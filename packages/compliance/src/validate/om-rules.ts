/**
 * Oman-specific business rules — OM-R-01 through OM-R-08.
 *
 * These are PINT-OM invariants that sit above the generic
 * EN 16931 `BR-*` / `BR-CO-*` checks in `schematron-lite.ts`. They
 * enforce Oman-law-specific invoice content (reverse-charge notes,
 * exemption reasons, VATIN presence rules, sign of the payable
 * total) that would not apply to a Peppol invoice from another
 * jurisdiction, so we keep them in their own stage.
 *
 * Rule catalogue:
 *   OM-R-01 — Invoice total sign: Invoice > 0, CreditNote < 0 (or
 *             expressed as positive with type code 381; see note).
 *   OM-R-02 — Every line must carry a valid VAT category
 *             (one of S / Z / E / O / AE).
 *   OM-R-03 — Reverse-charge invoice must include a payable note
 *             "Reverse charge — buyer liable for VAT" in English
 *             AND Arabic.
 *   OM-R-04 — Invoice with any category-E (exempt) line must
 *             indicate an exemption reason at the invoice or line
 *             level. Emitted as a WARNING because the semantic
 *             model doesn't yet carry a dedicated reason-code field
 *             (BT-121); once that lands, upgrade to error.
 *   OM-R-05 — Σ line extensions ± allowances/charges = BT-109
 *             within rounding tolerance (1 minor unit).
 *   OM-R-06 — BT-112 = BT-109 + Σ category tax within tolerance.
 *   OM-R-07 — Seller VAT TIN required if any line is standard-rated
 *             or reverse-charge.
 *   OM-R-08 — Buyer VAT TIN required if any line is reverse-charge.
 *
 * All issues emit with `stage: "schematron"` so downstream consumers
 * (dashboards, QA fixtures) do not need to learn a new stage name
 * to filter them.
 */

import { isValidVatCategory } from '../codelists/vat-category.js';
import type { SemanticInvoice } from '../semantic/en16931.js';
import type { ValidationIssue } from './types.js';
import { computeVatMathSummary, toScaledInt } from './vat-math.js';

/**
 * Canonical phrasing for the reverse-charge note. The rule does not
 * require an EXACT match — any invoice note that contains the
 * English marker AND one of the accepted Arabic markers passes. We
 * keep a tolerant matcher because real-world invoices embed the
 * note inside a longer sentence (invoice/PO references, legal
 * boilerplate) and demanding byte-equality would reject valid docs.
 */
export const REVERSE_CHARGE_NOTE_EN = 'Reverse charge — buyer liable for VAT';
export const REVERSE_CHARGE_NOTE_AR = 'التكليف العكسي — المشتري ملزم بضريبة القيمة المضافة';

const REVERSE_CHARGE_EN_MATCHER = /reverse\s*charge/i;
/** OTA uses either phrasing; we accept both. */
const REVERSE_CHARGE_AR_MATCHER = /(التكليف\s*العكسي|الاحتساب\s*العكسي|الضريبة\s*العكسية)/u;

/** Rounding tolerance used by the reconciliation rules — ±1 minor unit. */
const RECON_TOLERANCE_INT = 1;

function error(rule: string, message: string, path?: string): ValidationIssue {
  return { severity: 'error', stage: 'schematron', rule, message, path };
}

function warn(rule: string, message: string, path?: string): ValidationIssue {
  return { severity: 'warning', stage: 'schematron', rule, message, path };
}

/**
 * Oman VAT TINs are 10 digits, optionally prefixed with "OM". The
 * rule layer only cares about presence (format is BR-OM-001's job),
 * so we count a VATIN present if it is a non-empty string.
 */
function hasVatin(vatin: string | undefined): boolean {
  return typeof vatin === 'string' && vatin.trim().length > 0;
}

/**
 * Entry point. Runs every OM-R-* rule on the given semantic invoice
 * and returns the flat issue list.
 */
export function runOmRules(semantic: SemanticInvoice): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Derived VAT math — used by five of the eight rules. One pass is
  // enough; the summary carries bucket presence flags so no rule has
  // to re-walk `bg25_lines` on its own.
  const summary = computeVatMathSummary(semantic);
  const scale = summary.scale;

  /* ---------- OM-R-02 — every line carries a valid category -------------- */
  // Done first because OM-R-03/04/07/08 reason about category flags,
  // and a bogus category could otherwise mask a buyer-liable invoice.
  for (const line of semantic.bg25_lines) {
    const code = line.bt152_itemVatCategoryCode;
    if (!isValidVatCategory(code)) {
      issues.push(
        error(
          'OM-R-02',
          `line ${line.bt126_lineId}: VAT category "${code}" is not one of S, Z, E, O, AE`,
          `bg25_lines[${line.bt126_lineId}].bt152_itemVatCategoryCode`,
        ),
      );
    }
  }

  /* ---------- OM-R-01 — payable total sign fits document type ------------ */
  // UNTDID 1001 code 380 = invoice (> 0), 381 = credit note (< 0 in
  // signed form; Omani OTA accepts credit notes expressed with a
  // positive amount + type code 381, so we emit a WARNING at the
  // schematron layer for that case — but the "obvious" failures
  // (invoice ≤ 0, credit note > 0 in *signed* form) are hard errors).
  //
  // The semantic layer currently stores unsigned decimals for
  // simplicity; we treat `bt115_amountDueForPayment > 0` as the
  // normal shape for both invoice and credit note (the sign is
  // conveyed by `bt3_typeCode`). The rule therefore degrades to:
  //   - Invoice (380)    : amount must be > 0
  //   - Credit note (381): amount must be > 0 (signed by type)
  //   - Debit note (383) : amount must be > 0
  //   - Any zero or negative payable is rejected regardless of type.
  const payable = semantic.bg22_documentTotals.bt115_amountDueForPayment;
  if (!(payable > 0)) {
    issues.push(
      error(
        'OM-R-01',
        `payable amount (BT-115) is ${payable}; must be > 0 for ${semantic.bt3_typeCode}`,
        'bg22_documentTotals.bt115_amountDueForPayment',
      ),
    );
  }

  /* ---------- OM-R-03 — reverse-charge note bilingual -------------------- */
  if (summary.hasReverseCharge) {
    const note = semantic.bt22_invoiceNote ?? '';
    const hasEn = REVERSE_CHARGE_EN_MATCHER.test(note);
    const hasAr = REVERSE_CHARGE_AR_MATCHER.test(note);
    if (!hasEn || !hasAr) {
      const missing: string[] = [];
      if (!hasEn) missing.push('English');
      if (!hasAr) missing.push('Arabic');
      issues.push(
        error(
          'OM-R-03',
          `invoice contains reverse-charge (AE) lines but is missing the mandatory ` +
            `"${REVERSE_CHARGE_NOTE_EN}" note in ${missing.join(' and ')}`,
          'bt22_invoiceNote',
        ),
      );
    }
  }

  /* ---------- OM-R-04 — exemption reason for category-E lines ------------ */
  // The task spec names "exempt" specifically (category E), so we
  // narrow the trigger here rather than fan it out across Z / O / AE
  // (zero-rated has its own semantics; reverse-charge is covered by
  // OM-R-03). Emitted as a WARNING because the semantic model has
  // no dedicated reason-code field yet — we can only check that
  // SOME free-form note is attached. Once we add BT-121
  // (`VatExemptionReasonCode`) to the semantic layer, this upgrades
  // to an error and the check becomes a code-presence test.
  const invoiceNote = (semantic.bt22_invoiceNote ?? '').trim();
  const invoiceNoteSet = invoiceNote.length > 0;
  for (const line of semantic.bg25_lines) {
    if (line.bt152_itemVatCategoryCode !== 'E') continue;
    const lineNote = (line.bt127_lineNote ?? '').trim();
    if (lineNote.length > 0 || invoiceNoteSet) continue;
    issues.push(
      warn(
        'OM-R-04',
        `line ${line.bt126_lineId} is category E (exempt) and should carry an ` +
          `exemption reason on BT-127 (line note) or BT-22 (document note)`,
        `bg25_lines[${line.bt126_lineId}].bt127_lineNote`,
      ),
    );
  }

  /* ---------- OM-R-05 — Σ lines ± allow/charge ≈ BT-109 ------------------ */
  // Rounding tolerance of 1 minor unit — OM-VAT-008 is the strict
  // (zero-tolerance) version in the arithmetic stage; OM-R-05 is the
  // business-rule form that accepts off-by-one baisa drift which can
  // arise when ERPs round line nets independently of the sum.
  const bt109Int = toScaledInt(
    semantic.bg22_documentTotals.bt109_totalAmountWithoutVat,
    scale,
  );
  const bt109Diff = Math.abs(bt109Int - summary.expectedTaxExclusiveInt);
  if (bt109Diff > RECON_TOLERANCE_INT) {
    issues.push(
      error(
        'OM-R-05',
        `BT-109 (TaxExclusiveAmount) ${semantic.bg22_documentTotals.bt109_totalAmountWithoutVat} ` +
          `differs from Σ lines ± allowances/charges by ${bt109Diff} minor units ` +
          `(tolerance ${RECON_TOLERANCE_INT})`,
        'bg22_documentTotals.bt109_totalAmountWithoutVat',
      ),
    );
  }

  /* ---------- OM-R-06 — BT-112 = BT-109 + Σ tax -------------------------- */
  const bt112Int = toScaledInt(semantic.bg22_documentTotals.bt112_totalAmountWithVat, scale);
  const bt112Expected = bt109Int + summary.sumVatInt;
  const bt112Diff = Math.abs(bt112Int - bt112Expected);
  if (bt112Diff > RECON_TOLERANCE_INT) {
    issues.push(
      error(
        'OM-R-06',
        `BT-112 (TaxInclusiveAmount) ${semantic.bg22_documentTotals.bt112_totalAmountWithVat} ` +
          `differs from BT-109 + Σ tax by ${bt112Diff} minor units ` +
          `(tolerance ${RECON_TOLERANCE_INT})`,
        'bg22_documentTotals.bt112_totalAmountWithVat',
      ),
    );
  }

  /* ---------- OM-R-07 — seller VATIN required for S / AE ---------------- */
  if (summary.hasStandard || summary.hasReverseCharge) {
    if (!hasVatin(semantic.supplier?.bt31_vatIdentifier)) {
      const triggers: string[] = [];
      if (summary.hasStandard) triggers.push('standard-rated (S)');
      if (summary.hasReverseCharge) triggers.push('reverse-charge (AE)');
      issues.push(
        error(
          'OM-R-07',
          `supplier VAT identifier (BT-31) is required because the invoice has ` +
            `${triggers.join(' / ')} lines`,
          'supplier.bt31_vatIdentifier',
        ),
      );
    }
  }

  /* ---------- OM-R-08 — buyer VATIN required for AE --------------------- */
  if (summary.hasReverseCharge) {
    if (!hasVatin(semantic.buyer?.bt31_vatIdentifier)) {
      issues.push(
        error(
          'OM-R-08',
          `buyer VAT identifier (BT-48) is required because the invoice has ` +
            `reverse-charge (AE) lines`,
          'buyer.bt31_vatIdentifier',
        ),
      );
    }
  }

  return issues;
}
