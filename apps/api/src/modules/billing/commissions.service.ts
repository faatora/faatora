import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { resellerCommissions } from '../../db/schema/billing';

interface ReferralLookup {
  firmId: string;
  commissionRate: number; // 0..1
}

/**
 * Commission accrual for referred clients.
 *
 * The referral tables (`accountant_firms`, `accountant_client_links`) are owned by A10 and
 * may land in a parallel migration. We query them with raw SQL and tolerate PG error 42P01
 * (undefined_table), logging a warning and no-op'ing. Once A10's migration is applied the
 * accrual starts working automatically — no code change on this side.
 */
@Injectable()
export class CommissionsService {
  private readonly log = new Logger(CommissionsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  private async lookupReferral(tenantId: string): Promise<ReferralLookup | null> {
    try {
      const result = await this.db.execute(sql`
        SELECT l.firm_id AS firm_id, COALESCE(f.commission_rate, 0.2) AS commission_rate
        FROM accountant_client_links l
        JOIN accountant_firms f ON f.id = l.firm_id
        WHERE l.tenant_id = ${tenantId} AND l.referred = true
        LIMIT 1
      `);
      // node-postgres result shape — rows is an array
      const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
      const row = rows[0];
      if (!row) return null;
      return {
        firmId: String(row.firm_id),
        commissionRate: Number(row.commission_rate),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '42P01') {
        this.log.warn(
          'Referral tables (accountant_firms/accountant_client_links) not present yet — skipping commission accrual.',
        );
        return null;
      }
      throw err;
    }
  }

  async accrue(input: {
    billingInvoiceId: string;
    tenantId: string;
    subtotal: number;
  }): Promise<{ id: string; amount: number } | null> {
    const referral = await this.lookupReferral(input.tenantId);
    if (!referral) return null;
    const amount = Number((input.subtotal * referral.commissionRate).toFixed(3));
    const [row] = await this.db
      .insert(resellerCommissions)
      .values({
        firmId: referral.firmId,
        tenantId: input.tenantId,
        billingInvoiceId: input.billingInvoiceId,
        amount: amount.toFixed(3),
        status: 'accrued',
      })
      .onConflictDoNothing({ target: resellerCommissions.billingInvoiceId })
      .returning();
    if (!row) return null;
    return { id: row.id, amount: Number(row.amount) };
  }

  async markPaid(id: string) {
    const [row] = await this.db
      .update(resellerCommissions)
      .set({ status: 'paid' })
      .where(eq(resellerCommissions.id, id))
      .returning();
    return row ?? null;
  }

  async listByFirm(firmId: string) {
    return this.db.select().from(resellerCommissions).where(eq(resellerCommissions.firmId, firmId));
  }
}
