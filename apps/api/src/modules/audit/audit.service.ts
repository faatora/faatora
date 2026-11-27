import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, and, eq, gte, desc, asc, isNull } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withFirm } from '../../db/with-firm';
import { firmAuditEvents } from '../../db/schema/audit';
import { computeEventHash } from './hash-chain';
import type { ChainableEvent } from './canonical-json';

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
  eventHash: string | null;
  prevHash: string | null;
}

/**
 * Result of walking a (firm, tenant) audit chain end-to-end.
 *
 * `ok: true` means every chained row's event_hash equals
 * sha256((prevHash ?? '') || '|' || canonical_json(event)) AND each row's
 * prev_hash equals the preceding row's event_hash. This is the artefact
 * the ClearTax partner pack §5.7 tamper-evident audit trail promises.
 *
 * On mismatch we return the first offending row's id and both the
 * recomputed and stored hashes so an operator can pinpoint the tamper
 * without walking the whole log by hand.
 */
export type AuditChainVerification =
  | { ok: true; totalEvents: number; skipped: number }
  | {
      ok: false;
      totalEvents: number;
      firstTamperAt: string;
      expected: string;
      actual: string;
      reason: string;
    };

export interface ListAuditEventsOptions {
  limit?: number;
  since?: Date;
  eventType?: string;
  /**
   * Optional tenant scope. When set, the list is filtered to events for
   * that specific tenant (NULL tenant_id rows — firm-level events — are
   * excluded). Used by the ClearTax partner read route to narrow an
   * inspection to one tenant without exposing the rest of the firm.
   */
  tenantId?: string;
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
    const tenantId = input.tenantId ?? null;
    const actorUserId = input.actorUserId ?? null;
    const source = input.source ?? 'system';
    const payload = (input.payload ?? {}) as Record<string, unknown>;

    // RLS on firm_audit_events keys only on app.firm_id, so withFirm
    // is sufficient even for tenant-scoped rows. We deliberately do NOT
    // require an active firm_client_tenants link here: the whole point
    // of the audit log is that it also captures `firm.client.revoked`,
    // which fires AFTER the link has been torn down.
    //
    // The whole chain extension — read the current head FOR UPDATE,
    // compute the new event_hash, insert — runs inside ONE transaction
    // (withFirm wraps `db.transaction`). The FOR UPDATE on the chain-head
    // row serialises concurrent writers on the same chain so no two
    // writers can both pick the same prev_hash.
    const inserted = await withFirm(this.db, input.firmId, async (tx) => {
      if (tenantId) {
        // Hint the connection with app.tenant_id too for any downstream
        // trigger or downstream read. Harmless on this table.
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      }

      // Chain head = latest row on the same (firm_id, tenant_id) chain in
      // occurred_at DESC, id DESC order. We lock it FOR UPDATE so the
      // transaction holds the chain head until commit and a concurrent
      // writer against the same chain blocks here instead of racing. The
      // firm_audit_events_chain_head_idx supports this lookup directly.
      //
      // NOTE on the tenant filter: drizzle's `eq(col, null)` produces
      // "col = NULL" which is always UNKNOWN, so we split the firm-level
      // (tenantId = NULL) case with `isNull`.
      const tenantFilter = tenantId
        ? eq(firmAuditEvents.tenantId, tenantId)
        : isNull(firmAuditEvents.tenantId);
      const headQuery = tx
        .select({ eventHash: firmAuditEvents.eventHash })
        .from(firmAuditEvents)
        .where(and(eq(firmAuditEvents.firmId, input.firmId), tenantFilter))
        .orderBy(desc(firmAuditEvents.occurredAt), desc(firmAuditEvents.id))
        .limit(1);
      const headRows = await headQuery.for('update');
      const prevHash = headRows[0]?.eventHash ?? null;

      // occurredAt is set client-side so the hash the app computes matches
      // the row we are about to insert. If we left it to the DB default
      // (now()), the row's occurred_at would be whatever the DB chose at
      // INSERT time, and the ISO string we hashed would disagree with
      // what any verifier reads back — the chain would be broken on the
      // very first row. Using toISOString() guarantees ms precision + 'Z'.
      const occurredAt = new Date();
      const chainable: ChainableEvent = {
        eventType: input.eventType,
        firmId: input.firmId,
        tenantId,
        actorUserId,
        source,
        occurredAt,
        payload,
      };
      const eventHash = computeEventHash(prevHash, chainable);

      const [r] = await tx
        .insert(firmAuditEvents)
        .values({
          firmId: input.firmId,
          tenantId,
          actorUserId,
          eventType: input.eventType,
          payload,
          source,
          occurredAt,
          eventHash,
          prevHash,
        })
        .returning();
      return r;
    });
    return this.mapRow(inserted);
  }

  /**
   * Verify the hash chain for one firm (optionally one tenant inside the
   * firm). Walks every row in occurred_at ASC order and recomputes
   * event_hash. Any divergence surfaces at the first offending row.
   *
   * Rows with `event_hash IS NULL` are pre-§5.7 legacy rows: they predate
   * this feature and sit at the head of their chain. We skip them AS
   * LONG AS the first chained row's prev_hash is NULL (i.e. the chain
   * started cleanly after the legacy tail). A chained row with a non-NULL
   * prev_hash that does not resolve to a legacy row is a break.
   */
  async verifyChain(firmId: string, tenantId?: string | null): Promise<AuditChainVerification> {
    return withFirm(this.db, firmId, async (tx) => {
      const tenantFilter =
        tenantId === undefined
          ? undefined
          : tenantId === null
            ? isNull(firmAuditEvents.tenantId)
            : eq(firmAuditEvents.tenantId, tenantId);
      const where = tenantFilter
        ? and(eq(firmAuditEvents.firmId, firmId), tenantFilter)
        : eq(firmAuditEvents.firmId, firmId);
      const rows = await tx
        .select()
        .from(firmAuditEvents)
        .where(where)
        .orderBy(asc(firmAuditEvents.occurredAt), asc(firmAuditEvents.id));

      let skipped = 0;
      // We verify PER (firm, tenant) chain so multi-tenant firms in a
      // single firm-wide verify do not get a false "break" at the first
      // row of each sub-chain. The key doubles as the chain identifier.
      const expectedPrevByChain = new Map<string, string | null>();

      for (const r of rows) {
        const chainKey = `${r.firmId}::${r.tenantId ?? ''}`;
        if (r.eventHash === null) {
          // Pre-chain legacy row; count it and move on. A later chained
          // row on the same chain MUST have prev_hash = NULL for the
          // chain to be considered clean. We force expectedPrev back to
          // NULL to express that.
          skipped += 1;
          expectedPrevByChain.set(chainKey, null);
          continue;
        }
        const expectedPrev = expectedPrevByChain.has(chainKey)
          ? (expectedPrevByChain.get(chainKey) ?? null)
          : null;
        if ((r.prevHash ?? null) !== expectedPrev) {
          return {
            ok: false,
            totalEvents: rows.length,
            firstTamperAt: r.id,
            expected: expectedPrev ?? '(null)',
            actual: r.prevHash ?? '(null)',
            reason: 'prev_hash does not match the previous row event_hash on this chain',
          };
        }
        const recomputed = computeEventHash(r.prevHash ?? null, {
          eventType: r.eventType,
          firmId: r.firmId,
          tenantId: r.tenantId,
          actorUserId: r.actorUserId,
          source: r.source,
          occurredAt: r.occurredAt,
          payload: (r.payload ?? {}) as Record<string, unknown>,
        });
        if (recomputed !== r.eventHash) {
          return {
            ok: false,
            totalEvents: rows.length,
            firstTamperAt: r.id,
            expected: recomputed,
            actual: r.eventHash,
            reason:
              'event_hash does not match sha256((prev ?? "") || "|" || canonical_json(event))',
          };
        }
        expectedPrevByChain.set(chainKey, r.eventHash);
      }
      return { ok: true, totalEvents: rows.length, skipped };
    });
  }

  async list(firmId: string, opts: ListAuditEventsOptions = {}): Promise<FirmAuditEvent[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), AuditService.MAX_LIST_LIMIT);
    return withFirm(this.db, firmId, async (tx) => {
      const filters = [eq(firmAuditEvents.firmId, firmId)];
      if (opts.since) {
        filters.push(gte(firmAuditEvents.occurredAt, opts.since));
      }
      if (opts.eventType) {
        filters.push(eq(firmAuditEvents.eventType, opts.eventType));
      }
      if (opts.tenantId) {
        // Non-null tenant scope only — firm-level rows (tenant_id IS NULL)
        // are excluded so an inspector narrowing to one tenant does not
        // see any firm-wide events. See ListAuditEventsOptions.tenantId.
        filters.push(eq(firmAuditEvents.tenantId, opts.tenantId));
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
      eventHash: r.eventHash ?? null,
      prevHash: r.prevHash ?? null,
    };
  }
}
