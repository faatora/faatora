export type RevenueBand = '<=100k' | '100k-500k' | '500k-1M' | '1M-5M' | '>5M';
export type InvoiceVolumeBand = '<100' | '100-500' | '500-2000' | '>2000';
export type B2CShare = '0' | '<25' | '25-50' | '>50';

export interface CheckerInput {
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  vatRegistered: boolean;
  revenueBand: RevenueBand;
  currentTool: string;
  invoiceVolumeBand: InvoiceVolumeBand;
  b2cShare: B2CShare;
  erp?: string;
}

export interface ReadinessVerdict {
  ready: boolean;
  score: number;
  blockers: string[];
  recommendations: string[];
  deadline: string;
}

export interface CheckerResult {
  id: string;
  verdict: ReadinessVerdict;
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000/api';

const DEFAULT_TIMEOUT_MS = 10_000;

export class CheckerSubmitError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CheckerSubmitError';
  }
}

export async function submitChecker(
  input: CheckerInput,
  options: { timeoutMs?: number } = {},
): Promise<CheckerResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE}/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-correlation-id': crypto.randomUUID(),
      },
      body: JSON.stringify(input),
      credentials: 'include',
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new CheckerSubmitError(`POST /leads -> ${res.status}`);
    }

    return (await res.json()) as CheckerResult;
  } catch (err) {
    if (err instanceof CheckerSubmitError) throw err;
    throw new CheckerSubmitError('network', err);
  } finally {
    clearTimeout(timer);
  }
}
