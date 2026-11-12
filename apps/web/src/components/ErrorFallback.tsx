import type { FallbackRender } from '@sentry/react';

/**
 * Fallback UI shown when the root Sentry.ErrorBoundary catches a
 * render error. Kept intentionally plain — i18n is not reachable from
 * here (the i18n provider may be the thing that crashed) so the copy
 * is English-only and we rely on the tagline being recognisable.
 *
 * The event id is surfaced so support can look the session up in
 * Sentry when a user pastes it in a bug report.
 */
export const ErrorFallback: FallbackRender = ({ error, eventId, resetError }) => {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  return (
    <main className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <div className="mx-auto max-w-xl px-6 py-16">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-start text-xl font-semibold text-slate-900">Something went wrong</h1>
          <p className="mt-2 text-start text-sm text-slate-700">
            Faatora hit an unexpected error. The team has been notified.
          </p>
          {eventId ? (
            <p className="mt-2 text-start text-xs text-slate-500">
              Reference: <code className="rounded bg-slate-100 px-1 py-0.5">{eventId}</code>
            </p>
          ) : null}
          <details className="mt-3 text-start text-xs text-slate-500">
            <summary className="cursor-pointer">Technical detail</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words">{message}</pre>
          </details>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={resetError}
              className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              Try again
            </button>
            <a
              href="/"
              className="ps-4 pe-4 py-2 rounded-md border border-slate-300 bg-white text-slate-900 text-sm font-medium hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              Go home
            </a>
          </div>
        </div>
      </div>
    </main>
  );
};
