const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api';
const DEFAULT_TIMEOUT_MS = 10_000;

export class AccountantApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AccountantApiError';
  }
}

export class AccountantUnauthorizedError extends AccountantApiError {
  constructor(cause?: unknown) {
    super('unauthorized', 401, cause);
    this.name = 'AccountantUnauthorizedError';
  }
}

export interface Firm {
  id: string;
  ownerUserId: string;
  name: string;
  vatin: string | null;
  phone: string | null;
  email: string | null;
  commissionRate: string;
  createdAt: string;
}

export interface TenantSummary {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  role: string;
  referred: boolean;
  linkedAt: string;
}

export interface TenantKpis {
  tenantId: string;
  tenantName: string;
  invoiceCount: number;
  invoiceTotal: string;
  vatOutput: string;
  overdueArCount: number;
  pendingBatchCount: number;
}

export interface CreateFirmInput {
  name: string;
  vatin?: string;
  phone?: string;
  email?: string;
}

function authHeaders(): Record<string, string> {
  let token: string | null = null;
  try {
    token = localStorage.getItem('fawtara_access_token');
  } catch {
    token = null;
  }
  const headers: Record<string, string> = {
    'x-correlation-id': crypto.randomUUID(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function request<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...rest,
      headers: { ...authHeaders(), ...(headers ?? {}) },
      credentials: 'include',
      signal: controller.signal,
    });
    if (res.status === 401) {
      throw new AccountantUnauthorizedError();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AccountantApiError(
        `${init.method ?? 'GET'} ${path} -> ${res.status} ${text}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AccountantApiError) throw err;
    throw new AccountantApiError('network', 0, err);
  } finally {
    clearTimeout(timer);
  }
}

export function getFirm(): Promise<Firm | null> {
  return request<Firm | null>('/accountant/me/firm');
}

export function createFirm(input: CreateFirmInput): Promise<Firm> {
  return request<Firm>('/accountant/me/firm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function listTenants(): Promise<TenantSummary[]> {
  return request<TenantSummary[]>('/accountant/me/tenants');
}

export function linkTenant(
  tenantId: string,
  opts: { referred?: boolean } = {},
): Promise<{ firmId: string; tenantId: string; referred: boolean }> {
  return request(`/accountant/me/tenants/${tenantId}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export function unlinkTenant(tenantId: string): Promise<{ removed: boolean }> {
  return request(`/accountant/me/tenants/${tenantId}/link`, { method: 'DELETE' });
}

export function fetchKpis(): Promise<TenantKpis[]> {
  return request<TenantKpis[]>('/accountant/me/kpis');
}

export function switchToTenant(tenantId: string): void {
  try {
    localStorage.setItem('fawtara_tenant_id', tenantId);
  } catch {
    // storage disabled — ignore
  }
}
