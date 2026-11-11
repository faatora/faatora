/**
 * Bilingual (Arabic RTL + English LTR) invoice HTML template.
 *
 * The template is a pure function of its inputs: no I/O, no Date.now(),
 * no network fetches. The renderer drives it, hands the result to
 * Playwright's headless Chromium, and downstream post-processing
 * (attachment, PDF/A-3 metadata) runs on the printed bytes.
 *
 * We render a two-column layout where each column repeats the same
 * document content in its own language and direction. Arabic falls back
 * to the English value when the caller did not supply an `ar` variant,
 * so every renderable value is defined for both columns at build time.
 */

import type { InvoiceRenderInput, BilingualText } from './types.js';

/** HTML-escape text before interpolating into the template. */
function esc(input: string): string {
  return input.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/** Resolve a bilingual text to its English / Arabic variants (falling back to English). */
function pair(text: BilingualText): { en: string; ar: string } {
  return { en: text.en, ar: text.ar ?? text.en };
}

/** Translatable label strings for one language column. */
interface Headings {
  invoice: string;
  credit_note: string;
  debit_note: string;
  seller: string;
  buyer: string;
  vat: string;
  invoiceNo: string;
  issueDate: string;
  currency: string;
  lineNo: string;
  description: string;
  qty: string;
  unitPrice: string;
  vatRate: string;
  lineAmount: string;
  netTotal: string;
  vatTotal: string;
  grandTotal: string;
  notes: string;
}

/** Headers shown at the top of each language column. */
const HEADINGS: { en: Headings; ar: Headings } = {
  en: {
    invoice: 'Tax Invoice',
    credit_note: 'Tax Credit Note',
    debit_note: 'Tax Debit Note',
    seller: 'Seller',
    buyer: 'Buyer',
    vat: 'VAT No.',
    invoiceNo: 'Invoice No.',
    issueDate: 'Issue Date',
    currency: 'Currency',
    lineNo: '#',
    description: 'Description',
    qty: 'Qty',
    unitPrice: 'Unit Price',
    vatRate: 'VAT %',
    lineAmount: 'Amount',
    netTotal: 'Net Total',
    vatTotal: 'VAT Total',
    grandTotal: 'Grand Total',
    notes: 'Notes',
  },
  ar: {
    invoice: 'فاتورة ضريبية',
    credit_note: 'إشعار دائن ضريبي',
    debit_note: 'إشعار مدين ضريبي',
    seller: 'البائع',
    buyer: 'المشتري',
    vat: 'الرقم الضريبي',
    invoiceNo: 'رقم الفاتورة',
    issueDate: 'تاريخ الإصدار',
    currency: 'العملة',
    lineNo: '#',
    description: 'الوصف',
    qty: 'الكمية',
    unitPrice: 'سعر الوحدة',
    vatRate: 'نسبة ض.ق.م',
    lineAmount: 'المبلغ',
    netTotal: 'الصافي',
    vatTotal: 'إجمالي الضريبة',
    grandTotal: 'المجموع الإجمالي',
    notes: 'ملاحظات',
  },
};

/** CSS for the invoice. Inlined into the HTML so Chromium has nothing to fetch. */
function stylesheet(primaryColor: string): string {
  return `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'Noto Sans', 'Noto Sans Arabic', 'Helvetica Neue', Arial, sans-serif;
      color: #0F172A;
      font-size: 10pt;
      line-height: 1.4;
    }
    .page {
      padding: 20mm 15mm;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 2px solid ${primaryColor};
      padding-bottom: 8mm;
      margin-bottom: 8mm;
    }
    .header .logo {
      max-height: 20mm;
      max-width: 40mm;
    }
    .header .firm {
      text-align: right;
    }
    .header .firm .firm-name-ar {
      font-size: 14pt;
      font-weight: 600;
      direction: rtl;
    }
    .header .firm .firm-name-en {
      font-size: 11pt;
      color: #475569;
    }
    .columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10mm;
    }
    .col {
      min-width: 0;
    }
    .col-en { direction: ltr; text-align: left; }
    .col-ar { direction: rtl; text-align: right; font-family: 'Noto Sans Arabic', 'Amiri', serif; }
    .doc-title {
      font-size: 16pt;
      font-weight: 700;
      color: ${primaryColor};
      margin: 0 0 4mm 0;
    }
    .meta {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 1mm 4mm;
      margin-bottom: 6mm;
      font-size: 9pt;
    }
    .meta dt { color: #64748B; }
    .meta dd { margin: 0; font-weight: 600; }
    .party {
      border: 1px solid #E2E8F0;
      border-radius: 1.5mm;
      padding: 3mm 4mm;
      margin-bottom: 6mm;
    }
    .party h3 {
      margin: 0 0 1mm 0;
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #64748B;
    }
    .party .name { font-weight: 600; margin-bottom: 1mm; }
    .party .vat { color: #475569; font-size: 9pt; }
    .party .addr { white-space: pre-line; font-size: 9pt; color: #334155; }
    table.lines {
      width: 100%;
      border-collapse: collapse;
      font-size: 9pt;
    }
    table.lines th, table.lines td {
      border-bottom: 1px solid #E2E8F0;
      padding: 2mm 2mm;
    }
    table.lines th {
      background: #F8FAFC;
      color: #475569;
      font-weight: 600;
      text-align: inherit;
    }
    table.lines td.num, table.lines th.num {
      text-align: end;
      font-variant-numeric: tabular-nums;
    }
    .totals {
      margin-top: 4mm;
      display: grid;
      grid-template-columns: auto auto;
      justify-content: end;
      gap: 1mm 6mm;
      font-size: 10pt;
    }
    .totals dt { color: #475569; }
    .totals dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .totals .grand dt, .totals .grand dd {
      font-size: 12pt;
      color: ${primaryColor};
      padding-top: 2mm;
      border-top: 1px solid #CBD5E1;
    }
    .notes {
      margin-top: 8mm;
      padding-top: 4mm;
      border-top: 1px dashed #CBD5E1;
      font-size: 9pt;
      color: #475569;
    }
    .footer {
      margin-top: 10mm;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid #E2E8F0;
      padding-top: 4mm;
    }
    .qr img {
      width: 32mm;
      height: 32mm;
    }
    .footer .qr-caption {
      font-size: 8pt;
      color: #64748B;
    }
  `;
}

interface ColumnInput {
  dir: 'ltr' | 'rtl';
  colClass: 'col-en' | 'col-ar';
  headings: Headings;
  invoice: InvoiceRenderInput;
  pickLang: 'en' | 'ar';
}

/** Render a party block in one language. */
function renderParty(column: ColumnInput, which: 'seller' | 'buyer'): string {
  const party = column.invoice[which];
  const name = pair(party.name)[column.pickLang];
  const label = which === 'seller' ? column.headings.seller : column.headings.buyer;
  const address = party.address ? pair(party.address)[column.pickLang] : undefined;
  return `
    <section class="party">
      <h3>${esc(label)}</h3>
      <div class="name">${esc(name)}</div>
      ${party.vatNumber ? `<div class="vat">${esc(column.headings.vat)}: ${esc(party.vatNumber)}</div>` : ''}
      ${address ? `<div class="addr">${esc(address)}</div>` : ''}
      ${party.country ? `<div class="addr">${esc(party.country)}</div>` : ''}
    </section>
  `;
}

/** Render the line-items table in one language. */
function renderLines(column: ColumnInput): string {
  const { headings, invoice, pickLang } = column;
  const rows = invoice.lines
    .map((line) => {
      const desc = pair(line.description)[pickLang];
      return `
        <tr>
          <td class="num">${esc(String(line.lineNo))}</td>
          <td>${esc(desc)}</td>
          <td class="num">${esc(line.quantity)} ${esc(line.unitCode)}</td>
          <td class="num">${esc(line.unitPrice)}</td>
          <td class="num">${esc(line.vatRate)}</td>
          <td class="num">${esc(line.lineAmount)}</td>
        </tr>
      `;
    })
    .join('');
  return `
    <table class="lines">
      <thead>
        <tr>
          <th class="num">${esc(headings.lineNo)}</th>
          <th>${esc(headings.description)}</th>
          <th class="num">${esc(headings.qty)}</th>
          <th class="num">${esc(headings.unitPrice)}</th>
          <th class="num">${esc(headings.vatRate)}</th>
          <th class="num">${esc(headings.lineAmount)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** Render the totals and (optional) notes block in one language. */
function renderTotalsAndNotes(column: ColumnInput): string {
  const { headings, invoice, pickLang } = column;
  const notes = invoice.notes ? pair(invoice.notes)[pickLang] : undefined;
  return `
    <dl class="totals">
      <dt>${esc(headings.netTotal)}</dt><dd>${esc(invoice.totals.netTotal)} ${esc(invoice.currency)}</dd>
      <dt>${esc(headings.vatTotal)}</dt><dd>${esc(invoice.totals.vatTotal)} ${esc(invoice.currency)}</dd>
      <dt class="grand">${esc(headings.grandTotal)}</dt>
      <dd class="grand">${esc(invoice.totals.grandTotal)} ${esc(invoice.currency)}</dd>
    </dl>
    ${notes ? `<div class="notes"><strong>${esc(headings.notes)}:</strong> ${esc(notes)}</div>` : ''}
  `;
}

/** Render one language column. */
function renderColumn(column: ColumnInput): string {
  const { invoice, headings, dir, colClass } = column;
  const title = headings[invoice.documentType];
  return `
    <div class="col ${colClass}" dir="${dir}">
      <h1 class="doc-title">${esc(title)}</h1>
      <dl class="meta">
        <dt>${esc(headings.invoiceNo)}</dt><dd>${esc(invoice.invoiceNumber)}</dd>
        <dt>${esc(headings.issueDate)}</dt><dd>${esc(invoice.issueDate)}</dd>
        <dt>${esc(headings.currency)}</dt><dd>${esc(invoice.currency)}</dd>
      </dl>
      ${renderParty(column, 'seller')}
      ${renderParty(column, 'buyer')}
      ${renderLines(column)}
      ${renderTotalsAndNotes(column)}
    </div>
  `;
}

/** Optional firm logo as inline <img> (data URI). The caller injects the data URI. */
function renderLogo(dataUri: string | undefined): string {
  if (!dataUri) return '';
  return `<img class="logo" src="${dataUri}" alt="logo" />`;
}

/**
 * Build the full invoice HTML.
 *
 * @param invoice  Invoice data, pre-formatted for display.
 * @param qrPngDataUri  The QR code as a `data:image/png;base64,...` URI.
 * @param logoDataUri  Optional logo as a `data:...` URI.
 */
export function buildInvoiceHtml(
  invoice: InvoiceRenderInput,
  qrPngDataUri: string,
  logoDataUri?: string,
): string {
  const primaryColor = invoice.branding.primaryColor ?? '#0F172A';
  const firmName = pair(invoice.branding.firmName);

  const enColumn: ColumnInput = {
    dir: 'ltr',
    colClass: 'col-en',
    headings: HEADINGS.en,
    invoice,
    pickLang: 'en',
  };
  const arColumn: ColumnInput = {
    dir: 'rtl',
    colClass: 'col-ar',
    headings: HEADINGS.ar,
    invoice,
    pickLang: 'ar',
  };

  // Document is LTR by default; the Arabic column flips direction locally.
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8" />
  <meta name="generator" content="Fawtara PDF/A-3 renderer" />
  <title>${esc(firmName.en)} - ${esc(invoice.invoiceNumber)}</title>
  <style>${stylesheet(primaryColor)}</style>
</head>
<body>
  <main class="page">
    <header class="header">
      ${renderLogo(logoDataUri)}
      <div class="firm">
        <div class="firm-name-ar">${esc(firmName.ar)}</div>
        <div class="firm-name-en">${esc(firmName.en)}</div>
      </div>
    </header>
    <section class="columns">
      ${renderColumn(arColumn)}
      ${renderColumn(enColumn)}
    </section>
    <footer class="footer">
      <div class="qr">
        <img src="${qrPngDataUri}" alt="QR" />
        <div class="qr-caption">TLV v1 (ZATCA/GCC)</div>
      </div>
      <div class="qr-caption">
        ${esc(invoice.issueTimestamp)}
      </div>
    </footer>
  </main>
</body>
</html>`;
}
