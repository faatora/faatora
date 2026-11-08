import { Module } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import { MeController } from './me.controller';
@Module({ controllers: [MeController], providers: [TenantGuard] })
export class AuthModule {}
