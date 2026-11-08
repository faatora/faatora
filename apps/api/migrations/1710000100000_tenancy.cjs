exports.up = (pgm) => {
  pgm.sql(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='faatora_app') THEN CREATE ROLE faatora_app LOGIN PASSWORD 'faatora_app'; END IF; END $$;`,
  );
  pgm.sql(
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO faatora_app', current_database()); END $$;`,
  );
  pgm.sql(`GRANT USAGE ON SCHEMA public TO faatora_app;`);
  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    vatin: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    cognito_sub: { type: 'text', notNull: true, unique: true },
    email: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('memberships', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true, default: 'clerk' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('memberships', 'memberships_tenant_user_uniq', {
    unique: ['tenant_id', 'user_id'],
  });
  pgm.createIndex('memberships', 'tenant_id', { name: 'memberships_tenant_idx' });
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO faatora_app;`);
  pgm.sql(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO faatora_app;`,
  );
  pgm.sql(`ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE tenants FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY tenant_self_isolation ON tenants USING (id = current_setting('app.tenant_id', true)::uuid);`,
  );
  pgm.sql(`ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE memberships FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY membership_isolation ON memberships USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
  );
};
exports.down = (pgm) => {
  pgm.dropTable('memberships');
  pgm.dropTable('users');
  pgm.dropTable('tenants');
};
