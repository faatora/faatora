import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { payments } from '../../db/schema/bookkeeping';
import type { CreatePaymentDto } from './dto/create-payment.dto';

@Injectable()
export class PaymentsService {
  constructor(@Inject(DB) private readonly db: Database) {}
  create(tenantId: string, dto: CreatePaymentDto) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(payments)
        .values({
          tenantId,
          direction: dto.direction,
          date: dto.date,
          amount: dto.amount.toFixed(3),
          method: dto.method,
          partyId: dto.partyId,
          invoiceId: dto.invoiceId,
          billId: dto.billId,
          memo: dto.memo,
        })
        .returning();
      return row;
    });
  }
  list(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(payments).orderBy(desc(payments.date), desc(payments.createdAt)),
    );
  }
  get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(payments).where(eq(payments.id, id)).limit(1);
      if (!row) throw new NotFoundException('Payment not found');
      return row;
    });
  }
}
