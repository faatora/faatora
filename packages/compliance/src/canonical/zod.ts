import { z } from 'zod';
import type {
  CanonicalAddress,
  CanonicalInvoice,
  CanonicalLine,
  CanonicalParty,
  CanonicalTotals,
} from './types.js';

export const canonicalAddressSchema = z.object({
  street: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().min(1).optional(),
  countrySubdivision: z.string().min(1).optional(),
}) satisfies z.ZodType<CanonicalAddress>;

export const canonicalPartySchema = z.object({
  name: z.string().min(1),
  vatin: z.string().min(1).optional(),
  country: z.string().length(2),
  peppolId: z.string().min(1).optional(),
  address: canonicalAddressSchema.optional(),
}) satisfies z.ZodType<CanonicalParty>;

export const vatCategorySchema = z.enum(['S', 'Z', 'E', 'O']);

export const canonicalLineSchema = z.object({
  lineNo: z.number().int().positive(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitCode: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  vatCategory: vatCategorySchema,
  vatRate: z.number().min(0).max(100),
}) satisfies z.ZodType<CanonicalLine>;

export const canonicalTotalsSchema = z.object({
  netTotal: z.number().nonnegative(),
  vatTotal: z.number().nonnegative(),
  grandTotal: z.number().nonnegative(),
}) satisfies z.ZodType<CanonicalTotals>;

export const invoiceTypeSchema = z.enum(['invoice', 'credit_note', 'debit_note']);

export const canonicalInvoiceSchema = z.object({
  id: z.string().min(1),
  type: invoiceTypeSchema,
  number: z.string().min(1),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'issueDate must be ISO YYYY-MM-DD'),
  currency: z.string().length(3),
  supplier: canonicalPartySchema,
  buyer: canonicalPartySchema,
  lines: z.array(canonicalLineSchema).min(1, 'at least one line required'),
  totals: canonicalTotalsSchema.optional(),
  notes: z.string().optional(),
}) satisfies z.ZodType<CanonicalInvoice>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: ValidationIssue[] };

/**
 * Runtime-validate an untrusted payload against the canonical invoice
 * schema. On success returns the strongly-typed data; on failure a
 * flattened list of issues (one per violated path).
 */
export function validateCanonical(input: unknown): ValidationResult<CanonicalInvoice> {
  const parsed = canonicalInvoiceSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const errors: ValidationIssue[] = parsed.error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
    message: issue.message,
  }));
  return { ok: false, errors };
}
