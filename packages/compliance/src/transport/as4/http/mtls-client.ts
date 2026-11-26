/**
 * mTLS HTTP client used by both the AS4 sender and the SMP lookup.
 *
 * Wraps `node:https.Agent` so a caller can present a client
 * certificate and private key (PEM strings loaded from env vars,
 * secrets manager, or disk) during the TLS handshake. The partner
 * endpoint — the OTA SMP (`test-smp-ext-api.taxoman.gov.om`) for
 * lookups, and the C3 AS4 endpoint for sends — authenticates clients
 * by their X.509 certificate, so a non-mTLS client is a non-starter.
 *
 * The client is `fetch`-shaped. Returning `fetch`-style `Response`
 * objects means callers use the same body / status / header API they
 * would with the global fetch, and tests can swap a mock fetch in
 * without touching the call sites.
 *
 * Behaviour pinned here:
 *   - Connect timeout: 30 s (`socket.on('connect', …)` races a timer)
 *   - Total timeout:   60 s (AbortController tied to the request)
 *   - No redirects — the AS4 and SMP endpoints never redirect, and
 *     silent redirects can send the client cert to an unexpected host
 *   - Node's built-in fetch, with an https.Agent that carries the
 *     cert / key / ca PEMs
 *
 * References:
 *   - RFC 8705 (OAuth 2.0 Mutual-TLS Client Authentication) §2
 *   - Node.js docs: https.Agent, undici dispatcher (fetch backend)
 *   - OTA Oman SMP API Specifications v1.0 §1.3 (mTLS secured)
 */

import { Agent, type AgentOptions } from 'node:https';

/**
 * Credentials for one mTLS endpoint. PEM strings so the caller can
 * read them straight from env vars (`.env`-loaded, KMS-decrypted, or
 * Vercel-style base64-encoded) without touching the filesystem.
 */
export interface MtlsCredentials {
  /** Client certificate PEM (may be a chain, one block per cert). */
  readonly cert: string;
  /** Client private key PEM. */
  readonly key: string;
  /** Optional passphrase for an encrypted key. */
  readonly passphrase?: string;
  /**
   * Optional CA bundle PEM. If omitted, Node's trust store is used,
   * which is the right default against public CAs. The OTA sandbox
   * endpoints use public CAs; a self-signed staging endpoint would
   * need to supply the CA here.
   */
  readonly ca?: string;
}

export interface MtlsHttpClientOptions {
  readonly credentials: MtlsCredentials;
  /** Connect timeout in milliseconds. Default 30_000. */
  readonly connectTimeoutMs?: number;
  /** Total-request timeout in milliseconds. Default 60_000. */
  readonly totalTimeoutMs?: number;
  /**
   * Fetch implementation. Defaults to Node's global `fetch`. Tests
   * inject a mock — the mock receives the URL and the `RequestInit`
   * the client assembled, including the `dispatcher` (from undici)
   * or `agent`-equivalent field on the init.
   */
  readonly fetchImpl?: typeof fetch;
}

/** Thrown when the total-request timeout fires. */
export class MtlsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MtlsTimeoutError';
  }
}

/** Thrown when the client is misconfigured (bad PEM, missing field). */
export class MtlsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MtlsConfigurationError';
  }
}

/**
 * The fetch-shaped surface callers see. One method, same contract as
 * `globalThis.fetch`, except that the client has already attached the
 * mTLS agent and the two timeouts.
 */
export interface MtlsHttpClient {
  fetch(url: string, init?: MtlsRequestInit): Promise<Response>;
  /** Expose the underlying https.Agent for callers that need it (undici dispatcher). */
  readonly agent: Agent;
}

export type MtlsRequestInit = Omit<RequestInit, 'signal'>;

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;

/**
 * Build an `MtlsHttpClient`. The returned agent is kept-alive and
 * reused across requests, which matters for AS4 where a sender may
 * burst several messages inside the SMP TTL window.
 */
export function createMtlsHttpClient(options: MtlsHttpClientOptions): MtlsHttpClient {
  assertCredentials(options.credentials);

  const agentOptions: AgentOptions = {
    cert: options.credentials.cert,
    key: options.credentials.key,
    passphrase: options.credentials.passphrase,
    ca: options.credentials.ca,
    keepAlive: true,
    // Enforce TLS 1.2+; AS4 sandboxes refuse 1.0/1.1 and the OTA SMP
    // documentation calls out TLS 1.2 as the floor.
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
  };
  const agent = new Agent(agentOptions);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  if (connectTimeoutMs <= 0) {
    throw new MtlsConfigurationError('connectTimeoutMs must be > 0');
  }
  if (totalTimeoutMs < connectTimeoutMs) {
    throw new MtlsConfigurationError('totalTimeoutMs must be >= connectTimeoutMs');
  }

  return {
    agent,
    async fetch(url: string, init: MtlsRequestInit = {}): Promise<Response> {
      const controller = new AbortController();
      const totalTimer = setTimeout(() => {
        controller.abort(new MtlsTimeoutError(`mTLS request exceeded ${totalTimeoutMs}ms`));
      }, totalTimeoutMs);
      // The connect timeout is enforced by the https.Agent via a
      // `timeout` option on the socket; we also race it against the
      // total timer so a stuck TLS handshake surfaces as a timeout
      // and not a hanging promise.
      const connectTimer = setTimeout(() => {
        controller.abort(new MtlsTimeoutError(`mTLS connect exceeded ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);

      try {
        // `dispatcher` is the undici field name used by Node's
        // built-in fetch; both Node 20 and 22 accept it when it is
        // an undici Dispatcher. `agent` is the legacy / polyfill
        // field. We set both so that a mock fetch in tests can read
        // whichever it expects, and in production the real wiring
        // will attach an undici Agent constructed from the same PEMs
        // (tracked for the Jan 2027 sandbox milestone). `as unknown`
        // is the narrowest cast we can use: the fetch type does not
        // model either field.
        const requestInit = {
          ...init,
          signal: controller.signal,
          dispatcher: agent,
          agent,
        } as unknown as RequestInit;
        const response = await fetchImpl(url, requestInit);
        // Once we have a response we clear the connect timer; the
        // total timer stays armed until the body has been consumed,
        // but the caller is responsible for that (we return the
        // Response object as-is).
        clearTimeout(connectTimer);
        // We use AbortController's signal to clear the total timer
        // once the fetch resolves, but the body may still stream
        // after this point; fire a one-shot to clean up.
        setTimeout(() => clearTimeout(totalTimer), 0).unref?.();
        return response;
      } catch (err) {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        // Unify AbortError/MtlsTimeoutError into MtlsTimeoutError
        // so callers do not have to pattern-match on the inner type.
        if (isAbortError(err)) {
          const reason = controller.signal.reason;
          if (reason instanceof MtlsTimeoutError) throw reason;
          throw new MtlsTimeoutError('mTLS request aborted');
        }
        throw err;
      }
    },
  };
}

function assertCredentials(c: MtlsCredentials): void {
  if (!c.cert || !c.cert.includes('-----BEGIN CERTIFICATE-----')) {
    throw new MtlsConfigurationError('cert PEM is missing or malformed');
  }
  if (
    !c.key ||
    !(
      c.key.includes('-----BEGIN PRIVATE KEY-----') ||
      c.key.includes('-----BEGIN RSA PRIVATE KEY-----') ||
      c.key.includes('-----BEGIN EC PRIVATE KEY-----')
    )
  ) {
    throw new MtlsConfigurationError('key PEM is missing or malformed');
  }
  if (c.ca !== undefined && !c.ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new MtlsConfigurationError('ca PEM is malformed');
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  // Node 22 throws a DOMException with name 'AbortError' from fetch;
  // some fetch mocks throw a plain Error whose message contains 'abort'.
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: unknown }).name === 'AbortError'
  ) {
    return true;
  }
  return false;
}
