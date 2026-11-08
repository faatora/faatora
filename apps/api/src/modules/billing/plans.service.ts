import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { plans } from '../../db/schema/billing';

@Injectable()
export class PlansService {
  constructor(@Inject(DB) private readonly db: Database) {}

  list() {
    return this.db.select().from(plans).where(eq(plans.archived, false)).orderBy(plans.monthlyFee);
  }

  async getByCode(code: string) {
    const [row] = await this.db
      .select()
      .from(plans)
      .where(and(eq(plans.code, code), eq(plans.archived, false)))
      .limit(1);
    if (!row) throw new NotFoundException(`Plan not found: ${code}`);
    return row;
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(plans).where(eq(plans.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Plan not found: ${id}`);
    return row;
  }
}
