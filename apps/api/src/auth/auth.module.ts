import { Module } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import { MeController } from './me.controller';
import { ClearTaxPartnerGuard } from './cleartax-partner.guard';
@Module({
  controllers: [MeController],
  providers: [TenantGuard, ClearTaxPartnerGuard],
  exports: [ClearTaxPartnerGuard],
})
export class AuthModule {}
