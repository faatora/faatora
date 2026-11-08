import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { subscriptions, usageMeters } from '../../db/schema/billing';

@Injectable()
export class MeteringService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async increment(
    tenantId: string,
    metric: string,
    periodStart: Date,
    periodEnd: Date,
    by = 1,
  ): Promise<number> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(usageMeters)
        .values({
          tenantId,
          metric,
          periodStart,
          periodEnd,
          count: by,
        })
        .onConflictDoUpdate({
          target: [usageMeters.tenantId, usageMeters.periodStart, usageMeters.metric],
          set: { count: sql`${usageMeters.count} + ${by}` },
        })
        .returning();
      return row.count;
    });
  }

  async getUsage(
    tenantId: string,
    metric: string,
    periodStart: Date,
    _periodEnd: Date,
  ): Promise<number> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(usageMeters)
        .where(
          and(
            eq(usageMeters.tenantId, tenantId),
            eq(usageMeters.metric, metric),
            eq(usageMeters.periodStart, periodStart),
          ),
        )
        .limit(1);
      return row ? row.count : 0;
    });
  }

  /**
   * Increments the "invoices_issued" meter for the tenant's current subscription period.
   * No-op (returns 0) if the tenant has no subscription.
   */
  async onInvoiceIssued(tenantId: string): Promise<number> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [sub] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
      if (!sub) return 0;
      const [row] = await tx
        .insert(usageMeters)
        .values({
          tenantId,
          metric: 'invoices_issued',
          periodStart: sub.currentPeriodStart,
          periodEnd: sub.currentPeriodEnd,
          count: 1,
        })
        .onConflictDoUpdate({
          target: [usageMeters.tenantId, usageMeters.periodStart, usageMeters.metric],
          set: { count: sql`${usageMeters.count} + 1` },
        })
        .returning();
      return row.count;
    });
  }
}
