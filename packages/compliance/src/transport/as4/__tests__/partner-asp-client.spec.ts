import { buildAs4UserMessage } from '../envelope.js';
import { makeIso6523ParticipantId, PEPPOL_BIS_BILLING_3_INVOICE } from '../metadata.js';
import {
  JsonWireProtocol,
  PartnerAspClient,
  PartnerAspHttpError,
  PartnerAspNetworkError,
  type PartnerAspClientOptions,
  type WireProtocol,
} from '../adapters/partner-asp-client.js';
import type { As4OutboundMessage, As4SendResult } from '../types.js';

function message(overrides: { messageId?: string } = {}): As4OutboundMessage {
  return {
    envelope: buildAs4UserMessage({
      fromPartyId: makeIso6523ParticipantId('9915', 'faatora-c2'),
      toPartyId: makeIso6523ParticipantId('9915', 'partner-c3'),
      originalSender: makeIso6523ParticipantId('9915', 'om-seller-1'),
      finalRecipient: makeIso6523ParticipantId('9915', 'om-buyer-9'),
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:x@y',
      messageId: overrides.messageId ?? 'msg-xyz',
      timestamp: '2026-11-12T08:30:00.000Z',
    }),
    payload: '<Invoice/>',
  };
}

/**
 * A subclass that lets each test inject a sequence of `sendOnce`
 * behaviors (results or thrown errors). It is the smallest hook we
 * need to exercise the retry loop without stubbing fetch.
 */
class ScriptedPartnerAspClient extends PartnerAspClient {
  public attempts = 0;
  constructor(
    opts: PartnerAspClientOptions,
    private readonly script: ReadonlyArray<As4SendResult | Error>,
  ) {
    super(opts);
  }
  protected override async sendOnce(_msg: As4OutboundMessage): Promise<As4SendResult> {
    const step = this.script[this.attempts];
    this.attempts += 1;
    if (!step) {
      throw new Error(
        `ScriptedPartnerAspClient: ran off the end of the script at attempt ${this.attempts}`,
      );
    }
    if (step instanceof Error) throw step;
    return step;
  }
}

/**
 * Lightweight fetch mock that returns scripted responses in order and
 * records every call it saw. Lets us assert the exact URL, headers
 * and body the client built without touching the network.
 */
class ScriptedFetch {
  public readonly calls: Array<{ url: string; init: RequestInit }> = [];
  private i = 0;
  constructor(private readonly responses: ReadonlyArray<Response | Error>) {}
  readonly impl: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    this.calls.push({ url, init: init ?? {} });
    const step = this.responses[this.i];
    this.i += 1;
    if (!step) throw new Error(`ScriptedFetch: ran off the end at call ${this.i}`);
    if (step instanceof Error) throw step;
    return step;
  };
}

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string, statusText = ''): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('PartnerAspClient construction', () => {
  it('rejects empty baseUrl', () => {
    expect(() => new PartnerAspClient({ baseUrl: '', apiKey: 'k' })).toThrow(/baseUrl/);
  });
  it('rejects empty apiKey', () => {
    expect(() => new PartnerAspClient({ baseUrl: 'https://asp.example', apiKey: '' })).toThrow(
      /apiKey/,
    );
  });
  it('exposes resolved config with defaults', () => {
    const c = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'k',
    });
    expect(c.config).toEqual({
      baseUrl: 'https://asp.example',
      apiKey: 'k',
      maxRetries: 5,
      initialBackoffMs: 500,
      maxBackoffMs: 30_000,
      requestTimeoutMs: 30_000,
    });
  });
});

describe('PartnerAspClient.sendOnce (default JSON wire)', () => {
  it('posts a JSON body with the envelope fields and Bearer auth', async () => {
    const fetchMock = new ScriptedFetch([
      jsonResponse(200, {
        messageId: 'msg-xyz',
        aspReference: 'asp-1',
        otaReference: 'ota-1',
        status: 'accepted',
      }),
    ]);
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async () => {},
    });
    const res = await client.send(message());
    expect(res).toEqual({
      status: 'accepted',
      messageId: 'msg-xyz',
      aspReference: 'asp-1',
      otaReference: 'ota-1',
    });
    expect(fetchMock.calls).toHaveLength(1);
    const [call] = fetchMock.calls;
    expect(call.url).toBe('https://asp.example/documents/outbound');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe('Bearer K');
    const body = JSON.parse(call.init.body as string);
    expect(body.messageId).toBe('msg-xyz');
    expect(body.timestamp).toBe('2026-11-12T08:30:00.000Z');
    expect(body.from.identifier).toBe('9915:faatora-c2');
    expect(body.to.identifier).toBe('9915:partner-c3');
    expect(body.originalSender.identifier).toBe('9915:om-seller-1');
    expect(body.finalRecipient.identifier).toBe('9915:om-buyer-9');
    expect(body.documentTypeId.rootNs).toContain('Invoice');
    expect(typeof body.documentTypeId.value).toBe('string');
    expect(body.documentTypeId.value).toContain('##');
    expect(body.processId.scheme).toBeTruthy();
    expect(body.payloadMimeType).toBe('application/xml');
    // Payload is base64 of '<Invoice/>'.
    expect(Buffer.from(body.payload, 'base64').toString('utf8')).toBe('<Invoice/>');
  });

  it('surfaces a 2xx body with status=rejected as a non-retryable rejection', async () => {
    const fetchMock = new ScriptedFetch([
      jsonResponse(200, {
        messageId: 'msg-xyz',
        status: 'rejected',
        errors: [{ code: 'UBL-SCH-001', message: 'missing /Invoice/cbc:ID' }, 'free-form warning'],
      }),
    ]);
    const sleeps: number[] = [];
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await client.send(message());
    expect(res.status).toBe('rejected');
    expect(res.messageId).toBe('msg-xyz');
    expect(res.errors).toEqual(['UBL-SCH-001: missing /Invoice/cbc:ID', 'free-form warning']);
    expect(fetchMock.calls).toHaveLength(1); // Not retried.
    expect(sleeps).toEqual([]);
  });

  it('accepts a 2xx body that is not JSON (treats as implicit accept)', async () => {
    const fetchMock = new ScriptedFetch([textResponse(200, 'OK')]);
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async () => {},
    });
    const res = await client.send(message());
    expect(res.status).toBe('accepted');
    expect(res.messageId).toBe('msg-xyz');
    expect(res.aspReference).toBeUndefined();
  });

  it('maps a 4xx to a non-retryable rejected result with the body', async () => {
    const fetchMock = new ScriptedFetch([textResponse(400, 'malformed envelope', 'Bad Request')]);
    const sleeps: number[] = [];
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await client.send(message());
    expect(res.status).toBe('rejected');
    expect(res.messageId).toBe('msg-xyz');
    expect(res.errors?.[0]).toContain('PartnerAspHttpError');
    expect(res.errors?.[0]).toContain('400');
    expect(sleeps).toEqual([]);
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('retries a 5xx response with exponential backoff', async () => {
    const fetchMock = new ScriptedFetch([
      textResponse(503, 'down', 'Service Unavailable'),
      textResponse(502, 'bad gateway', 'Bad Gateway'),
      jsonResponse(200, { messageId: 'msg-xyz', status: 'accepted' }),
    ]);
    const sleeps: number[] = [];
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await client.send(message());
    expect(res.status).toBe('accepted');
    expect(fetchMock.calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('retries a thrown network error', async () => {
    const fetchMock = new ScriptedFetch([
      new Error('ECONNRESET'),
      jsonResponse(200, { messageId: 'msg-xyz', status: 'accepted' }),
    ]);
    const sleeps: number[] = [];
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await client.send(message());
    expect(res.status).toBe('accepted');
    expect(sleeps).toEqual([500]);
  });

  it('uses x-api-key auth when authMode is x-api-key', async () => {
    const fetchMock = new ScriptedFetch([jsonResponse(200, { status: 'accepted' })]);
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async () => {},
      wireProtocol: new JsonWireProtocol({ authMode: 'x-api-key' }),
    });
    await client.send(message());
    const headers = fetchMock.calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('K');
    expect(headers['authorization']).toBeUndefined();
  });

  it('honors a custom path override', async () => {
    const fetchMock = new ScriptedFetch([jsonResponse(200, { status: 'accepted' })]);
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example/',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async () => {},
      wireProtocol: new JsonWireProtocol({ path: '/v2/peppol/send' }),
    });
    await client.send(message());
    expect(fetchMock.calls[0].url).toBe('https://asp.example/v2/peppol/send');
  });

  it('honors response-field overrides (ClearTax-style aliases)', async () => {
    const fetchMock = new ScriptedFetch([
      jsonResponse(200, {
        documentId: 'msg-xyz',
        clearTaxRef: 'ct-abc',
        taxAuthorityRef: 'ota-def',
        state: 'accepted',
      }),
    ]);
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async () => {},
      wireProtocol: new JsonWireProtocol({
        responseFields: {
          messageId: 'documentId',
          aspReference: 'clearTaxRef',
          otaReference: 'taxAuthorityRef',
          status: 'state',
        },
      }),
    });
    const res = await client.send(message());
    expect(res).toEqual({
      status: 'accepted',
      messageId: 'msg-xyz',
      aspReference: 'ct-abc',
      otaReference: 'ota-def',
    });
  });

  it('uses a wire protocol override entirely (multipart etc.)', async () => {
    const fetchMock = new ScriptedFetch([jsonResponse(200, {})]);
    const customProto: WireProtocol = {
      buildRequest: (_msg, ctx) => ({
        url: `${ctx.baseUrl}/custom`,
        init: { method: 'POST', body: 'CUSTOM' },
      }),
      parseResponse: async (_resp, msg) => ({
        status: 'accepted',
        messageId: msg.envelope.messageId,
      }),
    };
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock.impl,
      sleep: async () => {},
      wireProtocol: customProto,
    });
    const res = await client.send(message());
    expect(res.status).toBe('accepted');
    expect(fetchMock.calls[0].init.body).toBe('CUSTOM');
    expect(fetchMock.calls[0].url).toBe('https://asp.example/custom');
  });

  it('times out and treats as retryable network error', async () => {
    // Simulate a fetch that hangs by never resolving — but our
    // AbortController will fire after requestTimeoutMs. We shortcut
    // the timer logic by using a fetch impl that throws an AbortError
    // synchronously when it sees the signal already aborted. The
    // real timer is 30s by default; we lower it to 5ms.
    const fetchMock: typeof fetch = async (_url, init) => {
      await new Promise((r) => setTimeout(r, 20)); // past the 5ms timer
      const err = new DOMException(
        (init?.signal?.reason as Error | undefined)?.message ?? 'aborted',
        'AbortError',
      );
      throw err;
    };
    const sleeps: number[] = [];
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'K',
      fetchImpl: fetchMock,
      requestTimeoutMs: 5,
      maxRetries: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await client.send(message());
    expect(res.status).toBe('error');
    expect(res.errors?.[0]).toContain('PartnerAspNetworkError');
    // One initial try + one retry (because timeouts are retryable
    // as network errors) = 2 attempts. One sleep between them.
    expect(sleeps).toEqual([500]);
  });
});

describe('PartnerAspClient retry policy (scripted sendOnce)', () => {
  it('retries 5xx with exponential backoff and succeeds on recovery', async () => {
    const sleeps: number[] = [];
    const client = new ScriptedPartnerAspClient(
      {
        baseUrl: 'https://asp.example',
        apiKey: 'k',
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      [
        new PartnerAspHttpError(503, 'down'),
        new PartnerAspHttpError(502, 'bad gateway'),
        { status: 'accepted', messageId: 'msg-xyz' },
      ],
    );

    const res = await client.send(message());
    expect(res).toEqual({ status: 'accepted', messageId: 'msg-xyz' });
    expect(client.attempts).toBe(3);
    // backoffFor(0)=500, backoffFor(1)=1000.
    expect(sleeps).toEqual([500, 1000]);
  });

  it('retries network errors', async () => {
    const sleeps: number[] = [];
    const client = new ScriptedPartnerAspClient(
      {
        baseUrl: 'https://asp.example',
        apiKey: 'k',
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      [new PartnerAspNetworkError('ECONNRESET'), { status: 'accepted', messageId: 'msg-xyz' }],
    );
    const res = await client.send(message());
    expect(res.status).toBe('accepted');
    expect(sleeps).toEqual([500]);
  });

  it('does not retry 4xx and reports rejected', async () => {
    const sleeps: number[] = [];
    const client = new ScriptedPartnerAspClient(
      {
        baseUrl: 'https://asp.example',
        apiKey: 'k',
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      [new PartnerAspHttpError(400, 'bad request', 'malformed envelope')],
    );
    const res = await client.send(message());
    expect(res.status).toBe('rejected');
    expect(res.messageId).toBe('msg-xyz');
    expect(res.errors?.[0]).toContain('PartnerAspHttpError');
    expect(client.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('stops after maxRetries and returns an error result', async () => {
    const sleeps: number[] = [];
    const client = new ScriptedPartnerAspClient(
      {
        baseUrl: 'https://asp.example',
        apiKey: 'k',
        maxRetries: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      [
        new PartnerAspHttpError(503, 'down'),
        new PartnerAspHttpError(503, 'down'),
        new PartnerAspHttpError(503, 'down'),
      ],
    );
    const res = await client.send(message());
    expect(res.status).toBe('error');
    expect(client.attempts).toBe(3); // 1 + maxRetries
    // Sleeps between attempts: backoffFor(0)=500, backoffFor(1)=1000.
    expect(sleeps).toEqual([500, 1000]);
  });

  it('caps backoff at maxBackoffMs', async () => {
    const sleeps: number[] = [];
    const client = new ScriptedPartnerAspClient(
      {
        baseUrl: 'https://asp.example',
        apiKey: 'k',
        maxRetries: 5,
        initialBackoffMs: 1000,
        maxBackoffMs: 3000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      [
        new PartnerAspHttpError(500, 'x'),
        new PartnerAspHttpError(500, 'x'),
        new PartnerAspHttpError(500, 'x'),
        new PartnerAspHttpError(500, 'x'),
        new PartnerAspHttpError(500, 'x'),
        { status: 'accepted', messageId: 'msg-xyz' },
      ],
    );
    const res = await client.send(message());
    expect(res.status).toBe('accepted');
    // 1000, 2000, 3000 (cap), 3000, 3000.
    expect(sleeps).toEqual([1000, 2000, 3000, 3000, 3000]);
  });
});
