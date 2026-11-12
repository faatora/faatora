import { buildAs4UserMessage } from '../envelope.js';
import {
  formatDocumentTypeId,
  formatParticipantId,
  makeIso6523ParticipantId,
  PEPPOL_BIS_BILLING_3_INVOICE,
  PEPPOL_BIS_BILLING_3_PROCESS,
} from '../metadata.js';
import { PEPPOL } from '../types.js';

const seller = makeIso6523ParticipantId('9915', 'om-seller-1');
const buyer = makeIso6523ParticipantId('9915', 'om-buyer-9');
const sellerAsp = makeIso6523ParticipantId('9915', 'faatora-c2');
const buyerAsp = makeIso6523ParticipantId('9915', 'partner-c3');

describe('buildAs4UserMessage', () => {
  it('returns a fully-populated envelope with explicit identifiers', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:ubl-invoice@faatora.om',
      messageId: '11111111-2222-3333-4444-555555555555',
      timestamp: '2026-11-12T08:30:00.000Z',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    expect(env.messageId).toBe('11111111-2222-3333-4444-555555555555');
    expect(env.timestamp).toBe('2026-11-12T08:30:00.000Z');
    expect(env.collaborationInfo.conversationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('uses the Peppol-mandated roles on From and To', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:p@x',
    });
    expect(env.from.role).toBe(PEPPOL.initiatorRole);
    expect(env.to.role).toBe(PEPPOL.responderRole);
  });

  it('formats participant IDs with the Peppol scheme', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:p@x',
    });
    expect(formatParticipantId(env.from.partyId)).toBe('iso6523-actorid-upis::9915:faatora-c2');
    expect(formatParticipantId(env.to.partyId)).toBe('iso6523-actorid-upis::9915:partner-c3');
    expect(formatParticipantId(env.messageProperties.originalSender)).toBe(
      'iso6523-actorid-upis::9915:om-seller-1',
    );
    expect(formatParticipantId(env.messageProperties.finalRecipient)).toBe(
      'iso6523-actorid-upis::9915:om-buyer-9',
    );
  });

  it('carries BIS Billing 3.0 defaults in collaborationInfo', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:p@x',
    });
    expect(env.collaborationInfo.agreementRef).toBe('urn:fdc:peppol.eu:2017:agreements:tia:bis3');
    expect(env.collaborationInfo.service).toEqual(PEPPOL_BIS_BILLING_3_PROCESS);
    expect(env.collaborationInfo.service.value).toBe('urn:fdc:peppol.eu:2017:poacc:billing:01:1.0');
    expect(formatDocumentTypeId(env.collaborationInfo.action)).toBe(
      formatDocumentTypeId(PEPPOL_BIS_BILLING_3_INVOICE),
    );
  });

  it('builds a single payload PartInfo with the Peppol MimeType property', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:ubl-invoice@faatora.om',
    });
    expect(env.payloadInfo.parts).toHaveLength(1);
    const part = env.payloadInfo.parts[0];
    expect(part.href).toBe('cid:ubl-invoice@faatora.om');
    expect(part.mimeType).toBe('application/xml');
    expect(part.properties?.MimeType).toBe('application/xml');
  });

  it('merges extraPayloadProperties over defaults', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:x',
      extraPayloadProperties: { CompressionType: 'application/gzip' },
    });
    expect(env.payloadInfo.parts[0].properties).toEqual({
      MimeType: 'application/xml',
      CompressionType: 'application/gzip',
    });
  });

  it('generates a UUID messageId and ISO timestamp when not supplied', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:x',
    });
    // UUID v4 pattern.
    expect(env.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // ISO-8601 UTC with ms.
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('rejects an invalid timestamp', () => {
    expect(() =>
      buildAs4UserMessage({
        fromPartyId: sellerAsp,
        toPartyId: buyerAsp,
        originalSender: seller,
        finalRecipient: buyer,
        documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
        payloadCid: 'cid:x',
        timestamp: 'not-a-date',
      }),
    ).toThrow(/Invalid AS4 timestamp/);
  });
});
