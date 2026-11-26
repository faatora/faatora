/**
 * SOAP 1.2 envelope builder for an AS4 UserMessage.
 *
 * Wraps the already-serialized `eb:Messaging` header (from
 * `buildEbmsMessagingXml`) and the UBL payload reference into a
 * complete SOAP envelope. The payload itself travels in a MIME part
 * on the HTTP body, keyed by its `cid:` reference; this function does
 * NOT assemble the multipart body — that is the HTTP client's job.
 *
 * The envelope structure is fixed by OASIS AS4 §3 and Peppol TIA §3:
 *
 *   env:Envelope
 *     env:Header
 *       eb:Messaging    (one UserMessage, optionally containing a ds:Signature)
 *       ds:Signature?   (XAdES-BES; may also live inside WS-Security)
 *     env:Body          (EMPTY — the payload travels as a MIME attachment)
 *
 * Peppol TIA is explicit that the SOAP Body is empty for Peppol
 * UserMessages: the UBL payload is a MIME attachment referenced from
 * `eb:PayloadInfo/eb:PartInfo/@href`, not an inline SOAP body child.
 *
 * References:
 *   - OASIS SOAP 1.2 Part 1 §5.4
 *   - OASIS AS4 Profile of ebMS 3.0 v1.0, §3
 *   - OpenPeppol Transport Infrastructure AS4 Profile v2.0, §3.3
 */

import { XML_NS } from '../types.js';

/**
 * Input to {@link buildSoapEnvelopeXml}. Each piece is pre-serialized
 * XML — this builder just concatenates them inside a SOAP envelope
 * whose namespace declarations match the inner fragments.
 */
export interface BuildSoapEnvelopeInput {
  /**
   * The serialized `<eb:Messaging>` element produced by
   * `buildEbmsMessagingXml`. Must declare its own namespaces on the
   * root element, which it does by construction.
   */
  readonly messagingXml: string;
  /**
   * Optional `<ds:Signature>` element (XAdES-BES). When present, it
   * is emitted as a second child of `<env:Header>`, after
   * `<eb:Messaging>`. Produced by a `Signer` implementation.
   */
  readonly signatureXml?: string;
}

/**
 * Build the SOAP 1.2 envelope that an AS4 UserMessage ships in.
 *
 * Output is pretty-printed for readability in wire logs and test
 * diffs. Because XMLDsig canonicalisation normalises whitespace
 * inside the signed subtree, the pretty-print does not affect
 * signature verification.
 *
 * The output starts with an XML declaration (`<?xml version="1.0"
 * encoding="UTF-8"?>`); the HTTP layer sends the whole string as the
 * SOAP root part of the multipart body.
 */
export function buildSoapEnvelopeXml(input: BuildSoapEnvelopeInput): string {
  const header = assembleHeader(input);
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<env:Envelope xmlns:env="${XML_NS.soap}">\n` +
    `  <env:Header>\n` +
    indent(header, '    ') +
    '\n' +
    `  </env:Header>\n` +
    `  <env:Body/>\n` +
    `</env:Envelope>`;
  return envelope;
}

function assembleHeader(input: BuildSoapEnvelopeInput): string {
  if (!input.signatureXml) return input.messagingXml;
  return input.messagingXml + '\n' + input.signatureXml;
}

/**
 * Prefix every line of `block` with `pad`. We do NOT touch the inner
 * structure — attribute and child-element order is the signer's
 * concern, not ours.
 */
function indent(block: string, pad: string): string {
  return block
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}
