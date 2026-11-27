/**
 * Unit tests for `ImpersonationController`.
 *
 * The controller's job is three sequential checks (link → role → write)
 * plus one side effect (event emit); DB access is stubbed so the test
 * is a pure branch-and-outcome check. End-to-end persistence of
 * firm_impersonation_events is covered implicitly by the TenantGuard's
 * acceptance of the row shape — if the schema ever drifted, the
 * controller spec would still pass but the tenant-guard integration
 * would fail at RLS, which is the right signal.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ImpersonationController, extractClientContext } from './impersonation.controller';
import type { ActiveImpersonationSession, ImpersonationService } from './impersonation.service';

const FIRM_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const SESSION_ID = '44444444-4444-4444-4444-444444444444';

describe('ImpersonationController', () => {
  function build(
    opts: {
      linkedToTenant?: boolean;
      role?: string;
    } = {},
  ) {
    const linked = opts.linkedToTenant ?? true;
    const role = opts.role ?? 'staff';
    // Database stub: only transaction() is invoked by withFirm. The tx
    // returns [{id: ...}] when the link exists, [] otherwise.
    const db: any = {
      transaction: async (fn: (tx: any) => Promise<any>) =>
        fn({
          execute: jest.fn().mockResolvedValue({ rows: [] }),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => (linked ? [{ id: 'link-xyz' }] : []),
              }),
            }),
          }),
        }),
    };
    const session: ActiveImpersonationSession = {
      id: SESSION_ID,
      firmId: FIRM_ID,
      clientTenantId: TENANT_ID,
      userId: USER_ID,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const impersonation: ImpersonationService = {
      start: jest.fn().mockResolvedValue(session),
    } as unknown as ImpersonationService;
    const events = new EventEmitter2();
    const emitSpy = jest.spyOn(events, 'emit');
    const controller = new ImpersonationController(db, impersonation, events);
    const req: any = {
      userId: USER_ID,
      firmId: FIRM_ID,
      firmRole: role,
      email: 'actor@test',
      headers: { 'user-agent': 'FaatoraTest/1.0' },
      socket: { remoteAddress: '203.0.113.9' },
    };
    return { controller, req, impersonation, emitSpy, session };
  }

  it('404 when the (firmId, tenantId) link is not present under RLS', async () => {
    const { controller, req, impersonation } = build({ linkedToTenant: false });
    await expect(controller.start(req, FIRM_ID, TENANT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The row write must NOT be attempted when the link check fails.
    expect(impersonation.start).not.toHaveBeenCalled();
  });

  it('403 when the caller is a read_only firm member', async () => {
    const { controller, req, impersonation } = build({ role: 'read_only' });
    await expect(controller.start(req, FIRM_ID, TENANT_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(impersonation.start).not.toHaveBeenCalled();
  });

  it('403 for any unknown role as well (allowlist, not blocklist)', async () => {
    const { controller, req, impersonation } = build({ role: 'guest' });
    await expect(controller.start(req, FIRM_ID, TENANT_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(impersonation.start).not.toHaveBeenCalled();
  });

  it('allows the three expected roles', async () => {
    for (const role of ['owner', 'partner', 'staff']) {
      const { controller, req, impersonation } = build({ role });
      const out = await controller.start(req, FIRM_ID, TENANT_ID);
      expect(out.tenantId).toBe(TENANT_ID);
      expect(impersonation.start).toHaveBeenCalledWith({
        firmId: FIRM_ID,
        clientTenantId: TENANT_ID,
        userId: USER_ID,
        userAgent: 'FaatoraTest/1.0',
        ip: '203.0.113.9',
      });
    }
  });

  it('happy path returns { tenantId, expiresAt } and emits accountant.impersonation.started', async () => {
    const { controller, req, emitSpy, session } = build({ role: 'staff' });
    const out = await controller.start(req, FIRM_ID, TENANT_ID);
    expect(out).toEqual({
      tenantId: TENANT_ID,
      expiresAt: session.expiresAt.toISOString(),
    });
    expect(emitSpy).toHaveBeenCalledWith(
      'accountant.impersonation.started',
      expect.objectContaining({
        firmId: FIRM_ID,
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        sessionId: SESSION_ID,
        originalRole: 'staff',
      }),
    );
  });

  it('does not throw when EventEmitter2 is not wired (optional dep)', async () => {
    const { controller, req, impersonation } = build({ role: 'owner' });
    // Rebuild without events.
    const ctrl = new ImpersonationController((controller as any).db, impersonation, undefined);
    await expect(ctrl.start(req, FIRM_ID, TENANT_ID)).resolves.toEqual(
      expect.objectContaining({ tenantId: TENANT_ID }),
    );
  });
});

describe('extractClientContext', () => {
  it('prefers the first X-Forwarded-For hop over socket.remoteAddress', () => {
    const got = extractClientContext({
      headers: {
        'user-agent': 'UA/1.0',
        'x-forwarded-for': '203.0.113.5, 10.0.0.1',
      },
      socket: { remoteAddress: '10.0.0.1' },
    });
    expect(got).toEqual({ userAgent: 'UA/1.0', ip: '203.0.113.5' });
  });

  it('falls back to socket.remoteAddress when XFF is absent', () => {
    const got = extractClientContext({
      headers: { 'user-agent': 'UA/1.0' },
      socket: { remoteAddress: '198.51.100.5' },
    });
    expect(got).toEqual({ userAgent: 'UA/1.0', ip: '198.51.100.5' });
  });

  it('returns { userAgent: null, ip: null } when neither is available', () => {
    expect(extractClientContext({ headers: {} })).toEqual({ userAgent: null, ip: null });
  });
});
