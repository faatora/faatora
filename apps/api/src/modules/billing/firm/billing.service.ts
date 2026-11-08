import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../../../db/db.module';
import { withFirm } from '../../../db/with-firm';
import { firms } from '../../../db/schema/firms';
import {
  BILLING_PROVIDER,
  BillingEvent,
  BillingProvider,
  BillingProviderError,
  ProviderCustomer,
  ProviderSubscription,
} from './billing.port';

/**
 * Legacy direct-call shape kept so existing callers that pass a bare
 * `{id, name, billingEmail}` keep compiling. The real production entry
 * point is the @OnEvent('firm.created') handler below.
 */
export interface FirmBillingShape {
  readonly id: string;
  readonly name?: string;
  readonly billingEmail?: string;
  readonly ownerUserId?: string;
}

/**
 * Event shape FirmsService.createFirm emits. The matching audit side
 * shape lives in apps/api/src/modules/audit/audit.subscribers.ts.
 */
export interface FirmCreatedEvent {
  firmId: string;
  ownerUserId: string;
  firmName?: string;
  billingEmail?: string;
}

/**
 * FirmBillingService: consumer-facing façade over the BillingProvider.
 *
 * Controllers and modules import this; they must not import StripeBilling
 * or PaymobBilling directly. The provider is swappable via BILLING_PROVIDER
 * DI (see billing.module.ts for the env-driven factory).
 *
 * EP5 Wave 2 (W2-E) resolves the Wave 1 TODO: this service now subscribes
 * to `firm.created` and persists the returned providerCustomerId onto
 * the firms row in the matching stripe_customer_id or paymob_customer_id
 * column. It also emits `billing.customer.created` so the audit subscriber
 * records the moment a firm gets a provider identity.
 */
@Injectable()
export class FirmBillingService {
  private readonly log = new Logger(FirmBillingService.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(DB) private readonly db: Database,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /**
   * Firm lifecycle hook — invoked by the EventEmitter when
   * FirmsService.createFirm fires `firm.created`, and directly callable
   * by tests + legacy callers with a FirmBillingShape.
   *
   * Flow (EP5 Wave 2 W2-E):
   *   1. If the active provider is in dev/UAT stub mode (no credentials
   *      configured), log a warning and return. The firm row stands —
   *      this is the documented "firm can be created without billing"
   *      path in dev/UAT.
   *   2. Call BillingProvider.createCustomer with firm id + metadata.
   *   3. Persist the returned providerCustomerId onto the matching
   *      firms column via withFirm so RLS firms_self_isolation still
   *      gates the UPDATE.
   *   4. Emit `billing.customer.created` so the audit subscriber
   *      records who got provisioned on which provider.
   *
   * Defensive posture: a provider error, a persistence error, or a
   * misconfiguration must NOT throw back into the EventEmitter — that
   * would surface as an unhandled rejection in Nest's dispatcher and
   * make the firm look un-created even though the firm row exists.
   * All failures are logged and swallowed inside the handler.
   */
  @OnEvent('firm.created', { async: true, promisify: true })
  async onFirmCreated(
    event: FirmCreatedEvent | FirmBillingShape,
  ): Promise<ProviderCustomer | null> {
    // Normalise both legacy FirmBillingShape and the event payload into
    // one local view.
    const asEvent = event as Partial<FirmCreatedEvent> & Partial<FirmBillingShape>;
    const firmId = asEvent.firmId ?? asEvent.id;
    const firmName = asEvent.firmName ?? asEvent.name;
    const billingEmail = asEvent.billingEmail;
    const ownerUserId = asEvent.ownerUserId;

    if (!firmId) {
      this.log.warn('onFirmCreated: event missing firmId; ignoring');
      return null;
    }

    // Detect the dev/UAT stub providers wired by billing.module.ts when
    // credential env vars are missing. The factory names them exactly
    // `stub-stripe` / `stub-paymob`; we match that set only so a test
    // provider with an arbitrary "stub-for-tests" name still runs
    // through the real happy path.
    if (this.provider.name === 'stub-stripe' || this.provider.name === 'stub-paymob') {
      this.log.warn(
        { firmId, provider: this.provider.name },
        'billing provider is in stub mode (credentials env not set); skipping customer creation',
      );
      return null;
    }

    this.log.log({ firmId, provider: this.provider.name }, 'creating provider customer for firm');

    let customer: ProviderCustomer;
    try {
      const metadata: Record<string, string | undefined> = { name: firmName };
      if (billingEmail) metadata.email = billingEmail;
      if (ownerUserId) metadata.ownerUserId = ownerUserId;
      customer = await this.provider.createCustomer(firmId, metadata);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(
        { firmId, provider: this.provider.name, err: msg },
        'BillingProvider.createCustomer failed; firm exists without a provider customer',
      );
      return null;
    }

    try {
      await this.persistCustomerId(firmId, this.provider.name, customer.providerCustomerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(
        { firmId, provider: this.provider.name, err: msg },
        'failed to persist providerCustomerId onto firm row; provider state is leading local state',
      );
      // Still emit so the audit log records that the provider knows the
      // firm, even if our row is stale.
    }

    // Fan out to the audit subscriber. Fire-and-forget by design.
    this.events?.emit('billing.customer.created', {
      firmId,
      provider: this.provider.name,
      providerCustomerId: customer.providerCustomerId,
    });

    return customer;
  }

  async subscribe(
    providerCustomerId: string,
    planId: string,
    trialDays?: number,
  ): Promise<ProviderSubscription> {
    return this.provider.createSubscription(providerCustomerId, planId, trialDays);
  }

  async cancel(providerSubscriptionId: string): Promise<void> {
    await this.provider.cancelSubscription(providerSubscriptionId);
  }

  async portalUrl(providerCustomerId: string, returnUrl: string): Promise<string> {
    return this.provider.getCustomerPortalUrl(providerCustomerId, returnUrl);
  }

  verifyWebhook(rawBody: Buffer, signature: string): BillingEvent {
    return this.provider.verifyWebhook(rawBody, signature);
  }

  /**
   * Routes a verified event to the right domain handler. Every branch
   * is a no-op shell until downstream Wave 3 wires subscription state
   * onto the firm; W2-E adds an audit emission so the subscription
   * webhook stream shows up in the firm audit log immediately.
   */
  async handle(event: BillingEvent): Promise<void> {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        this.log.log(
          { eventId: event.providerEventId, type: event.type },
          'subscription state change; TODO wire to FirmsService.setSubscription',
        );
        this.emitSubscriptionUpdated(event);
        return;
      case 'customer.subscription.deleted':
        this.log.log(
          { eventId: event.providerEventId },
          'subscription canceled; TODO flip firm entitlement to canceled',
        );
        this.emitSubscriptionUpdated(event);
        return;
      case 'customer.subscription.trial_will_end':
        this.log.log(
          { eventId: event.providerEventId },
          'trial ending soon; TODO send reminder email 3d out',
        );
        return;
      case 'invoice.paid':
        this.log.log(
          { eventId: event.providerEventId },
          'invoice.paid; TODO extend firm access to paid period end',
        );
        return;
      case 'invoice.payment_failed':
        this.log.warn(
          { eventId: event.providerEventId },
          'invoice.payment_failed; TODO dunning flow',
        );
        return;
      case 'invoice.finalized':
        this.log.log(
          { eventId: event.providerEventId },
          'invoice.finalized; TODO store hosted_invoice_url for firm invoice history',
        );
        return;
      case 'checkout.session.completed':
        this.log.log(
          { eventId: event.providerEventId },
          'checkout.session.completed; TODO attach customer+subscription to firm',
        );
        return;
      // ------------------------------------------------------------------
      // Paymob branch. Paymob has no discrete event types; the adapter
      // synthesises these from the TRANSACTION callback booleans. See
      // docs/research/paymob-uat-integration-plan.md section 6.3.
      // ------------------------------------------------------------------
      case 'transaction.paid':
        this.log.log(
          { eventId: event.providerEventId },
          'paymob transaction.paid; TODO extend firm access to paid period end',
        );
        this.emitSubscriptionUpdated(event);
        return;
      case 'transaction.failed':
        this.log.warn(
          { eventId: event.providerEventId },
          'paymob transaction.failed; TODO dunning flow',
        );
        return;
      case 'transaction.refunded':
        this.log.log(
          { eventId: event.providerEventId },
          'paymob transaction.refunded; TODO reverse firm access window',
        );
        this.emitSubscriptionUpdated(event);
        return;
      case 'transaction.voided':
        this.log.log(
          { eventId: event.providerEventId },
          'paymob transaction.voided; TODO cancel firm subscription',
        );
        this.emitSubscriptionUpdated(event);
        return;
      case 'transaction.pending':
        this.log.debug(
          { eventId: event.providerEventId },
          'paymob transaction.pending; TODO track as in-flight',
        );
        return;
      default:
        this.log.debug(
          { eventId: event.providerEventId, type: event.type },
          'unhandled provider event (recorded for idempotency, no business handler)',
        );
    }
  }

  /**
   * Best-effort lookup from provider customer id to firm id. The webhook
   * path has already verified the signature, so this is a trusted
   * provider-side identifier. Executed outside withFirm because we do
   * not yet know which firm to set app.firm_id to. If RLS strips the
   * row we return null and the audit row is skipped.
   */
  async resolveFirmByCustomer(
    providerName: string,
    providerCustomerId: string,
  ): Promise<string | null> {
    try {
      const col = providerName === 'paymob' ? 'paymob_customer_id' : 'stripe_customer_id';
      // Parameter binding: we build a column-name string from a fixed
      // allow-list and bind the value properly.
      const res = await this.db.execute(
        sql`SELECT id FROM firms WHERE ${sql.identifier(col)} = ${providerCustomerId} LIMIT 1`,
      );
      const row = res.rows[0] as { id: string } | undefined;
      return row?.id ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug({ err: msg }, 'resolveFirmByCustomer failed; returning null');
      return null;
    }
  }

  /**
   * Shared persistence step for onFirmCreated. Writes
   * stripe_customer_id or paymob_customer_id onto the firm row under
   * `withFirm` so the RLS firms_self_isolation policy still gates the
   * UPDATE. Idempotent on the (firm, provider) pair thanks to the
   * partial unique index on each column.
   */
  private async persistCustomerId(
    firmId: string,
    providerName: string,
    providerCustomerId: string,
  ): Promise<void> {
    await withFirm(this.db, firmId, async (tx) => {
      if (providerName === 'stripe') {
        await tx
          .update(firms)
          .set({ stripeCustomerId: providerCustomerId })
          .where(eq(firms.id, firmId));
        return;
      }
      if (providerName === 'paymob') {
        await tx
          .update(firms)
          .set({ paymobCustomerId: providerCustomerId })
          .where(eq(firms.id, firmId));
        return;
      }
      throw new BillingProviderError(
        `Cannot persist providerCustomerId for unknown provider "${providerName}"`,
      );
    });
  }

  /**
   * Fan out an audit event for a subscription-shaped webhook. The audit
   * subscriber tolerates a missing firmId (drops the row with a debug
   * log) so a webhook for an unknown customer id does not need special
   * casing here.
   */
  private emitSubscriptionUpdated(event: BillingEvent): void {
    if (!this.events) return;
    const data = event.data as Record<string, unknown>;
    // Stripe shape:   data.object.customer, data.object.id, data.object.status
    // Paymob shape:   data (the transaction obj itself) has id + status_fields
    const object = (data?.object as Record<string, unknown> | undefined) ?? data;
    const providerCustomerId = object?.customer ?? object?.customer_id;
    const providerSubscriptionId = object?.id;
    const status = object?.status;

    const dispatch = (firmId?: string): void => {
      this.events?.emit('billing.subscription.updated', {
        firmId,
        provider: event.provider,
        providerSubscriptionId: providerSubscriptionId ? String(providerSubscriptionId) : '',
        providerCustomerId: providerCustomerId ? String(providerCustomerId) : undefined,
        status: typeof status === 'string' ? status : undefined,
        providerEventId: event.providerEventId,
      });
    };
    if (providerCustomerId) {
      this.resolveFirmByCustomer(event.provider, String(providerCustomerId))
        .then((firmId) => dispatch(firmId ?? undefined))
        .catch(() => dispatch(undefined));
    } else {
      dispatch(undefined);
    }
  }
}
