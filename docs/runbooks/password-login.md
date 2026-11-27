# Runbook — POS password login (`POST /auth/login`)

**Severity:** `POST /auth/login` is the only way POS clerks sign in. A full outage means every shop stops issuing invoices. Treat sustained 5xx on this route as **P0** and unexpected 4xx spikes (especially 401s) as **P1** (possible credential-stuffing in progress).

## What this route is

```
POST /auth/login
Body:    { "email": "<string>", "password": "<string>" }
Returns: { "accessToken": "<cognito access JWT>",
           "tenantId":    "<uuid>",
           "expiresIn":   <ms until exp> }
```

The route is implemented in `apps/api/src/auth/auth.controller.ts` and
delegates to `apps/api/src/auth/cognito-auth.service.ts`, which calls
Cognito's `InitiateAuth` with `AuthFlow=USER_PASSWORD_AUTH`. The access
token returned is the one the rest of the API already verifies via
`TenantGuard` → `getCognitoVerifier()`.

The POS frontend (`apps/web/src/features/auth/api/auth.ts`) persists the
token + `tenantId` into `localStorage` and schedules a refresh off
`expiresIn`.

## Cognito user-pool configuration

This endpoint depends on the following on the user pool and its POS
app-client:

1. **App-client auth flow.** The app-client **must** have the
   `ALLOW_USER_PASSWORD_AUTH` flow enabled. Without it, Cognito rejects
   the `InitiateAuth` call with `InvalidParameterException: Auth flow
   not enabled for this client` — the service maps that to a generic
   500 to avoid leaking config detail, so a sudden 500 spike after a
   pool change is the first thing to check.

2. **Access token custom claim.** Each user must carry a
   `custom:tenant_id` attribute, and the app-client's Access Token
   customization must include it in the access token (not just the ID
   token) via the Pre-Token-Generation Lambda or by enabling the
   attribute in the client's read/write schema. The service rejects
   logins without this claim with `401 "no tenant assigned"`.

3. **Optional client secret.** The POS app-client may be provisioned
   with or without a client secret. If the secret is configured on the
   client, set `COGNITO_CLIENT_SECRET` on the API task — the service
   will compute and send `SECRET_HASH`. If the client has no secret,
   leave `COGNITO_CLIENT_SECRET` unset; sending a `SECRET_HASH` to a
   client without a configured secret causes Cognito to reject the call.

4. **Password policy.** Set the pool's password policy via Terraform (in
   `infra/modules/cognito` — or inline on the pool in `infra/modules/api`
   until the dedicated module lands) to match the OTA guidance:
   - Minimum length: 12 (the default of 8 is too low for POS devices
     sitting on a shop counter).
   - Require uppercase, lowercase, digits. Symbols: optional (POS clerks
     type on tablets; symbols drive forgotten-password churn).
   - Temporary password validity: 1 day. Admin-created POS clerks are
     onboarded on-site; a 7-day default is too lax.

5. **MFA.** The POS login flow does NOT support MFA challenges. If a
   user has `MFA = required` on the pool, `InitiateAuth` returns a
   `ChallengeName` (e.g. `SOFTWARE_TOKEN_MFA`) and the service maps it
   to `401 "mfa required; use the full web sign-in flow"`. For shops
   that need MFA, provision the clerk against the full web app, not the
   POS app-client. If the pool has MFA = optional, users who have not
   enrolled TOTP will complete `InitiateAuth` normally — this is the
   intended POS default.

## Rate limiting

Today the route is rate-limited at the **ALB layer** (per source IP) via
the `ratelimit_rules` in `infra/modules/alb` — 60 requests per minute
per source IP, 429 above. This is a blunt instrument; it protects
Cognito from a stuffing storm but does not slow down a careful
attacker rotating IPs.

A follow-up PR will add `@nestjs/throttler` with a 10/minute per-IP
limit specifically on `POST /auth/login`. The dep was intentionally
NOT pulled into this PR to keep the change surface small; tracking
issue filed as a TODO in the PR description. When investigating a
stuffing alert before that follow-up lands, the mitigation is:

1. Drop the ALB rule from 60/min to 20/min for the `/auth/login` path
   (console → ALB → Listener → Rules → edit the `AuthRateLimit` rule).
2. If the attacker is rotating IPs, enable AWS WAF's
   `AWSManagedRulesATPRuleSet` (credential-stuffing managed rule) on
   the same ALB. It flags `.ATPRuleSet > SignalCredentialCompromised`
   and blocks the request before it reaches the API.
3. Longer term: ship the Throttler follow-up and move
   `AWSManagedRulesATPRuleSet` to count-mode so we can see the WAF
   signal in CloudWatch without false-blocking legitimate POS clerks.

Cognito itself throttles `InitiateAuth` at ~5 rps per user pool; a
sustained stuffing wave will trip that limit and Cognito will return
`TooManyRequestsException`, which the service maps to a generic 500.
If 500s suddenly correlate with 401s, that is the signature of a
stuffing wave that got past the ALB — jump to step 2 immediately.

## Log signal

The controller emits three log lines per attempt, all at `info` /
`warn`, with these fields:

- `login attempt` (info): `email`, `ip`.
- `login success` (info): `email`, `ip`, `tenantId`.
- `login failed`  (warn): `email`, `ip`, `errorClass` (Cognito error
  class name, e.g. `NotAuthorizedException`, or `Error`).

Passwords are NEVER logged. The pino redact list in `app.module.ts`
drops `req.headers.authorization` and never serializes `req.body`, so
even a crash in the controller does not echo the password. The
`email` field is logged in full so SOC can tie an attempt to a user;
the service's warn-level log (on Cognito error) redacts the local-part
of the email as a second layer.

Alerts (configured in the PagerDuty wire-up from #31):

- `warn login failed` count by `errorClass=NotAuthorizedException`
  greater than 20/minute → P2 page to on-call.
- 5xx on `POST /auth/login` greater than 1% of traffic over 5 minutes
  → P1 page.

## Common failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Every login 500s | Cognito app-client missing `ALLOW_USER_PASSWORD_AUTH` | Enable the flow in the pool's app-client |
| Every login 500s, shortly after a pool-clone | `COGNITO_CLIENT_ID` points at the old client, or the new client has a secret but `COGNITO_CLIENT_SECRET` is unset (or vice versa) | Sync the API task's env to the cloned client |
| Users 401 "no tenant assigned" | Pre-Token-Generation Lambda did not fire, or `custom:tenant_id` not on the access-token schema | Check the Lambda trigger wiring; verify the attribute is in the app-client's Access Token Customization |
| Users 401 "mfa required" on a pool without MFA | A specific user has MFA enrolled (TOTP) while the pool is MFA-optional | Either remove the MFA factor for that user or route them through the full web sign-in flow |
| Slow logins (>2s p95) | Cognito cold-start from our region or pool-level throttling | Check CloudWatch `AWS/Cognito > ThrottleCount`; file a Cognito quota increase |

## Env vars

Set these on the API task definition:

- `AWS_REGION` — already set (defaults to `me-south-1`).
- `COGNITO_USER_POOL_ID` — the POS pool id.
- `COGNITO_CLIENT_ID` — the POS app-client id.
- `COGNITO_CLIENT_SECRET` — ONLY if the app-client has a secret
  configured. Omit otherwise. Pulled from Secrets Manager via the task
  definition (`secretsmanager:/faatora/<env>/cognito/pos-client-secret`).

## Related

- `apps/api/src/auth/cognito.ts` — access-token verifier used by every
  other guard. Shares the pool id + client id envs.
- `apps/api/src/auth/tenant.guard.ts` — guard that verifies tokens on
  all tenant-scoped reads/writes.
- `apps/web/src/features/auth/api/auth.ts` — frontend contract.
- `apps/web/src/pages/pos/LoginPage.tsx` — POS login UI (#32).
