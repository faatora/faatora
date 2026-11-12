/**
 * In-memory AS4 sender for tests and local development.
 *
 * `MockAs4Sender` satisfies the `As4Sender` port by:
 *   - recording every call in `sent` for test assertions,
 *   - returning an `accepted` result that echoes the envelope's
 *     `messageId`,
 *   - optionally running an injected logger so local `dev:api` runs
 *     can see what would have been sent.
 *
 * It deliberately performs no SMP lookup, no SOAP serialization, and
 * no network I/O. It is the baseline against which every real
 * adapter is tested — if a real adapter's happy path doesn't match
 * this one's shape, the port is wrong.
 */

import type { As4Sender } from '../port.js';
import type { As4OutboundMessage, As4SendResult } from '../types.js';

export interface MockAs4SenderOptions {
  /**
   * Optional logger. Defaults to a no-op so tests stay quiet. In
   * local dev you can pass `console.log` (or a NestJS Logger's
   * `log.bind(logger)`) to see sends on the console.
   */
  readonly log?: (line: string) => void;
}

export class MockAs4Sender implements As4Sender {
  /** All messages that have been handed to `send`, in call order. */
  readonly sent: As4OutboundMessage[] = [];

  constructor(private readonly options: MockAs4SenderOptions = {}) {}

  async send(message: As4OutboundMessage): Promise<As4SendResult> {
    this.sent.push(message);
    const log = this.options.log;
    if (log) {
      const env = message.envelope;
      log(
        `[MockAs4Sender] accepted messageId=${env.messageId} ` +
          `from=${env.from.partyId.identifier} to=${env.to.partyId.identifier} ` +
          `action=${env.collaborationInfo.action.localName}`,
      );
    }
    return {
      status: 'accepted',
      messageId: message.envelope.messageId,
    };
  }

  /** Clear the recorded call list (useful between test cases). */
  reset(): void {
    this.sent.length = 0;
  }
}
