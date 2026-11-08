import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditService } from './audit.service';

/**
 * Event payload shapes contributed by sibling EP5 Wave 2 agents.
 *
 * - W2-E (this agent) owns `firm.created` and `billing.*`.
 * - W2-C owns `firm.client.added` / `firm.client.revoked`.
 * - W2-D owns `firm.import.committed`.
 *
 * The fields here are the minimum this subscriber reads. Emitters MAY
 * pass additional fields; they land in the audit row's jsonb `payload`
 * unchanged so downstream readers (future UAE OTA export) get the full
 * context without a schema change.
 */
export interface FirmCreatedEvent {
  firmId: string;
  ownerUserId: string;
  firmName?: string;
  [k: string]: unknown;
}
export interface FirmClientAddedEvent {
  firmId: string;
  tenantId: string;
  createdByUserId: string;
  [k: string]: unknown;
}
export interface FirmClientRevokedEvent {
  firmId: string;
  tenantId: string;
  revokedByUserId: string;
  [k: string]: unknown;
}
export interface FirmImportCommittedEvent {
  firmId: string;
  tenantId: string;
  batchId: string;
  rowCount: number;
  actorUserId: string;
  [k: string]: unknown;
}
export interface BillingCustomerCreatedEvent {
  firmId: string;
  provider: string;
  providerCustomerId: string;
  [k: string]: unknown;
}
export interface BillingSubscriptionUpdatedEvent {
  firmId?: string;
  provider: string;
  providerSubscriptionId: string;
  providerCustomerId?: string;
  status?: string;
  [k: string]: unknown;
}

/**
 * AuditSubscribers — the audit log's write side.
 *
 * Every @OnEvent handler is defensive: a failure to append MUST NOT
 * break the business event that triggered it. We swallow and log so
 * the EventEmitter has nothing to re-throw back to the emitter.
 *
 * Each handler maps one event to one audit row with an event_type
 * matching the event name, which keeps the viewer filter on
 * event_type aligned with the EventEmitter wire names.
 */
@Injectable()
export class AuditSubscribers {
  private readonly log = new Logger(AuditSubscribers.name);

  constructor(private readonly audit: AuditService) {}

  @OnEvent('firm.created', { async: true, promisify: true })
  async onFirmCreated(evt: FirmCreatedEvent): Promise<void> {
    await this.safeRecord('firm.created', {
      firmId: evt.firmId,
      actorUserId: evt.ownerUserId,
      payload: this.stripKnown(evt, ['firmId', 'ownerUserId']),
    });
  }

  @OnEvent('firm.client.added', { async: true, promisify: true })
  async onFirmClientAdded(evt: FirmClientAddedEvent): Promise<void> {
    await this.safeRecord('firm.client.added', {
      firmId: evt.firmId,
      tenantId: evt.tenantId,
      actorUserId: evt.createdByUserId,
      payload: this.stripKnown(evt, ['firmId', 'tenantId', 'createdByUserId']),
    });
  }

  @OnEvent('firm.client.revoked', { async: true, promisify: true })
  async onFirmClientRevoked(evt: FirmClientRevokedEvent): Promise<void> {
    await this.safeRecord('firm.client.revoked', {
      firmId: evt.firmId,
      tenantId: evt.tenantId,
      actorUserId: evt.revokedByUserId,
      payload: this.stripKnown(evt, ['firmId', 'tenantId', 'revokedByUserId']),
    });
  }

  @OnEvent('firm.import.committed', { async: true, promisify: true })
  async onFirmImportCommitted(evt: FirmImportCommittedEvent): Promise<void> {
    await this.safeRecord('firm.import.committed', {
      firmId: evt.firmId,
      tenantId: evt.tenantId,
      actorUserId: evt.actorUserId,
      payload: this.stripKnown(evt, ['firmId', 'tenantId', 'actorUserId']),
    });
  }

  @OnEvent('billing.customer.created', { async: true, promisify: true })
  async onBillingCustomerCreated(evt: BillingCustomerCreatedEvent): Promise<void> {
    await this.safeRecord('billing.customer.created', {
      firmId: evt.firmId,
      payload: this.stripKnown(evt, ['firmId']),
    });
  }

  @OnEvent('billing.subscription.updated', { async: true, promisify: true })
  async onBillingSubscriptionUpdated(evt: BillingSubscriptionUpdatedEvent): Promise<void> {
    if (!evt.firmId) {
      // Subscription events that cannot be resolved to a firm (webhooks
      // that arrive before FirmBillingService has looked up the firm by
      // customer id) are deliberately not recorded. The resolver is in
      // the FirmBillingService.handle() dispatch and will re-emit with
      // firmId once it resolves.
      this.log.debug('billing.subscription.updated without firmId; skipping audit');
      return;
    }
    await this.safeRecord('billing.subscription.updated', {
      firmId: evt.firmId,
      payload: this.stripKnown(evt, ['firmId']),
    });
  }

  /**
   * Shared wrapper that never throws back to the EventEmitter. If the
   * audit write fails, we log and drop — the business event stays
   * committed.
   */
  private async safeRecord(
    eventType: string,
    args: {
      firmId: string;
      tenantId?: string;
      actorUserId?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.audit.record({
        firmId: args.firmId,
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        eventType,
        payload: args.payload,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(
        { eventType, firmId: args.firmId, err: msg },
        'audit record failed; business event is unaffected',
      );
    }
  }

  private stripKnown(
    evt: Record<string, unknown>,
    keys: readonly string[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(evt)) {
      if (keys.includes(k)) continue;
      out[k] = evt[k];
    }
    return out;
  }
}
