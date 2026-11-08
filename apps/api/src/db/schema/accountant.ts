import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants, users } from './tenancy';

export const accountantFirms = pgTable(
  'accountant_firms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    vatin: text('vatin'),
    phone: text('phone'),
    email: text('email'),
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull().default('0.2'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerUniq: unique('accountant_firms_owner_user_id_uniq').on(t.ownerUserId),
    ownerIdx: index('accountant_firms_owner_user_idx').on(t.ownerUserId),
  }),
);

export const accountantClientLinks = pgTable(
  'accountant_client_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => accountantFirms.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    referred: boolean('referred').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmTenantUniq: unique('accountant_client_links_firm_tenant_uniq').on(t.firmId, t.tenantId),
    firmIdx: index('accountant_client_links_firm_idx').on(t.firmId),
    tenantIdx: index('accountant_client_links_tenant_idx').on(t.tenantId),
  }),
);
