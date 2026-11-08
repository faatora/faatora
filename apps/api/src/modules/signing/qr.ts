import QRCode from 'qrcode';

/**
 * QR payload shape for Faatora signed invoices.
 *
 * The Oman Tax Authority has not yet published a final mandatory QR
 * specification for PINT-OM invoices; this is the Faatora interim format
 * modelled on the ZATCA v2 TLV approach but kept as compact JSON so it can be
 * extended without a schema migration. All amounts are decimal strings to
 * preserve precision; `v` is the schema version so verifiers can adapt when
 * OTA publishes the final format.
 */
export interface FaatoraQrPayload {
  /** Payload schema version; bump when the field set changes. */
  v: number;
  /** Document UUID placed inside the UBL invoice. */
  uuid: string;
  /** Human invoice number (e.g. INV-2026-0001). */
  n: string;
  /** Issue date, ISO-8601 (YYYY-MM-DD). */
  d: string;
  /** Grand total, decimal string in document currency. */
  gt: string;
  /** VAT total, decimal string in document currency. */
  vt: string;
  /** Supplier VATIN (OM VAT registration number). */
  svat: string;
  /** Optional extension bag for forward-compat with the final OTA spec. */
  ext?: Record<string, string | number>;
}

export function buildQrPayload(input: {
  uuid: string;
  number: string;
  issueDate: string;
  grandTotal: string | number;
  vatTotal: string | number;
  supplierVatin: string;
  ext?: Record<string, string | number>;
}): FaatoraQrPayload {
  return {
    v: 1,
    uuid: input.uuid,
    n: input.number,
    d: input.issueDate,
    gt: String(input.grandTotal),
    vt: String(input.vatTotal),
    svat: input.supplierVatin,
    ...(input.ext ? { ext: input.ext } : {}),
  };
}

/**
 * Render a payload to a base64-encoded PNG QR code.
 * The input is any string; callers typically pass `JSON.stringify(buildQrPayload(...))`.
 */
export async function generateQrPng(payload: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    margin: 1,
    width: 320,
  });
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
