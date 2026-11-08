import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { PartiesService } from './parties.service';
import { CreatePartyDto } from './dto/create-party.dto';
@Controller('parties')
@UseGuards(TenantGuard)
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}
  @Post() create(@CurrentUser() u: AuthContext, @Body() dto: CreatePartyDto) {
    return this.parties.create(u.tenantId, dto);
  }
  @Get() list(@CurrentUser() u: AuthContext) {
    return this.parties.list(u.tenantId);
  }
  @Get(':id') get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.parties.get(u.tenantId, id);
  }
}
