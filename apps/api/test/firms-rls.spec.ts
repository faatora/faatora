/**
 * EP5 Wave 1 — RLS enforcement for firm-scoped tables (firms,
 * firm_memberships, firm_client_tenants) and for the invoice/party
 * SELECT branch added in migration 1710001300000_firm_invoice_rls_branch.
 *
 * All queries here run under the non-BYPASSRLS `faatora_app` role (via
 * DATABASE_URL). The admin pool (MIGRATION_DATABASE_URL) is used only
 * for seeding fixtures. If the two URLs point to the same role in a
 * dev setup, the admin-side seeding still works but the app-side
 * assertions remain the authoritative RLS check.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withFirm } from '../src/db/with-firm';
import { withFirmTenant } from '../src/db/with-firm-tenant';
import { withTenant } from '../src/db/with-tenant';
import { firms, firmMemberships, firmClientTenants } from '../src/db/schema/firms';
import { invoices, parties } from '../src/db/schema/invoicing';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

describe('RLS on firm-scoped tables', () => {
  // Two firms, each with their own owner and one client tenant
  const firmAId = randomUUID();
  const firmBId = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const tA = randomUUID();
  const tB = randomUUID();
  const partyA = randomUUID();
  const partyB = randomUUID();
  const invoiceA = randomUUID();
  const invoiceB = randomUUID();

  let admin: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    // Users, tenants, firms, memberships, client links
    await admin.query(
      `INSERT INTO users (id, cognito_sub, email) VALUES
         ($1,$2,$3),($4,$5,$6)`,
      [ownerA, `sub-${ownerA}`, 'ownerA@test', ownerB, `sub-${ownerB}`, 'ownerB@test'],
    );
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'TA'),($2,'TB')`, [tA, tB]);
    await admin.query(
      `INSERT INTO firms (id, name) VALUES ($1,'Firm A'),($2,'Firm B')`,
      [firmAId, firmBId],
    );
    await admin.query(
      `INSERT INTO firm_memberships (firm_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
      [firmAId, ownerA, firmBId, ownerB],
    );
    await admin.query(
      `INSERT INTO firm_client_tenants (firm_id, tenant_id, access_level, engagement_type)
         VALUES ($1,$2,'full','ongoing'),($3,$4,'full','ongoing')`,
      [firmAId, tA, firmBId, tB],
    );
    // One party + one invoice per tenant, for the firm-SELECT-branch tests.
    await admin.query(
      `INSERT INTO parties (id, tenant_id, kind, name) VALUES
         ($1,$2,'customer','A-party'),($3,$4,'customer','B-party')`,
      [partyA, tA, partyB, tB],
    );
    await admin.query(
      `INSERT INTO invoices (id, tenant_id, number, issue_date, supplier_party_id, buyer_party_id, grand_total)
         VALUES ($1,$2,'A-1','2026-01-10',$3,$3,'100.000'),
                ($4,$5,'B-1','2026-01-10',$6,$6,'200.000')`,
      [invoiceA, tA, partyA, invoiceB, tB, partyB],
    );

    appPool = new Pool({ connectionString: APP_URL });
    appDb = drizzle(appPool, { schema });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM invoices WHERE tenant_id IN ($1,$2)`, [tA, tB]);
    await admin.query(`DELETE FROM parties WHERE tenant_id IN ($1,$2)`, [tA, tB]);
    await admin.query(`DELETE FROM firms WHERE id IN ($1,$2)`, [firmAId, firmBId]);
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [tA, tB]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [ownerA, ownerB]);
    await appPool.end();
    await admin.end();
  });

  describe('firm_*_isolation policies', () => {
    it('firm A context sees only firm A row', async () => {
      const rows = await withFirm(appDb, firmAId, (tx) => tx.select().from(firms));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(firmAId);
    });

    it('firm A context cannot see firm B membership', async () => {
      const rows = await withFirm(appDb, firmAId, (tx) =>
        tx.select().from(firmMemberships).where(eq(firmMemberships.firmId, firmBId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('firm A context cannot see firm B client link', async () => {
      const rows = await withFirm(appDb, firmAId, (tx) =>
        tx.select().from(firmClientTenants).where(eq(firmClientTenants.firmId, firmBId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('firm A context cannot INSERT a membership into firm B', async () => {
      await expect(
        withFirm(appDb, firmAId, (tx) =>
          tx
            .insert(firmMemberships)
            .values({ firmId: firmBId, userId: ownerA, role: 'partner' }),
        ),
      ).rejects.toThrow();
    });

    it('firm A context cannot INSERT a client link into firm B', async () => {
      await expect(
        withFirm(appDb, firmAId, (tx) =>
          tx.insert(firmClientTenants).values({
            firmId: firmBId,
            tenantId: tA,
            accessLevel: 'full',
            engagementType: 'ongoing',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('invoice/party firm-SELECT branch', () => {
    it('firm A SELECT sees invoices of its linked tenant', async () => {
      const rows = await withFirm(appDb, firmAId, (tx) => tx.select().from(invoices));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(invoiceA);
      expect(ids).not.toContain(invoiceB);
    });

    it('firm A SELECT sees parties of its linked tenant', async () => {
      const rows = await withFirm(appDb, firmAId, (tx) => tx.select().from(parties));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(partyA);
      expect(ids).not.toContain(partyB);
    });

    it('revoking the client link removes cross-tenant SELECT access', async () => {
      // Revoke
      await admin.query(
        `UPDATE firm_client_tenants SET revoked_at = now() WHERE firm_id=$1 AND tenant_id=$2`,
        [firmAId, tA],
      );
      try {
        const rows = await withFirm(appDb, firmAId, (tx) => tx.select().from(invoices));
        expect(rows.map((r) => r.id)).not.toContain(invoiceA);
      } finally {
        await admin.query(
          `UPDATE firm_client_tenants SET revoked_at = NULL WHERE firm_id=$1 AND tenant_id=$2`,
          [firmAId, tA],
        );
      }
    });

    it('firm A SELECT cannot INSERT into the linked tenant (SELECT-only branch)', async () => {
      // The firm-branch policy is FOR SELECT only. INSERT falls back to the
      // tenant_isolation policy which requires app.tenant_id, which withFirm
      // does NOT set. withFirmTenant is the correct write path.
      await expect(
        withFirm(appDb, firmAId, (tx) =>
          tx.insert(parties).values({ tenantId: tA, kind: 'customer', name: 'blocked' }),
        ),
      ).rejects.toThrow();
    });

    it('no-firm-context callers still see nothing (app.firm_id unset)', async () => {
      // withTenant sets app.tenant_id for tB and leaves app.firm_id unset;
      // the firm branch's `current_setting('app.firm_id', true) <> ''` guard
      // short-circuits and the tenant_isolation branch gates the read to tB.
      const rows = await withTenant(appDb, tB, (tx) => tx.select().from(invoices));
      expect(rows.map((r) => r.id)).toEqual([invoiceB]);
    });
  });

  describe('withFirmTenant', () => {
    it('allows cross-tenant writes once the link is asserted', async () => {
      const newParty = randomUUID();
      await withFirmTenant(appDb, firmAId, tA, async (tx) => {
        await tx.insert(parties).values({
          id: newParty,
          tenantId: tA,
          kind: 'customer',
          name: 'via-withFirmTenant',
        });
      });
      // Confirm the row is readable under tenant A context via withTenant.
      const rows = await withTenant(appDb, tA, (tx) =>
        tx.select().from(parties).where(and(eq(parties.id, newParty), eq(parties.tenantId, tA))),
      );
      expect(rows).toHaveLength(1);
      // Cleanup
      await admin.query(`DELETE FROM parties WHERE id=$1`, [newParty]);
    });

    it('refuses when the firm has no active link for that tenant', async () => {
      await expect(
        withFirmTenant(appDb, firmAId, tB, async (tx) => {
          await tx.select().from(parties).limit(1);
        }),
      ).rejects.toThrow(/Firm has no active engagement/);
    });

    it('refuses when the link is revoked', async () => {
      await admin.query(
        `UPDATE firm_client_tenants SET revoked_at = now() WHERE firm_id=$1 AND tenant_id=$2`,
        [firmAId, tA],
      );
      try {
        await expect(
          withFirmTenant(appDb, firmAId, tA, async () => {
            // body never runs
          }),
        ).rejects.toThrow(/Firm has no active engagement/);
      } finally {
        await admin.query(
          `UPDATE firm_client_tenants SET revoked_at = NULL WHERE firm_id=$1 AND tenant_id=$2`,
          [firmAId, tA],
        );
      }
    });
  });

  describe('raw-query cross-firm isolation', () => {
    it('a raw query with app.firm_id = firm A cannot read firm B rows', async () => {
      // Use a dedicated client from the app pool so set_config sticks across
      // the two queries without a drizzle transaction wrapper.
      const client = await appPool.connect();
      try {
        await client.query(`select set_config('app.firm_id', $1, false)`, [firmAId]);
        const { rows: firmRows } = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM firms`,
        );
        expect(firmRows).toHaveLength(1);
        expect(firmRows[0].id).toBe(firmAId);

        const { rows: linkRows } = await client.query<{ firm_id: string }>(
          `SELECT firm_id FROM firm_client_tenants`,
        );
        expect(linkRows.every((r) => r.firm_id === firmAId)).toBe(true);
        expect(linkRows.find((r) => r.firm_id === firmBId)).toBeUndefined();
      } finally {
        await client.query(`select set_config('app.firm_id', '', false)`);
        client.release();
      }
    });
  });
});
