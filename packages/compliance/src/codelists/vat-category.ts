/**
 * UNTDID 5305 duty/tax/fee category codes supported by Faatora for
 * the Oman regime (Royal Decree 121/2020, in force since 2021-04-16).
 *
 * The code's BT-118 / BT-152 value in the EN 16931 semantic layer
 * doubles as its Peppol / PINT-OM code — they are identical glyphs.
 *
 * Category metadata carries the three axes the downstream engine needs:
 *  - `rateMode`    : how to read `bt119_categoryRate` / `bt153_itemVatRate`
 *                    for this category:
 *                      "positive"  rate must be > 0            (S)
 *                      "zero"      rate must be exactly 0      (Z, E, O, AE)
 *  - `reverseCharge`: true when the buyer accounts for VAT, not the
 *                    seller — the invoice tax amount is zero but the
 *                    liability remains (cross-border B2B).
 *  - `requiresExemptionReason`: true when Omani rules expect an
 *                    exemption / zero-rating code to accompany the
 *                    line (Z, E, O, AE).
 *
 * The narrow canonical type `VatCategory` in `canonical/types.ts`
 * still lists only `S | Z | E | O` because `AE` arrives through the
 * direct-semantic pipeline entry point (cross-border B2B flows build
 * their semantic invoice outside the canonical model). The validation
 * layer treats the code field as a string and consults this codelist
 * as the single source of truth.
 */
export interface VatCategoryDescriptor {
  /** UNTDID 5305 / Peppol single-letter code. */
  code: string;
  /** Short human label (UI). */
  label: string;
  /** Long description (UI help text). */
  description: string;
  /** How the paired rate value is constrained. */
  rateMode: 'positive' | 'zero';
  /** Buyer accounts for VAT — invoice tax amount is 0. */
  reverseCharge: boolean;
  /**
   * Whether an exemption / zero-rating reason is expected on the
   * line or the breakdown row. Enforced by rule `OM-R-04`.
   */
  requiresExemptionReason: boolean;
}

export const VAT_CATEGORIES: readonly VatCategoryDescriptor[] = [
  {
    code: 'S',
    label: 'Standard',
    description: 'Standard rate (5% in Oman).',
    rateMode: 'positive',
    reverseCharge: false,
    requiresExemptionReason: false,
  },
  {
    code: 'Z',
    label: 'Zero',
    description:
      'Zero-rated goods and services (exports, qualifying agriculture/fisheries investments, ' +
      'medicines, medical equipment, international transport).',
    rateMode: 'zero',
    reverseCharge: false,
    requiresExemptionReason: true,
  },
  {
    code: 'E',
    label: 'Exempt',
    description:
      'Exempt from VAT (financial services, residential leases, undeveloped land, bare metals, ' +
      'local passenger transport).',
    rateMode: 'zero',
    reverseCharge: false,
    requiresExemptionReason: true,
  },
  {
    code: 'O',
    label: 'Out of scope',
    description:
      'Transaction falls outside Oman VAT territorial scope (e.g., services consumed outside ' +
      'Oman by non-residents).',
    rateMode: 'zero',
    reverseCharge: false,
    requiresExemptionReason: true,
  },
  {
    code: 'AE',
    label: 'Reverse charge',
    description:
      'B2B cross-border — buyer accounts for VAT, not the seller. Invoice tax amount is 0; ' +
      'a mandatory note states the buyer is liable.',
    rateMode: 'zero',
    reverseCharge: true,
    requiresExemptionReason: true,
  },
] as const;

export type VatCategoryCode = (typeof VAT_CATEGORIES)[number]['code'];

const VAT_CATEGORY_INDEX: ReadonlyMap<string, VatCategoryDescriptor> = new Map(
  VAT_CATEGORIES.map((c) => [c.code, c]),
);

export function isValidVatCategory(code: string): code is VatCategoryCode {
  return VAT_CATEGORY_INDEX.has(code);
}

/**
 * Look up the descriptor for a category code. Returns `undefined`
 * when the code is not one of the five supported. Callers that need
 * to short-circuit on unknown codes should check `isValidVatCategory`
 * first; everything else can ask for the descriptor and branch on
 * the flag set.
 */
export function getVatCategory(code: string): VatCategoryDescriptor | undefined {
  return VAT_CATEGORY_INDEX.get(code);
}

/** True when the category means "buyer accounts for VAT". */
export function isReverseCharge(code: string): boolean {
  return VAT_CATEGORY_INDEX.get(code)?.reverseCharge === true;
}

/** True when the category requires an exemption / zero-rating reason. */
export function requiresExemptionReason(code: string): boolean {
  return VAT_CATEGORY_INDEX.get(code)?.requiresExemptionReason === true;
}
