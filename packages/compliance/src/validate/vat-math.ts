/**
 * VAT arithmetic validator.
 *
 * Re-derives line nets, per-category taxable/tax subtotals and the
 * three document totals (BT-106, BT-110, BT-112) from the semantic
 * invoice and reports every mismatch against the stored values. All
 * arithmetic happens in integer-baisa space (10^scale) so a float
 * drift of 1e-15 never shows up as a spurious error.
 *
 * Rules:
 *   OM-VAT-001 — line_net = round(quantity * unit_price, scale)
 *   OM-VAT-002 — per-category taxable subtotal = Σ line nets in that category
 *   OM-VAT-003 — per-category tax = round(subtotal * rate / 100, scale)
 *   OM-VAT-004 — BT-106 = Σ line nets
 *   OM-VAT-005 — BT-110 = Σ per-category tax
 *   OM-VAT-006 — BT-112 = BT-106 + BT-110
 */

import { CURRENCY_SCALE, isValidCurrency } from '../codelists/currency.js';
import type { SemanticInvoice } from '../semantic/en16931.js';
import type { ValidationIssue } from './types.js';

function scaleFor(currency: string): number {
  if (isValidCurrency(currency)) return CURRENCY_SCALE[currency];
  return 3;
}

/** Multiply decimal `v` by 10^scale and round half-away-from-zero. */
function toScaledInt(v: number, scale: number): number {
  const factor = Math.pow(10, scale);
  const shifted = v * factor;
  return shifted >= 0 ? Math.round(shifted) : -Math.round(-shifted);
}

/** Convert a scaled int back to a decimal fixed at `scale` places. */
function fromScaledInt(i: number, scale: number): number {
  const factor = Math.pow(10, scale);
  return Number((i / factor).toFixed(scale));
}

function err(rule: string, message: string, path?: string): ValidationIssue {
  return { severity: 'error', stage: 'vat', rule, message, path };
}

export function validateVatArithmetic(semantic: SemanticInvoice): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scale = scaleFor(semantic.bt5_currencyCode);

  // Rebuild every line net in scaled-int space and compare.
  const expectedLineNetsInt: number[] = [];
  for (const line of semantic.bg25_lines) {
    const unitPriceInt = toScaledInt(line.bt146_itemNetPrice, scale);
    const lineNetScaled = unitPriceInt * line.bt129_quantity;
    const expectedInt = Math.round((lineNetScaled / Math.pow(10, scale)) * Math.pow(10, scale));
    // Normalise: round through fromScaledInt to drop any 1e-9 jitter from
    // intermediate float ops (unitPriceInt * quantity, when quantity is a
    // non-integer like 0.5, is reproducible on all V8s we support).
    const expectedDecimal = fromScaledInt(expectedInt, scale);
    expectedLineNetsInt.push(toScaledInt(expectedDecimal, scale));

    const storedInt = toScaledInt(line.bt131_lineNetAmount, scale);
    if (storedInt !== toScaledInt(expectedDecimal, scale)) {
      issues.push(
        err(
          'OM-VAT-001',
          `line ${line.bt126_lineId}: stored net ${line.bt131_lineNetAmount} ≠ ` +
            `expected ${expectedDecimal} (qty ${line.bt129_quantity} × price ${line.bt146_itemNetPrice})`,
          `bg25_lines[${line.bt126_lineId}].bt131_lineNetAmount`,
        ),
      );
    }
  }

  // Per-category taxable subtotal and tax.
  const buckets = new Map<string, { code: string; rate: number; taxableInt: number }>();
  semantic.bg25_lines.forEach((line, idx) => {
    const key = `${line.bt152_itemVatCategoryCode}|${line.bt153_itemVatRate}`;
    const existing = buckets.get(key);
    const add = expectedLineNetsInt[idx];
    if (existing) {
      existing.taxableInt += add;
    } else {
      buckets.set(key, {
        code: line.bt152_itemVatCategoryCode,
        rate: line.bt153_itemVatRate,
        taxableInt: add,
      });
    }
  });

  for (const row of semantic.bg23_vatBreakdown) {
    const key = `${row.bt118_categoryCode}|${row.bt119_categoryRate}`;
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

    // Expected tax = round(taxable * rate / 100, scale) via scaled-int.
    const expectedTaxInt = Math.round((bucket.taxableInt * row.bt119_categoryRate) / 100);
    const expectedTaxDecimal = fromScaledInt(expectedTaxInt, scale);
    const storedTaxInt = toScaledInt(row.bt117_categoryTaxAmount, scale);
    if (storedTaxInt !== toScaledInt(expectedTaxDecimal, scale)) {
      issues.push(
        err(
          'OM-VAT-003',
          `category ${row.bt118_categoryCode} @ ${row.bt119_categoryRate}%: ` +
            `stored tax ${row.bt117_categoryTaxAmount} ≠ expected ${expectedTaxDecimal}`,
          `bg23_vatBreakdown[${row.bt118_categoryCode}@${row.bt119_categoryRate}].bt117_categoryTaxAmount`,
        ),
      );
    }
  }

  // BT-106 — sum of line nets.
  const sumLineNetsInt = expectedLineNetsInt.reduce((a, b) => a + b, 0);
  const storedBt106Int = toScaledInt(semantic.bg22_documentTotals.bt106_sumOfLineNetAmounts, scale);
  if (storedBt106Int !== sumLineNetsInt) {
    issues.push(
      err(
        'OM-VAT-004',
        `BT-106 stored ${semantic.bg22_documentTotals.bt106_sumOfLineNetAmounts} ≠ ` +
          `Σ line nets ${fromScaledInt(sumLineNetsInt, scale)}`,
        'bg22_documentTotals.bt106_sumOfLineNetAmounts',
      ),
    );
  }

  // BT-110 — sum of category tax amounts.
  const sumVatInt = semantic.bg23_vatBreakdown.reduce(
    (acc, r) => acc + toScaledInt(r.bt117_categoryTaxAmount, scale),
    0,
  );
  const storedBt110Int = toScaledInt(semantic.bg22_documentTotals.bt110_totalVatAmount, scale);
  if (storedBt110Int !== sumVatInt) {
    issues.push(
      err(
        'OM-VAT-005',
        `BT-110 stored ${semantic.bg22_documentTotals.bt110_totalVatAmount} ≠ ` +
          `Σ category tax ${fromScaledInt(sumVatInt, scale)}`,
        'bg22_documentTotals.bt110_totalVatAmount',
      ),
    );
  }

  // BT-112 — BT-106 + BT-110.
  const expectedBt112Int = sumLineNetsInt + sumVatInt;
  const storedBt112Int = toScaledInt(semantic.bg22_documentTotals.bt112_totalAmountWithVat, scale);
  if (storedBt112Int !== expectedBt112Int) {
    issues.push(
      err(
        'OM-VAT-006',
        `BT-112 stored ${semantic.bg22_documentTotals.bt112_totalAmountWithVat} ≠ ` +
          `BT-106 + BT-110 = ${fromScaledInt(expectedBt112Int, scale)}`,
        'bg22_documentTotals.bt112_totalAmountWithVat',
      ),
    );
  }

  return issues;
}
