/**
 * ISO 4217 currency codes supported end-to-end by Fawtara.
 *
 * The list is intentionally narrow: we start with OMR (home) plus
 * the four cross-border currencies our Omani SMBs invoice in most
 * often. Expanding this list is a product decision, not a technical
 * one — downstream mappers assume anything that reaches them is
 * already allow-listed here.
 */
export const SUPPORTED_CURRENCIES = ['OMR', 'USD', 'EUR', 'AED', 'SAR'] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Minor-unit (fractional) scale per supported currency.
 *
 * OMR uses 3 decimals (baisa, 1 OMR = 1000 baisa). The others use the
 * usual 2-decimal "cents" scale. The semantic mapper uses `10^scale`
 * when quantising to avoid floating-point drift.
 */
export const CURRENCY_SCALE: Record<SupportedCurrency, number> = {
  OMR: 3,
  USD: 2,
  EUR: 2,
  AED: 2,
  SAR: 2,
};

export function isValidCurrency(code: string): code is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}
