import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withFirm } from '../../db/with-firm';
import { firmClientTenants } from '../../db/schema/firms';
import { invoices } from '../../db/schema/invoicing';
import { tenants } from '../../db/schema/tenancy';

/**
 * EP5 Wave 2 (W2-B) — Consolidated Firm Dashboard service.
 *
 * Single aggregated view across every client tenant linked to the signed-in
 * firm. Built on the Wave 1 ADR-0003 option (a) RLS branch: with `app.firm_id`
 * set via withFirm, SELECTs on invoice, party and invoice_line return rows
 * for every tenant the firm actively engages, in ONE query. No per-tenant
 * loop is needed for the aggregate numbers themselves — only for resolving
 * tenant names, since the tenants table has no firm-RLS branch.
 *
 * All numeric aggregates and the perClient breakdown come from a single
 * cross-tenant SELECT; the issues list and vatReturnsDue list come from
 * bounded, LIMIT-ed queries with ORDER BY.
 */

export type IssueSeverity = 'error' | 'warning' | 'info';
export type VatReturnStatus = 'draft' | 'submitted' | 'overdue';

export interface FirmDashboardSummary {
  totalClients: number;
  totalInvoices30d: number;
  totalVatCollected30dOmr: string;
  overdueInvoiceCount: number;
  failedClearanceCount: number;
  pendingSubmissionCount: number;
  upcomingVatReturnCount: number;
}

export interface FirmDashboardPerClient {
  tenantId: string;
  tenantName: string;
  invoices30d: number;
  vatCollected30dOmr: string;
  lastSubmissionAt: string | null;
  openIssues: number;
}

export interface FirmDashboardIssue {
  severity: IssueSeverity;
  message: string;
  tenantId?: string;
  invoiceId?: string;
  createdAt: string;
}

export interface FirmDashboardVatReturn {
  tenantId: string;
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  status: VatReturnStatus;
}

export interface FirmDashboard {
  summary: FirmDashboardSummary;
  perClient: FirmDashboardPerClient[];
  issues: FirmDashboardIssue[];
  vatReturnsDue: FirmDashboardVatReturn[];
}

// Statuses that count as "in flight / not yet completed":
//  - VALIDATED / SIGNED : not yet submitted to the ASP  -> pendingSubmission
//  - SUBMITTED          : sent but awaiting ASP callback
//  - REJECTED           : terminal failure at the ASP   -> failedClearance
// "Overdue" follows the existing accountant.service heuristic until a
// payments module lands: an invoice issued >30 days ago that is not
// CLEARED or ARCHIVED is counted as overdue.
const PENDING_SUBMISSION_STATUSES = ['VALIDATED', 'SIGNED'] as const;
const FAILED_STATUSES = ['REJECTED'] as const;
const NOT_COMPLETED_STATUSES = ['VALIDATED', 'SIGNED', 'SUBMITTED', 'REJECTED'] as const;

const ISSUE_LIMIT = 20;

@Injectable()
export class FirmDashboardService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async getDashboard(firmId: string): Promise<FirmDashboard> {
    return withFirm(this.db, firmId, async (tx) => {
      // Legacy-policy NULLIF retrofit landed; sentinel no longer needed (see migration 1710001900000)

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const windowStartIso = thirtyDaysAgo.toISOString().slice(0, 10);
      const overdueCutoffIso = windowStartIso;
      const todayIso = now.toISOString().slice(0, 10);

      // 1. Resolve the firm's active client tenants (just IDs + createdAt).
      //    RLS gates this to the active firm.
      const clientLinks = await tx
        .select({
          tenantId: firmClientTenants.tenantId,
          createdAt: firmClientTenants.createdAt,
        })
        .from(firmClientTenants)
        .where(
          and(
            eq(firmClientTenants.firmId, firmId),
            isNull(firmClientTenants.revokedAt),
          ),
        );

      const totalClients = clientLinks.length;
      const tenantIds = clientLinks.map((c) => c.tenantId);

      // Short-circuit: if the firm has no client tenants, every downstream
      // query would return empty. Skip them and return an empty shape so
      // the API response is cheap and the UI can show its empty state.
      if (totalClients === 0) {
        return {
          summary: {
            totalClients: 0,
            totalInvoices30d: 0,
            totalVatCollected30dOmr: '0',
            overdueInvoiceCount: 0,
            failedClearanceCount: 0,
            pendingSubmissionCount: 0,
            upcomingVatReturnCount: 0,
          },
          perClient: [],
          issues: [],
          vatReturnsDue: [],
        } satisfies FirmDashboard;
      }

      // 2. Cross-tenant aggregates on invoices, in ONE statement each
      //    (not a per-tenant loop). RLS option (a) admits rows for every
      //    tenant linked to this firm.
      const totals30dRows = await tx
        .select({
          count: sql<number>`count(*)::int`,
          vat: sql<string>`coalesce(sum(${invoices.vatTotal}), 0)::text`,
        })
        .from(invoices)
        .where(gte(invoices.issueDate, windowStartIso));

      const statusAggRows = await tx
        .select({
          status: invoices.status,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .groupBy(invoices.status);
      const statusCount = new Map<string, number>();
      for (const r of statusAggRows) statusCount.set(r.status, Number(r.count));

      const overdueRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(invoices)
        .where(
          and(
            sql`${invoices.status} IN ('VALIDATED','SIGNED','SUBMITTED','REJECTED')`,
            lte(invoices.issueDate, overdueCutoffIso),
          ),
        );

      // Per-tenant breakdown. Single GROUP BY — N tenants, 1 query.
      const perTenant30dRows = await tx
        .select({
          tenantId: invoices.tenantId,
          invoiceCount: sql<number>`count(*)::int`,
          vatTotal: sql<string>`coalesce(sum(${invoices.vatTotal}), 0)::text`,
        })
        .from(invoices)
        .where(gte(invoices.issueDate, windowStartIso))
        .groupBy(invoices.tenantId);
      const perTenant30d = new Map<string, { invoiceCount: number; vatTotal: string }>();
      for (const r of perTenant30dRows) {
        perTenant30d.set(r.tenantId, {
          invoiceCount: Number(r.invoiceCount),
          vatTotal: r.vatTotal,
        });
      }

      const lastSubmissionRows = await tx
        .select({
          tenantId: invoices.tenantId,
          at: sql<string | null>`max(${invoices.updatedAt})::text`,
        })
        .from(invoices)
        .where(eq(invoices.status, 'SUBMITTED'))
        .groupBy(invoices.tenantId);
      const lastSubmissionByTenant = new Map<string, string | null>();
      for (const r of lastSubmissionRows) {
        lastSubmissionByTenant.set(r.tenantId, r.at);
      }

      const openIssuesRows = await tx
        .select({
          tenantId: invoices.tenantId,
          count: sql<number>`count(*)::int`,
        })
        .from(invoices)
        .where(
          sql`${invoices.status} IN ('REJECTED') OR (
            ${invoices.status} IN ('VALIDATED','SIGNED','SUBMITTED')
            AND ${invoices.issueDate} <= ${overdueCutoffIso}
          )`,
        )
        .groupBy(invoices.tenantId);
      const openIssuesByTenant = new Map<string, number>();
      for (const r of openIssuesRows) {
        openIssuesByTenant.set(r.tenantId, Number(r.count));
      }

      // 3. Top-N issues — single ORDER BY ... LIMIT query across tenants.
      //    Matches the top-20 contract: most recent cross-tenant problems.
      const issueCandidates = await tx
        .select({
          id: invoices.id,
          tenantId: invoices.tenantId,
          status: invoices.status,
          number: invoices.number,
          vatTotal: invoices.vatTotal,
          issueDate: invoices.issueDate,
          updatedAt: invoices.updatedAt,
        })
        .from(invoices)
        .where(
          sql`${invoices.status} IN ('REJECTED')
            OR (${invoices.status} IN ('VALIDATED','SIGNED','SUBMITTED')
                AND ${invoices.issueDate} <= ${overdueCutoffIso})
            OR (${invoices.status} IN ('VALIDATED','SIGNED','SUBMITTED','CLEARED')
                AND ${invoices.vatTotal}::numeric = 0)`,
        )
        .orderBy(desc(invoices.updatedAt))
        .limit(ISSUE_LIMIT);

      // 4. Resolve tenant names. The tenants table has no firm-RLS branch,
      //    so we flip app.tenant_id reentrantly inside this same tx to look
      //    each name up once. One SET LOCAL + one PK SELECT per tenant.
      const nameByTenant = new Map<string, string>();
      for (const link of clientLinks) {
        await tx.execute(sql`select set_config('app.tenant_id', ${link.tenantId}, true)`);
        const [row] = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, link.tenantId))
          .limit(1);
        nameByTenant.set(link.tenantId, row?.name ?? '');
      }
      // Legacy-policy NULLIF retrofit landed; sentinel no longer needed (see migration 1710001900000)

      // 5. Assemble perClient — one row per linked tenant, including those
      //    with zero activity in the window.
      const perClient: FirmDashboardPerClient[] = tenantIds.map((tid) => {
        const activity = perTenant30d.get(tid);
        const rawLast = lastSubmissionByTenant.get(tid) ?? null;
        return {
          tenantId: tid,
          tenantName: nameByTenant.get(tid) ?? '',
          invoices30d: activity?.invoiceCount ?? 0,
          vatCollected30dOmr: activity?.vatTotal ?? '0',
          lastSubmissionAt: rawLast ? new Date(rawLast).toISOString() : null,
          openIssues: openIssuesByTenant.get(tid) ?? 0,
        };
      });
      perClient.sort((a, b) => a.tenantName.localeCompare(b.tenantName));

      // 6. Build the issues list from the candidate query above.
      const issues: FirmDashboardIssue[] = issueCandidates.map((row) => {
        if (FAILED_STATUSES.includes(row.status as (typeof FAILED_STATUSES)[number])) {
          return {
            severity: 'error',
            message: `Invoice ${row.number} was rejected by the clearance gateway`,
            tenantId: row.tenantId,
            invoiceId: row.id,
            createdAt: new Date(row.updatedAt).toISOString(),
          };
        }
        if (Number(row.vatTotal) === 0) {
          return {
            severity: 'warning',
            message: `Invoice ${row.number} is missing a VAT total`,
            tenantId: row.tenantId,
            invoiceId: row.id,
            createdAt: new Date(row.updatedAt).toISOString(),
          };
        }
        // Must be overdue-pending.
        return {
          severity: 'warning',
          message: `Invoice ${row.number} is overdue (status ${row.status}, issued ${row.issueDate})`,
          tenantId: row.tenantId,
          invoiceId: row.id,
          createdAt: new Date(row.updatedAt).toISOString(),
        };
      });

      // 7. Upcoming VAT returns.
      //    No VAT-return table exists in the schema yet (future wave). For v1
      //    we project one entry per client tenant based on the current VAT
      //    quarter in Oman: period = current calendar quarter, dueDate = 30
      //    days after quarter end. Status is 'overdue' if dueDate has passed,
      //    otherwise 'draft'. This gives the UI something concrete to render
      //    without inventing a schema the rest of the system has not agreed on.
      const { periodStart, periodEnd, dueDate } = computeCurrentVatQuarter(now);
      const vatReturnsDue: FirmDashboardVatReturn[] = tenantIds.map((tid) => {
        const status: VatReturnStatus = todayIso > dueDate ? 'overdue' : 'draft';
        return {
          tenantId: tid,
          tenantName: nameByTenant.get(tid) ?? '',
          periodStart,
          periodEnd,
          dueDate,
          status,
        };
      });
      vatReturnsDue.sort((a, b) => a.tenantName.localeCompare(b.tenantName));

      // 8. Summary.
      const totalInvoices30d = Number(totals30dRows[0]?.count ?? 0);
      const totalVatCollected30dOmr = totals30dRows[0]?.vat ?? '0';
      const failedClearanceCount = FAILED_STATUSES.reduce(
        (a, s) => a + (statusCount.get(s) ?? 0),
        0,
      );
      const pendingSubmissionCount = PENDING_SUBMISSION_STATUSES.reduce(
        (a, s) => a + (statusCount.get(s) ?? 0),
        0,
      );
      const overdueInvoiceCount = Number(overdueRows[0]?.count ?? 0);

      // Silence unused-variable lint if NOT_COMPLETED_STATUSES is only
      // imported for documentation of the shape.
      void NOT_COMPLETED_STATUSES;

      const summary: FirmDashboardSummary = {
        totalClients,
        totalInvoices30d,
        totalVatCollected30dOmr,
        overdueInvoiceCount,
        failedClearanceCount,
        pendingSubmissionCount,
        upcomingVatReturnCount: vatReturnsDue.length,
      };

      return { summary, perClient, issues, vatReturnsDue };
    });
  }
}

/**
 * Current calendar-quarter window with a 30-day return filing allowance.
 * Pure helper, no DB round-trip; exported-shape fields are ISO date (UTC).
 */
function computeCurrentVatQuarter(now: Date): {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
} {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3);
  const startMonth = q * 3;
  const periodStart = new Date(Date.UTC(y, startMonth, 1));
  // Last day of period = day before next quarter's start.
  const nextStart = new Date(Date.UTC(y, startMonth + 3, 1));
  const periodEnd = new Date(nextStart.getTime() - 24 * 60 * 60 * 1000);
  const dueDate = new Date(periodEnd.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: periodEnd.toISOString().slice(0, 10),
    dueDate: dueDate.toISOString().slice(0, 10),
  };
}
