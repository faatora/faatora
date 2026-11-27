// POS-specific REST bindings. Auth, active-tenant, firm and impersonation
// headers are managed in the shared `lib/api` module and surfaced via
// `buildDefaultHeaders`; the login UI (`pages/pos/LoginPage.tsx`) is the
// only place that writes to those storage keys for POS users.

import {
  ACCESS_TOKEN_STORAGE_KEY,
  ACTIVE_TENANT_STORAGE_KEY,
  getAccessToken,
  getActiveTenantId,
} from '../../lib/api';

export type TenderMethod = 'cash' | 'card' | 'mixed';

export interface Product {
  id: string;
  sku: string;
  nameEn: string;
  nameAr: string | null;
  unitPrice: string; // numeric comes back as string from drizzle
  vatCategory: string;
  vatRate: string;
  barcode: string | null;
  archived: boolean;
}

export interface SaleLineInput {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  vatCategory?: string;
  vatRate?: number;
}

export interface CreateSaleInput {
  tenderMethod: TenderMethod;
  tenderCash?: number;
  tenderCard?: number;
  changeGiven?: number;
  lines: SaleLineInput[];
}

export interface Sale {
  id: string;
  number: string;
  soldAt: string;
  subtotal: string;
  vatTotal: string;
  grandTotal: string;
  tenderMethod: TenderMethod;
  tenderCash: string;
  tenderCard: string;
  changeGiven: string;
  clearanceStatus: string;
  lines: Array<{
    lineNo: number;
    description: string;
    quantity: string;
    unitPrice: string;
    vatCategory: string;
    vatRate: string;
    lineNet: string;
  }>;
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api';

export class PosApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PosApiError';
  }
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-correlation-id': crypto.randomUUID(),
  };
  const token = getAccessToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  const tenant = getActiveTenantId();
  if (tenant) h['x-tenant-id'] = tenant;
  return h;
}

// Re-export for tests and legacy callers that still reference the raw keys.
export { ACCESS_TOKEN_STORAGE_KEY, ACTIVE_TENANT_STORAGE_KEY };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    throw new PosApiError(`${init.method ?? 'GET'} ${path} -> ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function listProducts(): Promise<Product[]> {
  return request<Product[]>('/pos/products');
}

export async function lookupByBarcode(barcode: string): Promise<Product | null> {
  return request<Product | null>(`/pos/products/lookup?barcode=${encodeURIComponent(barcode)}`);
}

export async function createSale(input: CreateSaleInput): Promise<Sale> {
  return request<Sale>('/pos/sales', { method: 'POST', body: JSON.stringify(input) });
}
