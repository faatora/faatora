import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ReportsService } from './reports.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(name: string, value: string | undefined) {
  if (value === undefined) return;
  if (!DATE_RE.test(value)) throw new BadRequestException(`${name} must be YYYY-MM-DD`);
}
function requireDate(name: string, value: string | undefined): string {
  if (!value) throw new BadRequestException(`${name} is required (YYYY-MM-DD)`);
  if (!DATE_RE.test(value)) throw new BadRequestException(`${name} must be YYYY-MM-DD`);
  return value;
}

@Controller('reports')
@UseGuards(TenantGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Get('trial-balance') trialBalance(@CurrentUser() u: AuthContext, @Query('asOf') asOf?: string) {
    assertDate('asOf', asOf);
    return this.reports.trialBalance(u.tenantId, asOf);
  }
  @Get('pnl') pnl(
    @CurrentUser() u: AuthContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.profitAndLoss(u.tenantId, requireDate('from', from), requireDate('to', to));
  }
  @Get('balance-sheet') balanceSheet(@CurrentUser() u: AuthContext, @Query('asOf') asOf?: string) {
    assertDate('asOf', asOf);
    return this.reports.balanceSheet(u.tenantId, asOf);
  }
  @Get('vat-return') vatReturn(
    @CurrentUser() u: AuthContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.vatReturn(u.tenantId, requireDate('from', from), requireDate('to', to));
  }
}
