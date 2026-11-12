import {
  formatParticipantId,
  parseParticipantId,
  makeIso6523ParticipantId,
  formatDocumentTypeId,
  parseDocumentTypeId,
  PEPPOL_BIS_BILLING_3_INVOICE,
  PEPPOL_BIS_BILLING_3_CREDIT_NOTE,
} from '../metadata.js';
import { PEPPOL } from '../types.js';

describe('Peppol participant ID', () => {
  it('formats scheme + identifier with "::"', () => {
    expect(
      formatParticipantId({
        scheme: 'iso6523-actorid-upis',
        identifier: '9915:test-participant',
      }),
    ).toBe('iso6523-actorid-upis::9915:test-participant');
  });

  it('round-trips through parse', () => {
    const raw = 'iso6523-actorid-upis::9915:om-seller-1';
    expect(formatParticipantId(parseParticipantId(raw))).toBe(raw);
  });

  it('parse keeps colons inside the identifier intact', () => {
    const parsed = parseParticipantId('iso6523-actorid-upis::9915:om:seller:1');
    expect(parsed.scheme).toBe('iso6523-actorid-upis');
    expect(parsed.identifier).toBe('9915:om:seller:1');
  });

  it('rejects missing separator', () => {
    expect(() => parseParticipantId('iso6523-actorid-upis')).toThrow(/scheme::identifier/);
  });

  it('rejects empty halves', () => {
    expect(() => parseParticipantId('::9915:x')).toThrow(/empty/);
    expect(() => parseParticipantId('iso6523-actorid-upis::')).toThrow(/empty/);
  });

  it('rejects empty scheme / identifier on format', () => {
    expect(() => formatParticipantId({ scheme: '', identifier: '9915:x' })).toThrow(/scheme/);
    expect(() => formatParticipantId({ scheme: 'iso6523-actorid-upis', identifier: '' })).toThrow(
      /identifier/,
    );
  });

  it('makeIso6523ParticipantId uses the Peppol default scheme', () => {
    const id = makeIso6523ParticipantId('9915', 'om-seller-1');
    expect(id.scheme).toBe(PEPPOL.participantScheme);
    expect(id.identifier).toBe('9915:om-seller-1');
    expect(formatParticipantId(id)).toBe('iso6523-actorid-upis::9915:om-seller-1');
  });
});

describe('Peppol document type ID', () => {
  const invoiceRaw =
    'busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1';

  it('formats BIS Billing 3.0 Invoice to the canonical string', () => {
    expect(formatDocumentTypeId(PEPPOL_BIS_BILLING_3_INVOICE)).toBe(invoiceRaw);
  });

  it('round-trips parse -> format', () => {
    expect(formatDocumentTypeId(parseDocumentTypeId(invoiceRaw))).toBe(invoiceRaw);
  });

  it('parse extracts every component', () => {
    const parsed = parseDocumentTypeId(invoiceRaw);
    expect(parsed.scheme).toBe('busdox-docid-qns');
    expect(parsed.rootNs).toBe('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
    expect(parsed.localName).toBe('Invoice');
    expect(parsed.customizationId).toBe(
      'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
    );
    expect(parsed.ublVersion).toBe('2.1');
  });

  it('round-trips the Credit Note constant', () => {
    const raw = formatDocumentTypeId(PEPPOL_BIS_BILLING_3_CREDIT_NOTE);
    expect(parseDocumentTypeId(raw)).toEqual(PEPPOL_BIS_BILLING_3_CREDIT_NOTE);
    expect(raw).toContain('CreditNote-2');
    expect(raw).toContain('::CreditNote##');
  });

  it('rejects malformed input', () => {
    expect(() => parseDocumentTypeId('busdox-docid-qns::no-hash-marker::2.1')).toThrow(/##/);
    expect(() => parseDocumentTypeId('busdox-docid-qns::only-two')).toThrow(/rootNs separator|##/);
    expect(() => parseDocumentTypeId('no-scheme-separator')).toThrow(/scheme/);
  });
});
