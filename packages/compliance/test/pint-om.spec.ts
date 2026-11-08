import {
  canonicalToSemantic,
  PINT_OM_CUSTOMIZATION_ID,
  PINT_OM_PROFILE_ID,
  PINT_OM_RULE_PACK_VERSION,
  semanticToPintOm,
  type CanonicalInvoice,
} from '../src/index.js';
import { OM_VAT_SCHEME } from '../src/pint-om/specialize.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function baseInvoice(overrides: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'invoice',
    number: 'INV-9001',
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
    ],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Rule-pack metadata                                                         */
/* -------------------------------------------------------------------------- */

describe('PINT-OM constants', () => {
  it('exports the Peppol PINT-OM identifiers', () => {
    expect(PINT_OM_CUSTOMIZATION_ID).toBe('urn:peppol:pint:billing-1@om-1');
    expect(PINT_OM_PROFILE_ID).toBe('urn:peppol:bis:billing');
    expect(PINT_OM_RULE_PACK_VERSION).toBe('0.1.0-pint-om');
  });
});

/* -------------------------------------------------------------------------- */
/* semanticToPintOm                                                           */
/* -------------------------------------------------------------------------- */

describe('semanticToPintOm', () => {
  it('attaches the PINT-OM customization and profile identifiers', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const pintOm = semanticToPintOm(semantic);
    expect(pintOm.customizationId).toBe(PINT_OM_CUSTOMIZATION_ID);
    expect(pintOm.profileId).toBe(PINT_OM_PROFILE_ID);
  });

  it('stamps OM:VAT scheme on supplier and buyer that carry a VATIN', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const pintOm = semanticToPintOm(semantic);
    expect(pintOm.supplier.vatinScheme).toBe(OM_VAT_SCHEME);
    expect(pintOm.buyer.vatinScheme).toBe(OM_VAT_SCHEME);
    // Underlying BT-31 VATIN strings are preserved verbatim.
    expect(pintOm.supplier.bt31_vatIdentifier).toBe('OM1100000001');
    expect(pintOm.buyer.bt31_vatIdentifier).toBe('OM1100000002');
  });

  it('leaves vatinScheme undefined when a party has no VATIN', () => {
    const canonical = baseInvoice({
      buyer: { name: 'Walk-in Buyer', country: 'OM' },
    });
    const pintOm = semanticToPintOm(canonicalToSemantic(canonical));
    expect(pintOm.buyer.bt31_vatIdentifier).toBeUndefined();
    expect(pintOm.buyer.vatinScheme).toBeUndefined();
  });

  it('is a pure forwarder of lines, breakdown and totals', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const pintOm = semanticToPintOm(semantic);
    expect(pintOm.bg25_lines).toEqual(semantic.bg25_lines);
    expect(pintOm.bg23_vatBreakdown).toEqual(semantic.bg23_vatBreakdown);
    expect(pintOm.bg22_documentTotals).toEqual(semantic.bg22_documentTotals);
    expect(pintOm._canonicalId).toBe(semantic._canonicalId);
  });

  it('documentUuid is optional and roundtrips when provided', () => {
    const semantic = canonicalToSemantic(baseInvoice());
    const withoutUuid = semanticToPintOm(semantic);
    expect(withoutUuid.documentUuid).toBeUndefined();

    const withUuid = semanticToPintOm(semantic, {
      documentUuid: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
    });
    expect(withUuid.documentUuid).toBe('f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
  });
});
