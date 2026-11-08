exports.up = (pgm) => {
  pgm.createTable('signed_documents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'CASCADE' },
    document_uuid: { type: 'text', notNull: true },
    signed_xml: { type: 'text', notNull: true },
    signature_value: { type: 'text', notNull: true },
    signature_algorithm: { type: 'text', notNull: true },
    key_id: { type: 'text' },
    qr_png_base64: { type: 'text', notNull: true },
    pdf_base64: { type: 'text' },
    sha256: { type: 'text', notNull: true },
    signed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('signed_documents', 'tenant_id', { name: 'signed_documents_tenant_idx' });
  pgm.createIndex('signed_documents', 'invoice_id', { name: 'signed_documents_invoice_idx' });
  pgm.sql(`GRANT SELECT, INSERT ON signed_documents TO fawtara_app;`);
  pgm.sql(`ALTER TABLE signed_documents ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE signed_documents FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY signed_documents_isolation ON signed_documents USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
  );
};
exports.down = (pgm) => {
  pgm.dropTable('signed_documents');
};
