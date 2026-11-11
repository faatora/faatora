# UNTRANSLATED-STRINGS — Faatora web

Each entry is a string that appears to be rendered to the user but is not going through `t(...)`. The scanner is pattern-based and will produce false positives — treat this as a refactor backlog, not a lint failure.

Total findings: **9**.

## `src/components/LanguageToggle.tsx`

| Line | Kind | Text | Context |
| --- | --- | --- | --- |
| 17 | attribute | `Language` | `<div className="inline-flex items-center gap-2" role="group" aria-label="Language">` |

## `src/features/firms/clients/components/csvParser.ts`

| Line | Kind | Text | Context |
| --- | --- | --- | --- |
| 125 | string-literal | `tenantName is required` | `if (!tenantName) errors.push('tenantName is required');` |
| 126 | string-literal | `crNumber is required` | `if (!crNumber) errors.push('crNumber is required');` |
| 127 | string-literal | `vatin is required` | `if (!vatin) errors.push('vatin is required');` |
| 128 | string-literal | `country must be a 2-letter code` | `if (country.length !== 2) errors.push('country must be a 2-letter code');` |
| 130 | string-literal | `accessLevel must be full or read_only` | `errors.push('accessLevel must be full or read_only');` |
| 133 | string-literal | `engagementType must be ongoing or periodic` | `errors.push('engagementType must be ongoing or periodic');` |
| 136 | string-literal | `shopOwnerEmail is not a valid email` | `errors.push('shopOwnerEmail is not a valid email');` |

## `src/features/firms/dashboard/pages/DashboardPage.tsx`

| Line | Kind | Text | Context |
| --- | --- | --- | --- |
| 391 | jsx-text | `to` | `{v.periodStart} to {v.periodEnd}` |

