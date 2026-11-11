import { buildAs4UserMessage } from '../envelope.js';
import {
  makeIso6523ParticipantId,
  PEPPOL_BIS_BILLING_3_INVOICE,
} from '../metadata.js';
import { MockAs4Sender } from '../adapters/mock.js';
import type { As4OutboundMessage } from '../types.js';

function sampleOutbound(messageId: string): As4OutboundMessage {
  return {
    envelope: buildAs4UserMessage({
      fromPartyId: makeIso6523ParticipantId('9915', 'faatora-c2'),
      toPartyId: makeIso6523ParticipantId('9915', 'partner-c3'),
      originalSender: makeIso6523ParticipantId('9915', 'om-seller-1'),
      finalRecipient: makeIso6523ParticipantId('9915', 'om-buyer-9'),
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: 'cid:ubl@faatora.om',
      messageId,
      timestamp: '2026-11-12T08:30:00.000Z',
      conversationId: 'conv-1',
    }),
    payload: '<Invoice/>',
  };
}

describe('MockAs4Sender', () => {
  it('returns accepted with the submitted messageId', async () => {
    const sender = new MockAs4Sender();
    const result = await sender.send(sampleOutbound('msg-001'));
    expect(result).toEqual({ status: 'accepted', messageId: 'msg-001' });
  });

  it('records every call in order', async () => {
    const sender = new MockAs4Sender();
    await sender.send(sampleOutbound('msg-001'));
    await sender.send(sampleOutbound('msg-002'));
    expect(sender.sent.map((m) => m.envelope.messageId)).toEqual([
      'msg-001',
      'msg-002',
    ]);
  });

  it('invokes the injected logger exactly once per send', async () => {
    const lines: string[] = [];
    const sender = new MockAs4Sender({ log: (l) => lines.push(l) });
    await sender.send(sampleOutbound('msg-001'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[MockAs4Sender]');
    expect(lines[0]).toContain('messageId=msg-001');
    expect(lines[0]).toContain('action=Invoice');
  });

  it('reset() clears recorded calls', async () => {
    const sender = new MockAs4Sender();
    await sender.send(sampleOutbound('msg-001'));
    sender.reset();
    expect(sender.sent).toEqual([]);
  });
});
