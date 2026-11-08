import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
@Controller('invoices')
@UseGuards(TenantGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}
  @Post() create(@CurrentUser() u: AuthContext, @Body() dto: CreateInvoiceDto) {
    return this.invoices.create(u.tenantId, u.userId, dto);
  }
  @Get() list(@CurrentUser() u: AuthContext) {
    return this.invoices.list(u.tenantId);
  }
  @Get(':id') get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.invoices.get(u.tenantId, id);
  }
  @Post(':id/issue') issue(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.invoices.issue(u.tenantId, id);
  }
}
