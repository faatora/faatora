// Shared TypeScript types for the firms feature (W2-A).
//
// Mirrors the server contract exposed by the Wave 1 /firms endpoints.
// Other W2 agents (dashboard, clients) may import these types.

export type FirmMemberRole = 'owner' | 'partner' | 'staff' | 'read_only';

export const FIRM_MEMBER_ROLES: FirmMemberRole[] = ['owner', 'partner', 'staff', 'read_only'];

export interface Firm {
  id: string;
  name: string;
  legalName?: string | null;
  crNumber?: string | null;
  vatin?: string | null;
  email?: string | null;
  phone?: string | null;
  createdAt?: string;
}

export interface FirmMembership {
  firm: Firm;
  role: FirmMemberRole;
  joinedAt?: string;
}

export interface FirmMember {
  userId: string;
  email: string;
  role: FirmMemberRole;
  status: 'invited' | 'active';
  joinedAt?: string | null;
  invitedAt?: string | null;
}

export interface FirmClientTenant {
  tenantId: string;
  tenantName: string;
  accessLevel: string;
  engagementType: string;
  createdAt: string;
}

export interface CreateFirmInput {
  name: string;
  legal_name: string;
  cr_number: string;
  vatin?: string;
  email: string;
  phone: string;
}

export interface InviteMemberInput {
  email: string;
  role: FirmMemberRole;
}
