# Peppol AS4 Transport Adapter (Scaffold)

This module is the C2-side transport boundary for Faatora. It turns a
UBL document + routing metadata into a typed Peppol AS4 user message
object, and hands it off to an `As4Sender` implementation that puts
bytes on the wire.

Faatora operates as **C2** (Seller ASP) under the OTA SP Registration
§5.7 **subcontractor model**: an accredited OpenPeppol service
provider signs and transmits the AS4 message under their production
X.509 certificate. We produce the typed envelope and UBL payload;
they handle the SOAP, the XMLDsig, the SMP lookup, and the wire.

## Layout

```
transport/as4/
├── types.ts                     Information-model types + PEPPOL constants
├── metadata.ts                  Participant ID + document type ID format/parse
├── envelope.ts                  buildAs4UserMessage() — pure envelope builder
├── port.ts                      As4Sender port (hexagonal boundary)
├── adapters/
│   ├── mock.ts                  MockAs4Sender for tests + local dev
│   └── partner-asp-client.ts    Partner-ASP HTTP client (skeleton + retry)
├── __tests__/
│   ├── metadata.spec.ts
│   ├── envelope.spec.ts
│   ├── mock-sender.spec.ts
│   └── partner-asp-client.spec.ts
└── index.ts                     Barrel
```

> **Test naming:** the package uses Jest with `testRegex:
> '.*\\.spec\\.ts$'`, so files are named `*.spec.ts` rather than the
> `*.test.ts` used in some sibling repos. Behavior is identical.

## What's done

- **Types.** Full TypeScript shapes for the Peppol TIA v2.0 user
  message: `As4UserMessage`, `As4PartyInfo`, `As4CollaborationInfo`,
  `As4MessageProperties`, `As4PartInfo`, `As4PayloadInfo`,
  `As4OutboundMessage`, `As4SendResult`. The well-known Peppol
  strings (`agreementRef`, `billingProcessId`, scheme IDs, ebMS
  roles, PartInfo property keys) are collected on a frozen `PEPPOL`
  object.
- **Peppol ID helpers.** `formatParticipantId` / `parseParticipantId`
  for `iso6523-actorid-upis::9915:...` form, and
  `formatDocumentTypeId` / `parseDocumentTypeId` for the compound
  `busdox-docid-qns::<rootNs>::<local>##<cust>::<ver>` form. BIS
  Billing 3.0 Invoice / CreditNote constants are pre-built and
  frozen.
- **Envelope builder.** `buildAs4UserMessage()` is a pure function
  that returns a fully-populated `As4UserMessage`. `messageId` and
  `timestamp` can be injected (tests) or defaulted
  (`crypto.randomUUID()`, `new Date().toISOString()`). Defaults the
  process ID to BIS Billing 3.0 and the payload MIME to
  `application/xml`.
- **Port.** `As4Sender` interface — a one-method hexagonal port that
  the rest of the codebase depends on. Implementations must be
  idempotent on `envelope.messageId`.
- **Mock adapter.** `MockAs4Sender` records calls, returns
  `accepted`, and optionally runs an injected logger. Used by tests
  and the `dev:api` script.
- **Partner-ASP skeleton.** `PartnerAspClient` implements `As4Sender`
  and ships a working exponential-backoff retry loop (max 5 retries
  by default, 5xx + network errors retryable, 4xx surfaced as
  `rejected`, cap at `maxBackoffMs`). The actual HTTP call is the
  only TODO — see below.

## What's intentionally NOT done

| Concern | Why not |
| --- | --- |
| **SOAP envelope XML serialization** | The partner ASP owns SOAP construction. Producing our own would duplicate their work and risk XMLDsig mismatches. |
| **XMLDsig signing** | Under the §5.7 subcontractor model, signing happens at the partner ASP boundary using their OpenPeppol production X.509 certificate. We never hold that key. |
| **Wire transmission (TLS to C3)** | Same reason — the partner ASP transmits. |
| **SMP lookup / endpoint resolution** | The partner ASP already runs SMP lookups for every outgoing delivery. Duplicating the lookup client-side would be a second source of truth. |
| **Real HTTP call to the partner ASP API** | Waiting for the partner ASP to publish their API spec. Spec release is gated on the subcontractor agreement (OTA SP Registration §5.7). Once we have it, only `PartnerAspClient.sendOnce` needs real wiring; the port, retry loop, and callers stay put. |
| **Receipt / MDN handling** | Partner ASP returns receipts via their own callback mechanism. Will be added as a separate inbound port once the API spec is known. |

No new runtime dependencies were added. UUIDs come from Node's
built-in `node:crypto`; HTTP will go through `fetch` (Node 22
built-in) when the TODO is wired.

## Using it from a NestJS service

```typescript
import { Injectable, Logger } from '@nestjs/common';
import {
  buildAs4UserMessage,
  makeIso6523ParticipantId,
  MockAs4Sender,
  PEPPOL_BIS_BILLING_3_INVOICE,
  type As4Sender,
} from '@faatora/compliance';

@Injectable()
export class As4OutboundService {
  private readonly logger = new Logger(As4OutboundService.name);

  // Inject the real adapter (PartnerAspClient) in production; wire
  // this one in test modules.
  constructor(private readonly sender: As4Sender = new MockAs4Sender()) {}

  async sendInvoice(input: {
    sellerPeppolId: string; // e.g. '9915:om-seller-1'
    buyerPeppolId: string; // e.g. '9915:om-buyer-9'
    aspPeppolId: string; // e.g. '9915:partner-c3'
    ublXml: string;
  }) {
    const envelope = buildAs4UserMessage({
      fromPartyId: makeIso6523ParticipantId('9915', 'faatora-c2'),
      toPartyId: makeIso6523ParticipantId(
        ...splitIcd(input.aspPeppolId),
      ),
      originalSender: makeIso6523ParticipantId(
        ...splitIcd(input.sellerPeppolId),
      ),
      finalRecipient: makeIso6523ParticipantId(
        ...splitIcd(input.buyerPeppolId),
      ),
      documentTypeId: PEPPOL_BIS_BILLING_3_INVOICE,
      payloadCid: `cid:ubl-${crypto.randomUUID()}@faatora.om`,
    });

    const result = await this.sender.send({ envelope, payload: input.ublXml });
    this.logger.log(
      `AS4 send ${result.status} messageId=${result.messageId}`,
    );
    return result;
  }
}

function splitIcd(peppolId: string): [string, string] {
  const [icd, ...rest] = peppolId.split(':');
  return [icd, rest.join(':')];
}
```

In a test module, bind the port to `MockAs4Sender` and assert on its
`sent` array. The mock's happy-path shape is the contract every real
adapter is held to.
