import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { invoices } from './invoicing';

export const signedDocuments = pgTable(
  'signed_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    documentUuid: text('document_uuid').notNull(),
    signedXml: text('signed_xml').notNull(),
    signatureValue: text('signature_value').notNull(),
    signatureAlgorithm: text('signature_algorithm').notNull(),
    keyId: text('key_id'),
    qrPngBase64: text('qr_png_base64').notNull(),
    pdfBase64: text('pdf_base64'),
    sha256: text('sha256').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('signed_documents_tenant_idx').on(t.tenantId),
    invoiceIdx: index('signed_documents_invoice_idx').on(t.invoiceId),
  }),
);
