import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, and, eq, gte, desc } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withFirm } from '../../db/with-firm';
import { firmAuditEvents } from '../../db/schema/audit';

/**
 * Normalised audit event as the service accepts it. Shape chosen to
 * match the event payloads other EP5 Wave 2 agents emit (W2-C's
 * firm.client.added, W2-D's firm.import.committed, this agent's own
 * firm.created + billing.*), with `source` defaulting to 'system' so
 * the DB default is in play when a caller does not set it.
 */
export interface RecordAuditEventInput {
  firmId: string;
  tenantId?: string | null;
  actorUserId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
  source?: string;
}

export interface FirmAuditEvent {
  id: string;
  firmId: string;
  tenantId: string | null;
  actorUserId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  source: string;
}

export interface ListAuditEventsOptions {
  limit?: number;
  since?: Date;
  eventType?: string;
}

/**
 * AuditService — thin writer + reader over firm_audit_events.
 *
 * Writes go through withFirm (firm-level events) or withFirmTenant (tenant
 * -scoped events) so RLS gates the INSERT. Reads always use withFirm.
 *
 * Every write is defensive at the subscriber layer: a failure to append
 * an audit row MUST NOT break the business event that triggered it, so
 * subscribers wrap `record()` in try/catch and log on failure rather
 * than re-throwing. The service itself throws normally; the defensive
 * posture lives in the subscriber.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);
  // Hard cap on list() to keep accidental runaway paginations from
  // dragging the viewer; tuned to twice the Wave 3 default page size.
  private static readonly MAX_LIST_LIMIT = 500;

  constructor(@Inject(DB) private readonly db: Database) {}

  async record(input: RecordAuditEventInput): Promise<FirmAuditEvent> {
    const row = {
      firmId: input.firmId,
      tenantId: input.tenantId ?? null,
      actorUserId: input.actorUserId ?? null,
      eventType: input.eventType,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      source: input.source ?? 'system',
    };
    // RLS on firm_audit_events keys only on app.firm_id, so withFirm
    // is sufficient even for tenant-scoped rows. We deliberately do NOT
    // require an active firm_client_tenants link here: the whole point
    // of the audit log is that it also captures `firm.client.revoked`,
    // which fires AFTER the link has been torn down.
    const inserted = await withFirm(this.db, input.firmId, async (tx) => {
      if (input.tenantId) {
        // Hint the connection with app.tenant_id too for any downstream
        // trigger or downstream read. Harmless on this table.
        await tx.execute(sql`select set_config('app.tenant_id', ${input.tenantId}, true)`);
      }
      const [r] = await tx.insert(firmAuditEvents).values(row).returning();
      return r;
    });
    return this.mapRow(inserted);
  }

  async list(
    firmId: string,
    opts: ListAuditEventsOptions = {},
  ): Promise<FirmAuditEvent[]> {
    const limit = Math.min(
      Math.max(1, opts.limit ?? 50),
      AuditService.MAX_LIST_LIMIT,
    );
    return withFirm(this.db, firmId, async (tx) => {
      const filters = [eq(firmAuditEvents.firmId, firmId)];
      if (opts.since) {
        filters.push(gte(firmAuditEvents.occurredAt, opts.since));
      }
      if (opts.eventType) {
        filters.push(eq(firmAuditEvents.eventType, opts.eventType));
      }
      const rows = await tx
        .select()
        .from(firmAuditEvents)
        .where(and(...filters))
        .orderBy(desc(firmAuditEvents.occurredAt))
        .limit(limit);
      return rows.map((r) => this.mapRow(r));
    });
  }

  /**
   * Scoped export for a single client tenant between periodStart (inclusive)
   * and periodEnd (exclusive). This is the shape OTA inspectors ask for
   * when they request "every event affecting this client's data between
   * these dates" (see docs/research/ota-inspection-plan.md).
   */
  async exportForTenant(
    firmId: string,
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<FirmAuditEvent[]> {
    return withFirm(this.db, firmId, async (tx) => {
      const rows = await tx
        .select()
        .from(firmAuditEvents)
        .where(
          and(
            eq(firmAuditEvents.firmId, firmId),
            eq(firmAuditEvents.tenantId, tenantId),
            gte(firmAuditEvents.occurredAt, periodStart),
          ),
        )
        .orderBy(desc(firmAuditEvents.occurredAt));
      // periodEnd is exclusive; filter in app layer so the index can
      // remain simple firm_id, tenant_id, occurred_at desc. The
      // row count is bounded by the (firm,tenant) partition which in
      // practice is tiny per period.
      return rows
        .filter((r) => r.occurredAt.getTime() < periodEnd.getTime())
        .map((r) => this.mapRow(r));
    });
  }

  private mapRow(r: typeof firmAuditEvents.$inferSelect): FirmAuditEvent {
    return {
      id: r.id,
      firmId: r.firmId,
      tenantId: r.tenantId,
      actorUserId: r.actorUserId,
      eventType: r.eventType,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      occurredAt: r.occurredAt,
      source: r.source,
    };
  }
}
