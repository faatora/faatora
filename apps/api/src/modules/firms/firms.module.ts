import { Module } from '@nestjs/common';
import { FirmsController } from './firms.controller';
import { ClientOnboardingController } from './client-onboarding.controller';
import { FirmsService } from './firms.service';
import { FirmDashboardService } from './dashboard.service';
import { BatchOperationsService } from './batch-operations.service';
import { FirmGuard } from '../../auth/firm.guard';
import { AccountantModule } from '../accountant/accountant.module';
import { AccountantAuthGuard } from '../accountant/accountant-auth.guard';
import { InvoicesModule } from '../invoices/invoices.module';

/**
 * EP5 Wave 1 + 2 -- firm-console module.
 *
 * Imports AccountantModule for the AccountantAuthGuard, which protects
 * the bootstrap endpoints (create firm, accept invitation, list my
 * firms) -- those cannot require an active firm context because they're
 * what establishes it.
 *
 * Wave 2 (W2-C) adds:
 *   - ClientOnboardingController (POST /firms/:id/clients/onboard,
 *     POST /firms/:id/clients/batch, POST /firms/:id/operations/
 *     validate-all, GET /firms/:id/operations/vat-return.csv)
 *   - BatchOperationsService, which depends on the COMPLIANCE_VALIDATOR
 *     exported by InvoicesModule.
 */
@Module({
  imports: [AccountantModule, InvoicesModule],
  controllers: [FirmsController, ClientOnboardingController],
  providers: [
    FirmsService,
    FirmDashboardService,
    BatchOperationsService,
    FirmGuard,
    AccountantAuthGuard,
  ],
  exports: [FirmsService, FirmDashboardService, BatchOperationsService, FirmGuard],
})
export class FirmsModule {}
