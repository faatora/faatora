import { XMLParser } from 'fast-xml-parser';

import { buildAs4UserMessage } from '../envelope.js';
import {
  makeIso6523ParticipantId,
  PEPPOL_BIS_BILLING_3_CREDIT_NOTE,
  PEPPOL_BIS_BILLING_3_INVOICE,
} from '../metadata.js';
import { PEPPOL, XML_NS } from '../types.js';
import { buildEbmsMessagingXml } from '../xml/user-message-xml.js';

const seller = makeIso6523ParticipantId('9915', 'om-seller-1');
const buyer = makeIso6523ParticipantId('9915', 'om-buyer-9');
const sellerAsp = makeIso6523ParticipantId('9915', 'faatora-c2');
const buyerAsp = makeIso6523ParticipantId('9915', 'partner-c3');

function sampleEnvelope() {
  return buildAs4UserMessage({
    fromPartyId: sellerAsp,
    toPartyId: buyerAsp,
    originalSender: seller,
    finalRecipient: buyer,
    documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
    payloadCid: 'cid:ubl-invoice-123@faatora.om',
    messageId: '11111111-2222-3333-4444-555555555555',
    timestamp: '2026-11-12T08:30:00.000Z',
    conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
}

describe('buildEbmsMessagingXml — root element', () => {
  it('produces a well-formed <eb:Messaging> fragment with the correct namespaces', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    expect(xml.startsWith('<eb:Messaging ')).toBe(true);
    expect(xml).toContain(`xmlns:eb="${XML_NS.ebms}"`);
    expect(xml).toContain(`xmlns:wsu="${XML_NS.wsu}"`);
    expect(xml).toContain(`xmlns:env="${XML_NS.soap}"`);
    // ebMS 3.0 Part 2: mustUnderstand=true on the Messaging header.
    expect(xml).toContain('env:mustUnderstand="true"');
  });

  it('uses the default wsu:Id and lets the caller override it', () => {
    const def = buildEbmsMessagingXml(sampleEnvelope());
    expect(def).toContain('wsu:Id="_messaging"');
    const custom = buildEbmsMessagingXml(sampleEnvelope(), { wsuId: 'id-ebms' });
    expect(custom).toContain('wsu:Id="id-ebms"');
    expect(custom).not.toContain('wsu:Id="_messaging"');
  });
});

describe('buildEbmsMessagingXml — MessageInfo', () => {
  it('emits Timestamp and MessageId in document order', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    const tsIdx = xml.indexOf('<eb:Timestamp>');
    const idIdx = xml.indexOf('<eb:MessageId>');
    expect(tsIdx).toBeGreaterThan(0);
    expect(idIdx).toBeGreaterThan(tsIdx);
    expect(xml).toContain('<eb:Timestamp>2026-11-12T08:30:00.000Z</eb:Timestamp>');
    expect(xml).toContain('<eb:MessageId>11111111-2222-3333-4444-555555555555</eb:MessageId>');
  });
});

describe('buildEbmsMessagingXml — PartyInfo', () => {
  it('emits From/To with Peppol roles and iso6523 PartyId @type', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    expect(xml).toContain('<eb:PartyId type="iso6523-actorid-upis">9915:faatora-c2</eb:PartyId>');
    expect(xml).toContain('<eb:PartyId type="iso6523-actorid-upis">9915:partner-c3</eb:PartyId>');
    expect(xml).toContain(`<eb:Role>${PEPPOL.initiatorRole}</eb:Role>`);
    expect(xml).toContain(`<eb:Role>${PEPPOL.responderRole}</eb:Role>`);
  });

  it('places From before To (ebMS 3.0 §5.2.2.2)', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    const fromIdx = xml.indexOf('<eb:From>');
    const toIdx = xml.indexOf('<eb:To>');
    expect(fromIdx).toBeGreaterThan(0);
    expect(toIdx).toBeGreaterThan(fromIdx);
  });
});

describe('buildEbmsMessagingXml — CollaborationInfo', () => {
  it('emits AgreementRef, Service, Action and ConversationId in that order', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    const agrIdx = xml.indexOf('<eb:AgreementRef>');
    const svcIdx = xml.indexOf('<eb:Service ');
    const actIdx = xml.indexOf('<eb:Action>');
    const convIdx = xml.indexOf('<eb:ConversationId>');
    expect(agrIdx).toBeGreaterThan(0);
    expect(svcIdx).toBeGreaterThan(agrIdx);
    expect(actIdx).toBeGreaterThan(svcIdx);
    expect(convIdx).toBeGreaterThan(actIdx);
  });

  it('carries the Peppol BIS Billing 3.0 agreement ref and process id by default', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    expect(xml).toContain(
      '<eb:AgreementRef>urn:fdc:peppol.eu:2017:agreements:tia:bis3</eb:AgreementRef>',
    );
    expect(xml).toContain(
      '<eb:Service type="cenbii-procid-ubl">urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</eb:Service>',
    );
    expect(xml).toContain(
      '<eb:Action>busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1</eb:Action>',
    );
    expect(xml).toContain(
      '<eb:ConversationId>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</eb:ConversationId>',
    );
  });

  it('serializes credit-note documentTypeId correctly', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_CREDIT_NOTE,
      payloadCid: 'cid:cn@faatora.om',
      messageId: 'm-1',
      timestamp: '2026-11-12T08:30:00.000Z',
      conversationId: 'c-1',
    });
    const xml = buildEbmsMessagingXml(env);
    expect(xml).toContain(
      '<eb:Action>busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1</eb:Action>',
    );
  });
});

describe('buildEbmsMessagingXml — MessageProperties', () => {
  it('emits exactly two Property entries, originalSender then finalRecipient', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    const osIdx = xml.indexOf('name="originalSender"');
    const frIdx = xml.indexOf('name="finalRecipient"');
    expect(osIdx).toBeGreaterThan(0);
    expect(frIdx).toBeGreaterThan(osIdx);
    expect(xml).toContain(
      '<eb:Property name="originalSender" type="iso6523-actorid-upis">9915:om-seller-1</eb:Property>',
    );
    expect(xml).toContain(
      '<eb:Property name="finalRecipient" type="iso6523-actorid-upis">9915:om-buyer-9</eb:Property>',
    );
  });
});

describe('buildEbmsMessagingXml — PayloadInfo', () => {
  it('emits one PartInfo with @href = cid:... and MimeType PartProperty', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    expect(xml).toContain('<eb:PartInfo href="cid:ubl-invoice-123@faatora.om">');
    expect(xml).toContain('<eb:Property name="MimeType">application/xml</eb:Property>');
  });

  it('serializes extra part properties alongside MimeType', () => {
    const env = buildAs4UserMessage({
      fromPartyId: sellerAsp,
      toPartyId: buyerAsp,
      originalSender: seller,
      finalRecipient: buyer,
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:x@y',
      extraPayloadProperties: { CompressionType: 'application/gzip' },
      messageId: 'mid',
      timestamp: '2026-11-12T08:30:00.000Z',
      conversationId: 'c',
    });
    const xml = buildEbmsMessagingXml(env);
    expect(xml).toContain('<eb:Property name="MimeType">application/xml</eb:Property>');
    expect(xml).toContain('<eb:Property name="CompressionType">application/gzip</eb:Property>');
  });
});

describe('buildEbmsMessagingXml — parses back cleanly', () => {
  it('round-trips through a generic XML parser', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope());
    const parser = new XMLParser({
      attributeNamePrefix: '@_',
      ignoreAttributes: false,
      removeNSPrefix: true,
      textNodeName: '#text',
      parseAttributeValue: false,
      parseTagValue: false,
    });
    const parsed = parser.parse(xml);
    const um = parsed.Messaging.UserMessage;
    expect(um.MessageInfo.MessageId).toBe('11111111-2222-3333-4444-555555555555');
    expect(um.MessageInfo.Timestamp).toBe('2026-11-12T08:30:00.000Z');
    expect(um.PartyInfo.From.PartyId['@_type']).toBe('iso6523-actorid-upis');
    expect(um.PartyInfo.From.PartyId['#text']).toBe('9915:faatora-c2');
    expect(um.PartyInfo.To.PartyId['#text']).toBe('9915:partner-c3');
    expect(um.CollaborationInfo.Service['@_type']).toBe('cenbii-procid-ubl');
    expect(um.CollaborationInfo.Service['#text']).toBe(
      'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    );
    expect(um.CollaborationInfo.Action).toContain(
      'busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice',
    );
    expect(um.PayloadInfo.PartInfo['@_href']).toBe('cid:ubl-invoice-123@faatora.om');
    // Properties are an array of two entries.
    const props = um.MessageProperties.Property;
    expect(Array.isArray(props)).toBe(true);
    expect(props[0]['@_name']).toBe('originalSender');
    expect(props[1]['@_name']).toBe('finalRecipient');
  });
});

describe('buildEbmsMessagingXml — determinism', () => {
  it('is byte-identical for the same input (signing requires this)', () => {
    const a = buildEbmsMessagingXml(sampleEnvelope());
    const b = buildEbmsMessagingXml(sampleEnvelope());
    expect(a).toBe(b);
  });

  it('matches the expected fixture byte-for-byte', () => {
    const xml = buildEbmsMessagingXml(sampleEnvelope(), { pretty: true });
    // Full-fixture check — any drift in child-element order,
    // namespace prefix, or whitespace flips this test, which is
    // exactly what we want: a signed message cannot afford drift.
    expect(xml).toBe(EXPECTED_MESSAGING_XML);
  });
});

const EXPECTED_MESSAGING_XML = [
  '<eb:Messaging xmlns:eb="http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" wsu:Id="_messaging" env:mustUnderstand="true" xmlns:env="http://www.w3.org/2003/05/soap-envelope">',
  '  <eb:UserMessage>',
  '    <eb:MessageInfo>',
  '      <eb:Timestamp>2026-11-12T08:30:00.000Z</eb:Timestamp>',
  '      <eb:MessageId>11111111-2222-3333-4444-555555555555</eb:MessageId>',
  '    </eb:MessageInfo>',
  '    <eb:PartyInfo>',
  '      <eb:From>',
  '        <eb:PartyId type="iso6523-actorid-upis">9915:faatora-c2</eb:PartyId>',
  '        <eb:Role>http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/initiator</eb:Role>',
  '      </eb:From>',
  '      <eb:To>',
  '        <eb:PartyId type="iso6523-actorid-upis">9915:partner-c3</eb:PartyId>',
  '        <eb:Role>http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/responder</eb:Role>',
  '      </eb:To>',
  '    </eb:PartyInfo>',
  '    <eb:CollaborationInfo>',
  '      <eb:AgreementRef>urn:fdc:peppol.eu:2017:agreements:tia:bis3</eb:AgreementRef>',
  '      <eb:Service type="cenbii-procid-ubl">urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</eb:Service>',
  '      <eb:Action>busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1</eb:Action>',
  '      <eb:ConversationId>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</eb:ConversationId>',
  '    </eb:CollaborationInfo>',
  '    <eb:MessageProperties>',
  '      <eb:Property name="originalSender" type="iso6523-actorid-upis">9915:om-seller-1</eb:Property>',
  '      <eb:Property name="finalRecipient" type="iso6523-actorid-upis">9915:om-buyer-9</eb:Property>',
  '    </eb:MessageProperties>',
  '    <eb:PayloadInfo>',
  '      <eb:PartInfo href="cid:ubl-invoice-123@faatora.om">',
  '        <eb:PartProperties>',
  '          <eb:Property name="MimeType">application/xml</eb:Property>',
  '        </eb:PartProperties>',
  '      </eb:PartInfo>',
  '    </eb:PayloadInfo>',
  '  </eb:UserMessage>',
  '</eb:Messaging>',
].join('\n');
