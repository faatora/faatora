import { XMLParser } from 'fast-xml-parser';

import { buildAs4UserMessage } from '../envelope.js';
import { makeIso6523ParticipantId, PEPPOL_BIS_BILLING_3_INVOICE } from '../metadata.js';
import { XML_NS } from '../types.js';
import { buildEbmsMessagingXml } from '../xml/user-message-xml.js';
import { buildSoapEnvelopeXml } from '../xml/soap-envelope.js';

function sample() {
  return buildAs4UserMessage({
    fromPartyId: makeIso6523ParticipantId('9915', 'faatora-c2'),
    toPartyId: makeIso6523ParticipantId('9915', 'partner-c3'),
    originalSender: makeIso6523ParticipantId('9915', 'om-seller-1'),
    finalRecipient: makeIso6523ParticipantId('9915', 'om-buyer-9'),
    documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
    payloadCid: 'cid:p@q',
    messageId: 'msg-xyz',
    timestamp: '2026-11-12T08:30:00.000Z',
    conversationId: 'conv-1',
  });
}

const PARSER = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
});

describe('buildSoapEnvelopeXml — structure', () => {
  it('wraps the messaging header in env:Envelope / env:Header', () => {
    const messagingXml = buildEbmsMessagingXml(sample());
    const xml = buildSoapEnvelopeXml({ messagingXml });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(`<env:Envelope xmlns:env="${XML_NS.soap}">`);
    expect(xml).toContain('<env:Header>');
    expect(xml).toContain('</env:Header>');
  });

  it('emits an empty env:Body (Peppol TIA §3.3)', () => {
    const messagingXml = buildEbmsMessagingXml(sample());
    const xml = buildSoapEnvelopeXml({ messagingXml });
    expect(xml).toContain('<env:Body/>');
  });

  it('indents the Messaging block inside the Header', () => {
    const messagingXml = buildEbmsMessagingXml(sample());
    const xml = buildSoapEnvelopeXml({ messagingXml });
    const lines = xml.split('\n');
    const bodyLine = lines.find((l) => l.includes('<eb:Messaging '));
    expect(bodyLine).toBeDefined();
    // Four-space indent (header pad is 4 spaces).
    expect(bodyLine!.startsWith('    <eb:Messaging ')).toBe(true);
  });

  it('round-trips through a generic parser into one envelope with one header', () => {
    const messagingXml = buildEbmsMessagingXml(sample());
    const xml = buildSoapEnvelopeXml({ messagingXml });
    const parsed = PARSER.parse(xml);
    expect(parsed.Envelope).toBeDefined();
    expect(parsed.Envelope.Header).toBeDefined();
    expect(parsed.Envelope.Header.Messaging).toBeDefined();
    expect(parsed.Envelope.Header.Messaging.UserMessage.MessageInfo.MessageId).toBe('msg-xyz');
  });
});

describe('buildSoapEnvelopeXml — signature placement', () => {
  it('places ds:Signature after eb:Messaging when provided', () => {
    const messagingXml = buildEbmsMessagingXml(sample());
    const fakeSig = `<ds:Signature xmlns:ds="${XML_NS.ds}"><ds:SignedInfo/></ds:Signature>`;
    const xml = buildSoapEnvelopeXml({ messagingXml, signatureXml: fakeSig });
    const msgIdx = xml.indexOf('<eb:Messaging ');
    const sigIdx = xml.indexOf('<ds:Signature ');
    expect(msgIdx).toBeGreaterThan(0);
    expect(sigIdx).toBeGreaterThan(msgIdx);
  });

  it('omits ds:Signature when not provided', () => {
    const messagingXml = buildEbmsMessagingXml(sample());
    const xml = buildSoapEnvelopeXml({ messagingXml });
    expect(xml).not.toContain('<ds:Signature');
  });
});
