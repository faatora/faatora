# Observability setup: Sentry + PagerDuty

Post-merge runbook for the `feat/observability-setup` PR. Ahmed does
the account + secret work; the code is already shipped and will boot
cleanly without any of these vars (Sentry init is DSN-gated, the
PagerDuty webhook controller 503s on first hit, the Events API
client logs once and no-ops).

All secret values go through **AWS Secrets Manager** (api, ECS task)
and **Vercel project env vars** (web). Nothing in this doc gets
checked into git.

---

## 1. Sentry

### 1.1 Create the org + two projects

1. Sign up at [sentry.io](https://sentry.io) with the shared ops
   mailbox. Choose the Team plan (we need Replays + Performance).
2. Create one organisation: `faatora`.
3. Inside it, create **two** projects:
   - `faatora-api`  — platform: Node.js (Express).
   - `faatora-web`  — platform: React.
4. In each project, open **Settings → Client Keys (DSN)** and copy the
   DSN. These are the values you will paste into Secrets Manager /
   Vercel below.

### 1.2 Store the DSNs

**API (Secrets Manager):**

```
faatora/staging/sentry-dsn-api      ← apps/api staging DSN
faatora/prod/sentry-dsn-api         ← apps/api prod DSN
```

Add two matching entries pointing the ECS task definition at each
secret, env key `SENTRY_DSN`. Example task-definition fragment:

```json
"secrets": [
  {
    "name": "SENTRY_DSN",
    "valueFrom": "arn:aws:secretsmanager:me-south-1:<acct>:secret:faatora/prod/sentry-dsn-api"
  }
]
```

Also set the two sample rates **as plaintext env vars** on the task
(they are not secrets):

```
SENTRY_TRACES_SAMPLE_RATE=0.1
SENTRY_PROFILES_SAMPLE_RATE=0.1
```

Bump them temporarily when debugging; a 1.0 traces rate will roughly
double our monthly Sentry spend.

**Web (Vercel):**

In the Vercel project (`faatora-web`), **Settings → Environment
Variables** add:

| Key                               | Value                 | Environments            |
| --------------------------------- | --------------------- | ----------------------- |
| `VITE_SENTRY_DSN`                 | web project's DSN     | Production, Preview     |
| `VITE_SENTRY_TRACES_SAMPLE_RATE`  | `0.1`                 | Production, Preview     |

Do **not** set `VITE_SENTRY_DSN` on Development: the local `vite dev`
inlines whatever is there and we want local errors staying local.

### 1.3 Source-map upload (CI only)

1. In Sentry, **Settings → Account → Auth Tokens** → create a token
   scoped to `project:releases` + `project:write`. Name it
   `github-actions-sourcemaps`.
2. In the GitHub repository, **Settings → Secrets and variables →
   Actions** add three repo secrets:

   ```
   SENTRY_AUTH_TOKEN    ← the token from step 1
   SENTRY_ORG           ← "faatora"
   SENTRY_PROJECT       ← "faatora-web"
   ```

3. The `apps/web/vite.config.ts` plugin picks these up automatically
   (it is gated on all three being set). CI builds will start
   uploading source maps on the next merge.

### 1.4 Smoke test

After deploy:

1. In staging, hit an endpoint that we know throws — e.g. the
   `/api/health/throw` canary if we add one, or temporarily throw
   from any handler via a feature-flagged branch. The error should
   land in the `faatora-api` project within ~30s with the `tenant_id`
   / `user_id` / `correlation_id` tags populated from the request.
2. In the web app, open the browser console on the staging URL and
   run `throw new Error('sentry smoke test')`. The error should land
   in `faatora-web` with a Replay attached (first replay session may
   take ~60s to show in the UI).

---

## 2. PagerDuty

### 2.1 Account + service

1. Sign up at [pagerduty.com](https://www.pagerduty.com/) with the
   same ops mailbox. Business plan (Professional tier is enough for
   now; Business adds the status page integration we want later).
2. Create one team: `faatora-oncall`.
3. Create one **service**: `faatora-api`. Alert grouping: time-based,
   2 min window. Alert integration type: **Events API v2**.
4. Copy the **integration key** (routing_key, 32-char hex).

### 2.2 Store the routing key

```
faatora/staging/pagerduty-routing-key
faatora/prod/pagerduty-routing-key
```

Wire into the ECS task definition:

```json
"secrets": [
  {
    "name": "PAGERDUTY_ROUTING_KEY",
    "valueFrom": "arn:aws:secretsmanager:me-south-1:<acct>:secret:faatora/prod/pagerduty-routing-key"
  }
]
```

The outbound `PagerDutyService` will now actually page on
`trigger()`. Without this secret it remains a no-op (see the service
doc comment).

### 2.3 Webhook subscription (inbound)

Only needed if we want PagerDuty to call Faatora back on
`incident.*` events (for the future status-page work flagged TODO in
`apps/api/src/modules/alerts/pagerduty.controller.ts`).

1. In the PagerDuty UI, **Integrations → Webhooks → New Webhook**.
2. Deliver to: `https://api.faatora.om/api/webhooks/pagerduty`.
3. Event subscriptions: `incident.triggered`, `incident.acknowledged`,
   `incident.resolved`.
4. Set a shared **secret** (generate 32 random bytes); PagerDuty
   signs every delivery with HMAC SHA256 using this secret.
5. Store the secret:

   ```
   faatora/staging/pagerduty-webhook-secret
   faatora/prod/pagerduty-webhook-secret
   ```

6. Add to the ECS task env as `PAGERDUTY_WEBHOOK_SECRET`. Without it
   the controller returns 503 and PagerDuty will retry — ops will
   see this immediately in the PD delivery log.

### 2.4 Smoke test

1. Trigger from code: open a temporary route that calls
   `pagerDutyService.trigger({ summary: 'smoke test', severity:
   'info', source: 'faatora-api-staging' })`. A low-severity
   incident should show up in the PD UI within a few seconds. Resolve
   it with `pagerDutyService.resolve(dedupKey)`.
2. Webhook delivery: open the webhook in the PD UI, click **Send
   test event**. The API log should contain
   `pagerduty webhook received` with the event type; a failed
   signature instead shows a 401 in the PD delivery log — check that
   the secret stored in AWS matches the one you pasted into PD.

---

## 3. Local development

Nothing to do. All three env vars (`SENTRY_DSN`, `VITE_SENTRY_DSN`,
`PAGERDUTY_*`) are unset in `.env.example` and the code paths are
feature-flagged so local dev runs exactly as before. Set them
locally only when you want to verify the wiring end-to-end against a
staging-only Sentry project.

---

## 4. Rollback

If Sentry spend spikes or blocks a deploy:

- Set `SENTRY_TRACES_SAMPLE_RATE=0` and redeploy — kills traces +
  profiles but keeps error capture.
- Remove the `SENTRY_DSN` env var and redeploy — the SDK is a no-op
  on boot without a DSN, so nothing further is captured. No code
  change needed.

If PagerDuty flaps:

- Unset `PAGERDUTY_ROUTING_KEY` on the task — outbound stops paging.
- Disable the webhook subscription in the PD UI — inbound stops
  delivering. Server-side code stays as is.
