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

## PDF/A-3 conformance — status: TODO

`renderPdfA3` returns `pdfA3Conformant: false` at EP4 and will keep
returning `false` until a conformance step is added. What the renderer
DOES do today:

- Embeds the UBL XML with `/Type /Filespec`, `/AFRelationship /Source`,
  and registers it on the Catalog's `/AF` array (the ZUGFeRD /
  Factur-X pattern that PDF/A-3 requires for associated files).
- Sets `/Title`, `/Author`, `/Subject`, `/Creator`, `/CreationDate`.

What is MISSING for ISO 19005-3 conformance:

- **OutputIntent + ICC profile** — a PDF/A file must declare a device
  colour space via an `OutputIntents` entry with an embedded ICC
  profile (typically sRGB IEC61966-2.1). `pdf-lib` 1.17 does not
  produce this by default.
- **XMP metadata packet** — Info-dictionary fields must be mirrored
  into an XMP metadata stream with the PDF/A-3 conformance claim
  (`pdfaid:conformance = A/B/U`).
- **Font subsetting with embedded fonts** — any text must be rendered
  with embedded, subsettable fonts. Chromium already subsets its print
  fonts; we have not yet verified every glyph on an Arabic-heavy
  page comes out embedded.
- **No encryption, no transparency groups, no JavaScript** — Chromium
  print output should already satisfy these but we have not asserted.

The intended path is a **veraPDF** post-processing step: either a
sidecar Java process (`verapdf --flavour 3b <file.pdf>`) or the
in-development `verapdf-js` port. Validation PASSES flip the renderer's
`pdfA3Conformant` flag to `true`; FAILURES keep it `false` and are
logged in the validation step.

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
- **veraPDF** — until the validation step is wired in, DO NOT claim
  PDF/A-3 conformance to customers. The output is a signable,
  attachment-carrying PDF; it is not yet a certified archival PDF.

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
