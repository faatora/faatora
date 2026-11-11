import { Injectable, Logger } from '@nestjs/common';

/**
 * PagerDuty Events API v2 client.
 *
 * Posts `trigger` / `acknowledge` / `resolve` actions to
 * `https://events.pagerduty.com/v2/enqueue` using the service
 * integration key configured as `PAGERDUTY_ROUTING_KEY`.
 *
 * All methods are safe no-ops when the routing key is unset: we log a
 * warning once at first use and resolve with `null`. That keeps the
 * service wire-able into code paths that may run in environments
 * (local dev, CI, free-tier staging) that are not paging anyone.
 *
 * Severity mapping follows the Events API spec: critical | error |
 * warning | info.
 *
 * `dedup_key` is how PagerDuty threads subsequent events to the same
 * alert. Callers that want to resolve an alert they triggered must
 * remember the key they used (we return the one we generated when
 * the caller did not supply one).
 */

export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

export interface PagerDutyTriggerInput {
  /** One-line human summary; required by the API, shown on the pager. */
  summary: string;
  severity: PagerDutySeverity;
  /** Where the alert originated — hostname, service name, etc. */
  source: string;
  /** Freeform structured context visible in the PagerDuty incident. */
  customDetails?: Record<string, unknown>;
  /**
   * Caller-chosen key for deduplication. Two triggers with the same
   * key within an open window append to the same incident. Omit to
   * get a server-generated UUID back on the result.
   */
  dedupKey?: string;
  /** Component inside `source` (e.g. "billing-webhook"). Optional. */
  component?: string;
  /** Logical grouping (e.g. "staging"). Optional. */
  group?: string;
  /** Alert class (e.g. "exception"). Optional. */
  class?: string;
}

export interface PagerDutyEnqueueResult {
  status: 'success';
  message: string;
  dedup_key: string;
}

@Injectable()
export class PagerDutyService {
  private readonly log = new Logger(PagerDutyService.name);
  private readonly endpoint = 'https://events.pagerduty.com/v2/enqueue';
  private warnedUnconfigured = false;

  /**
   * Fire a `trigger` event. Returns the dedup_key PagerDuty assigned
   * (or echoed back), or `null` when the client is unconfigured.
   */
  async trigger(input: PagerDutyTriggerInput): Promise<string | null> {
    const routingKey = this.routingKey();
    if (!routingKey) return null;

    const payload = this.buildTriggerPayload(routingKey, input);
    const result = await this.post(payload);
    return result?.dedup_key ?? input.dedupKey ?? null;
  }

  /**
   * Acknowledge an existing incident by its dedup_key.
   */
  async acknowledge(dedupKey: string): Promise<boolean> {
    const routingKey = this.routingKey();
    if (!routingKey) return false;
    const result = await this.post({
      routing_key: routingKey,
      event_action: 'acknowledge',
      dedup_key: dedupKey,
    });
    return result !== null;
  }

  /**
   * Resolve (close) an existing incident by its dedup_key.
   */
  async resolve(dedupKey: string): Promise<boolean> {
    const routingKey = this.routingKey();
    if (!routingKey) return false;
    const result = await this.post({
      routing_key: routingKey,
      event_action: 'resolve',
      dedup_key: dedupKey,
    });
    return result !== null;
  }

  /**
   * Shape of the `trigger` payload per Events API v2:
   * https://developer.pagerduty.com/docs/events-api-v2/trigger-events/
   *
   * Exposed so the unit test can assert the shape without going
   * through the real HTTP path.
   */
  buildTriggerPayload(
    routingKey: string,
    input: PagerDutyTriggerInput,
  ): Record<string, unknown> {
    return {
      routing_key: routingKey,
      event_action: 'trigger',
      ...(input.dedupKey ? { dedup_key: input.dedupKey } : {}),
      payload: {
        summary: input.summary,
        severity: input.severity,
        source: input.source,
        ...(input.component ? { component: input.component } : {}),
        ...(input.group ? { group: input.group } : {}),
        ...(input.class ? { class: input.class } : {}),
        ...(input.customDetails ? { custom_details: input.customDetails } : {}),
      },
    };
  }

  private routingKey(): string | null {
    const key = process.env.PAGERDUTY_ROUTING_KEY;
    if (!key) {
      if (!this.warnedUnconfigured) {
        this.log.warn(
          'PAGERDUTY_ROUTING_KEY unset — trigger/acknowledge/resolve are no-ops',
        );
        this.warnedUnconfigured = true;
      }
      return null;
    }
    return key;
  }

  private async post(body: Record<string, unknown>): Promise<PagerDutyEnqueueResult | null> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.error(
          { status: res.status, body: text.slice(0, 500) },
          'PagerDuty enqueue failed',
        );
        return null;
      }
      return (await res.json()) as PagerDutyEnqueueResult;
    } catch (err) {
      this.log.error({ err }, 'PagerDuty enqueue threw');
      return null;
    }
  }
}
