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
 *      and write Fawtara-specific metadata.
 *
 * PDF/A-3 note: at EP4 we do not claim conformance. Steps 1..5 produce
 * a PDF with the UBL XML correctly attached and ready for signing, but
 * ICC profile + OutputIntent + XMP packet validation still require a
 * downstream veraPDF run. See `pdf/README.md` for the gap list and the
 * planned production-container updates.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { AFRelationship, PDFDocument } from 'pdf-lib';

import { encodeInvoiceQrTlv } from './qr-tlv.js';
import { buildInvoiceHtml } from './template-html.js';
import type { InvoiceRenderInput, InvoiceRenderOutput } from './types.js';

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
async function printHtmlToPdf(html: string, existingBrowser: Browser | undefined): Promise<Uint8Array> {
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

/**
 * Attach the UBL XML to the PDF bytes with ZUGFeRD-style `/AFRelationship`
 * and populate Info dictionary entries. Returns the rewritten PDF.
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
  const created = toPdfDate(input.issueTimestamp);
  if (created) {
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

  return doc.save();
}

/**
 * Render a PDF/A-3 invoice.
 *
 * Returns the PDF bytes, the embedded attachment name, and a flag
 * indicating whether PDF/A-3 conformance has been verified. At EP4
 * the flag is always `false` — see module docstring and README.
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

  return {
    pdfBytes: finalPdf,
    embeddedXmlName: invoice.embeddedXmlName,
    // PDF/A-3 conformance validation is TODO — see pdf/README.md.
    pdfA3Conformant: false,
  };
}
