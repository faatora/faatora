import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { withTenant } from '../db/with-tenant';
import { memberships, users } from '../db/schema/tenancy';
import { getCognitoVerifier } from './cognito';
export interface AuthContext {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}
interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}
export type AuthedRequest = MinimalRequest & Partial<AuthContext>;

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}
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
    const header = req.headers['x-tenant-id'];
    const tenantId = Array.isArray(header) ? header[0] : header;
    if (!tenantId) throw new BadRequestException('Missing x-tenant-id header');
    const found = await this.db.select().from(users).where(eq(users.cognitoSub, sub)).limit(1);
    const user = found[0];
    if (!user) throw new UnauthorizedException('User not provisioned');
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
