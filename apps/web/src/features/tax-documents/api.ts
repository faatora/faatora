/**
 * API client for credit / debit note endpoints.
 *
 * Every call targets /firms/:firmId/clients/:clientId/* and goes
 * through the shared apiFetch, which sets the x-firm-id header from
 * the active firm context (see src/lib/api.ts).
 */

import { apiGet, apiPost } from '../../lib/api';
import type { CreateTaxDocumentInput, TaxDocumentKind, TaxDocumentResult } from './types';

function base(firmId: string, clientId: string): string {
  return `/firms/${encodeURIComponent(firmId)}/clients/${encodeURIComponent(clientId)}`;
}

export function createCreditNote(
  firmId: string,
  clientId: string,
  input: CreateTaxDocumentInput,
): Promise<TaxDocumentResult> {
  return apiPost<TaxDocumentResult>(`${base(firmId, clientId)}/credit-notes`, input);
}

export function createDebitNote(
  firmId: string,
  clientId: string,
  input: CreateTaxDocumentInput,
): Promise<TaxDocumentResult> {
  return apiPost<TaxDocumentResult>(`${base(firmId, clientId)}/debit-notes`, input);
}

export function listTaxDocuments(
  firmId: string,
  clientId: string,
  kind: TaxDocumentKind,
): Promise<TaxDocumentResult[]> {
  const path = kind === 'credit_note' ? 'credit-notes' : 'debit-notes';
  return apiGet<TaxDocumentResult[]>(`${base(firmId, clientId)}/${path}`);
}
