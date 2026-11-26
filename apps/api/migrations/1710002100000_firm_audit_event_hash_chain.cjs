/**
 * ClearTax §5.7 declared-subcontractor commitment — tamper-evident audit trail.
 *
 * Adds a per-(firm, tenant) SHA-256 hash chain to firm_audit_events. The chain
 * is the artefact ClearTax reads on-demand to prove no audit row was altered
 * or removed after the fact:
 *
 *   event_hash = sha256_hex( (prev_hash ?? '') || '|' || canonical_json(event) )
 *
 * The first event on a (firm, tenant_id) chain carries prev_hash = NULL.
 * Subsequent writes read the current chain head FOR UPDATE inside the insert
 * transaction so two concurrent writes cannot pick the same chain head.
 *
 * OTA rule implemented: Fawtara §5.7 — accredited solution providers must
 * retain a tamper-evident audit trail accessible to the declared PEPPOL
 * access-point on-demand.  Our ClearTax partner pack calls this the
 * "chain-verified audit trail".
 *
 * Deliberately left nullable on both columns:
 *   - prev_hash is NULL for the first row of every chain by design.
 *   - event_hash is nullable for backwards compat with rows that existed
 *     before this migration — verifyChain treats a NULL event_hash as
 *     "unchained" (pre-§5.7 row) and skips it until it meets the first
 *     chained row, which must have prev_hash = NULL. A follow-up
 *     backfill migration (tracked in docs/research/cleartax-audit-chain.md)
 *     will rehash legacy rows; running it inside this migration would
 *     block the deploy on a long-running PL/pgSQL loop against production
 *     firm_audit_events, which we want to avoid.
 *
 * Reversible: `down` drops the new columns and the chain-head index.
 */

exports.up = (pgm) => {
  pgm.addColumns('firm_audit_events', {
    // Hex-encoded sha256 of (prev_hash || '|' || canonical_json(event)).
    // Nullable only for pre-§5.7 backfill (see top comment).
    event_hash: { type: 'text' },
    // Hex-encoded event_hash of the previous row on the same (firm, tenant)
    // chain, or NULL for the first row of each chain.
    prev_hash: { type: 'text' },
  });

  // Chain-head index: the insert path looks up the latest event_hash per
  // (firm_id, tenant_id) in occurred_at DESC order under FOR UPDATE.
  // Tie-break on id so concurrent inserts at the same occurred_at pick a
  // deterministic head.
  pgm.createIndex(
    'firm_audit_events',
    ['firm_id', 'tenant_id', { name: 'occurred_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
    { name: 'firm_audit_events_chain_head_idx' },
  );
};

exports.down = (pgm) => {
  pgm.dropIndex('firm_audit_events', null, {
    name: 'firm_audit_events_chain_head_idx',
    ifExists: true,
  });
  pgm.dropColumns('firm_audit_events', ['event_hash', 'prev_hash']);
};
