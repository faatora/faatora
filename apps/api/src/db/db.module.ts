import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadEnv } from '../config/env';
import * as schema from './schema';
export const DB = 'DB';
export type Database = NodePgDatabase<typeof schema>;
@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): Database => {
        const env = loadEnv();
        const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
