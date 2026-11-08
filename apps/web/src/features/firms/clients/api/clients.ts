// Client-onboarding + batch-operations API bindings for W2-C.
//
// These calls layer on top of the shared apiFetch, which already
// attaches the x-firm-id header set via FirmContext (W2-A).

import { apiFetch, apiGet, apiPost } from '../../../../lib/api';
import type { FirmClientTenant } from '../../types';

export interface CreateClientTenantInput {
  tenantName: string;
  crNumber: string;
  vatin: string;
  country?: string;
  accessLevel: 'full' | 'read_only';
  engagementType: 'ongoing' | 'periodic';
  shopOwnerEmail?: string;
}

export interface ClientTenantRecord extends FirmClientTenant {
  firmId: string;
  crNumber: string;
  vatin: string;
  country: string;
  invitationId?: string;
}

export interface BatchOnboardFailure {
  index: number;
  dto: CreateClientTenantInput;
  error: string;
  reason: 'duplicate' | 'validation' | 'conflict' | 'error';
}

export interface BatchOnboardResult {
  created: ClientTenantRecord[];
  failed: BatchOnboardFailure[];
}

export interface ValidationPreviewPerTenant {
  tenantId: string;
  tenantName: string;
  totalDraft: number;
  passed: number;
  failed: number;
  failures: Array<{ invoiceId: string; number: string; errors: string[] }>;
}

export interface ValidationPreviewResult {
  summary: {
    tenantsScanned: number;
    totalDraft: number;
    totalPassed: number;
    totalFailed: number;
  };
  perTenant: ValidationPreviewPerTenant[];
}

export function listClients(firmId: string): Promise<FirmClientTenant[]> {
  return apiGet<FirmClientTenant[]>(`/firms/${encodeURIComponent(firmId)}/clients`);
}

export function onboardClient(
  firmId: string,
  input: CreateClientTenantInput,
): Promise<ClientTenantRecord> {
  return apiPost<ClientTenantRecord>(
    `/firms/${encodeURIComponent(firmId)}/clients/onboard`,
    input,
  );
}

export function batchOnboard(
  firmId: string,
  clients: CreateClientTenantInput[],
): Promise<BatchOnboardResult> {
  return apiPost<BatchOnboardResult>(
    `/firms/${encodeURIComponent(firmId)}/clients/batch`,
    { clients },
  );
}

export function validateAll(firmId: string): Promise<ValidationPreviewResult> {
  return apiPost<ValidationPreviewResult>(
    `/firms/${encodeURIComponent(firmId)}/operations/validate-all`,
    {},
  );
}

/**
 * Fetch the VAT-return CSV. Returns the Blob directly so callers can
 * trigger a browser download via URL.createObjectURL.
 */
export async function vatReturnCsv(
  firmId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Blob> {
  const qs = `periodStart=${encodeURIComponent(periodStart)}&periodEnd=${encodeURIComponent(periodEnd)}`;
  const text = await apiFetch<string>(
    `/firms/${encodeURIComponent(firmId)}/operations/vat-return.csv?${qs}`,
    { method: 'GET' },
  );
  return new Blob([text], { type: 'text/csv;charset=utf-8;' });
}

/**
 * Revoke a client tenant link. Thin wrapper so callers don't have to
 * string-build the URL.
 */
export function revokeClient(firmId: string, tenantId: string): Promise<void> {
  return apiFetch<void>(
    `/firms/${encodeURIComponent(firmId)}/clients/${encodeURIComponent(tenantId)}`,
    { method: 'DELETE' },
  );
}
