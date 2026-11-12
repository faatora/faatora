import * as Sentry from '@sentry/react';

/**
 * Sentry bootstrap for the React app.
 *
 * MUST run before React renders so error boundaries + unhandled
 * promise rejections are captured from the first frame. `main.tsx`
 * calls {@link initSentry} before `createRoot(...).render(...)`.
 *
 * Feature flagged by env: if `VITE_SENTRY_DSN` is unset, {@link initSentry}
 * is a no-op. Local dev and the Vitest browser env leave it empty.
 *
 * PII scrubbing in `beforeSend`:
 *   - Replay is configured with maskAllText + blockAllMedia (handled
 *     by the SDK itself).
 *   - URL query strings that match the usual access_token / id_token
 *     shape are redacted before send — tokens leak via OAuth redirect
 *     landings and Stripe return URLs.
 */
export function initSentry(): boolean {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: parseFloat(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    replaysSessionSampleRate: 0.01,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    beforeSend: (event) => {
      // Scrub URL query strings that commonly carry tokens on return
      // URLs (OAuth landings, Stripe redirect, Paymob Unified Checkout
      // success/callback).
      if (event.request?.url) {
        event.request.url = redactTokens(event.request.url);
      }
      // Scrub session + local storage context if ever attached.
      const ctx = event.contexts as Record<string, unknown> | undefined;
      if (ctx) {
        delete ctx['localStorage'];
        delete ctx['sessionStorage'];
      }
      return event;
    },
  });

  return true;
}

/**
 * Replace the value of query params whose name looks like an auth
 * token with `***`. We leave the key in so Sentry breadcrumbs are
 * still useful for debugging flow.
 */
function redactTokens(url: string): string {
  try {
    const u = new URL(url, 'http://placeholder.local');
    const sensitive = /token|secret|password|key|authorization/i;
    u.searchParams.forEach((_value, key) => {
      if (sensitive.test(key)) u.searchParams.set(key, '***');
    });
    // Return a serialisation that preserves the original origin
    // when it was absolute, or the path+query when it was relative.
    if (u.origin === 'http://placeholder.local') {
      return `${u.pathname}${u.search}${u.hash}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

export { Sentry };
