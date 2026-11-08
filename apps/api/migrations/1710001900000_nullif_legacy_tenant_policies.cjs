/**
 * EP5 Wave 3 prep, tech-debt cleanup.
 *
 * Retrofit of EP2-era RLS policies to the Wave 1 hardening pattern.
 *
 * Context: every EP2 tenant isolation policy cast
 *   current_setting('app.tenant_id', true)::uuid
 * directly. When a pooled connection has previously executed a
 * `SET LOCAL app.tenant_id = ...`, Postgres leaves the GUC as the
 * empty string after commit rather than clearing it, so the next
 * policy evaluation throws
 *   invalid input syntax for type uuid: ""
 * on a routine SELECT. Wave 1 adopted
 *   NULLIF(current_setting('app.tenant_id', true), '')::uuid
 * for all new firm-scoped policies, and W2-B and W2-C worked around
 * the legacy bare cast by parking app.tenant_id on a sentinel uuid
 * (00000000-0000-0000-0000-000000000000) before cross-tenant SELECTs.
 *
 * This migration rewrites every legacy _isolation policy to use the
 * NULLIF form, so the sentinel workaround can be deleted and future
 * cross-tenant reads need no GUC gymnastics.
 *
 * Postgres has no ALTER POLICY ... USING / WITH CHECK, so each policy
 * is dropped and recreated. The down path restores the original bare
 * cast form so the migration is fully reversible, even though the
 * bare form is the shape we want to leave behind.
 */

const POLICIES = [
  // tenancy
  { table: 'tenants', name: 'tenant_self_isolation', column: 'id', withCheck: false },
  { table: 'memberships', name: 'membership_isolation', column: 'tenant_id', withCheck: true },
  // invoicing
  { table: 'parties', name: 'parties_isolation', column: 'tenant_id', withCheck: true },
  { table: 'invoices', name: 'invoices_isolation', column: 'tenant_id', withCheck: true },
  { table: 'invoice_lines', name: 'invoice_lines_isolation', column: 'tenant_id', withCheck: true },
  // signing
  {
    table: 'signed_documents',
    name: 'signed_documents_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  // bookkeeping
  { table: 'accounts', name: 'accounts_isolation', column: 'tenant_id', withCheck: true },
  { table: 'journals', name: 'journals_isolation', column: 'tenant_id', withCheck: true },
  {
    table: 'journal_lines',
    name: 'journal_lines_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  {
    table: 'supplier_bills',
    name: 'supplier_bills_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  { table: 'payments', name: 'payments_isolation', column: 'tenant_id', withCheck: true },
  // pos
  { table: 'products', name: 'products_isolation', column: 'tenant_id', withCheck: true },
  { table: 'pos_sales', name: 'pos_sales_isolation', column: 'tenant_id', withCheck: true },
  {
    table: 'pos_sale_lines',
    name: 'pos_sale_lines_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  {
    table: 'pos_number_sequences',
    name: 'pos_number_sequences_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  // billing
  {
    table: 'subscriptions',
    name: 'subscriptions_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  { table: 'usage_meters', name: 'usage_meters_isolation', column: 'tenant_id', withCheck: true },
  {
    table: 'billing_invoices',
    name: 'billing_invoices_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  // imports
  { table: 'import_jobs', name: 'import_jobs_isolation', column: 'tenant_id', withCheck: true },
  {
    table: 'import_errors',
    name: 'import_errors_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  // clearance
  {
    table: 'clearance_outbox',
    name: 'clearance_outbox_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  {
    table: 'clearance_events',
    name: 'clearance_events_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  {
    table: 'clearance_dlq',
    name: 'clearance_dlq_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
  // archive
  {
    table: 'archive_records',
    name: 'archive_records_isolation',
    column: 'tenant_id',
    withCheck: true,
  },
];

const NEW_CAST = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
const OLD_CAST = `current_setting('app.tenant_id', true)::uuid`;

function createPolicy(p, cast) {
  const using = `USING (${p.column} = ${cast})`;
  const check = p.withCheck ? ` WITH CHECK (${p.column} = ${cast})` : '';
  return `CREATE POLICY ${p.name} ON ${p.table} ${using}${check};`;
}

exports.up = (pgm) => {
  for (const p of POLICIES) {
    pgm.sql(`DROP POLICY IF EXISTS ${p.name} ON ${p.table};`);
    pgm.sql(createPolicy(p, NEW_CAST));
  }
};

exports.down = (pgm) => {
  for (const p of POLICIES) {
    pgm.sql(`DROP POLICY IF EXISTS ${p.name} ON ${p.table};`);
    pgm.sql(createPolicy(p, OLD_CAST));
  }
};
