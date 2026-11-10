import { inflateSync } from 'node:zlib';
import { renderPdf, type RenderInput } from '../src/modules/signing/pdf';

/**
 * Extract all text literals that pdfkit emits as `( ... ) Tj` / `( ... ) TJ`
 * from a PDF buffer. Content streams in pdfkit output are zlib-compressed, so
 * we walk the raw bytes, decompress every `stream ... endstream` block that
 * was `FlateDecode`-encoded, and pull the parenthesised text operands out.
 *
 * Uses only node stdlib — no third-party PDF parser (pdf-parse@1.1.1 is
 * broken on Node 22; see https://github.com/UpperCod/pdf-parse/issues/13).
 */
function extractText(pdf: Buffer): string {
  const bytes = pdf;
  const result: string[] = [];
  // Find every "stream\n ... \nendstream" block.
  const whole = bytes.toString('binary');
  let cursor = 0;
  while (true) {
    const streamIdx = whole.indexOf('\nstream', cursor);
    if (streamIdx === -1) break;
    const endIdx = whole.indexOf('endstream', streamIdx);
    if (endIdx === -1) break;
    // The stream data begins just after "stream" and a line terminator (CRLF or LF).
    let dataStart = streamIdx + '\nstream'.length;
    if (whole[dataStart] === '\r') dataStart++;
    if (whole[dataStart] === '\n') dataStart++;
    const dataEnd = endIdx;
    const streamBytes = bytes.subarray(dataStart, dataEnd);

    let decoded: Buffer;
    try {
      decoded = inflateSync(streamBytes);
    } catch {
      decoded = streamBytes;
    }

    // pdfkit emits text via standard-font encoding as `<HEX>` tokens inside
    // the TJ operator, e.g. `[<46> 50 <61> 20 <77746172>] TJ`. Each hex pair
    // is a Latin-1 (WinAnsiEncoding) byte for Helvetica. We also tolerate the
    // classic `( ... ) Tj` form for streams that use it.
    const text = decoded.toString('binary');
    const hexRe = /<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = hexRe.exec(text)) !== null) {
      const hex = m[1];
      let decodedStr = '';
      for (let i = 0; i + 1 < hex.length; i += 2) {
        const b = parseInt(hex.substr(i, 2), 16);
        decodedStr += String.fromCharCode(b);
      }
      if (decodedStr.length > 0) result.push(decodedStr);
    }
    const parenRe = /\(((?:\\.|[^()\\])*)\)/g;
    while ((m = parenRe.exec(text)) !== null) {
      result.push(unescapePdfString(m[1]));
    }
    cursor = endIdx + 'endstream'.length;
  }
  // Concatenate all glyph fragments with no separator — pdfkit splits words at
  // kerning points so a single word is emitted as several tokens with numeric
  // offsets between them inside the TJ array. Joining with "" reassembles each
  // word; cross-string boundaries still bleed together but assertions are
  // substring-based and robust to that.
  return result.join('');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, '');
}

function contains(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

function unescapePdfString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

const SAMPLE_QR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

function sample(): RenderInput {
  return {
    invoice: {
      id: 'd3a5f1c6-0000-4000-8000-000000000001',
      number: 'INV-2026-1001',
      documentUuid: '11111111-2222-3333-4444-555555555555',
      issueDate: '2026-10-17',
      currency: 'OMR',
      subtotal: 100.0,
      vatTotal: 5.0,
      grandTotal: 105.0,
    },
    lines: [
      {
        lineNo: 1,
        description: 'Consulting services October',
        quantity: 10,
        unitPrice: 8.0,
        lineNet: 80.0,
      },
      {
        lineNo: 2,
        description: 'Platform subscription',
        quantity: 1,
        unitPrice: 20.0,
        lineNet: 20.0,
      },
    ],
    supplier: { name: 'Faatora Supplier Co', vatin: 'OM1234567890', country: 'OM' },
    buyer: { name: 'Acme Trading LLC', vatin: 'OM9876543210', country: 'OM' },
    vatBreakdown: [{ category: 'S', rate: 5, taxable: 100, tax: 5 }],
    qrPngBase64: SAMPLE_QR_PNG_BASE64,
  };
}

describe('renderPdf', () => {
  it('produces a valid PDF with the invoice content', async () => {
    const b64 = await renderPdf(sample());
    const buf = Buffer.from(b64, 'base64');
    expect(buf.slice(0, 5).toString('utf8')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(3000);

    const text = extractText(buf);
    expect(contains(text, 'TAX INVOICE')).toBe(true);
    expect(contains(text, 'INV-2026-1001')).toBe(true);
    expect(contains(text, '2026-10-17')).toBe(true);
    expect(contains(text, '11111111-2222-3333-4444-555555555555')).toBe(true);
    expect(contains(text, 'Faatora Supplier Co')).toBe(true);
    expect(contains(text, 'OM1234567890')).toBe(true);
    expect(contains(text, 'Acme Trading LLC')).toBe(true);
    expect(contains(text, 'OM9876543210')).toBe(true);
    expect(contains(text, 'Consulting services')).toBe(true);
    expect(contains(text, 'Platform subscription')).toBe(true);
    expect(contains(text, '80.000')).toBe(true);
    expect(contains(text, '20.000')).toBe(true);
    expect(contains(text, 'Grand total')).toBe(true);
    expect(contains(text, '105.000')).toBe(true);
    expect(contains(text, 'VAT breakdown')).toBe(true);
    expect(contains(text, 'Standard')).toBe(true);
    expect(contains(text, 'Faatora')).toBe(true);
  });

  it('embeds the QR PNG image into the PDF payload', async () => {
    const b64 = await renderPdf(sample());
    const buf = Buffer.from(b64, 'base64');
    const txt = buf.toString('binary');
    expect(txt).toMatch(/\/Subtype\s*\/Image/);
  });

  it('does not fail when vatBreakdown is empty', async () => {
    const input = sample();
    input.vatBreakdown = [];
    const b64 = await renderPdf(input);
    const buf = Buffer.from(b64, 'base64');
    expect(buf.length).toBeGreaterThan(2000);
    const text = extractText(buf);
    expect(contains(text, 'VAT breakdown')).toBe(false);
    expect(contains(text, 'Grand total')).toBe(true);
  });

  it('uses 2 decimal places for non-OMR currency', async () => {
    const input = sample();
    input.invoice.currency = 'USD';
    input.invoice.subtotal = 100;
    input.invoice.vatTotal = 5;
    input.invoice.grandTotal = 105;
    const b64 = await renderPdf(input);
    const buf = Buffer.from(b64, 'base64');
    const text = extractText(buf);
    // 2-dp amount followed by currency code; normalization makes this
    // whitespace-insensitive, which is what we want (pdfkit may emit the
    // numeric value and the currency code as separate TJ runs).
    expect(contains(text, '105.00USD')).toBe(true);
    // No 3-dp artefact for a 2-dp currency.
    expect(contains(text, '105.000USD')).toBe(false);
  });

  it('survives an empty QR payload without throwing', async () => {
    const input = sample();
    input.qrPngBase64 = '';
    const b64 = await renderPdf(input);
    const buf = Buffer.from(b64, 'base64');
    expect(buf.slice(0, 5).toString('utf8')).toBe('%PDF-');
  });
});
