import { Injectable, Logger } from '@nestjs/common';
import type { Alert, AlertSink } from './alert.port';

/**
 * Production alert sink (stub).
 *
 * Reads `FAWTARA_ALERT_WEBHOOK` and POSTs the alert body as JSON. The
 * webhook target is deployment-specific — Opsgenie's "Create Alert"
 * endpoint, a PagerDuty Events API v2 URL, or a Slack Incoming Webhook
 * for lower-severity routing. The payload shape here is the minimum
 * common envelope; a per-vendor adapter can wrap it later.
 *
 * ENV-ABSENT POLICY. If `FAWTARA_ALERT_WEBHOOK` is empty we treat the
 * sink as a no-op and log at `warn` the first time a page would have
 * fired, so a mis-provisioned environment is visible but doesn't
 * cause a crash loop. Flipping to {@link LogAlertSink} in the module
 * config is the recommended fallback for local dev.
 */
@Injectable()
export class WebhookAlertSink implements AlertSink {
  private readonly log = new Logger('WebhookAlertSink');
  private warnedOnEmpty = false;

  async send(alert: Alert): Promise<void> {
    const url = process.env.FAWTARA_ALERT_WEBHOOK?.trim();
    if (!url) {
      if (!this.warnedOnEmpty) {
        this.warnedOnEmpty = true;
        this.log.warn(
          { alert },
          'FAWTARA_ALERT_WEBHOOK is unset — WebhookAlertSink is a no-op. Set it or bind LogAlertSink.',
        );
      }
      return;
    }
    try {
      // We deliberately do NOT `await` with a long timeout — alert
      // emission must never block the hot path. A 2s cap and a
      // best-effort fire-and-report model fits the SRE contract.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          severity: alert.severity,
          title: alert.title,
          details: alert.details ?? {},
          source: 'fawtara-api',
          emitted_at: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        this.log.warn({ status: res.status, title: alert.title }, 'alert webhook returned non-2xx');
      }
    } catch (err) {
      // Swallow and log — a flaky webhook must not take down the API.
      this.log.warn(
        { err: (err as Error).message, title: alert.title },
        'alert webhook POST failed',
      );
    }
  }
}
