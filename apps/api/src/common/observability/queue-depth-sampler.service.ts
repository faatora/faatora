import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { loadEnv } from '../../config/env';
import { clearanceDlqSize, clearanceQueueDepth } from './metrics';

/**
 * Clearance queue-depth sampler.
 *
 * Reads `clearance_outbox` grouped by `status` and `clearance_dlq`
 * COUNT(*) every 15 s, and sets the two gauges that drive the
 * capacity alerts. This is cross-tenant monitoring — if the drain is
 * stuck for one tenant we need to see it on the system-wide
 * dashboard, not through a tenant-scoped pane.
 *
 * CONNECTION. A dedicated `pg.Pool` using `MIGRATION_DATABASE_URL`:
 *
 *   - The app pool runs under a role with FORCE ROW LEVEL SECURITY,
 *     and `current_setting('app.tenant_id')` is unset outside a
 *     `withTenant()` block, so a plain `SELECT COUNT(*)` would be
 *     filtered to zero rows.
 *   - The migration role owns these tables and bypasses RLS. We only
 *     read aggregate (`status`, `COUNT(*)`) tuples here — never a
 *     tenant-scoped column.
 *
 * MISSING-TABLE POLICY. In environments where A14's migration hasn't
 * run yet (`clearance_outbox` doesn't exist) we no-op after a
 * one-time warn log. The gauges stay un-updated so Prometheus will
 * see them as stale, which is the signal the operator wants.
 */
@Injectable()
export class QueueDepthSamplerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('QueueDepthSampler');
  private pool: Pool | null = null;
  private missingTableWarned = false;
  private readOnlyPoolMissingWarned = false;

  onModuleInit(): void {
    const env = loadEnv();
    const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
    if (!env.MIGRATION_DATABASE_URL && !this.readOnlyPoolMissingWarned) {
      this.readOnlyPoolMissingWarned = true;
      this.log.warn(
        'MIGRATION_DATABASE_URL is unset — falling back to DATABASE_URL. Cross-tenant counts may be filtered by RLS.',
      );
    }
    this.pool = new Pool({ connectionString: url, max: 2 });
    this.pool.on('error', (err) => {
      this.log.warn({ err: err.message }, 'queue-depth pool emitted error');
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {
        /* pool shutdown races are fine */
      });
      this.pool = null;
    }
  }

  // Six-field cron: every 15s.
  @Cron('*/15 * * * * *')
  async tick(): Promise<void> {
    await this.runSample();
  }

  /** Public for tests — one sampling pass. */
  async runSample(): Promise<void> {
    if (!this.pool) return;
    try {
      const outbox = await this.pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM clearance_outbox GROUP BY status`,
      );
      // Zero-out statuses that didn't appear so a drained queue doesn't
      // leave a stale gauge value.
      const seen = new Set<string>();
      for (const row of outbox.rows) {
        seen.add(row.status);
        clearanceQueueDepth.set({ status: row.status }, Number(row.count));
      }
      for (const status of ['queued', 'in_flight', 'delivered', 'dead']) {
        if (!seen.has(status)) {
          clearanceQueueDepth.set({ status }, 0);
        }
      }

      const dlq = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM clearance_dlq`,
      );
      clearanceDlqSize.set(Number(dlq.rows[0]?.count ?? 0));
    } catch (err) {
      const msg = (err as Error & { code?: string }).message || '';
      // Postgres undefined_table (42P01) — expected before A14's migration.
      if ((err as { code?: string }).code === '42P01' || msg.includes('does not exist')) {
        if (!this.missingTableWarned) {
          this.missingTableWarned = true;
          this.log.warn(
            'clearance_outbox / clearance_dlq not present — queue-depth sampler is a no-op until A14 migration lands',
          );
        }
        return;
      }
      this.log.warn({ err: msg }, 'queue-depth sample failed');
    }
  }
}
