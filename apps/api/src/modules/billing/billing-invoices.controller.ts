import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { BillingService } from './billing.service';

@Controller('billing/invoices')
@UseGuards(TenantGuard)
export class BillingInvoicesController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  list(@CurrentUser() u: AuthContext) {
    return this.billing.list(u.tenantId);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.billing.get(u.tenantId, id);
  }

  // NOTE (Wave 2): admin-only in a later wave; for now any tenant member can call it.
  // Real path will be via Thawani webhook → PaymentProvider.markPaid → BillingService.markPaid.
  @Post(':id/mark-paid')
  markPaid(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.billing.markPaid(u.tenantId, id);
  }
}
