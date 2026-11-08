import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { accounts, journals, journalLines, supplierBills } from '../../db/schema/bookkeeping';
import { invoices, invoiceLines } from '../../db/schema/invoicing';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
}

async function trialBalanceInternal(tx: Tx, asOfDate?: string): Promise<TrialBalanceRow[]> {
  const conds = [eq(journals.posted, true)];
  if (asOfDate) conds.push(lte(journals.entryDate, asOfDate));
  const rows = await tx
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)::text`,
      credit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)::text`,
    })
    .from(accounts)
    .leftJoin(journalLines, eq(journalLines.accountId, accounts.id))
    .leftJoin(journals, and(eq(journals.id, journalLines.journalId), ...conds))
    .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
    .orderBy(accounts.code);
  return rows.map((r) => ({
    accountId: r.accountId,
    code: r.code,
    name: r.name,
    type: r.type,
    debit: Number(r.debit),
    credit: Number(r.credit),
  }));
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  trialBalance(tenantId: string, asOfDate?: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await trialBalanceInternal(tx, asOfDate);
      const totals = rows.reduce(
        (acc, r) => {
          acc.debit += r.debit;
          acc.credit += r.credit;
          return acc;
        },
        { debit: 0, credit: 0 },
      );
      return { asOf: asOfDate ?? null, rows, totals };
    });
  }

  profitAndLoss(tenantId: string, from: string, to: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          accountId: accounts.id,
          code: accounts.code,
          name: accounts.name,
          type: accounts.type,
          debit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)::text`,
          credit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)::text`,
        })
        .from(accounts)
        .leftJoin(journalLines, eq(journalLines.accountId, accounts.id))
        .leftJoin(
          journals,
          and(
            eq(journals.id, journalLines.journalId),
            eq(journals.posted, true),
            gte(journals.entryDate, from),
            lte(journals.entryDate, to),
          ),
        )
        .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
        .orderBy(accounts.code);

      const income: { accountId: string; code: string; name: string; amount: number }[] = [];
      const expense: { accountId: string; code: string; name: string; amount: number }[] = [];
      let totalIncome = 0;
      let totalExpense = 0;
      for (const r of rows) {
        const debit = Number(r.debit);
        const credit = Number(r.credit);
        if (r.type === 'income') {
          const amount = credit - debit;
          income.push({ accountId: r.accountId, code: r.code, name: r.name, amount });
          totalIncome += amount;
        } else if (r.type === 'expense') {
          const amount = debit - credit;
          expense.push({ accountId: r.accountId, code: r.code, name: r.name, amount });
          totalExpense += amount;
        }
      }
      return {
        from,
        to,
        income,
        expense,
        totalIncome,
        totalExpense,
        netProfit: totalIncome - totalExpense,
      };
    });
  }

  balanceSheet(tenantId: string, asOfDate?: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await trialBalanceInternal(tx, asOfDate);
      const bucket = {
        asset: [] as { accountId: string; code: string; name: string; balance: number }[],
        liability: [] as { accountId: string; code: string; name: string; balance: number }[],
        equity: [] as { accountId: string; code: string; name: string; balance: number }[],
      };
      let totalAssets = 0;
      let totalLiabilities = 0;
      let totalEquity = 0;
      let retainedProfit = 0;
      for (const r of rows) {
        if (r.type === 'asset') {
          const bal = r.debit - r.credit;
          bucket.asset.push({ accountId: r.accountId, code: r.code, name: r.name, balance: bal });
          totalAssets += bal;
        } else if (r.type === 'liability') {
          const bal = r.credit - r.debit;
          bucket.liability.push({
            accountId: r.accountId,
            code: r.code,
            name: r.name,
            balance: bal,
          });
          totalLiabilities += bal;
        } else if (r.type === 'equity') {
          const bal = r.credit - r.debit;
          bucket.equity.push({ accountId: r.accountId, code: r.code, name: r.name, balance: bal });
          totalEquity += bal;
        } else if (r.type === 'income') {
          retainedProfit += r.credit - r.debit;
        } else if (r.type === 'expense') {
          retainedProfit -= r.debit - r.credit;
        }
      }
      return {
        asOf: asOfDate ?? null,
        assets: bucket.asset,
        liabilities: bucket.liability,
        equity: bucket.equity,
        retainedProfit,
        totalAssets,
        totalLiabilities,
        totalEquity: totalEquity + retainedProfit,
      };
    });
  }

  vatReturn(tenantId: string, from: string, to: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      // Output VAT: aggregated from issued invoices (status in VALIDATED/ISSUED/PAID)
      // and broken down by vat_category on line level.
      const invLines = await tx
        .select({
          vatCategory: invoiceLines.vatCategory,
          vatRate: invoiceLines.vatRate,
          lineNet: invoiceLines.lineNet,
          issueDate: invoices.issueDate,
          status: invoices.status,
        })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .where(and(gte(invoices.issueDate, from), lte(invoices.issueDate, to)));

      let outputStandardNet = 0;
      let outputStandardVat = 0;
      let outputZeroNet = 0;
      let outputExemptNet = 0;
      for (const l of invLines) {
        if (l.status === 'DRAFT' || l.status === 'CANCELLED') continue;
        const net = Number(l.lineNet);
        const rate = Number(l.vatRate);
        if (l.vatCategory === 'Z') outputZeroNet += net;
        else if (l.vatCategory === 'E') outputExemptNet += net;
        else {
          outputStandardNet += net;
          outputStandardVat += (net * rate) / 100;
        }
      }

      // Input VAT: from posted supplier bills in range.
      const bills = await tx
        .select({
          subtotal: supplierBills.subtotal,
          vatTotal: supplierBills.vatTotal,
          status: supplierBills.status,
        })
        .from(supplierBills)
        .where(and(gte(supplierBills.issueDate, from), lte(supplierBills.issueDate, to)));
      let inputTotal = 0;
      let inputNet = 0;
      for (const b of bills) {
        if (b.status === 'DRAFT' || b.status === 'CANCELLED') continue;
        inputTotal += Number(b.vatTotal);
        inputNet += Number(b.subtotal);
      }

      return {
        from,
        to,
        outputStandard: { net: outputStandardNet, vat: outputStandardVat },
        outputZero: { net: outputZeroNet, vat: 0 },
        outputExempt: { net: outputExemptNet, vat: 0 },
        inputTotal,
        inputNet,
        netVatPayable: outputStandardVat - inputTotal,
      };
    });
  }
}
