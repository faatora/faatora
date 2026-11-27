/**
 * PDF/A-3 conformance validator.
 *
 * Takes the raw bytes of a rendered PDF and reports whether it meets
 * the structural requirements of ISO 19005-3. The checks here are the
 * practical minimum the OTA archive use case needs; a full veraPDF run
 * still catches more (transparency groups, colour spaces per content
 * stream, font glyph coverage), so the renderer and its caller should
 * continue to treat this as the first, programmatic gate and keep the
 * veraPDF sidecar as a belt-and-braces check for the production path.
 *
 * Validator invariants (each failure is appended to `errors`):
 *
 *   1. PDF header is `%PDF-1.4`..`%PDF-1.7`. PDF/A-3 is based on PDF 1.7;
 *      anything from 1.4 through 1.7 is accepted because most writers in
 *      the wild still emit the older versions. PDF 2.0+ is rejected.
 *   2. The trailer carries an `/ID` entry. PDF/A requires one so that
 *      downstream signers and archive indexers have a stable document
 *      identifier.
 *   3. The Document Catalog has a `/Metadata` entry pointing to an XMP
 *      stream.
 *   4. The XMP stream declares the `pdfaid` namespace
 *      (`http://www.aiim.org/pdfa/ns/id/`) with:
 *        - `pdfaid:part   = 3`
 *        - `pdfaid:conformance ∈ {A, B, U}` (the found level is reported).
 *   5. At least one `/OutputIntents` entry exists with `/S = GTS_PDFA1`
 *      and either `/OutputConditionIdentifier` containing `sRGB`
 *      (case-insensitive) or a `/DestOutputProfile` ICC stream.
 *   6. When the PDF contains an `/Names /EmbeddedFiles` tree (the
 *      ZUGFeRD / Factur-X attachment pattern that the OTA archive relies
 *      on), the Catalog must also carry an `/AF` associated-files array,
 *      and every filespec dictionary inside the embedded-files tree must
 *      declare `/AFRelationship` ∈ {Source, Data, Alternative,
 *      Supplement, Unspecified}. This is the specifically PDF/A-3
 *      requirement that distinguishes it from PDF/A-2.
 *
 * Deliberately NOT checked here (see README for the follow-up list):
 *   - Per-font embedding / subsetting. Chromium's print pipeline already
 *     embeds subsetted fonts, but asserting that at this depth requires
 *     walking every page's /Resources /Font tree. A regression there is
 *     caught by veraPDF; we accept the gap in the interest of a fast,
 *     dependency-free Node check.
 *   - Transparency groups, colour spaces per content stream, and
 *     ActualText coverage. These are PDF/A-2 concerns that veraPDF
 *     validates thoroughly.
 *
 * The validator is `async` because pdf-lib's `PDFDocument.load` yields
 * between object batches (`objectsPerTick`). It still resolves in a
 * single micro-tick for the in-memory buffers callers actually pass, so
 * the cost is a cheap `await` on the renderer's existing promise chain.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

/** Conformance level recorded on the output. */
export type PdfA3ConformanceLevel = 'A' | 'B' | 'U';

/** Result of a {@link validatePdfA3} run. */
export interface PdfA3ValidationResult {
  /** True IFF every check in the module docstring passed. */
  conformant: boolean;
  /** Level found on the `pdfaid:conformance` tag, or `null` when absent. */
  level: PdfA3ConformanceLevel | null;
  /** Human-readable explanation per failed check. Empty when conformant. */
  errors: ReadonlyArray<string>;
}

/** Valid values for the `/AFRelationship` key per ISO 19005-3 § 6.8.1. */
const AF_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'Source',
  'Data',
  'Alternative',
  'Supplement',
  'Unspecified',
]);

/** Accepted PDF header strings. PDF/A-3 is 1.7 but we accept 1.4..1.7. */
const ACCEPTED_HEADERS: ReadonlyArray<string> = ['%PDF-1.4', '%PDF-1.5', '%PDF-1.6', '%PDF-1.7'];

/**
 * Read the first non-empty bytes of `pdfBytes` as ASCII and return them
 * as a short header string. Returns `null` if the buffer is too small
 * or does not start with `%PDF-`.
 */
function readPdfHeader(pdfBytes: Buffer): string | null {
  if (pdfBytes.length < 8) {
    return null;
  }
  // Header is always at the start; the spec allows up to 1024 bytes of
  // preamble for self-executing wrappers but we do not support those.
  const head = pdfBytes.subarray(0, 8).toString('ascii');
  if (!head.startsWith('%PDF-')) {
    return null;
  }
  return head;
}

/**
 * Pull the raw bytes out of a Metadata stream regardless of whether it
 * was written uncompressed or with /FlateDecode. Returns `null` when
 * the object is not a stream (e.g. an indirect reference pointing at a
 * non-stream, which is itself a conformance failure).
 */
function readStreamBytes(stream: PDFObject): Uint8Array | null {
  if (stream instanceof PDFRawStream) {
    // Follow /Filter chain through pdf-lib's decoder. When the stream is
    // not actually encoded (no /Filter) the decoder is a no-op.
    try {
      return decodePDFRawStream(stream).decode();
    } catch {
      // Some writers emit a stream with a /Filter entry that pdf-lib's
      // decoder can't handle (e.g. unknown filter). Fall back to the raw
      // bytes so regex matches on the plaintext `pdfaid` tag still work
      // when the stream was written uncompressed.
      return stream.getContents();
    }
  }
  if (stream instanceof PDFStream) {
    // Non-raw stream (e.g. content stream). getContents() returns the
    // already-encoded bytes which is fine for text scanning but may not
    // be flate-decoded.
    return stream.getContents();
  }
  return null;
}

/** XMP packet parsing — regex-based, deliberately tolerant of formatting. */
interface XmpPdfaId {
  part?: string;
  conformance?: string;
}

/**
 * Pull `pdfaid:part` and `pdfaid:conformance` from an XMP packet.
 * Accepts both the attribute form (`pdfaid:part="3"` on an rdf:Description)
 * and the element form (`<pdfaid:part>3</pdfaid:part>`). Also accepts
 * the leading-whitespace variants Chromium's XMP exporter is fond of.
 */
function parseXmpPdfaId(xmp: string): XmpPdfaId {
  const result: XmpPdfaId = {};

  // Element form first: `<pdfaid:part>3</pdfaid:part>`
  const partElement = /<pdfaid:part[^>]*>\s*([^<\s]+)\s*<\/pdfaid:part>/i.exec(xmp);
  const confElement = /<pdfaid:conformance[^>]*>\s*([^<\s]+)\s*<\/pdfaid:conformance>/i.exec(xmp);
  if (partElement) {
    result.part = partElement[1];
  }
  if (confElement) {
    result.conformance = confElement[1];
  }

  // Attribute form: `pdfaid:part="3"` — common for compact XMP packets.
  if (result.part === undefined) {
    const partAttr = /pdfaid:part\s*=\s*["']([^"']+)["']/i.exec(xmp);
    if (partAttr) {
      result.part = partAttr[1];
    }
  }
  if (result.conformance === undefined) {
    const confAttr = /pdfaid:conformance\s*=\s*["']([^"']+)["']/i.exec(xmp);
    if (confAttr) {
      result.conformance = confAttr[1];
    }
  }

  return result;
}

/**
 * Walk a Name-tree (§ 7.9.6) in flat `[name, value, name, value, ...]`
 * Names arrays and in nested /Kids trees, yielding each value. The
 * EmbeddedFiles tree uses this shape to map filenames to filespec dicts.
 */
function* walkNameTree(node: PDFDict): Generator<PDFObject> {
  const names = node.lookup(PDFName.of('Names'));
  if (names instanceof PDFArray) {
    // Flat [name0, val0, name1, val1, ...] array — yield every value.
    for (let i = 1; i < names.size(); i += 2) {
      const val = names.lookup(i);
      if (val !== undefined) {
        yield val;
      }
    }
  }
  const kids = node.lookup(PDFName.of('Kids'));
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i);
      if (kid instanceof PDFDict) {
        yield* walkNameTree(kid);
      }
    }
  }
}

/**
 * Validate `pdfBytes` against the PDF/A-3 checks listed in the module
 * docstring. Returns a result object; never throws for well-formed PDF
 * input. A pathologically malformed buffer (e.g. one byte long, or not
 * a PDF at all) returns `conformant: false` with an explanatory error.
 */
export async function validatePdfA3(pdfBytes: Buffer): Promise<PdfA3ValidationResult> {
  const errors: string[] = [];
  let level: PdfA3ConformanceLevel | null = null;

  // Check 1 — PDF header.
  const header = readPdfHeader(pdfBytes);
  if (header === null) {
    errors.push('missing PDF header');
    // No point continuing without a parseable PDF.
    return { conformant: false, level: null, errors };
  }
  const headerVersion = ACCEPTED_HEADERS.find((h) => header.startsWith(h));
  if (headerVersion === undefined) {
    errors.push(`PDF header version not in 1.4..1.7 (found ${JSON.stringify(header.slice(0, 8))})`);
  }

  // Parse the document. pdf-lib throws on fundamentally broken input,
  // which we surface as a conformance failure rather than propagating.
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { throwOnInvalidObject: false });
  } catch (err) {
    errors.push(`failed to parse PDF structure: ${(err as Error).message}`);
    return { conformant: false, level: null, errors };
  }

  const catalog = doc.catalog;
  const context = doc.context;

  // Check 2 — trailer /ID entry.
  const idEntry = context.trailerInfo.ID;
  if (!idEntry) {
    errors.push('trailer is missing /ID entry');
  }

  // Check 3 — Catalog /Metadata XMP stream.
  const metadataObj = catalog.lookup(PDFName.of('Metadata'));
  let xmpText: string | null = null;
  if (!metadataObj) {
    errors.push('Catalog is missing /Metadata entry');
  } else {
    const bytes = readStreamBytes(metadataObj);
    if (!bytes) {
      errors.push('Catalog /Metadata entry does not resolve to a stream');
    } else {
      xmpText = Buffer.from(bytes).toString('utf-8');
    }
  }

  // Check 4 — pdfaid namespace in the XMP.
  if (xmpText !== null) {
    if (!xmpText.includes('http://www.aiim.org/pdfa/ns/id/')) {
      errors.push('XMP metadata does not declare the pdfaid namespace');
    }
    const pdfaId = parseXmpPdfaId(xmpText);
    if (pdfaId.part === undefined) {
      errors.push('XMP metadata is missing pdfaid:part');
    } else if (pdfaId.part !== '3') {
      errors.push(`XMP pdfaid:part is ${pdfaId.part}, expected 3`);
    }
    if (pdfaId.conformance === undefined) {
      errors.push('XMP metadata is missing pdfaid:conformance');
    } else if (!['A', 'B', 'U'].includes(pdfaId.conformance)) {
      errors.push(`XMP pdfaid:conformance is ${pdfaId.conformance}, expected one of A, B, U`);
    } else {
      level = pdfaId.conformance as PdfA3ConformanceLevel;
    }
  }

  // Check 5 — Catalog /OutputIntents with GTS_PDFA1 + sRGB or ICC.
  const outputIntents = catalog.lookup(PDFName.of('OutputIntents'));
  if (!(outputIntents instanceof PDFArray) || outputIntents.size() === 0) {
    errors.push('Catalog is missing /OutputIntents array');
  } else {
    let haveGtsPdfA1 = false;
    for (let i = 0; i < outputIntents.size(); i++) {
      const intent = outputIntents.lookup(i, PDFDict);
      const subtype = intent.lookup(PDFName.of('S'));
      // Subtype is a /Name — pdf-lib's toString() returns `/GTS_PDFA1`.
      const subtypeStr = subtype?.toString();
      if (subtypeStr !== '/GTS_PDFA1') {
        continue;
      }
      haveGtsPdfA1 = true;

      const ociRaw = intent.lookup(PDFName.of('OutputConditionIdentifier'));
      let oci: string | null = null;
      if (ociRaw instanceof PDFString || ociRaw instanceof PDFHexString) {
        oci = ociRaw.decodeText();
      } else if (ociRaw instanceof PDFName) {
        // Some writers (including pdf-lib when the literal is built via
        // context.obj) emit the identifier as a /Name rather than the
        // PDFString the spec calls for. Accept both — veraPDF does too,
        // and either form still conveys "this device is sRGB".
        oci = ociRaw.toString().replace(/^\//, '');
      }

      const destProfile = intent.lookup(PDFName.of('DestOutputProfile'));
      const haveSRgb = oci !== null && /sRGB/i.test(oci);
      const haveIccStream = destProfile instanceof PDFStream;

      if (!haveSRgb && !haveIccStream) {
        errors.push(
          '/OutputIntents entry with S=GTS_PDFA1 must declare an sRGB /OutputConditionIdentifier or a /DestOutputProfile ICC stream',
        );
      }
    }
    if (!haveGtsPdfA1) {
      errors.push('/OutputIntents has no entry with S=GTS_PDFA1');
    }
  }

  // Check 6 — /AF + /AFRelationship on embedded files.
  const namesRoot = catalog.lookup(PDFName.of('Names'));
  if (namesRoot instanceof PDFDict) {
    const embeddedFiles = namesRoot.lookup(PDFName.of('EmbeddedFiles'));
    if (embeddedFiles instanceof PDFDict) {
      // At least one embedded file present; Catalog /AF must exist.
      const afArray = catalog.lookup(PDFName.of('AF'));
      if (!(afArray instanceof PDFArray)) {
        errors.push('Catalog has embedded files but no /AF associated-files array');
      }

      let index = 0;
      for (const node of walkNameTree(embeddedFiles)) {
        if (!(node instanceof PDFDict)) {
          index++;
          continue;
        }
        const rel = node.lookup(PDFName.of('AFRelationship'));
        const relName = rel?.toString();
        if (!relName) {
          errors.push(`EmbeddedFiles entry #${index} filespec has no /AFRelationship`);
        } else {
          // PDFName.toString() returns a leading slash, e.g. "/Source".
          const relValue = relName.replace(/^\//, '');
          if (!AF_RELATIONSHIPS.has(relValue)) {
            errors.push(
              `EmbeddedFiles entry #${index} has invalid /AFRelationship ${JSON.stringify(relValue)}`,
            );
          }
        }
        index++;
      }
    }
  }

  return {
    conformant: errors.length === 0,
    level,
    errors,
  };
}
