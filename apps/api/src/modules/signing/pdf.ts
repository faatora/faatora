/**
 * PDF rendering — real renderer.
 *
 * Produces a professional-looking PDF 1.7 invoice using `pdfkit`:
 *   - Supplier and buyer blocks (name, VATIN, country)
 *   - Full line table (#, description, qty, unit price, line net)
 *   - VAT breakdown by category + rate (taxable, tax)
 *   - Totals block (subtotal, VAT total, grand total)
 *   - QR code image embedded top-right from the base64 PNG the signer produced
 *   - Document UUID + currency in the footer
 *
 * Honest caveat: this is a PDF 1.7, NOT PDF/A-3. PDF/A-3 adds strict
 * archival conformance (embedded fonts, XMP metadata, ICC profile, no
 * transparency, embedded UBL XML attachment). That upgrade is tracked in
 *   docs/runbooks/pdfa3-upgrade.md
 * and is coupled to bundling a real Arabic TTF (Helvetica is used here,
 * which does not carry Arabic glyphs). Current output is strictly better
 * than the previous one-line stub but is not conformance-grade.
 */

import PDFDocument from 'pdfkit';

export interface InvoiceLineLike {
  lineNo: number;
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  lineNet: string | number;
}

export interface InvoiceLike {
  id: string;
  number: string;
  documentUuid?: string | null;
  issueDate: string;
  currency: string;
  subtotal: string | number;
  vatTotal: string | number;
  grandTotal: string | number;
}

export interface PartyLike {
  name: string;
  vatin?: string | null;
  country?: string | null;
}

export interface VatBreakdownRow {
  category: string;
  rate: number;
  taxable: number;
  tax: number;
}

export interface RenderInput {
  invoice: InvoiceLike;
  lines: InvoiceLineLike[];
  supplier: PartyLike;
  buyer: PartyLike;
  vatBreakdown: VatBreakdownRow[];
  qrPngBase64: string;
}

const PAGE_MARGIN = 48;
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

export async function renderPdf(input: RenderInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      info: {
        Title: `Fawtara Invoice ${input.invoice.number}`,
        Author: input.supplier.name,
        Subject: `Tax Invoice — ${input.invoice.currency} ${fmt(input.invoice.grandTotal, input.invoice.currency)}`,
        Creator: 'Fawtara',
        Producer: 'Fawtara / pdfkit',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.on('error', reject);

    try {
      drawHeader(doc, input);
      drawPartyBlocks(doc, input);
      drawLineTable(doc, input);
      drawVatBreakdown(doc, input);
      drawTotals(doc, input);
      drawFooter(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawHeader(doc: PDFKit.PDFDocument, input: RenderInput): void {
  const { invoice, qrPngBase64 } = input;
  doc.font('Helvetica-Bold').fontSize(22).text('TAX INVOICE', PAGE_MARGIN, PAGE_MARGIN);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#555')
    .text('Fawtara', PAGE_MARGIN, PAGE_MARGIN + 28);
  doc.fillColor('#000');

  const rightX = A4_WIDTH - PAGE_MARGIN - 120;
  const labelX = A4_WIDTH - PAGE_MARGIN - 220;

  doc.fontSize(9).font('Helvetica-Bold').text('Invoice no.', labelX, PAGE_MARGIN);
  doc.font('Helvetica').text(invoice.number, rightX, PAGE_MARGIN);

  doc.font('Helvetica-Bold').text('Issue date', labelX, PAGE_MARGIN + 14);
  doc.font('Helvetica').text(invoice.issueDate, rightX, PAGE_MARGIN + 14);

  doc.font('Helvetica-Bold').text('Document UUID', labelX, PAGE_MARGIN + 28);
  doc
    .font('Helvetica')
    .fontSize(7)
    .text(invoice.documentUuid ?? 'pending', rightX, PAGE_MARGIN + 28, {
      width: 120,
    });

  // QR code — bottom-right area (keeps header clean)
  if (qrPngBase64 && qrPngBase64.length > 0) {
    try {
      const qrBuf = Buffer.from(qrPngBase64, 'base64');
      doc.image(qrBuf, A4_WIDTH - PAGE_MARGIN - 90, A4_HEIGHT - PAGE_MARGIN - 110, {
        width: 90,
        height: 90,
      });
      doc
        .fontSize(7)
        .fillColor('#555')
        .text('Scan to verify', A4_WIDTH - PAGE_MARGIN - 90, A4_HEIGHT - PAGE_MARGIN - 16, {
          width: 90,
          align: 'center',
        });
      doc.fillColor('#000');
    } catch {
      // QR embed failure must not fail the render; log is handled by the service wrapper
    }
  }

  // horizontal rule
  doc
    .moveTo(PAGE_MARGIN, PAGE_MARGIN + 54)
    .lineTo(A4_WIDTH - PAGE_MARGIN, PAGE_MARGIN + 54)
    .stroke();
}

function drawPartyBlocks(doc: PDFKit.PDFDocument, input: RenderInput): void {
  const { supplier, buyer } = input;
  const y = PAGE_MARGIN + 70;
  const colWidth = (A4_WIDTH - PAGE_MARGIN * 2 - 20) / 2;

  const partyBlock = (label: string, p: PartyLike, x: number) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555').text(label, x, y);
    doc
      .fillColor('#000')
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(p.name, x, y + 14, {
        width: colWidth,
      });
    doc.font('Helvetica').fontSize(9);
    let line = y + 32;
    if (p.vatin) {
      doc.text(`VATIN: ${p.vatin}`, x, line);
      line += 12;
    }
    if (p.country) {
      doc.text(`Country: ${p.country}`, x, line);
      line += 12;
    }
  };

  partyBlock('FROM / SUPPLIER', supplier, PAGE_MARGIN);
  partyBlock('BILL TO / BUYER', buyer, PAGE_MARGIN + colWidth + 20);
}

function drawLineTable(doc: PDFKit.PDFDocument, input: RenderInput): void {
  const { lines, invoice } = input;
  const startY = PAGE_MARGIN + 150;
  const cols = [
    { label: '#', x: PAGE_MARGIN, w: 22, align: 'left' as const },
    { label: 'Description', x: PAGE_MARGIN + 22, w: 260, align: 'left' as const },
    { label: 'Qty', x: PAGE_MARGIN + 282, w: 55, align: 'right' as const },
    { label: 'Unit price', x: PAGE_MARGIN + 337, w: 70, align: 'right' as const },
    { label: 'Line net', x: PAGE_MARGIN + 407, w: 92, align: 'right' as const },
  ];

  // header row
  doc
    .rect(PAGE_MARGIN, startY, A4_WIDTH - PAGE_MARGIN * 2, 20)
    .fill('#f3f3f0')
    .fillColor('#000');
  doc.font('Helvetica-Bold').fontSize(9);
  for (const c of cols) {
    doc.text(c.label, c.x + 4, startY + 6, { width: c.w - 8, align: c.align });
  }

  // rows
  let y = startY + 22;
  doc.font('Helvetica').fontSize(9);
  for (const l of lines) {
    const cells = [
      String(l.lineNo),
      l.description,
      fmt(l.quantity, invoice.currency, 3),
      fmt(l.unitPrice, invoice.currency),
      fmt(l.lineNet, invoice.currency),
    ];
    const descHeight = doc.heightOfString(l.description, { width: cols[1].w - 8 });
    const rowHeight = Math.max(16, descHeight + 6);
    for (let i = 0; i < cols.length; i++) {
      doc.text(cells[i], cols[i].x + 4, y + 3, { width: cols[i].w - 8, align: cols[i].align });
    }
    y += rowHeight;
    doc
      .moveTo(PAGE_MARGIN, y)
      .lineTo(A4_WIDTH - PAGE_MARGIN, y)
      .strokeColor('#eeeeee')
      .stroke();
    doc.strokeColor('#000');
  }
  // table end position for subsequent sections
  (doc as unknown as { _lineTableEndY: number })._lineTableEndY = y + 10;
}

function drawVatBreakdown(doc: PDFKit.PDFDocument, input: RenderInput): void {
  const { vatBreakdown, invoice } = input;
  if (!vatBreakdown || vatBreakdown.length === 0) return;
  const y = (doc as unknown as { _lineTableEndY: number })._lineTableEndY;

  doc.font('Helvetica-Bold').fontSize(10).text('VAT breakdown', PAGE_MARGIN, y);
  const rowY = y + 18;
  const cols = [
    { label: 'Category', x: PAGE_MARGIN, w: 90, align: 'left' as const },
    { label: 'Rate %', x: PAGE_MARGIN + 90, w: 60, align: 'right' as const },
    { label: 'Taxable', x: PAGE_MARGIN + 150, w: 110, align: 'right' as const },
    { label: 'VAT', x: PAGE_MARGIN + 260, w: 110, align: 'right' as const },
  ];
  doc.rect(PAGE_MARGIN, rowY, 370, 18).fill('#f3f3f0').fillColor('#000');
  doc.font('Helvetica-Bold').fontSize(9);
  for (const c of cols) {
    doc.text(c.label, c.x + 4, rowY + 5, { width: c.w - 8, align: c.align });
  }

  let yy = rowY + 20;
  doc.font('Helvetica').fontSize(9);
  for (const r of vatBreakdown) {
    const cells = [
      categoryName(r.category),
      String(r.rate),
      fmt(r.taxable, invoice.currency),
      fmt(r.tax, invoice.currency),
    ];
    for (let i = 0; i < cols.length; i++) {
      doc.text(cells[i], cols[i].x + 4, yy, { width: cols[i].w - 8, align: cols[i].align });
    }
    yy += 14;
  }
  (doc as unknown as { _vatEndY: number })._vatEndY = yy + 10;
}

function drawTotals(doc: PDFKit.PDFDocument, input: RenderInput): void {
  const { invoice } = input;
  const y =
    (doc as unknown as { _vatEndY?: number })._vatEndY ??
    (doc as unknown as { _lineTableEndY: number })._lineTableEndY;

  const boxX = A4_WIDTH - PAGE_MARGIN - 240;
  const labelX = boxX + 8;
  const valueX = boxX + 150;

  doc.rect(boxX, y, 240, 72).lineWidth(0.5).strokeColor('#888').stroke();
  doc.strokeColor('#000').lineWidth(1);

  doc.font('Helvetica').fontSize(10);
  const rows: [string, string][] = [
    ['Subtotal', `${fmt(invoice.subtotal, invoice.currency)} ${invoice.currency}`],
    ['VAT total', `${fmt(invoice.vatTotal, invoice.currency)} ${invoice.currency}`],
  ];
  rows.forEach(([label, value], i) => {
    doc.font('Helvetica').text(label, labelX, y + 8 + i * 16);
    doc.text(value, valueX, y + 8 + i * 16, { width: 80, align: 'right' });
  });
  doc
    .moveTo(boxX, y + 44)
    .lineTo(boxX + 240, y + 44)
    .strokeColor('#888')
    .stroke();
  doc.strokeColor('#000');
  doc.font('Helvetica-Bold').fontSize(12);
  doc.text('Grand total', labelX, y + 50);
  doc.text(`${fmt(invoice.grandTotal, invoice.currency)} ${invoice.currency}`, valueX, y + 50, {
    width: 80,
    align: 'right',
  });
}

function drawFooter(doc: PDFKit.PDFDocument, input: RenderInput): void {
  const { invoice } = input;
  const y = A4_HEIGHT - PAGE_MARGIN - 24;
  doc.font('Helvetica').fontSize(7).fillColor('#777');
  doc.text(
    `Generated by Fawtara. Document UUID: ${invoice.documentUuid ?? 'pending'}. This PDF is a human-readable rendering of the authoritative PINT-OM UBL 2.1 e-invoice.`,
    PAGE_MARGIN,
    y,
    { width: A4_WIDTH - PAGE_MARGIN * 2 - 100 },
  );
  doc.fillColor('#000');
}

function fmt(v: string | number, currency: string, scaleOverride?: number): string {
  const scale = scaleOverride ?? (currency === 'OMR' ? 3 : 2);
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(scale);
}

function categoryName(code: string): string {
  switch (code) {
    case 'S':
      return 'S — Standard';
    case 'Z':
      return 'Z — Zero-rated';
    case 'E':
      return 'E — Exempt';
    case 'O':
      return 'O — Out of scope';
    default:
      return code;
  }
}
