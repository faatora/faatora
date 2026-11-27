/**
 * TypeScript types for Peppol AS4 (ebMS 3.0 Part 2) user messages.
 *
 * This module mirrors the information model described in the
 * `peppol-transport-as4-v2_0` profile. It does NOT serialize to the
 * SOAP envelope / `eb:Messaging` SOAP header — the partner ASP owns
 * that boundary (signing happens under their OpenPeppol X.509 cert).
 *
 * These are plain data shapes: no behavior lives in `types.ts`. The
 * typed object is produced by `envelope.ts`, consumed by the port
 * (`As4Sender`) in `port.ts`, and translated to the on-the-wire SOAP
 * envelope by whichever adapter actually transmits it.
 *
 * References:
 *   - Peppol Transport Infrastructure AS4 Profile v2.0
 *     (TIA, Section 3, Message Properties and Payload Profile)
 *   - OASIS ebMS 3.0 Part 2 / AS4 Profile
 */

/**
 * Peppol participant identifier in its canonical "scheme::identifier"
 * CEF form, e.g. `iso6523-actorid-upis::9915:test-participant`.
 *
 * `scheme` is always one of the registered identifier schemes (for
 * Peppol in practice, `iso6523-actorid-upis`). The `identifier`
 * portion is itself an ICD-qualified value (`<icd>:<local-id>`).
 */
export interface PeppolParticipantId {
  readonly scheme: string;
  readonly identifier: string;
}

/**
 * Peppol document type identifier in its canonical
 * "scheme::value" form, where the value encodes the UBL root element,
 * customisation ID, and UBL version joined with `##` and `::`.
 *
 * e.g. `busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1`.
 */
export interface PeppolDocumentTypeId {
  readonly scheme: string;
  /** Root XSD namespace, e.g. `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2`. */
  readonly rootNs: string;
  /** Root local name, e.g. `Invoice`. */
  readonly localName: string;
  /** CustomizationID, e.g. `urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0`. */
  readonly customizationId: string;
  /** UBL version, e.g. `2.1`. */
  readonly ublVersion: string;
}

/**
 * Peppol process identifier (a.k.a. ProcessID / Service Value).
 * For Peppol BIS Billing 3.0 this is
 * `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`.
 */
export interface PeppolProcessId {
  readonly scheme: string;
  readonly value: string;
}

/**
 * `eb:PartyInfo` From/To party identification.
 *
 * `role` is the ebMS role URI. In Peppol AS4 this is always
 * `http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/initiator` or
 * `.../responder` depending on direction.
 */
export interface As4PartyInfo {
  readonly partyId: PeppolParticipantId;
  readonly role: string;
}

/**
 * `eb:CollaborationInfo` — combines AgreementRef, Service, Action, and
 * ConversationId. Peppol TIA constrains Service and Action to the
 * Peppol identifiers (Process ID and Document Type ID).
 */
export interface As4CollaborationInfo {
  readonly agreementRef: string;
  readonly service: PeppolProcessId;
  /** Peppol document type identifier (goes into `eb:Action`). */
  readonly action: PeppolDocumentTypeId;
  readonly conversationId: string;
}

/**
 * ebMS message-level properties. Peppol TIA mandates two:
 *   - `originalSender`   — C1 (the real issuer)
 *   - `finalRecipient`   — C4 (the real recipient)
 *
 * Both are Peppol participant IDs and are distinct from the AS4-layer
 * From/To `partyId`, which identify the ASPs (C2/C3), not the end
 * corners.
 */
export interface As4MessageProperties {
  readonly originalSender: PeppolParticipantId;
  readonly finalRecipient: PeppolParticipantId;
}

/**
 * `eb:PartInfo` — one payload descriptor. Peppol BIS Billing uses a
 * single payload part carrying the UBL document, usually with the
 * `CID` reference `cid:<payload-id>@<domain>`.
 */
export interface As4PartInfo {
  /** The `href` referencing the attached payload (typically a `cid:` URI). */
  readonly href: string;
  readonly mimeType: string;
  /**
   * Peppol-defined part properties. The Peppol profile requires
   * `MimeType` and `CompressionType` (when compression is used).
   */
  readonly properties?: Readonly<Record<string, string>>;
}

export interface As4PayloadInfo {
  readonly parts: ReadonlyArray<As4PartInfo>;
}

/**
 * The AS4 user message as a typed object. This is the input to
 * `As4Sender.send` plus the actual UBL payload bytes (carried
 * separately as `payload` on {@link As4OutboundMessage}).
 */
export interface As4UserMessage {
  readonly messageId: string;
  /** ISO-8601 UTC timestamp, e.g. `2026-11-12T08:30:00.000Z`. */
  readonly timestamp: string;
  readonly from: As4PartyInfo;
  readonly to: As4PartyInfo;
  readonly collaborationInfo: As4CollaborationInfo;
  readonly messageProperties: As4MessageProperties;
  readonly payloadInfo: As4PayloadInfo;
}

/**
 * Full outbound message: the typed envelope object plus the raw UBL
 * payload bytes. Payload is kept as a separate field so the adapter
 * can stream / attach it without mutating the envelope object.
 */
export interface As4OutboundMessage {
  readonly envelope: As4UserMessage;
  /** The UBL 2.1 invoice/credit-note XML, as bytes or a UTF-8 string. */
  readonly payload: Uint8Array | string;
}

export type As4SendStatus = 'accepted' | 'rejected' | 'error';

export interface As4SendResult {
  readonly status: As4SendStatus;
  /** The AS4 messageId that was sent (echoed back on accept, present on reject/error for correlation). */
  readonly messageId: string;
  readonly errors?: ReadonlyArray<string>;
  /**
   * Partner ASP's own identifier for this submission, if the ASP
   * returned one. Opaque to Faatora — kept for operator diagnostics
   * and partner-support correlation (added 2026-11-27 as the
   * `PartnerAspClient` HTTP body landed).
   */
  readonly aspReference?: string;
  /**
   * OTA's reference once the ASP forwards the message and OTA
   * assigns a clearance id. Not every partner surfaces this on the
   * initial response — may arrive only on the async callback path.
   */
  readonly otaReference?: string;
}

/* -------------------------------------------------------------------------- */
/* Well-known constants from the Peppol TIA profile.                          */
/* -------------------------------------------------------------------------- */

/**
 * Peppol identifier schemes and well-known values.
 *
 * These are literal CEF strings; they are not configurable per tenant
 * and must match the Peppol TIA profile exactly.
 */
export const PEPPOL = {
  participantScheme: 'iso6523-actorid-upis',
  documentTypeScheme: 'busdox-docid-qns',
  processScheme: 'cenbii-procid-ubl',
  /** `eb:AgreementRef` value for Peppol BIS Billing 3.0. */
  agreementRef: 'urn:fdc:peppol.eu:2017:agreements:tia:bis3',
  /** Peppol BIS Billing 3.0 process identifier (the `eb:Service` value). */
  billingProcessId: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
  /** ebMS roles. */
  initiatorRole: 'http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/initiator',
  responderRole: 'http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/responder',
  /**
   * The Peppol AS4 transport profile identifier, used in SMP endpoint
   * records (`smp:Endpoint/@transportProfile`). Peppol TIA v2.0.
   */
  as4TransportProfile: 'peppol-transport-as4-v2_0',
  /** Part property keys Peppol TIA requires on the payload PartInfo. */
  partProps: {
    mimeType: 'MimeType',
    compressionType: 'CompressionType',
  },
  /**
   * ebMS message-properties keys Peppol TIA mandates on every
   * UserMessage (originalSender = C1, finalRecipient = C4).
   */
  messagePropertyKeys: {
    originalSender: 'originalSender',
    finalRecipient: 'finalRecipient',
  },
} as const;

/* -------------------------------------------------------------------------- */
/* On-the-wire XML namespaces.                                                */
/* -------------------------------------------------------------------------- */

/**
 * XML namespace URIs the AS4 / ebMS / SOAP / XMLDsig serializers use.
 *
 * Collected here (not sprinkled through the builders) so the whole
 * transport layer resolves namespaces against a single auditable
 * source of truth. Every one of these strings is normative — a stray
 * character will make XMLDsig canonicalisation diverge and the
 * receiver's signature verification fail.
 *
 * References:
 *   - SOAP 1.2 (W3C Recommendation, April 2007)
 *   - OASIS ebMS 3.0 Part 1 Core Specification, §5.2
 *   - W3C XML-Signature Syntax and Processing (Second Edition), §4
 *   - ETSI EN 319 132-1 (XAdES), §4
 */
export const XML_NS = {
  /** SOAP 1.2 envelope namespace — Peppol AS4 is bound to SOAP 1.2. */
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  /** OASIS ebMS 3.0 Core Messaging header namespace. */
  ebms: 'http://docs.oasis-open.org/ebxml-msg/ebms/v3.0/ns/core/200704/',
  /** W3C XML Digital Signature (ds:) namespace. */
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  /** ETSI XAdES 1.3.2 (xades:) namespace. */
  xades: 'http://uri.etsi.org/01903/v1.3.2#',
  /** W3C WS-Addressing namespace, used in AS4 message exchange. */
  wsa: 'http://www.w3.org/2005/08/addressing',
  /** OASIS WS-Security 1.1 utility namespace (wsu:Id attributes). */
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  /** OASIS busdox SMP ServiceMetadata publishing namespace. */
  smp: 'http://busdox.org/serviceMetadata/publishing/1.0/',
  /** OASIS busdox identifiers namespace used inside ServiceMetadata docs. */
  smpIds: 'http://busdox.org/transport/identifiers/1.0/',
} as const;
