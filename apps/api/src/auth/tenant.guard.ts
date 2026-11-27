import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { withTenant } from '../db/with-tenant';
import { memberships, users } from '../db/schema/tenancy';
import { getCognitoVerifier } from './cognito';
import { ImpersonationService } from '../modules/firms/clients/impersonation.service';
import type { FirmMemberRole } from '../db/schema/firms';

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

/**
 * Attached by TenantGuard when a request is being served under an
 * accountant impersonation session (`X-Impersonate-Tenant-Id` header
 * present and accepted). Downstream controllers / interceptors can read
 * this to tag their own audit rows with the impersonating actor on top
 * of the tenant-side actor.
 */
export interface ImpersonationContext {
  firmId: string;
  startedBy: string;
  originalRole: FirmMemberRole | string | null;
  sessionId: string;
  expiresAt: Date;
}

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}
export type AuthedRequest = MinimalRequest &
  Partial<AuthContext> & {
    impersonating?: ImpersonationContext;
  };

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Database,
    // Optional so the guard still boots in modules whose test harness
    // doesn't provide the FirmsModule. In production FirmsModule is
    // @Global so the service is always available; the absence check
    // below rejects any request that tries to use impersonation when
    // the service is not wired, which is the safe default.
    @Optional() private readonly impersonation?: ImpersonationService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const authz = req.headers['authorization'];
    const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    let sub: string;
    try {
      const payload = await getCognitoVerifier().verify(token);
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    const found = await this.db.select().from(users).where(eq(users.cognitoSub, sub)).limit(1);
    const user = found[0];
    if (!user) throw new UnauthorizedException('User not provisioned');

    // --- Impersonation branch ----------------------------------------
    //
    // When X-Impersonate-Tenant-Id is set the caller is an accountant
    // firm-member who has already gone through POST /firms/:id/clients/
    // :tenantId/act-as. That handshake:
    //   - validated the firm_client_tenants link
    //   - validated the firm role is >= staff
    //   - wrote a firm_impersonation_events row the guard now looks up
    //
    // We deliberately skip the tenant-side memberships check in this
    // branch: the firm member does NOT need a tenant membership to act
    // on the client tenant; the impersonation row IS the authorisation.
    const impersonateHeader = req.headers['x-impersonate-tenant-id'];
    const impersonateTenantId = Array.isArray(impersonateHeader)
      ? impersonateHeader[0]
      : impersonateHeader;
    if (impersonateTenantId) {
      if (!this.impersonation) {
        // Defensive: the service should always be wired in production.
        // Throw 403 (not 503) because the client sent the header and a
        // 403 tells them unambiguously that impersonation is not
        // authorised for this request.
        throw new ForbiddenException('Impersonation is not available on this route');
      }
      const session = await this.impersonation.verify(user.id, impersonateTenantId);
      if (!session) {
        throw new ForbiddenException('impersonation session expired or revoked');
      }
      // We purposefully do NOT verify firmRole again here — the start()
      // handshake already did, and the accountant's role can change
      // without invalidating an already-issued short-lived session. The
      // originalRole lives on req.impersonating for downstream log rows.
      req.userId = user.id;
      req.tenantId = impersonateTenantId;
      // Role carried through from the token's normal tenant role is
      // meaningless in the impersonation branch (there is no membership
      // row), so we leave `role` undefined and signal the real shape
      // via req.impersonating. Downstream services that key on a tenant
      // role should either tolerate undefined or branch on `impersonating`.
      req.email = user.email;
      req.impersonating = {
        firmId: session.firmId,
        startedBy: user.id,
        originalRole: (req.role as FirmMemberRole | undefined) ?? null,
        sessionId: session.id,
        expiresAt: session.expiresAt,
      };
      return true;
    }

    // --- Default (tenant-membership) branch --------------------------
    const header = req.headers['x-tenant-id'];
    const tenantId = Array.isArray(header) ? header[0] : header;
    if (!tenantId) throw new BadRequestException('Missing x-tenant-id header');
    const membership = await withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, user.id), eq(memberships.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    });
    if (!membership) throw new ForbiddenException('No membership in this tenant');
    req.userId = user.id;
    req.tenantId = tenantId;
    req.role = membership.role;
    req.email = user.email;
    return true;
  }
}
