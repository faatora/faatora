/**
 * EP5 Wave 1 — Firm entity + membership schema.
 *
 * A firm is a top-level aggregator (an accounting practice) that manages many
 * client tenants. Distinct from the EP4 `accountant_firms` table (the older
 * single-user "my practice" concept) — this schema supports multiple users
 * per firm with granular roles, and a first-class link table recording the
 * firm's engagement with each client tenant.
 *
 * Context propagation key is `app.firm_id` (the firm the caller is acting
 * as), separate from `app.tenant_id` (the tenant whose data is being
 * accessed). See apps/api/src/db/with-firm.ts and with-firm-tenant.ts.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, users } from './tenancy';

export const FIRM_MEMBER_ROLES = ['owner', 'partner', 'staff', 'read_only'] as const;
export type FirmMemberRole = (typeof FIRM_MEMBER_ROLES)[number];

export const FIRM_CLIENT_ACCESS_LEVELS = ['full', 'read_only'] as const;
export type FirmClientAccessLevel = (typeof FIRM_CLIENT_ACCESS_LEVELS)[number];

export const FIRM_ENGAGEMENT_TYPES = ['ongoing', 'periodic'] as const;
export type FirmEngagementType = (typeof FIRM_ENGAGEMENT_TYPES)[number];

export const firms = pgTable('firms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  crNumber: text('cr_number'),
  country: text('country').notNull().default('OM'),
  vatin: text('vatin'),
  email: text('email'),
  phone: text('phone'),
  // Provider-opaque customer identifiers. Populated by
  // FirmBillingService.onFirmCreated once a BillingProvider is configured
  // (EP5 Wave 2 W2-E). Nullable in dev/UAT where no provider is bound.
  stripeCustomerId: text('stripe_customer_id'),
  paymobCustomerId: text('paymob_customer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const firmMemberships = pgTable(
  'firm_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    firmIdx: index('firm_memberships_firm_idx').on(t.firmId),
    userIdx: index('firm_memberships_user_idx').on(t.userId),
    roleCheck: check(
      'firm_memberships_role_check',
      sql`${t.role} IN ('owner','partner','staff','read_only')`,
    ),
    // One active membership per (firm,user). Historical (revoked) rows are kept.
    activeUniq: uniqueIndex('firm_memberships_firm_user_active_uniq')
      .on(t.firmId, t.userId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export const firmClientTenants = pgTable(
  'firm_client_tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    accessLevel: text('access_level').notNull().default('full'),
    engagementType: text('engagement_type').notNull().default('ongoing'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    firmIdx: index('firm_client_tenants_firm_idx').on(t.firmId),
    tenantIdx: index('firm_client_tenants_tenant_idx').on(t.tenantId),
    accessCheck: check(
      'firm_client_tenants_access_level_check',
      sql`${t.accessLevel} IN ('full','read_only')`,
    ),
    engagementCheck: check(
      'firm_client_tenants_engagement_type_check',
      sql`${t.engagementType} IN ('ongoing','periodic')`,
    ),
    // A tenant may be actively engaged by only ONE firm at a time. The
    // partial unique index ignores revoked rows so a tenant can move
    // between firms over time (revoke old link, then create a new one).
    activeTenantUniq: uniqueIndex('firm_client_tenants_tenant_active_uniq')
      .on(t.tenantId)
      .where(sql`revoked_at IS NULL`),
  }),
);

/**
 * Pending invitations the firm has sent out. Not in the task's required
 * table list but needed for the inviteMember / acceptInvitation flow,
 * because the invitee may not yet have a Faatora user row. Tokens are
 * opaque URL-safe strings and are one-shot — accepting or revoking
 * consumes them.
 */
export const firmInvitations = pgTable(
  'firm_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    token: text('token').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    firmIdx: index('firm_invitations_firm_idx').on(t.firmId),
    emailIdx: index('firm_invitations_email_idx').on(t.email),
    roleCheck: check(
      'firm_invitations_role_check',
      sql`${t.role} IN ('owner','partner','staff','read_only')`,
    ),
    // At most one open invite per (firm,email). Once accepted or revoked
    // the partial-unique predicate lets another one exist.
    openUniq: uniqueIndex('firm_invitations_firm_email_open_uniq')
      .on(t.firmId, t.email)
      .where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
  }),
);
