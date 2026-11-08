import { BadRequestException } from '@nestjs/common';
import type Stripe from 'stripe';
import {
  BillingEvent,
  BillingProvider,
  BillingProviderError,
  BillingSignatureError,
  ProviderCustomer,
  ProviderSubscription,
} from '../src/modules/billing/firm/billing.port';
import { StripeBilling, type StripeLike } from '../src/modules/billing/firm/stripe-billing';
import { FirmBillingService } from '../src/modules/billing/firm/billing.service';
import { BillingWebhookController } from '../src/modules/billing/firm/webhook.controller';
import type { WebhookEventsService, DispatchResult } from '../src/modules/billing/firm/webhook-events.service';

// Minimal in-memory mock of the stripe SDK. Only the methods the
// adapter actually uses are implemented. `webhooks.constructEvent` is
// configurable so tests can simulate signature pass/fail.
function makeStripeMock(overrides: Partial<StripeLike> = {}): StripeLike & {
  calls: {
    customers: { create: Array<{ params: Stripe.CustomerCreateParams; options?: { idempotencyKey?: string } }> };
    subscriptions: {
      create: Array<{ params: Stripe.SubscriptionCreateParams; options?: { idempotencyKey?: string } }>;
      cancel: string[];
    };
    portal: Array<Stripe.BillingPortal.SessionCreateParams>;
    webhookConstruct: Array<{ payload: string | Buffer; sig: string | string[]; secret: string }>;
  };
} {
  const calls = {
    customers: { create: [] as Array<{ params: Stripe.CustomerCreateParams; options?: { idempotencyKey?: string } }> },
    subscriptions: {
      create: [] as Array<{ params: Stripe.SubscriptionCreateParams; options?: { idempotencyKey?: string } }>,
      cancel: [] as string[],
    },
    portal: [] as Array<Stripe.BillingPortal.SessionCreateParams>,
    webhookConstruct: [] as Array<{ payload: string | Buffer; sig: string | string[]; secret: string }>,
  };
  const base: StripeLike = {
    customers: {
      async create(params, options) {
        calls.customers.create.push({ params, options });
        return {
          id: 'cus_test_123',
          email: params.email ?? null,
          metadata: params.metadata ?? {},
        } as unknown as Stripe.Customer;
      },
    },
    subscriptions: {
      async create(params, options) {
        calls.subscriptions.create.push({ params, options });
        const now = Math.floor(Date.now() / 1000);
        return {
          id: 'sub_test_123',
          status: 'trialing' as Stripe.Subscription.Status,
          current_period_start: now,
          current_period_end: now + 30 * 24 * 3600,
          cancel_at_period_end: false,
        } as unknown as Stripe.Subscription;
      },
      async cancel(id) {
        calls.subscriptions.cancel.push(id);
        return { id, status: 'canceled' } as unknown as Stripe.Subscription;
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          calls.portal.push(params);
          return { url: `https://billing.stripe.com/p/session/${params.customer}` } as unknown as Stripe.BillingPortal.Session;
        },
      },
    },
    webhooks: {
      constructEvent(payload, sig, secret) {
        calls.webhookConstruct.push({ payload, sig, secret });
        // Default: valid signature returns a canned event.
        return {
          id: 'evt_test_1',
          type: 'customer.subscription.created',
          created: Math.floor(Date.now() / 1000),
          data: { object: { id: 'sub_test_123' } },
        } as unknown as Stripe.Event;
      },
    },
  };
  return Object.assign(base, overrides, { calls }) as ReturnType<typeof makeStripeMock>;
}

describe('StripeBilling adapter', () => {
  it('createCustomer maps to a ProviderCustomer and uses a stable idempotency key', async () => {
    const mock = makeStripeMock();
    const adapter = new StripeBilling({ stripe: mock, webhookSecret: 'whsec_dev' });
    const firmId = '00000000-0000-0000-0000-000000000001';
    const got: ProviderCustomer = await adapter.createCustomer(firmId, {
      email: 'ops@firm.om',
      name: 'Al Hajar Audit',
    });
    expect(got.providerCustomerId).toBe('cus_test_123');
    expect(got.email).toBe('ops@firm.om');
    expect(mock.calls.customers.create).toHaveLength(1);
    expect(mock.calls.customers.create[0].options?.idempotencyKey).toBe(`firm:${firmId}:create-customer`);
    expect(mock.calls.customers.create[0].params.metadata).toMatchObject({ firm_id: firmId });
  });

  it('createCustomer wraps underlying errors as BillingProviderError', async () => {
    const mock = makeStripeMock({
      customers: {
        async create() {
          throw new Error('stripe side boom');
        },
      },
    });
    const adapter = new StripeBilling({ stripe: mock, webhookSecret: 'whsec_dev' });
    await expect(adapter.createCustomer('f1', {})).rejects.toBeInstanceOf(BillingProviderError);
  });

  it('createSubscription maps timestamps to Date and keeps planId on the port shape', async () => {
    const mock = makeStripeMock();
    const adapter = new StripeBilling({ stripe: mock, webhookSecret: 'whsec_dev' });
    const got: ProviderSubscription = await adapter.createSubscription('cus_1', 'price_firm_pro_annual', 14);
    expect(got.providerSubscriptionId).toBe('sub_test_123');
    expect(got.planId).toBe('price_firm_pro_annual');
    expect(got.status).toBe('trialing');
    expect(got.currentPeriodEnd.getTime()).toBeGreaterThan(got.currentPeriodStart.getTime());
    expect(mock.calls.subscriptions.create[0].params.trial_period_days).toBe(14);
    expect(mock.calls.subscriptions.create[0].options?.idempotencyKey).toBe('cust:cus_1:sub:price_firm_pro_annual');
  });

  it('cancelSubscription forwards the id', async () => {
    const mock = makeStripeMock();
    const adapter = new StripeBilling({ stripe: mock, webhookSecret: 'whsec_dev' });
    await adapter.cancelSubscription('sub_abc');
    expect(mock.calls.subscriptions.cancel).toEqual(['sub_abc']);
  });

  it('getCustomerPortalUrl returns the session url', async () => {
    const mock = makeStripeMock();
    const adapter = new StripeBilling({ stripe: mock, webhookSecret: 'whsec_dev' });
    const url = await adapter.getCustomerPortalUrl('cus_42', 'https://app.faatora.om/firm');
    expect(url).toBe('https://billing.stripe.com/p/session/cus_42');
    expect(mock.calls.portal[0].return_url).toBe('https://app.faatora.om/firm');
  });

  it('verifyWebhook returns a provider-agnostic BillingEvent on valid signature', async () => {
    const mock = makeStripeMock();
    const adapter = new StripeBilling({ stripe: mock, webhookSecret: 'whsec_dev' });
    const event: BillingEvent = adapter.verifyWebhook(Buffer.from('{"id":"evt_x"}'), 't=1,v1=sig');
    expect(event.provider).toBe('stripe');
    expect(event.providerEventId).toBe('evt_test_1');
    expect(event.type).toBe('customer.subscription.created');
    expect(mock.calls.webhookConstruct[0].secret).toBe('whsec_dev');
  });

  it('verifyWebhook raises BillingSignatureError when stripe rejects the sig', async () => {
    const mock = makeStripeMock({
      webhooks: {
        constructEvent() {
          throw new Error('No signatures found matching the expected signature for payload');
        },
      },
    });
    const adapter = new StripeBilling({ stripe: mock, webhookSecret: 'whsec_dev' });
    expect(() => adapter.verifyWebhook(Buffer.from('{}'), 'bogus')).toThrow(BillingSignatureError);
  });

  it('verifyWebhook raises BillingSignatureError when webhook secret is missing', () => {
    const mock = makeStripeMock();
    const adapter = new StripeBilling({ stripe: mock, webhookSecret: '' });
    expect(() => adapter.verifyWebhook(Buffer.from('{}'), 'anything')).toThrow(BillingSignatureError);
  });

  it('fromEnv refuses to boot without STRIPE_SECRET_KEY', () => {
    expect(() => StripeBilling.fromEnv({})).toThrow(BillingProviderError);
  });

  it('fromEnv refuses to boot in production without a webhook secret', () => {
    expect(() =>
      StripeBilling.fromEnv({ STRIPE_SECRET_KEY: 'sk_live_x', NODE_ENV: 'production' }),
    ).toThrow(BillingProviderError);
  });

  it('fromEnv tolerates a missing webhook secret in dev', () => {
    const adapter = StripeBilling.fromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', NODE_ENV: 'development' });
    expect(adapter.name).toBe('stripe');
  });
});

/**
 * Minimal Database stub used by billing.service tests that do not exercise
 * the UPDATE firms path. The withFirm-wrapped UPDATE in onFirmCreated
 * runs through the stub provider branch (provider.name starts with
 * 'stub-'), so most of these tests never reach `db.transaction`. For
 * tests that do (the W2-E onFirmCreated-persistence tests below), a
 * richer in-memory stub with a pg.Pool is wired up inline.
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

describe('FirmBillingService dispatch', () => {
  function makeProvider(): BillingProvider & { verifyCalls: Array<{ raw: Buffer; sig: string }> } {
    const verifyCalls: Array<{ raw: Buffer; sig: string }> = [];
    return {
      name: 'stub-for-tests',
      verifyCalls,
      async createCustomer(firmId) {
        return { providerCustomerId: `cus_for_${firmId}`, email: null };
      },
      async createSubscription(cus, plan) {
        return {
          providerCustomerId: cus,
          providerSubscriptionId: `sub_${plan}`,
          status: 'active',
          planId: plan,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 86400000),
          cancelAtPeriodEnd: false,
        };
      },
      async cancelSubscription() {
        /* noop */
      },
      async getCustomerPortalUrl() {
        return 'https://portal.example/session';
      },
      verifyWebhook(raw, sig) {
        verifyCalls.push({ raw, sig });
        return {
          provider: 'stub',
          providerEventId: 'evt_1',
          type: 'invoice.paid',
          createdAt: new Date(),
          data: {},
        };
      },
    };
  }

  it('onFirmCreated calls the provider with firm metadata', async () => {
    const provider = makeProvider();
    const svc = new FirmBillingService(provider, stubDb());
    const customer = await svc.onFirmCreated({ id: 'firm-42', name: 'X', billingEmail: 'x@y' });
    expect(customer?.providerCustomerId).toBe('cus_for_firm-42');
  });

  it('handle routes known events without throwing', async () => {
    const provider = makeProvider();
    const svc = new FirmBillingService(provider, stubDb());
    const types = [
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'customer.subscription.trial_will_end',
      'invoice.paid',
      'invoice.payment_failed',
      'invoice.finalized',
      'checkout.session.completed',
      'some.unhandled.event',
    ];
    for (const type of types) {
      await expect(
        svc.handle({ provider: 'stripe', providerEventId: `evt_${type}`, type, createdAt: new Date(), data: {} }),
      ).resolves.toBeUndefined();
    }
  });
});

describe('BillingWebhookController', () => {
  // In-memory impl of WebhookEventsService to simulate the DB-backed one.
  class InMemoryEvents {
    seen = new Map<string, { id: string; processedAt: Date | null; type: string }>();
    async record(event: BillingEvent): Promise<DispatchResult> {
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

  function makeRawReq(body: unknown): { rawBody: Buffer } {
    return { rawBody: Buffer.from(JSON.stringify(body)) };
  }

  function buildController(opts?: {
    verify?: (raw: Buffer, sig: string) => BillingEvent;
    handle?: (event: BillingEvent) => Promise<void>;
  }) {
    const handleCalls: BillingEvent[] = [];
    const svc = {
      verifyWebhook:
        opts?.verify ??
        ((raw: Buffer, _sig: string): BillingEvent => ({
          provider: 'stripe',
          providerEventId: JSON.parse(raw.toString()).id ?? 'evt_default',
          type: JSON.parse(raw.toString()).type ?? 'invoice.paid',
          createdAt: new Date(),
          data: {},
        })),
      handle: async (event: BillingEvent) => {
        handleCalls.push(event);
        if (opts?.handle) await opts.handle(event);
      },
    } as unknown as FirmBillingService;
    const events = new InMemoryEvents() as unknown as WebhookEventsService;
    const controller = new BillingWebhookController(svc, events);
    return { controller, events: events as unknown as InMemoryEvents, handleCalls };
  }

  it('400s when both signature sources are missing', async () => {
    const { controller } = buildController();
    await expect(
      controller.handle(makeRawReq({ id: 'evt_1' }) as any, undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s when the raw body is missing (rawBody misconfigured)', async () => {
    const { controller } = buildController();
    await expect(
      controller.handle({} as any, 't=1,v1=x', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s with "invalid signature" when verifyWebhook raises BillingSignatureError', async () => {
    const { controller } = buildController({
      verify: () => {
        throw new BillingSignatureError('bad sig');
      },
    });
    await expect(
      controller.handle(makeRawReq({ id: 'evt_x' }) as any, 't=1,v1=bad', undefined),
    ).rejects.toThrow(/invalid signature/);
  });

  it('accepts a first-seen event, routes it, and marks processed', async () => {
    const { controller, events, handleCalls } = buildController();
    const out = await controller.handle(
      makeRawReq({ id: 'evt_42', type: 'invoice.paid' }) as any,
      't=1,v1=good',
      undefined,
    );
    expect(out).toEqual({ received: true });
    expect(handleCalls).toHaveLength(1);
    expect(handleCalls[0].providerEventId).toBe('evt_42');
    expect(events.seen.get('stripe:evt_42')?.processedAt).toBeInstanceOf(Date);
  });

  it('short-circuits a replay . same provider_event_id is a no-op the second time', async () => {
    const { controller, handleCalls } = buildController();
    const req1 = makeRawReq({ id: 'evt_dup', type: 'invoice.paid' });
    const req2 = makeRawReq({ id: 'evt_dup', type: 'invoice.paid' });
    const first = await controller.handle(req1 as any, 't=1,v1=good', undefined);
    const second = await controller.handle(req2 as any, 't=1,v1=good', undefined);
    expect(first).toEqual({ received: true });
    expect(second).toEqual({ received: true, replay: true });
    // handle() ran exactly once across the two deliveries
    expect(handleCalls).toHaveLength(1);
  });

  it('does not mark processed when the handler throws (lets Stripe retry)', async () => {
    const { controller, events } = buildController({
      handle: async () => {
        throw new Error('db down');
      },
    });
    await expect(
      controller.handle(
        makeRawReq({ id: 'evt_boom', type: 'invoice.paid' }) as any,
        't=1,v1=good',
        undefined,
      ),
    ).rejects.toThrow(/db down/);
    const row = events.seen.get('stripe:evt_boom');
    expect(row?.processedAt).toBeNull();
  });
});

/**
 * EP5 Wave 2 (W2-E) — billing wire-up tests.
 *
 * Covers the TODO(ep5-wave1) resolution:
 *   - FirmBillingService.onFirmCreated is an @OnEvent('firm.created')
 *     handler that calls BillingProvider.createCustomer with firm
 *     metadata and persists the returned providerCustomerId.
 *   - The returned providerCustomerId lands on the correct column
 *     (stripe_customer_id or paymob_customer_id) per provider.name.
 *   - Env missing (stub provider) → firm still "created", no customer
 *     attempt, warning logged, no throw.
 *   - billing.customer.created is emitted after a successful create.
 */
describe('FirmBillingService.onFirmCreated — W2-E wire-up', () => {
  /**
   * In-memory shim of the drizzle Database that records UPDATE calls
   * and returns configurable rows for SELECTs. The real withFirm
   * wrapper runs tx.execute (SET LOCAL app.firm_id = '...') then the
   * provided callback; we mimic that lifecycle one step at a time.
   */
  function makeRecordingDb(): {
    db: any;
    updates: Array<{ stripeCustomerId?: string | null; paymobCustomerId?: string | null }>;
    setConfigs: string[];
  } {
    const updates: Array<{ stripeCustomerId?: string | null; paymobCustomerId?: string | null }> =
      [];
    const setConfigs: string[] = [];
    const tx = {
      execute: async (q: any) => {
        // Capture SET LOCAL app.firm_id = '<uuid>' from withFirm so we
        // can assert the right firm context was set.
        const text = q?.queryChunks
          ? q.queryChunks
              .map((c: any) => (typeof c === 'string' ? c : c.value ?? ''))
              .join('')
          : String(q);
        setConfigs.push(text);
        return { rows: [] };
      },
      update: () => ({
        set: (v: { stripeCustomerId?: string | null; paymobCustomerId?: string | null }) => {
          updates.push(v);
          return { where: async () => ({ rows: [] }) };
        },
      }),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    };
    const db = {
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
      execute: async () => ({ rows: [] }),
    };
    return { db, updates, setConfigs };
  }

  function makeProvider(name: 'stripe' | 'paymob' | 'stub-stripe' | 'stub-paymob') {
    const customerCalls: Array<{ firmId: string; metadata: Record<string, unknown> }> = [];
    const provider: BillingProvider & {
      customerCalls: typeof customerCalls;
    } = {
      name,
      customerCalls,
      async createCustomer(firmId, metadata) {
        customerCalls.push({ firmId, metadata: metadata as Record<string, unknown> });
        return {
          providerCustomerId: name === 'paymob' ? `firm_${firmId}` : `cus_${firmId}`,
          email: (metadata.email as string | undefined) ?? null,
        };
      },
      async createSubscription() {
        throw new Error('not used');
      },
      async cancelSubscription() {
        /* noop */
      },
      async getCustomerPortalUrl() {
        return 'https://example';
      },
      verifyWebhook() {
        throw new Error('not used');
      },
    };
    return provider;
  }

  it('firm.created invokes BillingProvider.createCustomer with the firm metadata', async () => {
    const provider = makeProvider('stripe');
    const { db } = makeRecordingDb();
    const svc = new FirmBillingService(provider, db);
    const result = await svc.onFirmCreated({
      firmId: 'f-100',
      ownerUserId: 'u-1',
      firmName: 'Test Firm',
    });
    expect(result?.providerCustomerId).toBe('cus_f-100');
    expect(provider.customerCalls).toHaveLength(1);
    expect(provider.customerCalls[0].firmId).toBe('f-100');
    expect(provider.customerCalls[0].metadata).toMatchObject({
      name: 'Test Firm',
      ownerUserId: 'u-1',
    });
  });

  it('persists providerCustomerId to firms.stripe_customer_id when provider is stripe', async () => {
    const provider = makeProvider('stripe');
    const { db, updates } = makeRecordingDb();
    const svc = new FirmBillingService(provider, db);
    await svc.onFirmCreated({ firmId: 'f-101', ownerUserId: 'u-1', firmName: 'F' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ stripeCustomerId: 'cus_f-101' });
  });

  it('persists providerCustomerId to firms.paymob_customer_id when provider is paymob', async () => {
    const provider = makeProvider('paymob');
    const { db, updates } = makeRecordingDb();
    const svc = new FirmBillingService(provider, db);
    const got = await svc.onFirmCreated({ firmId: 'f-102', ownerUserId: 'u-1', firmName: 'F2' });
    expect(got?.providerCustomerId).toBe('firm_f-102');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ paymobCustomerId: 'firm_f-102' });
  });

  it('stub-stripe provider skips the createCustomer call and does not throw', async () => {
    const provider = makeProvider('stub-stripe');
    const { db, updates } = makeRecordingDb();
    const svc = new FirmBillingService(provider, db);
    const result = await svc.onFirmCreated({
      firmId: 'f-103',
      ownerUserId: 'u-1',
      firmName: 'NoCreds',
    });
    expect(result).toBeNull();
    expect(provider.customerCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('stub-paymob provider skips the createCustomer call too', async () => {
    const provider = makeProvider('stub-paymob');
    const { db, updates } = makeRecordingDb();
    const svc = new FirmBillingService(provider, db);
    const result = await svc.onFirmCreated({ firmId: 'f-104', ownerUserId: 'u', firmName: 'P' });
    expect(result).toBeNull();
    expect(provider.customerCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('emits billing.customer.created on a successful persist', async () => {
    const provider = makeProvider('stripe');
    const { db } = makeRecordingDb();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const events = {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
        return true;
      },
    } as any;
    const svc = new FirmBillingService(provider, db, events);
    await svc.onFirmCreated({ firmId: 'f-105', ownerUserId: 'u-1', firmName: 'E' });
    const billing = emitted.filter((e) => e.event === 'billing.customer.created');
    expect(billing).toHaveLength(1);
    expect(billing[0].payload).toMatchObject({
      firmId: 'f-105',
      provider: 'stripe',
      providerCustomerId: 'cus_f-105',
    });
  });

  it('a provider.createCustomer failure does not throw — firm still exists', async () => {
    const provider = makeProvider('stripe');
    provider.createCustomer = async () => {
      throw new Error('stripe is down');
    };
    const { db, updates } = makeRecordingDb();
    const svc = new FirmBillingService(provider, db);
    const result = await svc.onFirmCreated({
      firmId: 'f-106',
      ownerUserId: 'u-1',
      firmName: 'Boom',
    });
    expect(result).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('event payload missing firmId is a no-op (defensive)', async () => {
    const provider = makeProvider('stripe');
    const { db } = makeRecordingDb();
    const svc = new FirmBillingService(provider, db);
    const result = await svc.onFirmCreated({} as any);
    expect(result).toBeNull();
    expect(provider.customerCalls).toHaveLength(0);
  });
});
