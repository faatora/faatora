/**
 * ISO 3166-1 alpha-2 country codes we recognise for parties on an
 * invoice. Covers the full GCC plus the usual trading-partner set
 * for Omani businesses.
 */
export const SUPPORTED_COUNTRIES = [
  // GCC
  'OM', // Oman
  'AE', // United Arab Emirates
  'SA', // Saudi Arabia
  'BH', // Bahrain
  'KW', // Kuwait
  'QA', // Qatar
  // Nearby / common trading partners
  'IN', // India
  'PK', // Pakistan
  'EG', // Egypt
  'JO', // Jordan
  'TR', // Turkey
  'GB', // United Kingdom
  'US', // United States
  'DE', // Germany
  'FR', // France
  'NL', // Netherlands
  'CN', // China
] as const;

export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number];

export function isValidCountry(code: string): code is SupportedCountry {
  return (SUPPORTED_COUNTRIES as readonly string[]).includes(code);
}
