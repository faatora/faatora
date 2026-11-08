/**
 * EP5 Wave 1 — firms, firm_memberships, firm_client_tenants, firm_invitations.
 *
 * RLS is FORCE-enabled on every new table and keyed on
 *   current_setting('app.firm_id', true)::uuid
 * set via the withFirm transaction wrapper. The non-BYPASSRLS application
 * role `faatora_app` cannot sidestep these policies.
 *
 * Design note (ADR-0003 captures the full picture): we chose option (a) —
 * extending the existing invoice / party / invoice_line SELECT policies so
 * a firm user with `app.firm_id` set can read any client tenant actively
 * linked via firm_client_tenants. That branch is added in the companion
 * migration 1710001300000_firm_invoice_rls_branch.cjs so this one stays
 * narrowly about the new tables and can be rolled back independently.
 */

const NEW_TABLES = ['firms', 'firm_memberships', 'firm_client_tenants', 'firm_invitations'];

exports.up = (pgm) => {
  // -------- firms --------
  pgm.createTable('firms', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    legal_name: { type: 'text' },
    cr_number: { type: 'text' },
    country: { type: 'text', notNull: true, default: 'OM' },
    vatin: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // -------- firm_memberships --------
  pgm.createTable('firm_memberships', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: { type: 'uuid', notNull: true, references: 'firms', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('firm_memberships', 'firm_memberships_role_check', {
    check: `role IN ('owner','partner','staff','read_only')`,
  });
  pgm.createIndex('firm_memberships', 'firm_id', { name: 'firm_memberships_firm_idx' });
  pgm.createIndex('firm_memberships', 'user_id', { name: 'firm_memberships_user_idx' });
  pgm.sql(
    `CREATE UNIQUE INDEX firm_memberships_firm_user_active_uniq
       ON firm_memberships (firm_id, user_id)
       WHERE revoked_at IS NULL;`,
  );

  // -------- firm_client_tenants --------
  pgm.createTable('firm_client_tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: { type: 'uuid', notNull: true, references: 'firms', onDelete: 'CASCADE' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    access_level: { type: 'text', notNull: true, default: 'full' },
    engagement_type: { type: 'text', notNull: true, default: 'ongoing' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('firm_client_tenants', 'firm_client_tenants_access_level_check', {
    check: `access_level IN ('full','read_only')`,
  });
  pgm.addConstraint('firm_client_tenants', 'firm_client_tenants_engagement_type_check', {
    check: `engagement_type IN ('ongoing','periodic')`,
  });
  pgm.createIndex('firm_client_tenants', 'firm_id', { name: 'firm_client_tenants_firm_idx' });
  pgm.createIndex('firm_client_tenants', 'tenant_id', { name: 'firm_client_tenants_tenant_idx' });
  // Core invariant: a tenant may only be actively engaged by ONE firm at a time.
  pgm.sql(
    `CREATE UNIQUE INDEX firm_client_tenants_tenant_active_uniq
       ON firm_client_tenants (tenant_id)
       WHERE revoked_at IS NULL;`,
  );

  // -------- firm_invitations --------
  pgm.createTable('firm_invitations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: { type: 'uuid', notNull: true, references: 'firms', onDelete: 'CASCADE' },
    email: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true },
    token: { type: 'text', notNull: true, unique: true },
    invited_by_user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    accepted_at: { type: 'timestamptz' },
    accepted_by_user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('firm_invitations', 'firm_invitations_role_check', {
    check: `role IN ('owner','partner','staff','read_only')`,
  });
  pgm.createIndex('firm_invitations', 'firm_id', { name: 'firm_invitations_firm_idx' });
  pgm.createIndex('firm_invitations', 'email', { name: 'firm_invitations_email_idx' });
  pgm.sql(
    `CREATE UNIQUE INDEX firm_invitations_firm_email_open_uniq
       ON firm_invitations (firm_id, email)
       WHERE accepted_at IS NULL AND revoked_at IS NULL;`,
  );

  // -------- grants --------
  pgm.sql(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON firms, firm_memberships, firm_client_tenants, firm_invitations TO faatora_app;`,
  );

  // -------- RLS (FORCE) --------
  //
  // Firms keyed on app.firm_id. No tenant_id column here — a firm row is
  // only visible when the firm the caller is acting as matches.
  pgm.sql(`ALTER TABLE firms ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE firms FORCE ROW LEVEL SECURITY;`);
  // NULLIF('', '')::uuid = NULL::uuid = NULL. This is important because
  // SET LOCAL leaves the parameter as '' (empty string), not NULL, once
  // the transaction ends — a straight ::uuid cast on '' would throw
  // `invalid input syntax for type uuid` and surface as an error inside
  // unrelated queries later on the same connection. See withFirm.
  pgm.sql(
    `CREATE POLICY firms_self_isolation ON firms
       USING (id = NULLIF(current_setting('app.firm_id', true), '')::uuid)
       WITH CHECK (id = NULLIF(current_setting('app.firm_id', true), '')::uuid);`,
  );

  pgm.sql(`ALTER TABLE firm_memberships ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE firm_memberships FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY firm_memberships_isolation ON firm_memberships
       USING (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid)
       WITH CHECK (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid);`,
  );

  pgm.sql(`ALTER TABLE firm_client_tenants ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE firm_client_tenants FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY firm_client_tenants_isolation ON firm_client_tenants
       USING (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid)
       WITH CHECK (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid);`,
  );

  pgm.sql(`ALTER TABLE firm_invitations ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE firm_invitations FORCE ROW LEVEL SECURITY;`);
  // Invitations need two access modes:
  //   (a) a firm member reading the firm's own invitations — keyed on app.firm_id
  //   (b) a prospective invitee presenting a raw token — guarded at the
  //       service layer by looking the token up with a MIGRATION_DATABASE_URL
  //       pool that bypasses RLS. The policy here is deliberately strict
  //       so the ordinary app pool cannot read anyone else's invitations.
  pgm.sql(
    `CREATE POLICY firm_invitations_isolation ON firm_invitations
       USING (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid)
       WITH CHECK (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid);`,
  );
};

exports.down = (pgm) => {
  for (const t of NEW_TABLES) {
    pgm.sql(`DROP POLICY IF EXISTS ${t}_self_isolation ON ${t};`);
    pgm.sql(`DROP POLICY IF EXISTS ${t}_isolation ON ${t};`);
  }
  pgm.dropTable('firm_invitations');
  pgm.dropTable('firm_client_tenants');
  pgm.dropTable('firm_memberships');
  pgm.dropTable('firms');
};
