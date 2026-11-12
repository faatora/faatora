import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * PagerDuty webhook signature verification.
 *
 * PagerDuty signs outbound webhook deliveries with an HMAC SHA256 of
 * the raw request body using the shared secret you set on the V3
 * webhook subscription. The signature is sent in the
 * `X-PagerDuty-Signature` header as a comma-separated list of
 * versioned signatures, e.g.:
 *
 *   X-PagerDuty-Signature: v1=aaaa...,v1=bbbb...
 *
 * Multiple `v1=` entries exist so operators can rotate secrets with a
 * grace window where both the old and new secret are valid. We
 * accept the request when ANY `v1=` entry matches the HMAC of the
 * raw body under the configured secret.
 *
 * All comparisons use `crypto.timingSafeEqual` to avoid leaking the
 * expected digest via timing side-channels.
 */

const VERSIONED_RE = /^v(\d+)=([0-9a-f]+)$/i;

/**
 * Verify that `headerValue` contains a `v1=<hex>` entry whose hex
 * matches HMAC-SHA256(rawBody, secret). Unknown version prefixes are
 * ignored so PagerDuty rolling forward to v2 does not break us; the
 * check simply fails until the server-side is upgraded.
 */
export function verifyPagerDutySignature(
  rawBody: Buffer,
  headerValue: string | undefined,
  secret: string,
): boolean {
  if (!headerValue || !secret) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();

  const entries = headerValue.split(',').map((s) => s.trim());
  for (const entry of entries) {
    const match = VERSIONED_RE.exec(entry);
    if (!match) continue;
    if (match[1] !== '1') continue; // ignore unknown versions
    const candidate = Buffer.from(match[2], 'hex');
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}
