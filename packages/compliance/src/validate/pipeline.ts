/**
 * End-to-end validation pipeline.
 *
 * Threads a canonical / semantic / pint-om / UBL quad through the
 * four stages (canonical zod, VAT math, UBL structure, Schematron-lite)
 * and emits a single `ValidationReport`. Each stage only runs when it
 * has an input to validate, and later stages lazily derive their input
 * from earlier ones so a caller can hand in just a `CanonicalInvoice`
 * and get the full report back.
 *
 * Flow:
 *   1. canonical (zod)      — if given, early-exit on shape errors
 *   2. canonical → semantic — derive when semantic is absent
 *   3. VAT math             — runs on the semantic invoice
 *   4. semantic → pint-om   — derive when pint-om is absent
 *   5. pint-om → UBL        — derive when UBL is absent
 *   6. XSD-lite             — structural checks on the UBL
 *   7. Schematron-lite      — business rules on the semantic invoice
 *   8. `ok = errors.length === 0`
 */

import type { CanonicalInvoice } from '../canonical/types.js';
import { validateCanonical } from '../canonical/zod.js';
import { PINT_OM_RULE_PACK_VERSION } from '../pint-om/customisation.js';
import { semanticToPintOm } from '../pint-om/specialize.js';
import type { PintOmInvoice } from '../pint-om/types.js';
import type { SemanticInvoice } from '../semantic/en16931.js';
import { canonicalToSemantic } from '../semantic/map.js';
import { pintOmToUbl } from '../ubl/serializer.js';
import { runSchematron } from './schematron-lite.js';
import type { ValidationIssue, ValidationReport } from './types.js';
import { validateVatArithmetic } from './vat-math.js';
import { validateUblStructure } from './xsd-lite.js';

export interface PipelineInput {
  canonical?: CanonicalInvoice;
  semantic?: SemanticInvoice;
  pintOm?: PintOmInvoice;
  ubl?: string;
}

function split(issues: ValidationIssue[]): {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
} {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const i of issues) {
    (i.severity === 'error' ? errors : warnings).push(i);
  }
  return { errors, warnings };
}

export function validateInvoice(input: PipelineInput): ValidationReport {
  const collected: ValidationIssue[] = [];

  let semantic = input.semantic;

  // 1. Canonical shape (early-exit on hard shape errors — downstream
  //    stages would just throw on missing/malformed fields).
  if (input.canonical !== undefined) {
    const canonicalResult = validateCanonical(input.canonical);
    if (!canonicalResult.ok) {
      for (const e of canonicalResult.errors) {
        collected.push({
          severity: 'error',
          stage: 'canonical',
          rule: 'CANON-001',
          path: e.path,
          message: e.message,
        });
      }
      const { errors, warnings } = split(collected);
      return {
        ok: false,
        errors,
        warnings,
        rulePackVersion: PINT_OM_RULE_PACK_VERSION,
      };
    }

    // 2. canonical → semantic.
    if (semantic === undefined) {
      semantic = canonicalToSemantic(canonicalResult.data);
    }
  }

  // 3. VAT math (requires semantic).
  if (semantic !== undefined) {
    collected.push(...validateVatArithmetic(semantic));
  }

  // 4. semantic → pint-om.
  let pintOm = input.pintOm;
  if (pintOm === undefined && semantic !== undefined) {
    pintOm = semanticToPintOm(semantic);
  }

  // 5. pint-om → UBL.
  let ubl = input.ubl;
  if (ubl === undefined && pintOm !== undefined) {
    ubl = pintOmToUbl(pintOm);
  }

  // 6. XSD-lite.
  if (ubl !== undefined) {
    collected.push(...validateUblStructure(ubl));
  }

  // 7. Schematron-lite (business rules).
  if (semantic !== undefined) {
    collected.push(...runSchematron(semantic));
  }

  const { errors, warnings } = split(collected);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    rulePackVersion: PINT_OM_RULE_PACK_VERSION,
  };
}
