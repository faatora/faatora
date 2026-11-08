/**
 * EP5 Wave 2 (W2-C) -- batch operations across a firm's client tenants.
 *
 * Two features live here:
 *   - validateAllPending(firmId): a dry-run compliance preview over every
 *     DRAFT invoice across the firm's active client tenants. No state
 *     mutation. For each tenant we open a withFirmTenant transaction and
 *     delegate to the existing compliance validator -- this keeps the
 *     preview using the same rule pack as the actual issue() path.
 *   - exportVatReturnSummaries(firmId, periodStart, periodEnd): produces
 *     a CSV with one row per client tenant summarising its invoice
 *     activity for the given period. Uses the firm RLS SELECT branch
 *     (ADR-0003 option a) via withFirm, so the aggregation is a single
 *     cross-tenant query gated by firm_client_tenants -- no per-tenant
 *     round trips.
 *
 * These are both read-only operations. Nothing here INSERTs, UPDATEs or
 * emits domain events; W2-E's audit log subscribes to firm.client.added
 * / firm.client.revoked which are fired from FirmsService itself.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withFirm } from '../../db/with-firm';
import { withFirmTenant } from '../../db/with-firm-tenant';
import { firmClientTenants } from '../../db/schema/firms';
import { invoices, invoiceLines } from '../../db/schema/invoicing';
import { tenants } from '../../db/schema/tenancy';
import { COMPLIANCE_VALIDATOR, type ComplianceValidator } from '../invoices/compliance.port';
import { computeTotals, type LineInput } from '../invoices/money';

export interface ValidationPreviewPerTenant {
  tenantId: string;
  tenantName: string;
  totalDraft: number;
  passed: number;
  failed: number;
  failures: Array<{ invoiceId: string; number: string; errors: string[] }>;
}

export interface ValidationPreviewResult {
  summary: {
    tenantsScanned: number;
    totalDraft: number;
    totalPassed: number;
    totalFailed: number;
  };
  perTenant: ValidationPreviewPerTenant[];
}

export interface VatReturnRow {
  tenantId: string;
  tenantName: string;
  vatin: string | null;
  invoiceCount: number;
  totalTaxableOmr: string;
  totalVatOmr: string;
  netOmr: string;
}

@Injectable()
export class BatchOperationsService {
  private readonly log = new Logger(BatchOperationsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(COMPLIANCE_VALIDATOR) private readonly compliance: ComplianceValidator,
  ) {}

  /**
   * Walk every active client tenant of the firm, run compliance against
   * each DRAFT invoice, return a summary + per-tenant breakdown.
   *
   * Error handling: a failure inside one tenant's transaction (including
   * an RLS or compliance error) is recorded on that tenant's entry and
   * does not short-circuit the scan. The outer promise resolves even if
   * every tenant errored; callers inspect .summary / .perTenant.
   */
  async validateAllPending(firmId: string): Promise<ValidationPreviewResult> {
    // Phase 1: enumerate the firm's client tenants with their display
    // names. firm_client_tenants is gated by app.firm_id (via withFirm);
    // the tenants peek is a per-tenant SELECT under app.tenant_id, same
    // pattern FirmsService.listClientTenants uses.
    const links = await withFirm(this.db, firmId, async (tx) => {
      const rawLinks = await tx
        .select({ tenantId: firmClientTenants.tenantId })
        .from(firmClientTenants)
        .where(and(eq(firmClientTenants.firmId, firmId), isNull(firmClientTenants.revokedAt)));
      const out: Array<{ tenantId: string; tenantName: string }> = [];
      for (const l of rawLinks) {
        await tx.execute(sql`select set_config('app.tenant_id', ${l.tenantId}, true)`);
        const tRows = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, l.tenantId))
          .limit(1);
        out.push({ tenantId: l.tenantId, tenantName: tRows[0]?.name ?? '' });
      }
      return out;
    });

    const perTenant: ValidationPreviewPerTenant[] = [];
    let totalDraft = 0;
    let totalPassed = 0;
    let totalFailed = 0;

    for (const link of links) {
      try {
        const tenantSummary = await withFirmTenant(this.db, firmId, link.tenantId, async (tx) => {
          // Explicit tenant_id filter in addition to the RLS gate.
          // withFirmTenant sets both app.firm_id and app.tenant_id;
          // under the firm-SELECT invoice branch (ADR-0003 option a)
          // a bare SELECT would also return rows from other tenants
          // linked to this firm. The explicit filter is defense in
          // depth so the per-tenant summary reflects exactly this
          // tenant's drafts.
          const drafts = await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.status, 'DRAFT'), eq(invoices.tenantId, link.tenantId)));
          const failures: ValidationPreviewPerTenant['failures'] = [];
          let passed = 0;
          let failed = 0;
          for (const inv of drafts) {
            const lines = await tx
              .select()
              .from(invoiceLines)
              .where(eq(invoiceLines.invoiceId, inv.id))
              .orderBy(invoiceLines.lineNo);
            // Compute totals from current line data so the preview
            // matches what issue() would see.
            const totals =
              lines.length > 0
                ? computeTotals(
                    lines.map<LineInput>((l) => ({
                      quantity: Number(l.quantity),
                      unitPrice: Number(l.unitPrice),
                      vatCategory: l.vatCategory,
                      vatRate: Number(l.vatRate),
                    })),
                  )
                : undefined;
            const result = await this.compliance.validate({ invoice: inv, lines, totals });
            if (result.ok) {
              passed++;
            } else {
              failed++;
              failures.push({
                invoiceId: inv.id,
                number: inv.number,
                errors: result.errors ?? ['unknown'],
              });
            }
          }
          return { totalDraft: drafts.length, passed, failed, failures };
        });
        perTenant.push({
          tenantId: link.tenantId,
          tenantName: link.tenantName,
          ...tenantSummary,
        });
        totalDraft += tenantSummary.totalDraft;
        totalPassed += tenantSummary.passed;
        totalFailed += tenantSummary.failed;
      } catch (err) {
        this.log.warn(
          `validateAllPending: tenant ${link.tenantId} scan failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        perTenant.push({
          tenantId: link.tenantId,
          tenantName: link.tenantName,
          totalDraft: 0,
          passed: 0,
          failed: 0,
          failures: [
            {
              invoiceId: '',
              number: '',
              errors: [`tenant scan failed: ${err instanceof Error ? err.message : String(err)}`],
            },
          ],
        });
      }
    }

    // Stable per-tenant order so the UI table doesn't shuffle between
    // polls.
    perTenant.sort((a, b) => a.tenantName.localeCompare(b.tenantName));

    return {
      summary: {
        tenantsScanned: links.length,
        totalDraft,
        totalPassed,
        totalFailed,
      },
      perTenant,
    };
  }

  /**
   * Produce one aggregated row per active client tenant for the firm,
   * covering invoices with issue_date in [periodStart, periodEnd]. Uses
   * the firm RLS SELECT branch (ADR-0003 option a) under withFirm, so a
   * single cross-tenant query handles the aggregation.
   *
   * Caveat on the tax base: for the MVP we treat (grand_total - vat_total)
   * as the taxable base. vat_breakdown holds the exact per-category split,
   * which a later version can expose as additional columns.
   */
  async exportVatReturnSummaries(
    firmId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<VatReturnRow[]> {
    // The `tenants` table's RLS policy requires a matching app.tenant_id,
    // so we cannot join across it from firm context. Instead we:
    //   1. Enumerate the firm's active client tenants (under app.firm_id)
    //   2. For each tenant, peek at the tenant row under app.tenant_id
    //      for name + vatin
    //   3. Run the invoice aggregate using the firm RLS SELECT branch
    //      (ADR-0003 option a) which restricts invoices to those in
    //      linked tenants. The legacy tenant_isolation policies now use
    //      the NULLIF cast (migration 1710001900000), so an unset
    //      app.tenant_id evaluates cleanly to NULL instead of throwing.
    return withFirm(this.db, firmId, async (tx) => {
      const links = await tx
        .select({ tenantId: firmClientTenants.tenantId })
        .from(firmClientTenants)
        .where(and(eq(firmClientTenants.firmId, firmId), isNull(firmClientTenants.revokedAt)));
      if (links.length === 0) return [];

      // Legacy-policy NULLIF retrofit landed; sentinel no longer needed (see migration 1710001900000)
      const aggResult = await tx.execute(sql`
        SELECT
          tenant_id,
          COUNT(id)::int AS invoice_count,
          COALESCE(SUM(grand_total - vat_total), 0)::text AS total_taxable_omr,
          COALESCE(SUM(vat_total), 0)::text AS total_vat_omr,
          COALESCE(SUM(grand_total), 0)::text AS net_omr
        FROM invoices
        WHERE issue_date BETWEEN ${periodStart}::date AND ${periodEnd}::date
          AND status IN ('VALIDATED', 'SIGNED', 'ISSUED', 'CLEARED')
        GROUP BY tenant_id
      `);
      const aggByTenant = new Map<
        string,
        {
          invoice_count: number;
          total_taxable_omr: string;
          total_vat_omr: string;
          net_omr: string;
        }
      >();
      for (const r of aggResult.rows as Array<{
        tenant_id: string;
        invoice_count: number;
        total_taxable_omr: string;
        total_vat_omr: string;
        net_omr: string;
      }>) {
        aggByTenant.set(r.tenant_id, r);
      }

      // Pick up the tenant name + vatin one tenant at a time -- only
      // one SELECT per linked tenant, which the target persona scale
      // (dozens, not thousands) handles comfortably.
      const out: VatReturnRow[] = [];
      for (const link of links) {
        await tx.execute(sql`select set_config('app.tenant_id', ${link.tenantId}, true)`);
        const tRows = await tx
          .select({ name: tenants.name, vatin: tenants.vatin })
          .from(tenants)
          .where(eq(tenants.id, link.tenantId))
          .limit(1);
        const tInfo = tRows[0];
        if (!tInfo) continue;
        const agg = aggByTenant.get(link.tenantId);
        out.push({
          tenantId: link.tenantId,
          tenantName: tInfo.name,
          vatin: tInfo.vatin ?? null,
          invoiceCount: Number(agg?.invoice_count ?? 0),
          totalTaxableOmr: String(agg?.total_taxable_omr ?? '0'),
          totalVatOmr: String(agg?.total_vat_omr ?? '0'),
          netOmr: String(agg?.net_omr ?? '0'),
        });
      }
      // Legacy-policy NULLIF retrofit landed; sentinel no longer needed (see migration 1710001900000)
      out.sort((a, b) => a.tenantName.localeCompare(b.tenantName));
      return out;
    });
  }

  /**
   * Render a VAT return row set as RFC 4180 CSV.
   *
   * Static method so controllers can call it without pulling in the full
   * BatchOperationsService dependency graph for unit tests.
   */
  static renderVatReturnCsv(rows: VatReturnRow[]): string {
    const header = [
      'tenantId',
      'tenantName',
      'vatin',
      'invoiceCount',
      'totalTaxableOmr',
      'totalVatOmr',
      'netOmr',
    ];
    const body = rows.map((r) =>
      [
        r.tenantId,
        r.tenantName,
        r.vatin ?? '',
        String(r.invoiceCount),
        r.totalTaxableOmr,
        r.totalVatOmr,
        r.netOmr,
      ]
        .map(csvEscape)
        .join(','),
    );
    return [header.join(','), ...body].join('\n') + '\n';
  }
}

function csvEscape(v: string): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
