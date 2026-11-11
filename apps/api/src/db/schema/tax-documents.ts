/**
 * Credit / debit note storage.
 *
 * We use a single `tax_documents` table discriminated by the `kind`
 * column (`credit_note` | `debit_note`) rather than two near-identical
 * tables. Rationale:
 *   - Both document kinds share the same shape (reference to an
 *     original invoice, party pair, lines, VAT breakdown).
 *   - Oman VAT law treats them as mirror operations on the same
 *     original invoice (credit = reduction, debit = increase), so
 *     keeping them in one table lets the audit log + listings join on
 *     original_invoice_id without a UNION.
 *   - A future `corrected_invoice` (UNTDID 384) or `self_billed`
 *     (389) would slot into the same table with a new kind value.
 *
 * `tax_document_lines` mirrors `invoice_lines`. The original line
 * reference is kept nullable so a partial credit can point back at
 * the line it credits for audit, while a free-form adjustment can
 * leave it NULL.
 *
 * RLS: identical pattern to `invoices` / `invoice_lines` (see migration
 * 1710002000000). Tenant isolation uses the NULLIF cast, FORCE RLS is
 * on, and the firm-console read branch is added so a firm user viewing
 * a client's documents is covered by the same ADR-0003 option (a)
 * path as the existing invoice tables.
 */

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
import { invoices, parties, invoiceLines } from './invoicing';

export const taxDocuments = pgTable(
  'tax_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** 'credit_note' | 'debit_note'. */
    kind: text('kind').notNull(),
    number: text('number').notNull(),
    documentUuid: text('document_uuid'),
    status: text('status').notNull().default('DRAFT'),
    currency: text('currency').notNull().default('OMR'),
    issueDate: date('issue_date').notNull(),

    /** The invoice this document references. Must belong to the same
     *  tenant; enforced at the service layer and via the tenant RLS
     *  policy on both sides. */
    originalInvoiceId: uuid('original_invoice_id')
      .notNull()
      .references(() => invoices.id),

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

    /** Free-form reason / note shown to the buyer (BT-22 analogue). */
    reason: text('reason'),
    notes: text('notes'),

    /** Serialised UBL (CreditNote-2 or Invoice-2 for debit notes). */
    ublXml: text('ubl_xml'),
    rulePackVersion: text('rule_pack_version'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('tax_documents_tenant_idx').on(t.tenantId),
    originalIdx: index('tax_documents_original_idx').on(t.originalInvoiceId),
    numberUniq: unique('tax_documents_tenant_number_uniq').on(t.tenantId, t.number),
  }),
);

export const taxDocumentLines = pgTable(
  'tax_document_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    taxDocumentId: uuid('tax_document_id')
      .notNull()
      .references(() => taxDocuments.id, { onDelete: 'cascade' }),
    /** The invoice line this document line is correcting, when
     *  applicable. NULL for free-form adjustments. */
    originalInvoiceLineId: uuid('original_invoice_line_id').references(() => invoiceLines.id),
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
    docIdx: index('tax_document_lines_doc_idx').on(t.taxDocumentId),
    tenantIdx: index('tax_document_lines_tenant_idx').on(t.tenantId),
  }),
);

export type TaxDocumentRow = typeof taxDocuments.$inferSelect;
export type TaxDocumentLineRow = typeof taxDocumentLines.$inferSelect;
export type TaxDocumentKind = 'credit_note' | 'debit_note';
