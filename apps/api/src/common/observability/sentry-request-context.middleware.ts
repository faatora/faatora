import { Injectable, type NestMiddleware } from '@nestjs/common';
import { Sentry } from './sentry';

/**
 * Per-request Sentry scope hydration.
 *
 * Nest guards (TenantGuard) write `tenantId` / `userId` / `email` onto
 * the request AFTER middleware runs, so this middleware installs a
 * lazy hook on the response's `finish` to catch the fully-populated
 * request. For errors raised mid-request (common case), the exception
 * filter re-reads these off the request directly — the middleware's
 * job is to tag breadcrumbs and any Sentry events fired by nested
 * code that lacks direct access to the request (background work
 * triggered within the request's isolation scope).
 *
 * Each request runs inside its own isolation scope — @sentry/node v8's
 * `httpIntegration` sets that up automatically; we just add fields.
 */
interface ContextRequest {
  tenantId?: string;
  userId?: string;
  email?: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface ContextResponse {
  on(event: 'finish', cb: () => void): void;
}

type NextFn = (err?: unknown) => void;

@Injectable()
export class SentryRequestContextMiddleware implements NestMiddleware {
  use(req: ContextRequest, _res: ContextResponse, next: NextFn): void {
    // Only touch Sentry when the SDK is actually initialized. In local
    // dev/test SENTRY_DSN is unset, isInitialized() is false, and the
    // setUser/setTag calls would be wasted work.
    if (!Sentry.isInitialized()) {
      next();
      return;
    }

    const scope = Sentry.getCurrentScope();

    // Correlation id is present as a request header set by the pino
    // logger middleware; grab it now for breadcrumbs.
    const corr = req.headers?.['x-correlation-id'];
    const cid = Array.isArray(corr) ? corr[0] : corr;
    if (cid) scope.setTag('correlation_id', cid);

    // tenant/user are populated by TenantGuard which fires AFTER
    // middleware. Add a one-shot hook on finish so trailing events
    // emitted from controllers/services get the identity tagged on
    // their breadcrumbs.
    _res.on('finish', () => {
      try {
        if (req.tenantId) scope.setTag('tenant_id', req.tenantId);
        if (req.userId) {
          scope.setUser({ id: req.userId, email: req.email });
        }
      } catch {
        // scope may be gone if the response finishes after the
        // isolation scope was torn down; ignore.
      }
    });

    next();
  }
}
