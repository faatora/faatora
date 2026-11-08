import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { BatchDto } from './dto/batch.dto';

@Controller('pos/sales')
@UseGuards(TenantGuard)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get() list(
    @CurrentUser() u: AuthContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    return this.sales.list(u.tenantId, { from, to, status });
  }

  @Post() create(@CurrentUser() u: AuthContext, @Body() dto: CreateSaleDto) {
    return this.sales.createSale(u.tenantId, u.userId, dto);
  }

  @Post('batch') batch(@CurrentUser() u: AuthContext, @Body() dto: BatchDto) {
    return this.sales.batchPendingToInvoice(u.tenantId, dto.cutoffAt);
  }

  @Get('reports/z') zReport(@CurrentUser() u: AuthContext, @Query('date') date: string) {
    return this.sales.endOfDayReport(u.tenantId, date);
  }

  @Get(':id') get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.sales.get(u.tenantId, id);
  }
}
