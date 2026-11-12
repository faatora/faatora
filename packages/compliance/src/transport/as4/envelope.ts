/**
 * Builder for the Peppol AS4 user message envelope (typed object only).
 *
 * This is NOT SOAP serialization. It builds the information model that
 * mirrors the `eb:UserMessage` SOAP header described in Peppol TIA
 * v2.0, and hands it to the port (`As4Sender`) along with the UBL
 * payload bytes. The partner ASP owns SOAP envelope construction,
 * signing (XMLDsig over the message header + attachment), and wire
 * transmission.
 *
 * Determinism: the only non-deterministic inputs — `messageId` and
 * `timestamp` — are explicit fields on {@link BuildEnvelopeInput}, so
 * tests can pass fixed values. If omitted, `messageId` is generated
 * with `crypto.randomUUID()` and `timestamp` with `new Date()`.
 */

import { randomUUID } from 'node:crypto';

import {
  PEPPOL,
  type As4PartInfo,
  type As4UserMessage,
  type PeppolDocumentTypeId,
  type PeppolParticipantId,
  type PeppolProcessId,
} from './types.js';

/**
 * Input to {@link buildAs4UserMessage}.
 *
 * `fromPartyId` / `toPartyId` identify the two ASPs on the AS4 hop
 * (C2 and C3). `originalSender` / `finalRecipient` identify the real
 * business parties (C1 and C4). In many deployments the ASP
 * participant ID and the end-party participant ID are the same
 * participant, but the model distinguishes them because the Peppol
 * TIA profile mandates separate `eb:MessageProperties` entries.
 */
export interface BuildEnvelopeInput {
  /** AS4-layer sender (the C2 ASP's Peppol participant ID). */
  readonly fromPartyId: PeppolParticipantId;
  /** AS4-layer receiver (the C3 ASP's Peppol participant ID). */
  readonly toPartyId: PeppolParticipantId;

  /** Business-level originator (C1). */
  readonly originalSender: PeppolParticipantId;
  /** Business-level final recipient (C4). */
  readonly finalRecipient: PeppolParticipantId;

  /** Peppol document type identifier (goes into `eb:Action`). */
  readonly documentTypeId: PeppolDocumentTypeId;
  /** Peppol process identifier (goes into `eb:Service`). Defaults to BIS Billing 3.0. */
  readonly processId?: PeppolProcessId;

  /** Conversation ID. Peppol TIA allows any string; convention is a UUID. */
  readonly conversationId?: string;

  /** `cid:` reference to the UBL payload attachment. */
  readonly payloadCid: string;
  /** Payload MIME type. Peppol TIA mandates `application/xml`. */
  readonly payloadMimeType?: string;
  /** Optional extra `PartInfo.PartProperties`. */
  readonly extraPayloadProperties?: Readonly<Record<string, string>>;

  /** Override the generated `eb:MessageInfo/MessageId`. Primarily for tests. */
  readonly messageId?: string;
  /** Override the generated `eb:MessageInfo/Timestamp`. Primarily for tests. */
  readonly timestamp?: Date | string;
}

/**
 * Build the typed AS4 user message envelope.
 *
 * Pure function: given the same inputs (including explicit
 * `messageId` and `timestamp`), it returns the same object every
 * time. Does not perform SMP lookup, does not sign, does not touch
 * the network.
 */
export function buildAs4UserMessage(input: BuildEnvelopeInput): As4UserMessage {
  const messageId = input.messageId ?? randomUUID();
  const timestamp = toIsoTimestamp(input.timestamp ?? new Date());
  const conversationId = input.conversationId ?? randomUUID();

  const processId: PeppolProcessId = input.processId ?? {
    scheme: PEPPOL.processScheme,
    value: PEPPOL.billingProcessId,
  };

  const mimeType = input.payloadMimeType ?? 'application/xml';
  const partProperties: Record<string, string> = {
    [PEPPOL.partProps.mimeType]: mimeType,
    ...(input.extraPayloadProperties ?? {}),
  };

  const payloadPart: As4PartInfo = {
    href: input.payloadCid,
    mimeType,
    properties: Object.freeze({ ...partProperties }),
  };

  return {
    messageId,
    timestamp,
    from: {
      partyId: input.fromPartyId,
      role: PEPPOL.initiatorRole,
    },
    to: {
      partyId: input.toPartyId,
      role: PEPPOL.responderRole,
    },
    collaborationInfo: {
      agreementRef: PEPPOL.agreementRef,
      service: processId,
      action: input.documentTypeId,
      conversationId,
    },
    messageProperties: {
      originalSender: input.originalSender,
      finalRecipient: input.finalRecipient,
    },
    payloadInfo: {
      parts: [payloadPart],
    },
  };
}

/**
 * Normalize a Date or ISO-ish string to the `YYYY-MM-DDTHH:mm:ss.sssZ`
 * form Peppol/ebMS expects in `eb:MessageInfo/Timestamp`. Strings are
 * trusted if they already parse to a valid Date.
 */
function toIsoTimestamp(ts: Date | string): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid AS4 timestamp: ${String(ts)}`);
  }
  return d.toISOString();
}
