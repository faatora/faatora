import { Module } from '@nestjs/common';
import { AccountantController } from './accountant.controller';
import { AccountantService } from './accountant.service';
import { AccountantAuthGuard } from './accountant-auth.guard';

@Module({
  controllers: [AccountantController],
  providers: [AccountantService, AccountantAuthGuard],
  exports: [AccountantService],
})
export class AccountantModule {}
