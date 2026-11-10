/**
 * EP5 Wave 2 (W2-E) — firm-scoped audit log.
 *
 * The accountant persona has a 10-year retention expectation for OTA
 * inspection readiness (see docs/research/firm-console-plan.md and
 * ADR-0003). Every mutating firm-lifecycle event lands here so there is
 * one queryable log of who touched which client's data when, both for
 * internal accountability inside the firm and for inspectors.
 *
 * Shape: narrow fields a controller needs to paginate (firm_id,
 * occurred_at), plus a jsonb `payload` holding whatever the emitter
 * cares to record. Event subscribers in apps/api/src/modules/audit/
 * decide payload shape per event_type; this table only promises the
 * envelope.
 *
 * RLS: FORCE, keyed on app.firm_id with the NULLIF('','') pattern used
 * everywhere else so SET LOCAL empty-string resets do not throw during
 * cross-transaction reuse of the same connection. tenant_id is nullable
 * because firm-level events (firm.created, billing.customer.created)
 * are not tied to a tenant.
 */

exports.up = (pgm) => {
  pgm.createTable('firm_audit_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: { type: 'uuid', notNull: true, references: 'firms', onDelete: 'CASCADE' },
    tenant_id: { type: 'uuid', references: 'tenants', onDelete: 'SET NULL' },
    actor_user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    event_type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true, default: pgm.func(`'{}'::jsonb`) },
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    source: { type: 'text', notNull: true, default: 'system' },
  });

  // Paginated viewer index: list(firmId, {limit, since, eventType}) sorts
  // DESC on occurred_at and filters by firm_id + optional event_type.
  pgm.createIndex('firm_audit_events', ['firm_id', { name: 'occurred_at', sort: 'DESC' }], {
    name: 'firm_audit_events_firm_time_idx',
  });
  pgm.createIndex('firm_audit_events', 'event_type', {
    name: 'firm_audit_events_type_idx',
  });
  // Per-tenant export index: exportForTenant(firmId, tenantId, period) is
  // range-scan on occurred_at under a firm+tenant filter.
  pgm.createIndex(
    'firm_audit_events',
    ['firm_id', 'tenant_id', { name: 'occurred_at', sort: 'DESC' }],
    {
      name: 'firm_audit_events_firm_tenant_time_idx',
      where: 'tenant_id IS NOT NULL',
    },
  );

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON firm_audit_events TO faatora_app;`);

  pgm.sql(`ALTER TABLE firm_audit_events ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE firm_audit_events FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY firm_audit_events_isolation ON firm_audit_events
       USING (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid)
       WITH CHECK (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid);`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS firm_audit_events_isolation ON firm_audit_events;`);
  pgm.dropTable('firm_audit_events');
};
