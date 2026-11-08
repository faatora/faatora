import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  date,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
export const parties = pgTable(
  'parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('customer'),
    name: text('name').notNull(),
    vatin: text('vatin'),
    country: text('country').notNull().default('OM'),
    address: jsonb('address'),
    peppolId: text('peppol_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tenantIdx: index('parties_tenant_idx').on(t.tenantId) }),
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('invoice'),
    number: text('number').notNull(),
    documentUuid: text('document_uuid'),
    status: text('status').notNull().default('DRAFT'),
    currency: text('currency').notNull().default('OMR'),
    issueDate: date('issue_date').notNull(),
    supplierPartyId: uuid('supplier_party_id')
      .notNull()
      .references(() => parties.id),
    buyerPartyId: uuid('buyer_party_id')
      .notNull()
      .references(() => parties.id),
    subtotal: numeric('subtotal', { precision: 18, scale: 3 }).notNull().default('0'),
    vatTotal: numeric('vat_total', { precision: 18, scale: 3 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 18, scale: 3 }).notNull().default('0'),
    vatBreakdown: jsonb('vat_breakdown').notNull().default([]),
    canonicalPayload: jsonb('canonical_payload'),
    rulePackVersion: text('rule_pack_version'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('invoices_tenant_idx').on(t.tenantId),
    numberUniq: unique('invoices_tenant_number_uniq').on(t.tenantId, t.number),
  }),
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    unitCode: text('unit_code').notNull().default('C62'),
    unitPrice: numeric('unit_price', { precision: 18, scale: 3 }).notNull(),
    vatCategory: text('vat_category').notNull().default('S'),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('5'),
    lineNet: numeric('line_net', { precision: 18, scale: 3 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index('invoice_lines_invoice_idx').on(t.invoiceId),
    tenantIdx: index('invoice_lines_tenant_idx').on(t.tenantId),
  }),
);
