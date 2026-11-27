/**
 * `CognitoAuthService` — thin wrapper around the Cognito `InitiateAuth`
 * USER_PASSWORD_AUTH flow. Called from `AuthController` on `POST
 * /auth/login`. See `docs/runbooks/password-login.md` for the operational
 * side (user-pool config, rate limiting, password policy).
 *
 * Design notes
 * ------------
 * - The client is instantiated lazily on first use. The service itself is
 *   a Nest singleton; the client is created once per process. This makes
 *   the service cheap to construct in tests (and in modules that import
 *   it without ever hitting Cognito).
 * - `SECRET_HASH` is optional. The Cognito app-client used by the POS may
 *   be configured with or without a client secret; if `COGNITO_CLIENT_SECRET`
 *   is set we compute the HMAC and send it, otherwise we omit the field.
 *   Sending `SECRET_HASH` to a client without a configured secret causes
 *   Cognito to reject the call, so the branch matters.
 * - Error translation is deliberate: we collapse `NotAuthorizedException`
 *   and `UserNotFoundException` into one generic "invalid credentials"
 *   message. Leaking which of the two tripped would let an attacker use
 *   the endpoint as a user-enumeration oracle.
 * - MFA challenges (`ChallengeName` on the response) are treated as a
 *   401 with a distinct message in this PR. The POS does not implement
 *   SMS/TOTP challenge flows yet; users with MFA fall back to the full
 *   web sign-in flow.
 * - The access token is NOT re-verified here (the Cognito SDK already
 *   negotiated it). We only decode the payload to extract `sub`,
 *   `custom:tenant_id` and `exp` for the response. The guards under
 *   `TenantGuard` / `ClearTaxPartnerGuard` will fully verify the token
 *   on subsequent requests via `aws-jwt-verify`.
 */
import { createHmac } from 'node:crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { loadEnv } from '../config/env';

export interface LoginResult {
  accessToken: string;
  tenantId: string;
  /** Milliseconds until the access token expires (frontend schedules a
   * re-auth check off this value). */
  expiresIn: number;
}

/** Minimal shape we pull off the base64url payload of the access token.
 * We do NOT re-verify the signature here — the Cognito SDK did that; this
 * is a one-shot decode to surface the tenant + expiry back to the client.
 */
interface AccessTokenPayload {
  sub?: string;
  exp?: number;
  'custom:tenant_id'?: string;
}

@Injectable()
export class CognitoAuthService {
  private readonly logger = new Logger(CognitoAuthService.name);
  private client: CognitoIdentityProviderClient | null = null;

  /** Lazy getter so tests that never log in don't instantiate an SDK
   * client (and so misconfigured envs fail on first use, not at module
   * boot). */
  private getClient(): CognitoIdentityProviderClient {
    if (this.client) return this.client;
    const env = loadEnv();
    this.client = new CognitoIdentityProviderClient({ region: env.AWS_REGION });
    return this.client;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const env = loadEnv();
    if (!env.COGNITO_CLIENT_ID) {
      throw new InternalServerErrorException('Cognito not configured');
    }
    const clientId = env.COGNITO_CLIENT_ID;
    const secret = process.env.COGNITO_CLIENT_SECRET;

    const authParameters: Record<string, string> = {
      USERNAME: email,
      PASSWORD: password,
    };
    if (secret) {
      authParameters.SECRET_HASH = computeSecretHash(email, clientId, secret);
    }

    let response;
    try {
      response = await this.getClient().send(
        new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: clientId,
          AuthParameters: authParameters,
        }),
      );
    } catch (err) {
      // Cognito's Smithy errors carry the type on either `.name` or the
      // legacy `.__type`. We branch on the stable `.name` and never
      // re-throw the raw error (avoids leaking stack frames / internal
      // IDs in the 401 body).
      const kind = (err as { name?: string }).name ?? '';
      this.logger.warn(
        { errorClass: kind, email: redactEmail(email) },
        'Cognito InitiateAuth failed',
      );
      switch (kind) {
        case 'NotAuthorizedException':
        case 'UserNotFoundException':
          // Same message for both — see file-level note on enumeration.
          throw new UnauthorizedException('invalid credentials');
        case 'PasswordResetRequiredException':
          throw new UnauthorizedException('password reset required');
        case 'UserNotConfirmedException':
          throw new UnauthorizedException('account not confirmed');
        default:
          // Anything else is almost certainly a config / network / Cognito
          // issue. Surface a generic 500 — the real detail is in the
          // server log above.
          throw new InternalServerErrorException('authentication failed');
      }
    }

    // A `ChallengeName` on the response means Cognito wants a follow-up
    // step (SMS_MFA, SOFTWARE_TOKEN_MFA, NEW_PASSWORD_REQUIRED, …). The
    // POS flow does not implement challenges; the full web sign-in UI
    // handles those. 401 so the POS surfaces the "sign in on the web
    // first" guidance.
    if (response.ChallengeName) {
      this.logger.warn(
        { challenge: response.ChallengeName, email: redactEmail(email) },
        'Cognito InitiateAuth returned a challenge; not supported on this endpoint',
      );
      throw new UnauthorizedException('mfa required; use the full web sign-in flow');
    }

    const authResult: AuthenticationResultType | undefined = response.AuthenticationResult;
    const accessToken = authResult?.AccessToken;
    if (!accessToken) {
      // Shouldn't happen in practice — Cognito either returns tokens or
      // a challenge or an error. Defend anyway so a weird response
      // doesn't flow through as a zero-length token.
      this.logger.warn({ email: redactEmail(email) }, 'Cognito returned no access token');
      throw new InternalServerErrorException('authentication failed');
    }

    const payload = decodeJwtPayload(accessToken);
    const tenantId = payload['custom:tenant_id'];
    if (!tenantId) {
      // A user without a tenant claim can't actually use the API — every
      // tenant-scoped guard refuses. Fail now rather than return a token
      // the frontend will then struggle with.
      this.logger.warn(
        { sub: payload.sub, email: redactEmail(email) },
        'Access token missing custom:tenant_id',
      );
      throw new UnauthorizedException('no tenant assigned');
    }

    // `expiresIn` is returned in SECONDS, matching Cognito's own
    // AuthenticationResult.ExpiresIn convention and the frontend
    // contract documented in apps/web/src/features/auth/api/auth.ts.
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = typeof payload.exp === 'number' ? payload.exp : nowSec;
    const expiresIn = Math.max(0, expSec - nowSec);

    return {
      accessToken,
      tenantId,
      expiresIn,
    };
  }
}

/**
 * Compute the Cognito `SECRET_HASH`:
 *   base64( HMAC_SHA256( clientSecret, username + clientId ) )
 * Exported only for the unit test.
 */
export function computeSecretHash(username: string, clientId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(username + clientId)
    .digest('base64');
}

/**
 * Decode the base64url-encoded JSON payload of a JWT. No signature
 * verification — the Cognito SDK already handled that end.
 * Exported only for the unit test.
 */
export function decodeJwtPayload(token: string): AccessTokenPayload {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '==='.slice((base64.length + 3) % 4);
  try {
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as AccessTokenPayload;
  } catch {
    return {};
  }
}

/** Replace the local-part of an email with its first two chars + ***
 * so warning-level logs don't carry a readable identifier. */
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 2) return '***';
  return email.slice(0, 2) + '***' + email.slice(at);
}
