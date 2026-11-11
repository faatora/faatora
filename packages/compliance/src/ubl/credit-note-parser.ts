/**
 * UBL 2.1 CreditNote parser (structural well-formedness only).
 *
 * Twin of `parser.ts` (which checks Invoice-2 documents); same failure
 * classes:
 *   1. the XML does not parse at all,
 *   2. the root is not `<CreditNote>`,
 *   3. one of the handful of mandatory PINT-OM elements is missing.
 *
 * Deeper semantic / Schematron checks live in the regime rule pack
 * and are stage-shared with Invoice (the semantic invoice shape is
 * the same, only the syntax root differs).
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type ParseCreditNoteResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errors: string[] };

const MANDATORY_PATHS: Array<[string, (cn: Record<string, unknown>) => boolean]> = [
  ['CreditNote/cbc:CustomizationID', (cn) => hasText(cn['cbc:CustomizationID'])],
  ['CreditNote/cbc:ProfileID', (cn) => hasText(cn['cbc:ProfileID'])],
  ['CreditNote/cbc:ID', (cn) => hasText(cn['cbc:ID'])],
  ['CreditNote/cbc:IssueDate', (cn) => hasText(cn['cbc:IssueDate'])],
  ['CreditNote/cbc:CreditNoteTypeCode', (cn) => hasText(cn['cbc:CreditNoteTypeCode'])],
  ['CreditNote/cbc:DocumentCurrencyCode', (cn) => hasText(cn['cbc:DocumentCurrencyCode'])],
  // Credit notes MUST reference an original invoice (Oman VAT law +
  // Peppol BR-CO-25).
  ['CreditNote/cac:BillingReference', (cn) => isNonEmptyObject(cn['cac:BillingReference'])],
  ['CreditNote/cac:LegalMonetaryTotal', (cn) => isNonEmptyObject(cn['cac:LegalMonetaryTotal'])],
  [
    'CreditNote/cac:CreditNoteLine',
    (cn) => {
      const l = cn['cac:CreditNoteLine'];
      if (l === undefined || l === null) return false;
      if (Array.isArray(l)) return l.length >= 1;
      return isNonEmptyObject(l);
    },
  ],
];

function hasText(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number' || typeof v === 'boolean') return true;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return false;
}

function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v as object).length > 0
  );
}

export function parseCreditNote(xml: string): ParseCreditNoteResult {
  const valid = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (valid !== true) {
    const msg =
      (valid as { err?: { msg?: string } })?.err?.msg ?? 'invalid XML';
    return { ok: false, errors: [`xml_wellformedness: ${msg}`] };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    removeNSPrefix: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    const msg = (e as { message?: string } | undefined)?.message ?? 'unknown parse failure';
    return { ok: false, errors: [`parse_error: ${msg}`] };
  }

  const creditNote = parsed?.CreditNote;
  if (!isNonEmptyObject(creditNote)) {
    return { ok: false, errors: ['CreditNote'] };
  }

  const missing: string[] = [];
  for (const [path, check] of MANDATORY_PATHS) {
    if (!check(creditNote)) missing.push(path);
  }
  if (missing.length > 0) return { ok: false, errors: missing };

  return { ok: true, data: parsed };
}
