const { Pool } = require('pg');
const URL = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!URL) {
  console.error('Set MIGRATION_DATABASE_URL');
  process.exit(1);
}
const sub = process.env.COGNITO_SUB || process.argv[2];
const email = process.env.USER_EMAIL || process.argv[3] || `${sub}@faatora.local`;
const tenantName = process.env.TENANT_NAME || 'Demo Co';
const role = process.env.ROLE || 'owner';
if (!sub) {
  console.error('Missing COGNITO_SUB');
  process.exit(1);
}
(async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    const { rows: ur } = await pool.query(
      `INSERT INTO users (cognito_sub, email) VALUES ($1,$2) ON CONFLICT (cognito_sub) DO UPDATE SET email=EXCLUDED.email RETURNING id`,
      [sub, email],
    );
    const { rows: ex } = await pool.query(`SELECT id FROM tenants WHERE name=$1 LIMIT 1`, [
      tenantName,
    ]);
    let tenantId = ex[0]?.id;
    if (!tenantId) {
      const { rows: tr } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [
        tenantName,
      ]);
      tenantId = tr[0].id;
    }
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET role=EXCLUDED.role`,
      [tenantId, ur[0].id, role],
    );
    console.log(JSON.stringify({ userId: ur[0].id, tenantId, email, tenantName, role }, null, 2));
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
