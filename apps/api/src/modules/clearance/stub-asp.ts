import { Inject, Injectable, Optional } from '@nestjs/common';
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
  constructor(
    @Optional() @Inject(ASP_CALLBACK_SINK) private readonly sink: ClearanceCallbackSink | null,
  ) {}

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
      if (this.sink) {
        const sink = this.sink;
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
