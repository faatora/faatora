# RTL follow-ups — Faatora web

Status at the time of this writing: the web app's RTL layout is in solid
shape. The spot-audit below found one real digit-system bug (fixed in
this PR) and a handful of smaller items that aren't release-blockers but
are worth a future pass.

## Fixed in this PR

- **POS receipt date formatted with Eastern Arabic numerals.**
  `ReceiptView.tsx` called `Date.toLocaleString(lang)` with `lang` of
  `ar`, which Chromium renders as `١٢‏/١١‏/٢٠٢٦`. Faatora's product rule
  is Hindu-Arabic digits across the UI, and the receipt is printed on
  a till printer where Eastern digits do not always render cleanly.
  The locale now forces the `latn` numbering system
  (`ar-OM-u-nu-latn`).

## Backlog — not release-blockers

### 1. Left-to-right fenced tokens inside Arabic sentences

The CSV batch-error strings embed Latin status tokens (`"full"`,
`"read_only"`, `"ongoing"`, `"periodic"`) inside an Arabic sentence.
Browsers mostly handle bidi correctly, but a wrapper `<bdi>` around
the tokens would make the rendering deterministic across OS text
engines. Low priority — no user has reported a problem.

### 2. Firm switcher caret glyphs do not flip

`FirmSwitcher.tsx` renders `▲ / ▼` as the expand/collapse hint. These
are visually neutral and do not need to flip in RTL, but a reviewer may
prefer an inline SVG chevron that can be rotated based on
`document.dir`. Purely cosmetic.

### 3. Invitation icon is a bare unicode envelope

Also in `FirmSwitcher.tsx`: the "Accept invitation" item uses `✉` as
the leading glyph. On some Windows renderings this picks up a colour
emoji presentation that clashes with the surrounding monochrome UI.
Swapping for an inline SVG at some point would make both themes match
and the icon crisper.

### 4. `toLocaleString(undefined, …)` for OMR totals

`DashboardPage.tsx` formats OMR totals via `toLocaleString(undefined, …)`,
which inherits the browser's locale. That is correct for a user whose
browser is set to Arabic (Oman) — they get Omani thousands separators.
It can surprise a reviewer whose browser is `en-GB` but who is browsing
the Arabic UI. Worth considering an explicit `ar-OM` / `en-OM` passed
through on behalf of the active app locale, with the `-u-nu-latn`
extension to keep digits Western.

### 5. Date fields fall through to the browser's native date picker

Two date inputs in `BatchOperationsPage.tsx` (`periodStart`,
`periodEnd`) use the native `<input type="date">`. Chromium shows an
Arabic calendar for `dir=rtl` but Firefox does not. A shared wrapper
that normalises both would avoid user confusion. Out of scope for the
i18n PR.

### 6. Table row-number header is a bare `#`

`ImportWizardPage.tsx` renders `<th>#</th>` for the row-number column.
`#` is unambiguous enough that no translation is needed (both locales
read it the same way), but a reviewer may prefer an actual key like
`imports.wizard.review.col.row_no`. Noted here so we don't lose track.

---

If any of the above becomes a user-visible issue (e.g. a reviewer
screenshots an Arabic receipt with mixed digits, or a Firefox user
reports the date picker), file a separate ticket citing this doc as
the earlier known-good state.
