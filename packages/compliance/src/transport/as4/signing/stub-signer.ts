/**
 * StubSigner — a signer that produces a structurally-valid
 * `<ds:Signature>` with a DETERMINISTIC dummy digest.
 *
 * Purpose: let the envelope + SOAP + HTTP layers be exercised end to
 * end before the real KMS wiring is available. The output fragment
 * is schema-valid against XMLDsig-core.xsd (W3C XML Signature Syntax
 * and Processing, Second Edition) and XAdES-core.xsd 1.3.2 at the
 * element-structure level, so an XSD-driven partner can parse it.
 * The digest and signature bytes are NOT cryptographic — any real
 * verifier WILL (and should) reject the stub's output.
 *
 * Determinism: given the same inputs, the stub returns byte-identical
 * output. Non-deterministic bits — the XAdES SigningTime and the
 * X509 SerialNumber — are optional constructor overrides so tests
 * can pin them.
 *
 * Drop-in: `StubSigner` implements the `Signer` interface. A real
 * KMS-backed signer is a straight substitution at the DI layer.
 *
 * References:
 *   - W3C XML Signature Syntax and Processing (Second Edition), §4
 *   - ETSI EN 319 132-1 (XAdES Baseline Profile), §4
 *   - OpenPeppol TIA v2.0 §3.5
 */

import { createHash } from 'node:crypto';

import { XML_NS } from '../types.js';
import {
  PEPPOL_SIGNATURE_ALGORITHMS,
  type SignInput,
  type SignResult,
  type Signer,
  type SignTarget,
} from './signer.js';

export interface StubSignerOptions {
  /** Pin the XAdES SigningTime for reproducible output. */
  readonly signingTime?: string;
  /** Pin the fake X509 serial number for reproducible output. */
  readonly x509SerialNumber?: string;
  /** Pin the fake X509 issuer name. */
  readonly x509IssuerName?: string;
  /** Pin the fake base64 SignatureValue. */
  readonly signatureValue?: string;
  /** Pin the fake base64 X509Certificate body. */
  readonly x509Certificate?: string;
}

/**
 * Deterministic placeholders. The signature-value and certificate
 * strings are long enough to look right in a glance, short enough
 * to keep test fixtures readable. The issuer name is written in
 * conformance-fixture style.
 */
const DEFAULTS = {
  signingTime: '2026-01-01T00:00:00.000Z',
  x509SerialNumber: '1',
  x509IssuerName: 'CN=Faatora Stub Signing CA,O=Faatora,C=OM',
  signatureValue: 'U1RVQl9TSUdfTk9UX0ZPUl9QUk9EVUNUSU9OX1VTRV9yc2Ffc2hhMjU2X2R1bW15X2Jsb2I=',
  x509Certificate: 'U1RVQl9YNTA5X0NFUlRJRklDQVRFX05PVF9GT1JfUFJPRFVDVElPTl9kdW1teV9ib2R5',
} as const;

const SIGNATURE_WSU_ID = '_signature';
const SIGNED_INFO_ID = '_signedInfo';
const KEY_INFO_ID = '_keyInfo';
const SIGNED_PROPERTIES_ID = '_signedProperties';
const SIGNED_PROPERTIES_URI = `#${SIGNED_PROPERTIES_ID}`;
const SIGNED_PROPERTIES_TYPE = 'http://uri.etsi.org/01903#SignedProperties';

export class StubSigner implements Signer {
  constructor(private readonly options: StubSignerOptions = {}) {}

  async sign(input: SignInput): Promise<SignResult> {
    if (!input.keyRef || !input.keyRef.keyRef) {
      throw new Error('StubSigner: keyRef.keyRef is required');
    }
    if (input.targets.length === 0) {
      throw new Error('StubSigner: at least one target is required');
    }

    const references = input.targets.map((t) => this.referenceFor(t));
    const signingTime = this.options.signingTime ?? DEFAULTS.signingTime;
    const serial = this.options.x509SerialNumber ?? DEFAULTS.x509SerialNumber;
    const issuer = this.options.x509IssuerName ?? DEFAULTS.x509IssuerName;
    const sigValue = this.options.signatureValue ?? DEFAULTS.signatureValue;
    const cert = this.options.x509Certificate ?? DEFAULTS.x509Certificate;

    const signatureXml = buildSignatureXml({
      references,
      signingTime,
      x509SerialNumber: serial,
      x509IssuerName: issuer,
      signatureValue: sigValue,
      x509Certificate: cert,
    });

    return {
      signatureXml,
      algorithms: PEPPOL_SIGNATURE_ALGORITHMS,
      keyRef: input.keyRef.keyRef,
    };
  }

  /**
   * Compose one `<ds:Reference>` structure. For a `header` target we
   * use `URI="#<id>"` and the `exc-c14n#` transform; for an
   * `attachment` target we use `URI="cid:<contentId>"` and the
   * AS4-mandated `xmlmime` content transforms. The DigestValue is
   * the sha256 of the input, base64-encoded — real digest bytes
   * just computed over the UNCANONICALISED input, which a real
   * verifier will reject. That is deliberate: it makes the stub
   * easy to tell apart from a real signature while still giving
   * deterministic bytes a test can assert on.
   */
  private referenceFor(target: SignTarget): ReferenceDescriptor {
    if (target.kind === 'header') {
      const digest = sha256Base64(target.xml);
      return {
        uri: `#${target.id}`,
        transforms: [PEPPOL_SIGNATURE_ALGORITHMS.canonicalizationMethod],
        digestMethod: PEPPOL_SIGNATURE_ALGORITHMS.digestMethod,
        digestValue: digest,
      };
    }
    const digest = sha256Base64(target.bytes);
    return {
      uri: `cid:${target.contentId}`,
      transforms: [
        'http://docs.oasis-open.org/wss/oasis-wss-SwAProfile-1.1#Attachment-Content-Signature-Transform',
      ],
      digestMethod: PEPPOL_SIGNATURE_ALGORITHMS.digestMethod,
      digestValue: digest,
    };
  }
}

interface ReferenceDescriptor {
  readonly uri: string;
  readonly transforms: ReadonlyArray<string>;
  readonly digestMethod: string;
  readonly digestValue: string;
}

interface SignatureXmlInput {
  readonly references: ReadonlyArray<ReferenceDescriptor>;
  readonly signingTime: string;
  readonly x509SerialNumber: string;
  readonly x509IssuerName: string;
  readonly signatureValue: string;
  readonly x509Certificate: string;
}

/**
 * Compose the `<ds:Signature>` fragment by hand (templated string
 * concatenation rather than an XMLBuilder round-trip): we need to
 * emit a very specific element order, with precise whitespace, and
 * the extra template literal keeps that visible in one place.
 */
function buildSignatureXml(input: SignatureXmlInput): string {
  const references = input.references.map(renderReference).join('\n');
  const signedProperties = renderSignedProperties(input);
  const keyInfo = renderKeyInfo(input);

  return [
    `<ds:Signature xmlns:ds="${XML_NS.ds}" xmlns:wsu="${XML_NS.wsu}" wsu:Id="${SIGNATURE_WSU_ID}">`,
    `  <ds:SignedInfo Id="${SIGNED_INFO_ID}">`,
    `    <ds:CanonicalizationMethod Algorithm="${PEPPOL_SIGNATURE_ALGORITHMS.canonicalizationMethod}"/>`,
    `    <ds:SignatureMethod Algorithm="${PEPPOL_SIGNATURE_ALGORITHMS.signatureMethod}"/>`,
    references,
    `    <ds:Reference URI="${SIGNED_PROPERTIES_URI}" Type="${SIGNED_PROPERTIES_TYPE}">`,
    `      <ds:DigestMethod Algorithm="${PEPPOL_SIGNATURE_ALGORITHMS.digestMethod}"/>`,
    `      <ds:DigestValue>${sha256Base64(signedProperties)}</ds:DigestValue>`,
    `    </ds:Reference>`,
    `  </ds:SignedInfo>`,
    `  <ds:SignatureValue>${input.signatureValue}</ds:SignatureValue>`,
    keyInfo,
    `  <ds:Object>`,
    `    <xades:QualifyingProperties xmlns:xades="${XML_NS.xades}" Target="#${SIGNATURE_WSU_ID}">`,
    signedProperties,
    `    </xades:QualifyingProperties>`,
    `  </ds:Object>`,
    `</ds:Signature>`,
  ].join('\n');
}

function renderReference(ref: ReferenceDescriptor): string {
  const transforms = ref.transforms.map((t) => `      <ds:Transform Algorithm="${t}"/>`).join('\n');
  return [
    `    <ds:Reference URI="${ref.uri}">`,
    `      <ds:Transforms>`,
    transforms,
    `      </ds:Transforms>`,
    `      <ds:DigestMethod Algorithm="${ref.digestMethod}"/>`,
    `      <ds:DigestValue>${ref.digestValue}</ds:DigestValue>`,
    `    </ds:Reference>`,
  ].join('\n');
}

function renderKeyInfo(input: SignatureXmlInput): string {
  return [
    `  <ds:KeyInfo Id="${KEY_INFO_ID}">`,
    `    <ds:X509Data>`,
    `      <ds:X509IssuerSerial>`,
    `        <ds:X509IssuerName>${input.x509IssuerName}</ds:X509IssuerName>`,
    `        <ds:X509SerialNumber>${input.x509SerialNumber}</ds:X509SerialNumber>`,
    `      </ds:X509IssuerSerial>`,
    `      <ds:X509Certificate>${input.x509Certificate}</ds:X509Certificate>`,
    `    </ds:X509Data>`,
    `  </ds:KeyInfo>`,
  ].join('\n');
}

/**
 * The XAdES `<xades:SignedProperties>` block. For BES we only need
 * `SigningTime` and `SigningCertificate` (ETSI EN 319 132-1 §4.2.1).
 * Using a fake CertDigest here keeps the structure right without
 * pretending we have a real certificate hash.
 */
function renderSignedProperties(input: SignatureXmlInput): string {
  const certDigest = sha256Base64(input.x509Certificate);
  return [
    `      <xades:SignedProperties Id="${SIGNED_PROPERTIES_ID}">`,
    `        <xades:SignedSignatureProperties>`,
    `          <xades:SigningTime>${input.signingTime}</xades:SigningTime>`,
    `          <xades:SigningCertificate>`,
    `            <xades:Cert>`,
    `              <xades:CertDigest>`,
    `                <ds:DigestMethod xmlns:ds="${XML_NS.ds}" Algorithm="${PEPPOL_SIGNATURE_ALGORITHMS.digestMethod}"/>`,
    `                <ds:DigestValue xmlns:ds="${XML_NS.ds}">${certDigest}</ds:DigestValue>`,
    `              </xades:CertDigest>`,
    `              <xades:IssuerSerial>`,
    `                <ds:X509IssuerName xmlns:ds="${XML_NS.ds}">${input.x509IssuerName}</ds:X509IssuerName>`,
    `                <ds:X509SerialNumber xmlns:ds="${XML_NS.ds}">${input.x509SerialNumber}</ds:X509SerialNumber>`,
    `              </xades:IssuerSerial>`,
    `            </xades:Cert>`,
    `          </xades:SigningCertificate>`,
    `        </xades:SignedSignatureProperties>`,
    `      </xades:SignedProperties>`,
  ].join('\n');
}

function sha256Base64(input: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(input);
  return hash.digest('base64');
}

export const STUB_SIGNER_IDS = Object.freeze({
  signatureWsuId: SIGNATURE_WSU_ID,
  signedInfoId: SIGNED_INFO_ID,
  keyInfoId: KEY_INFO_ID,
  signedPropertiesId: SIGNED_PROPERTIES_ID,
});
