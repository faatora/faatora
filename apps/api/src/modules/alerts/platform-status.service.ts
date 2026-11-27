import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DB, type Database } from '../../db/db.module';
import { platformStatusEvents, type PlatformStatus } from '../../db/schema/platform-status';

/**
 * PlatformStatusService — projects verified PagerDuty webhook events
 * into the `platform_status_events` table and fans them out onto the
 * EventEmitter2 bus under `platform.status.event`.
 *
 * Called from PagerDutyController after signature verification. The
 * controller passes a {@link VerifiedPagerDutyEvent} (already parsed +
 * trusted) and expects this service to:
 *
 *   1. Persist a status-page row (best-effort — see below).
 *   2. Emit `platform.status.event` for future subscribers (per-tenant
 *      status board UI, Slack relays, etc).
 *
 * ──────────────────── Availability vs durability ────────────────────
 * This path MUST NOT 5xx back to PagerDuty. PagerDuty retries failed
 * webhook deliveries on an exponential backoff; a persistent 5xx here
 * would create a feedback loop (every retry costs a re-run of the DB
 * INSERT) and would stall the counter + event-bus emission that ops
 * actually care about during an incident. If the INSERT fails we log
 * at ERROR and still emit the event, so the public status page may be
 * missing a row but observers subscribed to `platform.status.event`
 * continue to fire. The controller returns 200 either way.
 */

/** Trusted, post-verification shape the controller hands to the service. */
export interface VerifiedPagerDutyEvent {
  /** PagerDuty incident id (`event.data.id`). `'unknown'` when absent. */
  incidentId: string;
  /** Raw PagerDuty event type, e.g. `incident.triggered`. */
  eventType: string;
  /** `event.data.summary`, if present. */
  summary?: string;
  /** Parsed `event.occurred_at`; falls back to the ingestion clock. */
  occurredAt: Date;
  /** Full inbound event envelope, stored verbatim in `raw_payload`. */
  raw: unknown;
}

/**
 * Map a raw PagerDuty event type onto a human-facing status label.
 *
 *   incident.triggered     → investigating
 *   incident.acknowledged  → identified
 *   incident.resolved      → resolved
 *   anything else          → investigating (conservative — we still
 *                            capture the row so ops can grep raw_payload)
 *
 * Exported for the controller/service spec so the mapping is testable
 * without reconstituting a whole service.
 */
export function mapToStatus(pdEventType: string): PlatformStatus {
  switch (pdEventType) {
    case 'incident.triggered':
      return 'investigating';
    case 'incident.acknowledged':
      return 'identified';
    case 'incident.resolved':
      return 'resolved';
    default:
      return 'investigating';
  }
}

@Injectable()
export class PlatformStatusService {
  private readonly log = new Logger(PlatformStatusService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /**
   * Record one verified PagerDuty event: append a status-page row and
   * emit `platform.status.event`. Never throws — all failures are
   * logged so the controller can keep returning 200 to PagerDuty.
   */
  async record(event: VerifiedPagerDutyEvent): Promise<void> {
    const status = mapToStatus(event.eventType);

    try {
      await this.db.insert(platformStatusEvents).values({
        incidentId: event.incidentId,
        pdEventType: event.eventType,
        status,
        summary: event.summary ?? null,
        occurredAt: event.occurredAt,
        rawPayload: event.raw,
      });
    } catch (err) {
      // Never 5xx back to PagerDuty; log and continue so the counter
      // and the event emission still fire.
      this.log.error(
        { err: (err as Error).message, incidentId: event.incidentId },
        'failed to persist platform_status_events row',
      );
    }

    // EventEmitter2 is wired globally in AppModule, but this service is
    // also instantiable with no bus (unit tests, boot-time probes) so
    // the dependency is @Optional and we null-check before emitting.
    this.events?.emit('platform.status.event', {
      incidentId: event.incidentId,
      pdEventType: event.eventType,
      status,
      summary: event.summary,
      occurredAt: event.occurredAt,
    });
  }
}
