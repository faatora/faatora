/**
 * Unit tests for the Oman VAT arithmetic engine and the OM-R-* rule
 * pack. Grouped by concern:
 *
 *   1. Per-category calculation correctness (S / Z / E / O / AE).
 *   2. Reverse-charge mechanics (AE) — tax = 0 and OM-R-03 note.
 *   3. Mixed-category invoice — aggregation and reconciliation.
 *   4. Rounding edge cases — half-away-from-zero at 3 decimals.
 *   5. Each OM-R-XX rule — happy path and failing case.
 *   6. Randomised-input "property" tests — commutativity of totals
 *      and preservation of invariants over arbitrary line sets
 *      (seeded so failures are reproducible).
 *
 * Tests live under `src/validate/__tests__` (jest's testRegex is
 * `.*\.spec\.ts$`, rootDir `.` — this is picked up automatically).
 */

import type { CanonicalInvoice, VatCategory } from '../../canonical/types.js';
import { canonicalToSemantic } from '../../semantic/map.js';
import type { SemanticInvoice, SemanticLine } from '../../semantic/en16931.js';
import { validateInvoice } from '../pipeline.js';
import { REVERSE_CHARGE_NOTE_AR, REVERSE_CHARGE_NOTE_EN, runOmRules } from '../om-rules.js';
import {
  computeVatMathSummary,
  deriveBreakdownRow,
  fromScaledInt,
  roundTo,
  ROUNDING_MODE,
  runVatArithmetic,
  toScaledInt,
  validateVatArithmetic,
} from '../vat-math.js';

/* -------------------------------------------------------------------------- */
/* Shared fixtures                                                             */
/* -------------------------------------------------------------------------- */

const baseSupplier = {
  name: 'Acme Supplier LLC',
  vatin: 'OM1100000001',
  country: 'OM',
};
const baseBuyer = {
  name: 'Buyer SAOC',
  vatin: 'OM1100000002',
  country: 'OM',
};

function invoice(overrides: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    id: 'vat-math-spec',
    type: 'invoice',
    number: 'INV-VM-0001',
    issueDate: '2026-10-10',
    currency: 'OMR',
    supplier: baseSupplier,
    buyer: baseBuyer,
    lines: [
      {
        lineNo: 1,
        description: 'Widget',
        quantity: 2,
        unitCode: 'C62',
        unitPrice: 10,
        vatCategory: 'S',
        vatRate: 5,
      },
    ],
    ...overrides,
  };
}

/**
 * Build a semantic invoice whose lines carry an arbitrary VAT
 * category code, including `AE` which the canonical layer doesn't
 * accept. We start from a canonical-generated base and overwrite
 * BT-152 / BT-119 in place.
 */
function semanticWithCategory(
  code: string,
  rate: number,
  lineNote?: string,
  invoiceNote?: string,
): SemanticInvoice {
  const semantic = canonicalToSemantic(invoice());
  const scale = 3;
  const taxableInt = toScaledInt(semantic.bg25_lines[0].bt131_lineNetAmount, scale);
  const taxInt = code === 'S' ? Math.round((taxableInt * rate) / 100) : 0;
  const taxable = fromScaledInt(taxableInt, scale);
  const tax = fromScaledInt(taxInt, scale);
  const totalWithVat = fromScaledInt(taxableInt + taxInt, scale);

  const line: SemanticLine = {
    ...semantic.bg25_lines[0],
    bt152_itemVatCategoryCode: code,
    bt153_itemVatRate: rate,
    bt127_lineNote: lineNote,
  };
  return {
    ...semantic,
    bt22_invoiceNote: invoiceNote,
    bg25_lines: [line],
    bg23_vatBreakdown: [
      {
        bt116_categoryTaxableAmount: taxable,
        bt117_categoryTaxAmount: tax,
        bt118_categoryCode: code,
        bt119_categoryRate: rate,
      },
    ],
    bg22_documentTotals: {
      bt106_sumOfLineNetAmounts: taxable,
      bt109_totalAmountWithoutVat: taxable,
      bt110_totalVatAmount: tax,
      bt112_totalAmountWithVat: totalWithVat,
      bt115_amountDueForPayment: totalWithVat,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 1. Per-category calculation correctness                                    */
/* -------------------------------------------------------------------------- */

describe('vat-math — per-category calculations', () => {
  it('ROUNDING_MODE is documented as half-away-from-zero', () => {
    expect(ROUNDING_MODE).toBe('half-away-from-zero');
  });

  it('S (standard 5%): tax = taxable × 5 / 100, rounded to baisa', () => {
    const s = canonicalToSemantic(invoice()); // 2 × 10 = 20 taxable, 1.000 tax
    expect(validateVatArithmetic(s)).toEqual([]);
    const summary = computeVatMathSummary(s);
    expect(summary.sumLineNetsInt).toBe(20_000);
    expect(summary.sumVatInt).toBe(1_000);
    expect(summary.hasStandard).toBe(true);
    expect(summary.hasReverseCharge).toBe(false);
    expect(summary.hasExempt).toBe(false);
  });

  it('Z (zero-rated): tax = 0 at rate 0', () => {
    const s = semanticWithCategory('Z', 0);
    expect(validateVatArithmetic(s)).toEqual([]);
    expect(computeVatMathSummary(s).sumVatInt).toBe(0);
  });

  it('E (exempt): tax = 0 at rate 0', () => {
    const s = semanticWithCategory('E', 0);
    expect(validateVatArithmetic(s)).toEqual([]);
    const sum = computeVatMathSummary(s);
    expect(sum.sumVatInt).toBe(0);
    expect(sum.hasExempt).toBe(true);
  });

  it('O (out of scope): tax = 0 at rate 0', () => {
    const s = semanticWithCategory('O', 0);
    expect(validateVatArithmetic(s)).toEqual([]);
    expect(computeVatMathSummary(s).sumVatInt).toBe(0);
  });

  it('AE (reverse charge): tax = 0, hasReverseCharge = true', () => {
    const s = semanticWithCategory('AE', 0);
    expect(validateVatArithmetic(s)).toEqual([]);
    const sum = computeVatMathSummary(s);
    expect(sum.sumVatInt).toBe(0);
    expect(sum.hasReverseCharge).toBe(true);
  });

  it('unknown category fires OM-VAT-010', () => {
    const s = semanticWithCategory('X', 0);
    const rules = validateVatArithmetic(s).map((i) => i.rule);
    expect(rules).toContain('OM-VAT-010');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Reverse-charge mechanics (AE)                                           */
/* -------------------------------------------------------------------------- */

describe('vat-math — reverse-charge (AE)', () => {
  it('rejects a non-zero tax amount on an AE breakdown row (OM-VAT-007)', () => {
    const s = semanticWithCategory('AE', 0);
    // Inject a wrong tax amount on the AE row.
    s.bg23_vatBreakdown[0].bt117_categoryTaxAmount = 1.0;
    s.bg22_documentTotals.bt110_totalVatAmount = 1.0;
    s.bg22_documentTotals.bt112_totalAmountWithVat = 21.0;
    s.bg22_documentTotals.bt115_amountDueForPayment = 21.0;
    const rules = validateVatArithmetic(s).map((i) => i.rule);
    expect(rules).toContain('OM-VAT-007');
  });

  it('OM-R-03 fires when AE invoice is missing the bilingual note', () => {
    const s = semanticWithCategory('AE', 0);
    const issues = runOmRules(s);
    expect(issues.map((i) => i.rule)).toContain('OM-R-03');
  });

  it('OM-R-03 passes when the invoice note carries both EN and AR markers', () => {
    const note = `${REVERSE_CHARGE_NOTE_EN} / ${REVERSE_CHARGE_NOTE_AR}`;
    const s = semanticWithCategory('AE', 0, undefined, note);
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-03');
  });

  it('OM-R-03 fires when only one language marker is present', () => {
    const s = semanticWithCategory('AE', 0, undefined, 'Reverse charge only');
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-03');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Mixed-category invoice                                                   */
/* -------------------------------------------------------------------------- */

describe('vat-math — mixed category invoice', () => {
  function mixed(): CanonicalInvoice {
    return invoice({
      lines: [
        {
          lineNo: 1,
          description: 'Widget A (standard)',
          quantity: 2,
          unitCode: 'C62',
          unitPrice: 10,
          vatCategory: 'S',
          vatRate: 5,
        },
        {
          lineNo: 2,
          description: 'Widget B (zero-rated export)',
          quantity: 5,
          unitCode: 'C62',
          unitPrice: 12,
          vatCategory: 'Z',
          vatRate: 0,
        },
        {
          lineNo: 3,
          description: 'Widget C (exempt medical)',
          quantity: 3,
          unitCode: 'C62',
          unitPrice: 20,
          vatCategory: 'E',
          vatRate: 0,
        },
      ],
    });
  }

  it('aggregates per-category subtotals correctly', () => {
    const s = canonicalToSemantic(mixed());
    const sum = computeVatMathSummary(s);
    // S: 2*10 = 20; Z: 5*12 = 60; E: 3*20 = 60. Total 140. Tax = 20*0.05 = 1.
    expect(sum.sumLineNetsInt).toBe(140_000);
    expect(sum.sumVatInt).toBe(1_000);
    expect(sum.expectedTaxExclusiveInt).toBe(140_000);
    expect(sum.expectedTaxInclusiveInt).toBe(141_000);
    expect(sum.buckets.size).toBe(3);
  });

  it('full reconciliation passes end-to-end', () => {
    const report = validateInvoice({ canonical: mixed() });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Rounding edge cases                                                      */
/* -------------------------------------------------------------------------- */

describe('vat-math — rounding (half-away-from-zero at 3 decimals)', () => {
  it('rounds 0.0005 OMR up to 0.001 (half away from zero)', () => {
    expect(roundTo(0.0005, 3)).toBe(0.001);
  });

  it('rounds 0.0004 OMR down to 0.000', () => {
    expect(roundTo(0.0004, 3)).toBe(0);
  });

  it('rounds 0.9995 OMR up to 1.000', () => {
    expect(roundTo(0.9995, 3)).toBe(1);
  });

  it('rounds 0.9994 OMR to 0.999', () => {
    expect(roundTo(0.9994, 3)).toBe(0.999);
  });

  it('rounds -0.0005 OMR to -0.001 (away from zero, not banker)', () => {
    expect(roundTo(-0.0005, 3)).toBe(-0.001);
  });

  it('toScaledInt / fromScaledInt round-trip at 3 decimals', () => {
    for (const v of [0.001, 0.123, 1.234, 10.999, 100.555]) {
      expect(fromScaledInt(toScaledInt(v, 3), 3)).toBe(v);
    }
  });

  it('5% VAT on a fractional-baisa taxable value quantises deterministically', () => {
    // 3.333 OMR × 5% = 0.16665 → rounds to 0.167 (half-away-from-zero).
    const row = deriveBreakdownRow('S', 5, [3.333], 3);
    expect(row.bt116_categoryTaxableAmount).toBe(3.333);
    expect(row.bt117_categoryTaxAmount).toBe(0.167);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. OM-R-* rules — happy path + failing case                                 */
/* -------------------------------------------------------------------------- */

describe('OM-R rules', () => {
  function runPipeline(overrides: Partial<CanonicalInvoice> = {}) {
    return validateInvoice({ canonical: invoice(overrides) });
  }

  /* -- OM-R-01 — invoice total sign ---------------------------------------- */

  it('OM-R-01 passes when BT-115 > 0', () => {
    const rules = runOmRules(canonicalToSemantic(invoice())).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-01');
  });

  it('OM-R-01 fires when BT-115 == 0', () => {
    const s = canonicalToSemantic(invoice());
    s.bg22_documentTotals.bt115_amountDueForPayment = 0;
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-01');
  });

  it('OM-R-01 fires when BT-115 < 0', () => {
    const s = canonicalToSemantic(invoice());
    s.bg22_documentTotals.bt115_amountDueForPayment = -10;
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-01');
  });

  /* -- OM-R-02 — valid category -------------------------------------------- */

  it('OM-R-02 passes for canonical S / Z / E / O categories', () => {
    for (const cat of ['S', 'Z', 'E', 'O'] as VatCategory[]) {
      const rate = cat === 'S' ? 5 : 0;
      const s = runPipeline({
        lines: [
          {
            lineNo: 1,
            description: cat,
            quantity: 1,
            unitCode: 'C62',
            unitPrice: 10,
            vatCategory: cat,
            vatRate: rate,
          },
        ],
      });
      expect(s.errors.map((e) => e.rule)).not.toContain('OM-R-02');
    }
  });

  it('OM-R-02 passes for AE supplied directly as semantic', () => {
    const s = semanticWithCategory('AE', 0);
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-02');
  });

  it('OM-R-02 fires for an unknown category', () => {
    const s = semanticWithCategory('X', 0);
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-02');
  });

  /* -- OM-R-03 covered in section 2 ---------------------------------------- */

  /* -- OM-R-04 — exemption reason warning ---------------------------------- */

  it('OM-R-04 emits a warning (not error) for E lines with no reason', () => {
    const s = semanticWithCategory('E', 0);
    const issues = runOmRules(s);
    const r04 = issues.find((i) => i.rule === 'OM-R-04');
    expect(r04?.severity).toBe('warning');
  });

  it('OM-R-04 does not fire when BT-127 line note is set', () => {
    const s = semanticWithCategory('E', 0, 'Financial services — exempt per OTA circular 3/2021');
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-04');
  });

  it('OM-R-04 does not fire when BT-22 invoice note is set', () => {
    const s = semanticWithCategory('E', 0, undefined, 'Exempt — residential lease');
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-04');
  });

  /* -- OM-R-05 — tax-exclusive reconciliation ------------------------------ */

  it('OM-R-05 passes when BT-109 matches Σ lines', () => {
    const rules = runOmRules(canonicalToSemantic(invoice())).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-05');
  });

  it('OM-R-05 fires when BT-109 is tampered beyond rounding tolerance', () => {
    const s = canonicalToSemantic(invoice());
    s.bg22_documentTotals.bt109_totalAmountWithoutVat = 999;
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-05');
  });

  it('OM-R-05 tolerates a 1-baisa drift (within tolerance)', () => {
    const s = canonicalToSemantic(invoice());
    s.bg22_documentTotals.bt109_totalAmountWithoutVat = 20.001; // +1 baisa
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-05');
  });

  /* -- OM-R-06 — tax-inclusive reconciliation ------------------------------ */

  it('OM-R-06 fires when BT-112 is tampered beyond tolerance', () => {
    const s = canonicalToSemantic(invoice());
    s.bg22_documentTotals.bt112_totalAmountWithVat = 999;
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-06');
  });

  /* -- OM-R-07 — seller VATIN for S / AE ----------------------------------- */

  it('OM-R-07 passes when supplier has a VATIN and S lines are present', () => {
    const rules = runOmRules(canonicalToSemantic(invoice())).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-07');
  });

  it('OM-R-07 fires when supplier VATIN is missing on an S invoice', () => {
    const s = canonicalToSemantic(invoice({ supplier: { ...baseSupplier, vatin: undefined } }));
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-07');
  });

  it('OM-R-07 fires when supplier VATIN is missing on an AE invoice', () => {
    const s = semanticWithCategory('AE', 0);
    s.supplier.bt31_vatIdentifier = undefined;
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-07');
  });

  it('OM-R-07 does not fire on a pure Z / E / O invoice with no supplier VATIN', () => {
    const s = semanticWithCategory('Z', 0);
    s.supplier.bt31_vatIdentifier = undefined;
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-07');
  });

  /* -- OM-R-08 — buyer VATIN for AE ---------------------------------------- */

  it('OM-R-08 passes on a non-AE invoice', () => {
    const s = canonicalToSemantic(invoice({ buyer: { ...baseBuyer, vatin: undefined } }));
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-08');
  });

  it('OM-R-08 fires on an AE invoice with no buyer VATIN', () => {
    const s = semanticWithCategory('AE', 0);
    s.buyer.bt31_vatIdentifier = undefined;
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).toContain('OM-R-08');
  });

  it('OM-R-08 passes on an AE invoice with a buyer VATIN set', () => {
    const s = semanticWithCategory('AE', 0);
    s.buyer.bt31_vatIdentifier = 'OM9900000001';
    const rules = runOmRules(s).map((i) => i.rule);
    expect(rules).not.toContain('OM-R-08');
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Randomised invariants (seeded)                                           */
/*                                                                             */
/* Plain Jest-only "property" tests: generate N random line sets from a        */
/* fixed seed so failures are reproducible. We check two invariants that        */
/* should hold for any well-formed invoice coming out of the mapper:            */
/*   P1. runVatArithmetic emits zero issues.                                   */
/*   P2. expectedTaxInclusiveInt == expectedTaxExclusiveInt + sumVatInt.        */
/* -------------------------------------------------------------------------- */

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG — good enough for test shuffling.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

describe('vat-math — randomised invariants (seeded)', () => {
  // Fixed seed so a failing run is always reproducible.
  const rand = makeLcg(42);

  function randomInvoice(rng: () => number, nLines: number): CanonicalInvoice {
    const cats: Array<[VatCategory, number]> = [
      ['S', 5],
      ['Z', 0],
      ['E', 0],
      ['O', 0],
    ];
    const lines: CanonicalInvoice['lines'] = [];
    for (let i = 0; i < nLines; i++) {
      const [cat, rate] = cats[Math.floor(rng() * cats.length)];
      // Keep prices within 3-decimal representable range to avoid
      // float shrapnel that is not the system under test.
      const qty = 1 + Math.floor(rng() * 9);
      const price = Math.round(rng() * 1000) / 10; // 0.0–100.0 at 0.1 step
      lines.push({
        lineNo: i + 1,
        description: `line ${i + 1}`,
        quantity: qty,
        unitCode: 'C62',
        unitPrice: price,
        vatCategory: cat,
        vatRate: rate,
      });
    }
    return invoice({ lines, id: `rnd-${nLines}-${lines.length}` });
  }

  it('P1 — a canonically-derived semantic emits no VAT math issues', () => {
    for (let i = 0; i < 100; i++) {
      const nLines = 1 + Math.floor(rand() * 10);
      const inv = randomInvoice(rand, nLines);
      const s = canonicalToSemantic(inv);
      const result = runVatArithmetic(s);
      if (result.issues.length !== 0) {
        throw new Error(
          `seed iter ${i}: unexpected issues — ${result.issues.map((x) => x.rule).join(',')}`,
        );
      }
    }
  });

  it('P2 — expectedTaxInclusive = expectedTaxExclusive + sumVat', () => {
    for (let i = 0; i < 100; i++) {
      const nLines = 1 + Math.floor(rand() * 10);
      const inv = randomInvoice(rand, nLines);
      const sum = computeVatMathSummary(canonicalToSemantic(inv));
      expect(sum.expectedTaxInclusiveInt).toBe(sum.expectedTaxExclusiveInt + sum.sumVatInt);
      // And payable, with no prepaid/rounding, equals tax inclusive.
      expect(sum.expectedPayableInt).toBe(sum.expectedTaxInclusiveInt);
    }
  });
});
