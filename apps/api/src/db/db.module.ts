import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadEnv } from '../config/env';

export const DB = 'DB';
export type Database = NodePgDatabase<Record<string, never>>;

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): Database => {
        const env = loadEnv();
        const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
        return drizzle(pool);
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
