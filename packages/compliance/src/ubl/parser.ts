/**
 * UBL 2.1 Invoice parser (structural well-formedness only).
 *
 * This is NOT an XSD validator. Its job is to catch three classes of
 * failure before downstream signing / clearance even looks at the
 * payload:
 *   1. the XML does not parse at all,
 *   2. the root is not `<Invoice>`,
 *   3. one of the handful of mandatory PINT-OM elements is missing.
 *
 * Deeper semantic checks (BR-* rules, VAT breakdown totals, VATIN
 * format) live in the regime rule-pack that A7 wires up.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type ParseUblResult =
  { ok: true; data: Record<string, any> } | { ok: false; errors: string[] };

const MANDATORY_PATHS: Array<[string, (inv: any) => boolean]> = [
  ['Invoice/cbc:CustomizationID', (inv) => hasText(inv['cbc:CustomizationID'])],
  ['Invoice/cbc:ProfileID', (inv) => hasText(inv['cbc:ProfileID'])],
  ['Invoice/cbc:ID', (inv) => hasText(inv['cbc:ID'])],
  ['Invoice/cbc:IssueDate', (inv) => hasText(inv['cbc:IssueDate'])],
  ['Invoice/cbc:InvoiceTypeCode', (inv) => hasText(inv['cbc:InvoiceTypeCode'])],
  ['Invoice/cbc:DocumentCurrencyCode', (inv) => hasText(inv['cbc:DocumentCurrencyCode'])],
  ['Invoice/cac:LegalMonetaryTotal', (inv) => isNonEmptyObject(inv['cac:LegalMonetaryTotal'])],
  [
    'Invoice/cac:InvoiceLine',
    (inv) => {
      const l = inv['cac:InvoiceLine'];
      if (l === undefined || l === null) return false;
      if (Array.isArray(l)) return l.length >= 1;
      // Single-line docs come back as a plain object, not an array.
      return isNonEmptyObject(l);
    },
  ],
];

function hasText(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number' || typeof v === 'boolean') return true;
  // fast-xml-parser may wrap `<Foo attr="x">text</Foo>` as an object.
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return false;
}

function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v as object).length > 0
  );
}

export function parseUbl(xml: string): ParseUblResult {
  // Structural XML well-formedness first — much better error strings
  // than a raw parser.parse() throw.
  const valid = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (valid !== true) {
    const msg = valid?.err?.msg ?? 'invalid XML';
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

  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch (e: any) {
    return {
      ok: false,
      errors: [`parse_error: ${e?.message ?? 'unknown parse failure'}`],
    };
  }

  const invoice = parsed?.Invoice;
  if (!isNonEmptyObject(invoice)) {
    return { ok: false, errors: ['Invoice'] };
  }

  const missing: string[] = [];
  for (const [path, check] of MANDATORY_PATHS) {
    if (!check(invoice)) missing.push(path);
  }
  if (missing.length > 0) return { ok: false, errors: missing };

  return { ok: true, data: parsed };
}
