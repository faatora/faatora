import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Controller('pos/products')
@UseGuards(TenantGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get() list(@CurrentUser() u: AuthContext) {
    return this.products.list(u.tenantId);
  }

  @Post() create(@CurrentUser() u: AuthContext, @Body() dto: CreateProductDto) {
    return this.products.create(u.tenantId, dto);
  }

  @Get('lookup') lookup(
    @CurrentUser() u: AuthContext,
    @Query('barcode') barcode?: string,
    @Query('sku') sku?: string,
  ) {
    if (barcode) return this.products.findByBarcode(u.tenantId, barcode);
    if (sku) return this.products.findBySku(u.tenantId, sku);
    return null;
  }

  @Get(':id') get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.products.get(u.tenantId, id);
  }

  @Patch(':id') update(
    @CurrentUser() u: AuthContext,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(u.tenantId, id, dto);
  }

  @Post(':id/archive') archive(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.products.archive(u.tenantId, id);
  }
}
