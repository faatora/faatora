/**
 * UN/ECE Recommendation 20 unit-of-measure codes. We ship a
 * minimal subset covering the units our pilot users bill in. The
 * list grows per customer request, not speculatively — mappers that
 * see an unknown code refuse the document.
 */
export const SUPPORTED_UNITS = [
  { code: 'C62', label: 'unit' },
  { code: 'KGM', label: 'kilogram' },
  { code: 'LTR', label: 'litre' },
  { code: 'HUR', label: 'hour' },
  { code: 'DAY', label: 'day' },
  { code: 'MTR', label: 'metre' },
] as const;

export type UnitCode = (typeof SUPPORTED_UNITS)[number]['code'];

/** Canonical default when callers do not specify a unit. */
export const DEFAULT_UNIT_CODE: UnitCode = 'C62';

const UNIT_CODES: ReadonlySet<string> = new Set(SUPPORTED_UNITS.map((u) => u.code));

export function isValidUnit(code: string): code is UnitCode {
  return UNIT_CODES.has(code);
}
