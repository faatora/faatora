import { buildAs4UserMessage } from '../envelope.js';
import { makeIso6523ParticipantId, PEPPOL_BIS_BILLING_3_INVOICE } from '../metadata.js';
import {
  PartnerAspClient,
  PartnerAspHttpError,
  PartnerAspNetworkError,
  type PartnerAspClientOptions,
} from '../adapters/partner-asp-client.js';
import type { As4OutboundMessage, As4SendResult } from '../types.js';

function message(): As4OutboundMessage {
  return {
    envelope: buildAs4UserMessage({
      fromPartyId: makeIso6523ParticipantId('9915', 'faatora-c2'),
      toPartyId: makeIso6523ParticipantId('9915', 'partner-c3'),
      originalSender: makeIso6523ParticipantId('9915', 'om-seller-1'),
      finalRecipient: makeIso6523ParticipantId('9915', 'om-buyer-9'),
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:x@y',
      messageId: 'msg-xyz',
      timestamp: '2026-11-12T08:30:00.000Z',
    }),
    payload: '<Invoice/>',
  };
}

/**
 * A subclass that lets each test inject a sequence of `sendOnce`
 * behaviors (results or thrown errors). It is the smallest hook we
 * need to exercise the retry loop without stubbing the real HTTP
 * layer (which is itself a TODO).
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
    });
  });
});

describe('PartnerAspClient.sendOnce (default skeleton)', () => {
  it('surfaces the TODO as a non-retryable error result', async () => {
    const sleeps: number[] = [];
    const client = new PartnerAspClient({
      baseUrl: 'https://asp.example',
      apiKey: 'k',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await client.send(message());
    expect(res.status).toBe('error');
    expect(res.messageId).toBe('msg-xyz');
    expect(res.errors?.[0]).toMatch(/not implemented/);
    // Default errors are not retryable, so no sleeps occur.
    expect(sleeps).toEqual([]);
  });
});

describe('PartnerAspClient retry policy', () => {
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
