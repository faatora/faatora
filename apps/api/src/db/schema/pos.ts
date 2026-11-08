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
  primaryKey,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { invoices } from './invoicing';

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    unitPrice: numeric('unit_price', { precision: 18, scale: 3 }).notNull(),
    vatCategory: text('vat_category').notNull().default('S'),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('5'),
    barcode: text('barcode'),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantSkuUniq: unique('products_tenant_sku_uniq').on(t.tenantId, t.sku),
    tenantIdx: index('products_tenant_idx').on(t.tenantId),
    barcodeIdx: index('products_barcode_idx').on(t.barcode),
  }),
);

export const posSales = pgTable(
  'pos_sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull().defaultNow(),
    subtotal: numeric('subtotal', { precision: 18, scale: 3 }).notNull().default('0'),
    vatTotal: numeric('vat_total', { precision: 18, scale: 3 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 18, scale: 3 }).notNull().default('0'),
    tenderMethod: text('tender_method').notNull(),
    tenderCash: numeric('tender_cash', { precision: 18, scale: 3 }).notNull().default('0'),
    tenderCard: numeric('tender_card', { precision: 18, scale: 3 }).notNull().default('0'),
    changeGiven: numeric('change_given', { precision: 18, scale: 3 }).notNull().default('0'),
    clearanceStatus: text('clearance_status').notNull().default('PENDING_BATCH'),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    soldBy: uuid('sold_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantNumberUniq: unique('pos_sales_tenant_number_uniq').on(t.tenantId, t.number),
    tenantIdx: index('pos_sales_tenant_idx').on(t.tenantId),
    soldAtIdx: index('pos_sales_sold_at_idx').on(t.soldAt),
    clearanceIdx: index('pos_sales_clearance_status_idx').on(t.clearanceStatus),
  }),
);

export const posSaleLines = pgTable(
  'pos_sale_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => posSales.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 18, scale: 3 }).notNull(),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('5'),
    vatCategory: text('vat_category').notNull().default('S'),
    lineNet: numeric('line_net', { precision: 18, scale: 3 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    saleIdx: index('pos_sale_lines_sale_idx').on(t.saleId),
    tenantIdx: index('pos_sale_lines_tenant_idx').on(t.tenantId),
  }),
);

export const posNumberSequences = pgTable(
  'pos_number_sequences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    bucket: text('bucket').notNull(),
    seq: integer('seq').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({
      name: 'pos_number_sequences_pk',
      columns: [t.tenantId, t.scope, t.bucket],
    }),
  }),
);
