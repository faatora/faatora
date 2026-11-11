/**
 * Partner-ASP HTTP client (skeleton).
 *
 * Under Faatora's subcontractor arrangement (OTA SP Registration
 * §5.7), the actual AS4 signing and wire transmission to C3 is
 * performed by an accredited Peppol service provider using their
 * production OpenPeppol X.509 certificate. We hand off the envelope
 * and UBL payload over the partner ASP's API.
 *
 * The exact endpoint, auth scheme, and request/response shape will
 * be defined by the partner ASP once the subcontractor agreement is
 * signed. Until then this class is a SKELETON:
 *
 *   - Constructor signature is stable: { baseUrl, apiKey }.
 *   - Retry policy is implemented and tested (exponential backoff,
 *     max 5 retries, 5xx + network errors are retryable).
 *   - The actual HTTP call (`sendOnce`) is a TODO that throws.
 *
 * When the spec arrives, only `sendOnce` needs real wiring; the
 * retry wrapper, port contract, and callers stay put.
 */

import type { As4Sender } from '../port.js';
import type { As4OutboundMessage, As4SendResult } from '../types.js';

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

/** Thrown for network-level failures (DNS, TCP, TLS, dropped socket). */
export class PartnerAspNetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PartnerAspNetworkError';
  }
}

const DEFAULTS = {
  maxRetries: 5,
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PartnerAspClient implements As4Sender {
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

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
    this.sleep = options.sleep ?? defaultSleep;
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
   * One attempt at the HTTP call. Implementers: when the partner
   * ASP's API spec arrives, replace the TODO body with a `fetch`
   * (or undici) call against `${baseUrl}/...` carrying the AS4
   * envelope + UBL payload per their contract. Translate:
   *
   *   - 2xx response  -> `{ status: 'accepted', messageId: ... }`
   *   - 4xx response  -> `{ status: 'rejected', ..., errors: [...] }`
   *                      (do NOT throw; 4xx is not retryable)
   *   - 5xx response  -> throw new PartnerAspHttpError(status, ...)
   *                      (the retry wrapper will back off)
   *   - fetch throws  -> throw new PartnerAspNetworkError(message, err)
   */
  protected async sendOnce(_message: As4OutboundMessage): Promise<As4SendResult> {
    // TODO: implement once the partner ASP publishes their API spec.
    // The subcontractor agreement (see OTA SP Registration §5.7) is
    // the gate for receiving the spec. Until then, calling this
    // adapter is a configuration error, not a runtime one.
    throw new Error(
      'PartnerAspClient.sendOnce is not implemented: ' +
        'awaiting partner ASP API specification (see README).',
    );
  }

  /**
   * A 5xx HTTP response or a network-level error (DNS, TCP reset,
   * socket hang-up, TLS error) is retryable. A 4xx response is a
   * contract violation and should surface to the caller unchanged.
   * Any other thrown error (bad config, programmer bug) is not
   * retryable either.
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

  private toErrorResult(
    message: As4OutboundMessage,
    err: unknown,
  ): As4SendResult {
    const errText =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
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
  get config(): Readonly<Required<Omit<PartnerAspClientOptions, 'sleep'>>> {
    return {
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      maxRetries: this.maxRetries,
      initialBackoffMs: this.initialBackoffMs,
      maxBackoffMs: this.maxBackoffMs,
    };
  }
}
