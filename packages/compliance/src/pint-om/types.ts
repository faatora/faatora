/**
 * PINT-OM invoice shape.
 *
 * This is the EN 16931 semantic invoice (regime-agnostic) specialised
 * for Oman:
 *  - `customizationId` / `profileId` carry the fixed PINT-OM URNs.
 *  - supplier / buyer VATINs are tagged with the Oman `OM:VAT` scheme
 *    so downstream validators (and the UBL serialiser, if we later
 *    choose to stamp a `schemeID`) can tell country/scheme apart.
 *  - `documentUuid` is reserved here; signing (A6) assigns it, but
 *    we accept it on the input side so that cleared / signed re-renders
 *    stay deterministic.
 */

import type { SemanticInvoice, SemanticParty } from '../semantic/en16931.js';

export interface PintOmParty extends SemanticParty {
  /**
   * Scheme identifier for the party's VAT ID.
   * For Oman tax-registered parties this is `OM:VAT`.
   * Undefined when the party carries no VATIN at all.
   */
  vatinScheme?: string;
}

export interface PintOmInvoice extends Omit<SemanticInvoice, 'supplier' | 'buyer'> {
  /** `cbc:CustomizationID` value, e.g. `urn:peppol:pint:billing-1@om-1`. */
  customizationId: string;
  /** `cbc:ProfileID` value, e.g. `urn:peppol:bis:billing`. */
  profileId: string;
  supplier: PintOmParty;
  buyer: PintOmParty;
  /**
   * Document-level UUID. Not required at this layer, but stamped as
   * `cbc:UUID` in the UBL output when present. The signing module
   * (A6) is the authoritative source of this value.
   */
  documentUuid?: string;
}
