import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type {
  TransmissionCallback,
  TransmissionProvider,
  TransmissionResult,
  TransmissionSubmission,
} from './transmission-provider.port';

/**
 * Sink to push asynchronous OTA verdicts back into the gateway. In Wave 3
 * this is the gateway's own handleCallback method; in a real deployment it
 * would be an HTTP webhook controller that forwards into the same method.
 *
 * WIRING NOTE. We resolve this sink LAZILY via ModuleRef (see
 * StubAspProvider.submit) rather than taking it in the constructor.
 * Reason: the module wires the token as `useExisting: ClearanceGatewayService`
 * and the gateway in turn depends on `TRANSMISSION_PROVIDER` (which
 * resolves back to this StubAspProvider). Constructor injection here
 * creates a classic circular that Nest 10's `useExisting` resolver
 * cannot break even with `@Optional()` — the provider's Promise stays
 * pending, no "dependencies initialized" line fires for ClearanceModule,
 * and the whole NestFactory.create() call hangs (observed in staging
 * 2026-11-26 — one full day on CloudWatch silent-exits). Lazy resolve
 * sidesteps the cycle: by the time submit() runs, both instances exist
 * and Nest can serve the alias in one microtask.
 */
export const ASP_CALLBACK_SINK = 'ASP_CALLBACK_SINK';
export interface ClearanceCallbackSink {
  // SEC-003: the sink is tenant-scoped. The stub knows the tenant from its
  // own submission context (we track it in a per-key map below); the real
  // webhook controller passes the tenant from an `x-tenant-id` header.
  handleCallback(tenantId: string, cb: TransmissionCallback): Promise<void>;
}

/**
 * In-memory, process-local idempotency cache keyed on the invoice document
 * UUID. Replaying a submission (same idempotency key) returns the first
 * result verbatim; a real ASP would do the same thing server-side.
 *
 * Scoped at module level (not instance) so that the stub survives DI graph
 * recreations in tests but can be cleared explicitly via resetStubAspState().
 */
const idempotencyCache = new Map<string, TransmissionResult>();

export function resetStubAspState(): void {
  idempotencyCache.clear();
}

const ASYNC_CALLBACK_DELAY_MS = 50;

@Injectable()
export class StubAspProvider implements TransmissionProvider {
  private readonly log = new Logger(StubAspProvider.name);
  // Test-only override, written through attachSinkForTesting. Set this in
  // suites that need to observe the async callback without a full Nest
  // application context. Prod code paths MUST NOT read this directly.
  private sinkOverride: ClearanceCallbackSink | null = null;

  // `moduleRef` is nullable so unit tests can construct StubAspProvider
  // without spinning up a Nest injector. Prod callers always get a real
  // ModuleRef through DI (ClearanceModule).
  constructor(private readonly moduleRef: ModuleRef | null) {}

  /**
   * Install a callback sink directly, bypassing ModuleRef. Intended ONLY
   * for unit tests that construct StubAspProvider without a Nest injector
   * — see apps/api/test/clearance.spec.ts. In production the sink is
   * resolved lazily through ModuleRef at submit() time.
   */
  attachSinkForTesting(sink: ClearanceCallbackSink | null): void {
    this.sinkOverride = sink;
  }

  /**
   * Lazy-resolve the callback sink the first time it's needed. See the
   * wiring note on ASP_CALLBACK_SINK above for why this cannot be a
   * constructor injection. `strict: false` lets ModuleRef look up tokens
   * registered anywhere in the application tree, not just this module.
   */
  private resolveSink(): ClearanceCallbackSink | null {
    if (this.sinkOverride) return this.sinkOverride;
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get<ClearanceCallbackSink>(ASP_CALLBACK_SINK, { strict: false });
    } catch (err) {
      this.log.warn(`ASP_CALLBACK_SINK not resolvable at submit() time: ${(err as Error).message}`);
      return null;
    }
  }

  async submit(input: TransmissionSubmission): Promise<TransmissionResult> {
    // Idempotency: identical key -> identical result, regardless of payload.
    const cached = idempotencyCache.get(input.idempotencyKey);
    if (cached) return cached;

    // Explicit test hook: an invoice body containing <ForceReject>true</ForceReject>
    // deterministically returns a sync rejection with a reasoned payload.
    if (/<ForceReject>true<\/ForceReject>/.test(input.ublXml)) {
      const result: TransmissionResult = {
        aspReference: `stub-asp-${randomUUID()}`,
        synchronousStatus: 'rejected',
        rawResponse: {
          rejectionReasons: ['FORCE_REJECT: stub reject hook'],
        },
      };
      idempotencyCache.set(input.idempotencyKey, result);
      return result;
    }

    // Async mode: ASP accepts for later. We schedule a callback via the sink.
    if (process.env.STUB_ASP_MODE === 'async') {
      const aspReference = `stub-asp-${randomUUID()}`;
      const otaReference = `stub-ota-${randomUUID()}`;
      const result: TransmissionResult = {
        aspReference,
        synchronousStatus: 'accepted_pending',
      };
      idempotencyCache.set(input.idempotencyKey, result);
      const sink = this.resolveSink();
      if (sink) {
        // The stub knows the tenant from the submission context; it passes
        // it along so handleCallback runs under RLS for the right tenant.
        const tenantId = input.tenantId;
        setTimeout(() => {
          void sink.handleCallback(tenantId, {
            aspReference,
            status: 'cleared',
            otaReference,
            rawPayload: { source: 'stub-async-callback' },
          });
        }, ASYNC_CALLBACK_DELAY_MS);
      }
      return result;
    }

    // Default: synchronous clearance.
    const result: TransmissionResult = {
      aspReference: `stub-asp-${randomUUID()}`,
      synchronousStatus: 'cleared',
      otaReference: `stub-ota-${randomUUID()}`,
      rawResponse: { source: 'stub-sync' },
    };
    idempotencyCache.set(input.idempotencyKey, result);
    return result;
  }
}
