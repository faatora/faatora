# Faatora web locales

Arabic and English bundles for the web app live in `src/i18n/`:

```
apps/web/src/i18n/en.json
apps/web/src/i18n/ar.json
```

`src/locales/` holds companion metadata for the Arabic pass — nothing
in this folder is bundled into the running app. In particular,
`ar/_review-needed.json` is the single source of truth for strings
that still need native-Arabic-speaker eyes before they reach
production.

## Review-needed workflow

Faatora's primary market is Oman. Several accounting-firm staff and
SME owners use Arabic as their working language, so a machine-shaped
sentence in an Arabic-mode screen is a legitimate brand risk. The
workflow below exists so Ahmed (and any future reviewers) can see at
a glance what to look at and what to ship as-is.

### 1. Pull the backlog

Open `apps/web/src/locales/ar/_review-needed.json`. Each entry is one
string with four fields:

| Field | Meaning |
| --- | --- |
| `en` | The source English string (ground truth). |
| `ar` | The Arabic string as it currently ships. |
| `confidence` | `high` / `medium` / `low` — see below. |
| `reason` | A one-sentence note on what to double-check. |

Confidence tags:

- **high** — Common UI word (`Save`, `Cancel`, `Loading…`). Safe to ship.
  Listed here only for completeness, not for action.
- **medium** — Domain-specific or multi-word. Native eyes requested
  before the next release, but the app will not mislead if we ship as-is.
- **low** — Long sentence, legal or compliance nuance, or a term with
  real ambiguity. **Must** be reviewed before the next release.

### 2. Make edits directly in `ar.json`

There is no separate "Arabic workspace" file. A reviewer edits
`apps/web/src/i18n/ar.json` directly, keeping the key path unchanged.

Rules:

- Use Modern Standard Arabic (fuṣḥá) — not Omani dialect.
- Use Arabic numerals (0-9), not Eastern Arabic (٠-٩). Omani SaaS
  users expect to see `OMR 1,500.000`, not `OMR ١٬٥٠٠٫٠٠٠`.
- Finance / tax terms must match the Oman Tax Authority's Arabic
  documentation. In particular:
  - فاتورة = invoice
  - ضريبة القيمة المضافة = VAT
  - الرقم الضريبي = VATIN
  - السجل التجاري = CR (commercial registration)
  - عميل / مورد = customer / supplier
  - فاتورة دائنة / فاتورة مدينة = credit note / debit note
- Keep acronyms Omani users recognise in Latin (UBL, PDF, QR, OTA, VAT
  when it appears beside its Arabic equivalent).
- Interpolations stay in Latin script: `{{email}}`, `{{count}}`.
  Rewording around them is fine.

### 3. Remove the entry from `_review-needed.json`

Once the string looks right, delete that entry from
`_review-needed.json`. If we are explicitly accepting the current
Arabic as-is, change the entry's `confidence` to `"high"` and move
on — do not delete without one of those two actions.

### 4. Re-run the audit

```
pnpm --filter @faatora/web i18n:audit
```

This regenerates `scripts/i18n-audit-report.{md,json}`, the top-level
`docs/i18n-audit-report.md`, and `scripts/UNTRANSLATED-STRINGS.md`.
A green audit (0 missing / empty / identical / hardcoded) is the gate
for a locale PR.

## Adding new keys

New keys must be added to **both** `en.json` and `ar.json` in the same
commit. The audit script fails the PR otherwise. If you are not a
native Arabic speaker, add your best-effort translation and append an
entry to `_review-needed.json` with confidence `medium` or `low` as
appropriate. Don't ship an empty Arabic value — the audit flags that
too.

## Not in scope

- Date and number formatting (currently handled per-call via
  `toLocaleString(lang)`).
- Pluralisation rules beyond react-i18next's built-in `_plural` suffix
  (see `pos.offline_pending_plural` for the current pattern).
- Regional Arabic variants (Gulf vs Egyptian vs Levantine). Faatora
  ships one Arabic locale — fuṣḥá.
