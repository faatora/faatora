// Shared API client for the Fawtara web app.
//
// Honours two orthogonal context signals:
//   1. Auth bearer token  — read from localStorage key `fawtara_access_token`.
//   2. Active firm id     — read from localStorage key `fawtara.activeFirmId`
//                            and sent as the `x-firm-id` header on every
//                            request. Absent for SME users; the header is
//                            then not emitted at all, preserving the
//                            existing shop-owner path.
//
// Any new feature calling the API should use `apiFetch`, `apiGet`, `apiPost`
// or `apiDelete` so that the firm header is applied uniformly.

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api';
const DEFAULT_TIMEOUT_MS = 10_000;

export const ACTIVE_FIRM_STORAGE_KEY = 'fawtara.activeFirmId';
export const ACCESS_TOKEN_STORAGE_KEY = 'fawtara_access_token';

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
 * Build the default headers that every API request carries. Firm context and
 * auth are both optional; a request made in SME mode with no token yields
 * only a correlation id, matching the pre-pivot behaviour.
 */
export function buildDefaultHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'x-correlation-id': makeCorrelationId(),
  };
  const token = safeGet(ACCESS_TOKEN_STORAGE_KEY);
  if (token) headers.authorization = `Bearer ${token}`;
  const firmId = safeGet(ACTIVE_FIRM_STORAGE_KEY);
  if (firmId) headers['x-firm-id'] = firmId;
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

export function getActiveFirmId(): string | null {
  return safeGet(ACTIVE_FIRM_STORAGE_KEY);
}

export function setActiveFirmId(firmId: string | null): void {
  try {
    if (firmId) {
      localStorage.setItem(ACTIVE_FIRM_STORAGE_KEY, firmId);
    } else {
      localStorage.removeItem(ACTIVE_FIRM_STORAGE_KEY);
    }
  } catch {
    // storage disabled — context switch still works in-memory via FirmContext.
  }
}
