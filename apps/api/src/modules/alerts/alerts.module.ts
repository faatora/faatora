import { Module } from '@nestjs/common';
import { PagerDutyController } from './pagerduty.controller';
import { PagerDutyService } from '../../common/alerts/pagerduty.service';

/**
 * AlertsModule — inbound + outbound PagerDuty wiring.
 *
 * - `PagerDutyController` receives V3 webhook deliveries at
 *   POST /api/webhooks/pagerduty.
 * - `PagerDutyService` is the Events API v2 client; exported so
 *   other modules (incident reporters, canary alerter) can inject it
 *   and fire alerts outbound.
 *
 * Both halves are built so Ahmed can pick which direction he actually
 * uses post-deploy. Neither throws on boot when the matching env var
 * is unset — the controller 503s on first request, and the client is
 * a no-op.
 */
@Module({
  controllers: [PagerDutyController],
  providers: [PagerDutyService],
  exports: [PagerDutyService],
})
export class AlertsModule {}
