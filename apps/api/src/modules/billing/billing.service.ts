import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { billingInvoices, plans, subscriptions, usageMeters } from '../../db/schema/billing';
import { CommissionsService } from './commissions.service';

export const VAT_RATE = 0.05;

export interface BillingComputation {
  used: number;
  included: number;
  overageUnits: number;
  planFee: number;
  overageFee: number;
  subtotal: number;
  vat: number;
  total: number;
}

export function computeBilling(input: {
  used: number;
  included: number;
  monthlyFee: number;
  overagePrice: number;
  vatRate?: number;
}): BillingComputation {
  const vatRate = input.vatRate ?? VAT_RATE;
  const overageUnits = Math.max(0, input.used - input.included);
  const planFee = round3(input.monthlyFee);
  const overageFee = round3(overageUnits * input.overagePrice);
  const subtotal = round3(planFee + overageFee);
  const vat = round3(subtotal * vatRate);
  const total = round3(subtotal + vat);
  return {
    used: input.used,
    included: input.included,
    overageUnits,
    planFee,
    overageFee,
    subtotal,
    vat,
    total,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function billingNumber(periodStart: Date): string {
  const y = periodStart.getUTCFullYear();
  const m = String(periodStart.getUTCMonth() + 1).padStart(2, '0');
  return `BILL-${y}${m}`;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly commissions: CommissionsService,
  ) {}

  async generateMonthlyBilling(tenantId: string) {
    const result = await withTenant(this.db, tenantId, async (tx) => {
      const [sub] = await tx
        .select({ subscription: subscriptions, plan: plans })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
      if (!sub) throw new NotFoundException('No active subscription for tenant');

      const periodStart = sub.subscription.currentPeriodStart;
      const periodEnd = sub.subscription.currentPeriodEnd;

      const [meter] = await tx
        .select()
        .from(usageMeters)
        .where(
          and(
            eq(usageMeters.tenantId, tenantId),
            eq(usageMeters.metric, 'invoices_issued'),
            eq(usageMeters.periodStart, periodStart),
          ),
        )
        .limit(1);
      const used = meter?.count ?? 0;

      const comp = computeBilling({
        used,
        included: sub.plan.includedInvoices,
        monthlyFee: Number(sub.plan.monthlyFee),
        overagePrice: Number(sub.plan.overagePricePerInvoice),
      });

      const number = billingNumber(periodStart);
      const [row] = await tx
        .insert(billingInvoices)
        .values({
          tenantId,
          number,
          periodStart,
          periodEnd,
          planFee: comp.planFee.toFixed(3),
          overageFee: comp.overageFee.toFixed(3),
          subtotal: comp.subtotal.toFixed(3),
          vat: comp.vat.toFixed(3),
          total: comp.total.toFixed(3),
          currency: sub.plan.currency,
          status: 'open',
        })
        .returning();

      if (!row) {
        throw new UnprocessableEntityException(
          `Billing invoice ${number} already exists for this tenant`,
        );
      }
      return { row, comp };
    });

    // Commission accrual uses raw SQL + public reseller_commissions insert — no tenant RLS context needed.
    await this.commissions.accrue({
      billingInvoiceId: result.row.id,
      tenantId,
      subtotal: result.comp.subtotal,
    });

    return { ...result.row, computation: result.comp };
  }

  async markPaid(tenantId: string, billingInvoiceId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(billingInvoices)
        .where(eq(billingInvoices.id, billingInvoiceId))
        .limit(1);
      if (!existing) throw new NotFoundException('Billing invoice not found');
      if (existing.status === 'void') {
        throw new BadRequestException('Cannot mark a void billing invoice as paid');
      }
      const [row] = await tx
        .update(billingInvoices)
        .set({ status: 'paid', paidAt: new Date() })
        .where(eq(billingInvoices.id, billingInvoiceId))
        .returning();
      return row;
    });
  }

  async list(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(billingInvoices).orderBy(desc(billingInvoices.createdAt)),
    );
  }

  async get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(billingInvoices)
        .where(eq(billingInvoices.id, id))
        .limit(1);
      if (!row) throw new NotFoundException('Billing invoice not found');
      return row;
    });
  }
}
