/**
 * ClearTax §5.7 declared-subcontractor commitment — canonical JSON for the
 * audit-event hash chain.
 *
 * Canonicalisation rules (frozen — changing any of these invalidates every
 * existing chain, which breaks the §5.7 tamper-evidence guarantee, so any
 * change requires a chain-rotation migration):
 *
 *   1. Object keys are sorted lexicographically (UTF-16 code unit order,
 *      matching JavaScript's Array.prototype.sort default).
 *   2. Arrays preserve insertion order.
 *   3. null, true, false, finite numbers and strings serialise as their
 *      standard JSON forms — JSON.stringify's output for those is already
 *      canonical.
 *   4. undefined values and function values are DROPPED before hashing.
 *      A caller that wants to hash `undefined` must pass `null`.
 *   5. Numbers that are NaN or +/-Infinity are REJECTED: the standard JSON
 *      output for these is `null` which would silently collide with real
 *      nulls and defeat tamper detection.
 *
 * The hashed envelope shape is:
 *
 *   {
 *     eventType:    string,
 *     firmId:       uuid string,
 *     tenantId:     uuid string or '' when NULL,
 *     actorUserId:  uuid string or '' when NULL,
 *     source:       string,
 *     occurredAt:   ISO-8601 UTC string, millisecond precision + 'Z',
 *     payload:      arbitrary JSON (recursively canonicalised),
 *   }
 *
 * `id` and the hash columns themselves are NOT in the envelope — they are
 * derived from the envelope and must not feed back into it.
 */

export interface ChainableEvent {
  eventType: string;
  firmId: string;
  tenantId: string | null;
  actorUserId: string | null;
  source: string;
  occurredAt: Date | string;
  payload: unknown;
}

/**
 * Format a Date as an ISO-8601 UTC string with millisecond precision and
 * a trailing 'Z'. Node's `Date.prototype.toISOString` already does this,
 * but we call it out explicitly because the migration-time SQL backfill
 * (see 1710002100000_firm_audit_event_hash_chain.cjs top comment) uses
 * the same format from Postgres `to_char`, and any drift between the two
 * breaks the chain.
 */
function isoUtcMs(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) {
    throw new Error('canonicalJson: occurredAt is not a valid Date');
  }
  return date.toISOString();
}

function canonicalise(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite numbers are not permitted');
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined || typeof v === 'function') continue;
      out[k] = canonicalise(v);
    }
    return out;
  }
  // bigint, symbol, function: not representable; refuse rather than lose
  // tamper detection.
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`);
}

export function canonicalJson(event: ChainableEvent): string {
  const envelope = {
    actorUserId: event.actorUserId ?? '',
    eventType: event.eventType,
    firmId: event.firmId,
    occurredAt: isoUtcMs(event.occurredAt),
    payload: event.payload ?? {},
    source: event.source,
    tenantId: event.tenantId ?? '',
  };
  return JSON.stringify(canonicalise(envelope));
}
