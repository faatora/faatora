import { createHash } from 'node:crypto';

/**
 * Per-tenant archive hash chain.
 *
 * Each `archive_records` row carries three hex-encoded SHA-256 fields:
 *   - `sha256`      — the hash of the archived payload bytes (the signed XML).
 *   - `prev_sha256` — the `sha256` of the previous row for THIS tenant, in
 *                     archived_at order. `null` for the first row of a tenant.
 *   - `chain_hash`  — the output of `computeChainHash(prev_sha256, sha256)`.
 *
 * The chain is per-tenant: tenants are isolated by RLS and each one's rows
 * form an independent chain so a compromise in one tenant does not break
 * verification elsewhere.
 *
 * Algorithm (document this for A14 and auditors):
 *   chain_hash = sha256_hex( utf8( (prev ?? "") + "|" + sha256 ) )
 *
 * The separator "|" is included so that a prev of null is distinguishable
 * from a prev whose hex happens to be a prefix of `sha256` — tampering with
 * either part changes the output, so tampering with any payload surfaces at
 * that row AND at every row thereafter.
 */

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function computeChainHash(prevSha256: string | null, sha256: string): string {
  return createHash('sha256')
    .update(`${prevSha256 ?? ''}|${sha256}`, 'utf8')
    .digest('hex');
}
