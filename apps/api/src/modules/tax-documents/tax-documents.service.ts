/**
 * Tax documents service — credit note + debit note write path.
 *
 * Shared service for both document kinds because they share nearly
 * every step; the only difference is which @faatora/compliance
 * serialiser to call. The kind is passed in by the controller.
 *
 * Flow:
 *   1. Open a withFirmTenant transaction so RLS gates every row
 *      touched by the tenant policy.
 *   2. Load the original invoice + verify it belongs to this tenant
 *      and its status is CLEARED (Oman VAT law restriction).
 *   3. Compute totals from the submitted lines (same money.ts engine
 *      invoices use, so OMR baisa math matches exactly).
 *   4. Resolve supplier / buyer parties from the original invoice —
 *      a credit or debit note always carries the invoice's parties.
 *   5. Build the canonical shape and call the compliance serialiser
 *      (CreditNote-2 or Invoice-2-with-383, see @faatora/compliance).
 *   6. Persist the header + lines, store the UBL, and emit a
 *      firm.tax_document.created event the audit subscriber picks up.
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { desc, eq } from 'drizzle-orm';
import {
  canonicalToSemantic,
  PINT_OM_RULE_PACK_VERSION,
  semanticToPintOm,
  serializeCreditNote,
  serializeDebitNote,
  validateInvoice,
  type CanonicalInvoice,
  type CreditNoteInput,
  type DebitNoteInput,
  type InvoiceType,
  type VatCategory,
} from '@faatora/compliance';

import { DB, type Database } from '../../db/db.module';
import { withFirmTenant } from '../../db/with-firm-tenant';
import { invoices, parties } from '../../db/schema/invoicing';
import {
  taxDocuments,
  taxDocumentLines,
  type TaxDocumentKind,
} from '../../db/schema/tax-documents';
import { computeTotals, type LineInput } from '../invoices/money';
import type { CreateTaxDocumentDto } from './dto/create-tax-document.dto';

const KNOWN_VAT_CATEGORIES: readonly VatCategory[] = ['S', 'Z', 'E', 'O'];

function asVatCategory(v: string | undefined): VatCategory {
  return (KNOWN_VAT_CATEGORIES as readonly string[]).includes(v ?? '') ? (v as VatCategory) : 'S';
}

function toIsoDate(v: string | Date): string {
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return v;
}

export interface TaxDocumentResult {
  id: string;
  kind: TaxDocumentKind;
  number: string;
  originalInvoiceId: string;
  status: string;
  currency: string;
  subtotal: string;
  vatTotal: string;
  grandTotal: string;
  ublXml: string;
  rulePackVersion: string;
  lines: Array<{
    lineNo: number;
    description: string;
    quantity: string;
    unitPrice: string;
    vatCategory: string;
    vatRate: string;
    lineNet: string;
  }>;
}

@Injectable()
export class TaxDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Create a credit note or debit note against an existing CLEARED
   * invoice belonging to the client tenant.
   *
   * The firm membership + active engagement checks happen in
   * FirmGuard + withFirmTenant; by the time we reach this method the
   * caller is proven to have write access to this (firm, tenant)
   * pair.
   */
  async create(
    firmId: string,
    tenantId: string,
    kind: TaxDocumentKind,
    userId: string,
    dto: CreateTaxDocumentDto,
  ): Promise<TaxDocumentResult> {
    const totals = computeTotals(
      dto.lines.map<LineInput>((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        vatCategory: l.vatCategory ?? 'S',
        vatRate: l.vatRate ?? 5,
      })),
    );

    return withFirmTenant(this.db, firmId, tenantId, async (tx) => {
      // Load the original invoice. RLS already restricts to this
      // tenant; the explicit tenant_id guard here is defense in depth
      // and makes the error message deterministic even if a later
      // policy change widens the SELECT branch.
      const [original] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, dto.originalInvoiceId))
        .limit(1);
      if (!original || original.tenantId !== tenantId) {
        throw new NotFoundException('Original invoice not found');
      }

      // Oman VAT law: credit / debit notes can only be issued against
      // a cleared (settled) invoice, because otherwise the original
      // VAT wasn't owed in the first place. We accept CLEARED as the
      // canonical state. SIGNED / SUBMITTED invoices are not yet
      // cleared.
      if (original.status !== 'CLEARED') {
        throw new BadRequestException(
          `Only CLEARED invoices can be ${kind === 'credit_note' ? 'credited' : 'debited'} ` +
            `(status=${original.status})`,
        );
      }

      // Resolve parties so we can build the canonical invoice shape
      // the compliance serialiser expects. Both must belong to the
      // same tenant — enforced by the RLS policy on `parties`.
      const [supplier] = await tx
        .select()
        .from(parties)
        .where(eq(parties.id, original.supplierPartyId))
        .limit(1);
      const [buyer] = await tx
        .select()
        .from(parties)
        .where(eq(parties.id, original.buyerPartyId))
        .limit(1);
      if (!supplier || !buyer) {
        throw new BadRequestException(
          'Original invoice references parties that are not visible in this tenant',
        );
      }

      const currency = dto.currency ?? original.currency;

      // Canonical shape — same shape the invoice issue() path builds.
      // The compliance serialiser recomputes totals from lines so
      // we only need to pass accurate line data.
      const canonicalType: InvoiceType = kind === 'credit_note' ? 'credit_note' : 'debit_note';
      const canonical: CanonicalInvoice = {
        id: original.id,
        type: canonicalType,
        number: dto.number,
        issueDate: toIsoDate(dto.issueDate),
        currency,
        supplier: {
          name: supplier.name,
          vatin: supplier.vatin ?? undefined,
          country: supplier.country,
        },
        buyer: {
          name: buyer.name,
          vatin: buyer.vatin ?? undefined,
          country: buyer.country,
        },
        lines: dto.lines.map((l, i) => ({
          lineNo: i + 1,
          description: l.description,
          quantity: l.quantity,
          unitCode: l.unitCode ?? 'C62',
          unitPrice: l.unitPrice,
          vatCategory: asVatCategory(l.vatCategory),
          vatRate: l.vatRate ?? 5,
        })),
        notes: dto.reason ?? dto.notes,
      };

      // Pipeline check — business-rule compliance (BR-*, BR-CO-*,
      // BR-OM-*) ahead of persisting anything. Same engine as the
      // invoice issue path.
      const report = validateInvoice({ canonical });
      if (!report.ok) {
        throw new UnprocessableEntityException({
          message: 'Compliance validation failed',
          errors: report.errors.map((e) => `${e.rule}: ${e.message}`),
        });
      }

      // Serialise.
      const semantic = canonicalToSemantic(canonical);
      const pintOm = semanticToPintOm(semantic);
      const billingReference = {
        invoiceDocumentReference: {
          id: original.number,
          issueDate: toIsoDate(original.issueDate),
        },
      };
      const ublXml =
        kind === 'credit_note'
          ? serializeCreditNote({ ...pintOm, billingReference } satisfies CreditNoteInput)
          : serializeDebitNote({ ...pintOm, billingReference } satisfies DebitNoteInput);

      // Persist header + lines inside the same tx so RLS covers both
      // writes under one firm-tenant check.
      const [row] = await tx
        .insert(taxDocuments)
        .values({
          tenantId,
          kind,
          number: dto.number,
          currency,
          status: 'VALIDATED',
          issueDate: toIsoDate(dto.issueDate),
          originalInvoiceId: original.id,
          supplierPartyId: original.supplierPartyId,
          buyerPartyId: original.buyerPartyId,
          subtotal: totals.subtotal.toFixed(3),
          vatTotal: totals.vatTotal.toFixed(3),
          grandTotal: totals.grandTotal.toFixed(3),
          vatBreakdown: totals.vatBreakdown,
          reason: dto.reason,
          notes: dto.notes,
          ublXml,
          rulePackVersion: report.rulePackVersion ?? PINT_OM_RULE_PACK_VERSION,
          createdBy: userId,
        })
        .returning();

      const lineRows = dto.lines.map((l, i) => ({
        tenantId,
        taxDocumentId: row.id,
        originalInvoiceLineId: l.originalInvoiceLineId,
        lineNo: i + 1,
        description: l.description,
        quantity: l.quantity.toFixed(3),
        unitCode: l.unitCode ?? 'C62',
        unitPrice: l.unitPrice.toFixed(3),
        vatCategory: l.vatCategory ?? 'S',
        vatRate: (l.vatRate ?? 5).toFixed(2),
        lineNet: totals.lineNets[i].toFixed(3),
      }));
      const inserted = await tx.insert(taxDocumentLines).values(lineRows).returning();

      // Audit trail. The subscriber is defensive (never throws back
      // into the business tx), but we still emit after the writes
      // succeed so the audit mirrors committed state.
      this.events.emit('firm.tax_document.created', {
        firmId,
        tenantId,
        taxDocumentId: row.id,
        originalInvoiceId: original.id,
        kind,
        number: dto.number,
        actorUserId: userId,
      });

      return {
        id: row.id,
        kind,
        number: row.number,
        originalInvoiceId: row.originalInvoiceId,
        status: row.status,
        currency: row.currency,
        subtotal: row.subtotal,
        vatTotal: row.vatTotal,
        grandTotal: row.grandTotal,
        ublXml,
        rulePackVersion: row.rulePackVersion ?? PINT_OM_RULE_PACK_VERSION,
        lines: inserted.map((l) => ({
          lineNo: l.lineNo,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          vatCategory: l.vatCategory,
          vatRate: l.vatRate,
          lineNet: l.lineNet,
        })),
      };
    });
  }

  /**
   * List every credit or debit note a tenant has against their
   * invoices, most recent first. Used by the client-detail page in
   * the firm console.
   */
  async list(firmId: string, tenantId: string, kind?: TaxDocumentKind) {
    return withFirmTenant(this.db, firmId, tenantId, async (tx) => {
      const base = tx.select().from(taxDocuments).orderBy(desc(taxDocuments.createdAt));
      const rows = kind ? await base.where(eq(taxDocuments.kind, kind)) : await base;
      return rows;
    });
  }

  async get(firmId: string, tenantId: string, id: string) {
    return withFirmTenant(this.db, firmId, tenantId, async (tx) => {
      const [row] = await tx.select().from(taxDocuments).where(eq(taxDocuments.id, id)).limit(1);
      if (!row) throw new NotFoundException('Tax document not found');
      const lines = await tx
        .select()
        .from(taxDocumentLines)
        .where(eq(taxDocumentLines.taxDocumentId, id))
        .orderBy(taxDocumentLines.lineNo);
      return { ...row, lines };
    });
  }
}
