exports.up = (pgm) => {
  pgm.createTable('accounts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    code: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true },
    parent_id: { type: 'uuid', references: 'accounts', onDelete: 'SET NULL' },
    is_vat_output: { type: 'boolean', notNull: true, default: false },
    is_vat_input: { type: 'boolean', notNull: true, default: false },
    archived: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('accounts', 'accounts_type_check', {
    check: "type IN ('asset','liability','equity','income','expense')",
  });
  pgm.addConstraint('accounts', 'accounts_tenant_code_uniq', { unique: ['tenant_id', 'code'] });
  pgm.createIndex('accounts', 'tenant_id', { name: 'accounts_tenant_idx' });

  pgm.createTable('journals', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    entry_date: { type: 'date', notNull: true },
    memo: { type: 'text' },
    source: { type: 'text', notNull: true, default: 'adjustment' },
    source_id: { type: 'uuid' },
    posted: { type: 'boolean', notNull: true, default: false },
    posted_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('journals', 'journals_source_check', {
    check: "source IN ('invoice','bill','payment','adjustment')",
  });
  pgm.createIndex('journals', ['tenant_id', 'entry_date'], { name: 'journals_tenant_date_idx' });

  pgm.createTable('journal_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    journal_id: { type: 'uuid', notNull: true, references: 'journals', onDelete: 'CASCADE' },
    line_no: { type: 'integer', notNull: true },
    account_id: { type: 'uuid', notNull: true, references: 'accounts' },
    debit: { type: 'numeric(18,3)', notNull: true, default: 0 },
    credit: { type: 'numeric(18,3)', notNull: true, default: 0 },
    description: { type: 'text' },
  });
  pgm.addConstraint('journal_lines', 'journal_lines_sign_check', {
    check: 'debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0)',
  });
  pgm.createIndex('journal_lines', 'journal_id', { name: 'journal_lines_journal_idx' });
  pgm.createIndex('journal_lines', 'tenant_id', { name: 'journal_lines_tenant_idx' });

  pgm.createTable('supplier_bills', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    supplier_party_id: { type: 'uuid', notNull: true, references: 'parties' },
    number: { type: 'text', notNull: true },
    issue_date: { type: 'date', notNull: true },
    due_date: { type: 'date' },
    currency: { type: 'text', notNull: true, default: 'OMR' },
    subtotal: { type: 'numeric(18,3)', notNull: true, default: 0 },
    vat_total: { type: 'numeric(18,3)', notNull: true, default: 0 },
    grand_total: { type: 'numeric(18,3)', notNull: true, default: 0 },
    status: { type: 'text', notNull: true, default: 'DRAFT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('supplier_bills', 'supplier_bills_status_check', {
    check: "status IN ('DRAFT','POSTED','PAID','CANCELLED')",
  });
  pgm.addConstraint('supplier_bills', 'supplier_bills_tenant_number_uniq', {
    unique: ['tenant_id', 'number'],
  });
  pgm.createIndex('supplier_bills', 'tenant_id', { name: 'supplier_bills_tenant_idx' });

  pgm.createTable('payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    direction: { type: 'text', notNull: true },
    date: { type: 'date', notNull: true },
    amount: { type: 'numeric(18,3)', notNull: true },
    method: { type: 'text', notNull: true },
    party_id: { type: 'uuid', notNull: true, references: 'parties' },
    invoice_id: { type: 'uuid', references: 'invoices' },
    bill_id: { type: 'uuid', references: 'supplier_bills' },
    memo: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('payments', 'payments_direction_check', {
    check: "direction IN ('in','out')",
  });
  pgm.addConstraint('payments', 'payments_method_check', {
    check: "method IN ('cash','card','bank','cheque','other')",
  });
  pgm.createIndex('payments', ['tenant_id', 'date'], { name: 'payments_tenant_date_idx' });

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fawtara_app;`);
  for (const tbl of ['accounts', 'journals', 'journal_lines', 'supplier_bills', 'payments']) {
    pgm.sql(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(
      `CREATE POLICY ${tbl}_isolation ON ${tbl} USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
    );
  }
};
exports.down = (pgm) => {
  pgm.dropTable('payments');
  pgm.dropTable('supplier_bills');
  pgm.dropTable('journal_lines');
  pgm.dropTable('journals');
  pgm.dropTable('accounts');
};
