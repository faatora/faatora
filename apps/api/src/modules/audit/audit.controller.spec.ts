/**
 * Unit tests for the partner-facing branch of `AuditController`.
 *
 * These tests do NOT round-trip HTTP; they call the handler method
 * directly with a stubbed `AuditService` and separately assert that
 * `ClearTaxPartnerGuard` permits the same request. The purpose is to
 * pin the three partner-route contract behaviours:
 *
 *   - the guard is wired on the handler (route is NOT open),
 *   - the handler forwards `firmId` straight through to `AuditService.list`
 *     without any ownership-of-firm transform,
 *   - `tenantId`, `limit`, `since` are parsed and forwarded correctly.
 */
import * as forge from 'node-forge';
import { AuditController } from './audit.controller';
import type { AuditService, FirmAuditEvent } from './audit.service';

jest.mock('../../auth/cognito', () => ({
  getCognitoVerifier: jest.fn(),
}));

import { getCognitoVerifier } from '../../auth/cognito';
import { ClearTaxPartnerGuard } from '../../auth/cleartax-partner.guard';

const mockedVerifier = getCognitoVerifier as jest.MockedFunction<typeof getCognitoVerifier>;

const SUBJECT_CN = 'ops.cleartax.om';
const ISSUER_CN = 'ClearTax Ops CA';
const FIRM_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';

describe('AuditController — ClearTax partner route', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.CLEARTAX_PARTNER_CERT_SUBJECT_CN = SUBJECT_CN;
    process.env.CLEARTAX_PARTNER_ISSUER_CN = ISSUER_CN;
    process.env.CLEARTAX_PARTNER_IP_ALLOWLIST = '203.0.113.0/24';
    mockedVerifier.mockReset();
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('is decorated with ClearTaxPartnerGuard (route is NOT open)', () => {
    // Nest stores @UseGuards() metadata as the global 'guards' key via
    // the Reflector. We assert the metadata is present without booting
    // the full Nest runtime, which keeps this a true unit test.
    const guards: unknown = Reflect.getMetadata(
      '__guards__',
      AuditController.prototype.cleartaxAudit,
    );
    expect(Array.isArray(guards)).toBe(true);
    expect((guards as unknown[]).some((g) => g === ClearTaxPartnerGuard)).toBe(true);
  });

  it('forwards firmId, tenantId, limit and since to AuditService.list', async () => {
    const events: FirmAuditEvent[] = [
      sampleEvent({ firmId: FIRM_ID, tenantId: TENANT_ID, eventType: 'firm.client.added' }),
    ];
    const audit = { list: jest.fn().mockResolvedValue(events) } as unknown as AuditService;
    const controller = new AuditController(audit);
    const got = await controller.cleartaxAudit(FIRM_ID, TENANT_ID, '25', '2026-01-01T00:00:00Z');
    expect(got).toEqual(events);
    expect(audit.list).toHaveBeenCalledWith(FIRM_ID, {
      limit: 25,
      since: new Date('2026-01-01T00:00:00Z'),
      tenantId: TENANT_ID,
    });
  });

  it('clamps limit to [1, 500] and drops an un-parseable since', async () => {
    const audit = { list: jest.fn().mockResolvedValue([]) } as unknown as AuditService;
    const controller = new AuditController(audit);
    await controller.cleartaxAudit(FIRM_ID, undefined, '99999', 'not-a-date');
    expect(audit.list).toHaveBeenCalledWith(FIRM_ID, {
      limit: 500,
      since: undefined,
      tenantId: undefined,
    });
  });

  it('treats an empty ?tenantId= as "whole firm" (undefined, not empty-string scope)', async () => {
    const audit = { list: jest.fn().mockResolvedValue([]) } as unknown as AuditService;
    const controller = new AuditController(audit);
    await controller.cleartaxAudit(FIRM_ID, '');
    expect(audit.list).toHaveBeenCalledWith(FIRM_ID, {
      limit: 50,
      since: undefined,
      tenantId: undefined,
    });
  });

  it('happy path: guard permits a fully-valid request and controller returns the events', async () => {
    mockedVerifier.mockReturnValue({
      verify: jest.fn().mockResolvedValue({ sub: 'u', 'custom:role': 'clearance-partner' }),
    } as any);
    const events: FirmAuditEvent[] = [
      sampleEvent({ firmId: FIRM_ID, tenantId: null, eventType: 'firm.created' }),
    ];
    const audit = { list: jest.fn().mockResolvedValue(events) } as unknown as AuditService;
    const controller = new AuditController(audit);
    const guard = new ClearTaxPartnerGuard();

    const pem = makeCert({ subjectCn: SUBJECT_CN, issuerCn: ISSUER_CN, daysValid: 30 });
    const req = {
      headers: {
        'x-amzn-mtls-clientcert': encodeURIComponent(pem),
        'x-forwarded-for': '203.0.113.9',
        authorization: 'Bearer tok',
      },
      socket: { remoteAddress: '10.0.0.1' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
    } as any;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const got = await controller.cleartaxAudit(FIRM_ID, undefined, '10', undefined);
    expect(got).toEqual(events);
    expect(audit.list).toHaveBeenCalledWith(FIRM_ID, {
      limit: 10,
      since: undefined,
      tenantId: undefined,
    });
  });
});

function sampleEvent(partial: Partial<FirmAuditEvent>): FirmAuditEvent {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    firmId: FIRM_ID,
    tenantId: null,
    actorUserId: null,
    eventType: 'firm.created',
    payload: {},
    occurredAt: new Date(),
    source: 'system',
    eventHash: null,
    prevHash: null,
    ...partial,
  };
}

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
