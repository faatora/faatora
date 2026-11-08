exports.up = (pgm) => {
  // 1a. plans — public static catalog, no RLS
  pgm.createTable('plans', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    code: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    monthly_fee: { type: 'numeric(18,3)', notNull: true },
    included_invoices: { type: 'integer', notNull: true, default: 0 },
    overage_price_per_invoice: { type: 'numeric(18,4)', notNull: true, default: 0 },
    currency: { type: 'text', notNull: true, default: 'OMR' },
    archived: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(
    `INSERT INTO plans (code, name, monthly_fee, included_invoices, overage_price_per_invoice) VALUES
       ('basic','Basic',12,100,0.0300),
       ('pro','Pro',25,500,0.0250);`,
  );

  // 1b. subscriptions — RLS by tenant
  pgm.createTable('subscriptions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    plan_id: { type: 'uuid', notNull: true, references: 'plans' },
    status: { type: 'text', notNull: true, default: 'active' },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    current_period_start: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    current_period_end: { type: 'timestamptz', notNull: true },
    canceled_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('subscriptions', 'subscriptions_status_check', {
    check: "status IN ('trialing','active','past_due','canceled')",
  });
  pgm.addConstraint('subscriptions', 'subscriptions_tenant_uniq', { unique: ['tenant_id'] });
  pgm.createIndex('subscriptions', 'tenant_id', { name: 'subscriptions_tenant_idx' });

  // 1c. usage_meters — RLS by tenant
  pgm.createTable('usage_meters', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    period_start: { type: 'timestamptz', notNull: true },
    period_end: { type: 'timestamptz', notNull: true },
    metric: { type: 'text', notNull: true },
    count: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('usage_meters', 'usage_meters_tenant_period_metric_uniq', {
    unique: ['tenant_id', 'period_start', 'metric'],
  });
  pgm.createIndex('usage_meters', ['tenant_id', 'period_start'], {
    name: 'usage_meters_tenant_period_idx',
  });

  // 1d. billing_invoices — RLS by tenant
  pgm.createTable('billing_invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    number: { type: 'text', notNull: true },
    period_start: { type: 'timestamptz', notNull: true },
    period_end: { type: 'timestamptz', notNull: true },
    plan_fee: { type: 'numeric(18,3)', notNull: true, default: 0 },
    overage_fee: { type: 'numeric(18,3)', notNull: true, default: 0 },
    subtotal: { type: 'numeric(18,3)', notNull: true },
    vat: { type: 'numeric(18,3)', notNull: true, default: 0 },
    total: { type: 'numeric(18,3)', notNull: true },
    currency: { type: 'text', notNull: true, default: 'OMR' },
    status: { type: 'text', notNull: true, default: 'open' },
    paid_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('billing_invoices', 'billing_invoices_status_check', {
    check: "status IN ('open','paid','void')",
  });
  pgm.addConstraint('billing_invoices', 'billing_invoices_tenant_number_uniq', {
    unique: ['tenant_id', 'number'],
  });
  pgm.createIndex('billing_invoices', 'tenant_id', { name: 'billing_invoices_tenant_idx' });

  // 1e. reseller_commissions — public, keyed by firm_id, no RLS
  pgm.createTable('reseller_commissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: { type: 'uuid', notNull: true },
    tenant_id: { type: 'uuid', notNull: true },
    billing_invoice_id: {
      type: 'uuid',
      notNull: true,
      references: 'billing_invoices',
      onDelete: 'CASCADE',
    },
    amount: { type: 'numeric(18,3)', notNull: true },
    status: { type: 'text', notNull: true, default: 'accrued' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('reseller_commissions', 'reseller_commissions_status_check', {
    check: "status IN ('accrued','paid')",
  });
  pgm.addConstraint('reseller_commissions', 'reseller_commissions_billing_invoice_uniq', {
    unique: ['billing_invoice_id'],
  });
  pgm.createIndex('reseller_commissions', ['firm_id', 'status'], {
    name: 'reseller_commissions_firm_status_idx',
  });

  // Grants
  pgm.sql(`GRANT SELECT ON plans TO fawtara_app;`);
  pgm.sql(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions, usage_meters, billing_invoices TO fawtara_app;`,
  );
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON reseller_commissions TO fawtara_app;`);

  // RLS on tenant-scoped tables
  for (const tbl of ['subscriptions', 'usage_meters', 'billing_invoices']) {
    pgm.sql(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(
      `CREATE POLICY ${tbl}_isolation ON ${tbl} USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
    );
  }
};

exports.down = (pgm) => {
  pgm.dropTable('reseller_commissions');
  pgm.dropTable('billing_invoices');
  pgm.dropTable('usage_meters');
  pgm.dropTable('subscriptions');
  pgm.dropTable('plans');
};
