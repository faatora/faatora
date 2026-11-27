/**
 * Unit tests for the PDF/A-3 structural validator.
 *
 * Fixtures are built inline with pdf-lib so each test owns its PDF end
 * to end and we never check in binary blobs that would rot. The pattern
 * is to start from `buildConformantFixture()` (which produces a PDF the
 * validator accepts) and then mutate one property at a time to prove
 * that each check is independent and fires exactly when it should.
 */

import {
  AFRelationship,
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from 'pdf-lib';

import { validatePdfA3 } from '../validator.js';

/** Build the XMP metadata packet that the validator's checks 3/4 expect. */
function xmpPacket(part = '3', conformance = 'B'): string {
  const bom = '\u{FEFF}';
  return `<?xpacket begin="${bom}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>${part}</pdfaid:part>
      <pdfaid:conformance>${conformance}</pdfaid:conformance>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

interface FixtureOverrides {
  /** Omit the XMP /Metadata entry. */
  skipMetadata?: boolean;
  /** Override the XMP pdfaid:part value. */
  xmpPart?: string;
  /** Override the XMP pdfaid:conformance value. */
  xmpConformance?: string;
  /** Omit the Catalog /OutputIntents array. */
  skipOutputIntents?: boolean;
  /** Omit /AFRelationship on the embedded filespec. */
  skipAfRelationship?: boolean;
  /** Attach a UBL XML file (default: no attachment). */
  attachUbl?: boolean;
  /** Omit the trailer /ID entry. */
  skipTrailerId?: boolean;
}

/**
 * Build a PDF buffer that is, by default, fully conformant per the
 * validator's six checks. Pass overrides to selectively break pieces.
 */
async function buildFixture(overrides: FixtureOverrides = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]); // non-empty page tree

  const context: PDFContext = doc.context;
  const catalog = doc.catalog;

  // Info dictionary — pdf-lib sets this on save. Fine for the validator;
  // the Info dict is not one of the checks.
  doc.setTitle('Fixture');
  doc.setCreator('validator.spec.ts');

  // Attach the UBL XML if requested. Done BEFORE we write the XMP and
  // OutputIntents so pdf-lib's attach() writes its own /Names tree and
  // /AF entry, which we then optionally de-fang.
  if (overrides.attachUbl) {
    await doc.attach(Buffer.from('<Invoice/>', 'utf-8'), 'invoice-ubl.xml', {
      mimeType: 'application/xml',
      afRelationship: AFRelationship.Source,
    });
    // pdf-lib materialises the /Names tree and /AF entry at save()
    // time, not at attach() time; the `skipAfRelationship` surgery
    // therefore runs post-save below.
  }

  // XMP /Metadata — register unless skipped.
  if (!overrides.skipMetadata) {
    const packet = xmpPacket(overrides.xmpPart ?? '3', overrides.xmpConformance ?? 'B');
    const xmpRef = context.register(context.stream(packet, { Type: 'Metadata', Subtype: 'XML' }));
    catalog.set(PDFName.of('Metadata'), xmpRef);
  }

  // OutputIntents — sRGB, identifier-only.
  if (!overrides.skipOutputIntents) {
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
      RegistryName: 'http://www.color.org',
      Info: 'sRGB IEC61966-2.1',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
  }

  // Trailer /ID — a deterministic pair of hex strings.
  if (!overrides.skipTrailerId) {
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;
  }

  const bytes = await doc.save({ useObjectStreams: false });

  // Post-save surgery. pdf-lib populates /Names /EmbeddedFiles and /AF
  // on save, so we have to reload to touch them.
  if (overrides.attachUbl && overrides.skipAfRelationship) {
    const reopened = await PDFDocument.load(bytes);
    const namesDict = reopened.catalog.lookup(PDFName.of('Names'), PDFDict);
    const embedded = namesDict.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const names = embedded.lookup(PDFName.of('Names'), PDFArray);
    for (let i = 1; i < names.size(); i += 2) {
      const spec = names.lookup(i, PDFDict);
      spec.delete(PDFName.of('AFRelationship'));
    }
    return Buffer.from(await reopened.save({ useObjectStreams: false }));
  }

  return Buffer.from(bytes);
}

describe('validatePdfA3', () => {
  it('rejects empty Buffer with "missing PDF header"', async () => {
    const result = await validatePdfA3(Buffer.alloc(0));
    expect(result.conformant).toBe(false);
    expect(result.level).toBeNull();
    expect(result.errors).toContain('missing PDF header');
  });

  it('rejects a buffer whose header is not %PDF-', async () => {
    const result = await validatePdfA3(Buffer.from('NOT A PDF AT ALL, JUST TEXT'));
    expect(result.conformant).toBe(false);
    expect(result.errors).toContain('missing PDF header');
  });

  it('rejects PDF with no XMP metadata', async () => {
    const pdf = await buildFixture({ skipMetadata: true });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => e.includes('/Metadata'))).toBe(true);
  });

  it('rejects XMP with pdfaid:part != 3', async () => {
    const pdf = await buildFixture({ xmpPart: '2' });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => /pdfaid:part is 2/.test(e))).toBe(true);
  });

  it('accepts XMP with pdfaid:part=3 and conformance=B', async () => {
    const pdf = await buildFixture({ xmpPart: '3', xmpConformance: 'B' });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.level).toBe('B');
    expect(result.errors).toEqual([]);
  });

  it('accepts XMP with pdfaid:conformance=U', async () => {
    const pdf = await buildFixture({ xmpConformance: 'U' });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.level).toBe('U');
  });

  it('rejects XMP with an unknown pdfaid:conformance level', async () => {
    const pdf = await buildFixture({ xmpConformance: 'X' });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.level).toBeNull();
    expect(result.errors.some((e) => /conformance is X/.test(e))).toBe(true);
  });

  it('rejects PDF missing OutputIntents', async () => {
    const pdf = await buildFixture({ skipOutputIntents: true });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => /OutputIntents/.test(e))).toBe(true);
  });

  it('rejects an OutputIntent with the wrong /S subtype', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    doc.setCreator('bad-subtype');

    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );

    // GTS_PDFX is PDF/X; a PDF/A validator must not accept it.
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFX',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);

    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => /GTS_PDFA1/.test(e))).toBe(true);
  });

  it('rejects an OutputIntent with neither sRGB OCI nor DestOutputProfile', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    doc.setCreator('missing-oci');

    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );

    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'Totally-Made-Up-Space',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);

    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(
      result.errors.some((e) => /sRGB.*OutputConditionIdentifier|DestOutputProfile/.test(e)),
    ).toBe(true);
  });

  it('rejects filespec with no /AFRelationship', async () => {
    const pdf = await buildFixture({ attachUbl: true, skipAfRelationship: true });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => /no \/AFRelationship/.test(e))).toBe(true);
  });

  it('accepts an attached UBL file when /AFRelationship is set', async () => {
    const pdf = await buildFixture({ attachUbl: true });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.level).toBe('B');
  });

  it('accepts a hand-built minimal conformant fixture', async () => {
    const pdf = await buildFixture();
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.level).toBe('B');
    expect(result.errors).toEqual([]);
  });

  it('reports multiple failures independently', async () => {
    const pdf = await buildFixture({
      skipMetadata: true,
      skipOutputIntents: true,
    });
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    // Both checks failed; both errors appear.
    expect(result.errors.some((e) => /\/Metadata/.test(e))).toBe(true);
    expect(result.errors.some((e) => /OutputIntents/.test(e))).toBe(true);
  });

  it('is tolerant of surrounding whitespace inside the XMP element form', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    doc.setCreator('whitespace');
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    const bom = '\u{FEFF}';
    const packet = `<?xpacket begin="${bom}"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>
    3
      </pdfaid:part>
      <pdfaid:conformance>
    A
      </pdfaid:conformance>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(packet, { Type: 'Metadata', Subtype: 'XML' })),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;
    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.level).toBe('A');
  });

  it('decodes a /FlateDecode-compressed XMP stream', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    doc.setCreator('flate-xmp');
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    // flateStream() writes the content with /Filter /FlateDecode.
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.flateStream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;
    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
  });

  it('accepts an OutputIntent that uses an embedded ICC profile instead of sRGB', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    doc.setCreator('icc-profile');
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    // Build a minimal, syntactically valid ICC header: 128 bytes total,
    // with the ASCII signature `acsp` at offset 36 and the data colour
    // space `RGB ` at offset 16. The full ICC profile that veraPDF
    // round-trips would be ~3 KB; this header is enough for our check.
    const iccBytes = new Uint8Array(128);
    iccBytes.set([0x52, 0x47, 0x42, 0x20], 16); // 'RGB '
    iccBytes.set([0x61, 0x63, 0x73, 0x70], 36); // 'acsp'
    const iccStream = context.register(context.stream(iccBytes, { N: PDFNumber.of(3) }));
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'Custom',
      DestOutputProfile: iccStream,
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;
    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    // Suppress "unused" lints on the ICC stream helper.
    expect(iccStream).toBeDefined();
    expect(PDFRawStream).toBeDefined();
    expect(result.conformant).toBe(true);
  });

  it('rejects a PDF whose header version is not 1.4..1.7', async () => {
    // Build a conformant PDF then rewrite the header to 2.0 in the
    // Buffer before passing to the validator. The Buffer's structural
    // content is still valid PDF; only the header string is swapped.
    const pdf = await buildFixture();
    const tampered = Buffer.from(pdf);
    // '%PDF-2.0' — 8 bytes.
    tampered.write('%PDF-2.0', 0, 'ascii');
    const result = await validatePdfA3(tampered);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => /not in 1\.4\.\.1\.7/.test(e))).toBe(true);
  });

  // --- Font embedding checks ------------------------------------------
  //
  // The validator walks every page's /Resources /Font tree and demands
  // either an embedded /FontFile{,2,3} on the descriptor OR one of the
  // 14 standard Type1 fonts. These tests build the pathological shapes
  // inline on the first page's resources so each case is minimal.

  /**
   * Helper that pins a hand-built font dict into the first page's
   * `/Resources /Font` dictionary under a chosen name, so the fixture
   * is self-contained regardless of what pdf-lib does on save.
   */
  function installFontOnFirstPage(doc: PDFDocument, resourceKey: string, fontDict: PDFDict): void {
    const page = doc.getPages()[0];
    const context = doc.context;
    // page.node.Resources() returns the inherited resource dict (which
    // on a freshly-created page is undefined); ensure one exists and
    // then plant our font under /Font.
    let resources = page.node.Resources();
    if (!resources) {
      resources = context.obj({}) as PDFDict;
      page.node.set(PDFName.of('Resources'), resources);
    }
    const fontsLookup = resources.lookup(PDFName.of('Font'));
    let fonts: PDFDict;
    if (fontsLookup instanceof PDFDict) {
      fonts = fontsLookup;
    } else {
      fonts = context.obj({}) as PDFDict;
      resources.set(PDFName.of('Font'), fonts);
    }
    fonts.set(PDFName.of(resourceKey), fontDict);
  }

  it('rejects a PDF with a font that has no FontDescriptor and is not a standard 14 Type1', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    // A TrueType font with no FontDescriptor; BaseFont is not one of
    // the 14 standard names.
    const badFont = context.obj({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: 'MadeUpDisplayFace',
    });
    installFontOnFirstPage(doc, 'F1', badFont);

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors).toContain('font "MadeUpDisplayFace" is not embedded');
  });

  it('accepts a PDF whose only font is Helvetica without embedding', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    const helvetica = context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
    });
    installFontOnFirstPage(doc, 'F1', helvetica);

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a PDF with a fully embedded TrueType font', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    // Register the embedded-font program stream separately, as a real
    // PDF would, and point /FontFile2 at it by indirect reference.
    const fontFileRef = context.register(
      context.stream(new Uint8Array([0x00, 0x01, 0x00, 0x00]), { Length1: PDFNumber.of(4) }),
    );
    const descriptor = context.obj({
      Type: 'FontDescriptor',
      FontName: 'EmbeddedSans',
      Flags: PDFNumber.of(32),
      FontBBox: [0, 0, 1000, 1000],
      FontFile2: fontFileRef,
    });
    const font = context.obj({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: 'EmbeddedSans',
      FontDescriptor: descriptor,
    });
    installFontOnFirstPage(doc, 'F1', font);

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a composite Type0 font whose descendant carries an embedded /FontFile2', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    const fontFileRef = context.register(
      context.stream(new Uint8Array([0x00, 0x01, 0x00, 0x00]), { Length1: PDFNumber.of(4) }),
    );
    const descriptor = context.obj({
      Type: 'FontDescriptor',
      FontName: 'AAAAAA+NotoSansArabic',
      Flags: PDFNumber.of(32),
      FontBBox: [0, 0, 1000, 1000],
      FontFile2: fontFileRef,
    });
    const descendant = context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'AAAAAA+NotoSansArabic',
      FontDescriptor: descriptor,
    });
    const descendants = PDFArray.withContext(context);
    descendants.push(descendant);
    const type0 = context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'AAAAAA+NotoSansArabic',
      Encoding: 'Identity-H',
      DescendantFonts: descendants,
    });
    installFontOnFirstPage(doc, 'F1', type0);

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a Type3 font without a FontDescriptor (self-embedded via CharProcs)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    // A Type3 font is itself the font program: the character procedures
    // live in /CharProcs streams IN the PDF. The validator accepts it
    // even with no /FontDescriptor, matching veraPDF's reading of
    // ISO 19005-1 § 6.3.7 for Type3.
    const charProcs = context.obj({
      A: context.register(context.stream(Buffer.from('100 0 0 100 0 0 d1\n', 'ascii'))),
    });
    const type3 = context.obj({
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: [0, 0, 1000, 1000],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: charProcs,
    });
    installFontOnFirstPage(doc, 'F1', type3);

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a font whose FontDescriptor has no FontFile/FontFile2/FontFile3 entry', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'sRGB',
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    // Pathological shape: a FontDescriptor is present but carries no
    // embedded font program.
    const descriptor = context.obj({
      Type: 'FontDescriptor',
      FontName: 'NakedDescriptor',
      Flags: PDFNumber.of(32),
      FontBBox: [0, 0, 1000, 1000],
    });
    const font = context.obj({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: 'NakedDescriptor',
      FontDescriptor: descriptor,
    });
    installFontOnFirstPage(doc, 'F1', font);

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors).toContain('font "NakedDescriptor" is not embedded');
  });

  // --- ICC profile integrity checks ----------------------------------

  it('rejects an OutputIntent DestOutputProfile that lacks the acsp signature', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    // A 128-byte stream padded with zeros has no `acsp` signature at
    // offset 36, so the ICC check must reject it.
    const bogusIcc = new Uint8Array(128);
    const iccStream = context.register(context.stream(bogusIcc, { N: PDFNumber.of(3) }));
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'Custom',
      DestOutputProfile: iccStream,
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors).toContain(
      'OutputIntent DestOutputProfile is not a valid ICC profile (missing acsp signature)',
    );
  });

  it('rejects an OutputIntent DestOutputProfile that is shorter than the 128-byte ICC header', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    // 50 bytes — not even enough to hold the ICC header.
    const tinyIcc = new Uint8Array(50);
    const iccStream = context.register(context.stream(tinyIcc, { N: PDFNumber.of(3) }));
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'Custom',
      DestOutputProfile: iccStream,
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(false);
    expect(result.errors.some((e) => /header is shorter than 128 bytes/.test(e))).toBe(true);
  });

  it('accepts a named sRGB OutputIntent (no embedded profile) — ICC check skipped', async () => {
    // The identifier-only sRGB form is the pattern the renderer uses in
    // production; make the skip explicit so a future tightening of the
    // ICC check cannot regress it.
    const pdf = await buildFixture();
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts an OutputIntent DestOutputProfile with a valid acsp signature at offset 36', async () => {
    // Covered by the updated "accepts an embedded ICC profile" case too;
    // this one spells out the single bit that matters and keeps the
    // intent obvious for a future reader.
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const { context, catalog } = { context: doc.context, catalog: doc.catalog };
    catalog.set(
      PDFName.of('Metadata'),
      context.register(context.stream(xmpPacket(), { Type: 'Metadata', Subtype: 'XML' })),
    );
    const iccBytes = new Uint8Array(128);
    iccBytes.set([0x52, 0x47, 0x42, 0x20], 16); // 'RGB '
    iccBytes.set([0x61, 0x63, 0x73, 0x70], 36); // 'acsp'
    const iccStream = context.register(context.stream(iccBytes, { N: PDFNumber.of(3) }));
    const intent = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: 'Custom',
      DestOutputProfile: iccStream,
    });
    const arr = PDFArray.withContext(context);
    arr.push(intent);
    catalog.set(PDFName.of('OutputIntents'), arr);
    const id = PDFHexString.of('CAFEBABEDEADBEEFCAFEBABEDEADBEEF');
    const idArr = PDFArray.withContext(context);
    idArr.push(id);
    idArr.push(id);
    context.trailerInfo.ID = idArr;

    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const result = await validatePdfA3(pdf);
    expect(result.conformant).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
