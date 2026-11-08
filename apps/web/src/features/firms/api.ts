// Firms API client. All calls go through the shared apiFetch so that the
// x-firm-id header is set once a firm has been selected via FirmContext.

import { apiDelete, apiFetch, apiGet, apiPost } from '../../lib/api';
import type {
  CreateFirmInput,
  Firm,
  FirmClientTenant,
  FirmMember,
  FirmMembership,
  InviteMemberInput,
} from './types';

/** GET /firms/mine — bootstrap list of firms the current user belongs to. */
export function fetchMyFirms(): Promise<FirmMembership[]> {
  return apiGet<FirmMembership[]>('/firms/mine');
}

/** GET /firms/:id — firm detail (firm context required). */
export function fetchFirm(firmId: string): Promise<Firm> {
  return apiGet<Firm>(`/firms/${encodeURIComponent(firmId)}`);
}

/** POST /firms — create a new firm (bootstrap). */
export function createFirm(input: CreateFirmInput): Promise<Firm> {
  return apiPost<Firm>('/firms', input);
}

/** GET /firms/:id/members — list members (firm context required). */
export function listFirmMembers(firmId: string): Promise<FirmMember[]> {
  return apiGet<FirmMember[]>(`/firms/${encodeURIComponent(firmId)}/members`);
}

/** POST /firms/:id/members/invites — invite a member by email. */
export function inviteFirmMember(
  firmId: string,
  input: InviteMemberInput,
): Promise<{ invitationId: string }> {
  return apiPost<{ invitationId: string }>(
    `/firms/${encodeURIComponent(firmId)}/members/invites`,
    input,
  );
}

/** DELETE /firms/:id/members/:userId — remove a member. */
export function removeFirmMember(firmId: string, userId: string): Promise<void> {
  return apiDelete<void>(
    `/firms/${encodeURIComponent(firmId)}/members/${encodeURIComponent(userId)}`,
  );
}

/** GET /firms/:id/clients — the firm's linked client tenants. */
export function listFirmClients(firmId: string): Promise<FirmClientTenant[]> {
  return apiGet<FirmClientTenant[]>(`/firms/${encodeURIComponent(firmId)}/clients`);
}

/** POST /firms/invitations/accept — redeem an invitation token. */
export function acceptInvitation(token: string): Promise<{ firmId: string }> {
  return apiPost<{ firmId: string }>('/firms/invitations/accept', { token });
}

export { apiFetch };
