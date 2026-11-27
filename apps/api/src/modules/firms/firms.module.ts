import { Global, Module } from '@nestjs/common';
import { FirmsController } from './firms.controller';
import { ClientOnboardingController } from './client-onboarding.controller';
import { FirmsService } from './firms.service';
import { FirmDashboardService } from './dashboard.service';
import { BatchOperationsService } from './batch-operations.service';
import { FirmGuard } from '../../auth/firm.guard';
import { AccountantModule } from '../accountant/accountant.module';
import { AccountantAuthGuard } from '../accountant/accountant-auth.guard';
import { InvoicesModule } from '../invoices/invoices.module';
import { ImpersonationController } from './clients/impersonation.controller';
import { ImpersonationService } from './clients/impersonation.service';

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
 *
 * Accountant impersonation ("act as this client") adds:
 *   - ImpersonationController (POST /firms/:id/clients/:tenantId/act-as)
 *   - ImpersonationService, which is also injected by TenantGuard to
 *     verify the X-Impersonate-Tenant-Id header on every follow-up
 *     request. Because TenantGuard is referenced by @UseGuards from many
 *     unrelated modules (invoices, billing, bookkeeping, imports...),
 *     the service must be resolvable from any module injector — hence
 *     the `@Global()` decorator on this module. Making FirmsModule
 *     global is a minor widening: its existing exports (FirmsService,
 *     FirmDashboardService, BatchOperationsService, FirmGuard) were
 *     already safe to expose anywhere that explicitly imported the
 *     module; `@Global` just drops the import requirement.
 */
@Global()
@Module({
  imports: [AccountantModule, InvoicesModule],
  controllers: [FirmsController, ClientOnboardingController, ImpersonationController],
  providers: [
    FirmsService,
    FirmDashboardService,
    BatchOperationsService,
    ImpersonationService,
    FirmGuard,
    AccountantAuthGuard,
  ],
  exports: [
    FirmsService,
    FirmDashboardService,
    BatchOperationsService,
    ImpersonationService,
    FirmGuard,
  ],
})
export class FirmsModule {}
