import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalToSemantic,
  pintOmToUbl,
  semanticToPintOm,
  type CanonicalInvoice,
  type InvoiceType,
  type VatCategory,
} from '@fawtara/compliance';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { invoices, invoiceLines, parties } from '../../db/schema/invoicing';
import { signedDocuments } from '../../db/schema/signing';
import { SIGNER, type Signer } from './signer.port';
import { buildQrPayload, generateQrPng } from './qr';
import { renderPdf } from './pdf';

export interface SignOutcome {
  documentUuid: string;
  sha256: string;
  qrPngBase64: string;
  pdfBase64: string;
  signatureValue: string;
}

const KNOWN_INVOICE_TYPES: readonly InvoiceType[] = ['invoice', 'credit_note', 'debit_note'];
const KNOWN_VAT_CATEGORIES: readonly VatCategory[] = ['S', 'Z', 'E', 'O'];

function asInvoiceType(v: string | undefined | null): InvoiceType {
  return (KNOWN_INVOICE_TYPES as readonly string[]).includes(v ?? '')
    ? (v as InvoiceType)
    : 'invoice';
}

function asVatCategory(v: string | undefined | null): VatCategory {
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

@Injectable()
export class SigningService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SIGNER) private readonly signer: Signer,
  ) {}

  /**
   * Sign the invoice at (tenantId, invoiceId). The caller supplies NO XML:
   * the signer rebuilds the PINT-OM UBL server-side from invoice + lines +
   * supplier/buyer parties under RLS, so the signed document always matches
   * what the DB stored at validation time. See SEC-001.
   */
  async sign(tenantId: string, invoiceId: string, _userId: string): Promise<SignOutcome> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status !== 'VALIDATED') {
        throw new BadRequestException(
          `Only VALIDATED invoices can be signed (status=${invoice.status})`,
        );
      }

      const documentUuid = invoice.documentUuid ?? randomUUID();

      // Resolve supplier + buyer under tenant RLS. Both must be visible in
      // this tenant — any mismatch (orphaned FK, cross-tenant leak) surfaces
      // here before we hand anything to the signer.
      const [supplier] = await tx
        .select()
        .from(parties)
        .where(eq(parties.id, invoice.supplierPartyId))
        .limit(1);
      if (!supplier) {
        throw new NotFoundException('Supplier party not found for this tenant');
      }
      const [buyer] = await tx
        .select()
        .from(parties)
        .where(eq(parties.id, invoice.buyerPartyId))
        .limit(1);
      if (!buyer) {
        throw new NotFoundException('Buyer party not found for this tenant');
      }

      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId))
        .orderBy(invoiceLines.lineNo);

      // Build the canonical invoice from DB rows (NOT from client input).
      const canonical: CanonicalInvoice = {
        id: invoice.id,
        type: asInvoiceType(invoice.type),
        number: invoice.number,
        issueDate: toIsoDate(invoice.issueDate),
        currency: invoice.currency,
        supplier: {
          name: supplier.name,
          vatin: supplier.vatin ?? undefined,
          country: supplier.country ?? 'OM',
          peppolId: supplier.peppolId ?? undefined,
        },
        buyer: {
          name: buyer.name,
          vatin: buyer.vatin ?? undefined,
          country: buyer.country ?? 'OM',
          peppolId: buyer.peppolId ?? undefined,
        },
        lines: lines.map((l) => ({
          lineNo: l.lineNo,
          description: l.description,
          quantity: Number(l.quantity),
          unitCode: l.unitCode,
          unitPrice: Number(l.unitPrice),
          vatCategory: asVatCategory(l.vatCategory),
          vatRate: Number(l.vatRate),
        })),
        notes: invoice.notes ?? undefined,
      };

      const semantic = canonicalToSemantic(canonical);
      const pintOm = semanticToPintOm(semantic, { documentUuid });
      const ublXml = pintOmToUbl(pintOm);

      const sha256 = createHash('sha256').update(ublXml, 'utf8').digest('hex');
      const signResult = await this.signer.sign(Buffer.from(ublXml, 'utf8'));

      const supplierVatin = supplier.vatin ?? '';
      const qrPayload = JSON.stringify(
        buildQrPayload({
          uuid: documentUuid,
          number: invoice.number,
          issueDate: String(invoice.issueDate),
          grandTotal: invoice.grandTotal,
          vatTotal: invoice.vatTotal,
          supplierVatin,
        }),
      );
      const qrPngBase64 = await generateQrPng(qrPayload);
      const pdfBase64 = await renderPdf({
        invoice: {
          id: invoice.id,
          number: invoice.number,
          documentUuid,
          issueDate: String(invoice.issueDate),
          currency: invoice.currency,
          subtotal: invoice.subtotal,
          vatTotal: invoice.vatTotal,
          grandTotal: invoice.grandTotal,
        },
        lines: lines.map((l) => ({
          lineNo: l.lineNo,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineNet: l.lineNet,
        })),
        supplier: {
          name: supplier.name,
          vatin: supplier.vatin,
          country: supplier.country,
        },
        buyer: {
          name: buyer.name,
          vatin: buyer.vatin,
          country: buyer.country,
        },
        vatBreakdown: Array.isArray(invoice.vatBreakdown)
          ? (invoice.vatBreakdown as Array<{
              category: string;
              rate: number;
              taxable: number;
              tax: number;
            }>)
          : [],
        qrPngBase64,
      });

      await tx
        .update(invoices)
        .set({
          documentUuid,
          status: 'SIGNED',
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoiceId));

      await tx.insert(signedDocuments).values({
        tenantId,
        invoiceId,
        documentUuid,
        signedXml: ublXml,
        signatureValue: signResult.signatureValue,
        signatureAlgorithm: signResult.algorithm,
        keyId: signResult.keyId,
        qrPngBase64,
        pdfBase64,
        sha256,
      });

      return {
        documentUuid,
        sha256,
        qrPngBase64,
        pdfBase64,
        signatureValue: signResult.signatureValue,
      };
    });
  }
}
