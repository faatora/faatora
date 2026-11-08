import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import {
  BillingEvent,
  BillingProvider,
  BillingProviderError,
  BillingSignatureError,
  BillingSubscriptionStatus,
  ProviderCustomer,
  ProviderSubscription,
} from './billing.port';

/**
 * Minimal view over the pieces of the `stripe` SDK we use. Lets the unit
 * tests pass a hand-rolled mock without needing stripe-mock or a live
 * account. Kept intentionally narrow. Adding a new Stripe call here is
 * a deliberate act, not an accident.
 */
export interface StripeLike {
  customers: {
    create(
      params: Stripe.CustomerCreateParams,
      options?: { idempotencyKey?: string },
    ): Promise<Stripe.Customer>;
  };
  subscriptions: {
    create(
      params: Stripe.SubscriptionCreateParams,
      options?: { idempotencyKey?: string },
    ): Promise<Stripe.Subscription>;
    cancel(id: string): Promise<Stripe.Subscription>;
  };
  billingPortal: {
    sessions: {
      create(
        params: Stripe.BillingPortal.SessionCreateParams,
      ): Promise<Stripe.BillingPortal.Session>;
    };
  };
  webhooks: {
    constructEvent(payload: string | Buffer, sig: string | string[], secret: string): Stripe.Event;
  };
}

function mapStatus(s: Stripe.Subscription.Status): BillingSubscriptionStatus {
  switch (s) {
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'canceled':
    case 'unpaid':
    case 'incomplete':
      return s;
    case 'incomplete_expired':
      return 'canceled';
    case 'paused':
      return 'past_due';
    default:
      return 'incomplete';
  }
}

@Injectable()
export class StripeBilling implements BillingProvider {
  readonly name = 'stripe';
  private readonly log = new Logger(StripeBilling.name);
  private readonly stripe: StripeLike;
  private readonly webhookSecret: string;

  constructor(opts: { stripe: StripeLike; webhookSecret: string }) {
    this.stripe = opts.stripe;
    this.webhookSecret = opts.webhookSecret;
  }

  /**
   * Factory used by the module. Separated from the constructor so unit
   * tests can inject a mock StripeLike without touching env.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): StripeBilling {
    const secret = env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new BillingProviderError('STRIPE_SECRET_KEY is required when BILLING_PROVIDER=stripe');
    }
    const whSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!whSecret) {
      if (env.NODE_ENV === 'production') {
        throw new BillingProviderError(
          'STRIPE_WEBHOOK_SECRET is required in production when BILLING_PROVIDER=stripe',
        );
      }
      // Dev/test: let it through with a placeholder so adapter boots;
      // verifyWebhook will fail loudly on any real call.
    }
    const client = new Stripe(secret, {
      // Pin API version so a Stripe-side rollout does not change types.
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
      maxNetworkRetries: 3,
      timeout: 15_000,
    });
    return new StripeBilling({ stripe: client, webhookSecret: whSecret ?? '' });
  }

  async createCustomer(
    firmId: string,
    metadata: { email?: string; name?: string; [k: string]: string | undefined },
  ): Promise<ProviderCustomer> {
    try {
      const customer = await this.stripe.customers.create(
        {
          email: metadata.email,
          name: metadata.name,
          metadata: {
            firm_id: firmId,
            ...Object.fromEntries(
              Object.entries(metadata).filter(
                ([k, v]) => k !== 'email' && k !== 'name' && v !== undefined,
              ),
            ),
          },
        },
        { idempotencyKey: `firm:${firmId}:create-customer` },
      );
      return { providerCustomerId: customer.id, email: customer.email ?? null };
    } catch (err) {
      throw new BillingProviderError('stripe.customers.create failed', err);
    }
  }

  async createSubscription(
    providerCustomerId: string,
    planId: string,
    trialDays?: number,
  ): Promise<ProviderSubscription> {
    try {
      const sub = await this.stripe.subscriptions.create(
        {
          customer: providerCustomerId,
          items: [{ price: planId }],
          trial_period_days: trialDays,
          payment_behavior: 'default_incomplete',
          proration_behavior: 'create_prorations',
        },
        { idempotencyKey: `cust:${providerCustomerId}:sub:${planId}` },
      );
      return {
        providerSubscriptionId: sub.id,
        providerCustomerId,
        status: mapStatus(sub.status),
        planId,
        currentPeriodStart: new Date(sub.current_period_start * 1000),
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      };
    } catch (err) {
      throw new BillingProviderError('stripe.subscriptions.create failed', err);
    }
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    try {
      await this.stripe.subscriptions.cancel(providerSubscriptionId);
    } catch (err) {
      throw new BillingProviderError('stripe.subscriptions.cancel failed', err);
    }
  }

  async getCustomerPortalUrl(providerCustomerId: string, returnUrl: string): Promise<string> {
    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: providerCustomerId,
        return_url: returnUrl,
      });
      return session.url;
    } catch (err) {
      throw new BillingProviderError('stripe.billingPortal.sessions.create failed', err);
    }
  }

  verifyWebhook(rawBody: Buffer, signature: string): BillingEvent {
    if (!this.webhookSecret) {
      throw new BillingSignatureError(
        'STRIPE_WEBHOOK_SECRET is not configured; cannot verify webhook',
      );
    }
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'signature check failed';
      this.log.warn({ msg }, 'stripe webhook signature verification failed');
      throw new BillingSignatureError(msg);
    }
    return {
      provider: 'stripe',
      providerEventId: event.id,
      type: event.type,
      createdAt: new Date(event.created * 1000),
      data: event.data as unknown as Record<string, unknown>,
    };
  }
}
