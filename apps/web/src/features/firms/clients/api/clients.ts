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
  return apiPost<ClientTenantRecord>(`/firms/${encodeURIComponent(firmId)}/clients/onboard`, input);
}

export function batchOnboard(
  firmId: string,
  clients: CreateClientTenantInput[],
): Promise<BatchOnboardResult> {
  return apiPost<BatchOnboardResult>(`/firms/${encodeURIComponent(firmId)}/clients/batch`, {
    clients,
  });
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

/**
 * Impersonation ticket returned by the server once the "act as this
 * client" handshake exists on the backend. Shape is intentionally minimal
 * — the UI only needs the tenant id it is now scoped to; cross-tenant
 * authorisation happens in `apps/api/src/auth/*` guards.
 */
export interface ImpersonationTicket {
  firmId: string;
  clientTenantId: string;
  /** Absolute expiry so the banner can warn before the session drops. */
  expiresAt?: string;
}

/**
 * TODO(backend-follow-up): POST /firms/:id/clients/:tenantId/act-as is not
 * yet implemented. Until it is, the frontend records the impersonation
 * intent client-side (via FirmContext.startActingAs, which writes
 * `faatora_impersonate_tenant_id`) and the shared apiFetch helper sends
 * `x-impersonate-tenant-id` on every subsequent request. The backend PR
 * that adds the controller should:
 *
 *   1. Validate that (firmId, clientTenantId) is a live link under
 *      `firm_client_tenants` and that the caller's firm role is >=
 *      `staff` (read_only must be rejected here too, as a defence in
 *      depth — the UI already hides the button for read-only members).
 *   2. Short-circuit the TenantGuard's membership check for this one
 *      session, re-scoping `req.tenantId` to the impersonated tenant.
 *   3. Write an audit row (actor_user_id, firm_id, target_tenant_id,
 *      started_at) so every impersonated action is attributable.
 *
 * When that controller lands, flip this to call it and propagate its
 * response (ticket) to the caller; the FirmContext API does not change.
 */
export async function startImpersonation(
  firmId: string,
  clientTenantId: string,
): Promise<ImpersonationTicket> {
  try {
    return await apiPost<ImpersonationTicket>(
      `/firms/${encodeURIComponent(firmId)}/clients/${encodeURIComponent(clientTenantId)}/act-as`,
      {},
    );
  } catch (err) {
    // While the endpoint doesn't exist yet a 404 is expected; we treat
    // that as "frontend-only impersonation" so the UX works end-to-end
    // and the backend PR can tighten the check without a web rev.
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 405) {
      return { firmId, clientTenantId };
    }
    throw err;
  }
}
