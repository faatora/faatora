import { canonicalToSemantic, validateCanonical, type CanonicalInvoice } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const baseParty = {
  name: 'Acme LLC',
  vatin: 'OM1100000001',
  country: 'OM',
  address: {
    street: 'Al Khuwair St',
    city: 'Muscat',
    postalCode: '112',
    countrySubdivision: 'OM-MA',
  },
};

const buyer = {
  name: 'Buyer SAOC',
  vatin: 'OM1100000002',
  country: 'OM',
};

function baseInvoice(overrides: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'invoice',
    number: 'INV-0001',
    issueDate: '2026-10-17',
    currency: 'OMR',
    supplier: baseParty,
    buyer,
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
      {
        lineNo: 2,
        description: 'Gadget',
        quantity: 1,
        unitCode: 'C62',
        unitPrice: 30,
        vatCategory: 'S',
        vatRate: 5,
      },
    ],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* validateCanonical                                                          */
/* -------------------------------------------------------------------------- */

describe('validateCanonical', () => {
  it('rejects a payload missing supplier', () => {
    const withoutSupplier: Partial<CanonicalInvoice> = { ...baseInvoice() };
    delete withoutSupplier.supplier;
    const res = validateCanonical(withoutSupplier);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path === 'supplier')).toBe(true);
    }
  });

  it('rejects a payload with no lines', () => {
    const res = validateCanonical(baseInvoice({ lines: [] }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path === 'lines')).toBe(true);
    }
  });

  it('rejects a bad currency length', () => {
    const res = validateCanonical(baseInvoice({ currency: 'OMRX' }));
    expect(res.ok).toBe(false);
  });

  it('accepts a well-formed invoice', () => {
    const res = validateCanonical(baseInvoice());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.lines).toHaveLength(2);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* canonicalToSemantic — standard 2-line                                      */
/* -------------------------------------------------------------------------- */

describe('canonicalToSemantic — 2-line standard-rate OMR invoice', () => {
  const semantic = canonicalToSemantic(baseInvoice());

  it('maps header fields', () => {
    expect(semantic.bt1_invoiceNumber).toBe('INV-0001');
    expect(semantic.bt2_issueDate).toBe('2026-10-17');
    expect(semantic.bt3_typeCode).toBe('380');
    expect(semantic.bt5_currencyCode).toBe('OMR');
    expect(semantic.bt24_specificationVersion).toBe('2.1');
  });

  it('maps supplier and buyer', () => {
    expect(semantic.supplier.bt27_name).toBe('Acme LLC');
    expect(semantic.supplier.bt31_vatIdentifier).toBe('OM1100000001');
    expect(semantic.supplier.bt40_countryCode).toBe('OM');
    expect(semantic.buyer.bt27_name).toBe('Buyer SAOC');
  });

  it('computes BT-131 per line and BT-106 sum', () => {
    expect(semantic.bg25_lines).toHaveLength(2);
    expect(semantic.bg25_lines[0].bt131_lineNetAmount).toBe(20);
    expect(semantic.bg25_lines[1].bt131_lineNetAmount).toBe(30);
    expect(semantic.bg22_documentTotals.bt106_sumOfLineNetAmounts).toBe(50);
  });

  it('computes BT-110 total VAT @ 5%', () => {
    expect(semantic.bg22_documentTotals.bt110_totalVatAmount).toBe(2.5);
  });

  it('computes BT-112 grand total', () => {
    expect(semantic.bg22_documentTotals.bt112_totalAmountWithVat).toBe(52.5);
    expect(semantic.bg22_documentTotals.bt115_amountDueForPayment).toBe(52.5);
  });

  it('produces a single BG-23 breakdown row for one category+rate', () => {
    expect(semantic.bg23_vatBreakdown).toHaveLength(1);
    const [row] = semantic.bg23_vatBreakdown;
    expect(row.bt118_categoryCode).toBe('S');
    expect(row.bt119_categoryRate).toBe(5);
    expect(row.bt116_categoryTaxableAmount).toBe(50);
    expect(row.bt117_categoryTaxAmount).toBe(2.5);
  });
});

/* -------------------------------------------------------------------------- */
/* canonicalToSemantic — mixed categories                                     */
/* -------------------------------------------------------------------------- */

describe('canonicalToSemantic — mixed standard + zero-rated', () => {
  const mixed = baseInvoice({
    lines: [
      {
        lineNo: 1,
        description: 'Standard item',
        quantity: 1,
        unitCode: 'C62',
        unitPrice: 100,
        vatCategory: 'S',
        vatRate: 5,
      },
      {
        lineNo: 2,
        description: 'Zero-rated item',
        quantity: 1,
        unitCode: 'C62',
        unitPrice: 40,
        vatCategory: 'Z',
        vatRate: 0,
      },
    ],
  });
  const semantic = canonicalToSemantic(mixed);

  it('groups the vat breakdown by category + rate', () => {
    expect(semantic.bg23_vatBreakdown).toHaveLength(2);
    // Sorted by category code asc -> 'S' then 'Z'
    const [sRow, zRow] = semantic.bg23_vatBreakdown;
    expect(sRow.bt118_categoryCode).toBe('S');
    expect(sRow.bt116_categoryTaxableAmount).toBe(100);
    expect(sRow.bt117_categoryTaxAmount).toBe(5);
    expect(zRow.bt118_categoryCode).toBe('Z');
    expect(zRow.bt116_categoryTaxableAmount).toBe(40);
    expect(zRow.bt117_categoryTaxAmount).toBe(0);
  });

  it('rolls document totals across categories (zero contributes 0 tax)', () => {
    expect(semantic.bg22_documentTotals.bt106_sumOfLineNetAmounts).toBe(140);
    expect(semantic.bg22_documentTotals.bt110_totalVatAmount).toBe(5);
    expect(semantic.bg22_documentTotals.bt112_totalAmountWithVat).toBe(145);
  });
});

/* -------------------------------------------------------------------------- */
/* Money engine — baisa rounding                                              */
/* -------------------------------------------------------------------------- */

describe('canonicalToSemantic — baisa-scale rounding', () => {
  it('1 × 0.105 @ 5% -> taxable 0.105, tax 0.005', () => {
    const inv = baseInvoice({
      lines: [
        {
          lineNo: 1,
          description: 'Baisa test',
          quantity: 1,
          unitCode: 'C62',
          unitPrice: 0.105,
          vatCategory: 'S',
          vatRate: 5,
        },
      ],
    });
    const semantic = canonicalToSemantic(inv);
    expect(semantic.bg25_lines[0].bt131_lineNetAmount).toBe(0.105);
    const [row] = semantic.bg23_vatBreakdown;
    expect(row.bt116_categoryTaxableAmount).toBe(0.105);
    expect(row.bt117_categoryTaxAmount).toBe(0.005);
    expect(semantic.bg22_documentTotals.bt112_totalAmountWithVat).toBe(0.11);
  });
});
