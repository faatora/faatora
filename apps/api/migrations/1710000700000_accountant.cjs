exports.up = (pgm) => {
  pgm.createTable('accountant_firms', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    owner_user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    vatin: { type: 'text' },
    phone: { type: 'text' },
    email: { type: 'text' },
    commission_rate: { type: 'numeric(5,4)', notNull: true, default: 0.2 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('accountant_firms', 'accountant_firms_owner_user_id_uniq', {
    unique: ['owner_user_id'],
  });
  pgm.createIndex('accountant_firms', 'owner_user_id', {
    name: 'accountant_firms_owner_user_idx',
  });

  pgm.createTable('accountant_client_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: {
      type: 'uuid',
      notNull: true,
      references: 'accountant_firms',
      onDelete: 'CASCADE',
    },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    referred: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('accountant_client_links', 'accountant_client_links_firm_tenant_uniq', {
    unique: ['firm_id', 'tenant_id'],
  });
  pgm.createIndex('accountant_client_links', 'firm_id', {
    name: 'accountant_client_links_firm_idx',
  });
  pgm.createIndex('accountant_client_links', 'tenant_id', {
    name: 'accountant_client_links_tenant_idx',
  });

  // Public tables (no RLS) — service layer enforces authorization through tenant membership checks.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON accountant_firms TO fawtara_app;`);
  pgm.sql(`GRANT SELECT, INSERT, DELETE ON accountant_client_links TO fawtara_app;`);
};

exports.down = (pgm) => {
  pgm.dropTable('accountant_client_links');
  pgm.dropTable('accountant_firms');
};
