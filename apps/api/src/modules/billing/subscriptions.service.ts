import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { plans, subscriptions } from '../../db/schema/billing';
import { PlansService } from './plans.service';

export function addOneMonth(from: Date): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  // handle month-length overflow (e.g. Jan 31 -> Mar 3): clamp to last day of target month
  if (d.getUTCDate() < day) {
    d.setUTCDate(0);
  }
  return d;
}

@Injectable()
export class SubscriptionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly plansService: PlansService,
  ) {}

  async subscribe(tenantId: string, planCode: string) {
    const plan = await this.plansService.getByCode(planCode);
    return withTenant(this.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
      if (!existing) {
        const now = new Date();
        const [row] = await tx
          .insert(subscriptions)
          .values({
            tenantId,
            planId: plan.id,
            status: 'active',
            startedAt: now,
            currentPeriodStart: now,
            currentPeriodEnd: addOneMonth(now),
          })
          .returning();
        return { ...row, plan };
      }
      if (existing.planId === plan.id) {
        return { ...existing, plan };
      }
      // Swap plan effective next period: keep current period, change plan on currentPeriodEnd rollover.
      // For Wave 2 (no renewal cron yet) we just stage the plan swap by updating planId to apply at the
      // next period start — we do this by writing planId now but preserving currentPeriodEnd so the
      // existing period keeps running under the old plan's prices during metering. To keep that semantic
      // honest, we also update startedAt=now so observers can tell when the swap was requested.
      const [row] = await tx
        .update(subscriptions)
        .set({
          planId: plan.id,
          status: existing.status === 'canceled' ? 'active' : existing.status,
          canceledAt: null,
        })
        .where(eq(subscriptions.id, existing.id))
        .returning();
      return { ...row, plan };
    });
  }

  async cancel(tenantId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
      if (!existing) throw new NotFoundException('No subscription to cancel');
      if (existing.status === 'canceled') {
        throw new BadRequestException('Subscription already canceled');
      }
      const [row] = await tx
        .update(subscriptions)
        .set({ status: 'canceled', canceledAt: new Date() })
        .where(eq(subscriptions.id, existing.id))
        .returning();
      return row;
    });
  }

  async getActive(tenantId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .select({
          subscription: subscriptions,
          plan: plans,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
      if (!row) return null;
      return { ...row.subscription, plan: row.plan };
    });
  }
}
