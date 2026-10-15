// Minimal self-contained PDF writer: embeds page images directly, no external libraries.
// One image per page, sized to fill the page. Supports two embeddings:
//   - JPEG bytes as-is (/Filter /DCTDecode) — smaller files, lossy.
//   - Raw RGB pixel data, deflate-compressed ourselves (/Filter /FlateDecode) — lossless,
//     much larger files. This is not a PNG file; PDF just wants plain deflated component
//     bytes, so a PNG's own container/filtering is skipped entirely — see
//     canvasToLosslessPdfImage() below.
//
// Two size-reduction techniques on top of image quality/format choice:
//   - Identical image streams (same bytes/dims/format — e.g. an accidental duplicate page)
//     are written once and shared across pages instead of embedded again per page.
//   - Callers can pass a smaller pixel-resolution image than the page's physical size would
//     imply (see downsampleCanvasToDpi() in editor.js) — this writer just places whatever
//     pixel data it's given to fill the given wPt/hPt, so a lower-resolution image still
//     fills the same physical page, just with less embedded pixel data.

function sccStrToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

// Extracts a canvas's pixels as raw, tightly-packed RGB (or, in grayscale mode, single-channel
// luma) bytes (alpha dropped — PDF pages are opaque) and deflate-compresses them with the
// browser's built-in CompressionStream, so embedding a "lossless" page needs no PNG/zlib
// library of our own. Grayscale isn't just a visual effect here: since this path stores raw
// uncompressed-per-pixel samples (deflate only squeezes redundancy, not color depth), dropping
// from 3 channels to 1 directly cuts the embedded data size by roughly 3x, on top of whatever
// deflate itself saves.
async function canvasToLosslessPdfImage(canvas, grayscale) {
  const ctx = canvas.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const raw = new Uint8Array(width * height * (grayscale ? 1 : 3));
  let o = 0;
  if (grayscale) {
    for (let i = 0; i < data.length; i += 4) {
      raw[o++] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      raw[o++] = data[i];
      raw[o++] = data[i + 1];
      raw[o++] = data[i + 2];
    }
  }
  const bytes = await deflate(raw);
  return { format: 'png', bytes, widthPx: width, heightPx: height, colorSpace: grayscale ? 'gray' : 'rgb' };
}

// The Canvas API has no grayscale JPEG encoder, so "grayscale" here means desaturating the
// pixels (R=G=B=luma) on a scratch copy before handing them to the normal JPEG encoder — the
// resulting file is still a 3-component JPEG stream (no size win the way the lossless path
// gets one), just visually black-and-white. Draws onto a fresh canvas rather than mutating the
// caller's, since callers may reuse that same canvas elsewhere (previews, other export paths).
async function canvasToLossyPdfImage(canvas, quality, grayscale) {
  let srcCanvas = canvas;
  if (grayscale) {
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = canvas.width;
    srcCanvas.height = canvas.height;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(canvas, 0, 0);
    const imgData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const y = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      data[i] = data[i + 1] = data[i + 2] = y;
    }
    srcCtx.putImageData(imgData, 0, 0);
  }
  const blob = await new Promise((resolve) => srcCanvas.toBlob(resolve, 'image/jpeg', quality / 100));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { format: 'jpeg', bytes, widthPx: canvas.width, heightPx: canvas.height, colorSpace: 'rgb' };
}

// Cheap fingerprint (not cryptographic — just needs to catch exact duplicates without
// hashing every byte of potentially huge streams) used to dedupe identical image streams.
function fingerprintBytes(bytes) {
  let checksum = 0;
  for (let i = 0; i < bytes.length; i += 97) {
    checksum = (checksum * 33 + bytes[i]) >>> 0;
  }
  return `${bytes.length}:${checksum}`;
}

// Encodes a JS string as a sequence of raw 2-byte (UTF-16BE) codes with NO leading BOM — this
// is what a hex string means under a Type0 font with /Encoding /Identity-H: each 2 bytes is a
// character code (= CID, and here also = GID and = Unicode code point — see GLYPHLESS FONT
// below), not a PDF text-string literal, so no BOM marker belongs here.
function pdfIdentityHexString(str) {
  let hex = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const c = code - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      hex += hi.toString(16).padStart(4, '0') + lo.toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return hex.toUpperCase();
}

// --- Invisible OCR text layer: a real "glyphless" CID font, not an ActualText hack ---------
//
// Earlier versions of this drew one visible-but-invisible (Tr 3) Helvetica placeholder glyph
// per word/line and relied on PDF's /ActualText marked-content mechanism to substitute the
// real recognized text at copy/extract time — needed because Helvetica has no way to encode
// arbitrary Unicode (Japanese especially) as character codes. That mostly worked for COPYING
// text, but PDF viewers generally treat an ActualText span as one atomic, indivisible
// selection unit: clicking anywhere inside one only ever selected the whole span from its
// start, with no way to stop or start mid-span. That's the "selection only grabs the first
// character" symptom.
//
// The actual fix is to stop faking it. Tesseract's OWN built-in PDF renderer (its WASM core
// exposes TessPDFRenderer, which tesseract.js's `recognize(..., {pdf:true})` option calls
// into) embeds a tiny custom TrueType font it calls "GlyphLessFont" for exactly this purpose,
// and constructs a real Identity-H CID font around it — inspecting its actual output PDF is
// where this approach (and the exact font bytes below) come from. The trick:
//   - The font has exactly one real glyph outline: an empty one. /CIDToGIDMap maps every
//     possible CID (0x0000-0xFFFF) to that same one glyph, so there's nothing to embed per
//     character — Tr 3 (invisible render mode) means it's never painted anyway.
//   - /Encoding /Identity-H means each 2-byte code in a Tj/TJ hex string IS the CID directly
//     (no separate encoding table to build).
//   - /ToUnicode is the identity mapping (every code maps to the same Unicode value) — so we
//     can just use each character's own UTF-16BE code unit AS its CID, and text
//     extraction/search/copy recovers the exact original Unicode text with no lookup tables.
// Net effect: normal PDF text objects, normal per-character glyph positions, so ordinary
// (non-atomic) text selection/extraction applies — the same as it would for any other PDF's
// real text layer — while still never painting anything visible over the page image.
const GLYPHLESS_FONT_BASE64 =
  'AAEAAAAKAIAAAwAgT1MvMlbeyJQAAAEoAAAAYGNtYXAACgA0AAABkAAAAB5nbHlmFSJBJAAAAbgAAAAY' +
  'aGVhZAt48WUAAACsAAAANmhoZWEMAgQCAAAA5AAAACRobXR4BAAAAAAAAYgAAAAIbG9jYQAMAAAAAAGw' +
  'AAAABm1heHAABAAFAAABCAAAACBuYW1l8usW2gAAAdAAAABLcG9zdAABAAEAAAIcAAAAIAABAAAAAQAA' +
  'sJRxEF8PPPUEBwgAAAAAAM+a/G4AAAAA1MOn8gAAAAAEAAgAAAAAEAACAAAAAAAAAAEAAAgA//8AAAQA' +
  'AAAAAAQAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAwAA' +
  'AZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAR09PRwBA' +
  'AAAAAAAB//8AAAABAAGAAAAAAAAAAAAAAAAAAAABAAAAAAAABAAAAAAAAAIAAQAAAAAAFAADAAAAAAAU' +
  'AAYACgAAAAAAAAAAAAAAAAAMAAAAAQAAAAAEAAgAAAMAADEhESEEAPwACAAAAAADACoAAAADAAAABQAW' +
  'AAAAAQAAAAAABQALABYAAwABBAkABQAWAAAAVgBlAHIAcwBpAG8AbgAgADEALgAwVmVyc2lvbiAxLjAA' +
  'AAEAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=';

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Every one of the 65536 possible 2-byte CIDs maps to GID 1 (the font's one, empty glyph) —
// see the big comment above. Compressed before embedding since the raw table is a very
// repetitive 128KB (deflate shrinks it to a tiny fraction of that).
async function buildCidToGidMapDeflated() {
  const bytes = new Uint8Array(65536 * 2);
  for (let i = 0; i < 65536; i++) {
    bytes[i * 2] = 0x00;
    bytes[i * 2 + 1] = 0x01;
  }
  return deflate(bytes);
}

// Static identity CMap program: maps every code in the codespace to itself, so text
// extraction recovers each character's own UTF-16BE code unit unchanged.
const TOUNICODE_IDENTITY_CMAP = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
<<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;

// Builds the invisible-text content-stream fragment for one OCR'd LINE: a normal (not
// marked-content-wrapped) text object using the glyphless CID font, one Tj call showing the
// whole line's text at once. Deliberately does NOT try to position each recognized word at
// its own individually-measured bbox — that was tried, and text EXTRACTION turned out to key
// off actual rendered inter-glyph gaps rather than "is this a separate PDF text-showing
// operation": Tesseract's own per-word bboxes for Japanese (it commonly recognizes each
// kanji/kana as a separate "word", having no real inter-word-space signal to key off for
// scripts that don't use spaces) always have a little natural padding around each detected
// glyph, which reads as a "word gap" to threshold-based extractors even though it's just
// normal letter-spacing — so trying to honor those exact positions kept producing spurious
// spaces in copied text. Using uniform, purely font-driven spacing for the whole line (real
// space characters only where line.text — see ocr.js's buildLineText — actually has one)
// sidesteps that ambiguity entirely: there's no irregular gap for an extractor to second-guess.
//
// Every character is still its own real CID glyph in the font (not one glyph stretched over
// everything), so ordinary per-character selection hit-testing works the same as it would for
// any other PDF's real text layer — that part was fixed by switching off ActualText/Helvetica
// entirely (see the big comment near GLYPHLESS_FONT_BASE64 above), independent of this.
//
// /DW (default glyph width) is uniform for every character, so — same as Tesseract's own PDF
// renderer — one horizontal scale (Tz) approximates the whole line's overall measured width
// instead of relying on individual character metrics.
function lineTextOps(line) {
  if (!line.text || line.wPt <= 0 || line.hPt <= 0) return '';
  const fontSize = Math.max(0.1, line.hPt);
  const defaultGlyphWidthEm = 0.5; // /DW 500 in 1000-unit em space
  const charCount = Math.max(1, line.text.length);
  const estimatedWidth = Math.max(0.01, fontSize * defaultGlyphWidthEm * charCount);
  const tz = Math.min(1000, Math.max(1, (line.wPt / estimatedWidth) * 100));
  const hex = pdfIdentityHexString(line.text);
  return (
    `BT\n3 Tr\n/F1 ${fontSize.toFixed(2)} Tf\n${tz.toFixed(2)} Tz\n` +
    `1 0 0 1 ${line.xPt.toFixed(2)} ${line.yPt.toFixed(2)} Tm\n<${hex}> Tj\nET\n`
  );
}

// pages: [{ format: 'jpeg'|'png', bytes, widthPx, heightPx, wPt, hPt, imgXPt?, imgYPt?,
//           imgWPt?, imgHPt?, words? }]
// wPt/hPt are the PAGE's physical size (MediaBox) in PDF points — independent of
// widthPx/heightPx, so a downsampled image can still fill the page's originally-intended
// physical size. imgXPt/imgYPt/imgWPt/imgHPt (all optional, default to filling the whole
// page at 0,0) instead describe where/how big to draw the image WITHIN that page — used for
// a fixed paper size (e.g. A4) that doesn't match the image's own aspect ratio, fit-and-
// centered rather than stretched.
// words (optional): [{ text, xPt, yPt, wPt, hPt }] one entry per recognized LINE, already
// positioned in PDF point space (origin bottom-left, y-up) — an invisible, selectable/
// searchable OCR text layer using a real embedded CID font (see above), so ordinary
// character-level PDF text selection/extraction applies.
// onProgress(done, total), if given, is called periodically during the per-page write loop
// below. That loop is the only part of this function whose cost scales with book length (one
// full-resolution image's worth of bytes pushed per page), so it is also the only place that
// yields back to the event loop — without that, writing a long book's pages was one unbroken
// synchronous call that blocked the whole tab (no repaint, no status update) until it finished,
// which looked indistinguishable from the export having silently died.
async function buildPdfFromImages(pages, onProgress) {
  const chunks = [];
  let offset = 0;
  const offsets = {};
  let nextObjNum = 0;

  function push(bytes) {
    chunks.push(bytes);
    offset += bytes.length;
  }
  function pushStr(str) {
    push(sccStrToBytes(str));
  }
  function allocObj() {
    return ++nextObjNum;
  }
  function beginObj(num) {
    offsets[num] = offset;
    pushStr(`${num} 0 obj\n`);
  }
  function endObj() {
    pushStr('endobj\n');
  }

  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const catalogObjNum = allocObj();
  const pagesObjNum = allocObj();
  const numPages = pages.length;
  const hasAnyText = pages.some((p) => p.words && p.words.length);

  // The glyphless CID font is a whole small object graph (Type0 font, CIDFont, descriptor,
  // embedded font file, CIDToGIDMap stream, ToUnicode CMap stream) allocated ONCE and shared
  // across every page that has OCR text, same spirit as image dedup above.
  let fontObjNum = null;
  let cidFontObjNum = null;
  let fontDescObjNum = null;
  let fontFileObjNum = null;
  let cidToGidMapObjNum = null;
  let toUnicodeObjNum = null;
  let cidToGidMapBytes = null;
  if (hasAnyText) {
    fontObjNum = allocObj();
    cidFontObjNum = allocObj();
    fontDescObjNum = allocObj();
    fontFileObjNum = allocObj();
    cidToGidMapObjNum = allocObj();
    toUnicodeObjNum = allocObj();
    cidToGidMapBytes = await buildCidToGidMapDeflated();
  }

  // Assign object numbers up front (page + content per page, image deduped by content) so
  // page objects can reference their image/content before those are actually written.
  const imageCache = new Map(); // fingerprint -> objNum
  const pageInfos = pages.map((page) => {
    const pageObjNum = allocObj();
    const contentObjNum = allocObj();
    const key = `${page.format}:${page.colorSpace || 'rgb'}:${page.widthPx}x${page.heightPx}:${fingerprintBytes(page.bytes)}`;
    let imgObjNum = imageCache.get(key);
    const isNewImage = imgObjNum == null;
    if (isNewImage) {
      imgObjNum = allocObj();
      imageCache.set(key, imgObjNum);
    }
    return { page, pageObjNum, contentObjNum, imgObjNum, isNewImage };
  });

  beginObj(catalogObjNum);
  pushStr(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>\n`);
  endObj();

  beginObj(pagesObjNum);
  const kids = pageInfos.map((info) => `${info.pageObjNum} 0 R`).join(' ');
  pushStr(`<< /Type /Pages /Kids [ ${kids} ] /Count ${numPages} >>\n`);
  endObj();

  if (fontObjNum) {
    beginObj(fontObjNum);
    pushStr(
      `<< /Type /Font /Subtype /Type0 /BaseFont /GlyphLessFont /Encoding /Identity-H ` +
        `/DescendantFonts [ ${cidFontObjNum} 0 R ] /ToUnicode ${toUnicodeObjNum} 0 R >>\n`
    );
    endObj();

    beginObj(cidFontObjNum);
    pushStr(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GlyphLessFont ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${fontDescObjNum} 0 R /DW 500 /CIDToGIDMap ${cidToGidMapObjNum} 0 R >>\n`
    );
    endObj();

    beginObj(fontDescObjNum);
    pushStr(
      `<< /Type /FontDescriptor /FontName /GlyphLessFont /Flags 5 /FontBBox [0 0 500 1000] ` +
        `/ItalicAngle 0 /Ascent 1000 /Descent -1 /CapHeight 1000 /StemV 80 ` +
        `/FontFile2 ${fontFileObjNum} 0 R >>\n`
    );
    endObj();

    const fontFileBytes = base64ToBytes(GLYPHLESS_FONT_BASE64);
    beginObj(fontFileObjNum);
    pushStr(`<< /Length ${fontFileBytes.length} /Length1 ${fontFileBytes.length} >>\nstream\n`);
    push(fontFileBytes);
    pushStr('\nendstream\n');
    endObj();

    beginObj(cidToGidMapObjNum);
    pushStr(`<< /Length ${cidToGidMapBytes.length} /Filter /FlateDecode >>\nstream\n`);
    push(cidToGidMapBytes);
    pushStr('\nendstream\n');
    endObj();

    const toUnicodeBytes = sccStrToBytes(TOUNICODE_IDENTITY_CMAP);
    beginObj(toUnicodeObjNum);
    pushStr(`<< /Length ${toUnicodeBytes.length} >>\nstream\n`);
    push(toUnicodeBytes);
    pushStr('\nendstream\n');
    endObj();
  }

  for (let pageIdx = 0; pageIdx < pageInfos.length; pageIdx++) {
    const info = pageInfos[pageIdx];
    const { page, pageObjNum, contentObjNum, imgObjNum, isNewImage } = info;
    const wPt = page.wPt;
    const hPt = page.hPt;
    // Where/how big to actually draw the image within the page — defaults to filling the
    // whole page (the original behavior, when the page size itself was always derived
    // directly from the image). When the caller picked a fixed paper size independent of the
    // image's own aspect ratio, these instead describe a fit-and-center placement.
    const imgXPt = page.imgXPt || 0;
    const imgYPt = page.imgYPt || 0;
    const imgWPt = page.imgWPt != null ? page.imgWPt : wPt;
    const imgHPt = page.imgHPt != null ? page.imgHPt : hPt;
    const words = page.words;
    const resourceParts = [`/XObject << /Im0 ${imgObjNum} 0 R >>`, '/ProcSet [/PDF /ImageC /Text]'];
    if (words && words.length && fontObjNum) resourceParts.push(`/Font << /F1 ${fontObjNum} 0 R >>`);

    beginObj(pageObjNum);
    pushStr(
      `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] ` +
        `/Resources << ${resourceParts.join(' ')} >> /Contents ${contentObjNum} 0 R >>\n`
    );
    endObj();

    let contentStr = `q\n${imgWPt.toFixed(2)} 0 0 ${imgHPt.toFixed(2)} ${imgXPt.toFixed(2)} ${imgYPt.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    if (words && words.length && fontObjNum) {
      for (const line of words) {
        contentStr += lineTextOps(line);
      }
    }
    const contentBytes = sccStrToBytes(contentStr);
    beginObj(contentObjNum);
    pushStr(`<< /Length ${contentBytes.length} >>\nstream\n`);
    push(contentBytes);
    pushStr('\nendstream\n');
    endObj();

    if (isNewImage) {
      const filter = page.format === 'png' ? 'FlateDecode' : 'DCTDecode';
      const colorSpace = page.colorSpace === 'gray' ? '/DeviceGray' : '/DeviceRGB';
      beginObj(imgObjNum);
      pushStr(
        `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} ` +
          `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /${filter} /Length ${page.bytes.length} >>\nstream\n`
      );
      push(page.bytes);
      pushStr('\nendstream\n');
      endObj();
    }

    if (pageIdx % 10 === 9 || pageIdx === pageInfos.length - 1) {
      if (onProgress) onProgress(pageIdx + 1, pageInfos.length);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  const totalObjNum = nextObjNum;
  const xrefStart = offset;
  let xref = `xref\n0 ${totalObjNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjNum; n++) {
    const off = offsets[n] !== undefined ? offsets[n] : 0;
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pushStr(xref);
  pushStr(`trailer\n<< /Size ${totalObjNum + 1} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return new Blob([out], { type: 'application/pdf' });
}
