import {
  canonicalToSemantic,
  parseUbl,
  pintOmToUbl,
  PINT_OM_CUSTOMIZATION_ID,
  PINT_OM_PROFILE_ID,
  semanticToPintOm,
  type CanonicalInvoice,
} from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function baseInvoice(overrides: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    id: '00000000-0000-0000-0000-000000000042',
    type: 'invoice',
    number: 'INV-UBL-0001',
    issueDate: '2026-10-17',
    currency: 'OMR',
    supplier: {
      name: 'Fawtara LLC',
      vatin: 'OM1100000001',
      country: 'OM',
    },
    buyer: {
      name: 'Buyer SAOC',
      vatin: 'OM1100000002',
      country: 'OM',
    },
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

function toUbl(canonical: CanonicalInvoice, documentUuid?: string): string {
  const semantic = canonicalToSemantic(canonical);
  const pintOm = semanticToPintOm(semantic, { documentUuid });
  return pintOmToUbl(pintOm);
}

/* -------------------------------------------------------------------------- */
/* Output shape + well-formedness                                             */
/* -------------------------------------------------------------------------- */

describe('pintOmToUbl — document shape', () => {
  const xml = toUbl(baseInvoice());

  it('starts with the UTF-8 XML declaration', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  });

  it('declares the three UBL namespaces on the root', () => {
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).toContain(
      'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    );
    expect(xml).toContain(
      'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    );
  });

  it('parseUbl accepts the serialiser output as well-formed', () => {
    const parsed = parseUbl(xml);
    expect(parsed.ok).toBe(true);
  });

  it('contains every mandatory element the parser checks for', () => {
    expect(xml).toContain(`<cbc:CustomizationID>${PINT_OM_CUSTOMIZATION_ID}</cbc:CustomizationID>`);
    expect(xml).toContain(`<cbc:ProfileID>${PINT_OM_PROFILE_ID}</cbc:ProfileID>`);
    expect(xml).toContain('<cbc:ID>INV-UBL-0001</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-10-17</cbc:IssueDate>');
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:DocumentCurrencyCode>OMR</cbc:DocumentCurrencyCode>');
    expect(xml).toContain('<cac:LegalMonetaryTotal>');
    expect(xml).toContain('<cac:InvoiceLine>');
  });

  it('UBL document order: Customization -> Profile -> ID -> IssueDate -> InvoiceTypeCode -> DocumentCurrencyCode -> parties -> TaxTotal -> LegalMonetaryTotal -> InvoiceLine', () => {
    const idx = (needle: string) => xml.indexOf(needle);
    expect(idx('<cbc:CustomizationID>')).toBeLessThan(idx('<cbc:ProfileID>'));
    expect(idx('<cbc:ProfileID>')).toBeLessThan(idx('<cbc:ID>'));
    expect(idx('<cbc:ID>')).toBeLessThan(idx('<cbc:IssueDate>'));
    expect(idx('<cbc:IssueDate>')).toBeLessThan(idx('<cbc:InvoiceTypeCode>'));
    expect(idx('<cbc:InvoiceTypeCode>')).toBeLessThan(idx('<cbc:DocumentCurrencyCode>'));
    expect(idx('<cbc:DocumentCurrencyCode>')).toBeLessThan(idx('<cac:AccountingSupplierParty>'));
    expect(idx('<cac:AccountingSupplierParty>')).toBeLessThan(idx('<cac:AccountingCustomerParty>'));
    expect(idx('<cac:AccountingCustomerParty>')).toBeLessThan(idx('<cac:TaxTotal>'));
    expect(idx('<cac:TaxTotal>')).toBeLessThan(idx('<cac:LegalMonetaryTotal>'));
    expect(idx('<cac:LegalMonetaryTotal>')).toBeLessThan(idx('<cac:InvoiceLine>'));
  });

  it('includes cbc:UUID when documentUuid is set and omits it otherwise', () => {
    const withoutUuid = toUbl(baseInvoice());
    expect(withoutUuid).not.toContain('<cbc:UUID>');

    const withUuid = toUbl(baseInvoice(), 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
    expect(withUuid).toContain('<cbc:UUID>f81d4fae-7dec-11d0-a765-00a0c91e6bf6</cbc:UUID>');
    // UBL order: UUID comes between ID and IssueDate.
    expect(withUuid.indexOf('<cbc:ID>')).toBeLessThan(withUuid.indexOf('<cbc:UUID>'));
    expect(withUuid.indexOf('<cbc:UUID>')).toBeLessThan(withUuid.indexOf('<cbc:IssueDate>'));
  });
});

/* -------------------------------------------------------------------------- */
/* Currency scale                                                             */
/* -------------------------------------------------------------------------- */

describe('pintOmToUbl — monetary formatting', () => {
  it('OMR amounts render with 3 decimal places (baisa)', () => {
    const xml = toUbl(baseInvoice());
    // 2 Widgets @ 10 = 20.000 OMR net.
    expect(xml).toContain('currencyID="OMR">20.000</cbc:LineExtensionAmount>');
    // Grand total = 50 + 5% VAT = 52.500 OMR.
    expect(xml).toContain('currencyID="OMR">52.500</cbc:PayableAmount>');
  });

  it('USD amounts render with 2 decimal places', () => {
    const xml = toUbl(baseInvoice({ currency: 'USD' }));
    expect(xml).toContain('currencyID="USD">20.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('currencyID="USD">52.50</cbc:PayableAmount>');
    expect(xml).not.toMatch(/currencyID="USD">\d+\.\d{3}</);
  });

  it('every monetary element carries a currencyID attribute', () => {
    const xml = toUbl(baseInvoice());
    // Count opening tags that should be monetary vs tags that carry currencyID.
    const monetary = [
      'cbc:LineExtensionAmount',
      'cbc:TaxAmount',
      'cbc:TaxableAmount',
      'cbc:TaxExclusiveAmount',
      'cbc:TaxInclusiveAmount',
      'cbc:PayableAmount',
      'cbc:PriceAmount',
    ];
    for (const tag of monetary) {
      // Opening tag always appears with the attribute; closing tag never does.
      const opens = xml.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
      expect(opens.length).toBeGreaterThan(0);
      for (const open of opens) {
        expect(open).toContain('currencyID=');
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Type code mapping                                                          */
/* -------------------------------------------------------------------------- */

describe('pintOmToUbl — InvoiceTypeCode mapping', () => {
  it("maps 'invoice' -> 380", () => {
    expect(toUbl(baseInvoice({ type: 'invoice' }))).toContain(
      '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>',
    );
  });

  it("maps 'credit_note' -> 381", () => {
    expect(toUbl(baseInvoice({ type: 'credit_note' }))).toContain(
      '<cbc:InvoiceTypeCode>381</cbc:InvoiceTypeCode>',
    );
  });

  it("maps 'debit_note' -> 383", () => {
    expect(toUbl(baseInvoice({ type: 'debit_note' }))).toContain(
      '<cbc:InvoiceTypeCode>383</cbc:InvoiceTypeCode>',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('pintOmToUbl — determinism', () => {
  it('yields byte-identical output on two independent calls', () => {
    const canonical = baseInvoice();
    const a = toUbl(canonical);
    const b = toUbl(canonical);
    expect(a).toBe(b);
    expect(Buffer.byteLength(a, 'utf8')).toBe(Buffer.byteLength(b, 'utf8'));
  });
});

/* -------------------------------------------------------------------------- */
/* Roundtrip canonical -> semantic -> pint-om -> ubl -> parse                  */
/* -------------------------------------------------------------------------- */

describe('pintOmToUbl — roundtrip against parseUbl', () => {
  it('canonical totals survive serialisation to UBL and back out of the parser', () => {
    const canonical = baseInvoice();
    const semantic = canonicalToSemantic(canonical);
    const xml = pintOmToUbl(semanticToPintOm(semantic));

    const parsed = parseUbl(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const inv = parsed.data.Invoice;
    expect(inv['cbc:ID']).toBe('INV-UBL-0001');
    expect(inv['cbc:InvoiceTypeCode']).toBe('380');
    expect(inv['cbc:DocumentCurrencyCode']).toBe('OMR');

    const lmt = inv['cac:LegalMonetaryTotal'];
    expect(lmt['cbc:LineExtensionAmount']['#text']).toBe('50.000');
    expect(lmt['cbc:TaxExclusiveAmount']['#text']).toBe('50.000');
    expect(lmt['cbc:TaxInclusiveAmount']['#text']).toBe('52.500');
    expect(lmt['cbc:PayableAmount']['#text']).toBe('52.500');

    const taxTotal = inv['cac:TaxTotal'];
    expect(taxTotal['cbc:TaxAmount']['#text']).toBe(
      semantic.bg22_documentTotals.bt110_totalVatAmount.toFixed(3),
    );

    // Two lines in the input -> array in the parsed output.
    expect(Array.isArray(inv['cac:InvoiceLine'])).toBe(true);
    expect(inv['cac:InvoiceLine']).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* parseUbl rejects bad input                                                 */
/* -------------------------------------------------------------------------- */

describe('parseUbl — negative cases', () => {
  it('rejects malformed XML with a parse-time error', () => {
    const res = parseUbl('<Invoice><cbc:ID></Invoice>');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-Invoice root element', () => {
    const res = parseUbl('<?xml version="1.0"?><NotAnInvoice/>');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('Invoice');
  });

  it('lists every missing mandatory element', () => {
    const skeleton =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">' +
      '<cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">X</cbc:ID>' +
      '</Invoice>';
    const res = parseUbl(skeleton);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toEqual(
        expect.arrayContaining([
          'Invoice/cbc:CustomizationID',
          'Invoice/cbc:ProfileID',
          'Invoice/cbc:IssueDate',
          'Invoice/cbc:InvoiceTypeCode',
          'Invoice/cbc:DocumentCurrencyCode',
          'Invoice/cac:LegalMonetaryTotal',
          'Invoice/cac:InvoiceLine',
        ]),
      );
    }
  });
});
