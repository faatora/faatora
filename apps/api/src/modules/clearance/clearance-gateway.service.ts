import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { loadEnv } from '../../config/env';
import { invoices } from '../../db/schema/invoicing';
import { signedDocuments } from '../../db/schema/signing';
import { clearanceDlq, clearanceEvents, clearanceOutbox } from '../../db/schema/clearance';
import { ArchiveService } from '../archive/archive.service';
import {
  TRANSMISSION_PROVIDER,
  type TransmissionCallback,
  type TransmissionProvider,
  type TransmissionSubmission,
} from './transmission-provider.port';
import { TransmissionCircuitBreaker } from './circuit-breaker';
import { assertCanTransition, type ClearanceActor, type InvoiceState } from './state-machine';
import { ClearanceCallbackSink } from './stub-asp';

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export interface EnqueueResult {
  outboxId: string;
  reused: boolean;
}

export interface DrainReport {
  processed: number;
  cleared: number;
  rejected: number;
  pending: number;
  retried: number;
  deadLettered: number;
  shortCircuited: number;
  breaker: ReturnType<TransmissionCircuitBreaker['snapshot']>;
}

/**
 * The clearance gateway: enqueues signed invoices for transmission to the
 * OTA via an accredited ASP, drains the outbox with retry + backoff + DLQ +
 * circuit-breaker, and handles asynchronous OTA callbacks.
 *
 * Design notes on the drain's cross-tenant sweep:
 *   drainOnce() needs to see queued rows across all tenants. The application
 *   DB role (fawtara_app) is subject to RLS and cannot read any row without
 *   app.tenant_id being set. Rather than loop over every tenant (expensive
 *   at scale and racy), we open a short-lived pg Pool using
 *   MIGRATION_DATABASE_URL — the superuser connection the migrations run
 *   under, which bypasses RLS — and SELECT only (id, tenant_id) of candidate
 *   rows. Each row is then processed under its own tenant context via the
 *   normal withTenant() path, so every INSERT/UPDATE still goes through
 *   RLS. If MIGRATION_DATABASE_URL is not configured, the sweep falls back
 *   to the main pool (useful when running against a DB where the app role
 *   is already BYPASSRLS'd — e.g. a single-tenant dev setup).
 */
@Injectable()
export class ClearanceGatewayService implements ClearanceCallbackSink {
  private readonly log = new Logger(ClearanceGatewayService.name);
  private sweepPool: Pool | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(TRANSMISSION_PROVIDER) private readonly provider: TransmissionProvider,
    private readonly breaker: TransmissionCircuitBreaker,
    // Archive hook — fired AFTER a successful CLEARED tx commits. Optional so
    // the gateway can still be constructed in unit tests that don't want to
    // run the archive step; production wiring always provides it (B1 fix).
    @Optional() private readonly archive: ArchiveService | null = null,
  ) {}

  // ---------------------------------------------------------------------
  // ENQUEUE
  // ---------------------------------------------------------------------

  /**
   * Transactional outbox write: in a single tx we flip the invoice to
   * SUBMITTED, journal the state change, and insert the outbox row. The
   * invoice's document_uuid is the idempotency key — calling enqueue()
   * twice yields the same outbox row.
   */
  async enqueue(tenantId: string, invoiceId: string): Promise<EnqueueResult> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
      if (!invoice) throw new NotFoundException('Invoice not found');

      // Idempotent re-entry: if the invoice is already SUBMITTED (or further),
      // return the existing outbox row rather than erroring out — the caller
      // may have retried after a network blip between HTTP and DB.
      if (invoice.status !== 'SIGNED' && invoice.status !== 'SUBMITTED') {
        throw new BadRequestException(
          `Only SIGNED invoices can be submitted (status=${invoice.status})`,
        );
      }

      const [signedDoc] = await tx
        .select()
        .from(signedDocuments)
        .where(eq(signedDocuments.invoiceId, invoiceId))
        .limit(1);
      if (!signedDoc) {
        throw new BadRequestException('Invoice has no signed_documents row');
      }

      const idempotencyKey = signedDoc.documentUuid;

      // Idempotent insert via the UNIQUE(idempotency_key) constraint:
      // ON CONFLICT DO NOTHING + a follow-up select is race-safe and avoids
      // the "do you already exist?" lookup becoming the source of truth.
      const inserted = await tx
        .insert(clearanceOutbox)
        .values({
          tenantId,
          invoiceId,
          idempotencyKey,
          payloadSha256: signedDoc.sha256,
          status: 'queued',
        })
        .onConflictDoNothing({ target: clearanceOutbox.idempotencyKey })
        .returning({ id: clearanceOutbox.id });

      if (inserted.length === 0) {
        const [existing] = await tx
          .select({ id: clearanceOutbox.id })
          .from(clearanceOutbox)
          .where(eq(clearanceOutbox.idempotencyKey, idempotencyKey))
          .limit(1);
        if (!existing) {
          // Should be impossible: ON CONFLICT fired but no row is visible.
          throw new BadRequestException('Outbox row vanished mid-insert');
        }
        return { outboxId: existing.id, reused: true };
      }

      // First-time enqueue: journal the SIGNED -> SUBMITTED transition and
      // bump the invoice state. We only run this half of the write when the
      // insert produced a brand-new row, otherwise we'd re-emit a duplicate
      // event every time a caller retried the endpoint.
      if (invoice.status === 'SIGNED') {
        this.assertStateTransition(invoice.status, 'SUBMITTED', 'system');
        await tx.insert(clearanceEvents).values({
          tenantId,
          invoiceId,
          fromState: 'SIGNED',
          toState: 'SUBMITTED',
          actor: 'system',
        });
        await tx
          .update(invoices)
          .set({ status: 'SUBMITTED', updatedAt: new Date() })
          .where(eq(invoices.id, invoiceId));
      }

      return { outboxId: inserted[0].id, reused: false };
    });
  }

  // ---------------------------------------------------------------------
  // DRAIN
  // ---------------------------------------------------------------------

  async drainOnce(limit = 25): Promise<DrainReport> {
    const report: DrainReport = {
      processed: 0,
      cleared: 0,
      rejected: 0,
      pending: 0,
      retried: 0,
      deadLettered: 0,
      shortCircuited: 0,
      breaker: this.breaker.snapshot(),
    };

    // Cross-tenant sweep: superuser pool (RLS bypassed) returns just
    // (id, tenant_id) tuples. Everything after this runs under withTenant.
    const candidates = await this.sweepCandidates(limit);
    if (candidates.length === 0) {
      report.breaker = this.breaker.snapshot();
      return report;
    }

    for (const { id: outboxId, tenant_id: tenantId } of candidates) {
      if (this.breaker.isOpen()) {
        // Short-circuit: push next_attempt_at out so we don't re-select this
        // row on every tick while the breaker cools down. Status stays queued.
        await withTenant(this.db, tenantId, async (tx) => {
          await tx
            .update(clearanceOutbox)
            .set({
              nextAttemptAt: new Date(Date.now() + 10_000),
              updatedAt: new Date(),
            })
            .where(eq(clearanceOutbox.id, outboxId));
        });
        report.shortCircuited += 1;
        continue;
      }

      try {
        const outcome = await this.processOne(tenantId, outboxId);
        report.processed += 1;
        if (outcome === 'cleared') report.cleared += 1;
        else if (outcome === 'rejected') report.rejected += 1;
        else if (outcome === 'pending') report.pending += 1;
        else if (outcome === 'retry') report.retried += 1;
        else if (outcome === 'dead') report.deadLettered += 1;
      } catch (err) {
        this.log.error(
          `drainOnce: processOne crashed for outbox=${outboxId}: ${(err as Error).message}`,
        );
      }
    }

    report.breaker = this.breaker.snapshot();
    return report;
  }

  /**
   * Processes exactly one outbox row under its tenant. The full submit+commit
   * cycle happens outside the DB transaction so a slow ASP doesn't hold a
   * tenant-scoped tx open; the only piece of in-tx work is the state flip.
   */
  private async processOne(
    tenantId: string,
    outboxId: string,
  ): Promise<'cleared' | 'rejected' | 'pending' | 'retry' | 'dead'> {
    // Phase 1 (tx): claim the row, bump attempts, fetch the signed payload.
    const claim = await withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(clearanceOutbox)
        .where(and(eq(clearanceOutbox.id, outboxId), eq(clearanceOutbox.status, 'queued')))
        .limit(1);
      if (!row) return null;
      const [signedDoc] = await tx
        .select()
        .from(signedDocuments)
        .where(eq(signedDocuments.invoiceId, row.invoiceId))
        .limit(1);
      if (!signedDoc) {
        // Can't submit without a signed payload — move straight to DLQ.
        await tx.insert(clearanceDlq).values({
          tenantId,
          invoiceId: row.invoiceId,
          outboxId: row.id,
          error: 'signed_documents row missing',
          attempts: row.attempts + 1,
        });
        await tx
          .update(clearanceOutbox)
          .set({ status: 'dead', updatedAt: new Date() })
          .where(eq(clearanceOutbox.id, row.id));
        return null;
      }
      await tx
        .update(clearanceOutbox)
        .set({
          status: 'in_flight',
          attempts: row.attempts + 1,
          updatedAt: new Date(),
        })
        .where(eq(clearanceOutbox.id, row.id));
      return { row: { ...row, attempts: row.attempts + 1 }, signedDoc };
    });

    if (!claim) return 'dead';

    const { row, signedDoc } = claim;
    const submission: TransmissionSubmission = {
      tenantId,
      idempotencyKey: row.idempotencyKey,
      ublXml: signedDoc.signedXml,
      signatureValue: signedDoc.signatureValue,
      invoiceUuid: signedDoc.documentUuid,
    };

    // Phase 2 (no tx): talk to the ASP.
    try {
      const result = await this.provider.submit(submission);
      this.breaker.recordSuccess();
      // Phase 3 (tx): write back the result.
      const outcome = await withTenant(this.db, tenantId, async (tx) => {
        if (result.synchronousStatus === 'cleared') {
          await this.applyCleared(
            tx,
            tenantId,
            row,
            result.aspReference,
            result.otaReference,
            result.rawResponse ?? null,
          );
          return 'cleared' as const;
        }
        if (result.synchronousStatus === 'rejected') {
          await this.applyRejected(
            tx,
            tenantId,
            row,
            result.aspReference,
            result.rawResponse ?? null,
          );
          return 'rejected' as const;
        }
        // accepted_pending: stash the ASP reference on the invoice so the
        // async callback can find us, mark the outbox row delivered.
        await tx
          .update(clearanceOutbox)
          .set({ status: 'delivered', updatedAt: new Date() })
          .where(eq(clearanceOutbox.id, row.id));
        await tx.execute(
          sql`UPDATE invoices SET asp_reference = ${result.aspReference}, updated_at = now() WHERE id = ${row.invoiceId}`,
        );
        return 'pending' as const;
      });

      // After the CLEARED tx has committed, auto-advance the invoice to
      // ARCHIVED (B1 fix). Explicitly OUTSIDE the clearance tx: an archive
      // failure must NOT roll back the clearance — the invoice stays
      // CLEARED, and a later manual/scheduled retry can push it onwards.
      // The REJECTED path is intentionally NOT archived.
      if (outcome === 'cleared') {
        await this.autoArchiveAfterClear(tenantId, row.invoiceId);
      }

      return outcome;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.breaker.recordFailure();
      return this.handleFailure(tenantId, row, submission, message);
    }
  }

  /**
   * Fire-and-report archive step. Called ONLY after a successful CLEARED
   * transition. Failures are logged and swallowed so a filesystem/S3 blip
   * doesn't flip the invoice back to SUBMITTED — the invoice stays CLEARED
   * until a retry runs. The REJECTED path never calls this.
   */
  private async autoArchiveAfterClear(tenantId: string, invoiceId: string): Promise<void> {
    if (!this.archive) {
      this.log.warn(
        `autoArchiveAfterClear: no ArchiveService wired; invoice ${invoiceId} stays CLEARED`,
      );
      return;
    }
    try {
      await this.archive.archiveInvoice(tenantId, invoiceId);
    } catch (err) {
      // Structured context so operators can retry manually. The invoice
      // keeps its CLEARED status; a subsequent trigger can advance it.
      this.log.error(
        `autoArchiveAfterClear: archive failed for tenant=${tenantId} invoice=${invoiceId}: ${
          (err as Error).message ?? String(err)
        }`,
      );
    }
  }

  private async applyCleared(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    tenantId: string,
    row: typeof clearanceOutbox.$inferSelect,
    aspReference: string,
    otaReference: string | undefined,
    rawResponse: unknown,
  ) {
    this.assertStateTransition('SUBMITTED', 'CLEARED', 'system');
    await tx
      .update(clearanceOutbox)
      .set({ status: 'delivered', updatedAt: new Date() })
      .where(eq(clearanceOutbox.id, row.id));
    await tx.execute(
      sql`UPDATE invoices
          SET status = 'CLEARED',
              asp_reference = ${aspReference},
              ota_reference = ${otaReference ?? null},
              updated_at = now()
          WHERE id = ${row.invoiceId}`,
    );
    await tx.insert(clearanceEvents).values({
      tenantId,
      invoiceId: row.invoiceId,
      fromState: 'SUBMITTED',
      toState: 'CLEARED',
      actor: 'system',
      aspReference,
      otaReference: otaReference ?? null,
      rawResponse: rawResponse as never,
    });
  }

  private async applyRejected(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    tenantId: string,
    row: typeof clearanceOutbox.$inferSelect,
    aspReference: string,
    rawResponse: unknown,
  ) {
    this.assertStateTransition('SUBMITTED', 'REJECTED', 'system');
    await tx
      .update(clearanceOutbox)
      .set({ status: 'delivered', updatedAt: new Date() })
      .where(eq(clearanceOutbox.id, row.id));
    await tx.execute(
      sql`UPDATE invoices
          SET status = 'REJECTED',
              asp_reference = ${aspReference},
              updated_at = now()
          WHERE id = ${row.invoiceId}`,
    );
    await tx.insert(clearanceEvents).values({
      tenantId,
      invoiceId: row.invoiceId,
      fromState: 'SUBMITTED',
      toState: 'REJECTED',
      actor: 'system',
      aspReference,
      rawResponse: rawResponse as never,
    });
  }

  private async handleFailure(
    tenantId: string,
    row: typeof clearanceOutbox.$inferSelect,
    submission: TransmissionSubmission,
    message: string,
  ): Promise<'retry' | 'dead'> {
    const attempts = row.attempts; // already bumped in phase 1
    if (attempts >= MAX_ATTEMPTS) {
      await withTenant(this.db, tenantId, async (tx) => {
        await tx.insert(clearanceDlq).values({
          tenantId,
          invoiceId: row.invoiceId,
          outboxId: row.id,
          error: message,
          attempts,
          sentPayload: {
            idempotencyKey: submission.idempotencyKey,
            payloadSha256: createHash('sha256').update(submission.ublXml, 'utf8').digest('hex'),
          } as never,
        });
        await tx
          .update(clearanceOutbox)
          .set({ status: 'dead', lastError: message, updatedAt: new Date() })
          .where(eq(clearanceOutbox.id, row.id));
      });
      return 'dead';
    }

    const backoff = Math.min(BASE_BACKOFF_MS * attempts, MAX_BACKOFF_MS);
    await withTenant(this.db, tenantId, async (tx) => {
      await tx
        .update(clearanceOutbox)
        .set({
          status: 'queued',
          lastError: message,
          nextAttemptAt: new Date(Date.now() + backoff),
          updatedAt: new Date(),
        })
        .where(eq(clearanceOutbox.id, row.id));
    });
    return 'retry';
  }

  // ---------------------------------------------------------------------
  // ASYNC CALLBACK
  // ---------------------------------------------------------------------

  /**
   * Idempotent: if the invoice is already CLEARED or REJECTED we no-op, so
   * replayed callbacks (ASP retrying its own webhook) are safe.
   *
   * SEC-003: the callback is scoped under the caller-supplied `tenantId` and
   * the invoice lookup runs under RLS. A forged callback carrying another
   * tenant's `asp_reference` cannot flip our tenant's invoices because the
   * row simply isn't visible in this tenant's RLS context.
   */
  async handleCallback(tenantId: string, cb: TransmissionCallback): Promise<void> {
    let didClear = false;
    let targetInvoiceId: string | null = null;
    await withTenant(this.db, tenantId, async (tx) => {
      // Resolve the invoice by (tenant, asp_reference) under RLS. The sweep
      // pool is no longer used — if the asp_reference doesn't belong to this
      // tenant, we see nothing and no-op.
      const found = await tx
        .select()
        .from(invoices)
        .where(sql`${invoices.tenantId} = ${tenantId} AND asp_reference = ${cb.aspReference}`)
        .limit(1);
      const invoice = found[0];
      if (!invoice) {
        this.log.warn(
          `handleCallback: no invoice for tenant=${tenantId} aspReference=${cb.aspReference}`,
        );
        return;
      }
      if (invoice.status === 'CLEARED' || invoice.status === 'REJECTED') {
        // Idempotency: already applied, nothing to do.
        return;
      }
      if (invoice.status !== 'SUBMITTED') {
        this.log.warn(
          `handleCallback: invoice ${invoice.id} not SUBMITTED (status=${invoice.status})`,
        );
        return;
      }
      if (cb.status === 'cleared') {
        this.assertStateTransition('SUBMITTED', 'CLEARED', 'asp_callback');
        await tx.execute(
          sql`UPDATE invoices
              SET status = 'CLEARED',
                  ota_reference = ${cb.otaReference ?? null},
                  updated_at = now()
              WHERE id = ${invoice.id}`,
        );
        await tx.insert(clearanceEvents).values({
          tenantId,
          invoiceId: invoice.id,
          fromState: 'SUBMITTED',
          toState: 'CLEARED',
          actor: 'asp_callback',
          aspReference: cb.aspReference,
          otaReference: cb.otaReference ?? null,
          rawResponse: cb.rawPayload as never,
        });
        didClear = true;
        targetInvoiceId = invoice.id;
      } else {
        this.assertStateTransition('SUBMITTED', 'REJECTED', 'asp_callback');
        await tx.execute(
          sql`UPDATE invoices
              SET status = 'REJECTED',
                  updated_at = now()
              WHERE id = ${invoice.id}`,
        );
        await tx.insert(clearanceEvents).values({
          tenantId,
          invoiceId: invoice.id,
          fromState: 'SUBMITTED',
          toState: 'REJECTED',
          actor: 'asp_callback',
          aspReference: cb.aspReference,
          rawResponse: {
            rejectionReasons: cb.rejectionReasons ?? [],
            raw: cb.rawPayload,
          } as never,
        });
      }
    });

    // Auto-advance CLEARED -> ARCHIVED (B1 fix). Outside the tx — a storage
    // failure must not roll back the state flip. REJECTED stays REJECTED.
    if (didClear && targetInvoiceId) {
      await this.autoArchiveAfterClear(tenantId, targetInvoiceId);
    }
  }

  // ---------------------------------------------------------------------
  // MANUAL RETRY & READ-SIDE
  // ---------------------------------------------------------------------

  async retry(tenantId: string, invoiceId: string): Promise<{ outboxId: string }> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(clearanceOutbox)
        .where(eq(clearanceOutbox.invoiceId, invoiceId))
        .orderBy(desc(clearanceOutbox.createdAt))
        .limit(1);
      if (!row) throw new NotFoundException('No outbox row for this invoice');
      if (row.status === 'delivered') {
        throw new BadRequestException('Outbox row already delivered');
      }
      await tx
        .update(clearanceOutbox)
        .set({
          status: 'queued',
          nextAttemptAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(clearanceOutbox.id, row.id));
      return { outboxId: row.id };
    });
  }

  async listEvents(tenantId: string, invoiceId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(clearanceEvents)
        .where(eq(clearanceEvents.invoiceId, invoiceId))
        .orderBy(asc(clearanceEvents.at)),
    );
  }

  async status(tenantId: string, invoiceId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
      if (!invoice) throw new NotFoundException('Invoice not found');
      const [outbox] = await tx
        .select()
        .from(clearanceOutbox)
        .where(eq(clearanceOutbox.invoiceId, invoiceId))
        .orderBy(desc(clearanceOutbox.createdAt))
        .limit(1);
      const [latestEvent] = await tx
        .select()
        .from(clearanceEvents)
        .where(eq(clearanceEvents.invoiceId, invoiceId))
        .orderBy(desc(clearanceEvents.at))
        .limit(1);
      return {
        invoice: {
          id: invoice.id,
          status: invoice.status,
          aspReference:
            (invoice as unknown as { aspReference?: string | null }).aspReference ?? null,
          otaReference:
            (invoice as unknown as { otaReference?: string | null }).otaReference ?? null,
        },
        outbox: outbox ?? null,
        latestEvent: latestEvent ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------
  // INTERNAL — RLS-bypassing sweep pool
  // ---------------------------------------------------------------------

  private assertStateTransition(from: InvoiceState, to: InvoiceState, actor: ClearanceActor) {
    assertCanTransition(from, to, actor);
  }

  private getSweepPool(): Pool | null {
    if (this.sweepPool) return this.sweepPool;
    const env = loadEnv();
    const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
    if (!url) return null;
    this.sweepPool = new Pool({ connectionString: url, max: 2 });
    return this.sweepPool;
  }

  private async sweepCandidates(limit: number): Promise<Array<{ id: string; tenant_id: string }>> {
    const pool = this.getSweepPool();
    if (!pool) return [];
    const { rows } = await pool.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id
         FROM clearance_outbox
        WHERE status = 'queued' AND next_attempt_at <= now()
        ORDER BY next_attempt_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** Shuts down the sweep pool. Called from onApplicationShutdown via module. */
  async closeInternalPool(): Promise<void> {
    if (this.sweepPool) {
      await this.sweepPool.end();
      this.sweepPool = null;
    }
  }
}
