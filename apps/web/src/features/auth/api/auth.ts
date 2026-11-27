// Authentication API bindings.
//
// Backing endpoint: POST /auth/login
//
//   Request  (JSON): { email: string, password: string }
//   Response (JSON): {
//     accessToken: string,            // Cognito access token (JWT)
//     tenantId?: string | null,       // the POS clerk's default shop tenant
//     expiresIn?: number              // seconds
//   }
//
// The backend ultimately calls Cognito's InitiateAuth (USER_PASSWORD_AUTH
// flow) and returns the access token directly so the browser never sees
// the Cognito pool id or client secret. The guards under
// `apps/api/src/auth/*` already verify access tokens via
// `aws-jwt-verify`; this call is the missing piece on the write side.
//
// NOTE: at the time this module landed the `/auth/login` route is not
// yet implemented server-side. The web code is wired against the
// contract above so the follow-up backend PR only needs to add the
// controller (see PR description).

import {
  ApiError,
  setAccessToken,
  setActiveTenantId,
  UnauthorizedError,
  type ApiRequestOptions,
} from '../../../lib/api';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  tenantId?: string | null;
  expiresIn?: number;
}

export class InvalidCredentialsError extends ApiError {
  constructor(body?: unknown) {
    super('invalid credentials', 401, body);
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * Submit credentials and, on success, persist the returned token and
 * tenant id into localStorage so subsequent `apiFetch` calls pick them
 * up automatically. Rejects with `InvalidCredentialsError` on a 401 so
 * callers can distinguish "bad password" from "server down".
 *
 * This deliberately uses raw `fetch` (not `apiFetch`) so a stale/
 * mismatched bearer token is never echoed back to the login endpoint.
 */
export async function login(
  input: LoginInput,
  options: Pick<ApiRequestOptions, 'timeoutMs'> = {},
): Promise<LoginResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email: input.email, password: input.password }),
      credentials: 'include',
      signal: controller.signal,
    });

    const ct = res.headers.get('content-type') ?? '';
    let parsed: unknown = undefined;
    if (res.status !== 204) {
      if (ct.includes('json')) {
        parsed = await res.json().catch(() => undefined);
      } else {
        parsed = await res.text().catch(() => undefined);
      }
    }

    if (res.status === 401 || res.status === 403) {
      throw new InvalidCredentialsError(parsed);
    }
    if (!res.ok) {
      throw new ApiError(`POST /auth/login -> ${res.status}`, res.status, parsed);
    }

    const payload = parsed as Partial<LoginResponse> | null;
    if (!payload || typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) {
      throw new ApiError('malformed login response', res.status, parsed);
    }

    setAccessToken(payload.accessToken);
    if (payload.tenantId) setActiveTenantId(payload.tenantId);

    return {
      accessToken: payload.accessToken,
      tenantId: payload.tenantId ?? null,
      expiresIn: payload.expiresIn,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ApiError('timeout', 0, err);
    }
    throw new ApiError('network', 0, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clear every stored auth artifact. Intended for logout and for the
 * "my session expired" UX. Does not navigate; callers decide where to
 * send the user next.
 */
export function logout(): void {
  setAccessToken(null);
  setActiveTenantId(null);
}

export { UnauthorizedError };
