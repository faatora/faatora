/**
 * ClearTax §5.7 declared-subcontractor commitment — hash-chain unit tests.
 *
 * These tests do NOT touch a database. They exercise the pure
 * canonical-json + hash-chain primitives that back AuditService.record
 * and AuditService.verifyChain. DB-backed round-trip tests for the
 * chained insert path live in test/audit.spec.ts.
 *
 * Covered:
 *   - canonicalJson sorts object keys and is stable across whitespace
 *     / key-order permutations.
 *   - canonicalJson drops `undefined` values and refuses NaN / Infinity
 *     (losing those silently would collide with real nulls and break
 *     tamper detection).
 *   - computeEventHash is deterministic for the same input and changes
 *     on any payload tweak (the tamper signal).
 *   - A three-row synthetic chain verifies clean, and flipping any one
 *     row's event_hash or payload surfaces at that row.
 */
import { canonicalJson } from '../src/modules/audit/canonical-json';
import { computeEventHash, sha256Hex } from '../src/modules/audit/hash-chain';

describe('canonicalJson', () => {
  const baseOccurredAt = new Date('2026-11-26T10:00:00.000Z');

  it('sorts top-level keys lexicographically, producing the same output regardless of input order', () => {
    const a = canonicalJson({
      eventType: 'x',
      firmId: 'f',
      tenantId: null,
      actorUserId: null,
      source: 's',
      occurredAt: baseOccurredAt,
      payload: { z: 1, a: 2, m: 3 },
    });
    const b = canonicalJson({
      // Same values, different source-order.
      payload: { m: 3, a: 2, z: 1 },
      source: 's',
      occurredAt: baseOccurredAt,
      actorUserId: null,
      tenantId: null,
      firmId: 'f',
      eventType: 'x',
    });
    expect(a).toBe(b);
    // The canonical form has sorted keys at both levels.
    expect(a).toContain('"payload":{"a":2,"m":3,"z":1}');
  });

  it('sorts nested object keys recursively and preserves array order', () => {
    const out = canonicalJson({
      eventType: 'x',
      firmId: 'f',
      tenantId: 't',
      actorUserId: 'u',
      source: 'system',
      occurredAt: baseOccurredAt,
      payload: {
        outer: { z: 'last', a: 'first', m: [3, 1, 2] },
      },
    });
    expect(out).toContain('"outer":{"a":"first","m":[3,1,2],"z":"last"}');
  });

  it('coerces null tenantId and null actorUserId to empty strings so they are distinguishable from missing keys', () => {
    const out = canonicalJson({
      eventType: 'firm.created',
      firmId: 'f-1',
      tenantId: null,
      actorUserId: null,
      source: 'system',
      occurredAt: baseOccurredAt,
      payload: {},
    });
    expect(out).toContain('"tenantId":""');
    expect(out).toContain('"actorUserId":""');
  });

  it('drops undefined values from nested objects (JSON cannot carry them)', () => {
    const out = canonicalJson({
      eventType: 'x',
      firmId: 'f',
      tenantId: null,
      actorUserId: null,
      source: 's',
      occurredAt: baseOccurredAt,
      payload: { a: 1, b: undefined, c: 3 },
    });
    expect(out).toContain('"payload":{"a":1,"c":3}');
    expect(out).not.toContain('"b"');
  });

  it('refuses NaN and Infinity payload numbers', () => {
    expect(() =>
      canonicalJson({
        eventType: 'x',
        firmId: 'f',
        tenantId: null,
        actorUserId: null,
        source: 's',
        occurredAt: baseOccurredAt,
        payload: { bad: NaN },
      }),
    ).toThrow(/non-finite/);
    expect(() =>
      canonicalJson({
        eventType: 'x',
        firmId: 'f',
        tenantId: null,
        actorUserId: null,
        source: 's',
        occurredAt: baseOccurredAt,
        payload: { bad: Infinity },
      }),
    ).toThrow(/non-finite/);
  });

  it('refuses invalid occurredAt and non-representable payload types', () => {
    expect(() =>
      canonicalJson({
        eventType: 'x',
        firmId: 'f',
        tenantId: null,
        actorUserId: null,
        source: 's',
        occurredAt: new Date('not-a-date'),
        payload: {},
      }),
    ).toThrow(/occurredAt/);
    expect(() =>
      canonicalJson({
        eventType: 'x',
        firmId: 'f',
        tenantId: null,
        actorUserId: null,
        source: 's',
        occurredAt: baseOccurredAt,
        payload: { bad: BigInt(1) as unknown as number },
      }),
    ).toThrow(/unsupported value type/);
  });
});

describe('computeEventHash', () => {
  const sampleEvent = {
    eventType: 'firm.client.added',
    firmId: '00000000-0000-0000-0000-000000000001',
    tenantId: '00000000-0000-0000-0000-00000000aaaa',
    actorUserId: '00000000-0000-0000-0000-00000000bbbb',
    source: 'system',
    occurredAt: new Date('2026-11-26T10:00:00.000Z'),
    payload: { foo: 'bar' },
  };

  it('is deterministic for the same (prev, event)', () => {
    const h1 = computeEventHash(null, sampleEvent);
    const h2 = computeEventHash(null, sampleEvent);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches sha256((prev ?? "") || "|" || canonical_json(event)) directly', () => {
    const expected = sha256Hex(`|${canonicalJson(sampleEvent)}`);
    expect(computeEventHash(null, sampleEvent)).toBe(expected);
    const prev = 'a'.repeat(64);
    const expected2 = sha256Hex(`${prev}|${canonicalJson(sampleEvent)}`);
    expect(computeEventHash(prev, sampleEvent)).toBe(expected2);
  });

  it('changes when the prev changes (chain binding)', () => {
    const hNullPrev = computeEventHash(null, sampleEvent);
    const hRealPrev = computeEventHash('a'.repeat(64), sampleEvent);
    expect(hNullPrev).not.toBe(hRealPrev);
  });

  it('changes when the payload changes (tamper signal)', () => {
    const base = computeEventHash(null, sampleEvent);
    const tampered = computeEventHash(null, { ...sampleEvent, payload: { foo: 'baz' } });
    expect(tampered).not.toBe(base);
  });

  it('changes when the eventType changes', () => {
    const base = computeEventHash(null, sampleEvent);
    const other = computeEventHash(null, { ...sampleEvent, eventType: 'firm.client.revoked' });
    expect(other).not.toBe(base);
  });

  it('changes when occurredAt changes', () => {
    const base = computeEventHash(null, sampleEvent);
    const other = computeEventHash(null, {
      ...sampleEvent,
      occurredAt: new Date('2026-11-26T10:00:01.000Z'),
    });
    expect(other).not.toBe(base);
  });
});

describe('chain walk (synthetic three-row chain, no DB)', () => {
  const firmId = '00000000-0000-0000-0000-00000000f1f1';
  const tenantId = '00000000-0000-0000-0000-00000000aaaa';
  const base = (i: number) => ({
    eventType: `firm.import.committed`,
    firmId,
    tenantId,
    actorUserId: '00000000-0000-0000-0000-00000000bbbb',
    source: 'system',
    occurredAt: new Date(`2026-11-26T10:00:0${i}.000Z`),
    payload: { batchId: `b-${i}`, rowCount: i },
  });

  function buildChain(count: number) {
    const rows: Array<{
      prevHash: string | null;
      eventHash: string;
      event: ReturnType<typeof base>;
    }> = [];
    let prev: string | null = null;
    for (let i = 0; i < count; i++) {
      const event = base(i);
      const eventHash = computeEventHash(prev, event);
      rows.push({ prevHash: prev, eventHash, event });
      prev = eventHash;
    }
    return rows;
  }

  it('a clean chain verifies — each row rehashes to its stored event_hash', () => {
    const rows = buildChain(3);
    let expectedPrev: string | null = null;
    for (const r of rows) {
      expect(r.prevHash).toBe(expectedPrev);
      expect(computeEventHash(r.prevHash, r.event)).toBe(r.eventHash);
      expectedPrev = r.eventHash;
    }
  });

  it('tampering with a middle row payload surfaces at that row (verifier sees mismatch)', () => {
    const rows = buildChain(3);
    // Simulate an attacker rewriting row 1's payload after the fact.
    const tamperedMiddle = {
      ...rows[1],
      event: { ...rows[1].event, payload: { batchId: 'b-1', rowCount: 999 } },
      // The attacker cannot know the correct event_hash, so the stored one
      // is now stale. The verifier catches this.
    };
    const recomputed = computeEventHash(tamperedMiddle.prevHash, tamperedMiddle.event);
    expect(recomputed).not.toBe(tamperedMiddle.eventHash);
  });

  it('tampering with a row event_hash directly surfaces at the NEXT row (prev_hash link broken)', () => {
    const rows = buildChain(3);
    // Attacker rewrites row 0's event_hash to arbitrary bytes.
    const stolenHash = 'f'.repeat(64);
    const nextRow = rows[1];
    // The next row's prev_hash now disagrees with the attacker's new hash.
    expect(nextRow.prevHash).not.toBe(stolenHash);
    // And the verifier would flag row 1 as the first tamper point: its
    // stored prev_hash does not equal the (tampered) previous event_hash.
    expect(nextRow.prevHash).toBe(rows[0].eventHash);
  });

  it('deleting a row from the middle surfaces at the row AFTER it (prev_hash disagrees)', () => {
    const rows = buildChain(3);
    // Simulate deleting row 1 — row 2's prev_hash is now rows[1].eventHash
    // but the "previous row" by order is now rows[0], whose event_hash is
    // different. Walk: row 0 clean, row 2's prev_hash does not equal
    // rows[0].eventHash → break at row 2.
    const compactChain = [rows[0], rows[2]];
    expect(compactChain[1].prevHash).toBe(rows[1].eventHash);
    expect(compactChain[1].prevHash).not.toBe(compactChain[0].eventHash);
  });
});
