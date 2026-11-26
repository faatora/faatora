import { Global, Module } from '@nestjs/common';
import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadEnv } from '../config/env';
import * as schema from './schema';
export const DB = 'DB';
export type Database = NodePgDatabase<typeof schema>;

/**
 * Decide whether an outbound pg.Pool should negotiate TLS.
 *
 * RDS enforces TLS via `pg_hba.conf` (rejects connections with
 * "no encryption"). The `pg` driver does NOT parse `?sslmode=require`
 * from a connection string, so we have to set `ssl` on the config object
 * ourselves. On 2026-11-26 this was the final gate between a booting
 * container and a green `/api/health`: NestFactory.create() was returning,
 * the server bound :3000, the ALB target was healthy for routing — every
 * request hit a DB check that failed with pg_hba.conf.
 *
 * Policy:
 *   - production / staging: SSL on. `rejectUnauthorized: false` because
 *     RDS presents a certificate signed by the AWS RDS CA, which Node's
 *     default trust store does not include. Operators who want full chain
 *     validation can set `PGSSLROOTCERT` and extend this helper to load
 *     it — out of scope for this fix.
 *   - dev / test: SSL off (local Postgres in docker-compose doesn't
 *     expose TLS).
 *
 * Env override: `DATABASE_SSL=require|disable` forces one of the two
 * paths independent of NODE_ENV.
 *
 * IMPORTANT: every non-DbModule pg.Pool in this service (the firms
 * bypass pool, the clearance sweep pool, the queue-depth sampler pool)
 * MUST route through this helper too. Otherwise the main app health
 * check passes but the auxiliary pools throw "no encryption" on their
 * first query (observed as `ClearanceScheduler drain crashed: ...` in
 * the pino stream, PR #23 story).
 */
export function pgSslFor(nodeEnv: string): PoolConfig['ssl'] {
  const override = process.env.DATABASE_SSL;
  let useSsl: boolean;
  if (override === 'require') {
    useSsl = true;
  } else if (override === 'disable') {
    useSsl = false;
  } else {
    useSsl = nodeEnv === 'production';
  }
  return useSsl ? { rejectUnauthorized: false } : false;
}

/** DbModule's own pool config, the one the main app DB uses. */
export function buildPoolConfig(env: ReturnType<typeof loadEnv>): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: 10,
    ssl: pgSslFor(env.NODE_ENV),
  };
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): Database => {
        const env = loadEnv();
        const pool = new Pool(buildPoolConfig(env));
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
