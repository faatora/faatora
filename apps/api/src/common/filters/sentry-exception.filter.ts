import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Sentry } from '../observability/sentry';

/**
 * Global exception filter that forwards uncaught + 5xx errors to
 * Sentry before delegating to Nest's default filter for the HTTP
 * response. 4xx `HttpException`s are intentionally NOT reported —
 * they are user errors (bad input, missing auth) and would flood
 * Sentry. The default filter still produces the normal JSON body.
 *
 * Context attached:
 *   - tags: tenant_id, user_id, correlation_id, route
 *   - extra: method, url
 * The request context middleware ({@link SentryRequestContextMiddleware})
 * attaches the user/tenant on the current isolation scope on ingress,
 * so in the common case Sentry already has them by the time an error
 * fires here — this filter is a belt-and-braces re-attach from the
 * request object directly.
 */
interface RequestWithContext {
  method?: string;
  url?: string;
  originalUrl?: string;
  route?: { path?: string };
  tenantId?: string;
  userId?: string;
  email?: string;
  headers?: Record<string, string | string[] | undefined>;
}

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(SentryExceptionFilter.name);
  private readonly fallback: BaseExceptionFilter;

  constructor(httpAdapterHost: HttpAdapterHost) {
    this.fallback = new BaseExceptionFilter(httpAdapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (this.shouldReport(exception)) {
      try {
        const req = host.switchToHttp().getRequest<RequestWithContext>();
        Sentry.withScope((scope) => {
          if (req.tenantId) scope.setTag('tenant_id', req.tenantId);
          if (req.userId) scope.setTag('user_id', req.userId);
          const correlation = req.headers?.['x-correlation-id'];
          const cid = Array.isArray(correlation) ? correlation[0] : correlation;
          if (cid) scope.setTag('correlation_id', cid);
          const route = req.route?.path;
          if (route) scope.setTag('route', route);
          scope.setExtra('method', req.method);
          scope.setExtra('url', req.originalUrl ?? req.url);
          Sentry.captureException(exception);
        });
      } catch (err) {
        // Never let Sentry failures break the response path — log and
        // move on to the default filter so the client still gets a
        // proper error body.
        this.log.warn({ err }, 'Sentry.captureException failed; falling back');
      }
    }

    this.fallback.catch(exception, host);
  }

  /**
   * Report anything that is NOT a 4xx `HttpException`. 5xx HttpExceptions
   * (e.g. `InternalServerErrorException`) do report — those are server
   * bugs. Non-HttpException errors are always reported.
   */
  private shouldReport(exception: unknown): boolean {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return status >= HttpStatus.INTERNAL_SERVER_ERROR;
    }
    return true;
  }
}
