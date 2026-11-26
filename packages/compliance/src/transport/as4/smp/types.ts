/**
 * Types for the Peppol SMP (Service Metadata Publisher) lookup.
 *
 * The SMP is the discovery step before any AS4 send: given a Peppol
 * participant and the document-type the sender wants to deliver, it
 * returns the AS4 endpoint URL and the X.509 certificate the C3
 * endpoint will present during the TLS handshake. Faatora uses the
 * OTA SMP at `test-smp-ext-api.taxoman.gov.om` (T-SMP) during sandbox
 * onboarding; the production URL is "to be provided upon go live"
 * (OTA Oman SMP API Specifications v1.0 §1.3).
 *
 * The Oman SMP exposes the standard OpenPeppol `ServiceMetadata`
 * schema (http://busdox.org/serviceMetadata/publishing/1.0/): a GET
 * on `/<participantId>/services/<documentTypeId>` returns a
 * `<smp:ServiceMetadata>` document whose `<smp:Endpoint>` block
 * carries the fields modelled here.
 *
 * References:
 *   - OpenPeppol SMP v1.2 (ETSI TS 119 495-2) §5
 *   - OASIS busdox ServiceMetadata 1.0 schema
 *   - OTA Oman SMP API Specifications v1.0 (4-6-2026)
 */

/**
 * A resolved AS4 endpoint for one participant + document-type pair.
 * The AS4 sender uses this to decide where to post the UserMessage
 * and whose certificate to trust.
 */
export interface SmpEndpoint {
  /**
   * The AS4 transport profile, e.g. `peppol-transport-as4-v2_0`.
   * The sender MUST match this against its own capabilities before
   * sending — a `v3_0` endpoint cannot accept a `v2_0` message.
   */
  readonly transportProfile: string;
  /** The AS4 endpoint URL (HTTPS). */
  readonly endpointUrl: string;
  /** Whether Peppol business-level signing (XAdES on the UBL) is required. */
  readonly requiresBusinessLevelSignature: boolean;
  /** The recipient's AS4 certificate, PEM-encoded. */
  readonly certificatePem: string;
  /** Free-text description. */
  readonly serviceDescription?: string;
  /** Technical-contact URL (support contact). */
  readonly technicalContactUrl?: string;
  /** Activation timestamp (ISO-8601) if the endpoint is dated. */
  readonly serviceActivationDate?: string;
  /** Expiration timestamp (ISO-8601) if the endpoint is dated. */
  readonly serviceExpirationDate?: string;
  /** Minimum authentication level, when present. */
  readonly minimumAuthenticationLevel?: string;
}

/**
 * The resolved ServiceMetadata response, one entry per matching
 * process. Peppol BIS Billing 3.0 returns exactly one matching
 * process per participant+document-type pair, so in practice
 * callers use `endpoints[0]` — but the spec allows multiple, and
 * we preserve the shape.
 */
export interface SmpServiceMetadata {
  readonly participantId: string;
  readonly documentTypeId: string;
  readonly processes: ReadonlyArray<SmpProcess>;
}

export interface SmpProcess {
  readonly processId: string;
  readonly endpoints: ReadonlyArray<SmpEndpoint>;
}

/**
 * The Peppol-mandated SMP transport-profile value sent in the
 * `smp:Endpoint/@transportProfile` attribute for an AS4 v2.0 endpoint.
 * Re-exported here as a constant so the lookup caller can compare
 * without importing from `types.ts`.
 */
export const PEPPOL_AS4_TRANSPORT_PROFILE_V2_0 = 'peppol-transport-as4-v2_0';
