/**
 * The AS4 transport port (hexagonal sense).
 *
 * `As4Sender` is the single boundary between Faatora's domain code
 * (document generation, signing of the UBL semantic content, OTA
 * clearance) and whichever AS4 implementation actually puts bytes on
 * the wire. The intent is to keep the rest of the codebase free of
 * any assumptions about:
 *
 *   - Who signs the AS4 message (the partner ASP does, under their
 *     OpenPeppol production X.509 cert — not us).
 *   - How the SOAP envelope is serialized.
 *   - Which SMP is queried and when.
 *   - What the partner ASP's API looks like.
 *
 * Any of the above can change (we may move to a different partner
 * ASP, or eventually operate our own AP) without touching application
 * code, so long as the new adapter satisfies this port.
 */

import type { As4OutboundMessage, As4SendResult } from './types.js';

export interface As4Sender {
  /**
   * Send one outbound AS4 user message.
   *
   * Implementations MUST be idempotent on the AS4 `messageId`:
   * calling `send` twice with the same `envelope.messageId` must not
   * produce two deliveries. The partner ASP's API is expected to
   * enforce this; the adapter just forwards the id.
   *
   * Implementations SHOULD NOT throw for "the server said no" cases
   * (rejected / error). Reserve thrown exceptions for programmer
   * errors (bad config, invalid envelope) — the transport layer is a
   * boundary where we want callers to inspect `status` rather than
   * catch.
   */
  send(message: As4OutboundMessage): Promise<As4SendResult>;
}
