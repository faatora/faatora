# Runbook — PINT-OM data dictionary / Schematron pack update

**Severity:** Planned (becomes P1 if we're late — rejections start happening at the OTA's switchover moment, not before).

## Context

The OTA periodically publishes a new PINT-OM data dictionary and the associated Schematron rule pack. We track the deployed version in `rule_pack_version` (`/health/detailed` surfaces it). An update changes which fields are mandatory, which codelists are accepted, and which business rules are evaluated. Missing an update by one revision usually results in a wave of `fawtara_clearance_rejection_reason_total` spikes on specific rule IDs the day the OTA flips the switch.

## When to run

- Within 7 days of OTA's publication notice, or earlier if the notice flags a mandatory switchover date.
- Immediately on any OTA security advisory affecting the signature-related rules.

## Pre-flight checklist

1. Download the new pack from the OTA developer portal. Store in `packages/compliance/rule-packs/<version>/` and commit.
2. Note the version string (e.g. `pint-om-1.1.3`) — this is what `rule_pack_version` becomes.
3. Open the ADR template for a rule-pack bump and start filling in the "what changed" diff.

## Golden-corpus run

The golden corpus is a snapshot of ~100 real-shape anonymised invoices spanning every known business case we've issued. Before deploying the new pack, run the full corpus through the compliance pipeline with the new rules active:

```bash
cd packages/compliance
RULE_PACK_VERSION=pint-om-1.1.3 pnpm test:golden
```

Expected outcomes:

- **No regressions.** Previously-valid invoices stay valid.
- **New required fields.** If the pack adds a required field, expect N failures in the corpus — add a mapping defaulter for the field (or a per-tenant data migration if we can't derive it from existing data) BEFORE deploying.
- **New rejected codelist values.** Expect failures; patch the codelist tables (`packages/compliance/src/codelists/*.ts`).

Do NOT skip or snapshot-around a corpus failure — the whole point is that it mirrors production.

## Deployment

1. **Bump `rule_pack_version`** in `packages/compliance/src/pint-om/customisation.ts`.
2. **Deploy to staging.** Point the clearance gateway at the OTA sandbox. Run a smoke suite of 10 invoices from the golden corpus against the sandbox — all must come back `cleared`.
3. **Canary.** Deploy to 5% of API capacity in prod. Watch `fawtara_clearance_rejection_reason_total` by `reason_code` for 1 hour.
4. **Full rollout** if canary is clean.

## Monitor rejection rates

- Baseline rejected rate target < 0.1% monthly.
- After rollout, acceptable spike up to 0.5% for 24 hours while tenants catch up on their own data; above that, roll back by reverting `rule_pack_version`.
- Alert rule in place: see `docs/runbooks/clearance-rejections-spike.md`.

## Rollback

A rule-pack rollback is a code revert — bump `rule_pack_version` back to the previous value. There is no DB state to migrate. The OTA will accept both versions during the overlap window stated in their change notice.

## Root-cause history (template, if a pack rollout went wrong)

- **Pack version:**
- **Date deployed (UTC):**
- **Reason-code regressions:**
- **Rolled back?** Yes/No. If yes, when.
- **Follow-ups:**

## Links

- `packages/compliance/src/pint-om/` — specialisation code.
- `docs/runbooks/clearance-rejections-spike.md` — the on-call runbook for the symptom.
- OTA developer portal — see on-call wiki for the credential.

---

Last updated: 2026-10-17
Author: <on-call-sre>
