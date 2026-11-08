import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClearanceGatewayService } from './clearance-gateway.service';

/**
 * Fires drainOnce every 10 seconds. The isRunning guard means an unusually
 * slow drain (e.g. an ASP that takes >10s per submit) can't trip two cron
 * fires over the same rows — the second tick just no-ops until the first
 * returns.
 *
 * The cron can be disabled in tests (and short-lived scripts) by setting
 * DISABLE_CLEARANCE_CRON=1 so unit specs can call drainOnce() directly
 * without race-conditions against a background job.
 */
@Injectable()
export class ClearanceScheduler {
  private readonly log = new Logger(ClearanceScheduler.name);
  private isRunning = false;

  constructor(private readonly gateway: ClearanceGatewayService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async drain(): Promise<void> {
    if (process.env.DISABLE_CLEARANCE_CRON === '1') return;
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const report = await this.gateway.drainOnce(50);
      if (report.processed > 0 || report.shortCircuited > 0) {
        this.log.log(
          `drain: processed=${report.processed} cleared=${report.cleared} rejected=${report.rejected} pending=${report.pending} retried=${report.retried} dlq=${report.deadLettered} short=${report.shortCircuited}`,
        );
      }
    } catch (err) {
      this.log.error(`drain crashed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
