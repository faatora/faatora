import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  monthlyFee: numeric('monthly_fee', { precision: 18, scale: 3 }).notNull(),
  includedInvoices: integer('included_invoices').notNull().default(0),
  overagePricePerInvoice: numeric('overage_price_per_invoice', { precision: 18, scale: 4 })
    .notNull()
    .default('0'),
  currency: text('currency').notNull().default('OMR'),
  archived: boolean('archived').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true })
      .notNull()
      .defaultNow(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('subscriptions_tenant_idx').on(t.tenantId),
    tenantUniq: unique('subscriptions_tenant_uniq').on(t.tenantId),
  }),
);

export const usageMeters = pgTable(
  'usage_meters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    metric: text('metric').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => ({
    tenantPeriodIdx: index('usage_meters_tenant_period_idx').on(t.tenantId, t.periodStart),
    tenantPeriodMetricUniq: unique('usage_meters_tenant_period_metric_uniq').on(
      t.tenantId,
      t.periodStart,
      t.metric,
    ),
  }),
);

export const billingInvoices = pgTable(
  'billing_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    planFee: numeric('plan_fee', { precision: 18, scale: 3 }).notNull().default('0'),
    overageFee: numeric('overage_fee', { precision: 18, scale: 3 }).notNull().default('0'),
    subtotal: numeric('subtotal', { precision: 18, scale: 3 }).notNull(),
    vat: numeric('vat', { precision: 18, scale: 3 }).notNull().default('0'),
    total: numeric('total', { precision: 18, scale: 3 }).notNull(),
    currency: text('currency').notNull().default('OMR'),
    status: text('status').notNull().default('open'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('billing_invoices_tenant_idx').on(t.tenantId),
    numberUniq: unique('billing_invoices_tenant_number_uniq').on(t.tenantId, t.number),
  }),
);

export const resellerCommissions = pgTable(
  'reseller_commissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    billingInvoiceId: uuid('billing_invoice_id')
      .notNull()
      .references(() => billingInvoices.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 18, scale: 3 }).notNull(),
    status: text('status').notNull().default('accrued'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStatusIdx: index('reseller_commissions_firm_status_idx').on(t.firmId, t.status),
    billingInvoiceUniq: unique('reseller_commissions_billing_invoice_uniq').on(t.billingInvoiceId),
  }),
);
