// W2-D — imports API client.
// Uses the shared apiFetch so the `x-firm-id` header is automatically
// set from FirmContext.

import { apiFetch, apiGet, apiPost } from '../../lib/api';
import type { ColumnMapping, CommitResponse, ImportSourceFormat, PreviewResponse } from './types';

export async function previewImport(
  firmId: string,
  tenantId: string,
  sourceFormat: ImportSourceFormat,
  file: Blob,
  filename?: string,
): Promise<PreviewResponse> {
  const qs = new URLSearchParams({ tenantId, sourceFormat });
  if (filename) qs.set('filename', filename);
  const buffer = await file.arrayBuffer();
  return apiFetch<PreviewResponse>(
    `/firms/${encodeURIComponent(firmId)}/imports/preview?${qs.toString()}`,
    {
      method: 'POST',
      body: buffer,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    },
  );
}

export function commitImport(
  firmId: string,
  previewToken: string,
  mapping?: ColumnMapping,
  saveMapping?: boolean,
): Promise<CommitResponse> {
  return apiPost<CommitResponse>(`/firms/${encodeURIComponent(firmId)}/imports/commit`, {
    previewToken,
    mapping,
    saveMapping,
  });
}

export function getColumnMapping(
  firmId: string,
  sourceFormat: ImportSourceFormat,
): Promise<{ sourceFormat: ImportSourceFormat; mapping: ColumnMapping; isDefault: boolean }> {
  return apiGet(
    `/firms/${encodeURIComponent(firmId)}/imports/mapping/${encodeURIComponent(sourceFormat)}`,
  );
}

export function saveColumnMapping(
  firmId: string,
  sourceFormat: ImportSourceFormat,
  mapping: ColumnMapping,
): Promise<{ sourceFormat: ImportSourceFormat; mapping: ColumnMapping }> {
  return apiFetch(
    `/firms/${encodeURIComponent(firmId)}/imports/mapping/${encodeURIComponent(sourceFormat)}`,
    {
      method: 'PUT',
      body: { mapping },
    },
  );
}
