/**
 * Serializer for the AS4 `eb:UserMessage` SOAP header block.
 *
 * Produces the `eb:Messaging`/`eb:UserMessage` element described in
 * OASIS ebMS 3.0 Part 1 §5.2 and profiled by Peppol TIA v2.0
 * (`peppol-transport-as4-v2_0`). The output is a well-formed XML
 * fragment the SOAP-envelope builder wraps in `env:Envelope` /
 * `env:Header`, and that the XMLDsig signer references through the
 * `wsu:Id` attribute set on the `eb:Messaging` root.
 *
 * Determinism: output bytes are a pure function of the typed
 * `As4UserMessage`. Child-element order, attribute order, and
 * whitespace are fixed, because every byte is going to be hashed by
 * the signer — any drift would invalidate the signature across
 * replays. Keep this builder free of randomness and of any
 * timestamp-derived defaults; those already live in `envelope.ts`.
 *
 * References:
 *   - OASIS ebMS 3.0 Part 1 Core Specification, §5.2 (Messaging header)
 *   - OASIS AS4 Profile of ebMS 3.0 v1.0
 *   - OpenPeppol Transport Infrastructure AS4 Profile v2.0, §3
 */

import { XMLBuilder } from 'fast-xml-parser';

import { PEPPOL, XML_NS, type As4UserMessage, type PeppolParticipantId } from '../types.js';
import { formatDocumentTypeId } from '../metadata.js';

/**
 * Input to {@link buildEbmsMessagingXml}.
 *
 * `wsuId` is the `wsu:Id` attribute put on the `eb:Messaging` element
 * so the XAdES signer can reference it from `ds:Reference URI="#..."`.
 * Default is `_messaging`, which is the canonical placeholder value
 * used by eSens / OpenPeppol conformance test suites.
 */
export interface BuildMessagingOptions {
  readonly wsuId?: string;
  /**
   * Whether to pretty-print the output (2-space indent). AS4 messages
   * go through XMLDsig canonicalisation before signing, so pretty vs.
   * compact does not change the digest — but pretty-printed output is
   * much easier to diff in failing tests and in wire logs. Default `true`.
   */
  readonly pretty?: boolean;
}

const DEFAULT_WSU_ID = '_messaging';

/**
 * Build the `<eb:Messaging>` SOAP header block carrying a single
 * `<eb:UserMessage>`. The returned string is an XML fragment WITHOUT
 * an XML declaration (it will be nested inside the SOAP envelope the
 * HTTP client sends).
 *
 * Element order follows ebMS 3.0 §5.2 exactly:
 *
 * ```
 * eb:Messaging
 *   eb:UserMessage
 *     eb:MessageInfo       (Timestamp, MessageId)
 *     eb:PartyInfo         (From, To)
 *     eb:CollaborationInfo (AgreementRef, Service, Action, ConversationId)
 *     eb:MessageProperties (originalSender, finalRecipient)
 *     eb:PayloadInfo       (PartInfo*)
 * ```
 */
export function buildEbmsMessagingXml(
  message: As4UserMessage,
  options: BuildMessagingOptions = {},
): string {
  const wsuId = options.wsuId ?? DEFAULT_WSU_ID;
  const pretty = options.pretty ?? true;

  // Element order below is intentional and matches ebMS 3.0 §5.2.
  // fast-xml-parser's XMLBuilder iterates plain-object keys in
  // insertion order (V8 behaviour that fast-xml-parser documents and
  // relies on), so writing keys in the right order writes bytes in
  // the right order.
  const messagingRoot: Record<string, unknown> = {
    '@_xmlns:eb': XML_NS.ebms,
    '@_xmlns:wsu': XML_NS.wsu,
    '@_wsu:Id': wsuId,
    // ebMS 3.0 Part 2 recommends mustUnderstand=true on the Messaging
    // header so an intermediary that does not implement ebMS refuses
    // the message rather than forwarding it blindly.
    '@_env:mustUnderstand': 'true',
    '@_xmlns:env': XML_NS.soap,
    'eb:UserMessage': buildUserMessageSubtree(message),
  };

  const builder = new XMLBuilder({
    attributeNamePrefix: '@_',
    ignoreAttributes: false,
    textNodeName: '#text',
    format: pretty,
    indentBy: '  ',
    processEntities: true,
    suppressEmptyNode: false,
    // Keep `env:mustUnderstand="true"` as text: without this,
    // fast-xml-parser 4.x drops the "true" and emits a bare attribute
    // name (XML 1.0 forbids bare attribute names, and SOAP 1.2 requires
    // the literal "true"/"false").
    suppressBooleanAttributes: false,
  });

  const body = builder.build({ 'eb:Messaging': messagingRoot }) as string;
  // XMLBuilder emits a trailing newline when `format: true`; strip it
  // so callers get a clean fragment they can embed.
  return body.replace(/\n$/, '');
}

function buildUserMessageSubtree(message: As4UserMessage): Record<string, unknown> {
  // eb:UserMessage children, in ebMS 3.0 §5.2.2 order:
  return {
    'eb:MessageInfo': {
      'eb:Timestamp': message.timestamp,
      'eb:MessageId': message.messageId,
    },
    'eb:PartyInfo': {
      'eb:From': buildPartyBlock(message.from.partyId, message.from.role),
      'eb:To': buildPartyBlock(message.to.partyId, message.to.role),
    },
    'eb:CollaborationInfo': {
      // Peppol TIA §3.1 allows AgreementRef to be text-only (no
      // pmode/type attributes) — we emit it that way, matching eSens
      // and OpenPeppol conformance fixtures.
      'eb:AgreementRef': message.collaborationInfo.agreementRef,
      'eb:Service': {
        '@_type': message.collaborationInfo.service.scheme,
        '#text': message.collaborationInfo.service.value,
      },
      'eb:Action': formatDocumentTypeId(message.collaborationInfo.action),
      'eb:ConversationId': message.collaborationInfo.conversationId,
    },
    'eb:MessageProperties': {
      'eb:Property': [
        {
          '@_name': PEPPOL.messagePropertyKeys.originalSender,
          '@_type': message.messageProperties.originalSender.scheme,
          '#text': message.messageProperties.originalSender.identifier,
        },
        {
          '@_name': PEPPOL.messagePropertyKeys.finalRecipient,
          '@_type': message.messageProperties.finalRecipient.scheme,
          '#text': message.messageProperties.finalRecipient.identifier,
        },
      ],
    },
    'eb:PayloadInfo': {
      // eb:PartInfo is repeatable; Peppol BIS Billing uses exactly one.
      'eb:PartInfo': message.payloadInfo.parts.map((part) => {
        const partProperties = part.properties ?? {};
        const propertyEntries = Object.entries(partProperties);
        const partInfo: Record<string, unknown> = {
          '@_href': part.href,
        };
        // eb:PartProperties is OPTIONAL when there are no properties;
        // Peppol TIA mandates at least `MimeType`, so in practice it
        // is always emitted.
        if (propertyEntries.length > 0) {
          partInfo['eb:PartProperties'] = {
            'eb:Property': propertyEntries.map(([name, value]) => ({
              '@_name': name,
              '#text': value,
            })),
          };
        }
        return partInfo;
      }),
    },
  };
}

/**
 * Build one `<eb:From>` / `<eb:To>` block.
 *
 * ebMS 3.0 §5.2.2.2: `eb:PartyInfo` contains one or more `eb:PartyId`
 * child elements carrying the party identifier, plus one `eb:Role`
 * element. For Peppol TIA this is always exactly one PartyId, with
 * `@type` set to the scheme (`iso6523-actorid-upis`).
 */
function buildPartyBlock(partyId: PeppolParticipantId, role: string): Record<string, unknown> {
  return {
    'eb:PartyId': {
      '@_type': partyId.scheme,
      '#text': partyId.identifier,
    },
    'eb:Role': role,
  };
}

export const EBMS_MESSAGING_DEFAULT_WSU_ID = DEFAULT_WSU_ID;
