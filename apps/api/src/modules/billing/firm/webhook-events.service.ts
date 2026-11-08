import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../../../db/db.module';
import { billingWebhookEvents } from './webhook-event.entity';
import { BillingEvent } from './billing.port';

export interface DispatchResult {
  /** The row id. Always present. */
  readonly id: string;
  /**
   * True on the first (ever) sight of the event. False on replay,
   * meaning a row already existed with the same (provider, event_id).
   * Callers must gate business logic on this.
   */
  readonly firstSeen: boolean;
}

/**
 * Durable, idempotent store for inbound provider webhooks.
 *
 * The unique constraint (provider, provider_event_id) is what makes
 * replay safe. The ON CONFLICT DO NOTHING insert returns zero rows
 * when the event has been seen before; callers short-circuit in that
 * case so retries from Stripe are free.
 *
 * `markProcessed` is called by the controller once the per-event
 * business logic has returned without throwing. A row with
 * processed_at IS NULL is a crash-mid-flight marker and is safe to
 * retry by the next delivery attempt from Stripe.
 */
@Injectable()
export class WebhookEventsService {
  private readonly log = new Logger(WebhookEventsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async record(event: BillingEvent): Promise<DispatchResult> {
    // ON CONFLICT ... DO NOTHING ... RETURNING returns 0 rows on a
    // conflict, which is exactly what we want. The lookup below is
    // only reached on the conflict path.
    const inserted = await this.db
      .insert(billingWebhookEvents)
      .values({
        provider: event.provider,
        providerEventId: event.providerEventId,
        eventType: event.type,
        payload: event.data as unknown as object,
      })
      .onConflictDoNothing({
        target: [billingWebhookEvents.provider, billingWebhookEvents.providerEventId],
      })
      .returning({ id: billingWebhookEvents.id });

    if (inserted.length === 1) {
      return { id: inserted[0].id, firstSeen: true };
    }

    // Conflict path: fetch the existing row's id.
    const [existing] = await this.db
      .select({ id: billingWebhookEvents.id })
      .from(billingWebhookEvents)
      .where(
        and(
          eq(billingWebhookEvents.provider, event.provider),
          eq(billingWebhookEvents.providerEventId, event.providerEventId),
        ),
      )
      .limit(1);
    if (!existing) {
      // Pathological: the insert said conflict but no row? Treat as
      // first-seen so the handler runs, and log loudly.
      this.log.warn(
        { provider: event.provider, providerEventId: event.providerEventId },
        'webhook-events: conflict but no existing row found',
      );
      return { id: '', firstSeen: true };
    }
    return { id: existing.id, firstSeen: false };
  }

  async markProcessed(id: string): Promise<void> {
    await this.db
      .update(billingWebhookEvents)
      .set({ processedAt: sql`now()` })
      .where(eq(billingWebhookEvents.id, id));
  }
}
