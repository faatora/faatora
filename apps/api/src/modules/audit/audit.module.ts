import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditSubscribers } from './audit.subscribers';
import { AuditController } from './audit.controller';
import { FirmsModule } from '../firms/firms.module';
import { AuthModule } from '../../auth/auth.module';

/**
 * EP5 Wave 2 (W2-E) — firm-scoped audit log.
 *
 * Subscribes to firm-lifecycle events emitted by sibling W2 agents
 * (W2-C client add/revoke, W2-D import commit, W2-E's own firm.created
 * + billing.*). Exposes `AuditService` for programmatic access and a
 * single read endpoint under FirmGuard; the viewer UI lands in Wave 3.
 *
 * Imports FirmsModule so FirmGuard resolves from the shared provider.
 * Imports AuthModule for the ClearTaxPartnerGuard that protects the
 * `GET /partners/cleartax/firms/:firmId/audit` partner read route.
 */
@Module({
  imports: [FirmsModule, AuthModule],
  controllers: [AuditController],
  providers: [AuditService, AuditSubscribers],
  exports: [AuditService],
})
export class AuditModule {}
