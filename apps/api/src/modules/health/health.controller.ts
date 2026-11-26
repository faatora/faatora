import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckError,
  HealthCheckService,
  HealthIndicator,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { DB, type Database } from '../../db/db.module';

/**
 * Database liveness indicator.
 *
 * Executes a `SELECT 1` against the main application pool. This is the
 * same shape the canary uses (see
 * `common/observability/canary.service.ts:73-91`), kept intentionally
 * identical so a flake here and a canary page have a single explanation:
 * the app lost its Postgres pool.
 *
 * Why inline (not a shared base class): drizzle's `execute` signature
 * differs from the drivers Terminus ships adapters for (pg/typeorm/
 * sequelize/prisma), so the stock `TypeOrmHealthIndicator` does not fit.
 * We also do NOT want to pull in `@nestjs/typeorm` as a dependency just
 * to borrow a ping function — the repo is drizzle-only by design.
 *
 * Failure behaviour: throw `HealthCheckError` with `up: false` payload.
 * `HealthCheckService` catches this, turns the `/health` response into
 * a `503 Service Unavailable`, and the ALB target group marks the task
 * unhealthy within its 2-fail window (see
 * `infra/terraform/modules/alb/health.tf`). That is the signal ECS uses
 * to drain and replace the task.
 */
class DatabaseHealthIndicator extends HealthIndicator {
  constructor(private readonly db: Database) {
    super();
  }

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    try {
      // drizzle's NodePgDatabase#execute accepts a string or SQL template.
      // Cast mirrors `canary.service.ts` — kept as `unknown` because the
      // overload surface changes between drizzle minors and we only care
      // that the round-trip succeeded.
      await (this.db as unknown as { execute: (q: string) => Promise<unknown> }).execute(
        'SELECT 1',
      );
      return this.getStatus(key, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HealthCheckError('Database ping failed', this.getStatus(key, false, { message }));
    }
  }
}

/**
 * Liveness + readiness endpoint, consumed by:
 *   - the ECS ALB target-group health check (path `/api/health`)
 *   - the uptime canary that polls from outside the VPC
 *   - developers during local bring-up
 *
 * The check was previously `this.health.check([])`, which always
 * returned `{ status: 'ok' }` regardless of pool state. A hung or
 * dropped database connection therefore left tasks in service and
 * burned error budget until the real-request error rate alarmed. The
 * real DB ping below propagates DB outages to the ALB in seconds.
 */
@Controller('health')
export class HealthController {
  private readonly dbIndicator: DatabaseHealthIndicator;

  constructor(
    private readonly health: HealthCheckService,
    @Inject(DB) db: Database,
  ) {
    this.dbIndicator = new DatabaseHealthIndicator(db);
  }

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.dbIndicator.pingCheck('database')]);
  }
}
