/**
 * W2-D — firm-scoped preview + commit pipeline.
 *
 * Flow:
 *   1. preview(firmId, body) — parses the file, applies mapping, runs
 *      validation, computes per-row content hashes, checks against
 *      prior `import_batches.row_hashes` for that tenant to flag
 *      duplicates, returns a signed preview token plus rows/errors/summary.
 *      NO database writes.
 *   2. commit(firmId, previewToken, maybeEditedMapping) — re-validates
 *      the token, reopens the preview snapshot, writes DRAFT invoices
 *      under withFirmTenant, inserts an import_batches row, and emits
 *      `firm.import.committed` for W2-E to subscribe to.
 *
 * The preview snapshot lives in an in-memory Map keyed by the token.
 * Tokens are HMAC-signed with a server-side secret so a client cannot
 * forge one. The snapshot expires after ~30 minutes.
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withFirmTenant } from '../../db/with-firm-tenant';
import { withFirm } from '../../db/with-firm';
import { firmClientTenants } from '../../db/schema/firms';
import { invoices, parties } from '../../db/schema/invoicing';
import { importBatches } from '../../db/schema/firm-imports';
import {
  ColumnMappingService,
  type ColumnMapping,
} from './column-mapping.service';
import {
  isImportSourceFormat,
  type ImportSourceFormat,
  type ParsedImportRow,
  type RowError,
} from './parsers/parsed-import-row';
import { parseTallyCsv } from './parsers/tally-csv.parser';
import { parseTallyXml } from './parsers/tally-xml.parser';
import { parseZohoBooksCsv } from './parsers/zoho-books-csv.parser';

const TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN_SECRET = process.env.IMPORTS_PREVIEW_SECRET || 'dev-insecure-imports-preview-secret';

export interface PreviewRequest {
  tenantId: string;
  sourceFormat: ImportSourceFormat;
  filename?: string;
  file: Buffer;
}

export interface PreviewRow extends ParsedImportRow {
  rowHash: string;
  duplicate: boolean;
}

export interface PreviewResult {
  previewToken: string;
  rows: PreviewRow[];
  errors: RowError[];
  headers: string[];
  mapping: ColumnMapping;
  summary: {
    totalRows: number;
    validRows: number;
    errorRows: number;
    duplicateRows: number;
  };
}

export interface CommitResult {
  batchId: string;
  rowCountTotal: number;
  rowCountCommitted: number;
  rowCountSkipped: number;
  rowCountErrored: number;
}

interface PreviewSnapshot {
  firmId: string;
  tenantId: string;
  sourceFormat: ImportSourceFormat;
  filename?: string;
  mapping: ColumnMapping;
  rows: PreviewRow[];
  errors: RowError[];
  createdAt: number;
}

function signToken(id: string): string {
  const h = createHmac('sha256', TOKEN_SECRET).update(id).digest('hex');
  return `${id}.${h}`;
}

function verifyToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [id, sig] = parts;
  const expected = createHmac('sha256', TOKEN_SECRET).update(id).digest('hex');
  if (sig.length !== expected.length) return null;
  // Timing-safe compare (lengths equal here; use simple loop).
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? id : null;
}

export function computeRowHash(
  sourceFormat: ImportSourceFormat,
  row: ParsedImportRow,
): string {
  const payload = [
    sourceFormat,
    row.invoiceNumber,
    row.invoiceDate,
    row.totalAmount.toFixed(3),
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

@Injectable()
export class FirmImportsService {
  private readonly previews = new Map<string, PreviewSnapshot>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly mappings: ColumnMappingService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  private sweep(): void {
    const now = Date.now();
    for (const [id, snap] of this.previews.entries()) {
      if (now - snap.createdAt > TOKEN_TTL_MS) {
        this.previews.delete(id);
      }
    }
  }

  private async rawParse(sourceFormat: ImportSourceFormat, buffer: Buffer) {
    if (sourceFormat === 'tally_xml') return parseTallyXml(buffer);
    if (sourceFormat === 'zoho_books_csv') return parseZohoBooksCsv(buffer);
    // tally_daybook_csv / tally_sales_register_csv both go through parseTallyCsv.
    return parseTallyCsv(buffer);
  }

  /**
   * The engagement check: confirm the firm has an ACTIVE link to the
   * tenant before any work. withFirmTenant will also assert this, but
   * doing it up front lets us surface a clear 403 before parsing a
   * potentially large file.
   */
  private async assertEngagement(firmId: string, tenantId: string): Promise<void> {
    const rows = await withFirm(this.db, firmId, (tx) =>
      tx
        .select({ id: firmClientTenants.id })
        .from(firmClientTenants)
        .where(
          and(
            eq(firmClientTenants.firmId, firmId),
            eq(firmClientTenants.tenantId, tenantId),
            sql`${firmClientTenants.revokedAt} IS NULL`,
          ),
        )
        .limit(1),
    );
    if (!rows[0]) {
      throw new NotFoundException('Firm has no active engagement with this tenant');
    }
  }

  async preview(firmId: string, req: PreviewRequest): Promise<PreviewResult> {
    this.sweep();
    if (!isImportSourceFormat(req.sourceFormat)) {
      throw new BadRequestException(`Unsupported source format: ${req.sourceFormat}`);
    }
    if (!req.file || req.file.length === 0) {
      throw new BadRequestException('Empty file body');
    }
    await this.assertEngagement(firmId, req.tenantId);

    const rawResult = await this.rawParse(req.sourceFormat, req.file);
    const mapping = await this.mappings.getForFirm(firmId, req.sourceFormat);
    const mapped = this.mappings.applyMapping(rawResult.rawRows, mapping);

    // Gather known row hashes for this tenant to flag duplicates.
    const prior = await withFirmTenant(this.db, firmId, req.tenantId, (tx) =>
      tx
        .select({ hashes: importBatches.rowHashes })
        .from(importBatches)
        .where(eq(importBatches.tenantId, req.tenantId)),
    );
    const seen = new Set<string>();
    for (const b of prior) {
      const arr = (b.hashes as string[] | null) ?? [];
      for (const h of arr) seen.add(h);
    }

    let duplicateCount = 0;
    const previewRows: PreviewRow[] = mapped.rows.map((r) => {
      const hash = computeRowHash(req.sourceFormat, r);
      const duplicate = seen.has(hash);
      if (duplicate) duplicateCount++;
      return { ...r, rowHash: hash, duplicate };
    });

    const errors = [...rawResult.errors, ...mapped.errors];
    const totalRows = rawResult.rawRows.length + rawResult.errors.length;

    const id = randomBytes(16).toString('hex');
    this.previews.set(id, {
      firmId,
      tenantId: req.tenantId,
      sourceFormat: req.sourceFormat,
      filename: req.filename,
      mapping,
      rows: previewRows,
      errors,
      createdAt: Date.now(),
    });
    const token = signToken(id);
    return {
      previewToken: token,
      rows: previewRows,
      errors,
      headers: rawResult.headers,
      mapping,
      summary: {
        totalRows,
        validRows: previewRows.length - duplicateCount,
        errorRows: errors.length,
        duplicateRows: duplicateCount,
      },
    };
  }

  async commit(
    firmId: string,
    userId: string,
    previewToken: string,
    editedMapping?: ColumnMapping,
    saveMapping?: boolean,
  ): Promise<CommitResult> {
    this.sweep();
    const id = verifyToken(previewToken);
    if (!id) throw new BadRequestException('Invalid preview token');
    const snap = this.previews.get(id);
    if (!snap) throw new NotFoundException('Preview expired or unknown');
    if (snap.firmId !== firmId) {
      // The token was minted by another firm. Treat as a 404 to avoid
      // leaking its existence.
      throw new NotFoundException('Preview expired or unknown');
    }

    // Save the edited mapping for future imports if requested.
    if (saveMapping && editedMapping) {
      await this.mappings.saveForFirm(firmId, snap.sourceFormat, editedMapping);
    }

    // Rows to actually commit: valid (non-duplicate) rows. Duplicates
    // skip; errored rows are already not in snap.rows.
    const toCommit = snap.rows.filter((r) => !r.duplicate);
    const duplicateCount = snap.rows.length - toCommit.length;
    const errored = snap.errors.length;
    const total = snap.rows.length + errored;

    const batchId = await withFirmTenant(this.db, firmId, snap.tenantId, async (tx) => {
      const [batch] = await tx
        .insert(importBatches)
        .values({
          firmId,
          tenantId: snap.tenantId,
          sourceFormat: snap.sourceFormat,
          filename: snap.filename,
          rowCountTotal: total,
          rowCountCommitted: toCommit.length,
          rowCountSkipped: duplicateCount,
          rowCountErrored: errored,
          rowHashes: toCommit.map((r) => r.rowHash),
          createdBy: userId,
        })
        .returning({ id: importBatches.id });
      // For each row, upsert parties (supplier is "Self" when unknown
      // because the file is typically the client's own sales ledger)
      // and then write a DRAFT invoice.
      for (const r of toCommit) {
        const supplier = await this.findOrCreateParty(
          tx,
          snap.tenantId,
          r.supplierVatin,
          r.supplierName || 'Self',
          'supplier',
        );
        const buyer = await this.findOrCreateParty(
          tx,
          snap.tenantId,
          r.buyerVatin,
          r.buyerName || 'Unknown Buyer',
          'customer',
        );
        await tx
          .insert(invoices)
          .values({
            tenantId: snap.tenantId,
            type: 'invoice',
            status: 'DRAFT',
            number: r.invoiceNumber,
            issueDate: r.invoiceDate,
            supplierPartyId: supplier.id,
            buyerPartyId: buyer.id,
            currency: r.currency || 'OMR',
            subtotal: r.taxableAmount.toFixed(3),
            vatTotal: r.vatAmount.toFixed(3),
            grandTotal: r.totalAmount.toFixed(3),
            vatBreakdown: [
              {
                category: 'S',
                rate: r.vatRate ?? 5,
                taxable: r.taxableAmount,
                tax: r.vatAmount,
              },
            ],
            createdBy: userId,
            notes: r.description ?? null,
          })
          .onConflictDoNothing({ target: [invoices.tenantId, invoices.number] });
      }
      return batch.id;
    });

    // Drop the snapshot so the same token cannot be re-committed.
    this.previews.delete(id);

    this.events?.emit('firm.import.committed', {
      firmId,
      tenantId: snap.tenantId,
      batchId,
      rowCount: toCommit.length,
    });

    return {
      batchId,
      rowCountTotal: total,
      rowCountCommitted: toCommit.length,
      rowCountSkipped: duplicateCount,
      rowCountErrored: errored,
    };
  }

  private async findOrCreateParty(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    tenantId: string,
    vatin: string | undefined,
    name: string,
    kind: string,
  ): Promise<{ id: string }> {
    if (vatin && vatin.trim()) {
      const vat = vatin.trim();
      const byVat = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.vatin, vat)))
        .limit(1);
      if (byVat[0]) return byVat[0];
    }
    const byName = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.name, name)))
      .limit(1);
    if (byName[0]) return byName[0];
    const [created] = await tx
      .insert(parties)
      .values({
        tenantId,
        kind,
        name,
        vatin: vatin && vatin.trim() ? vatin.trim() : null,
        country: 'OM',
      })
      .returning({ id: parties.id });
    return created;
  }
}
