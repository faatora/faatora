import { Inject, Injectable } from '@nestjs/common';
import { DB, type Database } from '../../db/db.module';
import { leads } from '../../db/schema/leads';
import { assessReadiness, type ReadinessVerdict } from './readiness';
import type { CreateLeadDto } from './dto/create-lead.dto';
@Injectable()
export class LeadsService {
  constructor(@Inject(DB) private readonly db: Database) {}
  async create(
    dto: CreateLeadDto,
    ip?: string,
  ): Promise<{ id: string; verdict: ReadinessVerdict }> {
    const verdict = assessReadiness(dto);
    const [row] = await this.db
      .insert(leads)
      .values({
        email: dto.email,
        fullName: dto.fullName,
        companyName: dto.companyName,
        phone: dto.phone,
        revenueBand: dto.revenueBand,
        currentTool: dto.currentTool,
        invoiceVolumeBand: dto.invoiceVolumeBand,
        b2cShare: dto.b2cShare,
        erp: dto.erp,
        vatRegistered: dto.vatRegistered,
        verdict,
        ip,
      })
      .returning({ id: leads.id });
    return { id: row.id, verdict };
  }
}
