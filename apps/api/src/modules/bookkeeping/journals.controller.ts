import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { JournalsService } from './journals.service';
import { CreateJournalDto } from './dto/create-journal.dto';

@Controller('journals')
@UseGuards(TenantGuard)
export class JournalsController {
  constructor(private readonly journals: JournalsService) {}
  @Get() list(@CurrentUser() u: AuthContext) {
    return this.journals.list(u.tenantId);
  }
  @Post() create(@CurrentUser() u: AuthContext, @Body() dto: CreateJournalDto) {
    return this.journals.postManual(u.tenantId, dto);
  }
  @Get(':id') get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.journals.get(u.tenantId, id);
  }
}
