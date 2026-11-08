import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { accounts } from '../../db/schema/bookkeeping';
import { OMANI_SME_COA } from './omani-sme-coa';
import type { CreateAccountDto } from './dto/create-account.dto';

@Injectable()
export class AccountsService {
  constructor(@Inject(DB) private readonly db: Database) {}
  seedCoa(tenantId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const existing = await tx.select({ id: accounts.id }).from(accounts).limit(1);
      if (existing.length > 0) return { seeded: false, inserted: 0 };
      const rows = OMANI_SME_COA.map((a) => ({
        tenantId,
        code: a.code,
        name: a.name,
        type: a.type,
        isVatOutput: a.isVatOutput ?? false,
        isVatInput: a.isVatInput ?? false,
      }));
      await tx.insert(accounts).values(rows);
      return { seeded: true, inserted: rows.length };
    });
  }
  list(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(accounts).orderBy(asc(accounts.code)),
    );
  }
  get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(accounts).where(eq(accounts.id, id)).limit(1);
      if (!row) throw new NotFoundException('Account not found');
      return row;
    });
  }
  create(tenantId: string, dto: CreateAccountDto) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(accounts)
        .values({
          tenantId,
          code: dto.code,
          name: dto.name,
          type: dto.type,
          parentId: dto.parentId,
          isVatOutput: dto.isVatOutput ?? false,
          isVatInput: dto.isVatInput ?? false,
        })
        .returning();
      return row;
    });
  }
}
