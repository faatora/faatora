import { Module } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import { MeController } from './me.controller';
import { AuthController } from './auth.controller';
import { CognitoAuthService } from './cognito-auth.service';
import { ClearTaxPartnerGuard } from './cleartax-partner.guard';
@Module({
  controllers: [MeController, AuthController],
  providers: [TenantGuard, ClearTaxPartnerGuard, CognitoAuthService],
  exports: [ClearTaxPartnerGuard, CognitoAuthService],
})
export class AuthModule {}
