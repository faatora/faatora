/**
 * Alert sink port.
 *
 * A sink is anything that can take a structured {@link Alert} and get
 * it in front of a human. The default implementation is
 * {@link LogAlertSink} (writes via pino at a severity-mapped level) so
 * local dev always has a sink and tests can assert on it. In
 * production, swap in `WebhookAlertSink` (POSTs to Opsgenie / PagerDuty
 * / Slack webhook) by rebinding the provider — see
 * `webhook-alert-sink.ts`.
 */

export const ALERT_SINK = 'ALERT_SINK';

export type AlertSeverity = 'page' | 'warn' | 'info';

export interface Alert {
  /** Pager-worthy? `page` wakes someone. `warn` reaches a channel. `info` is journal-only. */
  severity: AlertSeverity;
  /** One-line human title shown on the pager / in the chat message. */
  title: string;
  /** Arbitrary structured context (runbook link, invoice id, correlation id, …). */
  details?: Record<string, any>;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}
