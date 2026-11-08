/**
 * Validation types for the compliance validation pipeline.
 *
 * The pipeline runs four stages — canonical (zod shape), VAT math,
 * UBL structural (xsd-lite) and business-rule (schematron-lite) — and
 * aggregates `ValidationIssue`s from each into a single
 * `ValidationReport`. Severity splits issues into blocking errors
 * (gate `ok=false`) and warnings (reported but non-blocking).
 *
 * Rule names use short, stable prefixes so downstream tooling (CI
 * reports, admin dashboards, QA fixtures) can map rule → regime
 * document without re-parsing the message string:
 *   - `OM-VAT-*`   from vat-math
 *   - `OM-XSD-*`   from xsd-lite
 *   - `BR-*`       from schematron-lite (EN 16931 + PINT-OM invariants)
 *   - `CANON-*`    from the canonical zod stage
 */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  stage: 'canonical' | 'vat' | 'xsd' | 'schematron';
  rule: string;
  path?: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  rulePackVersion: string;
}
