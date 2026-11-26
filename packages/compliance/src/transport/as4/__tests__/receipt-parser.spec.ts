import { parseAs4Receipt } from '../xml/receipt-parser.js';

const NRR_RECEIPT = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
  <env:Header>
    <eb:Messaging xmlns:eb="http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/">
      <eb:SignalMessage>
        <eb:MessageInfo>
          <eb:Timestamp>2026-11-12T08:30:05.000Z</eb:Timestamp>
          <eb:MessageId>receipt-id-1</eb:MessageId>
          <eb:RefToMessageId>msg-xyz</eb:RefToMessageId>
        </eb:MessageInfo>
        <eb:Receipt>
          <ebbp:NonRepudiationInformation xmlns:ebbp="http://docs.oasis-open.org/ebxml-bp/ebbp-signals-2.0">
            <ebbp:MessagePartNRInformation>
              <ds:Reference xmlns:ds="http://www.w3.org/2000/09/xmldsig#" URI="#_messaging">
                <ds:DigestValue>abcd</ds:DigestValue>
              </ds:Reference>
            </ebbp:MessagePartNRInformation>
          </ebbp:NonRepudiationInformation>
        </eb:Receipt>
      </eb:SignalMessage>
    </eb:Messaging>
  </env:Header>
  <env:Body/>
</env:Envelope>`;

const ERROR_SIGNAL = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
  <env:Header>
    <eb:Messaging xmlns:eb="http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/">
      <eb:SignalMessage>
        <eb:MessageInfo>
          <eb:Timestamp>2026-11-12T08:30:06.000Z</eb:Timestamp>
          <eb:MessageId>err-1</eb:MessageId>
          <eb:RefToMessageId>msg-xyz</eb:RefToMessageId>
        </eb:MessageInfo>
        <eb:Error errorCode="EBMS:0007" severity="failure" shortDescription="PolicyNoncompliance">
          <eb:Description>Signature verification failed</eb:Description>
        </eb:Error>
      </eb:SignalMessage>
    </eb:Messaging>
  </env:Header>
  <env:Body/>
</env:Envelope>`;

const MULTI_ERROR_SIGNAL = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
  <env:Header>
    <eb:Messaging xmlns:eb="http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/">
      <eb:SignalMessage>
        <eb:MessageInfo>
          <eb:MessageId>err-2</eb:MessageId>
          <eb:RefToMessageId>msg-xyz</eb:RefToMessageId>
        </eb:MessageInfo>
        <eb:Error errorCode="EBMS:0004" severity="failure" shortDescription="Other">
          <eb:Description>First error</eb:Description>
        </eb:Error>
        <eb:Error errorCode="EBMS:0005" severity="failure" shortDescription="Other">
          <eb:Description>Second error</eb:Description>
        </eb:Error>
      </eb:SignalMessage>
    </eb:Messaging>
  </env:Header>
  <env:Body/>
</env:Envelope>`;

describe('parseAs4Receipt — happy paths', () => {
  it('classifies a Non-Repudiation Receipt as accepted', () => {
    const r = parseAs4Receipt(NRR_RECEIPT);
    expect(r.status).toBe('accepted');
    expect(r.refToMessageId).toBe('msg-xyz');
    expect(r.messageId).toBe('receipt-id-1');
    expect(r.timestamp).toBe('2026-11-12T08:30:05.000Z');
    expect(r.nrrContent).toBeDefined();
    expect(r.nrrContent).toContain('NonRepudiationInformation');
  });

  it('classifies an Error signal as rejected', () => {
    const r = parseAs4Receipt(ERROR_SIGNAL);
    expect(r.status).toBe('rejected');
    expect(r.refToMessageId).toBe('msg-xyz');
    expect(r.errors).toHaveLength(1);
    const first = r.errors![0];
    expect(first.code).toBe('EBMS:0007');
    expect(first.severity).toBe('failure');
    expect(first.shortDescription).toBe('PolicyNoncompliance');
    expect(first.description).toBe('Signature verification failed');
  });

  it('reads multiple Error entries', () => {
    const r = parseAs4Receipt(MULTI_ERROR_SIGNAL);
    expect(r.status).toBe('rejected');
    expect(r.errors).toHaveLength(2);
    expect(r.errors![0].code).toBe('EBMS:0004');
    expect(r.errors![1].code).toBe('EBMS:0005');
  });
});

describe('parseAs4Receipt — error paths', () => {
  it('returns error status on malformed XML', () => {
    const r = parseAs4Receipt('<not-valid-xml');
    expect(r.status).toBe('error');
    expect(r.errors?.[0].description).toContain('Malformed receipt XML');
  });

  it('returns error status when SignalMessage is missing', () => {
    const noSignal =
      '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Header/><env:Body/></env:Envelope>';
    const r = parseAs4Receipt(noSignal);
    expect(r.status).toBe('error');
    expect(r.errors?.[0].description).toContain('No eb:SignalMessage');
  });

  it('returns error status when the SignalMessage carries neither Receipt nor Error', () => {
    const empty = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
  <env:Header>
    <eb:Messaging xmlns:eb="http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/">
      <eb:SignalMessage>
        <eb:MessageInfo>
          <eb:MessageId>empty-1</eb:MessageId>
        </eb:MessageInfo>
      </eb:SignalMessage>
    </eb:Messaging>
  </env:Header>
  <env:Body/>
</env:Envelope>`;
    const r = parseAs4Receipt(empty);
    expect(r.status).toBe('error');
  });
});
