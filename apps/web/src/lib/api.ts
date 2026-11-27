// Shared API client for the Faatora web app.
//
// Honours four orthogonal context signals, all stored in localStorage:
//   1. Auth bearer token          — `faatora_access_token`.
//   2. Active tenant id           — `faatora_tenant_id` (sent as `x-tenant-id`).
//      Tenant mode is the shop-owner / POS path; the header is omitted
//      when nothing is stored, matching the pre-pivot SME behaviour.
//   3. Active firm id             — `faatora.activeFirmId` (sent as `x-firm-id`).
//      Set via FirmContext when the user is a firm member.
//   4. Impersonated client tenant — `faatora_impersonate_tenant_id`
//      (sent as `x-impersonate-tenant-id`). An accountant user working
//      "as" one of their client tenants sets this via FirmContext;
//      backend enforcement is a separate follow-up (see
//      `features/firms/clients/api/clients.ts`).
//
// Any new feature calling the API should use `apiFetch`, `apiGet`, `apiPost`
// or `apiDelete` so that all four headers are applied uniformly.

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api';
const DEFAULT_TIMEOUT_MS = 10_000;

export const ACTIVE_FIRM_STORAGE_KEY = 'faatora.activeFirmId';
export const ACCESS_TOKEN_STORAGE_KEY = 'faatora_access_token';
export const ACTIVE_TENANT_STORAGE_KEY = 'faatora_tenant_id';
export const IMPERSONATE_TENANT_STORAGE_KEY = 'faatora_impersonate_tenant_id';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(body?: unknown) {
    super('unauthorized', 401, body);
    this.name = 'UnauthorizedError';
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function makeCorrelationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `cid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Build the default headers that every API request carries. Every context
 * header is optional; a request made in SME mode with no token yields only
 * a correlation id, matching the pre-pivot behaviour.
 */
export function buildDefaultHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'x-correlation-id': makeCorrelationId(),
  };
  const token = safeGet(ACCESS_TOKEN_STORAGE_KEY);
  if (token) headers.authorization = `Bearer ${token}`;
  const firmId = safeGet(ACTIVE_FIRM_STORAGE_KEY);
  if (firmId) headers['x-firm-id'] = firmId;
  const tenantId = safeGet(ACTIVE_TENANT_STORAGE_KEY);
  if (tenantId) headers['x-tenant-id'] = tenantId;
  const impersonate = safeGet(IMPERSONATE_TENANT_STORAGE_KEY);
  if (impersonate) headers['x-impersonate-tenant-id'] = impersonate;
  return headers;
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body' | 'headers'> {
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', ...rest } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const finalHeaders: Record<string, string> = {
    ...buildDefaultHeaders(),
    ...headers,
  };
  let serialisedBody: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof FormData || body instanceof Blob) {
      serialisedBody = body as BodyInit;
    } else {
      serialisedBody = JSON.stringify(body);
      if (!finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
        finalHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  try {
    const res = await fetch(`${BASE}${path}`, {
      ...rest,
      method,
      headers: finalHeaders,
      body: serialisedBody,
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

    if (res.status === 401) throw new UnauthorizedError(parsed);
    if (!res.ok) throw new ApiError(`${method} ${path} -> ${res.status}`, res.status, parsed);
    return parsed as T;
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

export function apiGet<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return apiFetch<T>(path, { ...options, method: 'GET' });
}

export function apiPost<T>(
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<T> {
  return apiFetch<T>(path, { ...options, method: 'POST', body });
}

export function apiDelete<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return apiFetch<T>(path, { ...options, method: 'DELETE' });
}

function safeSet(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage disabled — callers must keep state in memory as a fallback.
  }
}

export function getActiveFirmId(): string | null {
  return safeGet(ACTIVE_FIRM_STORAGE_KEY);
}

export function setActiveFirmId(firmId: string | null): void {
  safeSet(ACTIVE_FIRM_STORAGE_KEY, firmId);
}

export function getAccessToken(): string | null {
  return safeGet(ACCESS_TOKEN_STORAGE_KEY);
}

export function setAccessToken(token: string | null): void {
  safeSet(ACCESS_TOKEN_STORAGE_KEY, token);
}

export function getActiveTenantId(): string | null {
  return safeGet(ACTIVE_TENANT_STORAGE_KEY);
}

export function setActiveTenantId(tenantId: string | null): void {
  safeSet(ACTIVE_TENANT_STORAGE_KEY, tenantId);
}

export function getImpersonateTenantId(): string | null {
  return safeGet(IMPERSONATE_TENANT_STORAGE_KEY);
}

export function setImpersonateTenantId(tenantId: string | null): void {
  safeSet(IMPERSONATE_TENANT_STORAGE_KEY, tenantId);
}

/**
 * Best-effort JWT exp check. Returns true when the token is definitely
 * expired, false when it's valid or undecodable (callers treat "unknown"
 * as still-valid so a fresh non-JWT token isn't kicked out).
 */
export function isTokenExpired(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payloadStr =
      typeof atob === 'function'
        ? atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
        : Buffer.from(parts[1], 'base64').toString('binary');
    const payload = JSON.parse(payloadStr) as { exp?: number };
    if (typeof payload.exp !== 'number') return false;
    return payload.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}
