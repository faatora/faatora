# Paymob UAT Integration Plan for Faatora (Firm-Console Billing)

Status: research draft. Author: billing-adapter agent. Date: 2026-11-08.
Primary sources below are all Paymob official pages
(developers.paymob.com, docs.oman.paymob.com), plus licence reporting from
Fintech Futures, Arabian Business, and the National Bank of Oman press
release. Login-walled artifacts (merchant onboarding form, fee schedule,
commercial contract) are flagged as UNVERIFIED and must be confirmed by
Ahmed from the Paymob sandbox or a sales call.

## Executive summary

- Paymob holds a Payment Service Provider licence from the Central Bank of
  Oman (granted January 2024) and runs a regional stack at
  `oman.paymob.com` with the National Bank of Oman as the acquiring and
  settlement partner. A direct-contract path for an Omani LLC is
  plausible but is NOT publicly documented. Ahmed must confirm this with
  Paymob commercial before Faatora commits.
- The subscription primitive exists (`Create Subscription Plan` under
  developers.paymob.com) but the endpoint requires a "MIGS Moto
  integration ID", an acquirer-side artefact that is Egypt-oriented and
  is NOT publicly documented as available for Oman merchants. Treat
  Paymob Subscriptions as unverified-in-Oman until sandbox confirms.
- There is no hosted self-serve customer portal. Stripe's Customer
  Portal has no Paymob equivalent. Faatora must build the
  change-card, change-plan, cancel, invoice-history UI in-app. Rough
  cost: 2 to 3 engineer-weeks.
- Webhooks are signed with HMAC-SHA512 over 20 specified callback
  fields concatenated without a separator and delivered as a `?hmac=`
  query parameter, NOT a header, and NOT over the raw body. The
  existing Stripe webhook controller needed a minor change to accept
  the query parameter for the Paymob adapter.
- Recommendation: Paymob is a strong strategic fit for Oman but is NOT
  ready to replace Stripe for firm-console billing today. Keep the
  Stripe path as primary for UAT (Meydan entity), scaffold Paymob
  behind the `BILLING_PROVIDER` switch so it is a one-env-var flip once
  Ahmed verifies onboarding and subscription support with Paymob sales.

## 1. Oman onboarding reality

Paymob holds a full PSP licence from the Central Bank of Oman, granted
January 2024, and announced in regional press at the time as "the first
international fintech company to be fully licenced in Oman"
([Fintech Futures](https://www.fintechfutures.com/paytech/paymob-lands-psp-licence-from-oman-s-central-bank),
[Arabian Business](https://arabianbusiness.com/industries/banking-finance/major-fintech-firm-paymob-receives-oman-licence-in-regional-first)).
The licence lets Paymob accept and process online and in-store payments
inside Oman through integration with the CBO's OmanNet rails.

In August 2024 Paymob announced a strategic alliance with the National
Bank of Oman
([NBO press release](https://www.nbo.om/en/Pages/News/National-Bank-of-Oman-and-Paymob-Forge-Strategic-Alliance-to--Transform-Oman's-Digital-Landscape.aspx)).
NBO provides the acquiring, POS terminals, corporate internet banking,
and a PSP custody account under CBO guidelines. The release targets
"Micro-, Small-, and Medium-sized Businesses across Oman" but does not
restrict eligibility to any legal form.

What this adds up to:

- Paymob can contract with Omani merchants directly. There is a
  dedicated Oman tenant at `oman.paymob.com` with its own dashboard,
  regional base URL, and OmanNet integration
  ([Paymob Oman docs](https://docs.oman.paymob.com/docs/integration-process)).
- Settlement is presumed to be into an NBO (or any Omani bank) local
  account in OMR. NBO is the named banking partner; other local banks
  likely work since the PSP licence is CBO-level, but this is NOT
  publicly confirmed.
- The required KYC-and-commercial documents for a new Omani merchant
  are NOT published. Paymob documentation says business verification is
  a prerequisite before sandbox or live mode is unlocked
  ([Getting Started](https://developers.paymob.com/paymob-docs/developers))
  but does not list the specific documents.

**Unverified items that Ahmed must confirm with Paymob sales before
Faatora commits:**

- Whether Modern Venture Shelter LLC in Muscat, as a standard Omani
  LLC (not free-zone, not UAE subsidiary) can sign the Paymob merchant
  agreement directly.
- The exact onboarding document pack. Based on neighbouring provider
  requirements (Tap Payments for Oman, PayTabs) the expected list is:
  Commercial Registration (CR), VAT certificate, Chamber of Commerce
  certificate, owner ID, Articles of Association, signatory ID, Omani
  bank letter or IBAN certificate, and a business profile. Paymob is
  likely similar but Ahmed must get this in writing.
- Settlement bank list. NBO is confirmed as a partner. Bank Muscat,
  Sohar International, or HSBC Oman accounts should work since the CBO
  licence is bank-neutral but this must be confirmed.
- Settlement currency. OMR is confirmed as the processing currency in
  the Oman Intention API examples. Settlement should match but this
  must be confirmed.
- CR of the Paymob local legal entity in Oman, for Faatora's
  counterparty-risk file.

Primary recommendation: Ahmed emails commercial@paymob.com or uses the
onboarding wizard at the Oman dashboard, naming the entity and asking
for the merchant application pack for a standard Omani LLC. A one-day
turnaround is realistic. The answer to that email is the deciding
factor between Paymob-primary and Stripe-primary.

## 2. Product fit for firm-console subscription billing

Paymob documents three recurring-payment primitives. None is a
drop-in Stripe Billing equivalent.

### 2.1 Subscriptions API (global developer docs)

Documented at
[Create Subscription Plan](https://developers.paymob.com/paymob-docs/developers/subscription/create-subscription-plan)
and conceptually at
[Subscriptions overview](https://developers.paymob.com/paymob-docs/payments-and-features/core-features/subscriptions).

Key facts:

- Endpoint is `POST /` on a region-specific base URL with
  `Authorization: Bearer <auth_token>`. Bearer token is obtained from a
  separate Authentication Request and is valid for one hour.
- Plan fields: `name`, `frequency` (allowed values 7, 15, 30, 60, 90,
  180, 360 days only), `integration` (a "MIGS Moto integration ID"),
  `amount_cents`, `webhook_url`, `reminder_days`, `retrial_days`,
  `plan_type` ("rent"), `number_of_deductions`, `is_active`.
- Once a customer is enrolled, Paymob handles the recurring charge on
  schedule without merchant intervention.

Gaps versus Stripe Billing:

- No trial-days field. Stripe has first-class trials; Paymob has none
  documented.
- `frequency` is a closed list of integers. No arbitrary intervals
  (weekly, semi-annual), no "first of the month" calendar anchoring.
- `plan_type: "rent"` is the only documented value, suggesting the
  feature is tuned for landlord-rent use cases, not SaaS subscriptions.
- The `integration` field is called a "MIGS Moto integration ID". MIGS
  is Mastercard Internet Gateway Service, the legacy gateway used in
  Egypt and some KSA setups. The Oman docs do NOT mention MIGS Moto.
  The Oman "Pay with Saved Token" flow talks about OMANNET MOTO
  transactions, which are a different acquirer configuration
  ([Oman saved token docs](https://docs.oman.paymob.com/docs/pay-with-saved-token)).
  **This is the single biggest unknown in the integration.** It is
  entirely possible the Subscriptions API works in Oman but requires a
  dedicated integration ID that Paymob provisions by request. It is
  also possible the API does not work in Oman at all. Must be verified
  in sandbox before Faatora picks Paymob as primary.
- No prorations on plan change. No credit notes. No invoice object
  that mirrors Stripe's `invoice.finalized` flow for the firm's
  bookkeeping.
- Webhook events for subscription lifecycle are not catalogued in the
  public docs. Paymob confirms a `webhook_url` field on the plan but
  does not list the event types delivered there.

### 2.2 Tokenized card plus server-side scheduler (fallback)

If the Subscriptions API cannot be used in Oman, Faatora can emulate
subscriptions using saved card tokens plus a server-side cron.

Flow documented at
[Pay with Saved Card Token (Oman)](https://docs.oman.paymob.com/docs/pay-with-saved-token)
and
[CIT / MIT (global)](https://developers.paymob.com/paymob-docs/developers/pay-with-saved-cards/cit):

1. Customer completes a first 3DS card transaction via the Intention
   API. Paymob returns a card token to the merchant webhook.
2. Store token on the `firms` row.
3. Each billing period, Faatora's cron creates a new Intention with
   the stored token in the `card_tokens` array and triggers a
   merchant-initiated transaction.

Gotchas confirmed in the docs:

- The Oman saved-token docs state: "you need to pass `cvn` for OMANNET
  MOTO transactions". That is CVV. A merchant-initiated transaction
  that requires CVV is not a true MIT, because the merchant does not
  hold CVV after the first charge under PCI rules. For OmanNet-issued
  cards this means recurring is effectively not supported unattended.
  For Visa and Mastercard tokens the saved-card flow with `source.
  subtype: "TOKEN"` should work but the docs do not spell out whether
  CVV is required on re-use for those networks either. Must be
  verified in sandbox.
- "Recurring payments require a separate setup: ask your technical
  contact, who will provide an extra integration ID in your dashboard"
  ([Pay with Saved Token](https://docs.oman.paymob.com/docs/pay-with-saved-token)).
  Confirms that a Paymob-side provisioning step is required beyond the
  default merchant onboarding.

Building Faatora's own scheduler is the more defensible path for UAT
because it does not depend on Paymob's unverified Subscriptions API
and because Faatora already runs a NestJS `@nestjs/schedule` worker
for other close-of-day jobs. Dunning (retry on soft decline), proration
on plan change, and invoice generation would all become Faatora's
responsibility.

### 2.3 Payment Links (not viable for subscriptions)

[Payment Links](https://developers.paymob.com/paymob-docs/integration-paths/no-code/payment-links.md)
are shareable URLs for one-time payments. Docs do not mention recurring
use, and the feature is marketed for social selling and email
invoicing, not SaaS. Rejected as a subscription primitive.

### 2.4 Verdict on product fit

Paymob's subscription story is a 60 percent fit at best. Stripe Billing
offers: trials, prorations, calendar anchoring, dunning, invoice
objects with hosted URLs, customer portal, and a broad event catalogue.
Paymob offers: a flat "charge this amount every N days" primitive plus
MIGS-style tokenization that is probably Egypt-only. For an OMR 300 to
500 per seat per year subscription where the firm pays annually in one
charge, the simpler primitive is enough, but every ancillary feature
(portal, invoice history, dunning) becomes Faatora's engineering cost.

## 3. Self-serve customer portal

Paymob has no hosted customer portal. Searching the official docs,
Hookdeck's Paymob integration guide, the llms.txt docs index, and the
Oman docs returns zero results for a self-serve portal page. This is
confirmed by absence; by comparison, Stripe's Customer Portal, Paddle's
Retain, and Recurly's Customer Portal all have dedicated top-level
documentation.

Consequence for Faatora:

- Firms cannot change a card, upgrade or downgrade a plan, cancel, or
  view invoice history without a Faatora-built UI.
- The `getCustomerPortalUrl` method on the `BillingProvider` interface
  returns a Faatora-hosted route under `/firm/settings/billing` for
  Paymob. That URL is what the Paymob adapter yields in
  `getCustomerPortalUrl`.
- Engineering cost estimate: 2 to 3 engineer-weeks for a basic portal
  (card update via Intention API with a new 3DS, plan picker with
  cancel-and-recreate subscription, invoice table backed by the
  `billing_webhook_events` table filtered by `invoice.*` types).

This is the single largest hidden cost of a Paymob-primary decision.

## 4. Pricing and fees

No public rate card exists for Paymob Oman. Fees are a sales-call
artifact. The regional reporting
([Launch Base Africa](https://launchbaseafrica.com/2026/09/21/paymob-scoops-35m-as-gcc-market-hits-nearly-half-of-group-revenue/))
notes that GCC is now near half of Paymob group revenue, which suggests
competitive pricing against the regional incumbents (Checkout.com,
PayTabs, Network International).

Expected ballpark based on regional comparables:

- Local card (OmanNet): 1.5 to 2.0 percent per transaction.
- Regional card (GCC Visa, Mastercard): 2.5 to 2.9 percent.
- International card: 3.0 to 3.5 percent.
- Setup fee and monthly minimum: variable, often waived at onboarding.
- No annual commitment is standard in the region.

Stripe's typical 2.9 percent + fixed + currency conversion fee for an
Omani merchant run through a UAE Meydan entity is between 4 and 5
percent effective once FX is included. Paymob Oman settling in OMR
should materially undercut this on local-card volume.

**Unverified. Ahmed must get a written quote.**

## 5. Supported currencies, cards, wallets

From the Paymob docs:

- **Currencies in Oman**: OMR is the primary currency in the Oman
  Intention API examples. No multi-currency support is documented for
  the Oman tenant.
- **Card networks**: Visa, Mastercard, American Express, OmanNet
  (local Omani card scheme). Confirmed at the global
  [Payment Methods](https://developers.paymob.com/paymob-docs/payments-and-features/payment-methods)
  index.
- **Local Oman wallets**: None are listed. mPay (Bank Muscat wallet),
  OmanPay, and the Thawani wallet are not integrated. Faatora's Thawani
  path, which has its own module, remains the correct choice for any
  wallet-based SME flow.
- **Apple Pay**: Listed as all-region, gated on merchant-side
  activation.
- **Google Pay**: Listed for KSA and UAE only. Not Oman.
- **mada**: KSA-only.

For firm-console subscription billing where the firm almost always
pays with a corporate Visa or Mastercard, this coverage is adequate.

## 6. API and integration surface

### 6.1 Flow: Intention API

The modern integration path is the Intention API
([Create Intention](https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention)):

- Base URL: `https://oman.paymob.com/` for Oman, test and live use the
  same base URL and are differentiated by key prefix (`sk_test_` vs
  `sk_live_`).
- Auth: `Authorization: Token <secret_key>` for merchant-server to
  Paymob calls.
- Flow: `POST /v1/intention` with `amount` (cents), `currency`,
  `payment_methods` (array of integration IDs), `billing_data`,
  `extras`, `special_reference`, `notification_url`, `redirection_url`
  . Response carries `client_secret` and `payment_keys`.
- Client redirects to Paymob's Unified Checkout at a unified URL built
  from the `client_secret`, or renders the Pixel component.

### 6.2 Webhook signature

Documented at
[HMAC Transaction Callback](https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback).

- Algorithm: HMAC-SHA512, hex-encoded.
- Signature is passed as the `hmac` **query parameter** (for both the
  server-to-server Processed POST and the client-redirect Response
  GET). It is NOT a header, and crucially, it is NOT computed over the
  raw body.
- Fields signed, concatenated with no separator, in this order:
  `amount_cents`, `created_at`, `currency`, `error_occured`,
  `has_parent_transaction`, `obj.id` (POST) or `id` (GET),
  `integration_id`, `is_3d_secure`, `is_auth`, `is_capture`,
  `is_refunded`, `is_standalone_payment`, `is_voided`, `order.id`
  (POST) or `order_id` (GET), `owner`, `pending`, `source_data.pan`,
  `source_data.sub_type`, `source_data.type`, `success`.
- Booleans serialize as JavaScript lowercase `true` / `false`.
- Rotate the secret in Dashboard Settings > Account Info > HMAC.

Consequence for Faatora's existing webhook controller:

- The Stripe controller reads a `stripe-signature` header. The Paymob
  controller must also read the `hmac` query parameter. The simplest
  pattern is to extend the existing controller to accept whichever is
  present and pass it through the port as the `signature` argument;
  the Paymob adapter then does the HMAC-over-fields reconstruction
  internally. The `rawBody` argument remains the request body buffer;
  the Paymob adapter JSON-parses it and reads the fields it needs.

### 6.3 Event model

Paymob does NOT have Stripe-style discrete event names. Every callback
has `type: "TRANSACTION"` and merchant logic branches on boolean flags
(`success`, `is_refunded`, `is_voided`, `is_capture`, `is_auth`,
`pending`). The `FirmBillingService.handle()` switch for the Paymob
branch must adapt. The Paymob adapter synthesises a Stripe-like
`type` string from the booleans before handing the event to the
service, so the switch stays legible. Mapping:

| Paymob booleans | Synthesised `type` |
|---|---|
| `success=true && is_refunded=false && is_voided=false` | `transaction.paid` |
| `success=false && pending=false` | `transaction.failed` |
| `is_refunded=true` | `transaction.refunded` |
| `is_voided=true` | `transaction.voided` |
| `pending=true` | `transaction.pending` |

### 6.4 SDK availability

- iOS, Android, Flutter, React Native SDKs exist.
- No official Node.js SDK. Community PHP and Elixir packages exist but
  are not a basis for a NestJS adapter. Faatora's adapter calls Paymob
  over `fetch` directly, matching the pattern the Stripe adapter uses
  (a narrow `PaymobHttpClient`-style port that tests mock).

### 6.5 Rate limits and errors

Not documented publicly. Must be verified in sandbox. Adapter uses
standard exponential-backoff retries on 429 and 5xx, same as the
Stripe adapter's `maxNetworkRetries` posture.

## 7. PCI scope

- Unified Checkout (Paymob-hosted, full page redirect): SAQ A. Card
  data never touches Faatora's servers or browser.
- Pixel component (embedded iframe): SAQ A-EP. The iframe is served by
  Paymob and the card inputs are isolated from Faatora's DOM, but the
  parent page must be in scope.
- Direct Card API: SAQ D. Not applicable here because Faatora will not
  collect raw card data.

Firm-console UAT uses Unified Checkout. PCI scope stays at SAQ A, same
as the Stripe Checkout path.

## 8. UAT / sandbox setup playbook

Ahmed-side steps, in order:

1. Register a Paymob Oman merchant account at `oman.paymob.com`.
   Name: Modern Venture Shelter LLC, Muscat. Use the onboarding wizard
   to upload CR, VAT certificate, bank letter. Expected turnaround for
   sandbox access: hours; for live mode: days to weeks.
2. In the dashboard, Settings > Developers > API Keys, copy:
   - API Key (same across modes)
   - Secret Key (`sk_test_...` for sandbox)
   - Public Key (`pk_test_...` for sandbox)
3. Settings > Payment Integrations: note the Integration ID for `card`
   and for `omannet`. Open each and set:
   - Webhook URL: `https://uat.faatora.om/api/billing/webhook`
   - Redirect URL: `https://uat.faatora.om/firm/billing/return`
4. Copy the HMAC secret from Settings > Account Info > HMAC.
5. Separately request a "subscription" or "card-on-file" integration
   ID if Faatora intends to try the Subscriptions API or saved-token
   recurring. Contact Paymob technical support with the merchant
   account name and ask for the MOTO or MIGS Moto integration ID
   provisioned on the Oman tenant.
6. Populate `.env` with `BILLING_PROVIDER=paymob`,
   `PAYMOB_API_KEY`, `PAYMOB_SECRET_KEY`, `PAYMOB_HMAC_SECRET`,
   `PAYMOB_INTEGRATION_ID`, `PAYMOB_IFRAME_ID`.

Test cards: Paymob's public developer docs do NOT publish a
sandbox test card table. This is a documented gap; test cards are
distributed by Paymob support on request after the sandbox account is
provisioned. Treat as UNVERIFIED and expect to ask support. Common
test numbers inherited from the MIGS acquirer (`5123450000000008` for
success, `4000000000000119` for decline) sometimes work in Paymob
sandbox but this is not an official statement.

Webhook simulation: Paymob does not have a "send test event" button
in the dashboard that is comparable to Stripe's CLI. The practical way
to trigger a webhook is to run a sandbox transaction through the
Unified Checkout and let it POST back. For replay-safety and
idempotency testing, the webhook can be hand-crafted and `curl`'d at
Faatora's endpoint with a computed HMAC query parameter; the unit
tests scaffolded in this work use exactly this approach.

## 9. Recommendation

**Primary recommendation: Stripe for UAT, Paymob behind a
`BILLING_PROVIDER=paymob` flip once Ahmed verifies two things.**

Specifically:

- Ship the Stripe adapter to UAT behind the Meydan or IFZA entity.
  This path is known-good, has a Customer Portal, has 19 passing
  tests in the repo today, and is the only path that lets Faatora
  demonstrate firm-console subscription billing to prospective
  accountant-firm customers on the current timeline.
- Scaffold the Paymob adapter in parallel (this deliverable). Keep it
  wired through the same `BillingProvider` port, selected via
  `BILLING_PROVIDER=paymob`. No code change is needed to flip.
- Ahmed emails Paymob commercial this week with two specific
  questions:
  1. Can Modern Venture Shelter LLC in Muscat sign the Paymob
     merchant agreement directly, with settlement into an Omani bank
     account in OMR?
  2. Does the Paymob Subscriptions API (or an equivalent recurring
     primitive with Visa/Mastercard tokens, no CVV on re-use) work on
     the Oman tenant? If so, what is the integration ID type and how
     is it provisioned?
- If both answers are yes, flip the switch on the next deployment.
  Faatora retains the Oman operating entity for accountant-firm
  billing. No UAE second-entity cost (AED 12-20k per year, 2 to 4
  weeks setup) is incurred. Stripe stays dormant behind the flag for
  international accountants if and when they show up.
- If answer 1 is no, Paymob is dead and Stripe wins by default.
- If answer 1 is yes but answer 2 is no, Faatora picks Paymob only if
  it is willing to pay 2 to 3 engineer-weeks to build a server-side
  recurring scheduler plus the entire self-serve portal. For an
  Oman-only OMR 300 to 500 per seat per year product, that is
  probably worth it; for an internationally-ambitious product, Stripe
  Billing is cheaper.

The scaffold in `apps/api/src/modules/billing/firm/paymob-billing.ts`
plus its env wiring makes the switch a one-line config flip once
Ahmed clears onboarding and subscription support with Paymob sales.

## Sources

- Paymob Developer Docs: https://developers.paymob.com/paymob-docs/developers
- Paymob Oman Integration Guide: https://docs.oman.paymob.com/docs/integration-process
- Paymob Oman Pay with Saved Token: https://docs.oman.paymob.com/docs/pay-with-saved-token
- Paymob Create Intention: https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention
- Paymob Subscriptions overview: https://developers.paymob.com/paymob-docs/payments-and-features/core-features/subscriptions
- Paymob Create Subscription Plan: https://developers.paymob.com/paymob-docs/developers/subscription/create-subscription-plan
- Paymob CIT (Saved Cards): https://developers.paymob.com/paymob-docs/developers/pay-with-saved-cards/cit
- Paymob HMAC Transaction Callback: https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback
- Paymob Getting Integration Credentials: https://developers.paymob.com/paymob-docs/need-help/setup-guides/getting-integration-credentials
- Paymob Payment Methods: https://developers.paymob.com/paymob-docs/payments-and-features/payment-methods
- Fintech Futures (Paymob CBO PSP licence): https://www.fintechfutures.com/paytech/paymob-lands-psp-licence-from-oman-s-central-bank
- Arabian Business (Paymob Oman): https://arabianbusiness.com/industries/banking-finance/major-fintech-firm-paymob-receives-oman-licence-in-regional-first
- NBO Paymob Alliance: https://www.nbo.om/en/Pages/News/National-Bank-of-Oman-and-Paymob-Forge-Strategic-Alliance-to--Transform-Oman's-Digital-Landscape.aspx
- Hookdeck Paymob Webhooks guide: https://hookdeck.com/webhooks/platforms/guide-to-paymob-webhooks-features-and-best-practices.md
