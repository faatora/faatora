/**
 * Unit tests for PagerDutyController.
 *
 * We invoke the controller's `handle()` directly with a synthesised
 * `{ rawBody }` request rather than going through supertest + the
 * Nest rawBody middleware. Rationale:
 *
 *   1. `rawBody: true` in TestingModule.createNestApplication() does
 *      install the raw-body middleware, but the body bytes that
 *      reach it depend on supertest's content-type negotiation, and
 *      a single re-serialisation (JSON.stringify → superagent →
 *      Express) will mangle the exact bytes PagerDuty signed. That's
 *      a test-harness concern, not an application concern — the raw-
 *      body preservation path itself is exercised by the signature
 *      unit tests in test/pagerduty.spec.ts.
 *   2. Calling the handler directly also lets us assert against the
 *      live PlatformStatusService with a stubbed DB, which is what
 *      we actually care about here.
 *
 * Coverage:
 *   - Counter is bumped per verified delivery.
 *   - Status row is written (we assert the shape of the arg handed
 *     to the DB).
 *   - Event is emitted on EventEmitter2 (observed by a subscriber).
 *   - DB insert failure still 200s (no throw).
 *   - 401 on bad signature (regression).
 *   - 503 when PAGERDUTY_WEBHOOK_SECRET is unset (regression).
 */
import { createHmac } from 'node:crypto';
import {
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PagerDutyController } from './pagerduty.controller';
import { PlatformStatusService } from './platform-status.service';
import type { Database } from '../../db/db.module';
import {
  _resetRegistryForTests,
  defaultRegistry,
  pagerDutyEventsTotal,
} from '../../common/observability/metrics';

const WEBHOOK_SECRET = 'unit-test-pd-secret';

function sign(body: Buffer, secret = WEBHOOK_SECRET): string {
  return `v1=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Build a fake Database whose `.insert(table).values(row)` chain
 * invokes the supplied callback with the row. By default resolves;
 * a throwing impl covers the DB-down path.
 */
function fakeDb(onValues?: (row: unknown) => Promise<void>) {
  const values = jest.fn(async (row: unknown) => {
    if (onValues) await onValues(row);
  });
  const insert = jest.fn(() => ({ values }));
  return { insert, values, db: { insert } as unknown as Database };
}

/** A realistic PagerDuty V3 webhook envelope for one incident. */
function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id: '01DRE6M3B8ABC',
      event_type: 'incident.triggered',
      resource_type: 'incident',
      occurred_at: '2026-11-27T10:00:00.000Z',
      agent: { html_url: 'https://acme.pagerduty.com/users/P123' },
      data: {
        id: 'PD-INC-ABC',
        type: 'incident',
        status: 'triggered',
        summary: 'DB write latency over threshold',
      },
      ...overrides,
    },
  };
}

function buildController(opts: { db: ReturnType<typeof fakeDb>; events?: EventEmitter2 }): {
  controller: PagerDutyController;
  status: PlatformStatusService;
} {
  const status = new PlatformStatusService(opts.db.db, opts.events);
  const controller = new PagerDutyController(status);
  return { controller, status };
}

async function counterValue(labels: {
  event_type: string;
  resource_type: string;
}): Promise<number> {
  const snapshot = await pagerDutyEventsTotal.get();
  return (
    snapshot.values.find(
      (v) =>
        v.labels.event_type === labels.event_type &&
        v.labels.resource_type === labels.resource_type,
    )?.value ?? 0
  );
}

describe('PagerDutyController', () => {
  const ORIGINAL_SECRET = process.env.PAGERDUTY_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    _resetRegistryForTests();
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.PAGERDUTY_WEBHOOK_SECRET;
    } else {
      process.env.PAGERDUTY_WEBHOOK_SECRET = ORIGINAL_SECRET;
    }
  });

  it('bumps faatora_pd_events_total, writes a status row, and emits platform.status.event on a verified delivery', async () => {
    const db = fakeDb();
    const events = new EventEmitter2();
    const subscriber = jest.fn();
    events.on('platform.status.event', subscriber);
    const { controller } = buildController({ db, events });

    const body = Buffer.from(JSON.stringify(samplePayload()));
    const res = await controller.handle({ rawBody: body }, sign(body));

    expect(res).toEqual({ received: true });

    // Counter — asserted against the real prom-client registry.
    expect(
      await counterValue({ event_type: 'incident.triggered', resource_type: 'incident' }),
    ).toBe(1);
    const exposed = await defaultRegistry.metrics();
    expect(exposed).toContain(
      'faatora_pd_events_total{event_type="incident.triggered",resource_type="incident"} 1',
    );

    // Status-page row
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenCalledTimes(1);
    const row = db.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      incidentId: 'PD-INC-ABC',
      pdEventType: 'incident.triggered',
      status: 'investigating',
      summary: 'DB write latency over threshold',
    });
    expect(row.occurredAt).toBeInstanceOf(Date);
    expect((row.occurredAt as Date).toISOString()).toBe('2026-11-27T10:00:00.000Z');

    // Fan-out event
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: 'PD-INC-ABC',
        pdEventType: 'incident.triggered',
        status: 'investigating',
      }),
    );
  });

  it('labels the counter with "unknown" when event_type / resource_type are missing from the payload', async () => {
    const db = fakeDb();
    const events = new EventEmitter2();
    const { controller } = buildController({ db, events });
    const body = Buffer.from(JSON.stringify({ event: { data: { id: 'PD-INC-X' } } }));

    await controller.handle({ rawBody: body }, sign(body));

    expect(await counterValue({ event_type: 'unknown', resource_type: 'unknown' })).toBe(1);
    const row = db.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.incidentId).toBe('PD-INC-X');
    // Unknown event_type still maps conservatively to 'investigating'.
    expect(row.status).toBe('investigating');
  });

  it.each([
    ['incident.triggered', 'investigating'],
    ['incident.acknowledged', 'identified'],
    ['incident.resolved', 'resolved'],
  ] as const)(
    'projects %s → status=%s on the inserted row (end-to-end through the controller)',
    async (eventType, expectedStatus) => {
      const db = fakeDb();
      const events = new EventEmitter2();
      const { controller } = buildController({ db, events });
      const body = Buffer.from(JSON.stringify(samplePayload({ event_type: eventType })));

      await controller.handle({ rawBody: body }, sign(body));

      const row = db.values.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.status).toBe(expectedStatus);
      expect(row.pdEventType).toBe(eventType);
    },
  );

  it('still returns 200 (and still bumps the counter + emits the event) when the DB insert throws', async () => {
    const db = fakeDb(async () => {
      throw new Error('simulated DB outage');
    });
    const events = new EventEmitter2();
    const subscriber = jest.fn();
    events.on('platform.status.event', subscriber);
    const { controller } = buildController({ db, events });

    const body = Buffer.from(JSON.stringify(samplePayload()));
    await expect(controller.handle({ rawBody: body }, sign(body))).resolves.toEqual({
      received: true,
    });

    // Counter is bumped before record() runs, so it fires either way.
    expect(
      await counterValue({ event_type: 'incident.triggered', resource_type: 'incident' }),
    ).toBe(1);
    // The bus fan-out survives a DB failure.
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('throws UnauthorizedException on an invalid signature and neither writes nor bumps', async () => {
    const db = fakeDb();
    const events = new EventEmitter2();
    const subscriber = jest.fn();
    events.on('platform.status.event', subscriber);
    const { controller } = buildController({ db, events });
    const body = Buffer.from(JSON.stringify(samplePayload()));

    await expect(controller.handle({ rawBody: body }, 'v1=deadbeef')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(db.insert).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
    expect(
      await counterValue({ event_type: 'incident.triggered', resource_type: 'incident' }),
    ).toBe(0);
  });

  it('throws ServiceUnavailableException when PAGERDUTY_WEBHOOK_SECRET is unset', async () => {
    delete process.env.PAGERDUTY_WEBHOOK_SECRET;
    const db = fakeDb();
    const { controller } = buildController({ db, events: new EventEmitter2() });
    const body = Buffer.from(JSON.stringify(samplePayload()));

    await expect(
      controller.handle({ rawBody: body }, sign(body, 'irrelevant')),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when rawBody is missing (middleware misconfig)', async () => {
    const db = fakeDb();
    const { controller } = buildController({ db, events: new EventEmitter2() });

    await expect(controller.handle({}, 'v1=whatever')).rejects.toBeInstanceOf(BadRequestException);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
