import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const incoming = req.headers['x-correlation-id'];
          const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
          res.setHeader('x-correlation-id', id);
          return id;
        },
        // tenantId is attached by the tenant guard in EP2.
        customProps: (req: IncomingMessage) => ({
          tenantId: (req as IncomingMessage & { tenantId?: string }).tenantId ?? null,
        }),
        redact: ['req.headers.authorization'],
      },
    }),
    DbModule,
    HealthModule,
  ],
})
export class AppModule {}
