import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { SupplierBillsService } from './supplier-bills.service';
import { CreateSupplierBillDto } from './dto/create-supplier-bill.dto';

@Controller('supplier-bills')
@UseGuards(TenantGuard)
export class SupplierBillsController {
  constructor(private readonly bills: SupplierBillsService) {}
  @Get() list(@CurrentUser() u: AuthContext) {
    return this.bills.list(u.tenantId);
  }
  @Post() create(@CurrentUser() u: AuthContext, @Body() dto: CreateSupplierBillDto) {
    return this.bills.create(u.tenantId, dto);
  }
  @Get(':id') get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.bills.get(u.tenantId, id);
  }
}
