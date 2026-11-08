exports.up = (pgm) => {
  pgm.createTable('import_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    source: { type: 'text', notNull: true },
    original_filename: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'pending' },
    total_rows: { type: 'integer', notNull: true, default: 0 },
    imported_rows: { type: 'integer', notNull: true, default: 0 },
    error_rows: { type: 'integer', notNull: true, default: 0 },
    started_at: { type: 'timestamptz' },
    finished_at: { type: 'timestamptz' },
    created_by: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('import_jobs', 'import_jobs_source_check', {
    check: "source IN ('csv','excel','tally_xml')",
  });
  pgm.addConstraint('import_jobs', 'import_jobs_status_check', {
    check: "status IN ('pending','processing','completed','failed')",
  });
  pgm.createIndex('import_jobs', ['tenant_id', 'created_at'], {
    name: 'import_jobs_tenant_created_idx',
  });

  pgm.createTable('import_errors', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    job_id: { type: 'uuid', notNull: true, references: 'import_jobs', onDelete: 'CASCADE' },
    row_no: { type: 'integer', notNull: true },
    column_name: { type: 'text' },
    raw_value: { type: 'text' },
    message: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('import_errors', 'job_id', { name: 'import_errors_job_idx' });

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON import_jobs TO faatora_app;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON import_errors TO faatora_app;`);
  for (const tbl of ['import_jobs', 'import_errors']) {
    pgm.sql(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(
      `CREATE POLICY ${tbl}_isolation ON ${tbl} USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
    );
  }
};
exports.down = (pgm) => {
  pgm.dropTable('import_errors');
  pgm.dropTable('import_jobs');
};
