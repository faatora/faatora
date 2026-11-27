/**
 * Unit tests for `TenantGuard`.
 *
 * The guard has two branches:
 *   - default: `X-Tenant-Id` carries the tenant, a tenant-side membership
 *     check gates the request.
 *   - impersonation: `X-Impersonate-Tenant-Id` short-circuits the
 *     membership check and instead requires an active row in
 *     firm_impersonation_events for (userId, clientTenantId).
 *
 * The DB is stubbed with an in-memory shim (no live Postgres) because
 * the branching we care about is at the guard's decision layer, not at
 * drizzle's SQL generation. Cognito is mocked. ImpersonationService is
 * stubbed per-test so each branch's expiry / absence case is exact.
 *
 * DB-backed coverage of the impersonation table lives in the
 * ImpersonationController spec; this file deliberately stays out of
 * Postgres so it runs in the keyless sandbox too.
 */
import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

jest.mock('./cognito', () => ({
  getCognitoVerifier: jest.fn(),
}));

import { getCognitoVerifier } from './cognito';
import { TenantGuard } from './tenant.guard';
import type {
  ImpersonationService,
  ActiveImpersonationSession,
} from '../modules/firms/clients/impersonation.service';

const mockedVerifier = getCognitoVerifier as jest.MockedFunction<typeof getCognitoVerifier>;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const COGNITO_SUB = 'cog-sub-aaaa';
const EMAIL = 'tester@faatora.test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_TENANT_ID = '33333333-3333-3333-3333-333333333333';
const FIRM_ID = '44444444-4444-4444-4444-444444444444';
const SESSION_ID = '55555555-5555-5555-5555-555555555555';

describe('TenantGuard', () => {
  beforeEach(() => {
    mockedVerifier.mockReset();
    mockedVerifier.mockReturnValue({
      verify: jest.fn().mockResolvedValue({ sub: COGNITO_SUB }),
    } as any);
  });

  // -- Negative preconditions shared by both branches --------------------

  it('401 when the bearer token is missing', async () => {
    const guard = new TenantGuard(stubDbUser(), stubImpersonation({ active: null }));
    const ctx = makeCtx({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 when the bearer token fails Cognito verification', async () => {
    mockedVerifier.mockReturnValue({
      verify: jest.fn().mockRejectedValue(new Error('bad token')),
    } as any);
    const guard = new TenantGuard(stubDbUser(), stubImpersonation({ active: null }));
    const ctx = makeCtx({
      headers: { authorization: 'Bearer anything', 'x-tenant-id': TENANT_ID },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 when the local user row does not exist', async () => {
    const guard = new TenantGuard(stubDbUser({ user: null }), stubImpersonation({ active: null }));
    const ctx = makeCtx({ headers: { authorization: 'Bearer tok', 'x-tenant-id': TENANT_ID } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // -- Default (tenant-membership) branch --------------------------------

  it('400 when neither tenant header nor impersonation header is set', async () => {
    const guard = new TenantGuard(stubDbUser(), stubImpersonation({ active: null }));
    const ctx = makeCtx({ headers: { authorization: 'Bearer tok' } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('403 when the caller has no tenant membership under the default branch', async () => {
    const guard = new TenantGuard(
      stubDbUser({ membership: null }),
      stubImpersonation({ active: null }),
    );
    const ctx = makeCtx({ headers: { authorization: 'Bearer tok', 'x-tenant-id': TENANT_ID } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('attaches tenant context when the default branch succeeds', async () => {
    const guard = new TenantGuard(
      stubDbUser({ membership: { role: 'owner' } }),
      stubImpersonation({ active: null }),
    );
    const req: any = { headers: { authorization: 'Bearer tok', 'x-tenant-id': TENANT_ID } };
    await expect(guard.canActivate(makeCtxFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe(TENANT_ID);
    expect(req.userId).toBe(USER_ID);
    expect(req.role).toBe('owner');
    expect(req.email).toBe(EMAIL);
    expect(req.impersonating).toBeUndefined();
  });

  // -- Impersonation branch ----------------------------------------------

  it('403 when the impersonation header is present but no active session exists', async () => {
    const impersonation = stubImpersonation({ active: null });
    const guard = new TenantGuard(stubDbUser(), impersonation);
    const req: any = {
      headers: {
        authorization: 'Bearer tok',
        'x-impersonate-tenant-id': CLIENT_TENANT_ID,
      },
    };
    await expect(guard.canActivate(makeCtxFor(req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(impersonation.verify).toHaveBeenCalledWith(USER_ID, CLIENT_TENANT_ID);
  });

  it('403 when the impersonation header is present but ImpersonationService is not wired', async () => {
    const guard = new TenantGuard(stubDbUser(), undefined);
    const req: any = {
      headers: {
        authorization: 'Bearer tok',
        'x-impersonate-tenant-id': CLIENT_TENANT_ID,
      },
    };
    await expect(guard.canActivate(makeCtxFor(req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('switches tenantId and attaches `impersonating` when an active session exists', async () => {
    const future = new Date(Date.now() + 60_000);
    const session: ActiveImpersonationSession = {
      id: SESSION_ID,
      firmId: FIRM_ID,
      clientTenantId: CLIENT_TENANT_ID,
      userId: USER_ID,
      startedAt: new Date(Date.now() - 1_000),
      expiresAt: future,
    };
    const guard = new TenantGuard(stubDbUser(), stubImpersonation({ active: session }));
    const req: any = {
      headers: {
        authorization: 'Bearer tok',
        'x-impersonate-tenant-id': CLIENT_TENANT_ID,
      },
    };
    await expect(guard.canActivate(makeCtxFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe(CLIENT_TENANT_ID);
    expect(req.userId).toBe(USER_ID);
    expect(req.email).toBe(EMAIL);
    expect(req.impersonating).toEqual({
      firmId: FIRM_ID,
      startedBy: USER_ID,
      originalRole: null,
      sessionId: SESSION_ID,
      expiresAt: future,
    });
  });

  it('403 when the active-session lookup returns expired (ImpersonationService contract: expired => null)', async () => {
    // ImpersonationService.verify is the single source of truth for
    // "active". We verify the guard treats a null return as rejection
    // regardless of what the header named.
    const guard = new TenantGuard(stubDbUser(), stubImpersonation({ active: null }));
    const ctx = makeCtx({
      headers: {
        authorization: 'Bearer tok',
        'x-impersonate-tenant-id': CLIENT_TENANT_ID,
      },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does NOT require x-tenant-id when the impersonation header is set', async () => {
    const future = new Date(Date.now() + 60_000);
    const session: ActiveImpersonationSession = {
      id: SESSION_ID,
      firmId: FIRM_ID,
      clientTenantId: CLIENT_TENANT_ID,
      userId: USER_ID,
      startedAt: new Date(),
      expiresAt: future,
    };
    const guard = new TenantGuard(stubDbUser(), stubImpersonation({ active: session }));
    const req: any = {
      headers: {
        authorization: 'Bearer tok',
        'x-impersonate-tenant-id': CLIENT_TENANT_ID,
        // no x-tenant-id
      },
    };
    await expect(guard.canActivate(makeCtxFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe(CLIENT_TENANT_ID);
  });
});

// --- helpers --------------------------------------------------------------

function makeCtx(req: unknown): ExecutionContext {
  return makeCtxFor(req);
}
function makeCtxFor(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as any;
}

/**
 * Minimal Database shim. The guard makes two kinds of DB calls:
 *   - users lookup by cognito_sub
 *   - memberships lookup via withTenant (a transaction)
 *
 * The shim's `select().from(...).where(...).limit(...)` chain resolves to
 * `[user]` (or `[]` when opts.user is null); the `transaction(fn)` call
 * invokes fn with a tx that returns `[membership]` (or `[]`).
 */
function stubDbUser(
  opts: { user?: { id: string; email: string } | null; membership?: { role: string } | null } = {},
): any {
  const user = opts.user === undefined ? { id: USER_ID, email: EMAIL } : opts.user;
  const membership = opts.membership === undefined ? { role: 'owner' } : opts.membership;
  const txShim = {
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (membership ? [membership] : []),
        }),
      }),
    }),
  };
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (user ? [user] : []),
        }),
      }),
    }),
    transaction: async (fn: (tx: any) => Promise<any>) => fn(txShim),
  };
}

function stubImpersonation(opts: {
  active: ActiveImpersonationSession | null;
}): ImpersonationService {
  return {
    verify: jest.fn().mockResolvedValue(opts.active),
  } as unknown as ImpersonationService;
}
