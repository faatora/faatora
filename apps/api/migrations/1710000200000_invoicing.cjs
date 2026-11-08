exports.up = (pgm) => {
  pgm.createTable('parties', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true, default: 'customer' },
    name: { type: 'text', notNull: true },
    vatin: { type: 'text' },
    country: { type: 'text', notNull: true, default: 'OM' },
    address: { type: 'jsonb' },
    peppol_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('parties', 'tenant_id', { name: 'parties_tenant_idx' });
  pgm.createTable('invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true, default: 'invoice' },
    number: { type: 'text', notNull: true },
    document_uuid: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'DRAFT' },
    currency: { type: 'text', notNull: true, default: 'OMR' },
    issue_date: { type: 'date', notNull: true },
    supplier_party_id: { type: 'uuid', notNull: true, references: 'parties' },
    buyer_party_id: { type: 'uuid', notNull: true, references: 'parties' },
    subtotal: { type: 'numeric(18,3)', notNull: true, default: 0 },
    vat_total: { type: 'numeric(18,3)', notNull: true, default: 0 },
    grand_total: { type: 'numeric(18,3)', notNull: true, default: 0 },
    vat_breakdown: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    canonical_payload: { type: 'jsonb' },
    rule_pack_version: { type: 'text' },
    notes: { type: 'text' },
    created_by: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('invoices', 'tenant_id', { name: 'invoices_tenant_idx' });
  pgm.addConstraint('invoices', 'invoices_tenant_number_uniq', { unique: ['tenant_id', 'number'] });
  pgm.createTable('invoice_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'CASCADE' },
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
  pgm.createIndex('invoice_lines', 'invoice_id', { name: 'invoice_lines_invoice_idx' });
  pgm.createIndex('invoice_lines', 'tenant_id', { name: 'invoice_lines_tenant_idx' });
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fawtara_app;`);
  for (const tbl of ['parties', 'invoices', 'invoice_lines']) {
    pgm.sql(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(
      `CREATE POLICY ${tbl}_isolation ON ${tbl} USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
    );
  }
};
exports.down = (pgm) => {
  pgm.dropTable('invoice_lines');
  pgm.dropTable('invoices');
  pgm.dropTable('parties');
};
