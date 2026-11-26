import { Agent } from 'node:https';

import { DirectAs4Sender, staticEndpointResolver } from '../adapters/direct.js';
import { buildAs4UserMessage } from '../envelope.js';
import type { MtlsHttpClient } from '../http/mtls-client.js';
import { makeIso6523ParticipantId, PEPPOL_BIS_BILLING_3_INVOICE } from '../metadata.js';
import { StubSigner } from '../signing/stub-signer.js';
import type { As4OutboundMessage } from '../types.js';

/**
 * A minimal in-process stub of a Peppol C3 AS4 endpoint — the same
 * test-double pattern the clearance module uses for ASP calls. The
 * stub records every incoming request and lets the test drive the
 * response (NRR accept, ebMS Error, 5xx, or a thrown transport
 * failure).
 */
class StubC3Receiver {
  readonly requests: Array<{ url: string; init: RequestInit }> = [];
  mode: 'accept' | 'reject' | 'serverError' | 'throw' = 'accept';
  lastRequestBody?: string;

  asHttpClient(): MtlsHttpClient {
    return {
      agent: new Agent(),
      fetch: async (url: string, init: RequestInit = {}) => {
        this.requests.push({ url, init });
        this.lastRequestBody =
          typeof init.body === 'string'
            ? init.body
            : init.body !== undefined && init.body !== null
              ? Buffer.isBuffer(init.body)
                ? init.body.toString('utf8')
                : String(init.body)
              : undefined;
        if (this.mode === 'throw') {
          throw new Error('ECONNRESET');
        }
        if (this.mode === 'serverError') {
          return new Response('internal', { status: 500 });
        }
        const refToMessageId = extractMessageId(this.lastRequestBody ?? '');
        const body =
          this.mode === 'accept'
            ? buildAcceptResponse(refToMessageId)
            : buildRejectResponse(refToMessageId);
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/soap+xml' },
        });
      },
    };
  }
}

function buildAcceptResponse(refToMessageId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
  <env:Header>
    <eb:Messaging xmlns:eb="http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/">
      <eb:SignalMessage>
        <eb:MessageInfo>
          <eb:Timestamp>2026-11-12T08:30:05.000Z</eb:Timestamp>
          <eb:MessageId>receipt-${refToMessageId}</eb:MessageId>
          <eb:RefToMessageId>${refToMessageId}</eb:RefToMessageId>
        </eb:MessageInfo>
        <eb:Receipt>
          <ebbp:NonRepudiationInformation xmlns:ebbp="http://docs.oasis-open.org/ebxml-bp/ebbp-signals-2.0">
            <ebbp:MessagePartNRInformation>
              <ds:Reference xmlns:ds="http://www.w3.org/2000/09/xmldsig#" URI="#_messaging"/>
            </ebbp:MessagePartNRInformation>
          </ebbp:NonRepudiationInformation>
        </eb:Receipt>
      </eb:SignalMessage>
    </eb:Messaging>
  </env:Header>
  <env:Body/>
</env:Envelope>`;
}

function buildRejectResponse(refToMessageId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
  <env:Header>
    <eb:Messaging xmlns:eb="http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/">
      <eb:SignalMessage>
        <eb:MessageInfo>
          <eb:MessageId>err-${refToMessageId}</eb:MessageId>
          <eb:RefToMessageId>${refToMessageId}</eb:RefToMessageId>
        </eb:MessageInfo>
        <eb:Error errorCode="EBMS:0007" severity="failure" shortDescription="PolicyNoncompliance">
          <eb:Description>Signature verification failed</eb:Description>
        </eb:Error>
      </eb:SignalMessage>
    </eb:Messaging>
  </env:Header>
  <env:Body/>
</env:Envelope>`;
}

function extractMessageId(body: string): string {
  const m = body.match(/<eb:MessageId>([^<]+)<\/eb:MessageId>/);
  return m ? m[1] : 'unknown';
}

function makeMessage(messageId = 'msg-rt-1'): As4OutboundMessage {
  return {
    envelope: buildAs4UserMessage({
      fromPartyId: makeIso6523ParticipantId('9915', 'faatora-c2'),
      toPartyId: makeIso6523ParticipantId('9915', 'partner-c3'),
      originalSender: makeIso6523ParticipantId('9915', 'om-seller-1'),
      finalRecipient: makeIso6523ParticipantId('9915', 'om-buyer-9'),
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:ubl-payload-1@faatora.om',
      messageId,
      timestamp: '2026-11-12T08:30:00.000Z',
      conversationId: 'conv-1',
    }),
    payload:
      '<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">INV-001</cbc:ID></Invoice>',
  };
}

function makeSender(stub: StubC3Receiver): DirectAs4Sender {
  return new DirectAs4Sender({
    signer: new StubSigner(),
    signingKeyRef: { keyRef: 'kms:faatora/sandbox/sign-01' },
    httpClient: stub.asHttpClient(),
    endpointResolver: staticEndpointResolver('https://ap.taxoman.gov.om/as4/receive'),
    mimeBoundary: () => 'test-boundary',
  });
}

describe('DirectAs4Sender — happy path round-trip', () => {
  it('returns accepted when the C3 endpoint signs an NRR receipt', async () => {
    const stub = new StubC3Receiver();
    const sender = makeSender(stub);
    const result = await sender.send(makeMessage());
    expect(result).toEqual({
      status: 'accepted',
      messageId: 'msg-rt-1',
    });
    expect(stub.requests).toHaveLength(1);
  });

  it('sends a POST to the resolved endpoint URL', async () => {
    const stub = new StubC3Receiver();
    const sender = makeSender(stub);
    await sender.send(makeMessage());
    expect(stub.requests[0].url).toBe('https://ap.taxoman.gov.om/as4/receive');
    expect(stub.requests[0].init.method).toBe('POST');
  });

  it('includes the correct Content-Type with multipart boundary', async () => {
    const stub = new StubC3Receiver();
    const sender = makeSender(stub);
    await sender.send(makeMessage());
    const headers = stub.requests[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toContain('multipart/related');
    expect(headers['Content-Type']).toContain('boundary="test-boundary"');
    expect(headers['Content-Type']).toContain('type="application/soap+xml"');
  });

  it('wraps the SOAP envelope, ds:Signature, and payload in the multipart body', async () => {
    const stub = new StubC3Receiver();
    const sender = makeSender(stub);
    await sender.send(makeMessage());
    const body = stub.lastRequestBody!;
    expect(body).toContain('--test-boundary');
    expect(body).toContain('Content-Type: application/soap+xml');
    expect(body).toContain('<env:Envelope');
    expect(body).toContain('<eb:Messaging ');
    expect(body).toContain('<ds:Signature ');
    expect(body).toContain('<eb:MessageId>msg-rt-1</eb:MessageId>');
    expect(body).toContain('Content-ID: <ubl-payload-1@faatora.om>');
    expect(body).toContain('<Invoice ');
    // Closes with the final boundary.
    expect(body).toMatch(/--test-boundary--\r\n$/);
  });
});

describe('DirectAs4Sender — reject path', () => {
  it('returns rejected with ebMS error details', async () => {
    const stub = new StubC3Receiver();
    stub.mode = 'reject';
    const sender = makeSender(stub);
    const result = await sender.send(makeMessage('msg-rt-2'));
    expect(result.status).toBe('rejected');
    expect(result.messageId).toBe('msg-rt-2');
    expect(result.errors?.[0]).toMatch(/EBMS:0007/);
    expect(result.errors?.[0]).toMatch(/Signature verification failed/);
  });
});

describe('DirectAs4Sender — transport errors', () => {
  it('returns error status on HTTP 5xx', async () => {
    const stub = new StubC3Receiver();
    stub.mode = 'serverError';
    const sender = makeSender(stub);
    const result = await sender.send(makeMessage());
    expect(result.status).toBe('error');
    expect(result.errors?.[0]).toMatch(/HTTP 500/);
  });

  it('returns error status on a thrown transport failure', async () => {
    const stub = new StubC3Receiver();
    stub.mode = 'throw';
    const sender = makeSender(stub);
    const result = await sender.send(makeMessage());
    expect(result.status).toBe('error');
    expect(result.errors?.[0]).toMatch(/ECONNRESET/);
  });

  it('returns error status when signing fails', async () => {
    const stub = new StubC3Receiver();
    const sender = new DirectAs4Sender({
      signer: {
        sign: async () => {
          throw new Error('KMS unavailable');
        },
      },
      signingKeyRef: { keyRef: 'kms:faatora/sandbox/sign-01' },
      httpClient: stub.asHttpClient(),
      endpointResolver: staticEndpointResolver('https://ap.taxoman.gov.om/as4/receive'),
    });
    const result = await sender.send(makeMessage());
    expect(result.status).toBe('error');
    expect(result.errors?.[0]).toMatch(/signing failed/);
    expect(stub.requests).toHaveLength(0);
  });

  it('returns error status when endpoint resolution fails', async () => {
    const stub = new StubC3Receiver();
    const sender = new DirectAs4Sender({
      signer: new StubSigner(),
      signingKeyRef: { keyRef: 'kms:faatora/sandbox/sign-01' },
      httpClient: stub.asHttpClient(),
      endpointResolver: {
        resolve: async () => {
          throw new Error('SMP down');
        },
      },
    });
    const result = await sender.send(makeMessage());
    expect(result.status).toBe('error');
    expect(result.errors?.[0]).toMatch(/endpoint resolution failed/);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('DirectAs4Sender — construction', () => {
  it('rejects missing signer', () => {
    expect(
      () =>
        new DirectAs4Sender({
          signer: undefined as unknown as StubSigner,
          signingKeyRef: { keyRef: 'k' },
          httpClient: new StubC3Receiver().asHttpClient(),
          endpointResolver: staticEndpointResolver('https://x'),
        }),
    ).toThrow(/signer/);
  });

  it('rejects missing httpClient', () => {
    expect(
      () =>
        new DirectAs4Sender({
          signer: new StubSigner(),
          signingKeyRef: { keyRef: 'k' },
          httpClient: undefined as unknown as MtlsHttpClient,
          endpointResolver: staticEndpointResolver('https://x'),
        }),
    ).toThrow(/httpClient/);
  });

  it('rejects missing endpointResolver', () => {
    expect(
      () =>
        new DirectAs4Sender({
          signer: new StubSigner(),
          signingKeyRef: { keyRef: 'k' },
          httpClient: new StubC3Receiver().asHttpClient(),
          endpointResolver: undefined as unknown as ReturnType<typeof staticEndpointResolver>,
        }),
    ).toThrow(/endpointResolver/);
  });
});
