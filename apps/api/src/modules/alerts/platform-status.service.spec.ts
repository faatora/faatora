/**
 * Unit tests for PlatformStatusService — the glue between an
 * HMAC-verified PagerDuty event and the two side-effects that
 * actually matter (status-page row + EventEmitter2 fan-out).
 *
 * We mock the drizzle DB as a thin `{ insert: () => { values } }`
 * because the real Database is a Nest Global that drags in pg.Pool;
 * these tests are about the service's own contract and have no
 * business wiring a real database.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Database } from '../../db/db.module';
import {
  PlatformStatusService,
  mapToStatus,
  type VerifiedPagerDutyEvent,
} from './platform-status.service';
import { platformStatusEvents } from '../../db/schema/platform-status';

type InsertSpy = jest.Mock<{ values: jest.Mock<Promise<void>, [unknown]> }, [unknown]>;

interface FakeDb {
  db: Database;
  insert: InsertSpy;
  values: jest.Mock<Promise<void>, [unknown]>;
  table: unknown;
}

/**
 * Build a stand-in for `Database` whose `.insert(table).values(row)`
 * chain records which table was passed and what row was inserted. By
 * default `.values()` resolves; pass a rejector to make the insert
 * throw and exercise the error path.
 */
function makeFakeDb(valuesImpl?: () => Promise<void>): FakeDb {
  const values = jest.fn<Promise<void>, [unknown]>(valuesImpl ?? (async () => undefined));
  const insert = jest.fn((table: unknown) => {
    (insert as unknown as { lastTable: unknown }).lastTable = table;
    return { values };
  }) as unknown as InsertSpy;
  const db = { insert } as unknown as Database;
  return {
    db,
    insert,
    values,
    get table() {
      return (insert as unknown as { lastTable: unknown }).lastTable;
    },
  } as unknown as FakeDb;
}

function makeEvent(partial: Partial<VerifiedPagerDutyEvent> = {}): VerifiedPagerDutyEvent {
  return {
    incidentId: 'PD-INC-123',
    eventType: 'incident.triggered',
    summary: 'DB write latency over threshold',
    occurredAt: new Date('2026-11-27T10:00:00.000Z'),
    raw: { event: { event_type: 'incident.triggered' } },
    ...partial,
  };
}

describe('mapToStatus', () => {
  it.each([
    ['incident.triggered', 'investigating'],
    ['incident.acknowledged', 'identified'],
    ['incident.resolved', 'resolved'],
  ] as const)('maps %s → %s', (eventType, expected) => {
    expect(mapToStatus(eventType)).toBe(expected);
  });

  it('falls back to investigating for unknown event types', () => {
    expect(mapToStatus('incident.escalated')).toBe('investigating');
    expect(mapToStatus('')).toBe('investigating');
    expect(mapToStatus('garbage-from-the-future')).toBe('investigating');
  });
});

describe('PlatformStatusService.record', () => {
  it('inserts a row into platform_status_events with the mapped status', async () => {
    const fake = makeFakeDb();
    const events = new EventEmitter2();
    const svc = new PlatformStatusService(fake.db, events);

    await svc.record(makeEvent({ eventType: 'incident.triggered' }));

    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(fake.table).toBe(platformStatusEvents);
    expect(fake.values).toHaveBeenCalledTimes(1);
    const row = fake.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      incidentId: 'PD-INC-123',
      pdEventType: 'incident.triggered',
      status: 'investigating',
      summary: 'DB write latency over threshold',
      occurredAt: new Date('2026-11-27T10:00:00.000Z'),
    });
    expect(row.rawPayload).toEqual({ event: { event_type: 'incident.triggered' } });
  });

  it.each([
    ['incident.triggered', 'investigating'],
    ['incident.acknowledged', 'identified'],
    ['incident.resolved', 'resolved'],
    ['incident.escalated', 'investigating'],
  ] as const)('projects %s → status=%s on the inserted row', async (eventType, expectedStatus) => {
    const fake = makeFakeDb();
    const svc = new PlatformStatusService(fake.db, new EventEmitter2());

    await svc.record(makeEvent({ eventType }));

    const row = fake.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.status).toBe(expectedStatus);
    expect(row.pdEventType).toBe(eventType);
  });

  it('emits platform.status.event on the EventEmitter2 bus', async () => {
    const fake = makeFakeDb();
    const events = new EventEmitter2();
    const subscriber = jest.fn();
    events.on('platform.status.event', subscriber);

    const svc = new PlatformStatusService(fake.db, events);
    await svc.record(makeEvent({ eventType: 'incident.acknowledged' }));

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith({
      incidentId: 'PD-INC-123',
      pdEventType: 'incident.acknowledged',
      status: 'identified',
      summary: 'DB write latency over threshold',
      occurredAt: new Date('2026-11-27T10:00:00.000Z'),
    });
  });

  it('coerces a missing summary to null in the DB row but leaves it undefined on the bus', async () => {
    const fake = makeFakeDb();
    const events = new EventEmitter2();
    const subscriber = jest.fn();
    events.on('platform.status.event', subscriber);

    const svc = new PlatformStatusService(fake.db, events);
    await svc.record(makeEvent({ summary: undefined }));

    const row = fake.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.summary).toBeNull();
    expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ summary: undefined }));
  });

  it('still emits on the bus when the DB insert throws (availability > durability)', async () => {
    const fake = makeFakeDb(async () => {
      throw new Error('relation "platform_status_events" does not exist');
    });
    const events = new EventEmitter2();
    const subscriber = jest.fn();
    events.on('platform.status.event', subscriber);

    const svc = new PlatformStatusService(fake.db, events);
    // Explicitly: no rejection — record() swallows the DB error.
    await expect(svc.record(makeEvent())).resolves.toBeUndefined();
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('works with no EventEmitter2 injected (unit / boot probe path)', async () => {
    const fake = makeFakeDb();
    const svc = new PlatformStatusService(fake.db); // events: undefined
    await expect(svc.record(makeEvent())).resolves.toBeUndefined();
    expect(fake.insert).toHaveBeenCalledTimes(1);
  });
});
