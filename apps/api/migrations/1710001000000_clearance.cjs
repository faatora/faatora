/**
 * Clearance gateway migration (A14).
 *
 * Four tables implementing the tier-0 transmission path to the OTA via an
 * accredited ASP, plus two columns on invoices for the ASP + OTA references.
 *
 *   clearance_outbox  — transactional outbox (write once, drain many).
 *   clearance_events  — append-only state-machine audit trail.
 *   clearance_dlq     — dead-letter queue for terminally failed submissions.
 *   invoices          — ADD asp_reference / ota_reference.
 *
 * Every tenant-scoped table has FORCE ROW LEVEL SECURITY with a USING+WITH CHECK
 * policy on tenant_id, consistent with the rest of the schema (A3/A5 convention).
 */
exports.up = (pgm) => {
  // --- clearance_outbox -----------------------------------------------------
  pgm.createTable('clearance_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'CASCADE' },
    idempotency_key: { type: 'text', notNull: true, unique: true },
    payload_sha256: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'queued' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('clearance_outbox', 'clearance_outbox_status_check', {
    check: "status IN ('queued','in_flight','delivered','dead')",
  });
  pgm.createIndex('clearance_outbox', ['tenant_id', 'status', 'next_attempt_at'], {
    name: 'clearance_outbox_tenant_status_next_idx',
  });
  // Separate drain index for the system-level sweep (no tenant filter).
  pgm.createIndex('clearance_outbox', ['status', 'next_attempt_at'], {
    name: 'clearance_outbox_status_next_idx',
  });

  // --- clearance_events -----------------------------------------------------
  pgm.createTable('clearance_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'CASCADE' },
    from_state: { type: 'text', notNull: true },
    to_state: { type: 'text', notNull: true },
    actor: { type: 'text', notNull: true },
    asp_reference: { type: 'text' },
    ota_reference: { type: 'text' },
    raw_response: { type: 'jsonb' },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('clearance_events', 'clearance_events_actor_check', {
    check: "actor IN ('system','user','asp_callback')",
  });
  pgm.createIndex('clearance_events', ['tenant_id', 'invoice_id', 'at'], {
    name: 'clearance_events_tenant_invoice_at_idx',
  });

  // --- clearance_dlq --------------------------------------------------------
  pgm.createTable('clearance_dlq', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'CASCADE' },
    outbox_id: { type: 'uuid' },
    error: { type: 'text', notNull: true },
    attempts: { type: 'integer', notNull: true },
    sent_payload: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('clearance_dlq', ['tenant_id', 'created_at'], {
    name: 'clearance_dlq_tenant_created_idx',
  });

  // --- invoices extension ---------------------------------------------------
  pgm.addColumns('invoices', {
    asp_reference: { type: 'text' },
    ota_reference: { type: 'text' },
  });

  // --- Grants + RLS ---------------------------------------------------------
  // The drain's cross-tenant SELECT runs against this role too (see
  // ClearanceGatewayService.drainOnce) but only reads the (tenant_id, id)
  // tuple of each queued row — never a RLS-protected column — so the
  // service bypasses RLS by using the migration superuser connection for
  // that one query. Everything else is strictly tenant-scoped.
  for (const tbl of ['clearance_outbox', 'clearance_events', 'clearance_dlq']) {
    pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tbl} TO fawtara_app;`);
    pgm.sql(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(
      `CREATE POLICY ${tbl}_isolation ON ${tbl} USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
    );
  }
};

exports.down = (pgm) => {
  pgm.dropColumns('invoices', ['asp_reference', 'ota_reference']);
  pgm.dropTable('clearance_dlq');
  pgm.dropTable('clearance_events');
  pgm.dropTable('clearance_outbox');
};
