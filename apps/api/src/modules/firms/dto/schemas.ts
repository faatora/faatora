import { z } from 'zod';
import { FIRM_CLIENT_ACCESS_LEVELS, FIRM_ENGAGEMENT_TYPES, FIRM_MEMBER_ROLES } from '../../../db/schema/firms';

/**
 * EP5 Wave 1 -- Zod DTO schemas for the firm-console endpoints. Zod is
 * used here (rather than class-validator, which the rest of the API
 * uses) per the EP5 architecture rules. The ZodValidationPipe converts
 * a ZodError into a BadRequestException so NestJS's exception filter
 * handles it the same way as class-validator errors.
 */

export const CreateFirmSchema = z.object({
  name: z.string().min(1).max(200),
  legalName: z.string().max(200).optional(),
  crNumber: z.string().max(60).optional(),
  country: z.string().length(2).optional(),
  vatin: z.string().max(60).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
});
export type CreateFirmDto = z.infer<typeof CreateFirmSchema>;

export const InviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(FIRM_MEMBER_ROLES),
});
export type InviteMemberDto = z.infer<typeof InviteMemberSchema>;

export const AcceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
});
export type AcceptInvitationDto = z.infer<typeof AcceptInvitationSchema>;

export const AddMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(FIRM_MEMBER_ROLES),
});
export type AddMemberDto = z.infer<typeof AddMemberSchema>;

export const AddClientTenantSchema = z.object({
  tenantId: z.string().uuid(),
  accessLevel: z.enum(FIRM_CLIENT_ACCESS_LEVELS).default('full'),
  engagementType: z.enum(FIRM_ENGAGEMENT_TYPES).default('ongoing'),
});
export type AddClientTenantDto = z.infer<typeof AddClientTenantSchema>;

/**
 * EP5 Wave 2 (W2-C): the onboarding-wizard DTO. Unlike AddClientTenant
 * (which only links an existing tenants row), CreateClientTenant provisions
 * the tenant AND the link in one transaction. shopOwnerEmail is optional
 * because an accountant may onboard a client without inviting them yet.
 */
export const CreateClientTenantSchema = z.object({
  tenantName: z.string().min(1).max(200),
  crNumber: z.string().min(1).max(60),
  vatin: z.string().min(1).max(60),
  country: z.string().length(2).default('OM'),
  accessLevel: z.enum(FIRM_CLIENT_ACCESS_LEVELS).default('full'),
  engagementType: z.enum(FIRM_ENGAGEMENT_TYPES).default('ongoing'),
  shopOwnerEmail: z.string().email().optional(),
});
export type CreateClientTenantDto = z.infer<typeof CreateClientTenantSchema>;

/**
 * Batch wrapper. Capped at 50 per call so a single HTTP request always
 * fits in a reasonable transaction window; larger imports should page.
 */
export const CreateClientTenantsBatchSchema = z.object({
  clients: z.array(CreateClientTenantSchema).min(1).max(50),
});
export type CreateClientTenantsBatchDto = z.infer<typeof CreateClientTenantsBatchSchema>;

/**
 * Query params for the VAT-return CSV export. periodStart/periodEnd are
 * ISO calendar dates (inclusive).
 */
export const VatReturnQuerySchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type VatReturnQueryDto = z.infer<typeof VatReturnQuerySchema>;
