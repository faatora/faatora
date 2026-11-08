import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';

@Controller('accounts')
@UseGuards(TenantGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}
  @Get() list(@CurrentUser() u: AuthContext) {
    return this.accounts.list(u.tenantId);
  }
  @Post() create(@CurrentUser() u: AuthContext, @Body() dto: CreateAccountDto) {
    return this.accounts.create(u.tenantId, dto);
  }
  @Post('seed') seed(@CurrentUser() u: AuthContext) {
    return this.accounts.seedCoa(u.tenantId);
  }
  @Get(':id') get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.accounts.get(u.tenantId, id);
  }
}
