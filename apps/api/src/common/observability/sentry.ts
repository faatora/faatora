import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

/**
 * Sentry bootstrap.
 *
 * MUST be called BEFORE `NestFactory.create()` (and before any require
 * that opens outbound network — Sentry's auto-instrumentation patches
 * http/https on init). `main.ts` imports this module at the very top
 * and calls {@link initSentry} first thing.
 *
 * Feature flagged by env: if `SENTRY_DSN` is unset, {@link initSentry}
 * is a no-op. Local dev and CI keep the var empty so nothing ships.
 *
 * PII scrubbing in `beforeSend` strips headers that routinely carry
 * credentials (Authorization, Cookie, ASP + Stripe signatures). The
 * request body is NOT captured by default in @sentry/node v8; if that
 * changes we must revisit this filter because our invoice payloads
 * contain customer tax-ids and bank details.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    profilesSampleRate: parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? '0.1'),
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
      nodeProfilingIntegration(),
    ],
    beforeSend: (event) => {
      // Scrub PII — strip request headers that commonly carry secrets.
      // Sentry lowercases header names when it serialises them, so the
      // comparisons below are intentionally lowercase.
      const headers = event.request?.headers;
      if (headers) {
        delete headers['authorization'];
        delete headers['cookie'];
        delete headers['x-asp-signature'];
        delete headers['stripe-signature'];
      }
      return event;
    },
  });

  return true;
}

/**
 * Re-exported so callers don't have to depend on `@sentry/node`
 * directly. Mostly used by the exception filter and the request
 * context middleware.
 */
export { Sentry };
