/**
 * PINT-OM identifier constants.
 *
 * These are the Peppol International (PINT) Billing specification
 * identifiers for the Oman regime. They are stable per rule-pack
 * release and are what the UBL `cbc:CustomizationID` /
 * `cbc:ProfileID` elements carry on every PINT-OM invoice we emit.
 *
 * `PINT_OM_RULE_PACK_VERSION` tags the exact bundle of validation
 * rules and codelists this build was certified against; it is NOT
 * stamped into the XML but IS surfaced on the API /meta endpoint
 * so downstream agents (checker, clearance) can echo expectations.
 */
export const PINT_OM_CUSTOMIZATION_ID = 'urn:peppol:pint:billing-1@om-1';
export const PINT_OM_PROFILE_ID = 'urn:peppol:bis:billing';
export const PINT_OM_RULE_PACK_VERSION = '0.1.0-pint-om';
