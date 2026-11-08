/**
 * EP5 Wave 1 — ADR-0003 option (a): extend existing tenant-scoped RLS on
 * parties / invoices / invoice_lines with a SELECT-only policy branch that
 * permits reads when `app.firm_id` is set AND the row's tenant is actively
 * linked to that firm via firm_client_tenants.
 *
 * Why FOR SELECT only
 * -------------------
 * Wave 1 explicitly defers cross-tenant writes. A firm user who needs to
 * post to a specific client tenant MUST switch into that tenant's context
 * via withFirmTenant (which SETs both app.firm_id and app.tenant_id after
 * asserting the link), at which point the existing tenant policy covers
 * the write. The new policy is additive via PostgreSQL's OR of PERMISSIVE
 * policies — a non-firm caller (app.firm_id unset) is unaffected because
 * `current_setting('app.firm_id', true)::uuid` is NULL and the USING
 * expression short-circuits to false.
 *
 * Defense in depth: the subquery over firm_client_tenants is itself under
 * RLS (also FORCE), so even if the outer policy were somehow bypassed, a
 * caller without the matching app.firm_id would see an empty link set.
 */

const TABLES = ['parties', 'invoices', 'invoice_lines'];

exports.up = (pgm) => {
  for (const tbl of TABLES) {
    pgm.sql(
      `CREATE POLICY ${tbl}_firm_read ON ${tbl}
         FOR SELECT
         USING (
           tenant_id IN (
             SELECT tenant_id FROM firm_client_tenants
             WHERE firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid
               AND revoked_at IS NULL
           )
         );`,
    );
  }
};

exports.down = (pgm) => {
  for (const tbl of TABLES) {
    pgm.sql(`DROP POLICY IF EXISTS ${tbl}_firm_read ON ${tbl};`);
  }
};
