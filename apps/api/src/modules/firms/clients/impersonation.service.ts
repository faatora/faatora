import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DB, pgSslFor, type Database } from '../../../db/db.module';
import { withFirm } from '../../../db/with-firm';
import { firmImpersonationEvents } from '../../../db/schema/impersonation';
import * as schema from '../../../db/schema';
import { loadEnv } from '../../../config/env';

/**
 * A verified active impersonation session. Shape kept narrow because
 * TenantGuard only reads a handful of fields from the verify() result.
 */
export interface ActiveImpersonationSession {
  id: string;
  firmId: string;
  clientTenantId: string;
  userId: string;
  startedAt: Date;
  expiresAt: Date;
}

export interface StartImpersonationInput {
  firmId: string;
  clientTenantId: string;
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * ImpersonationService — operational store for the "act as this client"
 * handshake.
 *
 * Two surfaces:
 *
 *   start() writes a new session row. Must run with app.firm_id set so
 *     RLS gates the insert — the controller already does the
 *     firm_client_tenants link check inside withFirm, and start() reuses
 *     the same wrapper.
 *
 *   verify() reads the current active row for (userId, clientTenantId).
 *     Called by TenantGuard on EVERY request that carries
 *     X-Impersonate-Tenant-Id, and so runs outside any firm context —
 *     the caller may not yet have set app.firm_id (they might not even
 *     know which firm they are impersonating under; TenantGuard uses
 *     this result to find out). The read therefore goes through a
 *     dedicated RLS-bypass pool, the same pattern FirmsService uses for
 *     listMyFirms / acceptInvitation.
 *
 * The bypass pool is lazily opened on first use and closed in
 * onModuleDestroy, same shape as FirmsService.getBypassDb().
 */
@Injectable()
export class ImpersonationService implements OnModuleDestroy {
  private readonly log = new Logger(ImpersonationService.name);
  private bypassPool: Pool | null = null;
  private bypassDb: NodePgDatabase<typeof schema> | null = null;

  constructor(@Inject(DB) private readonly db: Database) {}

  async onModuleDestroy(): Promise<void> {
    if (this.bypassPool) {
      await this.bypassPool.end();
      this.bypassPool = null;
      this.bypassDb = null;
    }
  }

  /**
   * Session TTL in milliseconds. Read fresh from env each time so a test
   * that mutates process.env.IMPERSONATION_SESSION_TTL_MS before calling
   * start() sees the new value — loadEnv() memoises, so the test harness
   * can short-circuit by seeding before module compile.
   */
  getSessionTtlMs(): number {
    const raw = process.env.IMPERSONATION_SESSION_TTL_MS;
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return loadEnv().IMPERSONATION_SESSION_TTL_MS;
  }

  /**
   * Record the start of an impersonation session. Called from
   * ImpersonationController AFTER the controller has validated:
   *   1. a non-revoked firm_client_tenants link exists for (firmId, tenantId)
   *   2. the caller's firm role is >= staff
   *
   * The controller passes those pre-conditions in — this service does
   * not re-check them. It does set an explicit app.firm_id (via
   * withFirm) so the INSERT passes the firm_impersonation_events_isolation
   * RLS policy.
   *
   * Returns the inserted row so the controller can echo the expires_at
   * back to the frontend (which uses it to schedule an auto-exit).
   */
  async start(input: StartImpersonationInput): Promise<ActiveImpersonationSession> {
    const ttlMs = this.getSessionTtlMs();
    const expiresAt = new Date(Date.now() + ttlMs);
    return withFirm(this.db, input.firmId, async (tx) => {
      const [row] = await tx
        .insert(firmImpersonationEvents)
        .values({
          firmId: input.firmId,
          clientTenantId: input.clientTenantId,
          userId: input.userId,
          expiresAt,
          userAgent: input.userAgent ?? null,
          ip: input.ip ?? null,
        })
        .returning();
      return {
        id: row.id,
        firmId: row.firmId,
        clientTenantId: row.clientTenantId,
        userId: row.userId,
        startedAt: row.startedAt,
        expiresAt: row.expiresAt,
      };
    });
  }

  /**
   * TenantGuard's hot-path check. Returns the active row (or null) for
   * the (userId, clientTenantId) pair. "Active" means:
   *   - ended_at IS NULL
   *   - expires_at > now()
   *
   * The lookup goes through the RLS-bypass pool because the caller has
   * not yet set app.firm_id — the whole point of this call is to find
   * out which firm the user is impersonating under so TenantGuard can
   * attach it to the request as req.impersonating.firmId.
   *
   * Returns null when the bypass pool is unavailable (dev/test without
   * MIGRATION_DATABASE_URL). TenantGuard treats that as "no active
   * session" and refuses the impersonation header, which is the safe
   * default.
   */
  async verify(userId: string, clientTenantId: string): Promise<ActiveImpersonationSession | null> {
    const bypass = this.getBypassDb();
    if (!bypass) {
      this.log.warn('verify() called without MIGRATION_DATABASE_URL; refusing impersonation');
      return null;
    }
    const rows = await bypass
      .select()
      .from(firmImpersonationEvents)
      .where(
        and(
          eq(firmImpersonationEvents.userId, userId),
          eq(firmImpersonationEvents.clientTenantId, clientTenantId),
          isNull(firmImpersonationEvents.endedAt),
          gt(firmImpersonationEvents.expiresAt, sql`now()`),
        ),
      )
      .orderBy(sql`started_at desc`)
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      firmId: row.firmId,
      clientTenantId: row.clientTenantId,
      userId: row.userId,
      startedAt: row.startedAt,
      expiresAt: row.expiresAt,
    };
  }

  private getBypassDb(): NodePgDatabase<typeof schema> | null {
    if (this.bypassDb) return this.bypassDb;
    const env = loadEnv();
    const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
    if (!url) return null;
    this.bypassPool = new Pool({ connectionString: url, max: 2, ssl: pgSslFor(env.NODE_ENV) });
    this.bypassDb = drizzle(this.bypassPool, { schema });
    return this.bypassDb;
  }
}
