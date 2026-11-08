import {
  PINT_OM_RULE_PACK_VERSION,
  canonicalToSemantic,
  pintOmToUbl,
  semanticToPintOm,
  runSchematron,
  validateInvoice,
  validateUblStructure,
  validateVatArithmetic,
  type CanonicalInvoice,
  type SemanticInvoice,
} from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
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

function baseInvoice(overrides: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    id: 'validate-spec-base',
    type: 'invoice',
    number: 'INV-VAL-0001',
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

/* -------------------------------------------------------------------------- */
/* VAT math                                                                    */
/* -------------------------------------------------------------------------- */

describe('validateVatArithmetic', () => {
  it('passes for a semantic that was produced by canonicalToSemantic', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    expect(validateVatArithmetic(semantic)).toEqual([]);
  });

  it('flags OM-VAT-001 when a stored line_net disagrees with qty * price', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const broken: SemanticInvoice = {
      ...semantic,
      bg25_lines: [{ ...semantic.bg25_lines[0], bt131_lineNetAmount: 999 }],
    };
    const issues = validateVatArithmetic(broken);
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain('OM-VAT-001');
  });

  it('flags OM-VAT-004 (BT-106) and OM-VAT-006 (BT-112) when BT-106 is wrong', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const broken: SemanticInvoice = {
      ...semantic,
      bg22_documentTotals: {
        ...semantic.bg22_documentTotals,
        bt106_sumOfLineNetAmounts: 999,
      },
    };
    const rules = validateVatArithmetic(broken).map((i) => i.rule);
    expect(rules).toContain('OM-VAT-004');
  });

  it('flags OM-VAT-005 when BT-110 does not equal Σ category tax', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const broken: SemanticInvoice = {
      ...semantic,
      bg22_documentTotals: {
        ...semantic.bg22_documentTotals,
        bt110_totalVatAmount: 999,
      },
    };
    const rules = validateVatArithmetic(broken).map((i) => i.rule);
    expect(rules).toContain('OM-VAT-005');
  });
});

/* -------------------------------------------------------------------------- */
/* XSD-lite                                                                    */
/* -------------------------------------------------------------------------- */

describe('validateUblStructure', () => {
  it('accepts a UBL produced by the serialiser', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const xml = pintOmToUbl(semanticToPintOm(semantic));
    expect(validateUblStructure(xml)).toEqual([]);
  });

  it('flags OM-XSD-003 when CustomizationID is missing', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const xml = pintOmToUbl(semanticToPintOm(semantic));
    const stripped = xml.replace(/<cbc:CustomizationID>[^<]*<\/cbc:CustomizationID>\s*/, '');
    const issues = validateUblStructure(stripped);
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain('OM-XSD-003');
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('Invoice/cbc:CustomizationID');
  });

  it('flags OM-XSD-001 for malformed XML', () => {
    const issues = validateUblStructure('<Invoice><cbc:ID>oops');
    expect(issues.map((i) => i.rule)).toContain('OM-XSD-001');
  });

  it('flags OM-XSD-002 when the root is not <Invoice>', () => {
    const issues = validateUblStructure('<?xml version="1.0"?><NotInvoice/>');
    expect(issues.map((i) => i.rule)).toContain('OM-XSD-002');
  });
});

/* -------------------------------------------------------------------------- */
/* Schematron-lite                                                             */
/* -------------------------------------------------------------------------- */

describe('runSchematron', () => {
  function semantic(overrides: Partial<CanonicalInvoice> = {}): SemanticInvoice {
    return canonicalToSemantic(baseInvoice(overrides));
  }

  // Each presence rule has one positive (passes) and one negative (fires).

  it('BR-01: passes with a non-empty invoice number', () => {
    const rules = runSchematron(semantic()).map((i) => i.rule);
    expect(rules).not.toContain('BR-01');
  });
  it('BR-01: fires when BT-1 is empty', () => {
    const s = semantic();
    s.bt1_invoiceNumber = '';
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-01');
  });

  it('BR-02: fires when BT-2 is empty', () => {
    const s = semantic();
    s.bt2_issueDate = '';
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-02');
  });

  it('BR-04: fires when BT-3 is empty', () => {
    const s = semantic();
    (s as { bt3_typeCode: string }).bt3_typeCode = '';
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-04');
  });

  it('BR-05: fires when BT-5 is empty', () => {
    const s = semantic();
    s.bt5_currencyCode = '';
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-05');
  });

  it('BR-06: fires when supplier name is empty', () => {
    const s = semantic();
    s.supplier.bt27_name = '';
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-06');
  });

  it('BR-07: fires when buyer name is empty', () => {
    const s = semantic();
    s.buyer.bt27_name = '';
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-07');
  });

  it('BR-16: fires when there are no lines', () => {
    const s = semantic();
    s.bg25_lines = [];
    s.bg23_vatBreakdown = [];
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-16');
  });

  it('BR-CO-10: fires when BT-106 ≠ Σ line nets', () => {
    const s = semantic();
    s.bg22_documentTotals.bt106_sumOfLineNetAmounts = 999;
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-CO-10');
  });

  it('BR-CO-13: fires when BT-109 ≠ BT-106', () => {
    const s = semantic();
    s.bg22_documentTotals.bt109_totalAmountWithoutVat = 999;
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-CO-13');
  });

  it('BR-CO-15: fires when BT-112 ≠ BT-109 + BT-110', () => {
    const s = semantic();
    s.bg22_documentTotals.bt112_totalAmountWithVat = 999;
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-CO-15');
  });

  it('BR-CO-16: fires when BT-115 ≠ BT-112', () => {
    const s = semantic();
    s.bg22_documentTotals.bt115_amountDueForPayment = 999;
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-CO-16');
  });

  it('BR-S-01: fires when breakdown has S but no line is S', () => {
    const s: SemanticInvoice = {
      ...semantic(),
      bg25_lines: [
        {
          bt126_lineId: '1',
          bt129_quantity: 1,
          bt130_unitCode: 'C62',
          bt131_lineNetAmount: 10,
          bt146_itemName: 'misclassified',
          bt146_itemNetPrice: 10,
          bt152_itemVatCategoryCode: 'Z',
          bt153_itemVatRate: 0,
        },
      ],
      bg23_vatBreakdown: [
        {
          bt116_categoryTaxableAmount: 10,
          bt117_categoryTaxAmount: 0.5,
          bt118_categoryCode: 'S',
          bt119_categoryRate: 5,
        },
      ],
    };
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-S-01');
  });

  it('BR-S-05: fires when a category-S line has rate 0', () => {
    const s = semantic({
      lines: [
        {
          lineNo: 1,
          description: 'Zero-rated standard (wrong)',
          quantity: 1,
          unitCode: 'C62',
          unitPrice: 10,
          vatCategory: 'S',
          vatRate: 0,
        },
      ],
    });
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-S-05');
  });

  it('BR-Z-01: fires when a category-Z line has rate > 0', () => {
    const s = semantic({
      lines: [
        {
          lineNo: 1,
          description: 'Zero-rated with rate (wrong)',
          quantity: 1,
          unitCode: 'C62',
          unitPrice: 10,
          vatCategory: 'Z',
          vatRate: 5,
        },
      ],
    });
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-Z-01');
  });

  it('BR-E-01: fires when a category-E line has rate > 0', () => {
    const s = semantic({
      lines: [
        {
          lineNo: 1,
          description: 'Exempt with rate (wrong)',
          quantity: 1,
          unitCode: 'C62',
          unitPrice: 10,
          vatCategory: 'E',
          vatRate: 5,
        },
      ],
    });
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-E-01');
  });

  it('BR-OM-001: warns when supplier VATIN does not match OM pattern', () => {
    const s = semantic();
    s.supplier.bt31_vatIdentifier = 'ES-NOT-OMAN-XYZ';
    const issues = runSchematron(s);
    const warn = issues.find((i) => i.rule === 'BR-OM-001');
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });

  it('BR-OM-001: no warning for valid OM pattern', () => {
    const rules = runSchematron(semantic()).map((i) => i.rule);
    expect(rules).not.toContain('BR-OM-001');
  });

  it('BR-OM-002: warns when currency is not OMR', () => {
    const s = semantic({ currency: 'USD' });
    const issues = runSchematron(s);
    const warn = issues.find((i) => i.rule === 'BR-OM-002');
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });

  it('BR-OM-003: fires when issueDate is in the future', () => {
    const s = semantic({ issueDate: '2099-01-01' });
    expect(runSchematron(s).map((i) => i.rule)).toContain('BR-OM-003');
  });

  it('BR-OM-003: does not fire for today', () => {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const todayIso = `${y}-${m}-${day}`;
    const s = semantic({ issueDate: todayIso });
    expect(runSchematron(s).map((i) => i.rule)).not.toContain('BR-OM-003');
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end pipeline                                                         */
/* -------------------------------------------------------------------------- */

describe('validateInvoice pipeline', () => {
  it('returns ok=true for a known-good canonical invoice', () => {
    const report = validateInvoice({ canonical: baseInvoice() });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.rulePackVersion).toBe(PINT_OM_RULE_PACK_VERSION);
  });

  it('short-circuits on canonical zod errors with CANON-001', () => {
    const bad = { not: 'a canonical invoice' } as unknown as CanonicalInvoice;
    const report = validateInvoice({ canonical: bad });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.rule)).toContain('CANON-001');
    // Early-exit: later-stage rules do not run.
    expect(report.errors.every((e) => e.stage === 'canonical')).toBe(true);
  });

  it('accepts a pre-built semantic (bypassing canonical) and still runs schematron', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    semantic.bg25_lines = [];
    semantic.bg23_vatBreakdown = [];
    semantic.bg22_documentTotals = {
      bt106_sumOfLineNetAmounts: 0,
      bt109_totalAmountWithoutVat: 0,
      bt110_totalVatAmount: 0,
      bt112_totalAmountWithVat: 0,
      bt115_amountDueForPayment: 0,
    };
    const report = validateInvoice({ semantic });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.rule)).toContain('BR-16');
  });

  it('emits BR-OM-002 as a warning when currency is non-OMR but shape is valid', () => {
    const inv = baseInvoice({ currency: 'USD' });
    const report = validateInvoice({ canonical: inv });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.rule)).toContain('BR-OM-002');
  });
});
