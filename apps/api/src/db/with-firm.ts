import { sql } from 'drizzle-orm';
import type { Database } from './db.module';

/**
 * Transaction wrapper that sets `app.firm_id` for the duration of the
 * transaction (SET LOCAL). The companion of withTenant: used wherever a
 * handler is operating on firm-scoped tables (firms, firm_memberships,
 * firm_client_tenants, firm_invitations) or wants to issue a cross-tenant
 * SELECT against invoice/party/line data under the ADR-0003 firm RLS
 * branch.
 *
 * The passed firmId is NOT independently authorized here — authorization
 * is the FirmGuard's job. This helper only arranges the RLS context.
 */
export async function withFirm<T>(
  db: Database,
  firmId: string,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.firm_id', ${firmId}, true)`);
    return fn(tx);
  });
}
