# PDF/A-3 invoice renderer

Renders a bilingual (Arabic RTL + English LTR) tax-invoice PDF with the
UBL 2.1 XML embedded as a PDF attachment and a ZATCA/GCC-style TLV QR
code on every page.

## Usage

```ts
import { renderPdfA3 } from '@faatora/compliance';

const { pdfBytes, embeddedXmlName, pdfA3Conformant } = await renderPdfA3({
  invoiceNumber: 'INV-2026-0001',
  issueDate: '2026-11-12',
  issueTimestamp: '2026-11-12T10:00:00Z',
  currency: 'OMR',
  documentType: 'invoice',
  seller: {
    name: { en: 'Fawtara LLC', ar: 'شركة فاتورة' },
    vatNumber: 'OM1234567890123',
    address: { en: 'Muscat, Oman', ar: 'مسقط، عمان' },
    country: 'Oman',
  },
  buyer: {
    name: { en: 'Acme Trading LLC', ar: 'شركة أكمي للتجارة' },
    vatNumber: 'OM9876543210987',
    country: 'Oman',
  },
  lines: [
    {
      lineNo: 1,
      description: { en: 'Consulting', ar: 'استشارات' },
      quantity: '2',
      unitCode: 'C62',
      unitPrice: '50.000',
      lineAmount: '100.000',
      vatRate: '5',
    },
  ],
  totals: {
    netTotal: '100.000',
    vatTotal: '5.000',
    grandTotal: '105.000',
  },
  branding: {
    firmName: { en: 'Fawtara LLC', ar: 'شركة فاتورة' },
    logoPath: '/var/fawtara/firms/42/logo.png',
    primaryColor: '#0F766E',
  },
  embeddedXml: ublXmlBytes, // from the UBL serializer
  embeddedXmlName: 'invoice-ubl.xml',
});

await fs.writeFile('/tmp/invoice.pdf', pdfBytes);
```

The pipeline:

1. Build the TLV QR payload (Tags 1..5) from the invoice.
2. Render the QR as a PNG data URI (`qrcode` package).
3. Inline the per-firm logo as a data URI.
4. Build bilingual HTML.
5. Print to PDF via Playwright headless Chromium.
6. Rewrite the PDF with `pdf-lib` — embed the UBL XML with
   `/AFRelationship Source`, add it to the Catalog's `/AF` array, and
   populate the Info dictionary.

## QR TLV tag mapping

The QR payload is a base64-encoded concatenation of
`<tag:1><length><value>` triples. We implement BER/DER length rules
(short form <=127, 0x81 for 128..255, 0x82 for 256..65535) so Phase 2
hash values will fit without a format break.

| Tag | Meaning                               | Phase |
| --- | ------------------------------------- | ----- |
| 1   | Seller name (UTF-8)                   | 1     |
| 2   | Seller VAT number                     | 1     |
| 3   | Invoice timestamp (ISO 8601)          | 1     |
| 4   | Invoice total incl. VAT (string)      | 1     |
| 5   | VAT total (string)                    | 1     |
| 6   | ECDSA signature                       | 2 — reserved, not emitted |
| 7   | Public key                            | 2 — reserved, not emitted |
| 8   | Certificate signature                 | 2 — reserved, not emitted |

`decodeInvoiceQrTlv()` is exported symmetrically for verifier round
trips and is covered by unit tests.

## PDF/A-3 conformance

`renderPdfA3` runs a structural PDF/A-3 validator
(`validator.ts` / {@link validatePdfA3}) on the finished PDF before
returning, and sets `pdfA3Conformant` from the validator's result.
Callers never have to run the validator by hand.

The validator opens the finished PDF with `pdf-lib` and asserts six
invariants. Each failed check adds one entry to
`conformanceErrors`; `pdfA3Conformant` is `true` IFF every check
passed, and `conformanceLevel` is the `pdfaid:conformance` value
found on the XMP packet.

1. **PDF header is 1.4..1.7.** PDF/A-3 is based on PDF 1.7 and most
   writers emit anything from 1.4 through 1.7; PDF 2.0+ is rejected.
2. **Trailer carries an `/ID` entry.** Required for stable archive
   indexing and for any downstream signer that needs a document
   identifier.
3. **Catalog `/Metadata` points at an XMP stream.** The stream may be
   raw or `/FlateDecode`-compressed.
4. **The XMP packet carries the `pdfaid` namespace** with
   `pdfaid:part = 3` and `pdfaid:conformance ∈ {A, B, U}`. The renderer
   emits level **B** because we do not produce a tagged PDF —
   claiming A or U would be a false claim.
5. **At least one `/OutputIntents` entry has `S = GTS_PDFA1`** with
   either `OutputConditionIdentifier` containing `sRGB`
   (case-insensitive) or a `/DestOutputProfile` ICC stream. The
   renderer uses the identifier-only sRGB form permitted by PDF/A §6.2.2.
6. **`/AF` associated-files + per-filespec `/AFRelationship`.** When an
   `EmbeddedFiles` tree is present, the Catalog must have an `/AF`
   array and every filespec dictionary must declare `/AFRelationship`
   ∈ {Source, Data, Alternative, Supplement, Unspecified}. This is the
   specifically PDF/A-3 requirement that distinguishes it from PDF/A-2.

What the renderer DOES on top of these:

- Embeds the UBL XML with `/Type /Filespec`, `/AFRelationship /Source`,
  and on the Catalog's `/AF` array (the ZUGFeRD / Factur-X pattern).
- Writes a PDF/A-3B XMP packet into the Catalog's `/Metadata` stream
  with Dublin Core + XMP Basic + `pdfaid` namespaces.
- Writes the `GTS_PDFA1` OutputIntent with the sRGB identifier.
- Writes a deterministic trailer `/ID` derived from
  `(invoiceNumber, issueTimestamp)`.
- Sets `/Title`, `/Author`, `/Subject`, `/Creator`, `/CreationDate`.

### Known limitations of the validator

The structural validator is the first gate, not the only one. veraPDF
should continue to run as a sidecar before an archive is sealed, because
these follow-ups are deliberately out of scope here:

- **Font embedding / subsetting** is NOT checked. Walking every page's
  `/Resources /Font` tree and asserting a `/FontFile{,2,3}` on each
  descriptor is possible, but hasn't earned its keep yet: Chromium's
  print pipeline embeds subsetted fonts already, and a regression
  there is caught by veraPDF. Follow-up task.
- **Transparency groups, colour spaces per content stream, ActualText
  coverage** — PDF/A-2 concerns that veraPDF validates thoroughly and
  that we do not re-implement.
- **ICC profile well-formedness.** The validator accepts any
  `/DestOutputProfile` stream as valid; veraPDF parses the actual
  ICC bytes and rejects malformed profiles.

### The validator is the writer's spec

The validator and the renderer are co-designed. When a new field is
required for OTA conformance, add the check to the validator first and
then satisfy it in the renderer. The renderer tests assert
`pdfA3Conformant === true` on every render, so a regression on either
side fails fast.

## Deployment notes (Ahmed, this is what breaks in prod)

- **Playwright binaries** — `playwright` is declared as a dependency
  but the Chromium binary is downloaded separately. The API container's
  Dockerfile must either:
  - run `npx playwright install chromium --with-deps` on build (adds
    ~300 MB to the image), or
  - set `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and pre-bake the
    binaries, as this dev environment does.
- **Fonts** — the HTML template names `Noto Sans` and `Noto Sans
  Arabic`. Chromium falls back to its default sans if the fonts are
  not present; Arabic text may render but with a default system face.
  Install `fonts-noto` + `fonts-noto-color-emoji` in the container,
  or bundle TTFs alongside the renderer and reference them via
  `@font-face`.
- **Sandbox** — the renderer passes `--no-sandbox` to Chromium so it
  works in rootful containers. Keep the container non-root in prod
  and drop this flag if the host already provides a user namespace.
- **veraPDF** — the in-process validator covers the six structural
  checks listed above and flips `pdfA3Conformant` accordingly. Keep
  veraPDF scheduled as a sidecar before an archive is sealed: font
  embedding, ICC profile integrity and transparency rules are still
  out of scope for the in-process check and veraPDF catches them.

## Known limitations

- Jest is used (not Vitest); it matches the package's existing test
  runner so the one `pnpm --filter @faatora/compliance test` command
  stays the whole story.
- The `issueTimestamp` input is rendered into the QR TLV AS-IS via
  `new Date(issueTimestamp).toISOString()`. Callers are responsible
  for passing a valid RFC 3339 string.
- The template is single-page; multi-page invoices with 50+ line
  items will overflow. Pagination and totals carry-forward are future
  work.
- Logo data URI inlining reads the whole file into memory per render.
  That is fine for a 50 KB PNG and typical invoice throughput; large
  SVG logos should be rasterised upstream.
