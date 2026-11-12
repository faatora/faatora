// Minimal RFC-4180 CSV parser for the batch-onboard wizard.
//
// The wizard only needs to turn pasted / uploaded CSV text into rows for
// a preview table and then a POST. Row commit lives server-side; this
// parser stays in the browser so we can show the user what the parse
// found before anything hits the wire. The W2-D import pipeline is a
// separate flow for invoices, not tenants, and is not reused here.

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  // Normalise newlines; preserve embedded LFs inside quoted fields.
  const t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  // Flush the trailing field/row only when there was actually content.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim().length > 0));
  return {
    headers,
    rows: dataRows.map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = (r[i] ?? '').trim();
      });
      return obj;
    }),
  };
}

/**
 * A validation error attached to a single CSV row.
 *
 * `code` is a stable i18n key (under `clients.wizard.batch.errors.*`) so the
 * UI can render the message in the active locale. `code` MUST NOT be a
 * literal English phrase — the UI is the only translator.
 */
export interface CsvRowError {
  code: string;
}

export interface CsvMappedRow {
  tenantName: string;
  crNumber: string;
  vatin: string;
  country: string;
  accessLevel: 'full' | 'read_only';
  engagementType: 'ongoing' | 'periodic';
  shopOwnerEmail?: string;
  _rowIndex: number;
  _errors: CsvRowError[];
}

export const CSV_ERROR_CODES = {
  tenantNameRequired: 'clients.wizard.batch.errors.tenantName_required',
  crNumberRequired: 'clients.wizard.batch.errors.crNumber_required',
  vatinRequired: 'clients.wizard.batch.errors.vatin_required',
  countryLength: 'clients.wizard.batch.errors.country_length',
  accessLevelInvalid: 'clients.wizard.batch.errors.accessLevel_invalid',
  engagementTypeInvalid: 'clients.wizard.batch.errors.engagementType_invalid',
  shopOwnerEmailInvalid: 'clients.wizard.batch.errors.shopOwnerEmail_invalid',
} as const;

/**
 * Map a parsed CSV into the DTO shape the onboarding endpoint expects.
 * Each row carries its validation errors inline so the wizard can mark
 * the row red without rerunning validation.
 *
 * Expected header names (case-insensitive, tolerant of snake / spaced):
 *   tenantName | tenant_name | "Tenant name"
 *   crNumber   | cr_number   | "CR number"
 *   vatin      | VATIN
 *   country    (optional, defaults to OM)
 *   accessLevel  (optional: full|read_only, defaults to full)
 *   engagementType (optional: ongoing|periodic, defaults to ongoing)
 *   shopOwnerEmail (optional)
 */
export function mapCsvRows(rows: Record<string, string>[]): CsvMappedRow[] {
  const normalise = (k: string): string => k.toLowerCase().replace(/[\s_-]/g, '');
  return rows.map((raw, i) => {
    const byNorm: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      byNorm[normalise(k)] = v;
    }
    const pick = (...names: string[]) => {
      for (const n of names) {
        const v = byNorm[normalise(n)];
        if (v != null && v.length > 0) return v;
      }
      return '';
    };
    const tenantName = pick('tenantName', 'tenant_name', 'Tenant Name', 'name');
    const crNumber = pick('crNumber', 'cr_number', 'CR Number', 'cr');
    const vatin = pick('vatin', 'VATIN');
    const country = pick('country') || 'OM';
    const accessLevelRaw = (pick('accessLevel', 'access_level') || 'full').toLowerCase();
    const engagementTypeRaw = (
      pick('engagementType', 'engagement_type') || 'ongoing'
    ).toLowerCase();
    const shopOwnerEmail = pick('shopOwnerEmail', 'shop_owner_email', 'email');

    const errors: CsvRowError[] = [];
    if (!tenantName) errors.push({ code: CSV_ERROR_CODES.tenantNameRequired });
    if (!crNumber) errors.push({ code: CSV_ERROR_CODES.crNumberRequired });
    if (!vatin) errors.push({ code: CSV_ERROR_CODES.vatinRequired });
    if (country.length !== 2) errors.push({ code: CSV_ERROR_CODES.countryLength });
    if (!['full', 'read_only'].includes(accessLevelRaw)) {
      errors.push({ code: CSV_ERROR_CODES.accessLevelInvalid });
    }
    if (!['ongoing', 'periodic'].includes(engagementTypeRaw)) {
      errors.push({ code: CSV_ERROR_CODES.engagementTypeInvalid });
    }
    if (shopOwnerEmail && !/^\S+@\S+\.\S+$/.test(shopOwnerEmail)) {
      errors.push({ code: CSV_ERROR_CODES.shopOwnerEmailInvalid });
    }
    return {
      tenantName,
      crNumber,
      vatin,
      country,
      accessLevel: (accessLevelRaw as 'full' | 'read_only') || 'full',
      engagementType: (engagementTypeRaw as 'ongoing' | 'periodic') || 'ongoing',
      shopOwnerEmail: shopOwnerEmail || undefined,
      _rowIndex: i + 2, // +1 for 1-based, +1 for header row
      _errors: errors,
    };
  });
}
