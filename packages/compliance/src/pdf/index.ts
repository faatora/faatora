/**
 * PDF/A-3 renderer barrel export.
 *
 * Downstream consumers import everything from `@faatora/compliance` —
 * see the package root barrel for the re-export.
 */
export type {
  BilingualText,
  FirmBranding,
  InvoiceLineRender,
  InvoicePartyRender,
  InvoiceRenderInput,
  InvoiceRenderOutput,
  InvoiceTotalsRender,
} from './types.js';

export {
  decodeInvoiceQrTlv,
  decodeTlv,
  encodeInvoiceQrTlv,
  encodeStringTriple,
  encodeTlvTriple,
  tlvValueAsString,
} from './qr-tlv.js';
export type { InvoiceQrTlvInput, TlvTriple } from './qr-tlv.js';

export { buildInvoiceHtml } from './template-html.js';

export { renderPdfA3 } from './renderer.js';
export type { RenderOptions } from './renderer.js';
