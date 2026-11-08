/**
 * Firm-console billing port.
 *
 * This is the cross-cutting abstraction over the subscription billing
 * provider used to charge accounting firms (not retail SMEs; SME tenant
 * billing stays on the Thawani/`PAYMENT_PROVIDER` port under
 * `payment-provider.port.ts`).
 *
 * Why a port: Stripe cannot onboard an Omani LLC directly (see
 * `docs/research/stripe-uat-integration-plan.md`), so the production
 * provider may end up being Stripe (via a UAE / Delaware entity) or
 * Paddle / 2Checkout as merchant-of-record. We bind the adapter in the
 * module factory. Consumers only know `BillingProvider`.
 *
 * All provider-specific types (Stripe.Customer, Stripe.Subscription, ...)
 * are mapped into plain, provider-agnostic shapes before leaving the
 * adapter. Consumers never `import 'stripe'`.
 */

export const BILLING_PROVIDER = 'BILLING_PROVIDER';

/** Opaque, provider-side identifiers kept on the firm row. */
export interface ProviderCustomer {
  readonly providerCustomerId: string;
  readonly email: string | null;
}

export type BillingSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete';

export interface ProviderSubscription {
  readonly providerSubscriptionId: string;
  readonly providerCustomerId: string;
  readonly status: BillingSubscriptionStatus;
  readonly planId: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
}

/**
 * Provider-agnostic event, built from a verified webhook payload. The
 * webhook controller only sees this shape; the adapter owns signature
 * verification and the provider's native event type.
 */
export interface BillingEvent {
  readonly provider: string;
  readonly providerEventId: string;
  readonly type: string;
  readonly createdAt: Date;
  readonly data: Record<string, unknown>;
}

export interface BillingProvider {
  readonly name: string;

  createCustomer(
    firmId: string,
    metadata: { email?: string; name?: string; [k: string]: string | undefined },
  ): Promise<ProviderCustomer>;

  createSubscription(
    providerCustomerId: string,
    planId: string,
    trialDays?: number,
  ): Promise<ProviderSubscription>;

  cancelSubscription(providerSubscriptionId: string): Promise<void>;

  /**
   * Returns a one-shot URL into the provider's hosted self-serve
   * portal (Stripe Customer Portal, Paddle Retain, ...). Firms are
   * redirected here for upgrade / downgrade / invoice history.
   */
  getCustomerPortalUrl(providerCustomerId: string, returnUrl: string): Promise<string>;

  /**
   * Verifies the webhook signature and returns the parsed event. Must
   * accept the RAW request body (not a reparsed string). Throws if
   * the signature does not match. The controller translates that to
   * HTTP 400, never a 200.
   */
  verifyWebhook(rawBody: Buffer, signature: string): BillingEvent;
}

/** Thrown by adapters so the controller does not depend on provider SDK types. */
export class BillingSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingSignatureError';
  }
}

export class BillingProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BillingProviderError';
  }
}
