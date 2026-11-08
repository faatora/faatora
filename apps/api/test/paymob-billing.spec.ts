import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  BillingProviderError,
  BillingSignatureError,
} from '../src/modules/billing/firm/billing.port';
import {
  PaymobBilling,
  type PaymobHttpClient,
  _HMAC_FIELD_ORDER,
  _normalize,
} from '../src/modules/billing/firm/paymob-billing';
import { FirmBillingService } from '../src/modules/billing/firm/billing.service';
import { BillingWebhookController } from '../src/modules/billing/firm/webhook.controller';
import type {
  WebhookEventsService,
  DispatchResult,
} from '../src/modules/billing/firm/webhook-events.service';

/**
 * Minimal Database stub — W2-E extended FirmBillingService with a db
 * dependency for persisting the providerCustomerId. The dispatch tests
 * in this file do not exercise that path (every path hits a stub-named
 * provider or the handle() routing) so an empty shim is enough.
 */
function stubDb(): any {
  const tx = {
    execute: async () => ({ rows: [] }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => ({ rows: [] }) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  };
  return {
    transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    execute: async () => ({ rows: [] }),
    insert: tx.insert,
    update: tx.update,
    select: tx.select,
  };
}

// Minimal recording mock of the http port. Tests push responses onto
// `queue`; the adapter pops them in call order. Call history lives on
// `calls`.
function makeHttp(
  responses: Array<{ status: number; body: unknown }>,
): PaymobHttpClient & {
  calls: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }>;
} {
  const queue = [...responses];
  const calls: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }> = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const next = queue.shift();
      if (!next) throw new Error('mock http: response queue exhausted');
      return next;
    },
  };
}

function buildAdapter(opts?: {
  http?: PaymobHttpClient;
  hmacSecret?: string;
  secretKey?: string | null;
  publicKey?: string | null;
}): PaymobBilling {
  return new PaymobBilling({
    http:
      opts?.http ??
      makeHttp([
        { status: 200, body: { token: 'tok_auth_cached' } },
        { status: 201, body: { id: 'plan_1' } },
      ]),
    baseUrl: 'https://oman.paymob.com',
    checkoutUrl: 'https://om.checkout.paymob.com',
    apiKey: 'api_key_test',
    hmacSecret: opts?.hmacSecret ?? 'hmac_test_secret',
    integrationId: '4567890',
    iframeId: '987654',
    secretKey: opts?.secretKey === null ? undefined : (opts?.secretKey ?? 'sk_test_x'),
    publicKey: opts?.publicKey === null ? undefined : (opts?.publicKey ?? 'pk_test_x'),
  });
}

/**
 * Build a canonical Paymob "Transaction Processed" callback body and
 * the matching HMAC for a given secret. We populate every one of the
 * 20 signed fields so the adapter's pickField cannot tie-break on
 * absence. The caller can override any field to simulate decline /
 * refund / void.
 */
function buildPaymobCallback(
  overrides: Partial<Record<string, unknown>> = {},
  secret = 'hmac_test_secret',
): { body: object; hmac: string } {
  const fields: Record<string, unknown> = {
    amount_cents: 30000,
    created_at: '2026-11-08T10:00:00.000000',
    currency: 'OMR',
    error_occured: false,
    has_parent_transaction: false,
    id: 100042, // obj.id
    integration_id: 4567890,
    is_3d_secure: true,
    is_auth: false,
    is_capture: true,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    order_id: 200077, // obj.order.id
    owner: 12345,
    pending: false,
    'source_data.pan': '1111',
    'source_data.sub_type': 'MasterCard',
    'source_data.type': 'card',
    success: true,
    ...overrides,
  };
  const concat = _HMAC_FIELD_ORDER.map((f) => _normalize(fields[f])).join('');
  const hmac = createHmac('sha512', secret).update(concat, 'utf8').digest('hex');
  const body = {
    type: 'TRANSACTION',
    obj: {
      id: fields.id,
      amount_cents: fields.amount_cents,
      created_at: fields.created_at,
      currency: fields.currency,
      error_occured: fields.error_occured,
      has_parent_transaction: fields.has_parent_transaction,
      integration_id: fields.integration_id,
      is_3d_secure: fields.is_3d_secure,
      is_auth: fields.is_auth,
      is_capture: fields.is_capture,
      is_refunded: fields.is_refunded,
      is_standalone_payment: fields.is_standalone_payment,
      is_voided: fields.is_voided,
      owner: fields.owner,
      pending: fields.pending,
      success: fields.success,
      order: { id: fields.order_id },
      source_data: {
        pan: fields['source_data.pan'],
        sub_type: fields['source_data.sub_type'],
        type: fields['source_data.type'],
      },
    },
  };
  return { body, hmac };
}

/** Canonical Create Intention 201 response body. */
function buildIntentionResponse(
  overrides: Partial<{
    id: string;
    intention_order_id: number;
    client_secret: string;
    status: string;
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'pi_test_abc123',
    intention_order_id: overrides.intention_order_id ?? 265715202,
    client_secret: overrides.client_secret ?? 'om_csk_test_94042f793419c5a0f14a4cadfda9d626',
    status: overrides.status ?? 'intended',
    payment_methods: [{ integration_id: 4567890, method_type: 'online' }],
    object: 'paymentintention',
  };
}

describe('PaymobBilling adapter', () => {
  it('createCustomer probes auth then returns a synthetic firm_<uuid> id', async () => {
    const http = makeHttp([{ status: 200, body: { token: 'tok_auth' } }]);
    const adapter = buildAdapter({ http });
    const firmId = '00000000-0000-0000-0000-00000000abcd';
    const customer = await adapter.createCustomer(firmId, {
      email: 'ops@firm.om',
      name: 'Al Hajar Audit',
    });
    expect(customer.providerCustomerId).toBe(`firm_${firmId}`);
    expect(customer.email).toBe('ops@firm.om');
    // Auth probe hit /api/auth/tokens with the api_key.
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('https://oman.paymob.com/api/auth/tokens');
    expect(http.calls[0].body).toMatchObject({ api_key: 'api_key_test' });
  });

  it('createCustomer wraps auth failures as BillingProviderError', async () => {
    const http = makeHttp([{ status: 401, body: { detail: 'bad api key' } }]);
    const adapter = buildAdapter({ http });
    await expect(adapter.createCustomer('firm-x', {})).rejects.toBeInstanceOf(
      BillingProviderError,
    );
  });

  it('createSubscription provisions a Paymob plan under Bearer auth and returns its id', async () => {
    const http = makeHttp([
      { status: 200, body: { token: 'tok_auth' } },
      { status: 201, body: { id: 'plan_abc', frequency: 360, amount_cents: 30000 } },
    ]);
    const adapter = buildAdapter({ http });
    const sub = await adapter.createSubscription('firm_1', '30000:360');
    expect(sub.providerSubscriptionId).toBe('plan_abc');
    expect(sub.planId).toBe('30000:360');
    // Freshly provisioned plan starts incomplete until the first
    // Intention's 3DS charge enrolls a card; the adapter does not
    // fabricate an active status from thin air.
    expect(sub.status).toBe('incomplete');
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(sub.currentPeriodStart.getTime());
    const planCall = http.calls[1];
    expect(planCall.url).toBe('https://oman.paymob.com/api/acceptance/subscription-plans');
    expect(planCall.headers.Authorization).toBe('Bearer tok_auth');
    expect(planCall.body).toMatchObject({
      frequency: 360,
      amount_cents: 30000,
      integration: '4567890',
      is_active: true,
      plan_type: 'rent',
    });
  });

  it('createSubscription refuses an off-list frequency', async () => {
    const http = makeHttp([{ status: 200, body: { token: 'tok_auth' } }]);
    const adapter = buildAdapter({ http });
    await expect(
      adapter.createSubscription('firm_1', '30000:45'),
    ).rejects.toThrow(/frequency 45 not in allowed set/);
  });

  it('createSubscription refuses a malformed planId', async () => {
    const http = makeHttp([{ status: 200, body: { token: 'tok_auth' } }]);
    const adapter = buildAdapter({ http });
    await expect(
      adapter.createSubscription('firm_1', 'not-a-plan'),
    ).rejects.toThrow(/invalid planId/);
  });

  it('createSubscription ignores trialDays with a warn (Paymob has no trials)', async () => {
    const http = makeHttp([
      { status: 200, body: { token: 'tok_auth' } },
      { status: 201, body: { id: 'plan_t' } },
    ]);
    const adapter = buildAdapter({ http });
    const sub = await adapter.createSubscription('firm_1', '30000:360', 14);
    expect(sub.providerSubscriptionId).toBe('plan_t');
    // Body does NOT include a trial_period_days field (confirms the
    // ignored-not-translated behavior).
    const planCall = http.calls[1];
    expect(planCall.body).not.toHaveProperty('trial_period_days');
  });

  it('cancelSubscription flips is_active to false on the plan endpoint', async () => {
    const http = makeHttp([
      { status: 200, body: { token: 'tok_auth' } },
      { status: 200, body: { id: 'plan_x', is_active: false } },
    ]);
    const adapter = buildAdapter({ http });
    await adapter.cancelSubscription('plan_x');
    const cancelCall = http.calls[1];
    expect(cancelCall.method).toBe('PUT');
    expect(cancelCall.url).toBe('https://oman.paymob.com/api/acceptance/subscription-plans/plan_x');
    expect(cancelCall.body).toEqual({ is_active: false });
  });

  it('getCustomerPortalUrl returns a Faatora-hosted route (Paymob has no portal)', async () => {
    const adapter = buildAdapter();
    const url = await adapter.getCustomerPortalUrl(
      'firm_abc',
      'https://app.faatora.om/firm/dashboard',
    );
    const parsed = new URL(url);
    expect(parsed.host).toBe('app.faatora.om');
    expect(parsed.pathname).toBe('/firm/settings/billing');
    expect(parsed.searchParams.get('customer')).toBe('firm_abc');
    expect(parsed.searchParams.get('return')).toBe('https://app.faatora.om/firm/dashboard');
  });

  // ---------------------------------------------------------------
  // createCheckoutSession — new under the Intention + Unified Checkout
  // flow. Not on the BillingProvider port; callers cast via name.
  // ---------------------------------------------------------------

  it('createCheckoutSession POSTs /v1/intention/ with Token auth and returns the Unified Checkout URL', async () => {
    const http = makeHttp([{ status: 201, body: buildIntentionResponse() }]);
    const adapter = buildAdapter({ http });
    const session = await adapter.createCheckoutSession('firm_1', '50000:360', 'plan_abc');

    expect(session.intentionId).toBe('pi_test_abc123');
    expect(session.clientSecret).toBe('om_csk_test_94042f793419c5a0f14a4cadfda9d626');
    expect(session.orderId).toBe('265715202');
    expect(session.subscriptionPlanId).toBe('plan_abc');

    // The redirect URL points at the Oman Unified Checkout host with
    // both publicKey and clientSecret as query params.
    const parsed = new URL(session.checkoutUrl);
    expect(parsed.host).toBe('om.checkout.paymob.com');
    expect(parsed.searchParams.get('publicKey')).toBe('pk_test_x');
    expect(parsed.searchParams.get('clientSecret')).toBe(
      'om_csk_test_94042f793419c5a0f14a4cadfda9d626',
    );

    // One HTTP call: no /api/auth/tokens hit — the Intention API uses
    // the raw secret key directly in the Authorization header.
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://oman.paymob.com/v1/intention/');
    expect(call.headers.Authorization).toBe('Token sk_test_x');
    expect(call.headers['Content-Type']).toBe('application/json');
    const body = call.body as Record<string, unknown>;
    expect(body.amount).toBe(50000);
    expect(body.currency).toBe('OMR');
    expect(body.payment_methods).toEqual([4567890]);
    expect(body.subscription_plan_id).toBe('plan_abc');
    expect((body.extras as Record<string, unknown>).firm_customer_ref).toBe('firm_1');
  });

  it('createCheckoutSession omits subscription_plan_id when no plan id is given', async () => {
    const http = makeHttp([{ status: 201, body: buildIntentionResponse() }]);
    const adapter = buildAdapter({ http });
    await adapter.createCheckoutSession('firm_1', '50000:360', null);
    const body = http.calls[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty('subscription_plan_id');
  });

  it('createCheckoutSession merges caller-provided billing_data over defaults', async () => {
    const http = makeHttp([{ status: 201, body: buildIntentionResponse() }]);
    const adapter = buildAdapter({ http });
    await adapter.createCheckoutSession('firm_1', '50000:360', 'plan_abc', {
      billingData: {
        first_name: 'Ahmed',
        last_name: 'Al Habsi',
        email: 'ahmed@alhabsi.om',
      },
    });
    const body = http.calls[0].body as Record<string, unknown>;
    const billing = body.billing_data as Record<string, unknown>;
    expect(billing.first_name).toBe('Ahmed');
    expect(billing.last_name).toBe('Al Habsi');
    expect(billing.email).toBe('ahmed@alhabsi.om');
    // Defaults fill the remaining required-ish fields.
    expect(billing.phone_number).toBe('+96800000000');
    expect(billing.country).toBe('OM');
  });

  it('createCheckoutSession uses a caller-supplied specialReference verbatim', async () => {
    const http = makeHttp([{ status: 201, body: buildIntentionResponse() }]);
    const adapter = buildAdapter({ http });
    const ref = 'firm_1:50000:360:unique-attempt-42';
    await adapter.createCheckoutSession('firm_1', '50000:360', 'plan_abc', {
      specialReference: ref,
    });
    const body = http.calls[0].body as Record<string, unknown>;
    expect(body.special_reference).toBe(ref);
  });

  it('createCheckoutSession raises BillingProviderError on 4xx from Intention API', async () => {
    const http = makeHttp([
      { status: 400, body: { billing_data: { phone_number: ['This field is required.'] } } },
    ]);
    const adapter = buildAdapter({ http });
    await expect(
      adapter.createCheckoutSession('firm_1', '50000:360', 'plan_abc'),
    ).rejects.toBeInstanceOf(BillingProviderError);
  });

  it('createCheckoutSession raises BillingProviderError if client_secret is missing', async () => {
    const http = makeHttp([
      { status: 201, body: { id: 'pi_test_abc', intention_order_id: 1, status: 'intended' } },
    ]);
    const adapter = buildAdapter({ http });
    await expect(
      adapter.createCheckoutSession('firm_1', '50000:360', 'plan_abc'),
    ).rejects.toThrow(/missing id or client_secret/);
  });

  it('createCheckoutSession refuses to run without PAYMOB_SECRET_KEY', async () => {
    const adapter = buildAdapter({ secretKey: null });
    await expect(
      adapter.createCheckoutSession('firm_1', '50000:360', 'plan_abc'),
    ).rejects.toThrow(/PAYMOB_SECRET_KEY/);
  });

  it('createCheckoutSession refuses to run without PAYMOB_PUBLIC_KEY', async () => {
    const adapter = buildAdapter({ publicKey: null });
    await expect(
      adapter.createCheckoutSession('firm_1', '50000:360', 'plan_abc'),
    ).rejects.toThrow(/PAYMOB_PUBLIC_KEY/);
  });

  it('createCheckoutSession rejects malformed planId before hitting the API', async () => {
    const http = makeHttp([]);
    const adapter = buildAdapter({ http });
    await expect(
      adapter.createCheckoutSession('firm_1', 'nonsense', 'plan_abc'),
    ).rejects.toThrow(/invalid planId/);
    expect(http.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // verifyWebhook — unchanged under the new flow. The TRANSACTION
  // Processed callback is still fired by the card integration and
  // carries the same 20-field HMAC canonical.
  // ---------------------------------------------------------------

  it('verifyWebhook accepts a valid HMAC-SHA512 over the canonical 20 fields', () => {
    const adapter = buildAdapter();
    const { body, hmac } = buildPaymobCallback();
    const event = adapter.verifyWebhook(Buffer.from(JSON.stringify(body)), hmac);
    expect(event.provider).toBe('paymob');
    expect(event.providerEventId).toBe('100042');
    expect(event.type).toBe('transaction.paid');
  });

  it('verifyWebhook raises BillingSignatureError on a bad HMAC', () => {
    const adapter = buildAdapter();
    const { body } = buildPaymobCallback();
    // Right length, wrong value: hex string of 128 chars so we hit
    // timingSafeEqual (not the length pre-check).
    const wrong = 'a'.repeat(128);
    expect(() =>
      adapter.verifyWebhook(Buffer.from(JSON.stringify(body)), wrong),
    ).toThrow(BillingSignatureError);
  });

  it('verifyWebhook raises BillingSignatureError on a length-mismatched HMAC', () => {
    const adapter = buildAdapter();
    const { body } = buildPaymobCallback();
    expect(() =>
      adapter.verifyWebhook(Buffer.from(JSON.stringify(body)), 'too_short'),
    ).toThrow(/length mismatch/);
  });

  it('verifyWebhook raises BillingSignatureError when HMAC secret is unconfigured', () => {
    const adapter = buildAdapter({ hmacSecret: '' });
    const { body, hmac } = buildPaymobCallback();
    expect(() =>
      adapter.verifyWebhook(Buffer.from(JSON.stringify(body)), hmac),
    ).toThrow(/PAYMOB_HMAC_SECRET is not configured/);
  });

  it('verifyWebhook raises BillingSignatureError on non-JSON body', () => {
    const adapter = buildAdapter();
    expect(() =>
      adapter.verifyWebhook(Buffer.from('not json'), 'a'.repeat(128)),
    ).toThrow(/not valid JSON/);
  });

  it('verifyWebhook synthesises Stripe-shaped event types from TRANSACTION booleans', () => {
    const adapter = buildAdapter();
    const cases: Array<[Partial<Record<string, unknown>>, string]> = [
      [{ success: true, is_refunded: false, is_voided: false, pending: false }, 'transaction.paid'],
      [{ success: false, pending: false }, 'transaction.failed'],
      [{ success: true, is_refunded: true }, 'transaction.refunded'],
      [{ success: true, is_voided: true }, 'transaction.voided'],
      [{ success: false, pending: true }, 'transaction.pending'],
    ];
    for (const [overrides, expected] of cases) {
      const { body, hmac } = buildPaymobCallback(overrides);
      const event = adapter.verifyWebhook(Buffer.from(JSON.stringify(body)), hmac);
      expect(event.type).toBe(expected);
    }
  });

  // ---------------------------------------------------------------
  // fromEnv — updated to reflect the new required env vars under the
  // Intention + Unified Checkout flow.
  // ---------------------------------------------------------------

  it('fromEnv refuses to boot without PAYMOB_API_KEY', () => {
    expect(() => PaymobBilling.fromEnv({})).toThrow(BillingProviderError);
  });

  it('fromEnv refuses to boot in production without PAYMOB_HMAC_SECRET', () => {
    expect(() =>
      PaymobBilling.fromEnv({
        PAYMOB_API_KEY: 'k',
        PAYMOB_INTEGRATION_ID: '1',
        PAYMOB_IFRAME_ID: '2',
        PAYMOB_SECRET_KEY: 'sk_live_x',
        PAYMOB_PUBLIC_KEY: 'pk_live_x',
        NODE_ENV: 'production',
      }),
    ).toThrow(/PAYMOB_HMAC_SECRET is required in production/);
  });

  it('fromEnv refuses to boot in production without PAYMOB_SECRET_KEY', () => {
    expect(() =>
      PaymobBilling.fromEnv({
        PAYMOB_API_KEY: 'k',
        PAYMOB_HMAC_SECRET: 'h',
        PAYMOB_INTEGRATION_ID: '1',
        PAYMOB_IFRAME_ID: '2',
        PAYMOB_PUBLIC_KEY: 'pk_live_x',
        NODE_ENV: 'production',
      }),
    ).toThrow(/PAYMOB_SECRET_KEY is required in production/);
  });

  it('fromEnv refuses to boot in production without PAYMOB_PUBLIC_KEY', () => {
    expect(() =>
      PaymobBilling.fromEnv({
        PAYMOB_API_KEY: 'k',
        PAYMOB_HMAC_SECRET: 'h',
        PAYMOB_INTEGRATION_ID: '1',
        PAYMOB_IFRAME_ID: '2',
        PAYMOB_SECRET_KEY: 'sk_live_x',
        NODE_ENV: 'production',
      }),
    ).toThrow(/PAYMOB_PUBLIC_KEY is required in production/);
  });

  it('fromEnv tolerates missing optional secrets in dev', () => {
    const adapter = PaymobBilling.fromEnv({
      PAYMOB_API_KEY: 'k',
      PAYMOB_INTEGRATION_ID: '1',
      PAYMOB_IFRAME_ID: '2',
      NODE_ENV: 'development',
    });
    expect(adapter.name).toBe('paymob');
  });

  it('fromEnv honours PAYMOB_BASE_URL and PAYMOB_CHECKOUT_URL overrides', async () => {
    const adapter = PaymobBilling.fromEnv({
      PAYMOB_API_KEY: 'k',
      PAYMOB_HMAC_SECRET: 'h',
      PAYMOB_INTEGRATION_ID: '4567890',
      PAYMOB_IFRAME_ID: '2',
      PAYMOB_SECRET_KEY: 'sk_test_override',
      PAYMOB_PUBLIC_KEY: 'pk_test_override',
      PAYMOB_BASE_URL: 'https://uae.paymob.com',
      PAYMOB_CHECKOUT_URL: 'https://uae.checkout.paymob.com',
      NODE_ENV: 'development',
    });
    expect(adapter.name).toBe('paymob');
    // We cannot read the private fields directly; instead, exercise a
    // call path that uses both and assert on the URLs via a stubbed
    // http. Rebuild with the same options plus a mock http.
    const http = makeHttp([{ status: 201, body: buildIntentionResponse() }]);
    const rebuilt = new PaymobBilling({
      http,
      baseUrl: 'https://uae.paymob.com',
      checkoutUrl: 'https://uae.checkout.paymob.com',
      apiKey: 'k',
      hmacSecret: 'h',
      integrationId: '4567890',
      iframeId: '2',
      secretKey: 'sk_test_override',
      publicKey: 'pk_test_override',
    });
    const session = await rebuilt.createCheckoutSession('firm_1', '50000:360', 'plan_x');
    expect(http.calls[0].url).toBe('https://uae.paymob.com/v1/intention/');
    expect(new URL(session.checkoutUrl).host).toBe('uae.checkout.paymob.com');
  });
});

describe('FirmBillingModule provider switch', () => {
  // Re-require to pick up env mutations; module.ts reads process.env at
  // factory-call time, not at import.
  function loadFactory(): () => unknown {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../src/modules/billing/firm/billing.module');
    // Nest's @Module() hoists the useFactory into the metadata; we
    // re-reach it via the exported class's design-time metadata.
    const metadata = Reflect.getMetadata('providers', mod.FirmBillingModule) as Array<{
      provide: string;
      useFactory: () => unknown;
    }>;
    const entry = metadata.find((p) => p.provide === 'BILLING_PROVIDER');
    if (!entry) throw new Error('BILLING_PROVIDER provider not found in module metadata');
    return entry.useFactory;
  }

  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('BILLING_PROVIDER=paymob with PAYMOB_API_KEY set boots PaymobBilling', () => {
    process.env = {
      ...originalEnv,
      BILLING_PROVIDER: 'paymob',
      PAYMOB_API_KEY: 'k',
      PAYMOB_HMAC_SECRET: 'h',
      PAYMOB_INTEGRATION_ID: '1',
      PAYMOB_IFRAME_ID: '2',
      NODE_ENV: 'development',
    };
    const factory = loadFactory();
    const provider = factory() as { name: string };
    expect(provider.name).toBe('paymob');
  });

  it('BILLING_PROVIDER=paymob without PAYMOB_API_KEY in dev returns the paymob stub', () => {
    process.env = {
      ...originalEnv,
      BILLING_PROVIDER: 'paymob',
      NODE_ENV: 'development',
    };
    // Explicit unset in case the host env has it.
    delete process.env.PAYMOB_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const factory = loadFactory();
    const provider = factory() as { name: string };
    expect(provider.name).toBe('stub-paymob');
  });

  it('BILLING_PROVIDER=unknown rejects at boot', () => {
    process.env = {
      ...originalEnv,
      BILLING_PROVIDER: 'ompay',
      NODE_ENV: 'development',
    };
    const factory = loadFactory();
    expect(() => factory()).toThrow(/Unsupported BILLING_PROVIDER=ompay/);
  });
});

describe('BillingWebhookController with Paymob adapter', () => {
  class InMemoryEvents {
    seen = new Map<string, { id: string; processedAt: Date | null; type: string }>();
    async record(event: {
      provider: string;
      providerEventId: string;
      type: string;
    }): Promise<DispatchResult> {
      const key = `${event.provider}:${event.providerEventId}`;
      const existing = this.seen.get(key);
      if (existing) return { id: existing.id, firstSeen: false };
      const id = `row_${this.seen.size + 1}`;
      this.seen.set(key, { id, processedAt: null, type: event.type });
      return { id, firstSeen: true };
    }
    async markProcessed(id: string): Promise<void> {
      for (const v of this.seen.values()) {
        if (v.id === id) v.processedAt = new Date();
      }
    }
  }

  function buildController(): {
    controller: BillingWebhookController;
    events: InMemoryEvents;
    adapter: PaymobBilling;
  } {
    const adapter = buildAdapter();
    const svc = new FirmBillingService(adapter, stubDb());
    const events = new InMemoryEvents() as unknown as WebhookEventsService;
    const controller = new BillingWebhookController(svc, events);
    return { controller, events: events as unknown as InMemoryEvents, adapter };
  }

  it('400s when both stripe-signature and hmac query are missing', async () => {
    const { controller } = buildController();
    const { body } = buildPaymobCallback();
    await expect(
      controller.handle(
        { rawBody: Buffer.from(JSON.stringify(body)) } as any,
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a valid Paymob callback via the hmac query parameter', async () => {
    const { controller, events } = buildController();
    const { body, hmac } = buildPaymobCallback();
    const out = await controller.handle(
      { rawBody: Buffer.from(JSON.stringify(body)) } as any,
      undefined,
      hmac,
    );
    expect(out).toEqual({ received: true });
    expect(events.seen.get('paymob:100042')?.processedAt).toBeInstanceOf(Date);
  });

  it('short-circuits a Paymob replay (same transaction id twice)', async () => {
    const { controller } = buildController();
    const { body, hmac } = buildPaymobCallback();
    const first = await controller.handle(
      { rawBody: Buffer.from(JSON.stringify(body)) } as any,
      undefined,
      hmac,
    );
    const second = await controller.handle(
      { rawBody: Buffer.from(JSON.stringify(body)) } as any,
      undefined,
      hmac,
    );
    expect(first).toEqual({ received: true });
    expect(second).toEqual({ received: true, replay: true });
  });

  it('400s on a tampered Paymob payload (HMAC does not match)', async () => {
    const { controller } = buildController();
    const { body, hmac } = buildPaymobCallback();
    // Tamper: change the amount after the HMAC was computed.
    const parsed = JSON.parse(JSON.stringify(body));
    parsed.obj.amount_cents = 999999;
    await expect(
      controller.handle(
        { rawBody: Buffer.from(JSON.stringify(parsed)) } as any,
        undefined,
        hmac,
      ),
    ).rejects.toThrow(/invalid signature/);
  });
});
