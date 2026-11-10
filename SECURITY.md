# Security Policy

Thank you for helping keep Faatora and its users safe.

## Supported versions

Faatora is in active Wave 3 development; only the current `main` branch is supported. There are no backported security releases yet.

| Version | Supported |
|---|---|
| `main` (unreleased) | yes |
| any tagged `0.x` pre-release | no |

Once Faatora reaches `1.0`, this table will list the supported minor versions and their security-fix windows.

## Reporting a vulnerability

Please email **security@faatora.om** with a clear description, reproduction steps, affected endpoints or files, and the impact you observed.

For Wave 3 we accept plain-text email only; a PGP key will be published alongside the first production release. (Placeholder — this will change for `1.0`.)

Please do NOT open a public GitHub issue, post the finding in a chat channel, or share it with third parties before we have had a chance to respond.

### What to expect

- **Acknowledgement within 48 hours** of receipt (business days, GMT+4).
- A triage note within 5 business days with a working severity rating and a planned fix window.
- **Coordinated disclosure within 90 days** of acknowledgement. We will usually ship a fix well inside that window; longer embargoes are discussed case by case with the reporter.
- Credit in the release notes if you want it, under the name or handle you choose.

## Scope

In scope:

- The Faatora API (`apps/api`) running against the current `main` schema and migrations.
- The signing, clearance, archive, invoicing, imports, accountant, billing, POS and leads modules.
- The Terraform modules under `infra/` as they would be applied with their documented variables.

Out of scope:

- Test suites (`apps/api/test`, `apps/api/jest.config.*`) and any demo or canary data.
- The dev-only `StubAspProvider` and anything behind `NODE_ENV !== 'production'`.
- The `FilesystemStorage` archive adapter — it is dev/CI only and refused in production.
- `LocalSigner` and the `/tmp/faatora-dev-signing.pem` key path — dev/CI only.
- Rate-limiting findings on local-dev deployments (no WAF, no ALB).
- Social-engineering, physical-access, DoS floods against third-party dependencies (Cognito, S3, RDS) that are not caused by a Faatora-side misuse.

## Safe-harbour

We will not pursue legal action or report to law enforcement a researcher who, in good faith:

- Makes a reasonable effort to avoid privacy violations, data destruction, and service disruption.
- Does not exfiltrate more data than is necessary to demonstrate the issue.
- Gives us a reasonable chance to fix the issue before public disclosure.

Thank you.
