/**
 * GCC / ZATCA-style TLV encoder for e-invoice QR codes.
 *
 * Every Fawtara invoice carries a QR whose payload is a base64 string
 * of concatenated tag-length-value triples:
 *
 *   Tag 1  Seller name            (UTF-8 string)
 *   Tag 2  Seller VAT number      (UTF-8 string)
 *   Tag 3  Invoice timestamp      (ISO 8601 / RFC 3339 string)
 *   Tag 4  Invoice total (incl.)  (string, decimal)
 *   Tag 5  VAT total              (string, decimal)
 *   Tag 6+ Reserved for Phase 2   (signing hash, public key, ECDSA
 *                                  signature). Not emitted yet.
 *
 * Encoding rules:
 *   - Each triple is `<tag:1 byte><length><value:length bytes>`.
 *   - `length` is BER / DER short-form when the value is <= 127 bytes
 *     (a single byte whose high bit is 0). For 128..65535 bytes we use
 *     DER long form: `0x81 <len:1>` for 128..255 or `0x82 <len:2>` for
 *     256..65535. ZATCA's Phase 1 spec is silent on multi-byte lengths
 *     because Phase 1 values never exceed 127 bytes, but Phase 2 can
 *     carry long signing hashes, so we implement the general rule.
 *   - String values are UTF-8 encoded; byte length (not character count)
 *     is what goes in the length field.
 *
 * The decoder is deliberately symmetric and exported so unit tests and
 * downstream verifiers can round-trip the encoded payload.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Maximum payload length we support per triple. Matches DER long form (2). */
const MAX_VALUE_BYTES = 0xffff; // 65535

/**
 * Phase-1 inputs to the invoice QR TLV. All string fields are rendered
 * UTF-8; timestamp is converted to ISO 8601 (RFC 3339 profile).
 */
export interface InvoiceQrTlvInput {
  sellerName: string;
  sellerVatNumber: string;
  timestamp: Date;
  /** Invoice total WITH VAT, decimal string (e.g. "105.000"). */
  invoiceTotal: string;
  /** VAT total, decimal string (e.g. "5.000"). */
  vatTotal: string;
}

/** A decoded TLV triple. */
export interface TlvTriple {
  tag: number;
  value: Uint8Array;
}

/**
 * Encode one TLV triple into a Uint8Array.
 * Throws `RangeError` for invalid tags or over-long values.
 */
export function encodeTlvTriple(tag: number, value: Uint8Array): Uint8Array {
  if (!Number.isInteger(tag) || tag < 1 || tag > 0xff) {
    throw new RangeError(`TLV tag out of range (1..255): ${String(tag)}`);
  }
  const len = value.length;
  if (len > MAX_VALUE_BYTES) {
    throw new RangeError(`TLV value too long (${String(len)} > ${String(MAX_VALUE_BYTES)} bytes)`);
  }

  let header: Uint8Array;
  if (len <= 0x7f) {
    // Short form: single byte length.
    header = new Uint8Array([tag, len]);
  } else if (len <= 0xff) {
    // DER long form, 1 following byte.
    header = new Uint8Array([tag, 0x81, len]);
  } else {
    // DER long form, 2 following bytes, big-endian.
    header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  }

  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(value, header.length);
  return out;
}

/** Encode a UTF-8 string triple. Convenience wrapper over `encodeTlvTriple`. */
export function encodeStringTriple(tag: number, value: string): Uint8Array {
  return encodeTlvTriple(tag, encoder.encode(value));
}

/**
 * Concatenate the five Phase-1 triples and return a base64 string.
 *
 * Note: this returns standard base64 (RFC 4648), not base64url. QR
 * codes use alphanumeric mode or byte mode; standard base64 encodes
 * cleanly in byte mode, which is what ZATCA's reference verifier
 * expects.
 */
export function encodeInvoiceQrTlv(input: InvoiceQrTlvInput): string {
  const triples: Uint8Array[] = [
    encodeStringTriple(1, input.sellerName),
    encodeStringTriple(2, input.sellerVatNumber),
    encodeStringTriple(3, input.timestamp.toISOString()),
    encodeStringTriple(4, input.invoiceTotal),
    encodeStringTriple(5, input.vatTotal),
  ];

  const total = triples.reduce((n, t) => n + t.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const t of triples) {
    buf.set(t, offset);
    offset += t.length;
  }
  return Buffer.from(buf).toString('base64');
}

/**
 * Parse a TLV byte stream into its triples. Validates DER short/long
 * form length encoding and refuses unknown long-form indicators.
 * Throws `Error` on truncated or malformed input.
 */
export function decodeTlv(bytes: Uint8Array): TlvTriple[] {
  const triples: TlvTriple[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      throw new Error(`TLV truncated at offset ${String(i)} (missing length byte)`);
    }
    const tag = bytes[i]!;
    const first = bytes[i + 1]!;
    let len: number;
    let hdr: number;
    if (first <= 0x7f) {
      len = first;
      hdr = 2;
    } else if (first === 0x81) {
      if (i + 2 >= bytes.length) {
        throw new Error(`TLV truncated at offset ${String(i)} (missing 1-byte length)`);
      }
      len = bytes[i + 2]!;
      hdr = 3;
    } else if (first === 0x82) {
      if (i + 3 >= bytes.length) {
        throw new Error(`TLV truncated at offset ${String(i)} (missing 2-byte length)`);
      }
      len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      hdr = 4;
    } else {
      throw new Error(`Unsupported TLV long-form indicator 0x${first.toString(16)} at offset ${String(i)}`);
    }
    if (i + hdr + len > bytes.length) {
      throw new Error(
        `TLV value truncated at offset ${String(i)} (declared ${String(len)} bytes, have ${String(
          bytes.length - i - hdr,
        )})`,
      );
    }
    const value = bytes.slice(i + hdr, i + hdr + len);
    triples.push({ tag, value });
    i += hdr + len;
  }
  return triples;
}

/** Decode a base64 TLV payload and return its triples. */
export function decodeInvoiceQrTlv(base64: string): TlvTriple[] {
  return decodeTlv(Uint8Array.from(Buffer.from(base64, 'base64')));
}

/** Decode a TLV value as UTF-8. */
export function tlvValueAsString(value: Uint8Array): string {
  return decoder.decode(value);
}
