/**
 * Unit tests for `ClearTaxPartnerGuard`.
 *
 * The guard is the single authorisation point for the ClearTax §5.7
 * partner read route; every one of its three independent checks has a
 * negative test here plus one happy-path test with the full stack of
 * valid inputs. The Cognito verifier is mocked (we do not reach AWS);
 * the mTLS client cert is a self-signed PEM generated on the fly by
 * node-forge so there are no secrets or fixtures checked in.
 */
import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as forge from 'node-forge';

jest.mock('./cognito', () => ({
  getCognitoVerifier: jest.fn(),
}));

import { getCognitoVerifier } from './cognito';
import {
  ClearTaxPartnerGuard,
  extractCallerIp,
  ipInCidr,
  parseAllowlist,
} from './cleartax-partner.guard';

const mockedVerifier = getCognitoVerifier as jest.MockedFunction<typeof getCognitoVerifier>;

const SUBJECT_CN = 'ops.cleartax.om';
const ISSUER_CN = 'ClearTax Ops CA';
const ALLOWLIST = '203.0.113.0/24,2401:db00::/32';
const ALLOWED_IP = '203.0.113.42';

describe('ClearTaxPartnerGuard', () => {
  let guard: ClearTaxPartnerGuard;
  const origEnv = { ...process.env };

  beforeEach(() => {
    guard = new ClearTaxPartnerGuard();
    process.env.CLEARTAX_PARTNER_CERT_SUBJECT_CN = SUBJECT_CN;
    process.env.CLEARTAX_PARTNER_ISSUER_CN = ISSUER_CN;
    process.env.CLEARTAX_PARTNER_IP_ALLOWLIST = ALLOWLIST;
    mockedVerifier.mockReset();
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('returns 503 when CLEARTAX_PARTNER_CERT_SUBJECT_CN is unset', async () => {
    delete process.env.CLEARTAX_PARTNER_CERT_SUBJECT_CN;
    const ctx = makeCtx({
      headers: {},
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns 503 when CLEARTAX_PARTNER_ISSUER_CN is unset', async () => {
    delete process.env.CLEARTAX_PARTNER_ISSUER_CN;
    const ctx = makeCtx({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns 401 when the mTLS header is absent', async () => {
    const ctx = makeCtx({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 403 when the mTLS header value is not a parseable PEM', async () => {
    const ctx = makeCtx({
      headers: { 'x-amzn-mtls-clientcert': encodeURIComponent('not a cert') },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when the cert Subject CN does not match', async () => {
    const pem = makeCert({ subjectCn: 'attacker.evil', issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: { 'x-amzn-mtls-clientcert': encodeURIComponent(pem) },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when the cert Issuer CN does not match (self-signed with correct Subject)', async () => {
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: 'Rogue CA', daysValid: 30 });
    const ctx = makeCtx({
      headers: { 'x-amzn-mtls-clientcert': encodeURIComponent(pem) },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when the cert is expired', async () => {
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: -1 });
    const ctx = makeCtx({
      headers: { 'x-amzn-mtls-clientcert': encodeURIComponent(pem) },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when the caller IP is not on the allowlist', async () => {
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        'x-forwarded-for': '198.51.100.99',
        authorization: 'Bearer any',
      },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when the allowlist env is empty (block-all, not allow-all)', async () => {
    process.env.CLEARTAX_PARTNER_IP_ALLOWLIST = '';
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        'x-forwarded-for': ALLOWED_IP,
        authorization: 'Bearer any',
      },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when the bearer token is missing', async () => {
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        'x-forwarded-for': ALLOWED_IP,
      },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when the bearer token is invalid', async () => {
    mockedVerifier.mockReturnValue({
      verify: jest.fn().mockRejectedValue(new Error('bad token')),
    } as any);
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        'x-forwarded-for': ALLOWED_IP,
        authorization: 'Bearer anything',
      },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 when the bearer JWT role is not clearance-partner', async () => {
    mockedVerifier.mockReturnValue({
      verify: jest.fn().mockResolvedValue({ sub: 'u', 'custom:role': 'firm-admin' }),
    } as any);
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        'x-forwarded-for': ALLOWED_IP,
        authorization: 'Bearer tok',
      },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a valid cert + allowlisted IP + bearer with role=clearance-partner (custom:role)', async () => {
    mockedVerifier.mockReturnValue({
      verify: jest.fn().mockResolvedValue({ sub: 'u', 'custom:role': 'clearance-partner' }),
    } as any);
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        'x-forwarded-for': ALLOWED_IP,
        authorization: 'Bearer tok',
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('also accepts a bare `role` claim (no `custom:` prefix)', async () => {
    mockedVerifier.mockReturnValue({
      verify: jest.fn().mockResolvedValue({ sub: 'u', role: 'clearance-partner' }),
    } as any);
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        'x-forwarded-for': ALLOWED_IP,
        authorization: 'Bearer tok',
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('picks the first entry of X-Forwarded-For (not the last hop)', async () => {
    mockedVerifier.mockReturnValue({
      verify: jest.fn().mockResolvedValue({ sub: 'u', 'custom:role': 'clearance-partner' }),
    } as any);
    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const ctx = makeCtx({
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        // ALB format: real client first, then intermediate hops.
        'x-forwarded-for': `${ALLOWED_IP}, 10.0.0.1, 10.0.0.2`,
        authorization: 'Bearer tok',
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('ClearTaxPartnerGuard helpers', () => {
  describe('parseAllowlist', () => {
    it('splits, trims and drops empty entries', () => {
      expect(parseAllowlist(' 10.0.0.0/8 , , 192.168.0.0/16 ,')).toEqual([
        '10.0.0.0/8',
        '192.168.0.0/16',
      ]);
    });
    it('empty input yields an empty list (= block all, upstream)', () => {
      expect(parseAllowlist('')).toEqual([]);
    });
  });

  describe('extractCallerIp', () => {
    it('prefers the first X-Forwarded-For entry', () => {
      expect(
        extractCallerIp({
          headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
          socket: { remoteAddress: '10.0.0.1' },
        }),
      ).toBe('1.2.3.4');
    });
    it('falls back to socket.remoteAddress when XFF is absent', () => {
      expect(
        extractCallerIp({
          headers: {},
          socket: { remoteAddress: '10.0.0.1' },
        }),
      ).toBe('10.0.0.1');
    });
    it('returns empty string when neither is available', () => {
      expect(extractCallerIp({ headers: {} })).toBe('');
    });
  });

  describe('ipInCidr (IPv4)', () => {
    it('matches an inclusive host inside a /24', () => {
      expect(ipInCidr('203.0.113.1', '203.0.113.0/24')).toBe(true);
      expect(ipInCidr('203.0.113.255', '203.0.113.0/24')).toBe(true);
    });
    it('rejects a host just outside the /24', () => {
      expect(ipInCidr('203.0.114.0', '203.0.113.0/24')).toBe(false);
    });
    it('accepts a /32 host route', () => {
      expect(ipInCidr('203.0.113.42', '203.0.113.42/32')).toBe(true);
      expect(ipInCidr('203.0.113.43', '203.0.113.42/32')).toBe(false);
    });
    it('accepts a /0 catch-all', () => {
      expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    });
    it('matches a v4 CIDR against an IPv4-mapped IPv6 caller', () => {
      expect(ipInCidr('::ffff:203.0.113.5', '203.0.113.0/24')).toBe(true);
    });
    it('rejects malformed octets', () => {
      expect(ipInCidr('203.0.113.256', '203.0.113.0/24')).toBe(false);
      expect(ipInCidr('203.0.113.1', '203.0.113.0/40')).toBe(false);
    });
  });

  describe('ipInCidr (IPv6)', () => {
    it('matches a compressed-form host in a prefix', () => {
      expect(ipInCidr('2401:db00::1', '2401:db00::/32')).toBe(true);
      expect(ipInCidr('2401:db01::1', '2401:db00::/32')).toBe(false);
    });
    it('rejects a mis-matched prefix at the boundary', () => {
      expect(ipInCidr('2401:db00:ffff::', '2401:db00::/32')).toBe(true);
      expect(ipInCidr('2401:db01::', '2401:db00::/32')).toBe(false);
    });
  });
});

// --- helpers ---------------------------------------------------------------

/** Minimal ExecutionContext double: just enough to satisfy the guard. */
function makeCtx(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as any;
}

/**
 * Generate a self-signed X.509 cert whose Subject CN and Issuer CN are
 * set to the given values. For the "issuer does not match" negative test
 * we set a different Issuer CN while keeping the correct Subject — the
 * cert is still self-signed, but the guard asserts Issuer CN != attacker,
 * which is the whole point of checking Issuer in addition to Subject.
 *
 * `daysValid` can be negative to generate an already-expired cert.
 */
function makeCert(opts: { subjectCn: string; issuerCn: string; daysValid: number }): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now()) + Math.floor(Math.random() * 1_000).toString();
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(now.getTime() + opts.daysValid * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: 'commonName', value: opts.subjectCn }]);
  cert.setIssuer([{ name: 'commonName', value: opts.issuerCn }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}
