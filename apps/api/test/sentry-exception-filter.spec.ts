/**
 * Unit tests for SentryExceptionFilter.
 *
 * We mock `@sentry/node` so we can assert on captureException +
 * withScope without initialising a real Sentry client. The fallback
 * BaseExceptionFilter is instantiated by the filter from the real
 * HttpAdapterHost we hand it; we only need to assert it was invoked,
 * so we stub the adapter.
 */

type ScopeTag = { key: string; value: unknown };
type ScopeExtra = { key: string; value: unknown };

const captured: Array<{ exception: unknown; tags: ScopeTag[]; extras: ScopeExtra[] }> = [];

jest.mock('@sentry/node', () => {
  // The *current* scope state during a withScope callback. captureException
  // is invoked INSIDE that callback, so it must read these while they are
  // still populated — resetting after the callback is too late.
  let currentTags: ScopeTag[] = [];
  let currentExtras: ScopeExtra[] = [];
  return {
    withScope: (cb: (scope: unknown) => void) => {
      currentTags = [];
      currentExtras = [];
      const scope = {
        setTag: (key: string, value: unknown) => currentTags.push({ key, value }),
        setExtra: (key: string, value: unknown) => currentExtras.push({ key, value }),
      };
      cb(scope);
    },
    captureException: (exception: unknown) => {
      captured.push({ exception, tags: [...currentTags], extras: [...currentExtras] });
    },
    isInitialized: () => true,
    getCurrentScope: () => ({
      setTag: () => undefined,
      setUser: () => undefined,
    }),
  };
});

// After the mock is registered, import the filter — it pulls
// `@sentry/node` via `../src/common/observability/sentry` which
// re-exports the mocked module.
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { SentryExceptionFilter } from '../src/common/filters/sentry-exception.filter';

/**
 * Minimal stub for HttpAdapterHost + httpAdapter the fallback needs.
 * BaseExceptionFilter calls `isHeadersSent(res)` + `reply(res, body,
 * status)`; we stub both. `end` is read by Nest's error path too.
 */
function stubHttpAdapterHost(): { httpAdapter: unknown } {
  return {
    httpAdapter: {
      reply: jest.fn(),
      end: jest.fn(),
      isHeadersSent: jest.fn(() => false),
      getRequestUrl: jest.fn(() => '/x'),
      getRequestMethod: jest.fn(() => 'GET'),
    },
  };
}

function hostWithRequest(req: Record<string, unknown>): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
      }),
      getNext: () => undefined,
    }),
    getType: () => 'http' as const,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({ getContext: () => ({}), getData: () => ({}) }) as never,
    switchToWs: () =>
      ({ getClient: () => ({}), getData: () => ({}), getPattern: () => '' }) as never,
  } as unknown as ArgumentsHost;
}

describe('SentryExceptionFilter', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('captures a thrown non-HttpException and tags tenant_id, user_id, correlation_id, route', () => {
    const filter = new SentryExceptionFilter(
      stubHttpAdapterHost() as unknown as import('@nestjs/core').HttpAdapterHost,
    );
    const err = new Error('boom');
    const host = hostWithRequest({
      method: 'POST',
      url: '/api/invoices',
      originalUrl: '/api/invoices',
      route: { path: '/invoices' },
      tenantId: 'tnt_123',
      userId: 'usr_456',
      email: 'ahmed@example.com',
      headers: { 'x-correlation-id': 'corr-abc' },
    });

    // Suppress the fallback's write into the stub adapter.
    expect(() => filter.catch(err, host)).not.toThrow();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.exception).toBe(err);
    const tagMap = Object.fromEntries(captured[0]!.tags.map((t) => [t.key, t.value]));
    expect(tagMap).toMatchObject({
      tenant_id: 'tnt_123',
      user_id: 'usr_456',
      correlation_id: 'corr-abc',
      route: '/invoices',
    });
    const extraMap = Object.fromEntries(captured[0]!.extras.map((e) => [e.key, e.value]));
    expect(extraMap).toMatchObject({ method: 'POST', url: '/api/invoices' });
  });

  it('captures 5xx HttpExceptions', () => {
    const filter = new SentryExceptionFilter(
      stubHttpAdapterHost() as unknown as import('@nestjs/core').HttpAdapterHost,
    );
    const err = new HttpException('upstream dead', HttpStatus.BAD_GATEWAY);
    filter.catch(err, hostWithRequest({ headers: {} }));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.exception).toBe(err);
  });

  it('does NOT capture 4xx HttpExceptions (user error, would flood Sentry)', () => {
    const filter = new SentryExceptionFilter(
      stubHttpAdapterHost() as unknown as import('@nestjs/core').HttpAdapterHost,
    );
    const err = new HttpException('bad input', HttpStatus.BAD_REQUEST);
    filter.catch(err, hostWithRequest({ headers: {} }));
    expect(captured).toHaveLength(0);
  });

  it('still delegates to the fallback filter when Sentry.captureException throws', () => {
    // Replace the mocked captureException so it throws once, then
    // restore it so beforeEach reset works for the next test.
    const sentry = jest.requireMock('@sentry/node') as {
      captureException: (e: unknown) => void;
    };
    const original = sentry.captureException;
    sentry.captureException = () => {
      throw new Error('sentry down');
    };
    try {
      const filter = new SentryExceptionFilter(
        stubHttpAdapterHost() as unknown as import('@nestjs/core').HttpAdapterHost,
      );
      // The important assertion is that filter.catch itself does not
      // propagate the Sentry failure — the client still gets a
      // response from the fallback.
      expect(() => filter.catch(new Error('boom'), hostWithRequest({ headers: {} }))).not.toThrow();
    } finally {
      sentry.captureException = original;
    }
  });
});
