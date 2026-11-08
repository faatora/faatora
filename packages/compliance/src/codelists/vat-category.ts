/**
 * UNTDID 5305 category codes we accept. Each row carries the code,
 * a short human label, and a long description for UI/help text.
 *
 * Mapped to BT-118 (VAT category code) and BT-152 (line VAT category
 * code) in the EN 16931 semantic layer.
 */
export const VAT_CATEGORIES = [
  { code: 'S', label: 'Standard', description: 'Standard rate' },
  { code: 'Z', label: 'Zero', description: 'Zero-rated goods' },
  { code: 'E', label: 'Exempt', description: 'Exempt from tax' },
  { code: 'O', label: 'Out of scope', description: 'Services outside scope of tax' },
] as const;

export type VatCategoryCode = (typeof VAT_CATEGORIES)[number]['code'];

const VAT_CATEGORY_CODES: ReadonlySet<string> = new Set(VAT_CATEGORIES.map((c) => c.code));

export function isValidVatCategory(code: string): code is VatCategoryCode {
  return VAT_CATEGORY_CODES.has(code);
}
