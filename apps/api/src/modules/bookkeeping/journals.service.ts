import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import {
  accounts,
  journals,
  journalLines,
  supplierBills,
  payments,
} from '../../db/schema/bookkeeping';
import { invoices, invoiceLines } from '../../db/schema/invoicing';
import { ACCOUNT_CODES, SALES_ACCOUNT_BY_VAT_CATEGORY } from './omani-sme-coa';
import type { CreateJournalDto } from './dto/create-journal.dto';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

interface LineInsert {
  accountId: string;
  debit: number;
  credit: number;
  description?: string;
}

const EPSILON = 0.0005; // < half a fils

async function findAccountIdsByCode(tx: Tx, codes: string[]): Promise<Record<string, string>> {
  if (codes.length === 0) return {};
  const rows = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(inArray(accounts.code, codes));
  const map: Record<string, string> = {};
  for (const r of rows) map[r.code] = r.id;
  return map;
}

async function insertJournal(
  tx: Tx,
  tenantId: string,
  input: {
    entryDate: string;
    memo?: string;
    source: 'invoice' | 'bill' | 'payment' | 'adjustment';
    sourceId?: string;
    lines: LineInsert[];
  },
) {
  const totalDebit = input.lines.reduce((a, l) => a + l.debit, 0);
  const totalCredit = input.lines.reduce((a, l) => a + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > EPSILON)
    throw new BadRequestException(
      `Journal is not balanced: debits=${totalDebit.toFixed(3)} credits=${totalCredit.toFixed(3)}`,
    );
  if (input.lines.length < 2) throw new BadRequestException('Journal requires at least 2 lines');
  const [journal] = await tx
    .insert(journals)
    .values({
      tenantId,
      entryDate: input.entryDate,
      memo: input.memo,
      source: input.source,
      sourceId: input.sourceId,
      posted: true,
      postedAt: new Date(),
    })
    .returning();
  const lineRows = input.lines.map((l, i) => ({
    tenantId,
    journalId: journal.id,
    lineNo: i + 1,
    accountId: l.accountId,
    debit: l.debit.toFixed(3),
    credit: l.credit.toFixed(3),
    description: l.description,
  }));
  await tx.insert(journalLines).values(lineRows);
  return { ...journal, lines: lineRows };
}

@Injectable()
export class JournalsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  list(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(journals).orderBy(desc(journals.entryDate), desc(journals.createdAt)),
    );
  }

  get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [j] = await tx.select().from(journals).where(eq(journals.id, id)).limit(1);
      if (!j) throw new NotFoundException('Journal not found');
      const lines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalId, id))
        .orderBy(journalLines.lineNo);
      return { ...j, lines };
    });
  }

  postManual(tenantId: string, dto: CreateJournalDto) {
    for (const l of dto.lines) {
      if (l.debit > 0 && l.credit > 0)
        throw new BadRequestException('A line cannot have both debit and credit > 0');
      if (l.debit < 0 || l.credit < 0)
        throw new BadRequestException('Debit/credit cannot be negative');
    }
    return withTenant(this.db, tenantId, async (tx) => {
      const accountIds = Array.from(new Set(dto.lines.map((l) => l.accountId)));
      const visible = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(inArray(accounts.id, accountIds));
      if (visible.length !== accountIds.length)
        throw new BadRequestException('One or more accounts are not visible in this tenant');
      return insertJournal(tx, tenantId, {
        entryDate: dto.entryDate,
        memo: dto.memo,
        source: 'adjustment',
        lines: dto.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
        })),
      });
    });
  }

  postInvoiceIssued(tenantId: string, invoiceId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
      if (!invoice) throw new NotFoundException('Invoice not found');
      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId));
      if (lines.length === 0) throw new BadRequestException('Invoice has no lines');

      // Aggregate net by sales account code based on vat category.
      const netByCode: Record<string, number> = {};
      let vatOutput = 0;
      for (const l of lines) {
        const code = SALES_ACCOUNT_BY_VAT_CATEGORY[l.vatCategory] ?? ACCOUNT_CODES.SALES_STANDARD;
        const net = Number(l.lineNet);
        netByCode[code] = (netByCode[code] ?? 0) + net;
        const rate = Number(l.vatRate);
        vatOutput += (net * rate) / 100;
      }
      // Use VAT total from invoice header if close; prefer invoice header for consistency.
      const headerVat = Number(invoice.vatTotal);
      if (Math.abs(headerVat - vatOutput) <= EPSILON) vatOutput = headerVat;

      const needed = [ACCOUNT_CODES.AR, ACCOUNT_CODES.VAT_OUTPUT, ...Object.keys(netByCode)];
      const codeMap = await findAccountIdsByCode(tx, Array.from(new Set(needed)));
      if (!codeMap[ACCOUNT_CODES.AR])
        throw new BadRequestException(
          `Chart of Accounts missing account ${ACCOUNT_CODES.AR} (AR); seed CoA first`,
        );
      for (const c of Object.keys(netByCode)) {
        if (!codeMap[c])
          throw new BadRequestException(
            `Chart of Accounts missing sales account ${c}; seed CoA first`,
          );
      }
      if (vatOutput > EPSILON && !codeMap[ACCOUNT_CODES.VAT_OUTPUT])
        throw new BadRequestException(
          `Chart of Accounts missing VAT Payable account ${ACCOUNT_CODES.VAT_OUTPUT}`,
        );

      const grandTotal = Number(invoice.grandTotal);
      const journalLinesInput: LineInsert[] = [
        {
          accountId: codeMap[ACCOUNT_CODES.AR],
          debit: grandTotal,
          credit: 0,
          description: `AR for invoice ${invoice.number}`,
        },
      ];
      for (const [code, net] of Object.entries(netByCode)) {
        if (net <= 0) continue;
        journalLinesInput.push({
          accountId: codeMap[code],
          debit: 0,
          credit: net,
          description: `Sales ${code}`,
        });
      }
      if (vatOutput > EPSILON) {
        journalLinesInput.push({
          accountId: codeMap[ACCOUNT_CODES.VAT_OUTPUT],
          debit: 0,
          credit: vatOutput,
          description: 'VAT output',
        });
      }
      return insertJournal(tx, tenantId, {
        entryDate: invoice.issueDate,
        memo: `Invoice ${invoice.number} issued`,
        source: 'invoice',
        sourceId: invoice.id,
        lines: journalLinesInput,
      });
    });
  }

  postPaymentReceived(tenantId: string, paymentId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.direction !== 'in')
        throw new BadRequestException('Payment direction must be "in"');
      const cashCode = payment.method === 'cash' ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.BANK;
      const codeMap = await findAccountIdsByCode(tx, [cashCode, ACCOUNT_CODES.AR]);
      if (!codeMap[cashCode] || !codeMap[ACCOUNT_CODES.AR])
        throw new BadRequestException(
          `Chart of Accounts missing accounts (${cashCode} or ${ACCOUNT_CODES.AR}); seed CoA first`,
        );
      const amount = Number(payment.amount);
      return insertJournal(tx, tenantId, {
        entryDate: payment.date,
        memo: `Payment received`,
        source: 'payment',
        sourceId: payment.id,
        lines: [
          {
            accountId: codeMap[cashCode],
            debit: amount,
            credit: 0,
            description: `Receipt via ${payment.method}`,
          },
          {
            accountId: codeMap[ACCOUNT_CODES.AR],
            debit: 0,
            credit: amount,
            description: 'Clear AR',
          },
        ],
      });
    });
  }

  postBillReceived(tenantId: string, billId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [bill] = await tx
        .select()
        .from(supplierBills)
        .where(eq(supplierBills.id, billId))
        .limit(1);
      if (!bill) throw new NotFoundException('Supplier bill not found');
      const codeMap = await findAccountIdsByCode(tx, [
        ACCOUNT_CODES.OTHER_EXPENSE,
        ACCOUNT_CODES.VAT_INPUT,
        ACCOUNT_CODES.AP,
      ]);
      if (!codeMap[ACCOUNT_CODES.OTHER_EXPENSE] || !codeMap[ACCOUNT_CODES.AP])
        throw new BadRequestException('Chart of Accounts missing expense/AP accounts');
      const subtotal = Number(bill.subtotal);
      const vat = Number(bill.vatTotal);
      const grand = Number(bill.grandTotal);
      const lines: LineInsert[] = [
        {
          accountId: codeMap[ACCOUNT_CODES.OTHER_EXPENSE],
          debit: subtotal,
          credit: 0,
          description: `Bill ${bill.number} - expense`,
        },
      ];
      if (vat > EPSILON) {
        if (!codeMap[ACCOUNT_CODES.VAT_INPUT])
          throw new BadRequestException(
            `Chart of Accounts missing VAT Recoverable ${ACCOUNT_CODES.VAT_INPUT}`,
          );
        lines.push({
          accountId: codeMap[ACCOUNT_CODES.VAT_INPUT],
          debit: vat,
          credit: 0,
          description: 'VAT recoverable',
        });
      }
      lines.push({
        accountId: codeMap[ACCOUNT_CODES.AP],
        debit: 0,
        credit: grand,
        description: `AP for bill ${bill.number}`,
      });
      return insertJournal(tx, tenantId, {
        entryDate: bill.issueDate,
        memo: `Bill ${bill.number} received`,
        source: 'bill',
        sourceId: bill.id,
        lines,
      });
    });
  }

  postPaymentPaid(tenantId: string, paymentId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.direction !== 'out')
        throw new BadRequestException('Payment direction must be "out"');
      const cashCode = payment.method === 'cash' ? ACCOUNT_CODES.CASH : ACCOUNT_CODES.BANK;
      const codeMap = await findAccountIdsByCode(tx, [cashCode, ACCOUNT_CODES.AP]);
      if (!codeMap[cashCode] || !codeMap[ACCOUNT_CODES.AP])
        throw new BadRequestException(
          `Chart of Accounts missing accounts (${cashCode} or ${ACCOUNT_CODES.AP}); seed CoA first`,
        );
      const amount = Number(payment.amount);
      return insertJournal(tx, tenantId, {
        entryDate: payment.date,
        memo: `Payment paid`,
        source: 'payment',
        sourceId: payment.id,
        lines: [
          {
            accountId: codeMap[ACCOUNT_CODES.AP],
            debit: amount,
            credit: 0,
            description: 'Clear AP',
          },
          {
            accountId: codeMap[cashCode],
            debit: 0,
            credit: amount,
            description: `Paid via ${payment.method}`,
          },
        ],
      });
    });
  }
}
