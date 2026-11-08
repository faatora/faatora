import type {
  CanonicalInvoice,
  CanonicalLine,
  CanonicalParty,
  InvoiceType,
} from '../canonical/types.js';
import { CURRENCY_SCALE, isValidCurrency } from '../codelists/currency.js';
import {
  EN16931_UBL_VERSION,
  type InvoiceTypeCode,
  type SemanticInvoice,
  type SemanticLine,
  type SemanticParty,
  type SemanticVatBreakdownRow,
} from './en16931.js';

/* -------------------------------------------------------------------------- */
/* Money engine: integer-baisa arithmetic.                                    */
/*                                                                            */
/* We never multiply or add floats directly. Every monetary derivation is     */
/* done in scaled integer space (10^scale * amount) and quantised back to a   */
/* decimal when it leaves the semantic layer. Scale is picked per currency:   */
/*  - OMR: 3 (baisa, 1 OMR = 1000 baisa)                                      */
/*  - USD/EUR/AED/SAR: 2                                                      */
/*  - fallback: 3  (safer when precision-truncating; callers upstream are     */
/*    the ones who allow-list currencies — this is just a defensive default)  */
/* -------------------------------------------------------------------------- */

function scaleFor(currency: string): number {
  if (isValidCurrency(currency)) return CURRENCY_SCALE[currency];
  return 3;
}

/** Multiply decimal `v` by 10^scale and round half-away-from-zero. */
function toScaledInt(v: number, scale: number): number {
  const factor = Math.pow(10, scale);
  // Scale, then round half-away-from-zero to avoid banker-rounding surprises.
  const shifted = v * factor;
  return shifted >= 0 ? Math.round(shifted) : -Math.round(-shifted);
}

/** Divide scaled integer back to a decimal, exactly expressible under scale. */
function fromScaledInt(i: number, scale: number): number {
  const factor = Math.pow(10, scale);
  // toFixed+Number trip ensures the result is an "exact" decimal at `scale`
  // places and avoids `1.005 -> 1.0049999...` artefacts.
  return Number((i / factor).toFixed(scale));
}

/** Round a decimal to `scale` places using the same engine. */
function roundTo(v: number, scale: number): number {
  return fromScaledInt(toScaledInt(v, scale), scale);
}

/* -------------------------------------------------------------------------- */
/* Mapping helpers                                                            */
/* -------------------------------------------------------------------------- */

const TYPE_CODE_MAP: Record<InvoiceType, InvoiceTypeCode> = {
  invoice: '380',
  credit_note: '381',
  debit_note: '383',
};

function mapParty(p: CanonicalParty): SemanticParty {
  return {
    bt27_name: p.name,
    bt31_vatIdentifier: p.vatin,
    bt40_countryCode: p.country,
    peppolId: p.peppolId,
    address: p.address
      ? {
          street: p.address.street,
          city: p.address.city,
          postalCode: p.address.postalCode,
          countrySubdivision: p.address.countrySubdivision,
        }
      : undefined,
  };
}

function mapLine(line: CanonicalLine, scale: number): SemanticLine {
  // Line net = quantity * unitPrice, computed in scaled-int space.
  // We scale unitPrice to currency precision, multiply by quantity (which
  // may itself be fractional, e.g. 0.5 kg), scale back, then quantise.
  const unitPriceInt = toScaledInt(line.unitPrice, scale);
  const lineNetScaled = unitPriceInt * line.quantity;
  // lineNetScaled is still in the scaled int space (one factor applied).
  // Quantise to currency scale by rounding and dividing by factor.
  const lineNet = roundTo(lineNetScaled / Math.pow(10, scale), scale);

  return {
    bt126_lineId: String(line.lineNo),
    bt127_lineNote: undefined, // canonical has no per-line note today
    bt129_quantity: line.quantity,
    bt130_unitCode: line.unitCode,
    bt131_lineNetAmount: lineNet,
    bt146_itemName: line.description,
    bt146_itemNetPrice: roundTo(line.unitPrice, scale),
    bt152_itemVatCategoryCode: line.vatCategory,
    bt153_itemVatRate: line.vatRate,
  };
}

/**
 * Group lines by (vat category, vat rate) and compute BG-23 rows.
 * Grouping key is `${category}|${rate}` — same rate under different
 * categories must stay distinct (e.g. 0% zero-rated vs 0% exempt).
 */
function buildVatBreakdown(lines: SemanticLine[], scale: number): SemanticVatBreakdownRow[] {
  const buckets = new Map<string, { taxable: number; code: string; rate: number }>();
  for (const line of lines) {
    const key = `${line.bt152_itemVatCategoryCode}|${line.bt153_itemVatRate}`;
    const taxableAdd = toScaledInt(line.bt131_lineNetAmount, scale);
    const existing = buckets.get(key);
    if (existing) {
      existing.taxable += taxableAdd;
    } else {
      buckets.set(key, {
        taxable: taxableAdd,
        code: line.bt152_itemVatCategoryCode,
        rate: line.bt153_itemVatRate,
      });
    }
  }

  const rows: SemanticVatBreakdownRow[] = [];
  for (const { taxable, code, rate } of buckets.values()) {
    // tax = taxable * rate / 100, in scaled-int space.
    // taxable is already scaled; multiplying by rate keeps scale, but
    // dividing by 100 drops precision -> we round after the final /100.
    const taxScaled = (taxable * rate) / 100;
    const taxableDecimal = fromScaledInt(taxable, scale);
    const taxDecimal = roundTo(taxScaled / Math.pow(10, scale), scale);
    rows.push({
      bt116_categoryTaxableAmount: taxableDecimal,
      bt117_categoryTaxAmount: taxDecimal,
      bt118_categoryCode: code,
      bt119_categoryRate: rate,
    });
  }

  // Sort for determinism: category code asc, then rate asc.
  rows.sort((a, b) => {
    if (a.bt118_categoryCode !== b.bt118_categoryCode) {
      return a.bt118_categoryCode < b.bt118_categoryCode ? -1 : 1;
    }
    return a.bt119_categoryRate - b.bt119_categoryRate;
  });
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Pure function. Translates a canonical invoice into its EN 16931
 * semantic form, recomputing line-net amounts, the VAT breakdown
 * and the document totals from the lines (canonical.totals is
 * ignored on purpose — it is a hint, not the source of truth).
 */
export function canonicalToSemantic(canonical: CanonicalInvoice): SemanticInvoice {
  const scale = scaleFor(canonical.currency);

  const lines = canonical.lines.map((l) => mapLine(l, scale));
  const vatBreakdown = buildVatBreakdown(lines, scale);

  // BT-106 = Σ line nets. Done in scaled-int space.
  const sumLineNetsScaled = lines.reduce(
    (acc, l) => acc + toScaledInt(l.bt131_lineNetAmount, scale),
    0,
  );
  const bt106 = fromScaledInt(sumLineNetsScaled, scale);

  // BT-110 = Σ category tax amounts, scaled-int space.
  const sumVatScaled = vatBreakdown.reduce(
    (acc, r) => acc + toScaledInt(r.bt117_categoryTaxAmount, scale),
    0,
  );
  const bt110 = fromScaledInt(sumVatScaled, scale);

  const bt112 = fromScaledInt(sumLineNetsScaled + sumVatScaled, scale);

  return {
    bt1_invoiceNumber: canonical.number,
    bt2_issueDate: canonical.issueDate,
    bt3_typeCode: TYPE_CODE_MAP[canonical.type],
    bt5_currencyCode: canonical.currency,
    bt13_purchaseOrderReference: undefined,
    bt22_invoiceNote: canonical.notes,
    bt24_specificationVersion: EN16931_UBL_VERSION,
    supplier: mapParty(canonical.supplier),
    buyer: mapParty(canonical.buyer),
    bg25_lines: lines,
    bg23_vatBreakdown: vatBreakdown,
    bg22_documentTotals: {
      bt106_sumOfLineNetAmounts: bt106,
      bt109_totalAmountWithoutVat: bt106,
      bt110_totalVatAmount: bt110,
      bt112_totalAmountWithVat: bt112,
      bt115_amountDueForPayment: bt112,
    },
    _canonicalId: canonical.id,
  };
}
