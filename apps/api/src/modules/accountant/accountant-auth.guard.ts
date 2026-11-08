import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { users } from '../../db/schema/tenancy';
import { getCognitoVerifier } from '../../auth/cognito';

export interface AccountantAuthContext {
  userId: string;
  email: string;
}

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}

export type AccountantAuthedRequest = MinimalRequest & Partial<AccountantAuthContext>;

/**
 * Lightweight guard for the accountant console. Verifies the Cognito access
 * token and resolves the local user row, but does NOT require an x-tenant-id
 * header — the accountant works across tenants. Per-tenant authorization is
 * enforced by the service layer when it crosses an RLS boundary.
 */
@Injectable()
export class AccountantAuthGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AccountantAuthedRequest>();
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
    req.userId = user.id;
    req.email = user.email;
    return true;
  }
}
