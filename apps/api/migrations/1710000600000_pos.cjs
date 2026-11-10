exports.up = (pgm) => {
  pgm.createTable('products', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    sku: { type: 'text', notNull: true },
    name_en: { type: 'text', notNull: true },
    name_ar: { type: 'text' },
    unit_price: { type: 'numeric(18,3)', notNull: true },
    vat_category: { type: 'text', notNull: true, default: 'S' },
    vat_rate: { type: 'numeric(5,2)', notNull: true, default: 5 },
    barcode: { type: 'text' },
    archived: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('products', 'products_tenant_sku_uniq', { unique: ['tenant_id', 'sku'] });
  pgm.createIndex('products', 'tenant_id', { name: 'products_tenant_idx' });
  pgm.createIndex('products', 'barcode', { name: 'products_barcode_idx' });

  pgm.createTable('pos_sales', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    number: { type: 'text', notNull: true },
    sold_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    subtotal: { type: 'numeric(18,3)', notNull: true, default: 0 },
    vat_total: { type: 'numeric(18,3)', notNull: true, default: 0 },
    grand_total: { type: 'numeric(18,3)', notNull: true, default: 0 },
    tender_method: { type: 'text', notNull: true },
    tender_cash: { type: 'numeric(18,3)', notNull: true, default: 0 },
    tender_card: { type: 'numeric(18,3)', notNull: true, default: 0 },
    change_given: { type: 'numeric(18,3)', notNull: true, default: 0 },
    clearance_status: { type: 'text', notNull: true, default: 'PENDING_BATCH' },
    invoice_id: { type: 'uuid', references: 'invoices', onDelete: 'SET NULL' },
    sold_by: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('pos_sales', 'pos_sales_tenant_number_uniq', {
    unique: ['tenant_id', 'number'],
  });
  pgm.createIndex('pos_sales', 'tenant_id', { name: 'pos_sales_tenant_idx' });
  pgm.createIndex('pos_sales', 'sold_at', { name: 'pos_sales_sold_at_idx' });
  pgm.createIndex('pos_sales', 'clearance_status', { name: 'pos_sales_clearance_status_idx' });

  pgm.createTable('pos_sale_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    sale_id: { type: 'uuid', notNull: true, references: 'pos_sales', onDelete: 'CASCADE' },
    line_no: { type: 'integer', notNull: true },
    product_id: { type: 'uuid', references: 'products', onDelete: 'SET NULL' },
    description: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,3)', notNull: true },
    unit_price: { type: 'numeric(18,3)', notNull: true },
    vat_rate: { type: 'numeric(5,2)', notNull: true, default: 5 },
    vat_category: { type: 'text', notNull: true, default: 'S' },
    line_net: { type: 'numeric(18,3)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('pos_sale_lines', 'sale_id', { name: 'pos_sale_lines_sale_idx' });
  pgm.createIndex('pos_sale_lines', 'tenant_id', { name: 'pos_sale_lines_tenant_idx' });

  // Per-tenant sequence allocation: one row per (tenant_id, scope, bucket).
  // scope='pos_sale' with bucket=YYYYMMDD for daily POS numbering.
  // scope='b2c_invoice' with bucket=YYYYMMDD for daily B2C summary invoice numbering.
  pgm.createTable('pos_number_sequences', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    scope: { type: 'text', notNull: true },
    bucket: { type: 'text', notNull: true },
    seq: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('pos_number_sequences', 'pos_number_sequences_pk', {
    primaryKey: ['tenant_id', 'scope', 'bucket'],
  });

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO faatora_app;`);

  for (const tbl of ['products', 'pos_sales', 'pos_sale_lines', 'pos_number_sequences']) {
    pgm.sql(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(
      `CREATE POLICY ${tbl}_isolation ON ${tbl} USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
    );
  }
};

exports.down = (pgm) => {
  pgm.dropTable('pos_number_sequences');
  pgm.dropTable('pos_sale_lines');
  pgm.dropTable('pos_sales');
  pgm.dropTable('products');
};
