# Peppol AS4 Transport Adapter

This module is Faatora's C2-side transport boundary. It turns a UBL
document + routing metadata into a signed AS4 UserMessage, resolves
the C3 endpoint from an SMP, and transmits over mTLS. Two send
paths live side by side:

- **Partner-ASP path** (`adapters/partner-asp-client.ts`) — the
  original §5.7 subcontractor arrangement: Faatora hands envelope +
  UBL to an accredited OpenPeppol service provider who signs and
  transmits under their production X.509 certificate. Still the
  default production pathway.
- **Direct path** (`adapters/direct.ts`) — Faatora composes envelope,
  XAdES-BES signature, SOAP envelope and multipart body itself, and
  POSTs directly to C3 over mTLS. This is the pathway exercised for
  the 31 Jan 2027 OTA sandbox milestone.

Both paths satisfy the same `As4Sender` port; the rest of the
codebase does not care which one is wired at the DI layer.

## Layout

```
transport/as4/
├── types.ts                     Information-model types + Peppol constants + XML namespaces
├── metadata.ts                  Participant ID + document type ID format/parse
├── envelope.ts                  buildAs4UserMessage() — pure envelope builder
├── port.ts                      As4Sender port (hexagonal boundary)
├── xml/
│   ├── user-message-xml.ts      Serialize As4UserMessage -> <eb:Messaging> XML
│   ├── soap-envelope.ts         Wrap <eb:Messaging> + <ds:Signature> in SOAP 1.2
│   └── receipt-parser.ts        Parse AS4 NRR / Error signals from the response
├── signing/
│   ├── signer.ts                Signer port + XMLDsig algorithm constants
│   └── stub-signer.ts           XAdES-BES stub producing a schema-valid <ds:Signature>
├── http/
│   └── mtls-client.ts           fetch-shaped mTLS HTTP client
├── smp/
│   ├── types.ts                 Resolved endpoint + ServiceMetadata types
│   ├── parser.ts                Parse SMP ServiceMetadata XML
│   └── smp-client.ts            Peppol SMP lookup (Oman OTA T-SMP + generic)
├── adapters/
│   ├── mock.ts                  MockAs4Sender for tests + local dev
│   ├── partner-asp-client.ts    §5.7 Partner-ASP skeleton (retry loop + TODO HTTP)
│   └── direct.ts                DirectAs4Sender — envelope + sign + mTLS + SMP
├── __tests__/
│   ├── metadata.spec.ts
│   ├── envelope.spec.ts
│   ├── mock-sender.spec.ts
│   ├── partner-asp-client.spec.ts
│   ├── user-message-xml.spec.ts
│   ├── soap-envelope.spec.ts
│   ├── receipt-parser.spec.ts
│   ├── stub-signer.spec.ts
│   ├── mtls-client.spec.ts
│   ├── smp.spec.ts
│   └── direct-roundtrip.spec.ts
└── index.ts                     Barrel
```

> **Test naming:** `*.spec.ts` (`testRegex: '.*\\.spec\\.ts$'`).

## What's done

### Typed envelope (unchanged from the scaffold)

- `buildAs4UserMessage()` returns a fully-populated `As4UserMessage`
  with Peppol BIS Billing 3.0 defaults. `messageId` and `timestamp`
  are injectable for deterministic tests.
- Peppol ID helpers (`formatParticipantId`, `formatDocumentTypeId`,
  `make…`) and the frozen BIS Billing 3.0 Invoice / Credit Note /
  Process constants.

### UserMessage XML serialization (new)

`buildEbmsMessagingXml()` turns the typed envelope into a
byte-deterministic `<eb:Messaging>`/`<eb:UserMessage>` fragment in
the exact child-element order OASIS ebMS 3.0 §5.2 mandates:

```
MessageInfo (Timestamp, MessageId)
PartyInfo (From { PartyId, Role }, To { PartyId, Role })
CollaborationInfo (AgreementRef, Service, Action, ConversationId)
MessageProperties (Property name="originalSender", Property name="finalRecipient")
PayloadInfo (PartInfo href="cid:…" + PartProperties MimeType)
```

The root element carries `wsu:Id` so the XAdES signer can reference
it (`URI="#_messaging"`), and `env:mustUnderstand="true"`. Serializer
is fully deterministic; a byte-for-byte fixture test guards against
drift. Credit-note document-type IDs are supported.

### SOAP envelope wrapping (new)

`buildSoapEnvelopeXml()` composes `<env:Envelope><env:Header>…</env:Header><env:Body/></env:Envelope>`.
SOAP Body is empty by Peppol TIA §3.3 — the UBL payload travels as a
MIME attachment on the multipart body the direct sender builds.
`ds:Signature`, when present, sits after `<eb:Messaging>` inside the
header.

### XAdES-BES signing stub (new)

`Signer` port + `PEPPOL_SIGNATURE_ALGORITHMS` (xml-exc-c14n, rsa-sha256,
sha256 — Peppol TIA §3.5). `StubSigner` produces a structurally-valid
`<ds:Signature>` with:

- `<ds:SignedInfo>` with one `<ds:Reference>` per target (SOAP
  header via `URI="#_messaging"`, each attachment via `URI="cid:…"`)
  plus one for the XAdES `<xades:SignedProperties>`
- `<ds:SignatureValue>` — a deterministic placeholder string
- `<ds:KeyInfo>` with `<ds:X509IssuerSerial>` and a dummy
  `<ds:X509Certificate>`
- `<ds:Object>` containing `<xades:QualifyingProperties>` ->
  `<xades:SignedProperties>` -> `SigningTime` + `SigningCertificate`

The digest values are real sha256 of the inputs, but computed over
uncanonicalised bytes — any real verifier WILL reject. The stub
exists so the envelope + SOAP + HTTP layers can be exercised end to
end before KMS is wired. A real KMS-backed signer is a drop-in
replacement for the `Signer` interface.

### mTLS HTTP client (new)

`createMtlsHttpClient()` wraps `node:https.Agent` in a fetch-shaped
API:

- PEM `cert` / `key` / optional `ca` + `passphrase` (strings, so env
  vars and KMS-decrypted secrets flow through without a filesystem
  round-trip)
- TLS 1.2 minimum; `rejectUnauthorized: true`
- 30 s connect timeout + 60 s total timeout (configurable, enforced
  with `AbortController`)
- Agent is kept-alive and reused across requests
- Injectable `fetch` for tests

Throws `MtlsConfigurationError` on bad PEM / bad timeouts,
`MtlsTimeoutError` on either timeout tripping.

### SMP lookup (new)

`SmpClient` runs the standard Peppol SMP GET:

```
GET <baseUrl>/<encodedParticipantId>/services/<encodedDocumentTypeId>
```

against the Oman OTA T-SMP (`https://test-smp-ext-api.taxoman.gov.om/v1/secure/smp/wrapper`)
or any BDXR-compatible SMP. The parser reads the standard OASIS
busdox `ServiceMetadata` schema that the Oman OTA SMP spec reuses
(OTA Oman SMP API Specifications v1.0 §2.2). It returns the C3 AS4
endpoint URL, the X.509 certificate, and the "requires business-level
signature" flag. Multiple endpoints per process are supported; the
client filters for `peppol-transport-as4-v2_0` by default.

Error taxonomy:
- `SmpEndpointNotFoundError` for HTTP 404 and for responses that
  don't carry a matching transport profile
- `SmpHttpError` for other non-2xx responses (with `status` +
  `responseBody`)
- `SmpLookupError` for network failures and parse errors (with
  `cause`)

### Direct AS4 sender (new)

`DirectAs4Sender` composes all of the above into one `As4Sender`:

1. Serialize the Messaging header
2. Sign header + attachment through `Signer`
3. Compose the SOAP envelope
4. Resolve the C3 endpoint via `EndpointResolver` (static or
   SMP-backed)
5. Build the `multipart/related; type="application/soap+xml"` body
6. POST through the mTLS client
7. Parse the AS4 receipt from the response body; return
   `{status: 'accepted' | 'rejected' | 'error', messageId, errors?}`

The `MockAs4Sender` and the partner-ASP skeleton are still the
defaults; the direct sender is wired at the DI layer once the KMS
signing key is provisioned.

## What's still stubbed

| Concern | What's left |
| --- | --- |
| **Real XAdES-BES signing key** | `StubSigner` returns a deterministic fake digest and signature; real KMS wiring produces a real digest over the C14N-canonicalised header + attachment. Swap for a `KmsSigner` implementing the `Signer` port once the OpenPeppol production X.509 certificate is provisioned. |
| **XMLDsig canonicalisation** | We do not yet run exc-c14n over the header/attachment before digesting — the stub digest is over the raw bytes. A real `Signer` must canonicalise before digesting (the `Signer` port already takes `xml`/`bytes` on each target so the caller can choose whether to canonicalise upstream or inside the signer). |
| **Attachment transforms** | AS4 SwA attachments use the `Attachment-Content-Signature-Transform`; the stub emits the transform URI but does not apply it (stub digest is raw bytes). A real signer applies the transform before digesting. |
| **Receipt signature verification** | `parseAs4Receipt` structurally parses the NRR / Error signal; it does not verify the receipt's signature. Verification is a job for the `Verifier` port once the trust-store work is done. |
| **Non-200 synchronous responses as retries** | The direct sender surfaces non-2xx as `error`. Wire it behind the `PartnerAspClient`-style retry wrapper once the C3 endpoint's actual 5xx behaviour is understood. |
| **SMP response signature verification** | `parseSmpServiceMetadata` ignores `<SignedServiceMetadata>` wrappers and does not verify the SMP's own XMLDsig. The OpenPeppol transport-infrastructure trust chain lands in a follow-on PR. |
| **SMP Redirect chains** | A `<smp:Redirect>` response throws `SmpParseError`. Supporting it needs signed-chain verification (same KMS trust-store work). |

## Jan 31 2027 sandbox milestone — acceptance criteria

The OTA Fawtara sandbox AS4 transmission lands on:

1. Faatora produces a BIS Billing 3.0 UBL invoice and runs the full
   `canonicalToSemantic` -> `semanticToPintOm` -> `pintOmToUbl`
   pipeline, with the AS4 envelope then built by
   `buildAs4UserMessage`.
2. `SmpClient.lookupAs4Endpoint` resolves the recipient C3 against
   `test-smp-ext-api.taxoman.gov.om` and returns an
   `peppol-transport-as4-v2_0` endpoint URL + certificate.
3. A `Signer` implementation backed by the KMS-provisioned sandbox
   key signs the header + attachment with `rsa-sha256` over
   exc-c14n-canonicalised content.
4. `DirectAs4Sender` POSTs the multipart body over mTLS (sandbox
   client certificate) and receives a SignalMessage.
5. `parseAs4Receipt` classifies the response as `'accepted'` with a
   non-repudiation receipt that references the sent `MessageId`.

Steps 1, 2, 4 and 5 are code-complete in this PR behind test doubles.
Step 3 (real `Signer`) and the production SMP + endpoint PKI roots
(step 2's trust chain) are the remaining items before the sandbox
hit.

## Using it from a NestJS service

```typescript
import {
  DirectAs4Sender,
  SmpClient,
  OMAN_T_SMP_BASE_URL,
  StubSigner,
  buildAs4UserMessage,
  createMtlsHttpClient,
  makeIso6523ParticipantId,
  PEPPOL_BIS_BILLING_3_INVOICE,
  type As4Sender,
} from '@faatora/compliance';

const mtls = createMtlsHttpClient({
  credentials: {
    cert: process.env.FAATORA_AS4_CLIENT_CERT_PEM!,
    key: process.env.FAATORA_AS4_CLIENT_KEY_PEM!,
  },
});

const smp = new SmpClient({
  baseUrl: OMAN_T_SMP_BASE_URL,
  httpClient: mtls,
});

const sender: As4Sender = new DirectAs4Sender({
  signer: new StubSigner(),               // swap for KmsSigner in prod
  signingKeyRef: { keyRef: process.env.FAATORA_AS4_SIGNING_KEY_REF! },
  httpClient: mtls,
  endpointResolver: {
    async resolve(message) {
      const buyer = message.envelope.messageProperties.finalRecipient;
      const resolved = await smp.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE);
      return resolved.endpoint.endpointUrl;
    },
  },
});
```

For tests, keep using `MockAs4Sender` — it is still the baseline
every real adapter is held against.
