import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './auth/auth.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { LeadsModule } from './modules/leads/leads.module';
import { SigningModule } from './modules/signing/signing.module';
import { ImportsModule } from './modules/imports/imports.module';
import { BookkeepingModule } from './modules/bookkeeping/bookkeeping.module';
import { PosModule } from './modules/pos/pos.module';
import { AccountantModule } from './modules/accountant/accountant.module';
import { BillingModule } from './modules/billing/billing.module';
import { FirmBillingModule } from './modules/billing/firm/billing.module';
import { FirmsModule } from './modules/firms/firms.module';
import { ArchiveModule } from './modules/archive/archive.module';
import { ClearanceModule } from './modules/clearance/clearance.module';
import { AuditModule } from './modules/audit/audit.module';
import { TaxDocumentsModule } from './modules/tax-documents/tax-documents.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { AlertsModule } from './modules/alerts/alerts.module';
@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    // EP5 Wave 2 — EventEmitter routes firm.* + billing.* lifecycle events
    // to AuditModule's subscribers and to FirmBillingService.onFirmCreated.
    // wildcard=true enables the `firm.*` style matcher some future
    // subscribers may use; `verboseMemoryLeak` surfaces common misuse
    // (e.g. missing `await`) as a dev warning instead of a silent OOM.
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),
    ObservabilityModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const incoming = req.headers['x-correlation-id'];
          const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
          res.setHeader('x-correlation-id', id);
          return id;
        },
        customProps: (req: IncomingMessage) => ({
          tenantId: (req as IncomingMessage & { tenantId?: string }).tenantId ?? null,
        }),
        redact: ['req.headers.authorization'],
      },
    }),
    DbModule,
    HealthModule,
    AuthModule,
    InvoicesModule,
    LeadsModule,
    SigningModule,
    BookkeepingModule,
    PosModule,
    AccountantModule,
    BillingModule,
    FirmBillingModule,
    FirmsModule,
    ImportsModule,
    ArchiveModule,
    ClearanceModule,
    AuditModule,
    TaxDocumentsModule,
  ],
})
export class AppModule {}
