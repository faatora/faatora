/**
 * EP5 Wave 2 (W2-D) — firm-scoped import tables.
 *
 * `import_column_mappings` persists per-firm overrides of the default
 * mapping between a source file's columns and the canonical
 * ParsedImportRow fields. One row per (firm, source_format); firms
 * can save their customised mapping once and have it applied to every
 * future upload of that format.
 *
 * `import_batches` records each committed import. The row hashes of
 * every committed row are stored so re-uploading the same file
 * de-duplicates on the next preview: duplicates skip the commit and
 * are reported in the preview summary.
 *
 * RLS: both tables are FORCE RLS. import_column_mappings is firm-keyed
 * (app.firm_id); import_batches is tenant-keyed (app.tenant_id, same
 * as the invoices it produced).
 */

exports.up = (pgm) => {
  // -------- import_column_mappings --------
  pgm.createTable('import_column_mappings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: { type: 'uuid', notNull: true, references: 'firms', onDelete: 'CASCADE' },
    source_format: { type: 'text', notNull: true },
    mapping_json: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('import_column_mappings', 'import_column_mappings_source_format_check', {
    check:
      "source_format IN ('tally_daybook_csv','tally_sales_register_csv','tally_xml','zoho_books_csv')",
  });
  pgm.createIndex('import_column_mappings', ['firm_id', 'source_format'], {
    name: 'import_column_mappings_firm_format_idx',
  });
  pgm.sql(
    `CREATE UNIQUE INDEX import_column_mappings_firm_format_uniq
       ON import_column_mappings (firm_id, source_format);`,
  );

  // -------- import_batches --------
  pgm.createTable('import_batches', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: { type: 'uuid', notNull: true, references: 'firms', onDelete: 'CASCADE' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    source_format: { type: 'text', notNull: true },
    filename: { type: 'text' },
    row_count_total: { type: 'integer', notNull: true, default: 0 },
    row_count_committed: { type: 'integer', notNull: true, default: 0 },
    row_count_skipped: { type: 'integer', notNull: true, default: 0 },
    row_count_errored: { type: 'integer', notNull: true, default: 0 },
    row_hashes: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
    created_by: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('import_batches', ['tenant_id', 'created_at'], {
    name: 'import_batches_tenant_created_idx',
  });
  pgm.createIndex('import_batches', 'firm_id', { name: 'import_batches_firm_idx' });

  // -------- grants --------
  pgm.sql(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON import_column_mappings, import_batches TO faatora_app;`,
  );

  // -------- RLS on import_column_mappings (firm-keyed) --------
  pgm.sql(`ALTER TABLE import_column_mappings ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE import_column_mappings FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY import_column_mappings_firm_isolation ON import_column_mappings
       USING (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid)
       WITH CHECK (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid);`,
  );

  // -------- RLS on import_batches (tenant-keyed, with firm cross-select branch) --------
  //
  // Writes go through withFirmTenant, so app.tenant_id is set — the
  // tenant branch of the policy handles them. SELECTs from a firm
  // context (dashboard listings) also need to see every batch for any
  // linked client tenant, so a second USING branch keyed on app.firm_id
  // lets firm users read batches of their client tenants.
  pgm.sql(`ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY import_batches_tenant_isolation ON import_batches
       USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
       WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);`,
  );
  pgm.sql(
    `CREATE POLICY import_batches_firm_select ON import_batches
       FOR SELECT
       USING (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid);`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS import_batches_firm_select ON import_batches;`);
  pgm.sql(`DROP POLICY IF EXISTS import_batches_tenant_isolation ON import_batches;`);
  pgm.sql(`DROP POLICY IF EXISTS import_column_mappings_firm_isolation ON import_column_mappings;`);
  pgm.dropTable('import_batches');
  pgm.dropTable('import_column_mappings');
};
