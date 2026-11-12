/**
 * UBL structural (XSD-lite) validator.
 *
 * This is not a full XSD 1.1 engine; it reuses the existing
 * well-formedness + mandatory-element parsers (`parseUbl` for Invoice-2,
 * `parseCreditNote` for CreditNote-2) to produce one `ValidationIssue`
 * per missing or malformed structural element.
 *
 * The validator sniffs the root element from the XML prefix so a
 * caller can hand in either an Invoice (including debit-note shaped
 * invoices with type code 383) or a CreditNote without a separate
 * document-type parameter.
 *
 * Rules:
 *   OM-XSD-001 — XML must be well-formed
 *   OM-XSD-002 — root element must be <Invoice> or <CreditNote>
 *   OM-XSD-003 — mandatory UBL child element is missing / empty
 */

import { parseUbl } from '../ubl/parser.js';
import { parseCreditNote } from '../ubl/credit-note-parser.js';
import type { ValidationIssue } from './types.js';

function err(rule: string, message: string, path?: string): ValidationIssue {
  return { severity: 'error', stage: 'xsd', rule, message, path };
}

/**
 * Determine the document kind from the XML body. We scan for the first
 * element after the XML declaration rather than fully parse, so an
 * unparseable document still reaches the parser's well-formedness
 * error path with a specific message.
 */
function sniffRoot(xml: string): 'invoice' | 'credit-note' | 'unknown' {
  // Skip the XML prolog if present.
  const body = xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
  const m = body.match(/^<([A-Za-z_][A-Za-z0-9._:-]*)/);
  if (!m) return 'unknown';
  const name = m[1];
  if (name === 'Invoice') return 'invoice';
  if (name === 'CreditNote') return 'credit-note';
  return 'unknown';
}

export function validateUblStructure(xml: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kind = sniffRoot(xml);

  if (kind === 'credit-note') {
    const result = parseCreditNote(xml);
    if (result.ok) return issues;
    for (const errMsg of result.errors) {
      if (errMsg.startsWith('xml_wellformedness:') || errMsg.startsWith('parse_error:')) {
        issues.push(err('OM-XSD-001', errMsg));
        continue;
      }
      if (errMsg === 'CreditNote') {
        issues.push(err('OM-XSD-002', 'root element must be <CreditNote>', 'CreditNote'));
        continue;
      }
      issues.push(err('OM-XSD-003', `mandatory element missing or empty: ${errMsg}`, errMsg));
    }
    return issues;
  }

  // Invoice-2 path (covers both commercial invoices and debit notes,
  // which Peppol BIS Billing 3.0 represents as Invoice-2 with type
  // code 383).
  const result = parseUbl(xml);
  if (result.ok) return issues;

  for (const errMsg of result.errors) {
    if (errMsg.startsWith('xml_wellformedness:') || errMsg.startsWith('parse_error:')) {
      issues.push(err('OM-XSD-001', errMsg));
      continue;
    }
    if (errMsg === 'Invoice') {
      issues.push(err('OM-XSD-002', 'root element must be <Invoice>', 'Invoice'));
      continue;
    }
    issues.push(err('OM-XSD-003', `mandatory element missing or empty: ${errMsg}`, errMsg));
  }
  return issues;
}
