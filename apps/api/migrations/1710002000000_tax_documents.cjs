/**
 * Credit note + debit note storage.
 *
 * A single tax_documents table discriminated by `kind`
 * ('credit_note' | 'debit_note') plus tax_document_lines. Shape
 * mirrors invoices / invoice_lines so the existing withTenant /
 * withFirmTenant paths and audit / archiving flows apply with no
 * structural change.
 *
 * RLS follows the same pattern as invoices:
 *   - FORCE ROW LEVEL SECURITY on both tables.
 *   - `tenant_isolation`-style policy using the Wave 1 NULLIF cast
 *     (migration 1710001900000) so an unset app.tenant_id evaluates
 *     cleanly to NULL instead of throwing on the empty-string cast.
 *   - A firm_read SELECT-only branch mirroring the invoice firm
 *     branch (migration 1710001500000) so a firm operator can view a
 *     client's tax documents through the firm console without
 *     switching tenant context first. Cross-tenant mutations still
 *     go through withFirmTenant, which gates WITH CHECK.
 */

exports.up = (pgm) => {
  pgm.createTable('tax_documents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    number: { type: 'text', notNull: true },
    document_uuid: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'DRAFT' },
    currency: { type: 'text', notNull: true, default: 'OMR' },
    issue_date: { type: 'date', notNull: true },
    original_invoice_id: { type: 'uuid', notNull: true, references: 'invoices' },
    supplier_party_id: { type: 'uuid', notNull: true, references: 'parties' },
    buyer_party_id: { type: 'uuid', notNull: true, references: 'parties' },
    subtotal: { type: 'numeric(18,3)', notNull: true, default: 0 },
    vat_total: { type: 'numeric(18,3)', notNull: true, default: 0 },
    grand_total: { type: 'numeric(18,3)', notNull: true, default: 0 },
    vat_breakdown: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    reason: { type: 'text' },
    notes: { type: 'text' },
    ubl_xml: { type: 'text' },
    rule_pack_version: { type: 'text' },
    created_by: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('tax_documents', 'tax_documents_kind_check', {
    check: "kind IN ('credit_note','debit_note')",
  });
  pgm.createIndex('tax_documents', 'tenant_id', { name: 'tax_documents_tenant_idx' });
  pgm.createIndex('tax_documents', 'original_invoice_id', { name: 'tax_documents_original_idx' });
  pgm.addConstraint('tax_documents', 'tax_documents_tenant_number_uniq', {
    unique: ['tenant_id', 'number'],
  });

  pgm.createTable('tax_document_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    tax_document_id: {
      type: 'uuid',
      notNull: true,
      references: 'tax_documents',
      onDelete: 'CASCADE',
    },
    original_invoice_line_id: { type: 'uuid', references: 'invoice_lines' },
    line_no: { type: 'integer', notNull: true },
    description: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,3)', notNull: true },
    unit_code: { type: 'text', notNull: true, default: 'C62' },
    unit_price: { type: 'numeric(18,3)', notNull: true },
    vat_category: { type: 'text', notNull: true, default: 'S' },
    vat_rate: { type: 'numeric(5,2)', notNull: true, default: 5 },
    line_net: { type: 'numeric(18,3)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('tax_document_lines', 'tax_document_id', {
    name: 'tax_document_lines_doc_idx',
  });
  pgm.createIndex('tax_document_lines', 'tenant_id', {
    name: 'tax_document_lines_tenant_idx',
  });

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO faatora_app;`);

  const NEW_CAST = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
  for (const tbl of ['tax_documents', 'tax_document_lines']) {
    pgm.sql(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(
      `CREATE POLICY ${tbl}_isolation ON ${tbl}
         USING (tenant_id = ${NEW_CAST})
         WITH CHECK (tenant_id = ${NEW_CAST});`,
    );
    pgm.sql(
      `CREATE POLICY ${tbl}_firm_read ON ${tbl}
         FOR SELECT
         USING (
           tenant_id IN (
             SELECT tenant_id FROM firm_client_tenants
             WHERE firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid
               AND revoked_at IS NULL
           )
         );`,
    );
  }
};

exports.down = (pgm) => {
  pgm.dropTable('tax_document_lines');
  pgm.dropTable('tax_documents');
};
