import { Injectable, Logger } from '@nestjs/common';
import type { Alert, AlertSink } from './alert.port';

/**
 * Default alert sink: writes the alert through the standard Nest logger.
 * Severity → log level mapping:
 *   - `page`  → `fatal` (pino routes to stderr, high priority)
 *   - `warn`  → `warn`
 *   - `info`  → `info`
 *
 * PRODUCTION: this is NOT a pager. Deployments wire
 * {@link WebhookAlertSink} (or an Opsgenie / PagerDuty adapter) in
 * place of this provider so `page` severities actually wake someone.
 * The log line is still emitted either way for the audit trail.
 */
@Injectable()
export class LogAlertSink implements AlertSink {
  private readonly log = new Logger('AlertSink');

  async send(alert: Alert): Promise<void> {
    const payload = { title: alert.title, severity: alert.severity, ...(alert.details ?? {}) };
    switch (alert.severity) {
      case 'page':
        // Nest's Logger does not expose `fatal` — use `error` which pino
        // promotes to its highest level under nestjs-pino's bridge.
        this.log.error({ alert: payload }, `ALERT[page]: ${alert.title}`);
        break;
      case 'warn':
        this.log.warn({ alert: payload }, `ALERT[warn]: ${alert.title}`);
        break;
      case 'info':
      default:
        this.log.log({ alert: payload }, `ALERT[info]: ${alert.title}`);
        break;
    }
  }
}
