import { XMLParser } from 'fast-xml-parser';

import { XML_NS } from '../types.js';
import { PEPPOL_SIGNATURE_ALGORITHMS, type SigningKeyReference } from '../signing/signer.js';
import { StubSigner, STUB_SIGNER_IDS } from '../signing/stub-signer.js';

const KEY_REF: SigningKeyReference = { keyRef: 'kms:faatora/sandbox/sign-01' };
const HEADER_TARGET = {
  kind: 'header' as const,
  id: '_messaging',
  xml: '<eb:Messaging xmlns:eb="urn:x"/>',
};
const ATTACHMENT_TARGET = {
  kind: 'attachment' as const,
  contentId: 'ubl-payload-1@faatora.om',
  bytes: '<Invoice/>',
};

const PARSER = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
});

describe('StubSigner — construction', () => {
  it('throws if keyRef.keyRef is empty', async () => {
    const signer = new StubSigner();
    await expect(signer.sign({ keyRef: { keyRef: '' }, targets: [HEADER_TARGET] })).rejects.toThrow(
      /keyRef/,
    );
  });

  it('throws if no targets are provided', async () => {
    const signer = new StubSigner();
    await expect(signer.sign({ keyRef: KEY_REF, targets: [] })).rejects.toThrow(
      /at least one target/,
    );
  });
});

describe('StubSigner — Signature structure', () => {
  it('produces a <ds:Signature> with SignedInfo, SignatureValue, KeyInfo and ds:Object', async () => {
    const signer = new StubSigner();
    const res = await signer.sign({ keyRef: KEY_REF, targets: [HEADER_TARGET, ATTACHMENT_TARGET] });
    const sig = res.signatureXml;
    expect(sig.startsWith('<ds:Signature ')).toBe(true);
    expect(sig).toContain(`xmlns:ds="${XML_NS.ds}"`);
    expect(sig).toContain(`xmlns:wsu="${XML_NS.wsu}"`);
    expect(sig).toContain(`wsu:Id="${STUB_SIGNER_IDS.signatureWsuId}"`);
    expect(sig).toContain('<ds:SignedInfo');
    expect(sig).toContain('<ds:SignatureValue>');
    expect(sig).toContain('<ds:KeyInfo');
    expect(sig).toContain('<ds:Object>');
    expect(sig).toContain('</ds:Signature>');
  });

  it('uses the Peppol-pinned algorithms for Canonicalization, Signature, Digest', async () => {
    const signer = new StubSigner();
    const res = await signer.sign({ keyRef: KEY_REF, targets: [HEADER_TARGET] });
    const sig = res.signatureXml;
    expect(sig).toContain(
      `<ds:CanonicalizationMethod Algorithm="${PEPPOL_SIGNATURE_ALGORITHMS.canonicalizationMethod}"/>`,
    );
    expect(sig).toContain(
      `<ds:SignatureMethod Algorithm="${PEPPOL_SIGNATURE_ALGORITHMS.signatureMethod}"/>`,
    );
    expect(sig).toContain(
      `<ds:DigestMethod Algorithm="${PEPPOL_SIGNATURE_ALGORITHMS.digestMethod}"/>`,
    );
    expect(res.algorithms).toEqual(PEPPOL_SIGNATURE_ALGORITHMS);
  });

  it('emits one <ds:Reference> per input target plus one for SignedProperties', async () => {
    const signer = new StubSigner();
    const res = await signer.sign({
      keyRef: KEY_REF,
      targets: [HEADER_TARGET, ATTACHMENT_TARGET],
    });
    const parsed = PARSER.parse(res.signatureXml);
    const refs = parsed.Signature.SignedInfo.Reference;
    expect(Array.isArray(refs)).toBe(true);
    // Two target refs + one SignedProperties ref.
    expect(refs).toHaveLength(3);
    expect(refs[0]['@_URI']).toBe('#_messaging');
    expect(refs[1]['@_URI']).toBe('cid:ubl-payload-1@faatora.om');
    expect(refs[2]['@_URI']).toBe('#_signedProperties');
    expect(refs[2]['@_Type']).toBe('http://uri.etsi.org/01903#SignedProperties');
  });

  it('includes a XAdES SignedProperties block with SigningTime and SigningCertificate', async () => {
    const signer = new StubSigner();
    const res = await signer.sign({ keyRef: KEY_REF, targets: [HEADER_TARGET] });
    const sig = res.signatureXml;
    expect(sig).toContain(`xmlns:xades="${XML_NS.xades}"`);
    expect(sig).toContain('<xades:QualifyingProperties');
    expect(sig).toContain(`Target="#${STUB_SIGNER_IDS.signatureWsuId}"`);
    expect(sig).toContain('<xades:SignedProperties');
    expect(sig).toContain('<xades:SigningTime>');
    expect(sig).toContain('<xades:SigningCertificate>');
  });

  it('includes an X509IssuerSerial block in KeyInfo', async () => {
    const signer = new StubSigner({
      x509IssuerName: 'CN=Test CA',
      x509SerialNumber: '42',
    });
    const res = await signer.sign({ keyRef: KEY_REF, targets: [HEADER_TARGET] });
    expect(res.signatureXml).toContain('<ds:X509IssuerName>CN=Test CA</ds:X509IssuerName>');
    expect(res.signatureXml).toContain('<ds:X509SerialNumber>42</ds:X509SerialNumber>');
  });
});

describe('StubSigner — determinism', () => {
  it('produces byte-identical output for identical inputs', async () => {
    const signer = new StubSigner();
    const [a, b] = await Promise.all([
      signer.sign({ keyRef: KEY_REF, targets: [HEADER_TARGET] }),
      signer.sign({ keyRef: KEY_REF, targets: [HEADER_TARGET] }),
    ]);
    expect(a.signatureXml).toBe(b.signatureXml);
  });

  it('digest changes when the target content changes', async () => {
    const signer = new StubSigner();
    const r1 = await signer.sign({
      keyRef: KEY_REF,
      targets: [{ ...HEADER_TARGET, xml: '<a/>' }],
    });
    const r2 = await signer.sign({
      keyRef: KEY_REF,
      targets: [{ ...HEADER_TARGET, xml: '<b/>' }],
    });
    const d1 = extractFirstDigest(r1.signatureXml);
    const d2 = extractFirstDigest(r2.signatureXml);
    expect(d1).not.toBe(d2);
  });

  it('echoes the key reference on the result', async () => {
    const signer = new StubSigner();
    const res = await signer.sign({ keyRef: KEY_REF, targets: [HEADER_TARGET] });
    expect(res.keyRef).toBe('kms:faatora/sandbox/sign-01');
  });
});

describe('StubSigner — parseability', () => {
  it('is well-formed XML that parses without error', async () => {
    const signer = new StubSigner();
    const res = await signer.sign({ keyRef: KEY_REF, targets: [HEADER_TARGET, ATTACHMENT_TARGET] });
    expect(() => PARSER.parse(res.signatureXml)).not.toThrow();
  });
});

function extractFirstDigest(sig: string): string {
  const m = sig.match(/<ds:DigestValue>([^<]+)<\/ds:DigestValue>/);
  if (!m) throw new Error('no DigestValue found');
  return m[1];
}
