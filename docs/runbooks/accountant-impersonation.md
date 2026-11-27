# Runbook — Accountant impersonation ("act as this client")

**Severity:** A false positive here lets an accountant reach a tenant they are not linked to; a false negative blocks legitimate bookkeeping. Treat an unexpected spike in `403 impersonation session expired or revoked` on `TenantGuard` as **P1** — a firm member's real work is stopped. Treat any request accepted with `X-Impersonate-Tenant-Id` but no matching live row in `firm_impersonation_events` as **P0** — the row was the authorisation.

## What impersonation is

An accountant firm (`firms` table) manages many client tenants. A firm member who holds an `owner`, `partner` or `staff` role on a firm may "act as" one of its linked client tenants to do bookkeeping on their behalf — issuing invoices, booking journals, validating VAT. The alternative (having the firm member join every client tenant as a regular member) scales badly and leaks the firm's identity into the tenant's membership list.

The flow is:

1. Accountant visits the firm console → clients list → clicks **Act as this client** on a row.
2. Frontend calls `POST /firms/:id/clients/:tenantId/act-as`.
3. Backend (`ImpersonationController`) validates:
   - a non-revoked row exists in `firm_client_tenants` for (`firmId`, `tenantId`) — otherwise **404**;
   - the caller's firm role is not `read_only` — otherwise **403**;
4. Backend writes a row to `firm_impersonation_events` capturing `{firm_id, client_tenant_id, user_id, started_at, expires_at, user_agent, ip}` and returns `{ tenantId, expiresAt }`.
5. Backend emits `accountant.impersonation.started` on EventEmitter2 so `AuditSubscribers` appends the event to the ClearTax §5.7 hash-chained `firm_audit_events` log.
6. Frontend stores the tenant id and starts sending `X-Impersonate-Tenant-Id: <tenantId>` on every follow-up request.
7. `TenantGuard` honours the header: it looks up the user's active row in `firm_impersonation_events` (via the RLS-bypass pool, because the caller has not yet set `app.firm_id`), and if the row is live (`ended_at IS NULL AND expires_at > now()`), scopes `req.tenantId` to the impersonated tenant and attaches `req.impersonating = { firmId, startedBy, originalRole, sessionId, expiresAt }`.

### Default session length

Ten minutes. Configurable via `IMPERSONATION_SESSION_TTL_MS` (milliseconds, positive integer). Shorter is fine for a quick read; longer is appropriate during a scheduled close-out, but understand that every minute a session is open is a minute an unattended browser tab is live. Do not raise this above one hour without discussing it with the accountant team.

## How to audit who impersonated whom

Two sources:

### 1. `firm_impersonation_events` (operational store)

```sql
-- All sessions this firm started in the last 7 days.
SELECT started_at, user_id, client_tenant_id, expires_at, ended_at, end_reason, ip
  FROM firm_impersonation_events
  WHERE firm_id = '<firm uuid>'
    AND started_at > now() - interval '7 days'
  ORDER BY started_at DESC;
```

RLS: this table is `FORCE ROW LEVEL SECURITY` keyed on `app.firm_id`. To run the query above, connect as the migration role (bypasses RLS) or set `SET LOCAL app.firm_id = '<firm uuid>'` inside a transaction.

Indexes support three lookups:

- `firm_impersonation_events_firm_idx` → "what did this firm do?"
- `firm_impersonation_events_tenant_idx` → "who impersonated this tenant?"
- `firm_impersonation_events_active_idx` → `TenantGuard`'s hot path (partial, `WHERE ended_at IS NULL`).

### 2. `firm_audit_events` (ClearTax §5.7 tamper-evident chain)

For every started session the controller also emits `accountant.impersonation.started`, which the `AuditSubscribers` appends to `firm_audit_events`. These rows carry the hash chain — use them for OTA-facing export, not the operational store.

```sql
SELECT occurred_at, actor_user_id, tenant_id, payload
  FROM firm_audit_events
  WHERE firm_id = '<firm uuid>'
    AND event_type = 'accountant.impersonation.started'
  ORDER BY occurred_at DESC;
```

## How to revoke a session

An active session is one where `ended_at IS NULL AND expires_at > now()`. Three ways to end it:

- **Natural expiry.** The row's `expires_at` passes. `TenantGuard`'s `expires_at > now()` check starts rejecting the `X-Impersonate-Tenant-Id` header. The frontend's `ImpersonationBanner` reads the returned `expiresAt` and auto-exits a few seconds before.
- **User-initiated exit.** The frontend's **Exit** button clears the local tenant id and stops sending the header. To mark the row ended at the same time, follow-up work can PATCH `end_reason='user_exited'`.
- **Manual revocation.** An operator can invalidate a live session by stamping it:

  ```sql
  UPDATE firm_impersonation_events
     SET ended_at = now(), end_reason = 'revoked'
     WHERE id = '<session uuid>'
       AND ended_at IS NULL;
  ```

  RLS: same note as the audit query above — set `app.firm_id` or use the migration role. The very next request carrying that session's `X-Impersonate-Tenant-Id` fails `TenantGuard` with **403 `impersonation session expired or revoked`**.

To revoke every live session a firm member has open (e.g. a member just left the firm):

```sql
UPDATE firm_impersonation_events
   SET ended_at = now(), end_reason = 'revoked'
   WHERE user_id = '<user uuid>'
     AND ended_at IS NULL;
```

## Known limitations / follow-ups

- **End-reason attribution.** The `ended_at` / `end_reason` columns exist but the controller does not yet expose an `end` endpoint. Frontend "Exit" is client-side today; a follow-up should add `DELETE /firms/:id/clients/:tenantId/act-as` that stamps `end_reason='user_exited'` under `withFirm`.
- **Destructive-write audit interceptor.** The spec that landed this runbook called out a nice-to-have interceptor that writes a `firm_audit_events` row for every non-GET request under `req.impersonating`. Deferred to a follow-up PR so the critical path stays small; until then, downstream services that want it can read `req.impersonating` themselves.
- **Role re-check on long sessions.** `TenantGuard` does NOT re-verify the firm role on every follow-up request. An accountant whose role is reduced to `read_only` mid-session continues until the session expires. Keep the TTL short (default 10 min) so this window is bounded; consider a role re-check if you raise the TTL.

## Related files

- Migration: `apps/api/migrations/1710002400000_impersonation_events.cjs`
- Drizzle schema: `apps/api/src/db/schema/impersonation.ts`
- Service: `apps/api/src/modules/firms/clients/impersonation.service.ts`
- Controller: `apps/api/src/modules/firms/clients/impersonation.controller.ts`
- Guard extension: `apps/api/src/auth/tenant.guard.ts`
- Frontend handshake: `apps/web/src/features/firms/clients/api/clients.ts` (`startImpersonation`)
