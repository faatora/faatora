import { Logger, Module } from '@nestjs/common';
import {
  BILLING_PROVIDER,
  type BillingProvider,
  BillingProviderError,
} from './billing.port';
import { StripeBilling } from './stripe-billing';
import { PaymobBilling } from './paymob-billing';
import { FirmBillingService } from './billing.service';
import { BillingWebhookController } from './webhook.controller';
import { WebhookEventsService } from './webhook-events.service';

/**
 * Firm-console billing module.
 *
 * Separate from the existing BillingModule (which owns SME tenant
 * usage-billing on Thawani). This one owns subscription billing for
 * the accounting firms using the firm console, behind a swappable
 * provider port.
 *
 * Provider selection is driven by env var BILLING_PROVIDER:
 *   stripe (default): binds StripeBilling (needs STRIPE_SECRET_KEY,
 *                      STRIPE_WEBHOOK_SECRET)
 *   paymob:           binds PaymobBilling (needs PAYMOB_API_KEY,
 *                      PAYMOB_HMAC_SECRET, PAYMOB_INTEGRATION_ID,
 *                      PAYMOB_IFRAME_ID). See
 *                      docs/research/paymob-uat-integration-plan.md
 *                      for why Paymob is a plausible primary once
 *                      Omani-LLC onboarding is confirmed by Ahmed.
 *   future:           paddle, 2checkout, ompay
 *
 * In dev/test with no credentials, the factory falls back to a
 * disabled adapter that throws on first use. This keeps the app
 * bootable in CI without any provider credentials.
 */
@Module({
  controllers: [BillingWebhookController],
  providers: [
    FirmBillingService,
    WebhookEventsService,
    {
      provide: BILLING_PROVIDER,
      useFactory: (): BillingProvider => {
        const log = new Logger('FirmBillingModule');
        const choice = (process.env.BILLING_PROVIDER ?? 'stripe').toLowerCase();
        switch (choice) {
          case 'stripe': {
            if (!process.env.STRIPE_SECRET_KEY) {
              if ((process.env.NODE_ENV ?? 'development') === 'production') {
                throw new BillingProviderError(
                  'STRIPE_SECRET_KEY must be set in production when BILLING_PROVIDER=stripe',
                );
              }
              log.warn(
                'STRIPE_SECRET_KEY not set; FirmBillingModule is wired with a stub that throws on use',
              );
              return makeStubProvider('stripe');
            }
            log.log(
              `Booting StripeBilling adapter (env NODE_ENV=${process.env.NODE_ENV ?? 'development'})`,
            );
            return StripeBilling.fromEnv();
          }
          case 'paymob': {
            if (!process.env.PAYMOB_API_KEY) {
              if ((process.env.NODE_ENV ?? 'development') === 'production') {
                throw new BillingProviderError(
                  'PAYMOB_API_KEY must be set in production when BILLING_PROVIDER=paymob',
                );
              }
              log.warn(
                'PAYMOB_API_KEY not set; FirmBillingModule is wired with a stub that throws on use',
              );
              return makeStubProvider('paymob');
            }
            log.log(
              `Booting PaymobBilling adapter (env NODE_ENV=${process.env.NODE_ENV ?? 'development'})`,
            );
            return PaymobBilling.fromEnv();
          }
          default:
            throw new BillingProviderError(
              `Unsupported BILLING_PROVIDER=${choice}. Supported: 'stripe', 'paymob'.`,
            );
        }
      },
    },
  ],
  exports: [FirmBillingService, BILLING_PROVIDER],
})
export class FirmBillingModule {}

function makeStubProvider(providerName: 'stripe' | 'paymob'): BillingProvider {
  const refuse = (): never => {
    const varName =
      providerName === 'stripe' ? 'STRIPE_SECRET_KEY' : 'PAYMOB_API_KEY';
    throw new BillingProviderError(
      `FirmBilling stub: ${varName} was not set at boot. Configure credentials to enable.`,
    );
  };
  return {
    name: `stub-${providerName}`,
    createCustomer: async () => refuse(),
    createSubscription: async () => refuse(),
    cancelSubscription: async () => refuse(),
    getCustomerPortalUrl: async () => refuse(),
    verifyWebhook: () => refuse(),
  };
}
