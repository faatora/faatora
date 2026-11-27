/**
 * PDF/A-3 invoice renderer.
 *
 * Pipeline:
 *   1. Build the TLV-encoded QR payload from the invoice's seller /
 *      timestamp / totals using {@link encodeInvoiceQrTlv}.
 *   2. Render the QR to a PNG data URI with the `qrcode` package.
 *   3. Build the bilingual HTML with {@link buildInvoiceHtml}.
 *   4. Print the HTML to PDF through headless Chromium (Playwright).
 *   5. Post-process with pdf-lib: embed the UBL XML as an attachment,
 *      flag it with /AFRelationship Source (ZUGFeRD / Factur-X pattern),
 *      write the XMP metadata packet (pdfaid:part=3, conformance=B), add
 *      the sRGB OutputIntents entry, and write Fawtara-specific Info
 *      dictionary metadata.
 *   6. Validate the finished PDF against the structural PDF/A-3 checks
 *      in {@link validatePdfA3}. The returned flag is set iff every
 *      check passed; any failures are surfaced on `conformanceErrors`
 *      for the caller to log or block on.
 *
 * The validator is the writer's spec: when a new field is required, add
 * the check there first, then fix the writer below to satisfy it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { AFRelationship, PDFArray, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';

import { encodeInvoiceQrTlv } from './qr-tlv.js';
import { buildInvoiceHtml } from './template-html.js';
import type { InvoiceRenderInput, InvoiceRenderOutput } from './types.js';
import { validatePdfA3 } from './validator.js';

export interface RenderOptions {
  /**
   * Override the logo path from `invoice.branding.logoPath`. Useful in
   * tests to point at a fixture; production callers should put the
   * per-firm uploaded logo on the invoice branding instead.
   */
  logoPath?: string;
  /**
   * Playwright browser to reuse. If omitted the renderer launches a
   * throwaway Chromium and shuts it down on exit. In the API container
   * you want to pass a long-lived browser for throughput.
   */
  browser?: Browser;
}

/** Guess a MIME type from a logo file's extension. Defaults to PNG. */
function logoMimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

/** Read a logo file and return it as a `data:` URI. */
async function readLogoAsDataUri(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  const mime = logoMimeType(filePath);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** Render the QR as a PNG data URI. `payload` is the base64 TLV string. */
async function renderQrPng(payload: string): Promise<string> {
  // Error-correction level M is the GCC/ZATCA default for readability vs size.
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
}

/** Print HTML to PDF through Playwright. */
async function printHtmlToPdf(
  html: string,
  existingBrowser: Browser | undefined,
): Promise<Uint8Array> {
  const browser = existingBrowser ?? (await chromium.launch({ args: ['--no-sandbox'] }));
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: 'networkidle' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
      return new Uint8Array(pdfBuffer);
    } finally {
      await context.close();
    }
  } finally {
    if (!existingBrowser) {
      await browser.close();
    }
  }
}

/** Format an ISO-ish timestamp to a `D:YYYYMMDDHHMMSS+00'00'` PDF date string. */
function toPdfDate(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `D:${String(d.getUTCFullYear())}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Escape a string for safe inclusion inside an XML text node or attribute. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the XMP metadata packet that declares PDF/A-3 conformance.
 *
 * The packet is the minimum shape a PDF/A validator looks for:
 *   - a surrounding `<?xpacket ... ?>` wrapper so legacy readers can
 *     still fish it out of the file stream,
 *   - a single `<rdf:Description>` carrying the Dublin Core, XMP Basic
 *     and pdfaid namespaces,
 *   - `pdfaid:part=3` and `pdfaid:conformance=B` so the file claims
 *     PDF/A-3B. Level B is the right choice here: the PDF carries no
 *     structure tree (we are not producing a tagged PDF), so levels A
 *     and U would be false claims.
 */
function buildXmpPacket(input: InvoiceRenderInput, createdAt: string): string {
  const title = `${input.seller.name.en} - ${input.invoiceNumber}`;
  const author = input.seller.name.en;
  const subject = `Tax invoice ${input.invoiceNumber}`;
  const producer = 'Fawtara PDF/A-3 renderer';
  // The xpacket "begin" attribute carries a U+FEFF BOM so legacy packet
  // scanners can detect the encoding. Keep it as an explicit escape in
  // the source — a raw BOM character here trips `no-irregular-whitespace`.
  const bom = '\u{FEFF}';
  return `<?xpacket begin="${bom}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Fawtara XMP 1.0">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <dc:format>application/pdf</dc:format>
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li>
        </rdf:Alt>
      </dc:title>
      <dc:creator>
        <rdf:Seq>
          <rdf:li>${xmlEscape(author)}</rdf:li>
        </rdf:Seq>
      </dc:creator>
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${xmlEscape(subject)}</rdf:li>
        </rdf:Alt>
      </dc:description>
      <xmp:CreateDate>${xmlEscape(createdAt)}</xmp:CreateDate>
      <xmp:ModifyDate>${xmlEscape(createdAt)}</xmp:ModifyDate>
      <xmp:CreatorTool>${xmlEscape(producer)}</xmp:CreatorTool>
      <pdf:Producer>${xmlEscape(producer)}</pdf:Producer>
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Attach the UBL XML to the PDF bytes with ZUGFeRD-style `/AFRelationship`,
 * install the XMP metadata stream and the sRGB OutputIntents entry so
 * the file can satisfy the PDF/A-3 structural checks, and populate the
 * Info dictionary. Returns the rewritten PDF bytes.
 */
async function attachUblAndTagMetadata(
  pdfBytes: Uint8Array,
  input: InvoiceRenderInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);

  // Info dictionary — human-visible metadata.
  doc.setTitle(`${input.seller.name.en} - ${input.invoiceNumber}`);
  doc.setAuthor(input.seller.name.en);
  doc.setSubject(`Tax invoice ${input.invoiceNumber}`);
  doc.setProducer('Fawtara PDF/A-3 renderer');
  doc.setCreator('Fawtara PDF/A-3 renderer');
  const createdAtPdf = toPdfDate(input.issueTimestamp);
  if (createdAtPdf) {
    doc.setCreationDate(new Date(input.issueTimestamp));
    doc.setModificationDate(new Date(input.issueTimestamp));
  }

  // Attach the UBL XML. `AFRelationship.Source` = the attachment IS the
  // machine-readable source of what the PDF visually represents, which
  // is exactly the ZUGFeRD / Factur-X convention.
  await doc.attach(input.embeddedXml, input.embeddedXmlName, {
    mimeType: 'application/xml',
    description: 'UBL 2.1 invoice (Fawtara / PINT-OM)',
    creationDate: new Date(input.issueTimestamp),
    modificationDate: new Date(input.issueTimestamp),
    afRelationship: AFRelationship.Source,
  });

  // --- PDF/A-3 required structure -----------------------------------
  const context = doc.context;
  const catalog = doc.catalog;

  // XMP metadata stream — written uncompressed (no /Filter) so external
  // tools can locate the xpacket wrapper without having to decode.
  const createdAtIso = new Date(input.issueTimestamp).toISOString();
  const xmpPacket = buildXmpPacket(input, createdAtIso);
  const xmpStreamRef = context.register(
    context.stream(xmpPacket, {
      Type: 'Metadata',
      Subtype: 'XML',
    }),
  );
  catalog.set(PDFName.of('Metadata'), xmpStreamRef);

  // sRGB OutputIntent — identifier-only form. Per PDF/A §6.2.2 the ICC
  // profile may be omitted when the OutputConditionIdentifier names a
  // registered printing condition. "sRGB" is the ICC-registered entry
  // for sRGB IEC61966-2.1, which every PDF/A validator recognises.
  //
  // The spec calls for the identifier to be a text string; pdf-lib's
  // `context.obj` turns bare JS strings into /Name objects, so we wrap
  // the human-readable fields with `PDFString.of` explicitly.
  const outputIntent = context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB'),
    RegistryName: PDFString.of('http://www.color.org'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
  });
  const outputIntents = PDFArray.withContext(context);
  outputIntents.push(outputIntent);
  catalog.set(PDFName.of('OutputIntents'), outputIntents);

  // Trailer /ID — pdf-lib writes one on save, but we set an explicit
  // deterministic value so the validator's check 2 does not depend on
  // save-time behaviour. The ID is a pair of identical hex strings: the
  // first is the file's permanent identifier, the second updates on
  // every revision; for a freshly-minted PDF they are the same.
  const idBytes = Buffer.from(`${input.invoiceNumber}|${input.issueTimestamp}`, 'utf-8').toString(
    'hex',
  );
  const idHex = PDFHexString.of(idBytes.padEnd(32, '0').slice(0, 32).toUpperCase());
  const idArray = PDFArray.withContext(context);
  idArray.push(idHex);
  idArray.push(idHex);
  context.trailerInfo.ID = idArray;

  return doc.save();
}

/**
 * Render a PDF/A-3 invoice.
 *
 * Returns the PDF bytes, the embedded attachment name, the conformance
 * flag set by the structural validator, and — when non-empty — the
 * conformance level and any validator errors. Callers decide whether a
 * failed validation blocks the invoice or merely gets logged.
 */
export async function renderPdfA3(
  invoice: InvoiceRenderInput,
  options?: RenderOptions,
): Promise<InvoiceRenderOutput> {
  // 1. QR payload
  const qrPayload = encodeInvoiceQrTlv({
    sellerName: invoice.seller.name.en,
    sellerVatNumber: invoice.seller.vatNumber ?? '',
    timestamp: new Date(invoice.issueTimestamp),
    invoiceTotal: invoice.totals.grandTotal,
    vatTotal: invoice.totals.vatTotal,
  });
  const qrDataUri = await renderQrPng(qrPayload);

  // 2. Optional logo
  const logoPath = options?.logoPath ?? invoice.branding.logoPath;
  const logoDataUri = logoPath ? await readLogoAsDataUri(logoPath) : undefined;

  // 3. HTML -> PDF
  const html = buildInvoiceHtml(invoice, qrDataUri, logoDataUri);
  const rawPdf = await printHtmlToPdf(html, options?.browser);

  // 4. Attach UBL XML and write metadata
  const finalPdf = await attachUblAndTagMetadata(rawPdf, invoice);

  // 5. Validate PDF/A-3 conformance structurally. We do not throw on a
  // failed validation — the caller owns the policy decision about
  // whether to block the invoice or merely log the failure.
  const validation = await validatePdfA3(Buffer.from(finalPdf));

  return {
    pdfBytes: finalPdf,
    embeddedXmlName: invoice.embeddedXmlName,
    pdfA3Conformant: validation.conformant,
    conformanceLevel: validation.level ?? undefined,
    conformanceErrors: validation.errors.length ? validation.errors : undefined,
  };
}
