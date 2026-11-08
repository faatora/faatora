exports.up = (pgm) => {
  pgm.createTable('archive_records', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'CASCADE' },
    signed_document_id: { type: 'uuid', notNull: true, references: 'signed_documents' },
    document_uuid: { type: 'text', notNull: true },
    storage_backend: { type: 'text', notNull: true },
    storage_key: { type: 'text', notNull: true },
    storage_bucket: { type: 'text' },
    storage_region: { type: 'text' },
    sha256: { type: 'text', notNull: true },
    prev_sha256: { type: 'text' },
    chain_hash: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true, default: 'application/xml' },
    byte_size: { type: 'bigint', notNull: true },
    retention_until: { type: 'date', notNull: true },
    archived_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('archive_records', 'archive_records_backend_check', {
    check: "storage_backend IN ('filesystem','s3')",
  });
  pgm.addConstraint('archive_records', 'archive_records_tenant_invoice_uniq', {
    unique: ['tenant_id', 'invoice_id'],
  });
  pgm.createIndex('archive_records', 'tenant_id', { name: 'archive_records_tenant_idx' });
  pgm.createIndex('archive_records', 'invoice_id', { name: 'archive_records_invoice_idx' });
  pgm.createIndex('archive_records', 'document_uuid', { name: 'archive_records_doc_uuid_idx' });
  pgm.createIndex('archive_records', ['tenant_id', 'archived_at'], {
    name: 'archive_records_tenant_archived_idx',
  });
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON archive_records TO fawtara_app;`);
  pgm.sql(`ALTER TABLE archive_records ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE archive_records FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY archive_records_isolation ON archive_records USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
  );
};

exports.down = (pgm) => {
  pgm.dropTable('archive_records');
};
