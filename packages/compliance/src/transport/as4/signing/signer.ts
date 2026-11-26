/**
 * The XMLDsig / XAdES-BES signing port.
 *
 * Every AS4 message Peppol transmits is signed with an XML-Signature
 * conforming to the AS4 Signing Profile (OASIS AS4 §5.1.6) and
 * further profiled by Peppol TIA v2.0 §3.5 as XAdES-BES. The signing
 * covers:
 *
 *   1. the `<eb:Messaging>` SOAP header element (referenced by the
 *      `wsu:Id` attribute the message-XML builder put on it), and
 *   2. each payload attachment (referenced by its MIME `Content-Id`).
 *
 * In the §5.7 subcontractor model the signing key lives at the
 * partner ASP's boundary; Faatora's binary never holds it. In the
 * direct-connect mode that this module targets, the signing key
 * lives in KMS and is accessed through a `Signer` implementation.
 * Either way, the rest of the codebase depends on this interface
 * only — so the signer can be a KMS client, a `node:crypto` signer
 * reading a PKCS#12 file, or the stub in `stub-signer.ts`.
 *
 * References:
 *   - W3C XML Signature Syntax and Processing (Second Edition), §4
 *   - ETSI EN 319 132-1 (XAdES Baseline) §4
 *   - OASIS AS4 Profile of ebMS 3.0 v1.0 §5.1.6
 *   - OpenPeppol TIA v2.0 §3.5 (XAdES-BES)
 */

/**
 * A reference to a key held by a `Signer`.
 *
 * The exact meaning depends on the implementation: for the stub,
 * it is a free-form label; for a KMS-backed signer, it is the KMS
 * key ARN or key-id; for a local-PKCS12 signer, it is the alias
 * inside the keystore. The port only promises that `signer.sign`
 * will resolve it to a key or raise `InvalidKeyReferenceError`.
 */
export interface SigningKeyReference {
  /** Opaque identifier; the signer knows how to resolve it. */
  readonly keyRef: string;
}

/**
 * Error raised by a signer when the supplied `SigningKeyReference`
 * does not resolve to a usable key. Signer implementations should
 * use this type (rather than a generic Error) so the caller can
 * distinguish a key-management failure from a transport failure.
 */
export class InvalidKeyReferenceError extends Error {
  constructor(keyRef: string, detail?: string) {
    super(`Invalid signing key reference '${keyRef}'${detail ? `: ${detail}` : ''}`);
    this.name = 'InvalidKeyReferenceError';
  }
}

/**
 * Input to `Signer.sign`. The signer produces a `<ds:Signature>`
 * element that references each `targets` entry by its `wsu:Id` (for
 * the SOAP header subtree) or by its `Content-Id` (for MIME
 * attachments).
 *
 * Peppol TIA v2.0 §3.5 pins the algorithms:
 *   - CanonicalizationMethod: Exclusive C14N (`xml-exc-c14n#`)
 *   - SignatureMethod:         `rsa-sha256`
 *   - DigestMethod:            `sha256`
 *
 * These are not knobs here — a real signer must use them exactly.
 */
export interface SignInput {
  /** Resolves to the key the signature is built with. */
  readonly keyRef: SigningKeyReference;
  /**
   * The references the signature covers. Order is significant: the
   * `<ds:SignedInfo>` emits `<ds:Reference>` elements in this order.
   */
  readonly targets: ReadonlyArray<SignTarget>;
}

/**
 * One `<ds:Reference>` target.
 *
 * `kind: 'header'` points at a `wsu:Id`-bearing SOAP header subtree,
 * carried as the fragment identifier on `URI="#..."`. The
 * header-XML builder puts `wsu:Id="_messaging"` on `<eb:Messaging>`
 * by default; the matching target here is `{ kind: 'header', id:
 * '_messaging', xml: messagingXml }`.
 *
 * `kind: 'attachment'` points at a MIME part identified by its
 * Content-Id. AS4 / SwA signatures use `URI="cid:..."` with the
 * `xmlmime` transforms listed in the AS4 profile.
 *
 * `xml` / `bytes` are the canonicalised content to digest. The
 * caller — not the signer — is responsible for canonicalisation so
 * the signer can be a hardware module that only knows how to sign a
 * digest. The stub signer in this module skips canonicalisation
 * because its digest is a placeholder anyway.
 */
export type SignTarget =
  | {
      readonly kind: 'header';
      /** Value of the `wsu:Id` attribute on the header being signed. */
      readonly id: string;
      /** The already-canonicalised XML bytes to digest. */
      readonly xml: string;
    }
  | {
      readonly kind: 'attachment';
      /** Value of the MIME `Content-Id` (without the `<>`). */
      readonly contentId: string;
      /** The attachment bytes to digest. */
      readonly bytes: Uint8Array | string;
    };

/**
 * Output: the complete `<ds:Signature>` element as a serialized XML
 * fragment, plus a short descriptor of how it was signed, which the
 * audit trail records.
 */
export interface SignResult {
  readonly signatureXml: string;
  readonly algorithms: SignatureAlgorithms;
  /** Key-reference descriptor the caller logs for audit. */
  readonly keyRef: string;
}

export interface SignatureAlgorithms {
  readonly canonicalizationMethod: string;
  readonly signatureMethod: string;
  readonly digestMethod: string;
}

export interface Signer {
  sign(input: SignInput): Promise<SignResult>;
}

/**
 * The Peppol TIA v2.0 §3.5-pinned XMLDsig algorithm URIs. Any real
 * Signer implementation MUST use these; the stub advertises them
 * too so that integration tests that assert on the algorithm URIs
 * do not have to care whether the real or the stub signer produced
 * the signature.
 */
export const PEPPOL_SIGNATURE_ALGORITHMS: SignatureAlgorithms = Object.freeze({
  canonicalizationMethod: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  signatureMethod: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  digestMethod: 'http://www.w3.org/2001/04/xmlenc#sha256',
});
