import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as forge from 'node-forge';
import { getCognitoVerifier } from './cognito';

/**
 * ClearTax §5.7 declared-subcontractor partner access guard.
 *
 * ClearTax is Faatora's accredited OTA access point under the §5.7
 * declared-subcontractor arrangement. During an OTA inspection they
 * need read access to any firm's audit trail. This guard is the single
 * authorisation point for the `GET /partners/cleartax/firms/:firmId/
 * audit` route and is DELIBERATELY STRICT — it must fail closed when
 * any of its three independent checks miss.
 *
 * Three required checks (all must pass):
 *   1. Client-cert chain verified by the TLS terminator (ALB mutual-TLS)
 *      and passed through as the `X-Amzn-Mtls-Clientcert` header (PEM,
 *      URL-encoded). We re-parse it here to assert the Subject CN and
 *      Issuer CN match the configured partner identity and the cert is
 *      not expired. ALB has already validated the chain against the
 *      trust store; our reparse is defence in depth.
 *   2. Caller source IP on `CLEARTAX_PARTNER_IP_ALLOWLIST`. Empty list
 *      means "block all", NOT "allow all" — fail-closed by design so a
 *      mis-deployed empty env does not open the route to the world.
 *   3. Bearer JWT with `custom:role` (or bare `role`) equal to
 *      `clearance-partner`, verified by the standard Cognito verifier.
 *
 * Priority of failures:
 *   - env not configured              → 503 (never silently 200)
 *   - no mTLS header                  → 401
 *   - bad cert / wrong role / IP off  → 403
 *
 * Operational notes: see docs/runbooks/cleartax-partner-access.md
 * for ALB mTLS listener config, cert rotation, and the 403-spike
 * incident playbook.
 */
@Injectable()
export class ClearTaxPartnerGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PartnerRequest>();

    // --- (0) env must be configured --------------------------------------
    // We read env directly (not via loadEnv) so an operator flipping these
    // at runtime does not require a redeploy and so the guard can refuse
    // without depending on the full config schema.
    const subjectCn = process.env.CLEARTAX_PARTNER_CERT_SUBJECT_CN;
    const issuerCn = process.env.CLEARTAX_PARTNER_ISSUER_CN;
    if (!subjectCn || !issuerCn) {
      // 503 is deliberate: the route is defined, but the partner access
      // control plane is not provisioned. A 403 here would imply we
      // evaluated authz and rejected — we did not. A silent 200 would be
      // a severe hole. 503 says "come back when ops has configured me".
      throw new ServiceUnavailableException('ClearTax partner access not configured');
    }

    // --- (1) client cert -------------------------------------------------
    const certHeader = req.headers['x-amzn-mtls-clientcert'];
    const certRaw = Array.isArray(certHeader) ? certHeader[0] : certHeader;
    if (!certRaw) {
      throw new UnauthorizedException('Missing mTLS client certificate');
    }

    let cert: ParsedCert;
    try {
      // ALB URL-encodes the PEM because header values cannot contain CRLF.
      // decodeURIComponent restores the standard PEM with BEGIN/END lines.
      const pem = decodeURIComponent(certRaw);
      cert = parseCertificate(pem);
    } catch {
      throw new ForbiddenException('Invalid mTLS client certificate');
    }

    if (cert.subjectCn !== subjectCn) {
      throw new ForbiddenException('mTLS client certificate Subject CN does not match');
    }
    if (cert.issuerCn !== issuerCn) {
      // Guards against a self-signed cert with a spoofed Subject CN: the
      // Issuer CN must match the ClearTax ops CA. ALB's trust store is
      // the primary line of defence; this is the re-check inside the app.
      throw new ForbiddenException('mTLS client certificate Issuer CN does not match');
    }
    if (cert.notAfter.getTime() <= Date.now()) {
      throw new ForbiddenException('mTLS client certificate is expired');
    }

    // --- (2) source IP allowlist ----------------------------------------
    const allowlist = parseAllowlist(process.env.CLEARTAX_PARTNER_IP_ALLOWLIST ?? '');
    const callerIp = extractCallerIp(req);
    if (!callerIp || !allowlist.some((cidr) => ipInCidr(callerIp, cidr))) {
      throw new ForbiddenException('Source IP not on ClearTax partner allowlist');
    }

    // --- (3) bearer JWT with clearance-partner role ---------------------
    const authz = req.headers['authorization'];
    const token =
      typeof authz === 'string' && authz.startsWith('Bearer ')
        ? authz.slice('Bearer '.length)
        : null;
    if (!token) {
      throw new ForbiddenException('Missing partner bearer token');
    }
    let claims: Record<string, unknown>;
    try {
      claims = (await getCognitoVerifier().verify(token)) as Record<string, unknown>;
    } catch {
      throw new ForbiddenException('Invalid partner bearer token');
    }
    const role = claims['custom:role'] ?? claims['role'];
    if (role !== 'clearance-partner') {
      throw new ForbiddenException('Partner bearer token missing clearance-partner role');
    }

    return true;
  }
}

/** Shape the guard needs from the incoming request. Decoupled from
 *  express so the guard remains unit-testable with a plain object. */
interface PartnerRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
}

interface ParsedCert {
  subjectCn: string;
  issuerCn: string;
  notAfter: Date;
}

/**
 * Parse a PEM-encoded X.509 cert using node-forge and extract the
 * Subject CN, Issuer CN and notAfter. Throws on an unparseable PEM
 * or on a cert without a CN in either of its names.
 */
function parseCertificate(pem: string): ParsedCert {
  const cert = forge.pki.certificateFromPem(pem);
  const subjectField = cert.subject.getField('CN') as { value?: string } | null;
  const issuerField = cert.issuer.getField('CN') as { value?: string } | null;
  const subjectCn = subjectField?.value;
  const issuerCn = issuerField?.value;
  if (!subjectCn || !issuerCn) {
    throw new Error('certificate is missing a Subject or Issuer CN');
  }
  return {
    subjectCn,
    issuerCn,
    notAfter: cert.validity.notAfter,
  };
}

/** Normalise the comma-separated allowlist env into a list of CIDR
 *  strings. Empty, whitespace-only and blank entries are dropped — an
 *  empty final list is "block all" (fail-closed). */
export function parseAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Pick the caller's IP in the ALB/XFF convention: the FIRST entry of
 *  X-Forwarded-For (the real client, before the ALB and any upstream
 *  proxies appended themselves), else the socket remoteAddress. */
export function extractCallerIp(req: PartnerRequest): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (typeof first === 'string' && first.length > 0) {
    const head = first.split(',')[0]?.trim();
    if (head) return head;
  }
  return req.socket?.remoteAddress ?? req.ip ?? '';
}

// --- Minimal CIDR matcher, IPv4 + IPv6 -------------------------------------
//
// We do not pull a dep for this because the surface is tiny (a 30-ish
// line matcher) and a dep that ships "parse-and-match" opens a supply-
// chain hole for a guard that must fail closed. Everything here is
// pure, side-effect-free, and exported for its own unit test.

/** Parse an IPv4 dotted-quad to a 32-bit unsigned int. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const x = Number.parseInt(p, 10);
    if (x < 0 || x > 255 || String(x) !== p) return null;
    n = ((n << 8) | x) >>> 0;
  }
  return n >>> 0;
}

/** Parse an IPv6 (with optional `::` compression and v4-tail) to BigInt. */
function ipv6ToBigInt(ip: string): bigint | null {
  if (!ip.includes(':')) return null;
  // Strip IPv6 zone identifier (fe80::1%eth0) — not meaningful for CIDR.
  const zone = ip.indexOf('%');
  let s = zone >= 0 ? ip.slice(0, zone) : ip;
  // If the trailing group is a dotted-quad (::ffff:192.0.2.1), rewrite
  // it into two 16-bit hex groups so the rest of the parse is uniform.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    s = s.slice(0, lastColon + 1) + `${hi}:${lo}`;
  }
  const dblIdx = s.indexOf('::');
  const halves = dblIdx >= 0 ? [s.slice(0, dblIdx), s.slice(dblIdx + 2)] : [s];
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const explicit = left.length + right.length;
  const zeros = halves.length === 2 ? 8 - explicit : 0;
  if (zeros < 0) return null;
  if (halves.length === 1 && explicit !== 8) return null;
  const groups = [...left, ...Array<string>(zeros).fill('0'), ...right];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}

/**
 * Test whether an IP (v4 or v6 textual) sits inside a CIDR. v4-only CIDRs
 * also match the v4-mapped v6 form `::ffff:a.b.c.d` so an ALB-forwarded
 * IPv4 client is matched by a plain v4 CIDR in the allowlist.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const base = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const bitsStr = slash >= 0 ? cidr.slice(slash + 1) : null;
  const ipNorm = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (base.includes('.')) {
    const bits = bitsStr !== null ? Number.parseInt(bitsStr, 10) : 32;
    if (!(bits >= 0 && bits <= 32)) return false;
    const b = ipv4ToInt(base);
    const i = ipv4ToInt(ipNorm);
    if (b === null || i === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (b & mask) >>> 0 === (i & mask) >>> 0;
  }
  if (base.includes(':')) {
    const bits = bitsStr !== null ? Number.parseInt(bitsStr, 10) : 128;
    if (!(bits >= 0 && bits <= 128)) return false;
    const b = ipv6ToBigInt(base);
    const i = ipv6ToBigInt(ip);
    if (b === null || i === null) return false;
    const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
    return (b & mask) === (i & mask);
  }
  return false;
}
