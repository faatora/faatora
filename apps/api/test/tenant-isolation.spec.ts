import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../src/db/with-tenant';
import { memberships } from '../src/db/schema/tenancy';
import * as schema from '../src/db/schema';
const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;
describe('RLS tenant isolation', () => {
  const t1 = randomUUID();
  const t2 = randomUUID();
  const u1 = randomUUID();
  const u2 = randomUUID();
  let admin: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'T1'),($2,'T2')`, [t1, t2]);
    await admin.query(`INSERT INTO users (id, cognito_sub, email) VALUES ($1,$2,$3),($4,$5,$6)`, [
      u1,
      `sub-${u1}`,
      'u1@x',
      u2,
      `sub-${u2}`,
      'u2@x',
    ]);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
      [t1, u1, t2, u2],
    );
    appPool = new Pool({ connectionString: APP_URL });
    appDb = drizzle(appPool, { schema });
  });
  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [t1, t2]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [u1, u2]);
    await appPool.end();
    await admin.end();
  });
  it('tenant sees only own rows', async () => {
    const r = await withTenant(appDb, t1, (tx) => tx.select().from(memberships));
    expect(r).toHaveLength(1);
    expect(r[0].tenantId).toBe(t1);
  });
  it('cross-tenant filter returns nothing', async () => {
    const r = await withTenant(appDb, t1, (tx) =>
      tx.select().from(memberships).where(eq(memberships.tenantId, t2)),
    );
    expect(r).toHaveLength(0);
  });
  it('cross-tenant insert blocked', async () => {
    await expect(
      withTenant(appDb, t1, (tx) =>
        tx.insert(memberships).values({ tenantId: t2, userId: u1, role: 'clerk' }),
      ),
    ).rejects.toThrow();
  });
});
