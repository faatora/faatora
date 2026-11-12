/**
 * Peppol identifier formatting and parsing helpers.
 *
 * Peppol serializes identifiers in a "scheme::value" CEF form, used
 * everywhere from SMP lookups to AS4 `PartyId` elements. The format
 * is deceptively simple — it is purely textual — but a wrong scheme
 * or a stray space will make the receiver's SMP fail to resolve, so
 * these helpers exist to keep formatting/parsing in one audited
 * place.
 *
 * Document type identifiers are compound: the "value" half itself is
 *   <rootNs>::<localName>##<customizationId>::<ublVersion>
 * This module parses and reconstructs that compound form.
 */

import {
  PEPPOL,
  type PeppolDocumentTypeId,
  type PeppolParticipantId,
  type PeppolProcessId,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Participant IDs                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Format a Peppol participant identifier as the canonical
 * `scheme::identifier` CEF string.
 *
 * Example:
 *   formatParticipantId({ scheme: 'iso6523-actorid-upis', identifier: '9915:om-seller-1' })
 *   // => 'iso6523-actorid-upis::9915:om-seller-1'
 *
 * Throws on empty scheme or identifier so bad config fails loud
 * rather than silently producing an unresolvable SMP key.
 */
export function formatParticipantId(id: PeppolParticipantId): string {
  if (!id.scheme) {
    throw new Error('Peppol participant ID: scheme is required');
  }
  if (!id.identifier) {
    throw new Error('Peppol participant ID: identifier is required');
  }
  return `${id.scheme}::${id.identifier}`;
}

/**
 * Parse a Peppol participant identifier of the form `scheme::identifier`.
 *
 * The separator is the literal two-character sequence `::`. The
 * identifier half may itself contain colons (it is normally
 * `<icd>:<local-id>`), so we only split on the FIRST `::`.
 */
export function parseParticipantId(raw: string): PeppolParticipantId {
  const idx = raw.indexOf('::');
  if (idx < 0) {
    throw new Error(`Peppol participant ID: expected 'scheme::identifier', got '${raw}'`);
  }
  const scheme = raw.slice(0, idx);
  const identifier = raw.slice(idx + 2);
  if (!scheme || !identifier) {
    throw new Error(`Peppol participant ID: empty scheme or identifier in '${raw}'`);
  }
  return { scheme, identifier };
}

/**
 * Convenience constructor for an ISO 6523 (Peppol default) participant ID.
 * `icd` is the Peppol-assigned issuing-code (e.g. `9915` for Oman VAT
 * for the test network), `localId` is the recipient's registered ID.
 */
export function makeIso6523ParticipantId(icd: string, localId: string): PeppolParticipantId {
  return {
    scheme: PEPPOL.participantScheme,
    identifier: `${icd}:${localId}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Document type IDs                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Format a Peppol document type identifier.
 *
 * The on-the-wire form is:
 *   <scheme>::<rootNs>::<localName>##<customizationId>::<ublVersion>
 *
 * Example (BIS Billing 3.0 invoice):
 *   busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1
 */
export function formatDocumentTypeId(id: PeppolDocumentTypeId): string {
  if (!id.scheme || !id.rootNs || !id.localName || !id.customizationId || !id.ublVersion) {
    throw new Error(
      'Peppol document type ID: scheme, rootNs, localName, customizationId, and ublVersion are all required',
    );
  }
  return `${id.scheme}::${id.rootNs}::${id.localName}##${id.customizationId}::${id.ublVersion}`;
}

/**
 * Parse a Peppol document type identifier.
 *
 * Grammar (split from left to right):
 *   <scheme> "::" <rootNs> "::" <localName> "##" <customizationId> "::" <ublVersion>
 *
 * The `customizationId` value contains `#` and `:` characters but
 * does NOT contain `::` or `##`, so a strict left-to-right split is
 * unambiguous.
 */
export function parseDocumentTypeId(raw: string): PeppolDocumentTypeId {
  const schemeEnd = raw.indexOf('::');
  if (schemeEnd < 0) {
    throw new Error(`Peppol document type ID: missing scheme separator in '${raw}'`);
  }
  const scheme = raw.slice(0, schemeEnd);
  const rest = raw.slice(schemeEnd + 2);

  const rootNsEnd = rest.indexOf('::');
  if (rootNsEnd < 0) {
    throw new Error(`Peppol document type ID: missing rootNs separator in '${raw}'`);
  }
  const rootNs = rest.slice(0, rootNsEnd);
  const afterRoot = rest.slice(rootNsEnd + 2);

  const hashIdx = afterRoot.indexOf('##');
  if (hashIdx < 0) {
    throw new Error(`Peppol document type ID: missing '##' separator in '${raw}'`);
  }
  const localName = afterRoot.slice(0, hashIdx);
  const afterHash = afterRoot.slice(hashIdx + 2);

  // ublVersion is the final `::`-delimited segment. CustomizationID can
  // itself contain `::`-adjacent text in theory, but Peppol
  // CustomizationID values never embed `::`, so last-occurrence is safe.
  const versionIdx = afterHash.lastIndexOf('::');
  if (versionIdx < 0) {
    throw new Error(`Peppol document type ID: missing ublVersion separator in '${raw}'`);
  }
  const customizationId = afterHash.slice(0, versionIdx);
  const ublVersion = afterHash.slice(versionIdx + 2);

  if (!scheme || !rootNs || !localName || !customizationId || !ublVersion) {
    throw new Error(`Peppol document type ID: empty component in '${raw}'`);
  }
  return { scheme, rootNs, localName, customizationId, ublVersion };
}

/**
 * The Peppol BIS Billing 3.0 Invoice document type ID.
 * Frozen so callers cannot mutate the shared literal.
 */
export const PEPPOL_BIS_BILLING_3_INVOICE: PeppolDocumentTypeId = Object.freeze({
  scheme: PEPPOL.documentTypeScheme,
  rootNs: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  localName: 'Invoice',
  customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
  ublVersion: '2.1',
});

/**
 * The Peppol BIS Billing 3.0 Credit Note document type ID.
 */
export const PEPPOL_BIS_BILLING_3_CREDIT_NOTE: PeppolDocumentTypeId = Object.freeze({
  scheme: PEPPOL.documentTypeScheme,
  rootNs: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  localName: 'CreditNote',
  customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
  ublVersion: '2.1',
});

/* -------------------------------------------------------------------------- */
/* Process IDs                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The Peppol BIS Billing 3.0 process identifier (the AS4 `eb:Service` value).
 */
export const PEPPOL_BIS_BILLING_3_PROCESS: PeppolProcessId = Object.freeze({
  scheme: PEPPOL.processScheme,
  value: PEPPOL.billingProcessId,
});
