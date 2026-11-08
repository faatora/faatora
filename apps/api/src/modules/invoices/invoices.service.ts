import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { invoices, invoiceLines, parties } from '../../db/schema/invoicing';
import { computeTotals, type LineInput } from './money';
import { COMPLIANCE_VALIDATOR, type ComplianceValidator } from './compliance.port';
import type { CreateInvoiceDto } from './dto/create-invoice.dto';
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(COMPLIANCE_VALIDATOR) private readonly compliance: ComplianceValidator,
  ) {}
  create(tenantId: string, userId: string, dto: CreateInvoiceDto) {
    const totals = computeTotals(
      dto.lines.map<LineInput>((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        vatCategory: l.vatCategory ?? 'S',
        vatRate: l.vatRate ?? 5,
      })),
    );
    return withTenant(this.db, tenantId, async (tx) => {
      const ids = [dto.supplierPartyId, dto.buyerPartyId];
      const visible = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(inArray(parties.id, ids));
      const seen = new Set(visible.map((p) => p.id));
      if (!seen.has(dto.supplierPartyId) || !seen.has(dto.buyerPartyId)) {
        throw new BadRequestException(
          'supplierPartyId and buyerPartyId must be parties in this tenant',
        );
      }
      const [invoice] = await tx
        .insert(invoices)
        .values({
          tenantId,
          type: dto.type ?? 'invoice',
          number: dto.number,
          issueDate: dto.issueDate,
          supplierPartyId: dto.supplierPartyId,
          buyerPartyId: dto.buyerPartyId,
          currency: dto.currency ?? 'OMR',
          notes: dto.notes,
          createdBy: userId,
          subtotal: totals.subtotal.toFixed(3),
          vatTotal: totals.vatTotal.toFixed(3),
          grandTotal: totals.grandTotal.toFixed(3),
          vatBreakdown: totals.vatBreakdown,
        })
        .returning();
      const lineRows = dto.lines.map((l, i) => ({
        tenantId,
        invoiceId: invoice.id,
        lineNo: i + 1,
        description: l.description,
        quantity: l.quantity.toFixed(3),
        unitCode: l.unitCode ?? 'C62',
        unitPrice: l.unitPrice.toFixed(3),
        vatCategory: l.vatCategory ?? 'S',
        vatRate: (l.vatRate ?? 5).toFixed(2),
        lineNet: totals.lineNets[i].toFixed(3),
      }));
      await tx.insert(invoiceLines).values(lineRows);
      return { ...invoice, lines: lineRows };
    });
  }
  list(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(invoices).orderBy(desc(invoices.createdAt)),
    );
  }
  get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
      if (!invoice) throw new NotFoundException('Invoice not found');
      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(invoiceLines.lineNo);
      return { ...invoice, lines };
    });
  }
  issue(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status !== 'DRAFT')
        throw new BadRequestException(`Only DRAFT can be issued (status=${invoice.status})`);
      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(invoiceLines.lineNo);
      if (lines.length === 0) throw new BadRequestException('Invoice has no lines');
      const totals = computeTotals(
        lines.map<LineInput>((l) => ({
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          vatCategory: l.vatCategory,
          vatRate: Number(l.vatRate),
        })),
      );
      const result = await this.compliance.validate({ invoice, lines, totals });
      if (!result.ok)
        throw new UnprocessableEntityException({
          message: 'Compliance validation failed',
          errors: result.errors,
        });
      const [updated] = await tx
        .update(invoices)
        .set({
          status: 'VALIDATED',
          subtotal: totals.subtotal.toFixed(3),
          vatTotal: totals.vatTotal.toFixed(3),
          grandTotal: totals.grandTotal.toFixed(3),
          vatBreakdown: totals.vatBreakdown,
          rulePackVersion: result.rulePackVersion ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(invoices.id, id), eq(invoices.status, 'DRAFT')))
        .returning();
      return updated;
    });
  }
}
