import { Module } from '@nestjs/common';
import { PagerDutyController } from './pagerduty.controller';
import { PagerDutyService } from '../../common/alerts/pagerduty.service';
import { PlatformStatusService } from './platform-status.service';

/**
 * AlertsModule — inbound + outbound PagerDuty wiring.
 *
 * - `PagerDutyController` receives V3 webhook deliveries at
 *   POST /api/webhooks/pagerduty and hands each verified event to
 *   `PlatformStatusService`.
 * - `PlatformStatusService` projects those events into the
 *   `platform_status_events` table (feeding the public status page)
 *   and fans them out on EventEmitter2 under `platform.status.event`
 *   so per-tenant status-board subscribers can react.
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
  providers: [PagerDutyService, PlatformStatusService],
  exports: [PagerDutyService, PlatformStatusService],
})
export class AlertsModule {}
