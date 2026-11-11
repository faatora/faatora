/**
 * VAT arithmetic validator — Oman (PINT-OM) hardening.
 *
 * Re-derives line nets, per-category taxable / tax subtotals and the
 * document-level totals (BT-106, BT-109, BT-110, BT-112, BT-115) from
 * the semantic invoice and reports every mismatch against the stored
 * values. All arithmetic happens in integer-minor-unit space
 * (10^scale) so a float drift of 1e-15 never shows up as a spurious
 * error. For OMR that minor unit is the baisa (1 OMR = 1000 baisa).
 *
 * Rounding strategy:
 *   The OM-PINT specification does not call out banker's rounding;
 *   every published OTA worked example uses commercial rounding
 *   (half away from zero) to the currency's minor unit. We follow
 *   that convention here so stored values produced by common ERPs
 *   (SAP/Oracle/QuickBooks, all of which round half-away-from-zero
 *   by default on monetary types) match what we re-derive. The
 *   choice is documented in `validate/README.md` and surfaced via
 *   the exported `ROUNDING_MODE` constant for downstream callers.
 *
 * Categories handled (all 5 Omani VAT categories):
 *   S  — standard 5%          (tax = taxable * 5 / 100)
 *   Z  — zero-rated           (tax = 0, rate must be 0)
 *   E  — exempt               (tax = 0, rate must be 0)
 *   O  — out of scope         (tax = 0, rate must be 0)
 *   AE — reverse charge       (tax = 0, rate must be 0, buyer liable)
 *
 * Rule identifiers emitted (stage = "vat"):
 *   OM-VAT-001 — line_net = round(quantity * unit_price, scale)
 *   OM-VAT-002 — per-category taxable subtotal = Σ line nets in cat
 *   OM-VAT-003 — per-category tax = round(taxable * rate / 100, scale)
 *   OM-VAT-004 — BT-106 = Σ line nets
 *   OM-VAT-005 — BT-110 = Σ per-category tax
 *   OM-VAT-006 — BT-112 = BT-109 + BT-110
 *   OM-VAT-007 — reverse-charge (AE) category tax MUST be 0
 *   OM-VAT-008 — BT-109 = BT-106 − allowances + charges (doc level)
 *   OM-VAT-009 — BT-115 = BT-112 − prepaid − rounding (doc level)
 *   OM-VAT-010 — unknown VAT category code
 */

import {
  getVatCategory,
  isReverseCharge,
  isValidVatCategory,
} from '../codelists/vat-category.js';
import { CURRENCY_SCALE, isValidCurrency } from '../codelists/currency.js';
import type { SemanticInvoice, SemanticVatBreakdownRow } from '../semantic/en16931.js';
import type { ValidationIssue } from './types.js';

/** Documented rounding mode. See file header. */
export const ROUNDING_MODE = 'half-away-from-zero' as const;

/* -------------------------------------------------------------------------- */
/* Money engine: integer minor-unit arithmetic                                */
/* -------------------------------------------------------------------------- */

function scaleFor(currency: string): number {
  if (isValidCurrency(currency)) return CURRENCY_SCALE[currency];
  return 3; // OMR default — 3-decimal baisa is the safest fallback.
}

/**
 * Multiply decimal `v` by 10^scale and round half-away-from-zero.
 *
 * Exported so sibling validators (om-rules.ts) share the exact same
 * rounding behaviour and tolerance window as this file does.
 */
export function toScaledInt(v: number, scale: number): number {
  const factor = Math.pow(10, scale);
  const shifted = v * factor;
  return shifted >= 0 ? Math.round(shifted) : -Math.round(-shifted);
}

/** Convert a scaled int back to a decimal fixed at `scale` places. */
export function fromScaledInt(i: number, scale: number): number {
  const factor = Math.pow(10, scale);
  return Number((i / factor).toFixed(scale));
}

/** Round a decimal to `scale` places using the same engine. */
export function roundTo(v: number, scale: number): number {
  return fromScaledInt(toScaledInt(v, scale), scale);
}

/** Resolve the minor-unit scale this engine uses for `currency`. */
export function scaleForCurrency(currency: string): number {
  return scaleFor(currency);
}

/* -------------------------------------------------------------------------- */
/* Error helper                                                               */
/* -------------------------------------------------------------------------- */

function err(rule: string, message: string, path?: string): ValidationIssue {
  return { severity: 'error', stage: 'vat', rule, message, path };
}

/* -------------------------------------------------------------------------- */
/* Per-line net + per-category aggregation                                    */
/* -------------------------------------------------------------------------- */

interface CategoryBucket {
  code: string;
  rate: number;
  /** Σ line nets in minor units. */
  taxableInt: number;
  /** Expected tax amount in minor units (0 for Z/E/O/AE). */
  expectedTaxInt: number;
  /** True if any line in this bucket is reverse-charge (AE). */
  reverseCharge: boolean;
}

/**
 * Compute the expected per-line net (in minor units) using the same
 * algorithm the canonical→semantic mapper uses, so the two agree by
 * construction: `round(quantity * unit_price, scale)`.
 */
function computeLineNetInt(quantity: number, unitPrice: number, scale: number): number {
  const unitPriceInt = toScaledInt(unitPrice, scale);
  const lineNetScaled = unitPriceInt * quantity;
  // Quantise to currency scale (drop any 1e-9 jitter introduced by the
  // scaled * fractional-quantity multiply).
  return toScaledInt(fromScaledInt(Math.round(lineNetScaled), scale), scale);
}

/**
 * Derived view of the aggregated VAT math, returned alongside the
 * issue list so consumers that need the numbers (e.g. the om-rules
 * stage, or a UI) do not have to recompute them.
 *
 * Every integer field is in minor units of `currency` (OMR → baisa).
 */
export interface VatMathSummary {
  currency: string;
  scale: number;
  /** Σ line nets in minor units. */
  sumLineNetsInt: number;
  /** Σ per-category tax in minor units. */
  sumVatInt: number;
  /** Expected BT-109 (TaxExclusiveAmount) in minor units. */
  expectedTaxExclusiveInt: number;
  /** Expected BT-112 (TaxInclusiveAmount) in minor units. */
  expectedTaxInclusiveInt: number;
  /** Expected BT-115 (PayableAmount) in minor units. */
  expectedPayableInt: number;
  /** One bucket per (category, rate) pair. */
  buckets: ReadonlyMap<string, CategoryBucket>;
  /** True when at least one line carries category AE. */
  hasReverseCharge: boolean;
  /** True when at least one line carries category E. */
  hasExempt: boolean;
  /** True when at least one line carries category S. */
  hasStandard: boolean;
}

/* -------------------------------------------------------------------------- */
/* Main validator                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Validate the invoice's VAT arithmetic.
 *
 * Returns the flat issues array as before (unchanged signature) so
 * the existing pipeline wiring keeps working. Callers that need the
 * derived numbers can use `computeVatMathSummary` below.
 */
export function validateVatArithmetic(semantic: SemanticInvoice): ValidationIssue[] {
  const { issues } = runVatArithmetic(semantic);
  return issues;
}

/**
 * Same as `validateVatArithmetic` but also returns the derived
 * summary. Used by the OM-R-* rule stage so it can reason about
 * reverse-charge presence, exempt presence, expected totals etc.
 * without re-walking the invoice.
 */
export function runVatArithmetic(semantic: SemanticInvoice): {
  issues: ValidationIssue[];
  summary: VatMathSummary;
} {
  const issues: ValidationIssue[] = [];
  const scale = scaleFor(semantic.bt5_currencyCode);

  /* ----------- Per-line expected net + bucket aggregation ---------------- */

  const expectedLineNetsInt: number[] = [];
  const buckets = new Map<string, CategoryBucket>();
  let hasReverseCharge = false;
  let hasExempt = false;
  let hasStandard = false;

  for (const line of semantic.bg25_lines) {
    const categoryCode = line.bt152_itemVatCategoryCode;
    const descriptor = getVatCategory(categoryCode);

    // OM-VAT-010 — unknown category. We still try to reconcile below
    // so the user sees every issue in one pass, but a bogus code
    // cannot match any breakdown row so it is reported first.
    if (!descriptor) {
      issues.push(
        err(
          'OM-VAT-010',
          `line ${line.bt126_lineId}: unknown VAT category "${categoryCode}" — ` +
            `must be one of S, Z, E, O, AE`,
          `bg25_lines[${line.bt126_lineId}].bt152_itemVatCategoryCode`,
        ),
      );
    } else {
      if (descriptor.code === 'S') hasStandard = true;
      if (descriptor.code === 'E') hasExempt = true;
      if (descriptor.reverseCharge) hasReverseCharge = true;
    }

    const expectedInt = computeLineNetInt(line.bt129_quantity, line.bt146_itemNetPrice, scale);
    const expectedDecimal = fromScaledInt(expectedInt, scale);
    expectedLineNetsInt.push(expectedInt);

    // OM-VAT-001 — stored line net must match re-derived.
    const storedInt = toScaledInt(line.bt131_lineNetAmount, scale);
    if (storedInt !== expectedInt) {
      issues.push(
        err(
          'OM-VAT-001',
          `line ${line.bt126_lineId}: stored net ${line.bt131_lineNetAmount} ≠ ` +
            `expected ${expectedDecimal} (qty ${line.bt129_quantity} × price ${line.bt146_itemNetPrice})`,
          `bg25_lines[${line.bt126_lineId}].bt131_lineNetAmount`,
        ),
      );
    }

    // Bucket aggregation — keyed on (category, rate). Same key format
    // as the canonical→semantic mapper so stored breakdown rows that
    // round-trip through this engine will always match.
    const key = `${categoryCode}|${line.bt153_itemVatRate}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.taxableInt += expectedInt;
    } else {
      buckets.set(key, {
        code: categoryCode,
        rate: line.bt153_itemVatRate,
        taxableInt: expectedInt,
        expectedTaxInt: 0, // filled in below once all lines are in.
        reverseCharge: descriptor?.reverseCharge ?? false,
      });
    }
  }

  // Per-bucket expected tax amount. For categories whose rateMode is
  // "zero" (Z/E/O/AE) the tax is 0 regardless of the stored rate; we
  // still consult the rate when computing S tax so a rate-mismatch
  // shows up via OM-VAT-003 rather than being silently papered over.
  for (const bucket of buckets.values()) {
    const descriptor = getVatCategory(bucket.code);
    if (!descriptor) {
      bucket.expectedTaxInt = 0;
      continue;
    }
    if (descriptor.reverseCharge || descriptor.rateMode === 'zero') {
      bucket.expectedTaxInt = 0;
    } else {
      // Scaled-int: taxable (already scaled) × rate / 100, round.
      const taxScaled = (bucket.taxableInt * bucket.rate) / 100;
      bucket.expectedTaxInt = Math.round(taxScaled);
    }
  }

  /* ----------- OM-VAT-002 / -003 / -007 — breakdown checks --------------- */

  // Build a parallel index on stored breakdown rows so we can also
  // catch "stored row has no matching lines".
  const storedBreakdownKeys = new Set<string>();
  for (const row of semantic.bg23_vatBreakdown) {
    const key = `${row.bt118_categoryCode}|${row.bt119_categoryRate}`;
    storedBreakdownKeys.add(key);
    const bucket = buckets.get(key);
    if (!bucket) {
      issues.push(
        err(
          'OM-VAT-002',
          `VAT breakdown row for ${row.bt118_categoryCode} @ ${row.bt119_categoryRate}% has no matching lines`,
          `bg23_vatBreakdown[${row.bt118_categoryCode}@${row.bt119_categoryRate}]`,
        ),
      );
      continue;
    }
    const storedTaxableInt = toScaledInt(row.bt116_categoryTaxableAmount, scale);
    if (storedTaxableInt !== bucket.taxableInt) {
      issues.push(
        err(
          'OM-VAT-002',
          `category ${row.bt118_categoryCode} @ ${row.bt119_categoryRate}%: ` +
            `stored taxable ${row.bt116_categoryTaxableAmount} ≠ ` +
            `expected ${fromScaledInt(bucket.taxableInt, scale)}`,
          `bg23_vatBreakdown[${row.bt118_categoryCode}@${row.bt119_categoryRate}].bt116_categoryTaxableAmount`,
        ),
      );
    }

    const storedTaxInt = toScaledInt(row.bt117_categoryTaxAmount, scale);

    // OM-VAT-007 — reverse charge must carry a zero tax amount.
    if (bucket.reverseCharge && storedTaxInt !== 0) {
      issues.push(
        err(
          'OM-VAT-007',
          `category ${row.bt118_categoryCode} is reverse-charge — ` +
            `tax amount must be 0, got ${row.bt117_categoryTaxAmount}`,
          `bg23_vatBreakdown[${row.bt118_categoryCode}@${row.bt119_categoryRate}].bt117_categoryTaxAmount`,
        ),
      );
    }

    // OM-VAT-003 — stored category tax must equal the re-derived value.
    if (storedTaxInt !== bucket.expectedTaxInt) {
      issues.push(
        err(
          'OM-VAT-003',
          `category ${row.bt118_categoryCode} @ ${row.bt119_categoryRate}%: ` +
            `stored tax ${row.bt117_categoryTaxAmount} ≠ ` +
            `expected ${fromScaledInt(bucket.expectedTaxInt, scale)}`,
          `bg23_vatBreakdown[${row.bt118_categoryCode}@${row.bt119_categoryRate}].bt117_categoryTaxAmount`,
        ),
      );
    }
  }

  // Buckets that exist on the lines but are missing from the stored
  // breakdown — this is the inverse of the orphan-row case above.
  for (const [key, bucket] of buckets) {
    if (!storedBreakdownKeys.has(key)) {
      issues.push(
        err(
          'OM-VAT-002',
          `no VAT breakdown row for lines in category ${bucket.code} @ ${bucket.rate}% ` +
            `(Σ line nets = ${fromScaledInt(bucket.taxableInt, scale)})`,
          `bg23_vatBreakdown[${bucket.code}@${bucket.rate}]`,
        ),
      );
    }
  }

  /* ----------- Document totals ------------------------------------------ */

  const sumLineNetsInt = expectedLineNetsInt.reduce((a, b) => a + b, 0);
  const sumVatInt = Array.from(buckets.values()).reduce((a, b) => a + b.expectedTaxInt, 0);

  // The semantic model doesn't carry document-level allowances /
  // charges / prepaid / rounding yet — they default to 0, which
  // reduces the identities to simple equalities. The rule emitters
  // still check them explicitly, so adding those fields later is a
  // one-line change (plumb the value into the rhs) rather than a
  // structural edit.
  const docAllowanceInt = 0;
  const docChargeInt = 0;
  const docPrepaidInt = 0;
  const docRoundingInt = 0;

  // Expected BT-109 = BT-106 − allowances + charges.
  const expectedBt109Int = sumLineNetsInt - docAllowanceInt + docChargeInt;
  // Expected BT-112 = BT-109 + Σ category tax.
  const expectedBt112Int = expectedBt109Int + sumVatInt;
  // Expected BT-115 = BT-112 − prepaid − rounding.
  const expectedBt115Int = expectedBt112Int - docPrepaidInt - docRoundingInt;

  const t = semantic.bg22_documentTotals;

  // OM-VAT-004 — BT-106 = Σ line nets.
  const storedBt106Int = toScaledInt(t.bt106_sumOfLineNetAmounts, scale);
  if (storedBt106Int !== sumLineNetsInt) {
    issues.push(
      err(
        'OM-VAT-004',
        `BT-106 stored ${t.bt106_sumOfLineNetAmounts} ≠ ` +
          `Σ line nets ${fromScaledInt(sumLineNetsInt, scale)}`,
        'bg22_documentTotals.bt106_sumOfLineNetAmounts',
      ),
    );
  }

  // OM-VAT-008 — BT-109 = BT-106 − allowances + charges.
  const storedBt109Int = toScaledInt(t.bt109_totalAmountWithoutVat, scale);
  if (storedBt109Int !== expectedBt109Int) {
    issues.push(
      err(
        'OM-VAT-008',
        `BT-109 stored ${t.bt109_totalAmountWithoutVat} ≠ ` +
          `BT-106 − allowances + charges = ${fromScaledInt(expectedBt109Int, scale)}`,
        'bg22_documentTotals.bt109_totalAmountWithoutVat',
      ),
    );
  }

  // OM-VAT-005 — BT-110 = Σ category tax.
  const storedBt110Int = toScaledInt(t.bt110_totalVatAmount, scale);
  if (storedBt110Int !== sumVatInt) {
    issues.push(
      err(
        'OM-VAT-005',
        `BT-110 stored ${t.bt110_totalVatAmount} ≠ ` +
          `Σ category tax ${fromScaledInt(sumVatInt, scale)}`,
        'bg22_documentTotals.bt110_totalVatAmount',
      ),
    );
  }

  // OM-VAT-006 — BT-112 = BT-109 + BT-110.
  const storedBt112Int = toScaledInt(t.bt112_totalAmountWithVat, scale);
  if (storedBt112Int !== expectedBt112Int) {
    issues.push(
      err(
        'OM-VAT-006',
        `BT-112 stored ${t.bt112_totalAmountWithVat} ≠ ` +
          `BT-109 + BT-110 = ${fromScaledInt(expectedBt112Int, scale)}`,
        'bg22_documentTotals.bt112_totalAmountWithVat',
      ),
    );
  }

  // OM-VAT-009 — BT-115 = BT-112 − prepaid − rounding.
  const storedBt115Int = toScaledInt(t.bt115_amountDueForPayment, scale);
  if (storedBt115Int !== expectedBt115Int) {
    issues.push(
      err(
        'OM-VAT-009',
        `BT-115 stored ${t.bt115_amountDueForPayment} ≠ ` +
          `BT-112 − prepaid − rounding = ${fromScaledInt(expectedBt115Int, scale)}`,
        'bg22_documentTotals.bt115_amountDueForPayment',
      ),
    );
  }

  const summary: VatMathSummary = {
    currency: semantic.bt5_currencyCode,
    scale,
    sumLineNetsInt,
    sumVatInt,
    expectedTaxExclusiveInt: expectedBt109Int,
    expectedTaxInclusiveInt: expectedBt112Int,
    expectedPayableInt: expectedBt115Int,
    buckets,
    hasReverseCharge,
    hasExempt,
    hasStandard,
  };

  return { issues, summary };
}

/**
 * Convenience accessor — re-run the arithmetic and return just the
 * summary. Keeps callers that only want the derived numbers from
 * having to deal with the issue list.
 */
export function computeVatMathSummary(semantic: SemanticInvoice): VatMathSummary {
  return runVatArithmetic(semantic).summary;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers surfaced for sibling validators and tests                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-derive a single VAT breakdown row from a set of lines, without
 * requiring a full `SemanticInvoice`. Exposed for unit tests and for
 * tooling that wants to synthesise expected rows (e.g. a "fix it"
 * autocorrect mode).
 */
export function deriveBreakdownRow(
  code: string,
  rate: number,
  lineNets: readonly number[],
  scale: number,
): SemanticVatBreakdownRow {
  const taxableInt = lineNets.reduce((a, v) => a + toScaledInt(v, scale), 0);
  const descriptor = getVatCategory(code);
  const zeroTax = !descriptor || descriptor.reverseCharge || descriptor.rateMode === 'zero';
  const taxInt = zeroTax ? 0 : Math.round((taxableInt * rate) / 100);
  return {
    bt116_categoryTaxableAmount: fromScaledInt(taxableInt, scale),
    bt117_categoryTaxAmount: fromScaledInt(taxInt, scale),
    bt118_categoryCode: code,
    bt119_categoryRate: rate,
  };
}

/** Re-export codelist helpers so callers can import everything from here. */
export { isValidVatCategory, isReverseCharge, getVatCategory };
