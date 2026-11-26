/**
 * Peppol SMP (Service Metadata Publisher) client.
 *
 * Resolves a recipient C3 AS4 endpoint from an SMP, given a Peppol
 * participant identifier and a document-type identifier. Faatora
 * targets the OTA Oman SMP:
 *
 *   T-SMP (sandbox) : https://test-smp-ext-api.taxoman.gov.om/v1/secure/smp/wrapper
 *   Production SMP  : (TBD — "to be provided upon go live")
 *
 * The lookup endpoint is a plain HTTP GET; authentication is mTLS
 * only for write operations (per OTA Oman SMP API Specifications v1.0
 * §1.3). We still route lookups through the same mTLS client so
 * production deployments that pin a certificate against the SMP host
 * (a common defence against SMP spoofing) work without a second code
 * path.
 *
 * This module intentionally covers READ ONLY. The PUT/DELETE routes
 * in the Oman SMP spec are administrative — used by service providers
 * to publish their own metadata, not by senders — and belong in a
 * separate module when that flow is wired.
 *
 * References:
 *   - OpenPeppol SMP Specification v1.2 §5
 *   - OASIS BDXR SMP 1.0 Reference Implementation
 *   - OTA Oman SMP API Specifications v1.0 (4-6-2026)
 */

import { formatDocumentTypeId, formatParticipantId } from '../metadata.js';
import type { PeppolDocumentTypeId, PeppolParticipantId } from '../types.js';
import type { MtlsHttpClient } from '../http/mtls-client.js';

import { parseSmpServiceMetadata, SmpParseError } from './parser.js';
import {
  PEPPOL_AS4_TRANSPORT_PROFILE_V2_0,
  type SmpEndpoint,
  type SmpServiceMetadata,
} from './types.js';

export interface SmpClientOptions {
  /**
   * SMP base URL, with no trailing slash. The Oman T-SMP base is
   * `https://test-smp-ext-api.taxoman.gov.om/v1/secure/smp/wrapper`.
   * A generic BDXR-style SMP would use the service-provider's own
   * host (e.g. `https://smp.example.com`); either shape works, the
   * code appends the route verbatim.
   */
  readonly baseUrl: string;
  /** mTLS HTTP client (same credentials as the AS4 sender's client). */
  readonly httpClient: MtlsHttpClient;
  /**
   * Transport profile to filter for. Default
   * `peppol-transport-as4-v2_0`. A sender that wants to be
   * future-proof against AS4 v3 should pass the profile its own
   * implementation speaks and surface a mismatch error as a config
   * problem rather than running against an endpoint it cannot
   * actually talk to.
   */
  readonly preferredTransportProfile?: string;
}

export class SmpLookupError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SmpLookupError';
  }
}

export class SmpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'SmpHttpError';
  }
}

export class SmpEndpointNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmpEndpointNotFoundError';
  }
}

/**
 * The resolved AS4 endpoint plus the raw ServiceMetadata it came
 * from. Callers that need just the endpoint use `endpoint`; callers
 * that archive the SMP response for audit use `serviceMetadata`.
 */
export interface ResolvedAs4Endpoint {
  readonly endpoint: SmpEndpoint;
  readonly serviceMetadata: SmpServiceMetadata;
}

export class SmpClient {
  private readonly baseUrl: string;
  private readonly preferredTransportProfile: string;

  constructor(private readonly options: SmpClientOptions) {
    if (!options.baseUrl) {
      throw new Error('SmpClient: baseUrl is required');
    }
    if (!options.httpClient) {
      throw new Error('SmpClient: httpClient is required');
    }
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.preferredTransportProfile =
      options.preferredTransportProfile ?? PEPPOL_AS4_TRANSPORT_PROFILE_V2_0;
  }

  /**
   * Resolve the AS4 endpoint for one participant + document-type
   * pair. Composes the SMP URL per OpenPeppol SMP v1.2 §5.1.1:
   *
   *   GET /<participant-id-url-encoded>/services/<document-type-id-url-encoded>
   *
   * URL encoding of the identifiers is mandatory because both halves
   * contain `:` and `#` which are reserved in HTTP paths. Oman SMP's
   * spec restates this verbatim: `#` -> `%23`, `:` -> `%3A`.
   */
  async lookupAs4Endpoint(
    participantId: PeppolParticipantId,
    documentTypeId: PeppolDocumentTypeId,
  ): Promise<ResolvedAs4Endpoint> {
    const sm = await this.getServiceMetadata(participantId, documentTypeId);

    // For BIS Billing 3.0 the SMP returns a single Process, but we
    // defensively search across them: the Endpoint's transport
    // profile is what pins AS4, not the process id.
    for (const process of sm.processes) {
      for (const endpoint of process.endpoints) {
        if (endpoint.transportProfile === this.preferredTransportProfile) {
          return { endpoint, serviceMetadata: sm };
        }
      }
    }

    const available = sm.processes
      .flatMap((p) => p.endpoints.map((e) => e.transportProfile))
      .join(', ');
    throw new SmpEndpointNotFoundError(
      `No endpoint found for transportProfile='${this.preferredTransportProfile}'` +
        (available ? ` (available: ${available})` : ''),
    );
  }

  /**
   * The raw ServiceMetadata response for a participant + document-type
   * pair. Exposed separately from `lookupAs4Endpoint` so administrative
   * flows (audit log, diagnostics) can inspect all endpoints the SMP
   * returned, not just the first AS4 one.
   */
  async getServiceMetadata(
    participantId: PeppolParticipantId,
    documentTypeId: PeppolDocumentTypeId,
  ): Promise<SmpServiceMetadata> {
    const url = this.urlFor(participantId, documentTypeId);
    let response: Response;
    try {
      response = await this.options.httpClient.fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/xml' },
      });
    } catch (err) {
      throw new SmpLookupError(`SMP GET failed: ${errToString(err)}`, err);
    }

    const bodyText = await response.text();
    if (response.status === 404) {
      throw new SmpEndpointNotFoundError(
        `SMP has no ServiceMetadata for ` +
          `${formatParticipantId(participantId)} / ${formatDocumentTypeId(documentTypeId)}`,
      );
    }
    if (!response.ok) {
      throw new SmpHttpError(response.status, `SMP GET returned HTTP ${response.status}`, bodyText);
    }

    try {
      return parseSmpServiceMetadata(bodyText);
    } catch (err) {
      if (err instanceof SmpParseError) {
        throw new SmpLookupError(`SMP response could not be parsed: ${err.message}`, err);
      }
      throw err;
    }
  }

  /**
   * Compose the SMP lookup URL. Both path parameters are URL-encoded.
   * The OTA Oman SMP spec explicitly calls out `#` -> `%23` and
   * `:` -> `%3A` — `encodeURIComponent` handles both (plus the `#`
   * fragment separator that would otherwise split the path).
   */
  urlFor(participantId: PeppolParticipantId, documentTypeId: PeppolDocumentTypeId): string {
    const pidEnc = encodeURIComponent(formatParticipantId(participantId));
    const docEnc = encodeURIComponent(formatDocumentTypeId(documentTypeId));
    return `${this.baseUrl}/${pidEnc}/services/${docEnc}`;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function errToString(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The Oman T-SMP base URL. Exported so wiring code does not repeat it. */
export const OMAN_T_SMP_BASE_URL = 'https://test-smp-ext-api.taxoman.gov.om/v1/secure/smp/wrapper';
