// TODO: wire up a real login UI; for now we read the bearer token and the active
// tenant id out of localStorage ('faatora_access_token', 'faatora_tenant_id').
// Pattern mirrors apps/web/src/pages/checker/api.ts.

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

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-correlation-id': crypto.randomUUID(),
  };
  const token = readLocal('faatora_access_token');
  if (token) h['Authorization'] = `Bearer ${token}`;
  const tenant = readLocal('faatora_tenant_id');
  if (tenant) h['x-tenant-id'] = tenant;
  return h;
}

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
