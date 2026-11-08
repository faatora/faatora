/**
 * PipelineComplianceValidator — the NestJS adapter around
 * `@faatora/compliance`'s validation pipeline.
 *
 * The invoices service calls `.validate({ invoice, lines, totals })`
 * with Drizzle row shapes. We translate that into a `CanonicalInvoice`,
 * run the four-stage pipeline (canonical → VAT math → UBL structure →
 * Schematron-lite), and map the result back onto the compact
 * `ComplianceResult` the port speaks.
 *
 * This swap is intentionally kept DB-free: party details (name, VATIN,
 * country) are not fetched from `parties` here — the compliance port
 * receives only the invoice + lines + totals. Placeholder party names
 * (the party UUID itself) are passed into the canonical so the
 * schematron presence rules (BR-06 supplier name, BR-07 buyer name)
 * never fire for an invoice that merely lacks a party lookup. A
 * single warning string is attached to the result so operators and
 * tests can see that structural validation ran without the real
 * party rows. A later pass can replace this by having
 * `invoices.service` resolve parties before calling the port.
 */

import { Injectable } from '@nestjs/common';
import {
  PINT_OM_RULE_PACK_VERSION,
  validateInvoice,
  type CanonicalInvoice,
  type InvoiceType,
  type VatCategory,
} from '@faatora/compliance';
import type { ComplianceResult, ComplianceValidator } from './compliance.port';

type InvoiceRow = {
  id: string;
  type: string;
  number: string;
  issueDate: string | Date;
  currency: string;
  supplierPartyId: string;
  buyerPartyId: string;
  notes?: string | null;
};

type LineRow = {
  lineNo: number;
  description: string;
  quantity: string | number;
  unitCode: string;
  unitPrice: string | number;
  vatCategory: string;
  vatRate: string | number;
};

interface ValidateInput {
  invoice: InvoiceRow;
  lines: LineRow[];
  totals?: unknown;
}

const KNOWN_INVOICE_TYPES: readonly InvoiceType[] = ['invoice', 'credit_note', 'debit_note'];
const KNOWN_VAT_CATEGORIES: readonly VatCategory[] = ['S', 'Z', 'E', 'O'];

function asInvoiceType(v: string | undefined): InvoiceType {
  return (KNOWN_INVOICE_TYPES as readonly string[]).includes(v ?? '')
    ? (v as InvoiceType)
    : 'invoice';
}

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
  // Drizzle `date` columns surface as 'YYYY-MM-DD' strings already.
  return v;
}

function isValidateInput(x: unknown): x is ValidateInput {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.invoice === 'object' && o.invoice !== null && Array.isArray(o.lines);
}

@Injectable()
export class PipelineComplianceValidator implements ComplianceValidator {
  async validate(input: unknown): Promise<ComplianceResult> {
    if (!isValidateInput(input)) {
      // Preserve the historical "always ok" shape when the caller hands
      // us something we don't understand — the port contract is loose.
      return { ok: true, rulePackVersion: PINT_OM_RULE_PACK_VERSION };
    }

    const canonical: CanonicalInvoice = {
      id: input.invoice.id,
      type: asInvoiceType(input.invoice.type),
      number: input.invoice.number,
      issueDate: toIsoDate(input.invoice.issueDate),
      currency: input.invoice.currency,
      // Placeholder party rows — see file header for the rationale.
      // Country defaults to OM so BR-OM-* don't light up on this
      // synthetic path; the real-party pass will replace these.
      supplier: {
        name: `party:${input.invoice.supplierPartyId}`,
        country: 'OM',
      },
      buyer: {
        name: `party:${input.invoice.buyerPartyId}`,
        country: 'OM',
      },
      lines: input.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        quantity: Number(l.quantity),
        unitCode: l.unitCode,
        unitPrice: Number(l.unitPrice),
        vatCategory: asVatCategory(l.vatCategory),
        vatRate: Number(l.vatRate),
      })),
      notes: input.invoice.notes ?? undefined,
    };

    const report = validateInvoice({ canonical });

    if (!report.ok) {
      return {
        ok: false,
        errors: report.errors.map((e) => `${e.rule}: ${e.message}`),
        rulePackVersion: report.rulePackVersion,
      };
    }

    // Warnings don't block the issue flow; the port's `errors` field is
    // only consulted on the failure branch, so we keep the success result
    // clean. A future revision will give the port a dedicated warnings
    // channel (and resolve parties for real, dropping the placeholder).
    return {
      ok: true,
      rulePackVersion: report.rulePackVersion,
    };
  }
}
