/**
 * `DirectAs4Sender` — AS4 sender that composes envelope, signer,
 * SMP lookup and mTLS HTTP client into one `As4Sender`.
 *
 * This is the "no partner ASP in the middle" path. It targets the
 * eventual direct-connect mode where Faatora itself transmits to C3
 * under its own OpenPeppol X.509 certificate. Until the production
 * KMS is wired, `signer` is a `StubSigner` and transmissions go to
 * the sandbox; everything up to and including the SOAP body is
 * genuine. This adapter is the integration seam we exercise for the
 * 31 Jan 2027 sandbox milestone.
 *
 * Message flow:
 *   1. Build the typed AS4 envelope (envelope.ts).
 *   2. Serialize the ebms3:Messaging header (xml/user-message-xml.ts).
 *   3. Resolve the recipient C3 endpoint from the SMP, when the
 *      caller did not pre-resolve one.
 *   4. Produce the ds:Signature (signing/signer.ts).
 *   5. Assemble the SOAP envelope (xml/soap-envelope.ts).
 *   6. POST the multipart body over mTLS (http/mtls-client.ts).
 *   7. Parse the receipt (xml/receipt-parser.ts) and return an
 *      As4SendResult.
 *
 * Steps 2, 4, 5 and 7 are pure — they just transform data. Steps 3
 * and 6 are the two I/O boundaries, and they sit behind interfaces
 * the test can mock without pulling in a real network stack.
 *
 * References:
 *   - OpenPeppol TIA v2.0 §3 (AS4 UserMessage), §3.4 (NRR receipt),
 *     §3.5 (XAdES-BES)
 *   - OASIS AS4 Profile of ebMS 3.0 v1.0 §4 (Transport binding)
 */

import { randomUUID } from 'node:crypto';

import type { As4Sender } from '../port.js';
import type { As4OutboundMessage, As4SendResult } from '../types.js';
import { buildEbmsMessagingXml, EBMS_MESSAGING_DEFAULT_WSU_ID } from '../xml/user-message-xml.js';
import { buildSoapEnvelopeXml } from '../xml/soap-envelope.js';
import { parseAs4Receipt, type ParsedAs4Receipt } from '../xml/receipt-parser.js';
import type { Signer, SigningKeyReference } from '../signing/signer.js';
import type { MtlsHttpClient } from '../http/mtls-client.js';

export interface DirectAs4SenderOptions {
  readonly signer: Signer;
  readonly signingKeyRef: SigningKeyReference;
  readonly httpClient: MtlsHttpClient;
  /**
   * Either a static C3 endpoint URL, or a resolver that yields one
   * per message (typically wrapping `SmpClient.lookupAs4Endpoint`).
   * Keeping this an interface (not a concrete `SmpClient` instance)
   * lets tests pass a pre-resolved URL without touching the SMP code
   * path, and lets production flows bypass the SMP when the sender
   * has cached its last successful lookup.
   */
  readonly endpointResolver: EndpointResolver;
  /**
   * Override the `wsu:Id` the Messaging header uses as the signature
   * anchor. Kept for forward-compat with partners that have been
   * observed to require a specific id string (`id-messaging`, etc.).
   */
  readonly messagingWsuId?: string;
  /**
   * Override the `cid:...` boundary token used in the multipart body.
   * Defaults to a `uuid@faatora.om` label on each send.
   */
  readonly mimeBoundary?: () => string;
}

/**
 * The resolver port. `resolve` is called once per send with the AS4
 * envelope; it returns the C3 endpoint URL. The real implementation
 * uses the SMP client; a static implementation is also exposed
 * (`staticEndpointResolver`) for pre-resolved callers and tests.
 */
export interface EndpointResolver {
  resolve(message: As4OutboundMessage): Promise<string>;
}

/**
 * An EndpointResolver that always returns the same URL. Useful when
 * the caller has already run the SMP lookup upstream, or when the
 * SMP is temporarily unavailable and a sender is wired against a
 * known-good endpoint.
 */
export function staticEndpointResolver(url: string): EndpointResolver {
  return {
    async resolve() {
      return url;
    },
  };
}

export class DirectAs4Sender implements As4Sender {
  constructor(private readonly options: DirectAs4SenderOptions) {
    if (!options.signer) throw new Error('DirectAs4Sender: signer is required');
    if (!options.signingKeyRef) throw new Error('DirectAs4Sender: signingKeyRef is required');
    if (!options.httpClient) throw new Error('DirectAs4Sender: httpClient is required');
    if (!options.endpointResolver) {
      throw new Error('DirectAs4Sender: endpointResolver is required');
    }
  }

  async send(message: As4OutboundMessage): Promise<As4SendResult> {
    const wsuId = this.options.messagingWsuId ?? EBMS_MESSAGING_DEFAULT_WSU_ID;

    // 1. Serialize the Messaging header.
    const messagingXml = buildEbmsMessagingXml(message.envelope, { wsuId, pretty: true });

    // 2. Produce the XAdES-BES signature over the header + payload.
    const payloadPart = message.envelope.payloadInfo.parts[0];
    const contentId = stripCidPrefix(payloadPart.href);
    let signatureXml: string;
    try {
      const signed = await this.options.signer.sign({
        keyRef: this.options.signingKeyRef,
        targets: [
          { kind: 'header', id: wsuId, xml: messagingXml },
          { kind: 'attachment', contentId, bytes: message.payload },
        ],
      });
      signatureXml = signed.signatureXml;
    } catch (err) {
      return errorResult(message, `signing failed: ${errToString(err)}`);
    }

    // 3. Compose the full SOAP envelope.
    const soapXml = buildSoapEnvelopeXml({ messagingXml, signatureXml });

    // 4. Resolve the C3 endpoint.
    let endpointUrl: string;
    try {
      endpointUrl = await this.options.endpointResolver.resolve(message);
    } catch (err) {
      return errorResult(message, `endpoint resolution failed: ${errToString(err)}`);
    }

    // 5. Build the multipart body. Peppol AS4 uses
    // `multipart/related; type="application/soap+xml"` with the SOAP
    // envelope as the first part and the UBL attachment as the second.
    const boundary = this.options.mimeBoundary?.() ?? `boundary-${randomUUID()}@faatora.om`;
    const body = buildMultipart({
      boundary,
      soapXml,
      payload: message.payload,
      payloadContentId: contentId,
      payloadMimeType: payloadPart.mimeType,
    });

    // 6. POST it.
    let response: Response;
    try {
      response = await this.options.httpClient.fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary="${boundary}"; type="application/soap+xml"`,
          // Peppol AS4 does not use SOAPAction, but some AS4 gateways
          // still require a header; empty-string is the ebMS 3.0 norm.
          SOAPAction: '"ebms"',
        },
        body,
      });
    } catch (err) {
      return errorResult(message, `HTTP POST failed: ${errToString(err)}`);
    }

    const responseBody = await response.text();
    if (response.status < 200 || response.status >= 300) {
      return {
        status: 'error',
        messageId: message.envelope.messageId,
        errors: [`C3 returned HTTP ${response.status}: ${truncate(responseBody, 512)}`],
      };
    }

    // 7. Parse the AS4 receipt out of the response body.
    const parsed = parseAs4Receipt(responseBody);
    return receiptToSendResult(message, parsed);
  }
}

function stripCidPrefix(href: string): string {
  return href.startsWith('cid:') ? href.slice(4) : href;
}

interface MultipartInput {
  readonly boundary: string;
  readonly soapXml: string;
  readonly payload: Uint8Array | string;
  readonly payloadContentId: string;
  readonly payloadMimeType: string;
}

/**
 * Build the Peppol AS4 multipart/related body. The SOAP envelope goes
 * first (root part); the UBL payload follows as a second part keyed
 * by its Content-Id. Everything is 8-bit — AS4 does not require
 * 7-bit or base64 encoding of the attachment.
 */
function buildMultipart(input: MultipartInput): Buffer {
  const CRLF = '\r\n';
  const dash = '--';
  const soapHeaders =
    'Content-Type: application/soap+xml; charset=UTF-8' +
    CRLF +
    'Content-Transfer-Encoding: 8bit' +
    CRLF +
    'Content-ID: <root@faatora.om>' +
    CRLF +
    CRLF;
  const payloadHeaders =
    `Content-Type: ${input.payloadMimeType}; charset=UTF-8` +
    CRLF +
    'Content-Transfer-Encoding: 8bit' +
    CRLF +
    `Content-ID: <${input.payloadContentId}>` +
    CRLF +
    CRLF;

  const payloadBytes =
    typeof input.payload === 'string'
      ? Buffer.from(input.payload, 'utf8')
      : Buffer.from(input.payload);

  return Buffer.concat([
    Buffer.from(dash + input.boundary + CRLF + soapHeaders + input.soapXml + CRLF, 'utf8'),
    Buffer.from(dash + input.boundary + CRLF + payloadHeaders, 'utf8'),
    payloadBytes,
    Buffer.from(CRLF + dash + input.boundary + dash + CRLF, 'utf8'),
  ]);
}

function receiptToSendResult(message: As4OutboundMessage, parsed: ParsedAs4Receipt): As4SendResult {
  if (parsed.status === 'accepted') {
    return {
      status: 'accepted',
      messageId: message.envelope.messageId,
    };
  }
  if (parsed.status === 'rejected') {
    return {
      status: 'rejected',
      messageId: message.envelope.messageId,
      errors: (parsed.errors ?? []).map(formatError),
    };
  }
  return {
    status: 'error',
    messageId: message.envelope.messageId,
    errors: (parsed.errors ?? []).map(formatError),
  };
}

function formatError(e: {
  code?: string;
  description?: string;
  shortDescription?: string;
}): string {
  const label = e.code ?? e.shortDescription ?? 'unknown';
  const detail = e.description ?? e.shortDescription ?? '(no description)';
  return `${label}: ${detail}`;
}

function errorResult(message: As4OutboundMessage, text: string): As4SendResult {
  return {
    status: 'error',
    messageId: message.envelope.messageId,
    errors: [text],
  };
}

function errToString(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
