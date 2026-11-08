import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    companyName: text('company_name').notNull(),
    phone: text('phone').notNull(),
    revenueBand: text('revenue_band').notNull(),
    currentTool: text('current_tool').notNull(),
    invoiceVolumeBand: text('invoice_volume_band').notNull(),
    b2cShare: text('b2c_share').notNull(),
    erp: text('erp'),
    vatRegistered: boolean('vat_registered').notNull(),
    source: text('source').notNull().default('checker'),
    verdict: jsonb('verdict').notNull().default({}),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index('leads_email_idx').on(t.email),
    createdAtIdx: index('leads_created_at_idx').on(t.createdAt),
  }),
);
