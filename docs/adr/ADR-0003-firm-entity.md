# ADR-0003: Firm Entity, Firm/Tenant RLS Model, and Context Propagation

- Status: Accepted
- Date: 2026-11-08
- Deciders: EP5 Wave 1 architect; Wave 2 module owners (dashboard, batch ops, billing)
- Supersedes: nothing
- Context of: ADR-0001 (tenancy, invoicing primitives), ADR-0002 (clearance, archive, console; in particular D1's `MIGRATION_DATABASE_URL` bypass pattern)

## Context

Faatora is pivoting from direct-to-SME to accountant-aggregator. One product, two sides: a micro-SME tenant with a low-ARPU retail subscription, and an accounting firm operating a per-seat subscription that lets a single accountant service 20–100 client tenants from one console. EP4 shipped a lightweight `accountant_firms` table built for a single-owner commission-tracking need; it is not a basis for the accountant-aggregator surface because it does not model (a) multiple members per firm with roles, (b) first-class engagement metadata between the firm and each client tenant, or (c) a context-propagation story strong enough to isolate firms from one another at the database layer.

EP5 Wave 1 lays the foundation so Wave 2 can build the dashboard, batch invoice ops, firm billing and firm-scoped audit log against a stable schema and context model. The scope is deliberately narrow: schema, RLS, context-propagation wrappers, FirmGuard, bare service CRUD, and tests. No UI, no batch ops, no consolidated KPIs.

## Decisions

### D1. Firm is a first-class aggregate with four new tables

We introduce `firms`, `firm_memberships`, `firm_client_tenants` and `firm_invitations`. The last is not in the Wave 1 required-tables list but is needed to make `inviteMember(firmId, email, role)` / `acceptInvitation(token)` work end-to-end: the invitee may not yet have a Faatora `users` row and the token has to be stored durably.

The firm/tenant relationship is a soft-deletable link: `firm_client_tenants` has `created_at` / `revoked_at`. A partial unique index `(tenant_id) WHERE revoked_at IS NULL` enforces the Wave 1 invariant that **a tenant may be actively engaged by only one firm at a time**. Historical links are retained — a tenant can move between firms over time by revoking then adding. Firm memberships follow the same soft-delete pattern with a partial `(firm_id, user_id) WHERE revoked_at IS NULL` unique index, so re-adding a previously-revoked user works out of the box.

`firm_memberships.role` accepts `owner | partner | staff | read_only`; `firm_client_tenants.access_level` accepts `full | read_only`; `firm_client_tenants.engagement_type` accepts `ongoing | periodic`. All three constraints are CHECK constraints at the database level, so the schema is the source of truth for the enum — Drizzle types and Zod DTO schemas both derive from constants in `src/db/schema/firms.ts`.

### D2. New session parameter `app.firm_id`; keep `app.tenant_id` as-is

The firm-console runs with a new session parameter `app.firm_id` set via `SET LOCAL` inside the `withFirm` transaction wrapper, mirroring exactly how `app.tenant_id` and the existing `withTenant` work. This is parallel, additive context — a handler can hold both `app.firm_id` and `app.tenant_id` simultaneously when the firm user has switched into one specific client (`withFirmTenant`), or just `app.firm_id` when reading the firm itself or running a cross-tenant SELECT against the ADR-0003 D4 branch.

Non-BYPASSRLS `faatora_app` role is the floor: every policy is `FORCE ROW LEVEL SECURITY`, no application code can side-step it even by accident.

### D3. RLS on the four new tables keyed on `app.firm_id`, hardened with `NULLIF`

All four new tables run `ENABLE + FORCE ROW LEVEL SECURITY` and one `firm_id = NULLIF(current_setting('app.firm_id', true), '')::uuid` policy per table (on `firms` keyed on `id`). The `NULLIF` is load-bearing and non-obvious: Postgres SET LOCAL leaves the parameter as **empty string**, not NULL, once the transaction ends, so a subsequent query on the same pooled connection that references the setting sees `''` and would throw `invalid input syntax for type uuid` from the cast — even when the `AND … <> ''` guard is the first term of the USING expression, because the planner is free to evaluate the subquery term first. `NULLIF('', '')::uuid = NULL::uuid = NULL`, which produces `firm_id = NULL` (NULL → false) and makes the policy a clean no-op when `app.firm_id` is unset. The same pattern is applied to the firm-read branch in D4.

### D4. Firm cross-tenant READ model: option (a) — PERMISSIVE SELECT branch on existing tenant policies

The core question Wave 1 answers: **how does a firm user read invoices across their client tenants?** Two options were on the table:

- **(a)** Keep existing invoice / party / invoice_line RLS keyed on `app.tenant_id`; add a separate PERMISSIVE policy per table that grants `SELECT` when `app.firm_id` is set AND the row's `tenant_id` is in the firm's active `firm_client_tenants`. Firm users can run one query across all their clients.
- **(b)** Require firm users to `withFirmTenant` into one tenant at a time; keep the invoice/party/line policies untouched. Firm users cannot issue a cross-tenant query at the database layer — they must iterate per tenant in application code.

**Decision: (a).** The Wave 2 consolidated dashboard needs to answer questions like "what are the total unpaid invoices across all my clients this quarter?" in one round-trip, not N. Option (b) forces application-layer aggregation and makes a firm with 100 clients issue 100 serial transactions for every read, which is exactly the cost `AccountantService.consolidatedKpis` already pays in EP4 and is slow enough that the Wave 2 brief explicitly flagged it.

Risk and mitigations:

- **Invariant broadening.** Option (a) means the invoice/party/line tables now have TWO paths to SELECT: the existing tenant policy and the new firm-read policy. Postgres OR's PERMISSIVE policies. If one path ever has a bug, data leaks are contained by the OTHER being correct. We strictly limit the new policy to `FOR SELECT` — writes still require the standard tenant policy. A firm user who wants to mutate on behalf of a client MUST call `withFirmTenant` which asserts the link and sets `app.tenant_id`, so writes always flow through the stricter tenant WITH CHECK.
- **Policy-nesting trust.** The new branch's USING references `firm_client_tenants`, which itself has FORCE RLS keyed on `app.firm_id`. Two layers of defense: even if the outer predicate were weakened, the inner subquery still returns zero rows unless the caller has the matching firm context.
- **No-firm-context callers.** `NULLIF` makes the branch a no-op when `app.firm_id` is unset — a tenant user calling `withTenant` still only sees their own rows, because the firm-read subquery returns empty. The existing `tenant-isolation.spec.ts` continues to pass; the new `firms-rls.spec.ts` asserts this directly.

### D5. `withFirm` and `withFirmTenant` wrappers

Two wrappers in `src/db/`:

- `withFirm(db, firmId, fn)` sets `app.firm_id` for the transaction. It does NOT independently authorize the caller — that is `FirmGuard`'s job at the request boundary.
- `withFirmTenant(db, firmId, tenantId, fn)` sets `app.firm_id`, asserts an active `firm_client_tenants` row for `(firmId, tenantId)`, then sets `app.tenant_id`. Any failure of the assertion raises `ForbiddenException` before the handler runs. This is the **only** write-safe cross-tenant path.

### D6. `FirmGuard` reads active firm from a signed JWT claim

Following the Wave 1 brief's suggestion, the active firm is carried in a signed JWT custom claim (`custom:active_firm_id` per Cognito convention; a bare `active_firm_id` is also accepted for test tokens). An `x-firm-id` header is accepted as a fallback for local dev and integration tests that mint synthetic tokens.

Alternatives considered: (i) header-only — easy to spoof, requires server-side firm membership check anyway, and leaves nothing to link to the token audit; (ii) subdomain — breaks local dev. The JWT claim path keeps the firm selection auditable alongside the authn material and is consistent with the existing `TenantGuard` pattern (header for tenant selection, JWT for identity).

`FirmGuard` runs the membership check inside `withFirm`, so RLS is in effect even for the membership read — the guard is defense in depth above the policy, not a replacement.

### D7. RLS-bypass pool for the two bootstrap reads

Two service operations need to see a row before any `app.firm_id` context is known:

- `listMyFirms(userId)` — "which firms am I in?" has to enumerate `firm_memberships` across firm_ids by user_id, which RLS keyed on `app.firm_id` cannot answer in one pass.
- `acceptInvitation(token, acceptingUserId)` — the invitee doesn't know the firm_id; only the token does. Resolving the token to a firm_id requires reading `firm_invitations` without `app.firm_id` set.

Rather than introduce a `SECURITY DEFINER` function for Wave 1, we reuse the `MIGRATION_DATABASE_URL` bypass-pool pattern already established by `ClearanceGatewayService.getSweepPool` and documented in ADR-0002 D1. The bypass pool reads only the minimum fields needed to establish a firm context; every subsequent write (membership insert, invitation marking) runs under the app pool with `app.firm_id` set, so RLS still gates the state change.

TODO(Wave 2): replace both bypass reads with a `SECURITY DEFINER` function so the service can drop its dependency on `MIGRATION_DATABASE_URL`.

### D8. Zod DTOs via a thin `ZodValidationPipe`

Per the Wave 1 architecture rules, firm-console controllers use Zod schemas for input validation rather than class-validator. The rest of the codebase uses class-validator; introducing Zod only for the new surface is a deliberate migration marker — Zod schemas derive directly from the DB enum constants in `src/db/schema/firms.ts` (single source of truth), and the `ZodValidationPipe` surfaces errors in a shape close enough to the existing class-validator response that the frontend error handling needn't branch.

## Consequences

Positive:

- Dashboards, batch ops and audit queries in Wave 2 can run as one SQL statement each, not N.
- Firm membership and firm/tenant engagement are first-class database rows, auditable and soft-deletable.
- Cross-firm isolation is enforced by Postgres, not the application — a mis-filtered Drizzle query cannot leak a row.
- The context-propagation vocabulary (`app.firm_id`, `withFirm`, `withFirmTenant`) parallels the existing tenant model, so EP4 code continues to work unchanged.

Negative / to pay back:

- Two more invariants to carry: `app.firm_id` AND `app.tenant_id` can both be set, and some queries will OR two policy branches. Reviewers need to understand that writes go through the stricter tenant policy via `withFirmTenant`.
- Postgres `SET LOCAL` empty-string behaviour is subtle and we work around it with `NULLIF` in every new policy. Any policy added later that references `current_setting('app.firm_id', true)::uuid` MUST use the same `NULLIF` wrapper, or the first `withFirm` call on a pooled connection will poison the connection for subsequent casts.
- `listClientTenants` currently cycles `app.tenant_id` per link to resolve tenant names. Fine at ≤100 clients but not free; Wave 2 introduces a `tenants_firm_read` policy to make a direct JOIN possible.
- Bypass-pool dependency for invitation acceptance and `listMyFirms`. Documented TODO to replace with a `SECURITY DEFINER` function.

## Alternatives considered

- **Option (b) — write-safe tenant switching only, no cross-tenant SELECT.** Rejected because Wave 2 dashboard SLOs would force N-way serial per-tenant queries for every firm view.
- **Dropping the `accountant_firms` table and migrating onto `firms`.** Out of Wave 1 scope. The two tables model different things (commission-tracker vs multi-user console) and the EP4 commission-report endpoint continues to work against the old table. Wave 2 or 3 can schedule a migration.
- **Modeling firms as a special kind of tenant.** Rejected: this would collapse two very different isolation boundaries into one and force the invoice RLS to interpret `app.tenant_id` as "maybe a firm, maybe a tenant", making the policy un-reviewable.
- **`SECURITY DEFINER` function for invitation acceptance in Wave 1.** Deferred to Wave 2 so this epic doesn't introduce a new category of database object (pl/pgsql function under a pinned role). The `MIGRATION_DATABASE_URL` bypass is already documented and tested.
- **Zod schemas for the whole API.** Out of scope. Wave 1 uses Zod only on the firm-console endpoints because the brief explicitly requires it there; a broader migration can land under its own epic.

## Shape of the surface (for Wave 2 consumers)

REST endpoints, all mounted at `/firms`:

| Method | Path                                      | Guard                 | Purpose                                |
|-------:|-------------------------------------------|-----------------------|----------------------------------------|
| POST   | `/firms`                                  | AccountantAuthGuard   | Create a firm, caller becomes owner    |
| GET    | `/firms/mine`                             | AccountantAuthGuard   | List firms caller is an active member of |
| POST   | `/firms/invitations/accept`               | AccountantAuthGuard   | Redeem an invitation token             |
| GET    | `/firms/:id`                              | FirmGuard             | Get the active firm                    |
| GET    | `/firms/:id/members`                      | FirmGuard             | List active members                    |
| POST   | `/firms/:id/members`                      | FirmGuard             | Add a member directly (admin path)     |
| POST   | `/firms/:id/members/invites`              | FirmGuard             | Create an invitation (returns token)   |
| DELETE | `/firms/:id/members/:userId`              | FirmGuard             | Revoke a membership                    |
| GET    | `/firms/:id/clients`                      | FirmGuard             | List active client tenants             |
| POST   | `/firms/:id/clients`                      | FirmGuard             | Engage a tenant as client              |
| DELETE | `/firms/:id/clients/:tenantId`            | FirmGuard             | Revoke a client engagement             |

Programmatic surface exported from `src/modules/firms/firms.service.ts`:

- `createFirm(ownerUserId, dto)`
- `getFirm(firmId)`
- `listMyFirms(userId)`
- `listMembers(firmId)` / `addMember(firmId, dto)` / `revokeMember(firmId, userId)`
- `inviteMember(firmId, invitedByUserId, dto)` / `acceptInvitation(token, acceptingUserId)`
- `addClientTenant(firmId, dto)` / `listClientTenants(firmId)` / `revokeClientTenant(firmId, tenantId)`

Context-propagation helpers exported from `src/db/`:

- `withFirm(db, firmId, fn)` — set `app.firm_id` for a transaction.
- `withFirmTenant(db, firmId, tenantId, fn)` — assert the link, set both `app.firm_id` and `app.tenant_id`. The ONLY write-safe path for cross-tenant mutation.
