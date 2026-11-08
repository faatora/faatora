import { Module } from '@nestjs/common';
import { PlansService } from './plans.service';
import { PlansController } from './plans.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { MeteringService } from './metering.service';
import { BillingService } from './billing.service';
import { BillingInvoicesController } from './billing-invoices.controller';
import { CommissionsService } from './commissions.service';
import { PAYMENT_PROVIDER, StubPaymentProvider } from './payment-provider.port';

@Module({
  controllers: [PlansController, SubscriptionsController, BillingInvoicesController],
  providers: [
    PlansService,
    SubscriptionsService,
    MeteringService,
    BillingService,
    CommissionsService,
    { provide: PAYMENT_PROVIDER, useClass: StubPaymentProvider },
  ],
  exports: [
    PlansService,
    SubscriptionsService,
    MeteringService,
    BillingService,
    CommissionsService,
    PAYMENT_PROVIDER,
  ],
})
export class BillingModule {}
