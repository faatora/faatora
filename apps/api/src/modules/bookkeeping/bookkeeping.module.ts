import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { JournalsController } from './journals.controller';
import { JournalsService } from './journals.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SupplierBillsController } from './supplier-bills.controller';
import { SupplierBillsService } from './supplier-bills.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [
    AccountsController,
    JournalsController,
    ReportsController,
    SupplierBillsController,
    PaymentsController,
  ],
  providers: [
    AccountsService,
    JournalsService,
    ReportsService,
    SupplierBillsService,
    PaymentsService,
  ],
  exports: [
    AccountsService,
    JournalsService,
    ReportsService,
    SupplierBillsService,
    PaymentsService,
  ],
})
export class BookkeepingModule {}
