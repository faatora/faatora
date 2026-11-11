import {
  decodeInvoiceQrTlv,
  decodeTlv,
  encodeInvoiceQrTlv,
  encodeStringTriple,
  encodeTlvTriple,
  tlvValueAsString,
} from '../qr-tlv.js';

describe('encodeTlvTriple', () => {
  it('uses short form for lengths 0..127', () => {
    const buf = encodeTlvTriple(1, new Uint8Array([0x41, 0x42, 0x43]));
    expect(Array.from(buf)).toEqual([0x01, 0x03, 0x41, 0x42, 0x43]);
  });

  it('uses DER long form 0x81 for lengths 128..255', () => {
    const value = new Uint8Array(200).fill(0x61);
    const buf = encodeTlvTriple(1, value);
    // header: tag(1) + 0x81 + 200(1 byte) = 3 bytes
    expect(buf.length).toBe(3 + 200);
    expect(buf[0]).toBe(0x01);
    expect(buf[1]).toBe(0x81);
    expect(buf[2]).toBe(200);
  });

  it('uses DER long form 0x82 for lengths 256..65535', () => {
    const value = new Uint8Array(1024).fill(0x61);
    const buf = encodeTlvTriple(1, value);
    expect(buf.length).toBe(4 + 1024);
    expect(buf[0]).toBe(0x01);
    expect(buf[1]).toBe(0x82);
    expect((buf[2]! << 8) | buf[3]!).toBe(1024);
  });

  it('rejects tags outside 1..255', () => {
    expect(() => encodeTlvTriple(0, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeTlvTriple(256, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeTlvTriple(-1, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeTlvTriple(1.5, new Uint8Array())).toThrow(RangeError);
  });

  it('rejects values longer than 65535 bytes', () => {
    const tooLong = new Uint8Array(65536);
    expect(() => encodeTlvTriple(1, tooLong)).toThrow(RangeError);
  });

  it('handles empty values with short-form zero length', () => {
    const buf = encodeTlvTriple(9, new Uint8Array());
    expect(Array.from(buf)).toEqual([0x09, 0x00]);
  });
});

describe('encodeStringTriple', () => {
  it('encodes ASCII strings using their byte length', () => {
    const buf = encodeStringTriple(1, 'ABC');
    expect(Array.from(buf)).toEqual([0x01, 0x03, 0x41, 0x42, 0x43]);
  });

  it('encodes non-ASCII strings using UTF-8 byte length, not code units', () => {
    // Arabic "شركة" is 4 characters but 8 UTF-8 bytes (2 bytes each).
    const buf = encodeStringTriple(1, 'شركة');
    expect(buf[0]).toBe(0x01);
    expect(buf[1]).toBe(0x08);
    expect(buf.length).toBe(2 + 8);
  });
});

describe('encodeInvoiceQrTlv / decodeInvoiceQrTlv', () => {
  it('round-trips the five Phase-1 fields', () => {
    const timestamp = new Date('2022-04-25T15:30:00Z');
    const payload = encodeInvoiceQrTlv({
      sellerName: 'Salem Bin Ali Bin Saleem',
      sellerVatNumber: '310122393500003',
      timestamp,
      invoiceTotal: '1000.00',
      vatTotal: '150.00',
    });

    const triples = decodeInvoiceQrTlv(payload);
    expect(triples.length).toBe(5);
    expect(triples[0]!.tag).toBe(1);
    expect(tlvValueAsString(triples[0]!.value)).toBe('Salem Bin Ali Bin Saleem');
    expect(triples[1]!.tag).toBe(2);
    expect(tlvValueAsString(triples[1]!.value)).toBe('310122393500003');
    expect(triples[2]!.tag).toBe(3);
    expect(tlvValueAsString(triples[2]!.value)).toBe(timestamp.toISOString());
    expect(triples[3]!.tag).toBe(4);
    expect(tlvValueAsString(triples[3]!.value)).toBe('1000.00');
    expect(triples[4]!.tag).toBe(5);
    expect(tlvValueAsString(triples[4]!.value)).toBe('150.00');
  });

  it('produces valid base64 output', () => {
    const payload = encodeInvoiceQrTlv({
      sellerName: 'Fawtara',
      sellerVatNumber: 'OM1234567',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      invoiceTotal: '105.000',
      vatTotal: '5.000',
    });
    expect(payload).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Decoding must not throw.
    expect(() => Buffer.from(payload, 'base64')).not.toThrow();
  });

  it('produces an Arabic-first payload with correct byte lengths', () => {
    const payload = encodeInvoiceQrTlv({
      sellerName: 'شركة فاتورة',
      sellerVatNumber: 'OM987654321',
      timestamp: new Date('2026-11-12T10:00:00Z'),
      invoiceTotal: '210.500',
      vatTotal: '10.500',
    });
    const triples = decodeInvoiceQrTlv(payload);
    expect(tlvValueAsString(triples[0]!.value)).toBe('شركة فاتورة');
    // 11 Arabic/space characters: 10 chars * 2 bytes + 1 space = 21 bytes
    expect(triples[0]!.value.length).toBe(21);
  });

  it('round-trips long values that require 0x82 long form', () => {
    // Simulate a Phase 2 signing hash.
    const longValue = 'A'.repeat(1024);
    const encoded = encodeStringTriple(6, longValue);
    const [decoded] = decodeTlv(encoded);
    expect(decoded!.tag).toBe(6);
    expect(tlvValueAsString(decoded!.value)).toBe(longValue);
  });
});

describe('decodeTlv', () => {
  it('throws on truncated length byte', () => {
    expect(() => decodeTlv(new Uint8Array([0x01]))).toThrow(/truncated/);
  });

  it('throws on truncated value bytes', () => {
    // tag 1, declared length 5, only 2 bytes follow
    expect(() => decodeTlv(new Uint8Array([0x01, 0x05, 0x41, 0x42]))).toThrow(/truncated/);
  });

  it('throws on unsupported long-form indicator', () => {
    expect(() => decodeTlv(new Uint8Array([0x01, 0x83, 0x00, 0x00, 0x01]))).toThrow(
      /Unsupported TLV long-form/,
    );
  });

  it('throws on truncated long-form length header (0x81)', () => {
    expect(() => decodeTlv(new Uint8Array([0x01, 0x81]))).toThrow(/truncated/);
  });

  it('throws on truncated long-form length header (0x82)', () => {
    expect(() => decodeTlv(new Uint8Array([0x01, 0x82, 0x00]))).toThrow(/truncated/);
  });

  it('accepts an empty buffer and yields no triples', () => {
    expect(decodeTlv(new Uint8Array())).toEqual([]);
  });
});
