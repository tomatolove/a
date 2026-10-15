// Thin wrapper around the vendored tesseract.js (see vendor/tesseract/) for embedding a
// selectable/searchable text layer into exported PDFs. Runs entirely locally (no CDN, no
// network) — MV3's CSP forbids remotely-hosted code, so the worker script, wasm core, and
// per-language trained data all ship inside the extension.
//
// OCR runs once, at export time, and the recognized words are baked into the PDF as an
// invisible text layer (see pdf-writer.js). That's the whole point: viewers never have to
// re-extract text from the page image themselves.
//
// Two things make this fast enough for a whole book instead of painfully slow:
//   - A scheduler with several worker threads (real OS threads — Web Workers), so multiple
//     pages recognize concurrently instead of one page fully finishing before the next
//     starts. tesseract.js's scheduler queues jobs and hands each to whichever worker is
//     free, so callers can just fire off every page's OCR job at once (see ocrCanvasLines
//     callers in editor.js) and let it saturate the workers on its own.
//   - Recognition time scales heavily with pixel count, and these are full-DPI screenshots
//     (often much higher resolution than OCR needs). Downscaling the image handed to
//     Tesseract to a sane cap before recognizing cuts recognition time with only a small
//     accuracy cost, since the source is a screen capture (not a noisy scan) to begin with.
//
// The trained data in vendor/tesseract/lang-data/ is Tesseract's STANDARD (not "_fast") LSTM
// model — the fast variant is noticeably less accurate (it's tuned for embedded/low-resource
// use, not quality) and gave poor results here. Standard is a large step up in accuracy for a
// several-times-larger download, which is an acceptable trade for a one-time bundled asset.

const OCR_MAX_DIMENSION = 3000; // px — cap on the longer side of the image handed to Tesseract
const OCR_WORKER_COUNT = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4));

let ocrSchedulerPromise = null;
let ocrSchedulerLang = null;

function ocrVendorUrl(path) {
  return chrome.runtime.getURL(`vendor/tesseract/${path}`);
}

function createOcrWorker(lang) {
  return Tesseract.createWorker(lang, 1, {
    workerPath: ocrVendorUrl('worker.min.js'),
    corePath: ocrVendorUrl('tesseract-core-simd-lstm.wasm.js'),
    langPath: ocrVendorUrl('lang-data'),
    workerBlobURL: false, // avoids needing 'blob:' in the extension's worker-src CSP
    gzip: true,
    cacheMethod: 'none'
  });
}

async function getOcrScheduler(lang) {
  if (ocrSchedulerPromise && ocrSchedulerLang === lang) return ocrSchedulerPromise;
  if (ocrSchedulerPromise) {
    const prevPromise = ocrSchedulerPromise;
    ocrSchedulerPromise = null;
    try {
      const prev = await prevPromise;
      await prev.terminate();
    } catch (_e) {
      // ignore — scheduler/workers may already be gone
    }
  }
  ocrSchedulerLang = lang;
  ocrSchedulerPromise = (async () => {
    const scheduler = Tesseract.createScheduler();
    const workers = await Promise.all(
      Array.from({ length: OCR_WORKER_COUNT }, () => createOcrWorker(lang))
    );
    workers.forEach((w) => scheduler.addWorker(w));
    return scheduler;
  })();
  return ocrSchedulerPromise;
}

// Never upscales (small/already-small images are returned as-is) — only shrinks images whose
// longer side exceeds the cap, preserving aspect ratio.
function downsampleForOcr(canvas) {
  const longSide = Math.max(canvas.width, canvas.height);
  if (longSide <= OCR_MAX_DIMENSION) return { canvas, scale: 1 };
  const scale = OCR_MAX_DIMENSION / longSide;
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.round(canvas.width * scale));
  tmp.height = Math.max(1, Math.round(canvas.height * scale));
  tmp.getContext('2d').drawImage(canvas, 0, 0, tmp.width, tmp.height);
  return { canvas: tmp, scale };
}

// Returns LINE-level entries — { text, x0, y0, x1, y1 } — in the SOURCE canvas's own pixel
// coordinate space (top-left origin, y-down), regardless of whatever internal resolution was
// actually recognized at. Safe to call for many pages without awaiting each one individually:
// the scheduler queues jobs across its worker pool.
//
// Getting a clean invisible text layer out of this took a few tries, each fixing a different
// real symptom:
//   1. Originally routed text through PDF's /ActualText marked-content mechanism (an
//      invisible placeholder glyph carrying a separately-specified "real" string), needed
//      because the placeholder used Helvetica, which can't encode arbitrary Unicode. PDF
//      viewers generally treat an ActualText span as one atomic, indivisible selection unit,
//      so clicking anywhere inside one only ever selected the whole thing from the start.
//   2. Switched to a real embedded "glyphless" CID font (see pdf-writer.js) so each Unicode
//      character IS the character code — no marked-content trickery, ordinary PDF text
//      objects. Tried positioning each recognized WORD at its own real bbox (individually, or
//      via per-segment kerning adjustments within one text-showing run) — but text
//      EXTRACTION turned out to key off actual rendered inter-glyph gaps, not "is this a
//      separate PDF object": Tesseract's own per-character bboxes for Japanese (it commonly
//      recognizes each kanji/kana as a separate "word", having no real inter-word-space
//      signal to key off for scripts that don't use spaces) always have a little natural
//      padding around each detected glyph, which reads as "word gap" to a threshold-based
//      extractor even though it's just normal letter-spacing.
//   3. Even with that, real-world (lower-quality/compressed) source images still produced
//      stray spaces sometimes — traced (by testing actual copy/paste in real headless Chrome,
//      not just structural PDF checks) to Chrome's PDF viewer inserting a space between two
//      SEPARATE text-showing objects once the gap between them exceeds a small threshold
//      (roughly 30% of the character's own width, in testing). Tesseract's own "line"
//      detection — not just its word detection — can fragment a single visual row of Japanese
//      text into multiple separate "line" objects when the source is noisier (no reliable
//      inter-word-space signal to key off, same root problem as word-fragmentation), and each
//      fragment was getting its own separate text object at its own slightly-gapped position.
// The fix used now: don't trust Tesseract's line grouping for row structure either. Pool every
// word in a paragraph together and re-cluster them into rows ourselves by actual vertical
// (Y-range) overlap — genuine separate lines of text have little to no Y overlap, while a
// same-row fragment (mis-split "line") overlaps almost completely — then build ONE merged
// text run per row regardless of how many Tesseract "line" objects it came from. Combined with
// uniform, font-driven spacing within that run (no artificial gaps for an extractor to
// misjudge) and a real space character between words only for scripts that actually use
// inter-word spaces in writing (not Japanese) — see buildLineText and clusterWordsIntoRows
// below, and lineTextOps in pdf-writer.js. Every character is still its own real CID glyph
// (not one placeholder stretched over everything), so ordinary per-character selection
// hit-testing works the same as any other PDF text layer.
function buildLineText(words, lang) {
  const noInterWordSpace = lang === 'jpn' || lang === 'jpn_vert';
  return words.map((w) => w.text).join(noInterWordSpace ? '' : ' ');
}

// words: [{ text, x0, y0, x1, y1 }], any order. Groups them into top-to-bottom rows by Y-range
// overlap (>50% of the shorter box's height counts as "the same row"), each row's words
// sorted left-to-right — reconstructing reading order without relying on Tesseract's own line
// boundaries, which are exactly what's unreliable here.
function clusterWordsIntoRows(words) {
  const rows = [];
  for (const w of words) {
    let row = rows.find((r) => {
      const overlap = Math.min(r.y1, w.y1) - Math.max(r.y0, w.y0);
      const minHeight = Math.min(r.y1 - r.y0, w.y1 - w.y0);
      return minHeight > 0 && overlap > minHeight * 0.5;
    });
    if (!row) {
      row = { y0: w.y0, y1: w.y1, words: [] };
      rows.push(row);
    }
    row.words.push(w);
    row.y0 = Math.min(row.y0, w.y0);
    row.y1 = Math.max(row.y1, w.y1);
  }
  rows.sort((a, b) => a.y0 - b.y0);
  rows.forEach((r) => r.words.sort((a, b) => a.x0 - b.x0));
  return rows;
}

async function ocrCanvasLines(canvas, lang) {
  if (!lang) return [];
  const scheduler = await getOcrScheduler(lang);
  const { canvas: ocrCanvas, scale } = downsampleForOcr(canvas);
  const { data } = await scheduler.addJob('recognize', ocrCanvas, {}, {
    blocks: true,
    text: false,
    hocr: false,
    tsv: false
  });
  const lines = [];
  const invScale = 1 / scale;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      const paraWords = [];
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          const text = word.text ? word.text.trim() : '';
          if (!text) continue;
          const b = word.bbox;
          paraWords.push({
            text,
            x0: b.x0 * invScale,
            y0: b.y0 * invScale,
            x1: b.x1 * invScale,
            y1: b.y1 * invScale
          });
        }
      }
      for (const row of clusterWordsIntoRows(paraWords)) {
        const text = buildLineText(row.words, lang);
        if (!text) continue;
        lines.push({
          text,
          x0: Math.min(...row.words.map((w) => w.x0)),
          y0: row.y0,
          x1: Math.max(...row.words.map((w) => w.x1)),
          y1: row.y1
        });
      }
    }
  }
  return lines;
}
