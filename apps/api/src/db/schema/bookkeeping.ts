import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  date,
  boolean,
  index,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { parties, invoices } from './invoicing';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id, {
      onDelete: 'set null',
    }),
    isVatOutput: boolean('is_vat_output').notNull().default(false),
    isVatInput: boolean('is_vat_input').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('accounts_tenant_idx').on(t.tenantId),
    codeUniq: unique('accounts_tenant_code_uniq').on(t.tenantId, t.code),
  }),
);

export const journals = pgTable(
  'journals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    entryDate: date('entry_date').notNull(),
    memo: text('memo'),
    source: text('source').notNull().default('adjustment'),
    sourceId: uuid('source_id'),
    posted: boolean('posted').notNull().default(false),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantDateIdx: index('journals_tenant_date_idx').on(t.tenantId, t.entryDate),
  }),
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journals.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    debit: numeric('debit', { precision: 18, scale: 3 }).notNull().default('0'),
    credit: numeric('credit', { precision: 18, scale: 3 }).notNull().default('0'),
    description: text('description'),
  },
  (t) => ({
    journalIdx: index('journal_lines_journal_idx').on(t.journalId),
    tenantIdx: index('journal_lines_tenant_idx').on(t.tenantId),
  }),
);

export const supplierBills = pgTable(
  'supplier_bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    supplierPartyId: uuid('supplier_party_id')
      .notNull()
      .references(() => parties.id),
    number: text('number').notNull(),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date'),
    currency: text('currency').notNull().default('OMR'),
    subtotal: numeric('subtotal', { precision: 18, scale: 3 }).notNull().default('0'),
    vatTotal: numeric('vat_total', { precision: 18, scale: 3 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 18, scale: 3 }).notNull().default('0'),
    status: text('status').notNull().default('DRAFT'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('supplier_bills_tenant_idx').on(t.tenantId),
    numberUniq: unique('supplier_bills_tenant_number_uniq').on(t.tenantId, t.number),
  }),
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    date: date('date').notNull(),
    amount: numeric('amount', { precision: 18, scale: 3 }).notNull(),
    method: text('method').notNull(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    billId: uuid('bill_id').references(() => supplierBills.id),
    memo: text('memo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantDateIdx: index('payments_tenant_date_idx').on(t.tenantId, t.date),
  }),
);
