import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CanaryService } from './canary.service';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { LogAlertSink } from './log-alert-sink';
import { ALERT_SINK } from './alert.port';
import { MetricsController } from './metrics.controller';
import { QueueDepthSamplerService } from './queue-depth-sampler.service';

/**
 * Observability wiring.
 *
 * Exports nothing imperative — other modules reach the metrics by
 * importing the handles from `./metrics` directly (that module is a
 * singleton registry so there's no DI benefit to wrapping it). What
 * this module OWNS:
 *
 *   - `/metrics` scrape controller
 *   - `HttpMetricsMiddleware` on every route via `configure()`
 *   - `CanaryService` + `QueueDepthSamplerService` lifecycle (both
 *      self-schedule in onModuleInit)
 *   - the `ALERT_SINK` token → `LogAlertSink` binding (production
 *      swaps this for `WebhookAlertSink`).
 */
@Module({
  controllers: [MetricsController],
  providers: [
    HttpMetricsMiddleware,
    CanaryService,
    QueueDepthSamplerService,
    { provide: ALERT_SINK, useClass: LogAlertSink },
  ],
  exports: [ALERT_SINK],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
