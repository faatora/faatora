import { Injectable, type NestMiddleware } from '@nestjs/common';
import { httpRequestsTotal, httpRequestDurationSeconds } from './metrics';

/**
 * Minimal structural shapes — we don't pull @types/express into this
 * middleware because it isn't a listed dep (and the Nest platform
 * stripping typing to IncomingMessage/ServerResponse is enough for
 * the fields we read). Any Express-shaped request/response satisfies
 * these.
 */
interface MiddlewareRequest {
  method: string;
  url?: string;
  route?: { path?: string };
  tenantId?: string;
}

interface MiddlewareResponse {
  statusCode: number;
  on(event: 'finish', cb: () => void): void;
}

type NextFn = (err?: unknown) => void;

/**
 * Lightweight request-timing middleware.
 *
 * We start a monotonic timer in the ingress call and attach a one-shot
 * `finish` listener on the response: on fire we increment the counter
 * and observe the histogram. Not an interceptor — a middleware fires
 * for every request including those that never reach a controller
 * (404, guard rejection), which is exactly what SRE needs to see.
 *
 * Label cardinality: route uses the Express route template (never the
 * raw path, so `/invoices/abc-123` becomes `/invoices/:id`) which
 * keeps series bounded. If routing hasn't matched by the time we
 * read it (very rare — short-circuit middleware errors) we fall back
 * to `req.url`.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(req: MiddlewareRequest, res: MiddlewareResponse, next: NextFn): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationNs = Number(process.hrtime.bigint() - start);
      const seconds = durationNs / 1e9;
      const method = req.method;
      const route = req.route?.path ?? req.url ?? 'unknown';
      const statusCode = String(res.statusCode);
      const tenantId = req.tenantId ?? 'anonymous';
      httpRequestsTotal.inc({ method, route, status_code: statusCode, tenant_id: tenantId }, 1);
      httpRequestDurationSeconds.observe({ method, route, status_code: statusCode }, seconds);
    });
    next();
  }
}
