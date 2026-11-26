import { Agent } from 'node:https';

import {
  createMtlsHttpClient,
  MtlsConfigurationError,
  MtlsTimeoutError,
  type MtlsCredentials,
} from '../http/mtls-client.js';

/**
 * Dummy PEM blobs. We never run them through a real TLS stack in
 * these tests, so their cryptographic validity does not matter —
 * but they must look like PEM so the constructor's assertion passes.
 */
const DUMMY_CERT_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBdummycertforfaatoratest==\n-----END CERTIFICATE-----';
const DUMMY_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMIIBdummykeyforfaatoratest==\n-----END PRIVATE KEY-----';
const DUMMY_CA_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBdummycatestonly==\n-----END CERTIFICATE-----';

const VALID_CREDS: MtlsCredentials = {
  cert: DUMMY_CERT_PEM,
  key: DUMMY_KEY_PEM,
};

describe('createMtlsHttpClient — construction', () => {
  it('rejects a missing cert', () => {
    expect(() => createMtlsHttpClient({ credentials: { cert: '', key: DUMMY_KEY_PEM } })).toThrow(
      MtlsConfigurationError,
    );
  });

  it('rejects a cert that does not look like PEM', () => {
    expect(() =>
      createMtlsHttpClient({ credentials: { cert: 'not a pem', key: DUMMY_KEY_PEM } }),
    ).toThrow(/cert PEM/);
  });

  it('rejects a missing key', () => {
    expect(() => createMtlsHttpClient({ credentials: { cert: DUMMY_CERT_PEM, key: '' } })).toThrow(
      /key PEM/,
    );
  });

  it('accepts EC and RSA private key PEMs', () => {
    const ec = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIGZz\n-----END EC PRIVATE KEY-----';
    const rsa = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC\n-----END RSA PRIVATE KEY-----';
    expect(() =>
      createMtlsHttpClient({ credentials: { cert: DUMMY_CERT_PEM, key: ec } }),
    ).not.toThrow();
    expect(() =>
      createMtlsHttpClient({ credentials: { cert: DUMMY_CERT_PEM, key: rsa } }),
    ).not.toThrow();
  });

  it('rejects a malformed CA', () => {
    expect(() =>
      createMtlsHttpClient({
        credentials: { cert: DUMMY_CERT_PEM, key: DUMMY_KEY_PEM, ca: 'not-pem' },
      }),
    ).toThrow(/ca PEM/);
  });

  it('exposes the underlying https.Agent', () => {
    const client = createMtlsHttpClient({ credentials: VALID_CREDS });
    expect(client.agent).toBeInstanceOf(Agent);
  });

  it('refuses connectTimeoutMs <= 0', () => {
    expect(() => createMtlsHttpClient({ credentials: VALID_CREDS, connectTimeoutMs: 0 })).toThrow(
      MtlsConfigurationError,
    );
  });

  it('refuses totalTimeoutMs smaller than connectTimeoutMs', () => {
    expect(() =>
      createMtlsHttpClient({
        credentials: VALID_CREDS,
        connectTimeoutMs: 30_000,
        totalTimeoutMs: 15_000,
      }),
    ).toThrow(/totalTimeoutMs/);
  });

  it('accepts an optional CA PEM', () => {
    const client = createMtlsHttpClient({
      credentials: { ...VALID_CREDS, ca: DUMMY_CA_PEM },
    });
    expect(client).toBeDefined();
  });
});

describe('createMtlsHttpClient — fetch behaviour', () => {
  it('passes the agent through to the underlying fetch', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      seenInit = init;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const client = createMtlsHttpClient({ credentials: VALID_CREDS, fetchImpl });
    await client.fetch('https://asp.example');
    expect(seenInit).toBeDefined();
    const bag = seenInit as RequestInit & { dispatcher?: unknown; agent?: Agent };
    expect(bag.dispatcher).toBe(client.agent);
    expect(bag.agent).toBe(client.agent);
  });

  it('propagates the response body and status to the caller', async () => {
    const fetchImpl = (async () =>
      new Response('body-here', { status: 202 })) as unknown as typeof fetch;
    const client = createMtlsHttpClient({ credentials: VALID_CREDS, fetchImpl });
    const res = await client.fetch('https://asp.example');
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('body-here');
  });

  it('fires total-timeout when the fetch never resolves', async () => {
    // A fetch that reads the signal and rejects on abort — the real
    // fetch does the same.
    const fetchImpl = ((_url: string, init: RequestInit = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;

    const client = createMtlsHttpClient({
      credentials: VALID_CREDS,
      fetchImpl,
      connectTimeoutMs: 1,
      totalTimeoutMs: 1,
    });

    await expect(client.fetch('https://asp.example')).rejects.toBeInstanceOf(MtlsTimeoutError);
  });

  it('surfaces non-abort errors unchanged', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = createMtlsHttpClient({ credentials: VALID_CREDS, fetchImpl });
    await expect(client.fetch('https://asp.example')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('forwards method, headers and body to the fetch', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      seenUrl = url;
      seenInit = init;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const client = createMtlsHttpClient({ credentials: VALID_CREDS, fetchImpl });
    await client.fetch('https://asp.example/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml' },
      body: '<payload/>',
    });
    expect(seenUrl).toBe('https://asp.example/x');
    expect(seenInit?.method).toBe('POST');
    expect((seenInit?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/soap+xml',
    );
    expect(seenInit?.body).toBe('<payload/>');
  });
});
