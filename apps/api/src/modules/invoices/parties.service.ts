import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { parties } from '../../db/schema/invoicing';
import type { CreatePartyDto } from './dto/create-party.dto';
@Injectable()
export class PartiesService {
  constructor(@Inject(DB) private readonly db: Database) {}
  create(tenantId: string, dto: CreatePartyDto) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(parties)
        .values({
          tenantId,
          kind: dto.kind ?? 'customer',
          name: dto.name,
          vatin: dto.vatin,
          country: dto.country ?? 'OM',
          address: dto.address,
          peppolId: dto.peppolId,
        })
        .returning();
      return row;
    });
  }
  list(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(parties).orderBy(desc(parties.createdAt)),
    );
  }
  get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx.select().from(parties).where(eq(parties.id, id)).limit(1);
      if (!row) throw new NotFoundException('Party not found');
      return row;
    });
  }
}
