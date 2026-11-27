/**
 * EP5 — Accountant impersonation audit table.
 *
 * Backing store for the "act as this client" flow (POST /firms/:id/
 * clients/:tenantId/act-as). Every started session writes one row;
 * TenantGuard then verifies the session on every subsequent request that
 * carries `X-Impersonate-Tenant-Id`.
 *
 * Why a dedicated table rather than reusing firm_audit_events:
 *   1. TenantGuard reads this on EVERY impersonated request — it is on
 *      the hot path and needs its own narrow indexes keyed on the
 *      (firm, client_tenant) active-row lookup.
 *   2. The session itself has lifecycle state (ended_at / end_reason)
 *      that firm_audit_events deliberately does not carry; firm_audit_
 *      events is append-only and immutable.
 *   3. firm_audit_events keeps its ClearTax §5.7 hash chain intact; a
 *      write that also mutates an older row would break the chain.
 *
 * A high-level "impersonation started" event IS still appended to
 * firm_audit_events by the AuditSubscribers (via EventEmitter2), so the
 * ClearTax tamper-evident chain still covers who impersonated whom and
 * when — this table is the operational store, not the audit log.
 *
 * RLS: FORCE, keyed on app.firm_id with the NULLIF('','') pattern used
 * by firm_audit_events (migration 1710001600000) so SET LOCAL empty-
 * string resets do not throw during cross-transaction reuse of the same
 * connection. SELECT is firm-scoped — firms see only their own sessions.
 * INSERT/UPDATE/DELETE flow through the app role with an active
 * app.firm_id set; TenantGuard's read uses the RLS-bypass pool so it
 * can resolve sessions before the caller has set a firm context.
 */

exports.up = (pgm) => {
  pgm.createTable('firm_impersonation_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firm_id: { type: 'uuid', notNull: true, references: 'firms', onDelete: 'CASCADE' },
    client_tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    ended_at: { type: 'timestamptz' },
    // One of 'expired' | 'user_exited' | 'revoked'. NULL while still active.
    // Not enforced with a CHECK so follow-up reasons (e.g. 'firm_revoked')
    // can be added without a migration in the critical path.
    end_reason: { type: 'text' },
    user_agent: { type: 'text' },
    ip: { type: 'text' },
  });

  // Firm viewer: "list all impersonations this firm has done, newest first".
  pgm.createIndex('firm_impersonation_events', ['firm_id', { name: 'started_at', sort: 'DESC' }], {
    name: 'firm_impersonation_events_firm_idx',
  });
  // Tenant viewer: "list all impersonations this tenant has been under,
  // newest first" — used by the per-tenant audit export.
  pgm.createIndex(
    'firm_impersonation_events',
    ['client_tenant_id', { name: 'started_at', sort: 'DESC' }],
    { name: 'firm_impersonation_events_tenant_idx' },
  );
  // Hot-path: TenantGuard's active-session lookup. Partial so the index
  // is tiny (only active sessions) and the EXISTS check is a single
  // lookup instead of a scan. ended_at IS NULL is the predicate because
  // expiry is validated in the app layer (so an expired-but-not-yet-
  // ended row still matches the index and the guard rejects it on
  // expires_at check).
  pgm.createIndex('firm_impersonation_events', ['firm_id', 'client_tenant_id'], {
    name: 'firm_impersonation_events_active_idx',
    where: 'ended_at IS NULL',
  });

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON firm_impersonation_events TO faatora_app;`);

  pgm.sql(`ALTER TABLE firm_impersonation_events ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE firm_impersonation_events FORCE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY firm_impersonation_events_isolation ON firm_impersonation_events
       USING (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid)
       WITH CHECK (firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid);`,
  );
};

exports.down = (pgm) => {
  pgm.sql(
    `DROP POLICY IF EXISTS firm_impersonation_events_isolation ON firm_impersonation_events;`,
  );
  pgm.dropTable('firm_impersonation_events');
};
