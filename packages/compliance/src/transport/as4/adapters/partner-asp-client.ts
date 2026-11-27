/**
 * Partner-ASP HTTP client.
 *
 * Under Faatora's subcontractor arrangement (OTA SP Registration
 * §5.7), the actual AS4 signing and wire transmission to C3 is
 * performed by an accredited Peppol service provider (currently
 * ClearTax) using their production OpenPeppol X.509 certificate. We
 * hand off the typed envelope + UBL payload over the partner ASP's
 * API; they handle XAdES-BES signing, SOAP packaging and the AS4
 * handshake with C3.
 *
 * Wire protocol. Partner ASPs typically front a REST API rather than
 * exposing raw AS4 — this keeps SP credential custody, cert
 * rotation and SMP lookup on their side. The exact field names and
 * endpoint path differ per vendor, so this module ships:
 *
 *   - `PartnerAspClient`: the stable retry / classification shell.
 *     Callers construct this once at startup and reuse it; it does
 *     no I/O of its own.
 *   - `WireProtocol`: a small interface that translates a typed
 *     `As4OutboundMessage` into an HTTP request and back into an
 *     `As4SendResult`.
 *   - `JsonWireProtocol`: a sane default implementation using the
 *     most common partner-ASP contract (JSON POST, base64 payload,
 *     bearer-token auth). Field names are documented below and MAY
 *     need a one-line override when ClearTax publishes their spec.
 *
 * To support a partner whose shape differs materially (multipart,
 * SOAP wrapper, OAuth2 refresh), implement `WireProtocol` and pass
 * it through `options.wireProtocol`. The retry / classification
 * contract stays fixed.
 *
 * Classification contract — the retry wrapper MUST see:
 *
 *   - 2xx accepted  -> return  { status: 'accepted',  messageId, aspReference?, otaReference? }
 *   - 2xx rejected  -> return  { status: 'rejected',  messageId, errors } (ASP accepted the
 *                               request but rejected the document validation; NOT retryable)
 *   - 4xx           -> throw   PartnerAspHttpError(4xx, ...) (NOT retryable; surfaced as 'rejected')
 *   - 5xx           -> throw   PartnerAspHttpError(5xx, ...) (retryable with backoff)
 *   - fetch rejects -> throw   PartnerAspNetworkError(...)   (retryable with backoff)
 *
 * This class is intentionally kept narrow — all of the HTTP shape
 * lives in the wire protocol, so the test matrix for retries is
 * stable across wire changes.
 */

import type { As4Sender } from '../port.js';
import type { As4OutboundMessage, As4SendResult, PeppolDocumentTypeId } from '../types.js';

/* -------------------------------------------------------------------------- */
/* Public options + errors                                                    */
/* -------------------------------------------------------------------------- */

export interface PartnerAspClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Maximum number of retry attempts AFTER the first try. Default 5
   * (so up to 6 total attempts). Peppol's SBDH level reliability
   * tolerates a long tail; we cap at 5 to bound worst-case latency.
   */
  readonly maxRetries?: number;
  /** Initial backoff in ms. Default 500. */
  readonly initialBackoffMs?: number;
  /** Maximum backoff in ms (cap for the exponential growth). Default 30_000. */
  readonly maxBackoffMs?: number;
  /**
   * Sleep function; injectable so tests don't actually wait. Default
   * uses `setTimeout`.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Wire protocol: translates typed messages to HTTP and back.
   * Defaults to `JsonWireProtocol`, which implements the most-common
   * REST-over-bearer contract used by partner ASPs. Override when the
   * partner's API spec differs (e.g. multipart envelope, SOAP body).
   */
  readonly wireProtocol?: WireProtocol;
  /**
   * `fetch` implementation to use. Defaults to `globalThis.fetch`
   * (Node 18+ built-in). Tests inject a mock to assert the exact
   * request shape and script responses.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Per-request timeout in ms. Enforced via AbortController. A 5xx
   * is retryable; a timeout is retryable as a network error. Default
   * 30_000.
   */
  readonly requestTimeoutMs?: number;
}

/**
 * Thrown by the HTTP layer when the partner ASP responds with an
 * HTTP status we classify. Kept narrow so the retry wrapper can
 * read `.status` to decide retry-ability.
 */
export class PartnerAspHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'PartnerAspHttpError';
  }
}

/** Thrown for network-level failures (DNS, TCP, TLS, dropped socket, timeout). */
export class PartnerAspNetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PartnerAspNetworkError';
  }
}

/* -------------------------------------------------------------------------- */
/* Wire protocol                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A `WireProtocol` is a pure translation layer between the typed AS4
 * information model and the partner ASP's HTTP shape. One instance
 * is reused across all sends; it must be stateless.
 *
 * `buildRequest` returns a URL (absolute) plus a `RequestInit`
 * suitable for passing straight to `fetch`. The retry wrapper
 * attaches the AbortController signal before calling fetch.
 *
 * `parseResponse` is called once the response has arrived:
 *   - 5xx: skip `parseResponse` entirely; the wrapper throws
 *     `PartnerAspHttpError(status, ...)` and the retry fires.
 *   - 4xx: skip `parseResponse`; throw `PartnerAspHttpError(status, ...)`.
 *   - 2xx: call `parseResponse` with the response + the original
 *     message so the parser can correlate against the sent
 *     messageId. It returns either `accepted` or `rejected` — a
 *     partner ASP may 200 OK a request but reject the document
 *     validation inside the JSON body.
 */
export interface WireProtocol {
  buildRequest(message: As4OutboundMessage, ctx: WireRequestContext): WireRequest;
  parseResponse(response: Response, message: As4OutboundMessage): Promise<As4SendResult>;
}

export interface WireRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export interface WireRequestContext {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * Default JSON wire protocol.
 *
 * Request shape — POST `{baseUrl}/documents/outbound`:
 *
 * ```json
 * {
 *   "messageId":        "<uuid-urn>",
 *   "timestamp":        "2026-11-27T03:40:00.000Z",
 *   "from":             { "scheme": "iso6523-actorid-upis", "identifier": "9915:faatora-c2" },
 *   "to":               { "scheme": "iso6523-actorid-upis", "identifier": "9915:partner-c3" },
 *   "originalSender":   { "scheme": "iso6523-actorid-upis", "identifier": "9915:om-seller-1" },
 *   "finalRecipient":   { "scheme": "iso6523-actorid-upis", "identifier": "9915:om-buyer-9" },
 *   "documentTypeId":   { "scheme": "busdox-docid-qns", "value": "urn:…::Invoice##urn:…::2.1" },
 *   "processId":        { "scheme": "cenbii-procid-ubl", "value": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0" },
 *   "payload":          "<base64>",
 *   "payloadMimeType":  "application/xml"
 * }
 * ```
 *
 * Response shape (2xx):
 *
 * ```json
 * {
 *   "messageId":    "<echoed-sender-messageId>",
 *   "aspReference": "asp-12345",
 *   "otaReference": "ota-67890",
 *   "status":       "accepted" | "rejected",
 *   "errors":       [{ "code": "...", "message": "..." }]
 * }
 * ```
 *
 * These field names reflect the most-common partner-ASP contract
 * (Pagero, Avalara, Sovos, ClearTax Global). When ClearTax publishes
 * the §5.7 integration spec, the one-line override is usually in
 * `JsonWireProtocol`'s constructor options (path, request-field map,
 * response-field map) — see the `JsonWireProtocolOptions` below.
 *
 * NOT CONFIGURED YET. Do not treat this as the final contract. The
 * tests in `partner-asp-client.spec.ts` exercise the defaults; when
 * the spec arrives, update that one file in lock-step with the
 * production wiring.
 */
export interface JsonWireProtocolOptions {
  /** HTTP path appended to baseUrl. Default `/documents/outbound`. */
  readonly path?: string;
  /** Request-field-name overrides for per-vendor quirks. */
  readonly requestFields?: Partial<JsonWireRequestFieldMap>;
  /** Response-field-name overrides for per-vendor quirks. */
  readonly responseFields?: Partial<JsonWireResponseFieldMap>;
  /**
   * Auth header mode. Most partner ASPs use `Authorization: Bearer <key>`;
   * a few prefer `X-Api-Key`. Default `bearer`.
   */
  readonly authMode?: 'bearer' | 'x-api-key';
}

export interface JsonWireRequestFieldMap {
  readonly messageId: string;
  readonly timestamp: string;
  readonly from: string;
  readonly to: string;
  readonly originalSender: string;
  readonly finalRecipient: string;
  readonly documentTypeId: string;
  readonly processId: string;
  readonly payload: string;
  readonly payloadMimeType: string;
}

export interface JsonWireResponseFieldMap {
  readonly messageId: string;
  readonly aspReference: string;
  readonly otaReference: string;
  readonly status: string;
  readonly errors: string;
}

const DEFAULT_REQUEST_FIELDS: JsonWireRequestFieldMap = {
  messageId: 'messageId',
  timestamp: 'timestamp',
  from: 'from',
  to: 'to',
  originalSender: 'originalSender',
  finalRecipient: 'finalRecipient',
  documentTypeId: 'documentTypeId',
  processId: 'processId',
  payload: 'payload',
  payloadMimeType: 'payloadMimeType',
};

const DEFAULT_RESPONSE_FIELDS: JsonWireResponseFieldMap = {
  messageId: 'messageId',
  aspReference: 'aspReference',
  otaReference: 'otaReference',
  status: 'status',
  errors: 'errors',
};

export class JsonWireProtocol implements WireProtocol {
  private readonly path: string;
  private readonly reqF: JsonWireRequestFieldMap;
  private readonly resF: JsonWireResponseFieldMap;
  private readonly authMode: 'bearer' | 'x-api-key';

  constructor(options: JsonWireProtocolOptions = {}) {
    this.path = options.path ?? '/documents/outbound';
    this.reqF = { ...DEFAULT_REQUEST_FIELDS, ...(options.requestFields ?? {}) };
    this.resF = { ...DEFAULT_RESPONSE_FIELDS, ...(options.responseFields ?? {}) };
    this.authMode = options.authMode ?? 'bearer';
  }

  buildRequest(message: As4OutboundMessage, ctx: WireRequestContext): WireRequest {
    const url = joinUrl(ctx.baseUrl, this.path);
    const payloadBase64 = toBase64(message.payload);

    const body: Record<string, unknown> = {};
    body[this.reqF.messageId] = message.envelope.messageId;
    body[this.reqF.timestamp] = message.envelope.timestamp;
    body[this.reqF.from] = {
      scheme: message.envelope.from.partyId.scheme,
      identifier: message.envelope.from.partyId.identifier,
    };
    body[this.reqF.to] = {
      scheme: message.envelope.to.partyId.scheme,
      identifier: message.envelope.to.partyId.identifier,
    };
    // Original sender / final recipient live in messageProperties as
    // ebMS properties; the typed envelope surfaces them there.
    body[this.reqF.originalSender] = {
      scheme: message.envelope.messageProperties.originalSender.scheme,
      identifier: message.envelope.messageProperties.originalSender.identifier,
    };
    body[this.reqF.finalRecipient] = {
      scheme: message.envelope.messageProperties.finalRecipient.scheme,
      identifier: message.envelope.messageProperties.finalRecipient.identifier,
    };
    // Peppol TIA mapping:
    //   eb:Service -> process id (collaborationInfo.service)
    //   eb:Action  -> document type id (collaborationInfo.action)
    // We send both as structured objects plus the canonical Peppol
    // string, so a partner ASP whose API prefers either form works
    // without a wire-field override.
    const dt = message.envelope.collaborationInfo.action;
    body[this.reqF.documentTypeId] = {
      scheme: dt.scheme,
      rootNs: dt.rootNs,
      localName: dt.localName,
      customizationId: dt.customizationId,
      ublVersion: dt.ublVersion,
      value: canonicalDocumentTypeString(dt),
    };
    body[this.reqF.processId] = {
      scheme: message.envelope.collaborationInfo.service.scheme,
      value: message.envelope.collaborationInfo.service.value,
    };
    body[this.reqF.payload] = payloadBase64;
    body[this.reqF.payloadMimeType] = 'application/xml';

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.authMode === 'bearer') {
      headers['authorization'] = `Bearer ${ctx.apiKey}`;
    } else {
      headers['x-api-key'] = ctx.apiKey;
    }

    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
    return { url, init };
  }

  async parseResponse(response: Response, message: As4OutboundMessage): Promise<As4SendResult> {
    // 2xx — parse body, decide accepted vs rejected from `status` field.
    const text = await safeText(response);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // ASP returned 2xx with a non-JSON body. Treat as a success
      // envelope with no extra metadata — the HTTP contract was
      // satisfied even if the ASP's body didn't echo ours.
      return {
        status: 'accepted',
        messageId: message.envelope.messageId,
      };
    }

    const statusField = asString(parsed[this.resF.status]);
    const echoedMessageId = asString(parsed[this.resF.messageId]) ?? message.envelope.messageId;
    const aspRef = asString(parsed[this.resF.aspReference]);
    const otaRef = asString(parsed[this.resF.otaReference]);
    const errors = parseErrors(parsed[this.resF.errors]);

    if (statusField === 'rejected') {
      return {
        status: 'rejected',
        messageId: echoedMessageId,
        errors: errors.length ? errors : ['ASP returned status=rejected with no error details'],
      };
    }

    // Default to accepted when the ASP didn't explicitly reject. A
    // partner ASP that returns 2xx and no status field is signalling
    // acceptance implicitly.
    return {
      status: 'accepted',
      messageId: echoedMessageId,
      ...(aspRef ? { aspReference: aspRef } : {}),
      ...(otaRef ? { otaReference: otaRef } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Retry / classification wrapper                                             */
/* -------------------------------------------------------------------------- */

const DEFAULTS = {
  maxRetries: 5,
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
  requestTimeoutMs: 30_000,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PartnerAspClient implements As4Sender {
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly wireProtocol: WireProtocol;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PartnerAspClientOptions) {
    if (!options.baseUrl) {
      throw new Error('PartnerAspClient: baseUrl is required');
    }
    if (!options.apiKey) {
      throw new Error('PartnerAspClient: apiKey is required');
    }
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULTS.initialBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.wireProtocol = options.wireProtocol ?? new JsonWireProtocol();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        'PartnerAspClient: no fetch implementation available (globalThis.fetch is undefined). ' +
          'Node >= 18 is required, or pass options.fetchImpl.',
      );
    }
  }

  async send(message: As4OutboundMessage): Promise<As4SendResult> {
    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= this.maxRetries) {
      try {
        return await this.sendOnce(message);
      } catch (err) {
        lastErr = err;
        if (!this.isRetryable(err) || attempt === this.maxRetries) {
          return this.toErrorResult(message, err);
        }
        await this.sleep(this.backoffFor(attempt));
        attempt += 1;
      }
    }

    // Unreachable: the loop always returns via the branches above.
    return this.toErrorResult(message, lastErr);
  }

  /**
   * One attempt at the HTTP call. The retry wrapper above adds
   * exponential backoff and classification of retryable vs
   * terminal failures; this method is responsible for the raw
   * request / response cycle.
   *
   * Overridable (protected) so a test subclass can inject scripted
   * behavior without having to stub `fetch` (see the existing
   * `ScriptedPartnerAspClient` in the test file).
   */
  protected async sendOnce(message: As4OutboundMessage): Promise<As4SendResult> {
    const wireRequest = this.wireProtocol.buildRequest(message, {
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`partner ASP request exceeded ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(wireRequest.url, {
        ...wireRequest.init,
        signal: controller.signal,
      });
    } catch (err) {
      // fetch throws for DNS failures, TCP reset, TLS error, or an
      // AbortController-triggered timeout. Treat every one as a
      // retryable network-level failure.
      throw new PartnerAspNetworkError(err instanceof Error ? err.message : String(err), err);
    } finally {
      clearTimeout(timer);
    }

    // Classify status. 5xx and 4xx get translated to PartnerAspHttpError
    // with the response body attached for diagnostics; the retry wrapper
    // then decides retry-vs-surface. 2xx is the only path that touches
    // the wire protocol's parseResponse.
    if (response.status >= 500 && response.status < 600) {
      const body = await safeText(response);
      throw new PartnerAspHttpError(
        response.status,
        `partner ASP responded ${response.status} ${response.statusText}`,
        body,
      );
    }
    if (response.status >= 400 && response.status < 500) {
      const body = await safeText(response);
      throw new PartnerAspHttpError(
        response.status,
        `partner ASP rejected request: ${response.status} ${response.statusText}`,
        body,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      // 1xx / 3xx are not expected — partner ASPs do not redirect
      // outbound POSTs. Treat as a programmer error.
      const body = await safeText(response);
      throw new PartnerAspHttpError(
        response.status,
        `partner ASP returned unexpected status ${response.status} ${response.statusText}`,
        body,
      );
    }

    return this.wireProtocol.parseResponse(response, message);
  }

  /**
   * A 5xx HTTP response or a network-level error (DNS, TCP reset,
   * socket hang-up, TLS error, request timeout) is retryable. A 4xx
   * response is a contract violation and should surface to the caller
   * unchanged. Any other thrown error (bad config, programmer bug) is
   * not retryable either.
   */
  private isRetryable(err: unknown): boolean {
    if (err instanceof PartnerAspNetworkError) return true;
    if (err instanceof PartnerAspHttpError) {
      return err.status >= 500 && err.status < 600;
    }
    return false;
  }

  /**
   * Exponential backoff: 2^attempt * initialBackoffMs, capped at
   * maxBackoffMs. No jitter yet — easy to add once we see real
   * partner-ASP load patterns. Pure function of `attempt`, so the
   * retry test can assert exact sleep durations.
   */
  private backoffFor(attempt: number): number {
    const raw = this.initialBackoffMs * Math.pow(2, attempt);
    return Math.min(raw, this.maxBackoffMs);
  }

  private toErrorResult(message: As4OutboundMessage, err: unknown): As4SendResult {
    const errText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const status: As4SendResult['status'] =
      err instanceof PartnerAspHttpError && err.status >= 400 && err.status < 500
        ? 'rejected'
        : 'error';
    return {
      status,
      messageId: message.envelope.messageId,
      errors: [errText],
    };
  }

  /** Read-only view of the resolved configuration (for tests / logging). */
  get config(): Readonly<
    Required<Omit<PartnerAspClientOptions, 'sleep' | 'wireProtocol' | 'fetchImpl'>>
  > {
    return {
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      maxRetries: this.maxRetries,
      initialBackoffMs: this.initialBackoffMs,
      maxBackoffMs: this.maxBackoffMs,
      requestTimeoutMs: this.requestTimeoutMs,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedPath}`;
}

function toBase64(payload: Uint8Array | string): string {
  if (typeof payload === 'string') {
    return Buffer.from(payload, 'utf8').toString('base64');
  }
  return Buffer.from(payload).toString('base64');
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Normalize the partner ASP's `errors` field into a flat
 * `string[]`. We accept several shapes:
 *   - string[]             -> itself
 *   - { message, code }[]  -> ["<code>: <message>", ...]
 *   - { message }[]        -> ["<message>", ...]
 *   - string               -> [string]
 *   - anything else        -> []
 *
 * Narrow enough to avoid leaking arbitrary partner-ASP shapes into
 * our audit log, wide enough to keep the useful text.
 */
/**
 * Serialize a `PeppolDocumentTypeId` to its canonical wire string:
 *   `<scheme>::<rootNs>::<localName>##<customizationId>::<ublVersion>`
 *
 * Partner ASPs that take the doc-type id as a single opaque string
 * (as opposed to a structured object) expect this exact form; the
 * Peppol TIA profile prescribes it.
 */
function canonicalDocumentTypeString(dt: PeppolDocumentTypeId): string {
  return `${dt.scheme}::${dt.rootNs}::${dt.localName}##${dt.customizationId}::${dt.ublVersion}`;
}

function parseErrors(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const msg = asString(rec.message) ?? asString(rec.detail) ?? asString(rec.description);
      const code = asString(rec.code) ?? asString(rec.errorCode);
      if (msg && code) out.push(`${code}: ${msg}`);
      else if (msg) out.push(msg);
      else if (code) out.push(code);
    }
  }
  return out;
}
