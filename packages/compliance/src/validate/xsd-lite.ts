/**
 * UBL structural (XSD-lite) validator.
 *
 * This is not a full XSD 1.1 engine; it reuses the existing
 * well-formedness + mandatory-element parser (`parseUbl`) to produce
 * one `ValidationIssue` per missing or malformed structural element.
 *
 * Rules:
 *   OM-XSD-001 — XML must be well-formed
 *   OM-XSD-002 — root element must be <Invoice>
 *   OM-XSD-003 — mandatory UBL child element is missing / empty
 */

import { parseUbl } from '../ubl/parser.js';
import type { ValidationIssue } from './types.js';

function err(rule: string, message: string, path?: string): ValidationIssue {
  return { severity: 'error', stage: 'xsd', rule, message, path };
}

export function validateUblStructure(xml: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
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
    // Mandatory-child paths come back as e.g. "Invoice/cbc:CustomizationID".
    issues.push(err('OM-XSD-003', `mandatory element missing or empty: ${errMsg}`, errMsg));
  }
  return issues;
}
