import { and, eq, isNull, sql } from 'drizzle-orm';
import { ForbiddenException } from '@nestjs/common';
import type { Database } from './db.module';
import { firmClientTenants } from './schema/firms';

/**
 * Transaction wrapper that scopes a handler to the intersection of a firm
 * and one of its client tenants. It:
 *
 *   1. Sets `app.firm_id` so firm-scoped RLS lets us read firm_client_tenants.
 *   2. Verifies an ACTIVE firm_client_tenants row links (firmId, tenantId).
 *      If not, raises ForbiddenException before any other work.
 *   3. Sets `app.tenant_id` so all subsequent reads/writes inside the
 *      transaction are RLS-scoped to that specific tenant — the normal
 *      invoice / party / line policies now apply exactly as if a tenant
 *      user had logged in.
 *
 * This is the "write-safe" cross-tenant path. The firm RLS branch on
 * invoices/parties/invoice_lines is SELECT-only; cross-tenant mutations
 * MUST go through withFirmTenant so the standard tenant policy's
 * WITH CHECK clause gates the write.
 */
export async function withFirmTenant<T>(
  db: Database,
  firmId: string,
  tenantId: string,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.firm_id', ${firmId}, true)`);
    const link = await tx
      .select({ id: firmClientTenants.id })
      .from(firmClientTenants)
      .where(
        and(
          eq(firmClientTenants.firmId, firmId),
          eq(firmClientTenants.tenantId, tenantId),
          isNull(firmClientTenants.revokedAt),
        ),
      )
      .limit(1);
    if (!link[0]) {
      throw new ForbiddenException('Firm has no active engagement with this tenant');
    }
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
