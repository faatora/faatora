import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { accountantFirms, accountantClientLinks } from '../../db/schema/accountant';
import { memberships, tenants } from '../../db/schema/tenancy';
import { invoices } from '../../db/schema/invoicing';
import type { CreateFirmDto } from './dto/create-firm.dto';

export interface FirmRow {
  id: string;
  ownerUserId: string;
  name: string;
  vatin: string | null;
  phone: string | null;
  email: string | null;
  commissionRate: string;
  createdAt: Date;
}

export interface TenantSummary {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  role: string;
  referred: boolean;
  linkedAt: Date;
}

export interface TenantKpis {
  tenantId: string;
  tenantName: string;
  invoiceCount: number;
  invoiceTotal: string;
  vatOutput: string;
  overdueArCount: number;
  pendingBatchCount: number;
}

export interface CommissionRow {
  tenantId: string;
  tenantName: string;
  periodFrom: string;
  periodTo: string;
  paidTotal: string;
  commissionRate: string;
  commissionAmount: string;
}

const ACCOUNTANT_ROLES = ['owner', 'accountant'] as const;
type AccountantRole = (typeof ACCOUNTANT_ROLES)[number];

function isAccountantRole(role: string): role is AccountantRole {
  return (ACCOUNTANT_ROLES as readonly string[]).includes(role);
}

@Injectable()
export class AccountantService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async getFirmForUser(userId: string): Promise<FirmRow | null> {
    const rows = await this.db
      .select()
      .from(accountantFirms)
      .where(eq(accountantFirms.ownerUserId, userId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      name: r.name,
      vatin: r.vatin,
      phone: r.phone,
      email: r.email,
      commissionRate: String(r.commissionRate),
      createdAt: r.createdAt,
    };
  }

  async createFirm(userId: string, dto: CreateFirmDto): Promise<FirmRow> {
    const existing = await this.getFirmForUser(userId);
    if (existing) throw new ConflictException('Firm already exists for user');
    try {
      const [row] = await this.db
        .insert(accountantFirms)
        .values({
          ownerUserId: userId,
          name: dto.name,
          vatin: dto.vatin ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
        })
        .returning();
      return {
        id: row.id,
        ownerUserId: row.ownerUserId,
        name: row.name,
        vatin: row.vatin,
        phone: row.phone,
        email: row.email,
        commissionRate: String(row.commissionRate),
        createdAt: row.createdAt,
      };
    } catch (err) {
      // concurrent insert — propagate as a conflict
      const msg = err instanceof Error ? err.message : String(err);
      if (/accountant_firms_owner_user_id_uniq/.test(msg)) {
        throw new ConflictException('Firm already exists for user');
      }
      throw err;
    }
  }

  /**
   * List every linked client tenant for the caller's firm, verifying — under
   * each tenant's RLS context — that the caller is still an owner/accountant.
   */
  async listMyTenants(userId: string): Promise<TenantSummary[]> {
    const firm = await this.getFirmForUser(userId);
    if (!firm) return [];
    const links = await this.db
      .select()
      .from(accountantClientLinks)
      .where(eq(accountantClientLinks.firmId, firm.id));
    if (links.length === 0) return [];

    const summaries: TenantSummary[] = [];
    for (const link of links) {
      const info = await withTenant(this.db, link.tenantId, async (tx) => {
        const mRows = await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, link.tenantId)))
          .limit(1);
        if (!mRows[0] || !isAccountantRole(mRows[0].role)) return null;
        const tRows = await tx
          .select({ name: tenants.name, status: tenants.status })
          .from(tenants)
          .where(eq(tenants.id, link.tenantId))
          .limit(1);
        if (!tRows[0]) return null;
        return { role: mRows[0].role, name: tRows[0].name, status: tRows[0].status };
      });
      if (!info) continue;
      summaries.push({
        tenantId: link.tenantId,
        tenantName: info.name,
        tenantStatus: info.status,
        role: info.role,
        referred: link.referred,
        linkedAt: link.createdAt,
      });
    }
    summaries.sort((a, b) => a.tenantName.localeCompare(b.tenantName));
    return summaries;
  }

  /**
   * Create (or no-op) a link from the user's firm to the given tenant.
   * The caller must already have an owner/accountant membership in the tenant.
   */
  async linkClient(
    userId: string,
    tenantId: string,
    opts: { referred?: boolean } = {},
  ): Promise<{ firmId: string; tenantId: string; referred: boolean }> {
    const firm = await this.getFirmForUser(userId);
    if (!firm) throw new NotFoundException('Create a firm before linking clients');

    const role = await withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
        .limit(1);
      return rows[0]?.role ?? null;
    });
    if (!role) throw new ForbiddenException('No membership in this tenant');
    if (!isAccountantRole(role)) {
      throw new ForbiddenException('Membership role must be owner or accountant');
    }

    const existing = await this.db
      .select()
      .from(accountantClientLinks)
      .where(
        and(
          eq(accountantClientLinks.firmId, firm.id),
          eq(accountantClientLinks.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { firmId: firm.id, tenantId, referred: existing[0].referred };
    }
    const [row] = await this.db
      .insert(accountantClientLinks)
      .values({
        firmId: firm.id,
        tenantId,
        referred: opts.referred ?? false,
      })
      .returning();
    return { firmId: row.firmId, tenantId: row.tenantId, referred: row.referred };
  }

  async unlinkClient(userId: string, tenantId: string): Promise<{ removed: boolean }> {
    const firm = await this.getFirmForUser(userId);
    if (!firm) return { removed: false };
    const removed = await this.db
      .delete(accountantClientLinks)
      .where(
        and(
          eq(accountantClientLinks.firmId, firm.id),
          eq(accountantClientLinks.tenantId, tenantId),
        ),
      )
      .returning({ id: accountantClientLinks.id });
    return { removed: removed.length > 0 };
  }

  /**
   * Build per-tenant KPIs. We MUST iterate per tenant because the invoices
   * table has FORCE row-level security — a single statement cannot see rows
   * across tenants. Each per-tenant block is wrapped in withTenant so that
   * `app.tenant_id` is set for that transaction. We run them sequentially
   * (not Promise.all): a firm may have 10-50 clients and we don't want to
   * open that many pool connections — each withTenant takes a transaction.
   */
  async consolidatedKpis(userId: string): Promise<TenantKpis[]> {
    const summaries = await this.listMyTenants(userId);
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startIso = start.toISOString().slice(0, 10);
    const endIso = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const overdueCutoffIso = thirtyDaysAgo.toISOString().slice(0, 10);

    const results: TenantKpis[] = [];
    for (const t of summaries) {
      const perTenant = await withTenant(this.db, t.tenantId, async (tx) => {
        const monthRows = await tx
          .select({
            count: sql<number>`count(*)::int`,
            total: sql<string>`coalesce(sum(${invoices.grandTotal}), 0)::text`,
            vat: sql<string>`coalesce(sum(${invoices.vatTotal}), 0)::text`,
          })
          .from(invoices)
          .where(and(gte(invoices.issueDate, startIso), lte(invoices.issueDate, endIso)));

        // "Overdue AR" is a placeholder until a payments module lands: an
        // invoice in a post-draft state issued >30 days ago is treated as
        // overdue. A1/A6 may replace this when they expose a payments table.
        const overdueRows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(invoices)
          .where(
            and(
              sql`${invoices.status} IN ('VALIDATED','SIGNED','ISSUED')`,
              lte(invoices.issueDate, overdueCutoffIso),
            ),
          );

        // Pending B2C batches — the batching table is owned by another Wave 2
        // agent (A5). Check `information_schema.tables` first so this method
        // works whether or not that migration has run.
        const batchExists = await tx.execute(sql`
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'b2c_batches'
          LIMIT 1
        `);
        let pendingBatchCount = 0;
        if (batchExists.rows.length > 0) {
          const b = await tx.execute(sql`
            SELECT count(*)::int AS count
            FROM b2c_batches
            WHERE status = 'PENDING'
          `);
          const first = b.rows[0] as { count?: number | string } | undefined;
          pendingBatchCount = first && first.count !== undefined ? Number(first.count) : 0;
        }

        return {
          invoiceCount: Number(monthRows[0]?.count ?? 0),
          invoiceTotal: monthRows[0]?.total ?? '0',
          vatOutput: monthRows[0]?.vat ?? '0',
          overdueArCount: Number(overdueRows[0]?.count ?? 0),
          pendingBatchCount,
        };
      });
      results.push({
        tenantId: t.tenantId,
        tenantName: t.tenantName,
        ...perTenant,
      });
    }
    return results;
  }

  /**
   * 20% * SUM(billing invoices paid in [from,to]) for each referred client.
   * The billing_invoices table is owned by A11 (billing module). If it is
   * absent from this deployment we return [] so the console doesn't fail.
   * TODO(A11): remove the information_schema guard once billing_invoices is
   * part of the base migrations.
   */
  async calculateCommission(userId: string, from: string, to: string): Promise<CommissionRow[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('from and to must be YYYY-MM-DD dates');
    }
    const firm = await this.getFirmForUser(userId);
    if (!firm) return [];

    const tableCheck = await this.db.execute(sql`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'billing_invoices'
      LIMIT 1
    `);
    if (tableCheck.rows.length === 0) return [];

    const referred = await this.db
      .select()
      .from(accountantClientLinks)
      .where(
        and(eq(accountantClientLinks.firmId, firm.id), eq(accountantClientLinks.referred, true)),
      );
    if (referred.length === 0) return [];

    const commissionRate = Number(firm.commissionRate);
    const results: CommissionRow[] = [];
    // billing_invoices has FORCE RLS, so each query runs inside its tenant's
    // transaction with app.tenant_id set. Sequential loop again — a firm with
    // many referred clients would otherwise exhaust the pool.
    for (const link of referred) {
      const perTenant = await withTenant(this.db, link.tenantId, async (tx) => {
        const sumRow = await tx.execute(sql`
          SELECT COALESCE(SUM(total), 0)::text AS paid_total
          FROM billing_invoices
          WHERE status = 'paid'
            AND paid_at >= ${from}::date
            AND paid_at <  (${to}::date + INTERVAL '1 day')
        `);
        const nameRow = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, link.tenantId))
          .limit(1);
        const sum = sumRow.rows[0] as { paid_total?: string } | undefined;
        return {
          paidTotal: sum?.paid_total ?? '0',
          tenantName: nameRow[0]?.name ?? '',
        };
      });
      const commissionAmount = (Number(perTenant.paidTotal) * commissionRate).toFixed(3);
      results.push({
        tenantId: link.tenantId,
        tenantName: perTenant.tenantName,
        periodFrom: from,
        periodTo: to,
        paidTotal: perTenant.paidTotal,
        commissionRate: String(commissionRate),
        commissionAmount,
      });
    }
    return results;
  }
}
