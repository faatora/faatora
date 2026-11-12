export * from './canonical/types.js';
export * from './canonical/zod.js';
export * from './semantic/en16931.js';
export * from './semantic/map.js';
export * from './codelists/currency.js';
export * from './codelists/country.js';
export * from './codelists/vat-category.js';
export * from './codelists/unit.js';
export * from './pint-om/customisation.js';
export * from './pint-om/types.js';
export * from './pint-om/specialize.js';
export * from './ubl/serializer.js';
export * from './ubl/parser.js';
export * from './ubl/credit-note.js';
export * from './ubl/credit-note-parser.js';
export * from './ubl/debit-note.js';

export const COMPLIANCE_CORE_VERSION = '0.1.0-ep4';

// Validation pipeline (A13).
//
// `ValidationIssue` and `ValidationReport` are explicit named
// re-exports here because `canonical/zod.ts` already exports a
// (different, legacy) `ValidationIssue` shape via `export *` above.
// Explicit named re-exports win over `export *` in ESM resolution,
// so consumers of the barrel always get the pipeline shape.
export type { ValidationIssue, ValidationReport } from './validate/types.js';
export * from './validate/vat-math.js';
export * from './validate/xsd-lite.js';
export * from './validate/schematron-lite.js';
export * from './validate/pipeline.js';
