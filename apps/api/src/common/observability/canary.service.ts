import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DB, type Database } from '../../db/db.module';
import { ALERT_SINK, type AlertSink } from './alert.port';
import { canaryLastSuccessTimestamp } from './metrics';

/**
 * Synthetic end-to-end canary.
 *
 * The canary is the 3-AM-friendly health signal: when it stops ticking,
 * something in the clearance / compliance pipeline is broken even if
 * every request-level metric looks green. We check two layers:
 *
 *   1. DATABASE connectivity — `SELECT 1` against the main app pool.
 *      Catches: pool exhaustion, RLS mis-config, dropped network.
 *
 *   2. COMPLIANCE CORE — if `@faatora/compliance` can be imported in
 *      this process, we build a canonical fixture and run it through
 *      `validateCanonical`. Catches: a bad deploy of the rule pack,
 *      a type-shape drift between apps/api and packages/compliance.
 *
 * On any failure we log a structured error with `canary_name` and emit
 * a `page` alert (the SRE wake-up signal). On success we stamp
 * `faatora_canary_last_success_timestamp` so Prometheus can alert on
 * `time() - faatora_canary_last_success_timestamp > 300`.
 *
 * SCHEDULING. `@nestjs/schedule`'s @Cron fires on a six-field spec; we
 * run every 60 s. An `isRunning` flag drops overlapping ticks so a
 * stuck DB round-trip can't queue a stampede.
 */
@Injectable()
export class CanaryService {
  private readonly log = new Logger('Canary');
  private isRunning = false;
  private complianceSkippedWarned = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ALERT_SINK) private readonly alerts: AlertSink,
  ) {}

  // Six-field cron: seconds field = every 60s. Equivalent to '0 * * * * *'.
  @Cron('*/60 * * * * *')
  async tick(): Promise<void> {
    await this.runOnce();
  }

  /**
   * Public entry so tests (and a hypothetical POST /canary/run) can
   * trigger a pass without waiting on the schedule.
   */
  async runOnce(): Promise<{ ok: true } | { ok: false; failed: string }> {
    if (this.isRunning) return { ok: true };
    this.isRunning = true;
    try {
      const dbOk = await this.checkDatabase();
      if (!dbOk) return { ok: false, failed: 'db' };

      const complianceOk = await this.checkComplianceCore();
      if (!complianceOk) return { ok: false, failed: 'compliance_core' };

      canaryLastSuccessTimestamp.set(Math.floor(Date.now() / 1000));
      return { ok: true };
    } finally {
      this.isRunning = false;
    }
  }

  /** `SELECT 1` against the app pool. Any throw = failure. */
  private async checkDatabase(): Promise<boolean> {
    try {
      await (this.db as unknown as { execute: (q: string) => Promise<unknown> }).execute(
        'SELECT 1',
      );
      return true;
    } catch (err) {
      this.log.error(
        { canary_name: 'db', err: (err as Error).message },
        'canary: database check failed',
      );
      await this.alerts.send({
        severity: 'page',
        title: 'Canary: database SELECT 1 failed',
        details: { canary_name: 'db', error: (err as Error).message },
      });
      return false;
    }
  }

  /**
   * Build a tiny canonical invoice and run it through the compliance
   * core. If the package can't be imported (missing link, test env)
   * we treat that as *skipped*, not failed — logged once at `warn`.
   */
  private async checkComplianceCore(): Promise<boolean> {
    let compliance: {
      validateCanonical: (v: unknown) => { ok: boolean; errors?: unknown };
    };
    try {
      compliance = await import('@faatora/compliance');
    } catch {
      if (!this.complianceSkippedWarned) {
        this.complianceSkippedWarned = true;
        this.log.warn(
          { canary_name: 'compliance_core' },
          '@faatora/compliance not importable in this environment — skipping canary layer',
        );
      }
      return true;
    }

    const fixture = {
      id: 'canary-' + Date.now().toString(16),
      type: 'invoice' as const,
      number: 'CANARY-0001',
      issueDate: new Date().toISOString().slice(0, 10),
      currency: 'OMR',
      supplier: {
        name: 'Faatora Canary Supplier',
        country: 'OM',
        vatin: 'OM1234567890',
      },
      buyer: {
        name: 'Faatora Canary Buyer',
        country: 'OM',
      },
      lines: [
        {
          lineNo: 1,
          description: 'Canary line item',
          quantity: 1,
          unitCode: 'EA',
          unitPrice: 100,
          vatCategory: 'S',
          vatRate: 5,
        },
      ],
    };

    try {
      const res = compliance.validateCanonical(fixture);
      if (!res.ok) {
        this.log.error(
          { canary_name: 'compliance_core', errors: res.errors },
          'canary: compliance core rejected the fixture',
        );
        await this.alerts.send({
          severity: 'page',
          title: 'Canary: compliance core rejected its fixture',
          details: { canary_name: 'compliance_core', errors: res.errors },
        });
        return false;
      }
      return true;
    } catch (err) {
      this.log.error(
        { canary_name: 'compliance_core', err: (err as Error).message },
        'canary: compliance core threw',
      );
      await this.alerts.send({
        severity: 'page',
        title: 'Canary: compliance core threw',
        details: { canary_name: 'compliance_core', error: (err as Error).message },
      });
      return false;
    }
  }
}
