import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
 * Minimal HTTP client surface the Paymob adapter talks through. We do
 * NOT ship the `axios` dependency: Node 22 ships a WHATWG `fetch` that
 * covers every call we make. The port exists for the same reason the
 * Stripe adapter has `StripeLike`: unit tests inject a hand-rolled
 * client and assert on URL, headers, body without touching the network
 * or shipping an SDK whose types rotate under us.
 *
 * Why not use the paymob community SDKs (laravel-paymob, paymobx,
 * ex_paymob): none is published for Node and they wrap the REST API
 * one-to-one anyway, so we lose nothing by owning the four calls we
 * need.
 */
export interface PaymobHttpClient {
  request(req: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }>;
}

/**
 * Default implementation backed by Node 22's built-in fetch. Kept in
 * this file (not a separate module) so the dependency surface is one
 * import away from grepping.
 */
export class FetchPaymobHttpClient implements PaymobHttpClient {
  async request(req: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }> {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
    };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
    }
    const res = await fetch(req.url, init);
    const text = await res.text();
    let body: unknown = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // leave as string; adapter decides what to do with a non-JSON body
      }
    }
    return { status: res.status, body };
  }
}

/**
 * The 20 fields, in order, that Paymob concatenates (no separator) to
 * produce an HMAC-SHA512 over a TRANSACTION Processed callback. This
 * canonical is UNCHANGED between the older Accept-API flow and the
 * newer Intention + Unified Checkout flow: the webhook is still fired
 * by the card integration's transaction pipeline, not by the Intention
 * layer. Source:
 * https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback
 * Boolean values must serialise as lowercase `true`/`false`, which
 * `String(false)` gives us.
 */
const HMAC_FIELD_ORDER: readonly string[] = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id', // obj.id on POST, id on GET -- adapter flattens before calling
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order_id', // order.id on POST, order_id on GET
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

/**
 * Pull a possibly nested field out of a parsed Paymob callback body.
 * Server-to-server POST callbacks nest under `obj`; GET redirect
 * callbacks flatten the keys. We accept either shape by checking
 * `obj.*` first and falling back to the flat key.
 */
function pickField(payload: Record<string, unknown>, field: string): unknown {
  const obj = (payload.obj as Record<string, unknown> | undefined) ?? payload;
  if (field === 'id') {
    return obj.id ?? payload.id;
  }
  if (field === 'order_id') {
    const order = obj.order as Record<string, unknown> | undefined;
    if (order && typeof order === 'object' && 'id' in order) return order.id;
    return payload.order_id;
  }
  if (field.includes('.')) {
    const [head, tail] = field.split('.', 2);
    const nested = (obj[head] ?? payload[head]) as Record<string, unknown> | undefined;
    if (nested && typeof nested === 'object') return nested[tail];
    return payload[field.replace('.', '_')];
  }
  return obj[field] ?? payload[field];
}

/**
 * Serialise a Paymob field value the exact way Paymob does on its side.
 * Booleans go to `"true"`/`"false"`, numbers to their decimal form,
 * null/undefined to empty string.
 */
function normalize(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/**
 * Synthesise a Stripe-shaped `type` string from Paymob's flat
 * TRANSACTION callback booleans so FirmBillingService.handle() can
 * branch readably. Priority order: refund > void > failure > pending
 * > paid.
 */
function synthesiseType(obj: Record<string, unknown>): string {
  const isRefunded = Boolean(obj.is_refunded);
  const isVoided = Boolean(obj.is_voided);
  const pending = Boolean(obj.pending);
  const success = Boolean(obj.success);
  if (isRefunded) return 'transaction.refunded';
  if (isVoided) return 'transaction.voided';
  if (pending) return 'transaction.pending';
  if (success) return 'transaction.paid';
  return 'transaction.failed';
}

function mapStatusFromTxn(obj: Record<string, unknown>): BillingSubscriptionStatus {
  if (Boolean(obj.is_refunded) || Boolean(obj.is_voided)) return 'canceled';
  if (Boolean(obj.pending)) return 'incomplete';
  if (Boolean(obj.success)) return 'active';
  return 'past_due';
}

/**
 * Response of /api/auth/tokens. Still used for the Subscription-Plan
 * admin endpoints (`/api/acceptance/subscription-plans` POST/PUT),
 * which continue to require a Bearer token even under the new flow.
 * The Intention API itself does NOT use this: it accepts the raw
 * secret key under `Authorization: Token sk_...`.
 */
interface PaymobAuthResponse {
  token: string;
}

interface PaymobSubscriptionPlanResponse {
  id: number | string;
  frequency?: number;
  amount_cents?: number;
  is_active?: boolean;
  integration?: number | string;
}

/**
 * Minimal view over the Create Intention response. The real response
 * has many more fields (`payment_keys`, `card_tokens`, `payment_methods`,
 * `extras.creation_extras`, ...); we read only what we need to hand
 * back to the caller for a Unified Checkout redirect. Source:
 * https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention
 */
interface PaymobIntentionResponse {
  id?: string;
  intention_order_id?: number | string;
  client_secret?: string;
  status?: string;
  created?: string;
}

/**
 * Shape returned by `createCheckoutSession`. Carries what the firm-console
 * UI needs to send a user into Unified Checkout. Not part of the
 * BillingProvider port; callers cast via `provider.name === 'paymob'`
 * the same way they do for `statusFromTransaction`.
 */
export interface PaymobCheckoutSession {
  /** Paymob intention id, like `pi_test_bd49bb7fb4da48cfac4ec71ab4d8c433`. */
  readonly intentionId: string;
  /** The `client_secret` returned by Create Intention. Opaque. */
  readonly clientSecret: string;
  /**
   * Fully-formed URL to redirect the browser to for Unified Checkout.
   * E.g. `https://om.checkout.paymob.com/?publicKey=pk_test_...&clientSecret=csk_test_...`.
   */
  readonly checkoutUrl: string;
  /** Numeric Paymob order id — appears in the eventual transaction callback. */
  readonly orderId: string | null;
  /** The Paymob subscription-plan id this intention is tied to, when applicable. */
  readonly subscriptionPlanId: string | null;
}

/**
 * Billing data block Create Intention requires. `first_name`, `last_name`
 * and `email` are the three fields Paymob validates on; the rest are
 * optional (we pass dummies where we have none, since Oman cards
 * typically do not enforce AVS). Source: Create Intention doc.
 */
export interface PaymobBillingData {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
  apartment?: string;
  floor?: string;
  street?: string;
  building?: string;
  city?: string;
  country?: string;
  state?: string;
}

export interface CreateCheckoutOptions {
  /**
   * Fawtara-side idempotency key. Paymob returns it under
   * `merchant_order_id` in callbacks. Keep the string unique per
   * payment attempt (e.g. `firm_<id>:sub_<planId>:<unix_ms>`).
   */
  readonly specialReference?: string;
  /** Override for billing_data fields; merged over the adapter defaults. */
  readonly billingData?: PaymobBillingData;
  /**
   * Where Paymob should GET-redirect the user after completion.
   * Defaults to `${portalReturnUrl}?customer=<id>` so the Fawtara
   * portal can resolve the firm from the browser-side redirect.
   */
  readonly redirectionUrl?: string;
  /**
   * Where Paymob should POST the server-to-server webhook. Defaults
   * to whatever is configured on the integration id in the Paymob
   * dashboard; passing it here overrides per-intention.
   */
  readonly notificationUrl?: string;
  /** Extra metadata echoed back in callbacks under `extras`. */
  readonly extras?: Record<string, unknown>;
}

@Injectable()
export class PaymobBilling implements BillingProvider {
  readonly name = 'paymob';
  private readonly log = new Logger(PaymobBilling.name);
  private readonly http: PaymobHttpClient;
  private readonly baseUrl: string;
  private readonly checkoutUrl: string;
  private readonly apiKey: string;
  private readonly secretKey: string | null;
  private readonly publicKey: string | null;
  private readonly hmacSecret: string;
  private readonly integrationId: string;
  private readonly iframeId: string;
  private readonly portalReturnUrl: string;
  private cachedAuthToken: { value: string; expiresAt: number } | null = null;

  constructor(opts: {
    http: PaymobHttpClient;
    baseUrl: string;
    apiKey: string;
    hmacSecret: string;
    integrationId: string;
    iframeId: string;
    secretKey?: string;
    publicKey?: string;
    checkoutUrl?: string;
    portalReturnUrl?: string;
  }) {
    this.http = opts.http;
    // Normalize base URLs: trim trailing slash so we can safely concat paths.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Checkout URL defaults to Oman's region host; see Unified Checkout
    // doc for per-region values. Trim trailing slash too.
    this.checkoutUrl = (opts.checkoutUrl ?? 'https://om.checkout.paymob.com').replace(
      /\/+$/,
      '',
    );
    this.apiKey = opts.apiKey;
    this.hmacSecret = opts.hmacSecret;
    this.integrationId = opts.integrationId;
    this.iframeId = opts.iframeId;
    this.secretKey = opts.secretKey ?? null;
    this.publicKey = opts.publicKey ?? null;
    // Default Fawtara-hosted portal route. Paymob has no hosted
    // self-serve portal; see docs/research/paymob-uat-integration-plan.md
    // section 3. The firm-console UI owns change-card / change-plan /
    // cancel / invoice-history.
    this.portalReturnUrl =
      opts.portalReturnUrl ?? 'https://app.fawtara.om/firm/settings/billing';
  }

  /**
   * Env-driven factory used by the module. Separate from the ctor so
   * tests can inject a fake HTTP client.
   *
   * Required env for the new Intention + Unified Checkout flow:
   *   - PAYMOB_API_KEY        (Bearer-token flow, for subscription-plan admin calls)
   *   - PAYMOB_SECRET_KEY     (Intention API auth header)
   *   - PAYMOB_PUBLIC_KEY     (Unified Checkout URL query param)
   *   - PAYMOB_HMAC_SECRET    (webhook verification; required in prod)
   *   - PAYMOB_INTEGRATION_ID (MOTO integration id used on plans and intentions)
   *   - PAYMOB_IFRAME_ID      (legacy; unused by the new flow, kept so stub boot works)
   *
   * Optional:
   *   - PAYMOB_BASE_URL        (defaults to https://oman.paymob.com)
   *   - PAYMOB_CHECKOUT_URL    (defaults to https://om.checkout.paymob.com)
   *   - PAYMOB_PORTAL_RETURN_URL
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): PaymobBilling {
    const apiKey = env.PAYMOB_API_KEY;
    const hmacSecret = env.PAYMOB_HMAC_SECRET;
    const integrationId = env.PAYMOB_INTEGRATION_ID;
    const iframeId = env.PAYMOB_IFRAME_ID;
    const secretKey = env.PAYMOB_SECRET_KEY;
    const publicKey = env.PAYMOB_PUBLIC_KEY;
    const isProd = (env.NODE_ENV ?? 'development') === 'production';

    if (!apiKey) {
      throw new BillingProviderError(
        'PAYMOB_API_KEY is required when BILLING_PROVIDER=paymob',
      );
    }
    if (!integrationId) {
      throw new BillingProviderError(
        'PAYMOB_INTEGRATION_ID is required when BILLING_PROVIDER=paymob',
      );
    }
    if (!iframeId) {
      // Legacy; still required to boot so later-wave callers that may
      // fall back to an iframe URL do not get a surprise undefined.
      throw new BillingProviderError(
        'PAYMOB_IFRAME_ID is required when BILLING_PROVIDER=paymob (legacy, unused by Unified Checkout)',
      );
    }
    if (!hmacSecret && isProd) {
      throw new BillingProviderError(
        'PAYMOB_HMAC_SECRET is required in production when BILLING_PROVIDER=paymob',
      );
    }
    if (!secretKey && isProd) {
      throw new BillingProviderError(
        'PAYMOB_SECRET_KEY is required in production when BILLING_PROVIDER=paymob (Intention API auth)',
      );
    }
    if (!publicKey && isProd) {
      throw new BillingProviderError(
        'PAYMOB_PUBLIC_KEY is required in production when BILLING_PROVIDER=paymob (Unified Checkout URL)',
      );
    }

    // Oman is the target tenant. Override with PAYMOB_BASE_URL when
    // staging against the Egypt or UAE sandbox.
    const baseUrl = env.PAYMOB_BASE_URL ?? 'https://oman.paymob.com';
    const checkoutUrl = env.PAYMOB_CHECKOUT_URL ?? 'https://om.checkout.paymob.com';
    return new PaymobBilling({
      http: new FetchPaymobHttpClient(),
      baseUrl,
      checkoutUrl,
      apiKey,
      hmacSecret: hmacSecret ?? '',
      integrationId,
      iframeId,
      secretKey,
      publicKey,
      portalReturnUrl: env.PAYMOB_PORTAL_RETURN_URL,
    });
  }

  /**
   * Paymob's Subscription-Plan admin endpoints still use a Bearer
   * token obtained by POSTing the API key to /api/auth/tokens. Token
   * is valid for one hour. We cache it with a 60-second safety
   * margin.
   *
   * The Intention API does NOT use this: it accepts the raw secret
   * key under `Authorization: Token sk_...`. So this helper is now
   * scoped to the plan endpoints only.
   */
  private async getAuthToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedAuthToken && this.cachedAuthToken.expiresAt > now + 60_000) {
      return this.cachedAuthToken.value;
    }
    const res = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/api/auth/tokens`,
      headers: { 'Content-Type': 'application/json' },
      body: { api_key: this.apiKey },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new BillingProviderError(
        `paymob auth token request failed: HTTP ${res.status}`,
      );
    }
    const body = res.body as PaymobAuthResponse;
    if (!body || typeof body.token !== 'string') {
      throw new BillingProviderError('paymob auth response missing token field');
    }
    this.cachedAuthToken = {
      value: body.token,
      expiresAt: now + 55 * 60 * 1000, // 55 minutes; one-hour nominal with margin
    };
    return body.token;
  }

  /**
   * Paymob has no first-class Customer object the way Stripe does.
   * The closest primitive is the `billing_data` block attached to an
   * Intention. For firm-console billing the adapter returns a
   * stable synthetic customer id (`firm_<uuid>`) that Fawtara stores
   * on the firm row and threads into every future Intention under
   * `extras.firm_customer_ref` so callbacks can be tied back to the
   * firm without ever calling "GET /customer" (there isn't one).
   *
   * This is intentional and documented in
   * docs/research/paymob-uat-integration-plan.md section 2.
   */
  async createCustomer(
    firmId: string,
    metadata: { email?: string; name?: string; [k: string]: string | undefined },
  ): Promise<ProviderCustomer> {
    // Validate the HTTP client is reachable so misconfig fails loud at
    // onboarding time rather than on the first subscription charge.
    try {
      await this.getAuthToken();
    } catch (err) {
      throw new BillingProviderError('paymob auth probe failed in createCustomer', err);
    }
    this.log.log(
      { firmId, email: metadata.email },
      'paymob: synthesising customer id (paymob has no first-class customer object)',
    );
    return {
      providerCustomerId: `firm_${firmId}`,
      email: metadata.email ?? null,
    };
  }

  /**
   * Create a Paymob Subscription Plan. Paymob's plan model is weaker
   * than Stripe's (no trials, no prorations, closed set of frequency
   * values: 7, 15, 30, 60, 90, 180, 360 days). We map Fawtara's
   * monthly to 30 and annual to 360, following the pattern in
   * docs/research/paymob-uat-integration-plan.md section 2.1.
   *
   * trialDays is not supported by Paymob and is silently ignored
   * after a warn log. Callers that care about trials must handle them
   * at the Fawtara layer (delay the first charge via scheduler) or
   * stay on Stripe.
   *
   * Under the new Intention + Unified Checkout flow, this method only
   * provisions the recurring schedule (the plan). It does NOT mint a
   * client_secret or a checkout URL — that is `createCheckoutSession`'s
   * job, kept separate so plan reuse and checkout-mint are not
   * conflated. The returned `providerSubscriptionId` is the plan id.
   * See the Create Subscription doc for the two-step pattern:
   * https://developers.paymob.com/paymob-docs/developers/subscription/create-subscription
   */
  async createSubscription(
    providerCustomerId: string,
    planId: string,
    trialDays?: number,
  ): Promise<ProviderSubscription> {
    if (trialDays !== undefined && trialDays > 0) {
      this.log.warn(
        { providerCustomerId, planId, trialDays },
        'paymob: trialDays requested but Paymob Subscriptions API has no trial field; ignoring',
      );
    }
    const token = await this.getAuthToken();
    // `planId` on the port is an opaque price id. For Paymob we treat
    // it as `<amount_cents>:<frequency_days>`, e.g.
    // "30000:360" = OMR 300 per year. The format is defensive against
    // future Paymob plan-template support: if Paymob ever ships a
    // reusable plan template id we flip this branch.
    const [amountRaw, freqRaw] = planId.split(':');
    const amount_cents = Number.parseInt(amountRaw, 10);
    const frequency = Number.parseInt(freqRaw, 10);
    if (!Number.isFinite(amount_cents) || amount_cents <= 0) {
      throw new BillingProviderError(
        `paymob: invalid planId "${planId}"; expected "<amountCents>:<frequencyDays>"`,
      );
    }
    const ALLOWED_FREQUENCIES = new Set([7, 15, 30, 60, 90, 180, 360]);
    if (!ALLOWED_FREQUENCIES.has(frequency)) {
      throw new BillingProviderError(
        `paymob: frequency ${frequency} not in allowed set {7,15,30,60,90,180,360}`,
      );
    }
    const res = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/api/acceptance/subscription-plans`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: {
        name: `fawtara-${providerCustomerId}-${planId}`,
        frequency,
        amount_cents,
        integration: this.integrationId,
        is_active: true,
        plan_type: 'rent',
        reminder_days: '3',
        retrial_days: '2',
      },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new BillingProviderError(
        `paymob subscription create failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    const plan = res.body as PaymobSubscriptionPlanResponse;
    if (plan == null || plan.id === undefined) {
      throw new BillingProviderError('paymob subscription response missing id');
    }
    const now = new Date();
    const periodEnd = new Date(now.getTime() + frequency * 24 * 3600 * 1000);
    return {
      providerSubscriptionId: String(plan.id),
      providerCustomerId,
      status: 'incomplete',
      planId,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    };
  }

  /**
   * Mint a Unified Checkout session for the given customer + plan.
   *
   * This is the second half of the new flow: `createSubscription`
   * provisioned the recurring schedule on Paymob; this call mints a
   * one-shot Intention with `subscription_plan_id` set, so that when
   * the customer completes the first 3DS charge via the returned
   * `checkoutUrl`, Paymob saves the card and enrolls them in the
   * plan. Subsequent recurring charges happen automatically.
   *
   * NOT part of the BillingProvider port. Callers that know they are
   * on Paymob (via `provider.name === 'paymob'`) cast the provider
   * and call this directly. Stripe's equivalent is the
   * Stripe Checkout Session, which lives behind `Checkout.Session.create`
   * in stripe-billing.ts.
   *
   * @param providerCustomerId the synthetic `firm_<uuid>` id we minted in createCustomer
   * @param planId             the `<amountCents>:<frequencyDays>` price key
   * @param paymobPlanId       the Paymob-side plan id returned by createSubscription
   * @param options            overrides for billing_data, redirect/notification URLs, extras
   */
  async createCheckoutSession(
    providerCustomerId: string,
    planId: string,
    paymobPlanId: string | null,
    options: CreateCheckoutOptions = {},
  ): Promise<PaymobCheckoutSession> {
    if (!this.secretKey) {
      throw new BillingProviderError(
        'PAYMOB_SECRET_KEY is required to create a Paymob checkout session',
      );
    }
    if (!this.publicKey) {
      throw new BillingProviderError(
        'PAYMOB_PUBLIC_KEY is required to create a Paymob checkout session',
      );
    }
    const [amountRaw] = planId.split(':');
    const amount_cents = Number.parseInt(amountRaw, 10);
    if (!Number.isFinite(amount_cents) || amount_cents <= 0) {
      throw new BillingProviderError(
        `paymob: invalid planId "${planId}"; expected "<amountCents>:<frequencyDays>"`,
      );
    }

    // Billing data defaults. Paymob validates first_name/last_name/email;
    // the rest are optional but Paymob historically rejects missing
    // phone_number too, hence the placeholder. The adapter uses no real
    // personal data here — callers that have real data pass it via
    // options.billingData.
    const defaultBilling: Required<
      Pick<
        PaymobBillingData,
        'first_name' | 'last_name' | 'email' | 'phone_number' | 'country'
      >
    > = {
      first_name: 'Firm',
      last_name: 'Subscriber',
      email: 'billing@fawtara.om',
      phone_number: '+96800000000',
      country: 'OM',
    };
    const billing_data: PaymobBillingData = { ...defaultBilling, ...options.billingData };

    const specialReference =
      options.specialReference ??
      `${providerCustomerId}:${planId}:${Date.now().toString(36)}`;

    const body: Record<string, unknown> = {
      amount: amount_cents,
      currency: 'OMR',
      payment_methods: [Number.parseInt(this.integrationId, 10) || this.integrationId],
      items: [
        {
          name: `Fawtara subscription ${planId}`,
          amount: amount_cents,
          description: `Fawtara firm-console subscription (${planId})`,
          quantity: 1,
        },
      ],
      billing_data,
      special_reference: specialReference,
      extras: {
        firm_customer_ref: providerCustomerId,
        fawtara_plan_id: planId,
        ...(options.extras ?? {}),
      },
    };
    if (paymobPlanId !== null && paymobPlanId !== undefined && paymobPlanId !== '') {
      body.subscription_plan_id = paymobPlanId;
    }
    if (options.redirectionUrl) body.redirection_url = options.redirectionUrl;
    if (options.notificationUrl) body.notification_url = options.notificationUrl;

    const res = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/intention/`,
      headers: {
        Authorization: `Token ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new BillingProviderError(
        `paymob intention create failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    const intent = res.body as PaymobIntentionResponse;
    if (
      intent == null ||
      typeof intent.id !== 'string' ||
      typeof intent.client_secret !== 'string' ||
      intent.client_secret.length === 0
    ) {
      throw new BillingProviderError(
        'paymob intention response missing id or client_secret',
      );
    }

    // Unified Checkout URL. The publicKey and clientSecret are opaque
    // strings; URL-encoding them is defensive since Paymob occasionally
    // embeds `+`/`=` in test-mode secrets.
    const u = new URL(this.checkoutUrl);
    u.searchParams.set('publicKey', this.publicKey);
    u.searchParams.set('clientSecret', intent.client_secret);
    const checkoutUrl = u.toString();

    const orderId =
      intent.intention_order_id === undefined || intent.intention_order_id === null
        ? null
        : String(intent.intention_order_id);

    return {
      intentionId: intent.id,
      clientSecret: intent.client_secret,
      checkoutUrl,
      orderId,
      subscriptionPlanId: paymobPlanId ?? null,
    };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    const token = await this.getAuthToken();
    // Paymob does not have a DELETE endpoint for a plan; "cancel" is
    // flipping is_active to false via the plan update endpoint. This
    // stops future deductions on the schedule.
    const res = await this.http.request({
      method: 'PUT',
      url: `${this.baseUrl}/api/acceptance/subscription-plans/${providerSubscriptionId}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: { is_active: false },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new BillingProviderError(
        `paymob subscription cancel failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
  }

  /**
   * Paymob has no hosted self-serve customer portal (see research doc
   * section 3). This returns a Fawtara-hosted route; the firm-console
   * UI is responsible for change-card / change-plan / cancel / invoice
   * history AND for kicking off a new Unified Checkout session (which
   * goes through `createCheckoutSession`). We include the provider
   * customer id as a query param so the Fawtara portal page can resolve
   * the firm without a DB lookup from the redirect handler.
   *
   * `returnUrl` on the port is the URL Fawtara's portal should send
   * the user to on done; we encode it so the portal page can forward
   * it to the browser after they finish their action.
   *
   * Signature returns `Promise<string>` (not an object with a
   * clientSecret) because the BillingProvider port requires that
   * shape and Stripe depends on it. Paymob-specific checkout minting
   * lives on `createCheckoutSession` instead.
   */
  async getCustomerPortalUrl(
    providerCustomerId: string,
    returnUrl: string,
  ): Promise<string> {
    const base = this.portalReturnUrl;
    const u = new URL(base);
    u.searchParams.set('customer', providerCustomerId);
    u.searchParams.set('return', returnUrl);
    return u.toString();
  }

  /**
   * Verify an inbound Paymob webhook.
   *
   * IMPORTANT: Paymob's HMAC is NOT over the raw body. It is over 20
   * specific fields pulled from the parsed JSON, concatenated with no
   * separator in a fixed order, hashed with HMAC-SHA512, hex-encoded,
   * and passed as the `hmac` QUERY PARAMETER (not a header). We thus
   * JSON.parse the rawBody here and signature contains the hex HMAC
   * that the controller pulled off the query string.
   *
   * Under the Intention + Unified Checkout flow, this canonical is
   * unchanged from the Accept-API flow: the TRANSACTION Processed
   * callback is still fired by the card integration's pipeline, not
   * by the Intention layer. See section 5 of
   * paymob-intention-api-refactor-design.md.
   */
  verifyWebhook(rawBody: Buffer, signature: string): BillingEvent {
    if (!this.hmacSecret) {
      throw new BillingSignatureError(
        'PAYMOB_HMAC_SECRET is not configured; cannot verify webhook',
      );
    }
    if (!signature) {
      throw new BillingSignatureError('missing hmac query parameter');
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid JSON body';
      throw new BillingSignatureError(`paymob webhook body is not valid JSON: ${msg}`);
    }
    const concat = HMAC_FIELD_ORDER
      .map((f) => normalize(pickField(payload, f)))
      .join('');
    const expected = createHmac('sha512', this.hmacSecret)
      .update(concat, 'utf8')
      .digest('hex');
    const sigLower = signature.toLowerCase();
    // Length check before timingSafeEqual: Node's impl throws on
    // mismatched lengths, which would leak info on an obviously bad
    // signature. A short-circuit length check is itself not timing
    // sensitive (the strings are public-shape).
    if (sigLower.length !== expected.length) {
      throw new BillingSignatureError('paymob hmac length mismatch');
    }
    const ok = timingSafeEqual(Buffer.from(sigLower, 'utf8'), Buffer.from(expected, 'utf8'));
    if (!ok) {
      this.log.warn('paymob webhook signature verification failed');
      throw new BillingSignatureError('paymob hmac mismatch');
    }
    // Pull obj out so the synthesised type sees the booleans in the
    // shape Paymob actually sends on the Processed POST callback.
    const obj = (payload.obj as Record<string, unknown> | undefined) ?? payload;
    const eventId = String(obj.id ?? payload.id ?? '');
    if (!eventId) {
      throw new BillingSignatureError('paymob webhook has no transaction id');
    }
    const createdAtRaw = obj.created_at ?? payload.created_at;
    const createdAt =
      typeof createdAtRaw === 'string' ? new Date(createdAtRaw) : new Date();
    return {
      provider: 'paymob',
      providerEventId: eventId,
      type: synthesiseType(obj),
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
      data: obj,
    };
  }

  /**
   * Exposed for future use by FirmBillingService.handle paymob branch.
   * Not part of the BillingProvider port; callers that need it dynamic
   * cast via `provider.name === 'paymob'`.
   */
  statusFromTransaction(obj: Record<string, unknown>): BillingSubscriptionStatus {
    return mapStatusFromTxn(obj);
  }
}

// Re-exported for tests that need to fabricate a canonical Paymob
// callback payload with the right 20 fields without reflecting into
// the module internals.
export const _HMAC_FIELD_ORDER = HMAC_FIELD_ORDER;
export const _normalize = normalize;
export const _pickField = pickField;
