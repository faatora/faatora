/**
 * Parser for AS4 Receipt / Error signals returned by the C3 endpoint.
 *
 * When a C2 sender posts an AS4 UserMessage, the receiver answers
 * synchronously with a SOAP envelope whose header carries one of two
 * ebMS signals:
 *
 *   - `<eb:SignalMessage>` with a `<eb:Receipt>` child — acceptance
 *     (the receiver committed to processing the message). Peppol TIA
 *     §3.4 further requires the receipt to be an AS4 Non-Repudiation
 *     Receipt, i.e. the receipt wraps the `ds:Reference` block of the
 *     original message's signature. We do not verify that here —
 *     verification lives in the signing module — but we do record the
 *     presence of the NRR content so the caller can keep it for audit.
 *
 *   - `<eb:SignalMessage>` with one or more `<eb:Error>` children —
 *     rejection (the receiver refuses to process).
 *
 * The parser is structural only: it reads the signals, it does NOT
 * verify the signature on the receipt, nor does it re-derive the
 * digest value. Both are a job for the signing module once the real
 * key material is wired.
 *
 * References:
 *   - OASIS ebMS 3.0 Part 1 §5.2.3 (SignalMessage)
 *   - OASIS AS4 Profile §5.1.8 (Receipt)
 *   - Peppol TIA v2.0 §3.4 (Non-Repudiation of Receipt)
 */

import { XMLParser } from 'fast-xml-parser';

/**
 * A parsed AS4 receipt. `status` mirrors the sender-facing taxonomy
 * used by `As4SendResult`: `'accepted'` for a non-repudiation receipt,
 * `'rejected'` for an ebMS Error signal, `'error'` for anything we
 * cannot classify (malformed body, unknown signal shape).
 */
export interface ParsedAs4Receipt {
  readonly status: 'accepted' | 'rejected' | 'error';
  /** The RefToMessageId pulled from the SignalMessage, if present. */
  readonly refToMessageId?: string;
  /** The MessageId of the SignalMessage itself, if present. */
  readonly messageId?: string;
  /** The SignalMessage Timestamp, if present (ISO-8601). */
  readonly timestamp?: string;
  /**
   * For an accepted receipt, the raw XML of the NRR content block
   * (the `<ebbp:NonRepudiationInformation>` subtree, or whatever the
   * receiver chose to carry inside `<eb:Receipt>`). Kept opaque so
   * the caller can archive it verbatim for audit.
   */
  readonly nrrContent?: string;
  /** For a rejected receipt, the ebMS Error entries. */
  readonly errors?: ReadonlyArray<ParsedAs4ReceiptError>;
}

export interface ParsedAs4ReceiptError {
  /** ebMS error code, e.g. `EBMS:0004`. */
  readonly code?: string;
  /** Short error label, e.g. `Other`. */
  readonly shortDescription?: string;
  /** Severity (`failure` / `warning`). */
  readonly severity?: string;
  /** Free-text description. */
  readonly description?: string;
}

const PARSER = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

/**
 * Parse a SOAP response body that carries an AS4 signal.
 *
 * On input the body may use any prefix for the ebMS namespace
 * (`eb:`, `ebms:`, `ebms3:`, …). We strip the prefix during parsing
 * and look up elements by local name only, which makes the parser
 * tolerant of partner-ASP variation.
 */
export function parseAs4Receipt(xml: string): ParsedAs4Receipt {
  let root: unknown;
  try {
    root = PARSER.parse(xml);
  } catch (err) {
    return {
      status: 'error',
      errors: [
        {
          description: `Malformed receipt XML: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const signal = pickSignalMessage(root);
  if (!signal) {
    return {
      status: 'error',
      errors: [{ description: 'No eb:SignalMessage found in response' }],
    };
  }

  const info = signal['MessageInfo'] as Record<string, unknown> | undefined;
  const refToMessageId = textOf(info?.['RefToMessageId']);
  const messageId = textOf(info?.['MessageId']);
  const timestamp = textOf(info?.['Timestamp']);

  if (signal['Receipt'] !== undefined) {
    const nrrContent = extractNrrContent(signal['Receipt']);
    return {
      status: 'accepted',
      refToMessageId,
      messageId,
      timestamp,
      nrrContent,
    };
  }

  const errorsRaw = signal['Error'];
  if (errorsRaw !== undefined) {
    const errorArray = Array.isArray(errorsRaw) ? errorsRaw : [errorsRaw];
    return {
      status: 'rejected',
      refToMessageId,
      messageId,
      timestamp,
      errors: errorArray.map((e) => parseError(e as Record<string, unknown>)),
    };
  }

  return {
    status: 'error',
    refToMessageId,
    messageId,
    timestamp,
    errors: [{ description: 'SignalMessage contained neither Receipt nor Error' }],
  };
}

function pickSignalMessage(root: unknown): Record<string, unknown> | undefined {
  if (!isObject(root)) return undefined;
  // Walk Envelope -> Header -> Messaging -> SignalMessage. All namespaces
  // have been stripped by removeNSPrefix, so we look up local names only.
  const envelope = root['Envelope'];
  if (!isObject(envelope)) return undefined;
  const header = envelope['Header'];
  if (!isObject(header)) return undefined;
  const messaging = header['Messaging'];
  if (!isObject(messaging)) return undefined;
  const signal = messaging['SignalMessage'];
  if (!isObject(signal)) return undefined;
  return signal;
}

function extractNrrContent(receipt: unknown): string | undefined {
  // We keep the receipt contents as a JSON stringification. This is
  // not the byte-exact NRR block we'd want to canonicalise and verify
  // (that requires preserving namespaces, which `removeNSPrefix`
  // stripped), but it is enough to prove the NRR was present. A real
  // verifier will re-parse the raw body with namespaces intact.
  if (receipt === undefined || receipt === null) return undefined;
  try {
    return JSON.stringify(receipt);
  } catch {
    return undefined;
  }
}

function parseError(err: Record<string, unknown>): ParsedAs4ReceiptError {
  return {
    code: strAttr(err, '@_errorCode'),
    shortDescription: strAttr(err, '@_shortDescription'),
    severity: strAttr(err, '@_severity'),
    description: textOf(err['Description']),
  };
}

function textOf(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (isObject(node)) {
    const text = node['#text'];
    if (typeof text === 'string') return text;
  }
  return undefined;
}

function strAttr(node: Record<string, unknown>, key: string): string | undefined {
  const v = node[key];
  return typeof v === 'string' ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
