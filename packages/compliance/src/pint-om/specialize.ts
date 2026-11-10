/**
 * Pure specialisation from the regime-agnostic EN 16931 semantic
 * invoice to the PINT-OM shape.
 *
 * No arithmetic happens here: totals, VAT breakdown rows and line
 * net amounts are already final at the semantic layer (see
 * `semantic/map.ts`). This step purely stamps PINT-OM identifiers
 * and the Oman VAT scheme onto parties so the UBL serialiser (next
 * layer) and downstream validators can tell this is an Oman
 * invoice without re-sniffing the country code.
 */

import type { SemanticInvoice, SemanticParty } from '../semantic/en16931.js';
import { PINT_OM_CUSTOMIZATION_ID, PINT_OM_PROFILE_ID } from './customisation.js';
import type { PintOmInvoice, PintOmParty } from './types.js';

/**
 * The scheme identifier we use for Oman tax-registered parties.
 * Mirrors the `OM:VAT` convention used elsewhere in Faatora (JWS
 * subject claims, Peppol participant endpoints).
 */
export const OM_VAT_SCHEME = 'OM:VAT';

function specializeParty(p: SemanticParty): PintOmParty {
  return {
    bt27_name: p.bt27_name,
    bt31_vatIdentifier: p.bt31_vatIdentifier,
    bt40_countryCode: p.bt40_countryCode,
    peppolId: p.peppolId,
    address: p.address,
    // Only emit the scheme tag when the party actually has a VATIN.
    // A buyer missing a VATIN (e.g. B2C) stays scheme-less rather
    // than carrying an orphaned `OM:VAT` label.
    vatinScheme: p.bt31_vatIdentifier ? OM_VAT_SCHEME : undefined,
  };
}

export function semanticToPintOm(
  semantic: SemanticInvoice,
  opts: { documentUuid?: string } = {},
): PintOmInvoice {
  return {
    bt1_invoiceNumber: semantic.bt1_invoiceNumber,
    bt2_issueDate: semantic.bt2_issueDate,
    bt3_typeCode: semantic.bt3_typeCode,
    bt5_currencyCode: semantic.bt5_currencyCode,
    bt13_purchaseOrderReference: semantic.bt13_purchaseOrderReference,
    bt22_invoiceNote: semantic.bt22_invoiceNote,
    bt24_specificationVersion: semantic.bt24_specificationVersion,
    supplier: specializeParty(semantic.supplier),
    buyer: specializeParty(semantic.buyer),
    bg25_lines: semantic.bg25_lines,
    bg23_vatBreakdown: semantic.bg23_vatBreakdown,
    bg22_documentTotals: semantic.bg22_documentTotals,
    _canonicalId: semantic._canonicalId,
    customizationId: PINT_OM_CUSTOMIZATION_ID,
    profileId: PINT_OM_PROFILE_ID,
    documentUuid: opts.documentUuid,
  };
}
