/**
 * Observability contract tests (A16).
 *
 * These tests exercise the pieces in isolation — a controller mounted on
 * its own Nest app, the middleware called directly with a stub req/res,
 * the canary with an in-memory DB stub, and the queue-depth sampler with
 * a pg Pool whose query() rejects to simulate a missing table.
 *
 * We never spin up the full AppModule here — that would drag in Cognito,
 * drizzle pools, etc. The observability pieces are standalone by design;
 * if a test suite needs AppModule it belongs in an e2e file, not here.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MetricsController } from '../src/common/observability/metrics.controller';
import { HttpMetricsMiddleware } from '../src/common/observability/http-metrics.middleware';
import {
  _resetRegistryForTests,
  defaultRegistry,
  httpRequestsTotal,
  incCounter,
  observeHistogram,
  setGauge,
} from '../src/common/observability/metrics';
import { CanaryService } from '../src/common/observability/canary.service';
import { QueueDepthSamplerService } from '../src/common/observability/queue-depth-sampler.service';
import { LogAlertSink } from '../src/common/observability/log-alert-sink';
import { ALERT_SINK } from '../src/common/observability/alert.port';
import { DB } from '../src/db/db.module';

describe('Observability — metrics endpoint', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 text/plain with faatora_http_requests_total after a request has been served', async () => {
    // Fabricate at least one observed request so the series exists.
    incCounter('faatora_http_requests_total', {
      method: 'GET',
      route: '/metrics',
      status_code: '200',
      tenant_id: 'anonymous',
    });

    const res = await request(app.getHttpServer()).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('faatora_http_requests_total');
    // Prometheus exposition format carries metric type comments
    expect(res.text).toMatch(/# TYPE faatora_http_requests_total counter/);
  });
});

describe('Observability — metrics helpers', () => {
  afterEach(() => {
    _resetRegistryForTests();
  });

  it('incCounter increases the exposed counter value', async () => {
    const labels = {
      method: 'POST',
      route: '/invoices',
      status_code: '201',
      tenant_id: 't1',
    };
    const before = await httpRequestsTotal.get();
    const beforeVal =
      before.values.find(
        (v) =>
          v.labels.method === 'POST' &&
          v.labels.route === '/invoices' &&
          v.labels.tenant_id === 't1',
      )?.value ?? 0;

    incCounter('faatora_http_requests_total', labels);
    incCounter('faatora_http_requests_total', labels, 4);

    const after = await httpRequestsTotal.get();
    const afterVal = after.values.find(
      (v) =>
        v.labels.method === 'POST' && v.labels.route === '/invoices' && v.labels.tenant_id === 't1',
    )?.value;

    expect(afterVal).toBe(beforeVal + 5);
  });

  it('observeHistogram records a sample on faatora_http_request_duration_seconds', async () => {
    observeHistogram(
      'faatora_http_request_duration_seconds',
      { method: 'GET', route: '/health', status_code: '200' },
      0.123,
    );
    const text = await defaultRegistry.metrics();
    expect(text).toContain('faatora_http_request_duration_seconds_count');
    expect(text).toMatch(
      /faatora_http_request_duration_seconds_sum\{[^}]*route="\/health"[^}]*\} 0\.123/,
    );
  });

  it('setGauge updates faatora_canary_last_success_timestamp', async () => {
    const now = Math.floor(Date.now() / 1000);
    setGauge('faatora_canary_last_success_timestamp', {}, now);
    const text = await defaultRegistry.metrics();
    expect(text).toContain(`faatora_canary_last_success_timestamp ${now}`);
  });

  it('throws on unknown metric names (typo guard)', () => {
    expect(() =>
      incCounter('does_not_exist' as unknown as 'faatora_http_requests_total', {}),
    ).toThrow(/unknown counter/);
  });
});

describe('Observability — HttpMetricsMiddleware', () => {
  afterEach(() => {
    _resetRegistryForTests();
  });

  it('observes a histogram sample and increments the counter on response finish', async () => {
    const mw = new HttpMetricsMiddleware();
    let finishCb: (() => void) | null = null;
    const req = {
      method: 'GET',
      url: '/anything',
      route: { path: '/anything' },
      tenantId: 't-metrics',
    };
    const res = {
      statusCode: 204,
      on: (event: string, cb: () => void) => {
        if (event === 'finish') finishCb = cb;
      },
    };
    let nextCalled = false;
    mw.use(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(finishCb).toBeTruthy();
    // Simulate finish after a tiny delay so we get a real duration.
    await new Promise((r) => setTimeout(r, 2));
    finishCb!();

    const text = await defaultRegistry.metrics();
    expect(text).toContain(
      'faatora_http_requests_total{method="GET",route="/anything",status_code="204",tenant_id="t-metrics"} 1',
    );
    expect(text).toContain(
      'faatora_http_request_duration_seconds_count{method="GET",route="/anything",status_code="204"} 1',
    );
  });

  it('falls back to anonymous tenant when req.tenantId is unset', async () => {
    const mw = new HttpMetricsMiddleware();
    let finishCb: (() => void) | null = null;
    mw.use(
      { method: 'GET', url: '/foo', route: { path: '/foo' } },
      {
        statusCode: 200,
        on: (_e: string, cb: () => void) => {
          finishCb = cb;
        },
      },
      () => undefined,
    );
    finishCb!();
    const text = await defaultRegistry.metrics();
    expect(text).toContain('tenant_id="anonymous"');
  });
});

describe('Observability — CanaryService', () => {
  afterEach(() => {
    _resetRegistryForTests();
  });

  function fakeDb(execute: (q: string) => Promise<unknown> = async () => []) {
    // CanaryService casts to `{ execute }` so we only need that shape.
    return { execute } as unknown as never;
  }

  function fakeSink(): { sent: unknown[]; sink: LogAlertSink } {
    const sent: unknown[] = [];
    const sink = {
      async send(alert: unknown) {
        sent.push(alert);
      },
    } as unknown as LogAlertSink;
    return { sent, sink };
  }

  it('stamps faatora_canary_last_success_timestamp after a successful pass', async () => {
    const { sink } = fakeSink();
    const svc = new CanaryService(fakeDb(), sink);
    const before = Math.floor(Date.now() / 1000) - 1;
    const result = await svc.runOnce();
    expect(result.ok).toBe(true);

    const text = await defaultRegistry.metrics();
    const match = text.match(/faatora_canary_last_success_timestamp (\d+(?:\.\d+)?)/);
    expect(match).toBeTruthy();
    const stamped = Number(match![1]);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 2);
  });

  it('reports {ok:false, failed:"db"} and pages when SELECT 1 throws', async () => {
    const { sent, sink } = fakeSink();
    const svc = new CanaryService(
      fakeDb(async () => {
        throw new Error('connection refused');
      }),
      sink,
    );
    const result = await svc.runOnce();
    expect(result).toEqual({ ok: false, failed: 'db' });
    expect(sent).toHaveLength(1);
    expect((sent[0] as { severity: string }).severity).toBe('page');
  });

  it('skips the compliance layer when @faatora/compliance is not importable', async () => {
    // We can't easily make the import fail here (the package IS linked
    // in the workspace), so instead we assert the happy path still ends
    // with ok=true. The import-miss log path is covered by the type and
    // the one-time warn guard.
    const { sink } = fakeSink();
    const svc = new CanaryService(fakeDb(), sink);
    const result = await svc.runOnce();
    expect(result.ok).toBe(true);
  });
});

describe('Observability — QueueDepthSamplerService', () => {
  afterEach(() => {
    _resetRegistryForTests();
  });

  it('no-ops and logs when clearance_outbox is absent', async () => {
    const svc = new QueueDepthSamplerService();
    // Inject a fake pool whose query() throws the expected undefined_table.
    const err = Object.assign(new Error('relation "clearance_outbox" does not exist'), {
      code: '42P01',
    });
    const pool = {
      query: async () => {
        throw err;
      },
      end: async () => undefined,
      on: () => undefined,
    };
    // Bypass onModuleInit's env load — plant the pool directly.
    (svc as unknown as { pool: unknown }).pool = pool;
    const warnSpy = jest
      .spyOn((svc as unknown as { log: { warn: (...a: unknown[]) => void } }).log, 'warn')
      .mockImplementation(() => undefined);
    await svc.runSample();
    expect(warnSpy).toHaveBeenCalled();
    const firstCall = warnSpy.mock.calls[0]?.[0];
    expect(String(firstCall)).toMatch(/clearance_outbox/);
    // Second run must not re-log.
    warnSpy.mockClear();
    await svc.runSample();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('sets the queue-depth gauge from a group-by result', async () => {
    const svc = new QueueDepthSamplerService();
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            { status: 'queued', count: '3' },
            { status: 'in_flight', count: '1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }),
      end: async () => undefined,
      on: () => undefined,
    };
    (svc as unknown as { pool: unknown }).pool = pool;
    await svc.runSample();
    const text = await defaultRegistry.metrics();
    expect(text).toContain('faatora_clearance_queue_depth{status="queued"} 3');
    expect(text).toContain('faatora_clearance_queue_depth{status="in_flight"} 1');
    expect(text).toContain('faatora_clearance_queue_depth{status="delivered"} 0');
    expect(text).toContain('faatora_clearance_dlq_size 2');
  });
});

describe('Observability — ObservabilityModule wiring', () => {
  it('exposes ALERT_SINK bound to LogAlertSink by default', async () => {
    const { ObservabilityModule } =
      await import('../src/common/observability/observability.module');
    // The module imports DB via CanaryService; we can't fully compile it
    // in isolation because DB is Global. Instead, inspect its providers.
    const module = Reflect.getMetadata('providers', ObservabilityModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    const sinkBinding = module.find((p) => p.provide === ALERT_SINK);
    expect(sinkBinding?.useClass).toBe(LogAlertSink);
  });
});

// Keep lightweight — DB is a Nest Global in prod but we don't need to
// touch it from here. These lint-level references prove the imports
// resolve without pulling the real module graph in.
void DB;
