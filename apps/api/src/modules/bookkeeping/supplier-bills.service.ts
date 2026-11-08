import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { supplierBills } from '../../db/schema/bookkeeping';
import type { CreateSupplierBillDto } from './dto/create-supplier-bill.dto';

@Injectable()
export class SupplierBillsService {
  constructor(@Inject(DB) private readonly db: Database) {}
  create(tenantId: string, dto: CreateSupplierBillDto) {
    const subtotal = dto.subtotal ?? 0;
    const vatTotal = dto.vatTotal ?? 0;
    const grandTotal = dto.grandTotal ?? subtotal + vatTotal;
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(supplierBills)
        .values({
          tenantId,
          supplierPartyId: dto.supplierPartyId,
          number: dto.number,
          issueDate: dto.issueDate,
          dueDate: dto.dueDate,
          currency: dto.currency ?? 'OMR',
          subtotal: subtotal.toFixed(3),
          vatTotal: vatTotal.toFixed(3),
          grandTotal: grandTotal.toFixed(3),
        })
        .returning();
      return row;
    });
  }
  list(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(supplierBills).orderBy(desc(supplierBills.createdAt)),
    );
  }
  get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(supplierBills).where(eq(supplierBills.id, id)).limit(1);
      if (!row) throw new NotFoundException('Supplier bill not found');
      return row;
    });
  }
}
