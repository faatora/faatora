import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { withFirm } from '../db/with-firm';
import { firmMemberships, type FirmMemberRole } from '../db/schema/firms';
import { users } from '../db/schema/tenancy';
import { getCognitoVerifier } from './cognito';

export interface FirmAuthContext {
  userId: string;
  firmId: string;
  firmRole: FirmMemberRole;
  email: string;
}

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}

export type FirmAuthedRequest = MinimalRequest & Partial<FirmAuthContext>;

/**
 * FirmGuard — analogue of TenantGuard but for the firm-console surface.
 *
 * Authn: standard Cognito access-token verification.
 * Firm selection: the active firm is carried in a custom JWT claim
 *   `active_firm_id` (as suggested in the EP5 spec) — operators mint
 *   this by setting a custom attribute on the Cognito user (prefixed
 *   `custom:active_firm_id` per Cognito convention). To keep local dev
 *   and integration tests workable without round-tripping Cognito, the
 *   guard also accepts an `x-firm-id` header as a fallback.
 * Authz: a non-revoked firm_memberships row must exist for (firm,user).
 *   That check runs inside withFirm so RLS is in effect even for the
 *   membership read — RLS is the floor, this is defense in depth.
 *
 * On success: attaches { userId, firmId, firmRole, email } to the request
 * and leaves `app.firm_id` set for the handler via a wrapping withFirm
 * invocation in services. The guard itself does not hold a transaction
 * open across the handler — services call withFirm again as needed.
 */
@Injectable()
export class FirmGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FirmAuthedRequest>();
    const authz = req.headers['authorization'];
    const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let sub: string;
    let claimedFirmId: string | undefined;
    try {
      // Cognito JWTs carry custom attributes as `custom:<name>`. We also
      // accept a bare `active_firm_id` for synthetic tokens in tests.
      const payload = (await getCognitoVerifier().verify(token)) as Record<string, unknown> & {
        sub: string;
      };
      sub = payload.sub;
      const fromCustom = payload['custom:active_firm_id'];
      const fromBare = payload['active_firm_id'];
      claimedFirmId =
        typeof fromCustom === 'string'
          ? fromCustom
          : typeof fromBare === 'string'
            ? fromBare
            : undefined;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    const headerFirm = req.headers['x-firm-id'];
    const headerFirmId = Array.isArray(headerFirm) ? headerFirm[0] : headerFirm;
    const firmId = claimedFirmId ?? headerFirmId;
    if (!firmId) {
      throw new BadRequestException(
        'Missing active firm — expected JWT claim active_firm_id or x-firm-id header',
      );
    }

    const found = await this.db.select().from(users).where(eq(users.cognitoSub, sub)).limit(1);
    const user = found[0];
    if (!user) throw new UnauthorizedException('User not provisioned');

    const membership = await withFirm(this.db, firmId, async (tx) => {
      const rows = await tx
        .select()
        .from(firmMemberships)
        .where(
          and(
            eq(firmMemberships.userId, user.id),
            eq(firmMemberships.firmId, firmId),
            isNull(firmMemberships.revokedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
    if (!membership) throw new ForbiddenException('No active membership in this firm');

    req.userId = user.id;
    req.firmId = firmId;
    req.firmRole = membership.role as FirmMemberRole;
    req.email = user.email;
    return true;
  }
}
