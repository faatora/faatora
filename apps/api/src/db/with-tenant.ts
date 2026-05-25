import { sql } from 'drizzle-orm';
import type { Database } from './db.module';

/**
 * Runs `fn` inside a transaction with the Postgres session variable
 * `app.tenant_id` set LOCALLY (transaction-scoped). EP2 adds RLS policies that
 * read current_setting('app.tenant_id'), so this wrapper is what isolates tenants
 * even if a query forgets its WHERE clause. Never run tenant-scoped queries outside it.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
