# Runbook — PDF/A-3 conformance upgrade

**Severity:** Follow-up (not a blocker for dev; blocker before any OTA audit).
**Owner:** TBD.
**Last updated:** 2026-10-17.

## Context

`apps/api/src/modules/signing/pdf.ts` currently produces a PDF 1.7 using
`pdfkit`. It is a correct human-readable invoice: supplier/buyer blocks, line
table, VAT breakdown, grand total, QR embedded, document UUID in the footer.

It is **not** PDF/A-3. PDF/A-3 is a strict archival conformance profile that
the OTA (and the Omani VAT law for 10-year retention) expects for the archived
rendering. Shipping a non-A3 PDF to a production tenant is fine for internal
use and email, but will fail an audit the first time an OTA inspector asks for
the archival file.

## What PDF/A-3 adds over our current output

1. **All fonts embedded as subsets** — no reliance on reader-side font
   installation. Our current output uses Helvetica (one of the 14 standard
   PDF 1.4 base fonts) which many readers still have but which PDF/A refuses.
2. **XMP metadata packet** declaring PDF/A-3 conformance (part + level). Must
   appear in the Catalog's `Metadata` entry as a raw XML stream.
3. **Device-independent color space** — an ICC profile embedded in the
   document's `OutputIntents`. sRGB (sRGB v2 ICC profile) is the usual choice.
4. **No transparency**, no encryption, no external references, no JavaScript,
   no multimedia.
5. **Embedded UBL XML attachment** — the signed PINT-OM XML is embedded as a
   `/Filespec` with `/AFRelationship /Source`. This is specifically what makes
   PDF/A-3 the right profile for e-invoicing (3b and 3a are for pure
   human-reading; 3 is the one with attachments).
6. **Document ID** — a stable, deterministic `/ID` entry in the trailer.

## What Arabic adds

The current Helvetica font does not carry Arabic glyphs. Any Arabic string
rendered through it will show as missing-glyph boxes. The PDF/A-3 step is the
natural place to fix this because PDF/A-3 requires embedded fonts anyway.

- Package choice: a TTF that ships Arabic glyphs. **`@fontsource/noto-sans-arabic` ships WOFF/WOFF2 only** (pdfkit requires TTF or OTF), so pick either:
  - `noto-sans-arabic-ttf` on npm, or
  - a build-time download of the Google Fonts TTF file into
    `apps/api/assets/fonts/NotoSansArabic-Regular.ttf` with a hash check, or
  - a system package (`fonts-noto-core` on Debian/Ubuntu) referenced via an
    absolute path in production.
- pdfkit + fontkit do handle Arabic glyph shaping (contextual forms) and bidi
  reasonably well via `doc.registerFont('ar', path)` + `doc.font('ar')`. Verify
  by rendering `ar.json` strings in a test and visually inspecting the output.

## Plan

### 1. Choose libraries

- Keep `pdfkit` (it supports PDF/A workflow with careful setup).
- Add `fontkit` explicitly (`pdfkit`'s font engine). pdfkit already depends on
  it, but we want to call `require('fontkit')` directly for custom TTF
  registration.
- No separate PDF/A library — do the XMP + OutputIntents by hand with
  `pdfkit`'s low-level stream API. The alternative `pdf-lib` would require
  rewriting the renderer end-to-end.

### 2. Bundle fonts

- Pick fonts that will cover both scripts.
  - Latin: `NotoSans-Regular.ttf` and `NotoSans-Bold.ttf` (replaces Helvetica).
  - Arabic: `NotoSansArabic-Regular.ttf` and `NotoSansArabic-Bold.ttf`.
- Place under `apps/api/assets/fonts/` and reference via `path.join(__dirname, '../../../assets/fonts/...')`.
- Add a build check that the font files exist at image-build time.

### 3. Add XMP metadata

- Generate the XMP packet with the UUID, title, author, dates, and the two
  key conformance fields: `pdfaid:part = 3` and `pdfaid:conformance = B`
  (PDF/A-3b is correct for e-invoicing with an embedded XML attachment and
  no tagged structure requirement; A3-u adds Unicode mapping, A3-a adds
  structural tagging — most e-invoice ASPs accept 3b).
- Write it into the document's `/Metadata` entry (type `/XML`, subtype `/XML`).

### 4. Embed the ICC profile

- Download sRGB v2 ICC profile (e.g. the "sRGB2014.icc" from color.org) and
  commit under `apps/api/assets/color/sRGB2014.icc`.
- Add a document `/OutputIntents` array with one entry referencing this
  profile.

### 5. Embed the UBL XML attachment

- Attach the signed PINT-OM UBL XML via pdfkit's `.file()` + a custom
  `/AFRelationship /Source` tag. Set the attachment's `/UF` filename to
  `invoice.xml` and MIME type to `application/xml`.

### 6. Harden against disallowed features

- Set the viewer-preferences `/Encrypt` dictionary to absent.
- Confirm no transparency groups are used (`globalAlpha = 1` everywhere).
- Remove any JavaScript action (pdfkit has none by default — verify).

### 7. CI validation

- Install **veraPDF** (the authoritative PDF/A validator, open-source Java)
  as a Docker container in CI: `verapdf/cli` on Docker Hub.
- Add a Jest-level or CI-level test that:
  1. Renders a sample PDF with the production code path.
  2. Runs `docker run --rm -v $tmp:/data verapdf/cli -f 3b /data/sample.pdf`.
  3. Asserts the output contains `isCompliant="true"`.
- Fail the build on any conformance drift.

### 8. OTA alignment

- Request the **exact PDF/A-3 flavour the OTA expects** from the accredited
  ASP during contract setup. The three candidates are A3-b, A3-u, A3-a; the
  practical default in GCC e-invoicing is **A3-b**, but confirm.
- Request a **sample cleared PDF** from the ASP's sandbox. Use `verapdf` to
  reverse-engineer which conformance profile it ships, then target the same.
- Confirm whether OTA requires the Arabic rendering, English, or both; the
  current PDF has English headers only.

## Estimated effort

- Code: 1-2 days by one engineer who's done PDF/A before.
- First-pass veraPDF debugging: another 1-2 days (small issues always appear —
  colour management, timestamp format, font widths).
- Arabic text shaping verification: half a day.
- Dockerized veraPDF in CI: 2 hours.
- Total: ~4-5 days.

## Done when

- `verapdf -f 3b` reports `isCompliant="true"` on 10+ sample PDFs covering:
  single line / many lines / Arabic descriptions / zero-rated / credit note.
- The embedded UBL XML round-trips: `pdftk sample.pdf unpack_files` produces
  the same bytes as the signed_documents.signed_xml column.
- All existing signing + pdf tests still pass.
- Font files + ICC profile are committed and documented.
