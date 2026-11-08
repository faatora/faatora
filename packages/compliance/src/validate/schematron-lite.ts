/**
 * Schematron-lite — EN 16931 + PINT-OM business rules in TypeScript.
 *
 * We hand-code the publicly documented invariants rather than ship a
 * Schematron engine, so this file is the single source of truth for
 * what the pipeline considers a business-rule error. Keep the rule
 * identifiers (`BR-*`, `BR-CO-*`, `BR-S-*`, `BR-Z-*`, `BR-E-*`,
 * `BR-OM-*`) stable: downstream dashboards and QA fixtures match by
 * exact string.
 *
 * Severity reference:
 *   - EN-16931 BR / BR-CO / per-category rules are hard errors.
 *   - OM-local invariants that MAY legitimately differ in cross-border
 *     scenarios (BR-OM-001 VATIN format, BR-OM-002 non-OMR currency)
 *     are warnings so the Wave 3 pipeline doesn't block exports we
 *     haven't modelled yet. BR-OM-003 (future-dated issueDate) is a
 *     hard error — nobody legitimately issues an invoice for next year.
 */

import type { SemanticInvoice } from '../semantic/en16931.js';
import type { ValidationIssue } from './types.js';

function issue(
  severity: 'error' | 'warning',
  rule: string,
  message: string,
  path?: string,
): ValidationIssue {
  return { severity, stage: 'schematron', rule, message, path };
}

function todayUtcIso(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const OM_VATIN_PATTERNS: RegExp[] = [/^OM\d{10}$/, /^\d{10}$/];

export function runSchematron(semantic: SemanticInvoice): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  /* ---------- Presence / mandatory-field rules ------------------------- */

  if (!semantic.bt1_invoiceNumber || semantic.bt1_invoiceNumber.length === 0) {
    issues.push(
      issue('error', 'BR-01', 'invoice must have an invoice number (BT-1)', 'bt1_invoiceNumber'),
    );
  }
  if (!semantic.bt2_issueDate || semantic.bt2_issueDate.length === 0) {
    issues.push(issue('error', 'BR-02', 'invoice must have an issue date (BT-2)', 'bt2_issueDate'));
  }
  if (!semantic.bt3_typeCode || semantic.bt3_typeCode.length === 0) {
    issues.push(
      issue('error', 'BR-04', 'invoice must have an invoice type code (BT-3)', 'bt3_typeCode'),
    );
  }
  if (!semantic.bt5_currencyCode || semantic.bt5_currencyCode.length === 0) {
    issues.push(
      issue(
        'error',
        'BR-05',
        'invoice must have a document currency code (BT-5)',
        'bt5_currencyCode',
      ),
    );
  }
  if (!semantic.supplier?.bt27_name || semantic.supplier.bt27_name.length === 0) {
    issues.push(
      issue('error', 'BR-06', 'invoice must have a supplier name (BT-27)', 'supplier.bt27_name'),
    );
  }
  if (!semantic.buyer?.bt27_name || semantic.buyer.bt27_name.length === 0) {
    issues.push(
      issue('error', 'BR-07', 'invoice must have a buyer name (BT-44)', 'buyer.bt27_name'),
    );
  }
  if (!semantic.bg25_lines || semantic.bg25_lines.length === 0) {
    issues.push(
      issue('error', 'BR-16', 'invoice must have at least one invoice line', 'bg25_lines'),
    );
  }

  /* ---------- Document-total consistency (BR-CO-*) --------------------- */
  // BR-CO-10, BR-CO-13, BR-CO-15, BR-CO-16 are all derivable algebraic
  // identities on the semantic totals. In Wave 3 we don't model
  // document-level allowances/charges, prepaid or rounding — they all
  // default to 0, which collapses the rules into simple equalities but
  // we still check them explicitly so adding those fields later only
  // changes the inputs, not the rule emitter.

  const t = semantic.bg22_documentTotals;
  if (t) {
    const sumLineNets = semantic.bg25_lines.reduce((a, l) => a + l.bt131_lineNetAmount, 0);
    // BR-CO-10 — BT-106 = Σ line nets. We tolerate the stored value if
    // it rounds to the same scale (vat-math catches the hard mismatch).
    const scaleFactor = 1e6;
    const bt106Int = Math.round(t.bt106_sumOfLineNetAmounts * scaleFactor);
    const sumInt = Math.round(sumLineNets * scaleFactor);
    if (bt106Int !== sumInt) {
      issues.push(
        issue(
          'error',
          'BR-CO-10',
          `BT-106 (${t.bt106_sumOfLineNetAmounts}) must equal Σ line nets (${sumLineNets})`,
          'bg22_documentTotals.bt106_sumOfLineNetAmounts',
        ),
      );
    }

    // BR-CO-13 — BT-109 = BT-106 − allowances + charges (both 0 in Wave 3).
    const bt109Int = Math.round(t.bt109_totalAmountWithoutVat * scaleFactor);
    if (bt109Int !== bt106Int) {
      issues.push(
        issue(
          'error',
          'BR-CO-13',
          `BT-109 (${t.bt109_totalAmountWithoutVat}) must equal BT-106 (${t.bt106_sumOfLineNetAmounts}) when document allowances/charges are absent`,
          'bg22_documentTotals.bt109_totalAmountWithoutVat',
        ),
      );
    }

    // BR-CO-15 — BT-112 = BT-109 + BT-110.
    const bt110Int = Math.round(t.bt110_totalVatAmount * scaleFactor);
    const bt112Int = Math.round(t.bt112_totalAmountWithVat * scaleFactor);
    if (bt112Int !== bt109Int + bt110Int) {
      issues.push(
        issue(
          'error',
          'BR-CO-15',
          `BT-112 (${t.bt112_totalAmountWithVat}) must equal BT-109 (${t.bt109_totalAmountWithoutVat}) + BT-110 (${t.bt110_totalVatAmount})`,
          'bg22_documentTotals.bt112_totalAmountWithVat',
        ),
      );
    }

    // BR-CO-16 — BT-115 = BT-112 − prepaid + rounding (both 0 in Wave 3).
    const bt115Int = Math.round(t.bt115_amountDueForPayment * scaleFactor);
    if (bt115Int !== bt112Int) {
      issues.push(
        issue(
          'error',
          'BR-CO-16',
          `BT-115 (${t.bt115_amountDueForPayment}) must equal BT-112 (${t.bt112_totalAmountWithVat}) when prepaid / rounding are absent`,
          'bg22_documentTotals.bt115_amountDueForPayment',
        ),
      );
    }
  }

  /* ---------- Per-category sanity (BR-S/Z/E) --------------------------- */

  const hasStandardLine = (semantic.bg25_lines ?? []).some(
    (l) => l.bt152_itemVatCategoryCode === 'S',
  );
  // BR-S-01: when any VAT breakdown row carries category S there must be
  // at least one line with category S. Fire the inverse too: a line with
  // category S must have a positive rate (BR-S-05).
  const hasStandardBreakdown = (semantic.bg23_vatBreakdown ?? []).some(
    (r) => r.bt118_categoryCode === 'S',
  );
  if (hasStandardBreakdown && !hasStandardLine) {
    issues.push(
      issue(
        'error',
        'BR-S-01',
        'standard-rated invoice must contain at least one line with VAT category S',
        'bg25_lines',
      ),
    );
  }

  for (const line of semantic.bg25_lines ?? []) {
    if (line.bt152_itemVatCategoryCode === 'S' && !(line.bt153_itemVatRate > 0)) {
      issues.push(
        issue(
          'error',
          'BR-S-05',
          `line ${line.bt126_lineId} has category S but rate ${line.bt153_itemVatRate} — must be > 0`,
          `bg25_lines[${line.bt126_lineId}].bt153_itemVatRate`,
        ),
      );
    }
    if (line.bt152_itemVatCategoryCode === 'Z' && line.bt153_itemVatRate !== 0) {
      issues.push(
        issue(
          'error',
          'BR-Z-01',
          `line ${line.bt126_lineId} has category Z (zero-rated) but rate ${line.bt153_itemVatRate} — must be 0`,
          `bg25_lines[${line.bt126_lineId}].bt153_itemVatRate`,
        ),
      );
    }
    if (line.bt152_itemVatCategoryCode === 'E' && line.bt153_itemVatRate !== 0) {
      issues.push(
        issue(
          'error',
          'BR-E-01',
          `line ${line.bt126_lineId} has category E (exempt) but rate ${line.bt153_itemVatRate} — must be 0`,
          `bg25_lines[${line.bt126_lineId}].bt153_itemVatRate`,
        ),
      );
    }
  }

  /* ---------- Oman-local invariants (BR-OM-*) -------------------------- */

  const supplierVatin = semantic.supplier?.bt31_vatIdentifier;
  if (supplierVatin) {
    const ok = OM_VATIN_PATTERNS.some((rx) => rx.test(supplierVatin));
    if (!ok) {
      issues.push(
        issue(
          'warning',
          'BR-OM-001',
          `supplier VATIN "${supplierVatin}" does not match the OM pattern /^OM\\d{10}$/ or /^\\d{10}$/`,
          'supplier.bt31_vatIdentifier',
        ),
      );
    }
  }

  if (semantic.bt5_currencyCode && semantic.bt5_currencyCode !== 'OMR') {
    issues.push(
      issue(
        'warning',
        'BR-OM-002',
        `currency is ${semantic.bt5_currencyCode}; OMR expected unless this is an export/cross-border invoice`,
        'bt5_currencyCode',
      ),
    );
  }

  if (semantic.bt2_issueDate && /^\d{4}-\d{2}-\d{2}$/.test(semantic.bt2_issueDate)) {
    if (semantic.bt2_issueDate > todayUtcIso()) {
      issues.push(
        issue(
          'error',
          'BR-OM-003',
          `issue date ${semantic.bt2_issueDate} is in the future (today UTC = ${todayUtcIso()})`,
          'bt2_issueDate',
        ),
      );
    }
  }

  return issues;
}
