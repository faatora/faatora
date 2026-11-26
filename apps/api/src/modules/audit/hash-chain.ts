/**
 * ClearTax §5.7 declared-subcontractor commitment — audit-event hash chain.
 *
 * Every firm_audit_events row is linked to its predecessor on the same
 * (firm_id, tenant_id) chain by:
 *
 *   event_hash = sha256_hex( (prev_hash ?? '') || '|' || canonical_json(event) )
 *
 * - The "|" separator is included so a prev_hash of null (encoded as '')
 *   is unambiguously distinguishable from a prev_hash whose hex happens
 *   to prefix the canonical JSON. Any after-the-fact tampering with a row
 *   surfaces at THAT row AND every row after it, which is what makes the
 *   chain "tamper-evident" — this is the §5.7 wording in the ClearTax
 *   partner pack.
 *
 * - The chain is per (firm_id, tenant_id):
 *     * Firm-level events (tenant_id = NULL) form a firm-wide chain.
 *     * Per-tenant events form one chain per client-tenant inside a firm.
 *   An inspector therefore walks one chain to verify one tenant's audit
 *   trail — they do not need to see any other tenant's data to prove any
 *   given tenant's trail is intact.
 *
 * - canonical_json is deliberately deterministic: see
 *   ./canonical-json.ts for the exact ordering rules. Changing those
 *   rules invalidates every chain, so the format is frozen; new fields
 *   can be added to `payload` safely because `payload` is itself
 *   recursively canonicalised.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, type ChainableEvent } from './canonical-json';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Compute the event_hash for a new row given the previous row's
 * event_hash (NULL for the first row of a chain).
 */
export function computeEventHash(prevHash: string | null, event: ChainableEvent): string {
  const canonical = canonicalJson(event);
  return sha256Hex(`${prevHash ?? ''}|${canonical}`);
}
