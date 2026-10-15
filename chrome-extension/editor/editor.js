const MAX_BAND_HEIGHT = 15000; // stay well under browser canvas height limits

const state = {
  session: null,
  bands: [],
  width: 0,
  totalHeight: 0,
  pages: [],
  excluded: new Set()
};

function qs(id) {
  return document.getElementById(id);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}

// Decoding a data URL image is not free (base64 + PNG/JPEG decode), and re-decoding every
// tile on every buildComposite() call adds up fast for long books. Cached by tile index and
// invalidated automatically whenever that index's dataUrl actually changes (e.g. recapture).
const tileImageCache = new Map(); // index -> { dataUrl, img }

async function loadCachedTileImage(index, dataUrl) {
  const cached = tileImageCache.get(index);
  if (cached && cached.dataUrl === dataUrl) return cached.img;
  const img = await loadImage(dataUrl);
  tileImageCache.set(index, { dataUrl, img });
  return img;
}

// A full-resolution canvas.toDataURL('image/png') is the dominant cost when there are many
// pages/bands to preview — easily seconds of blocked main-thread work for a long book. Only
// the actual export path needs full resolution; on-screen previews don't, so this draws a
// small scaled-down copy and encodes that (as JPEG, faster to encode than PNG) instead.
function canvasThumbnailDataUrl(canvas, maxWidth) {
  const scale = Math.min(1, maxWidth / Math.max(1, canvas.width));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return tmp.toDataURL('image/jpeg', 0.72);
}

function yieldToUi() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// Shrinks a page canvas so its pixel density doesn't exceed maxDpi, while the PDF page's
// physical size (wPt/hPt, computed separately from the ORIGINAL canvas size and `dpi`) stays
// unchanged — this is pure "embed fewer pixels for the same printed size" file-size reduction,
// not a crop or a page-size change. maxDpi of 0/falsy or >= currentDpi means "no cap".
function downsampleCanvasToDpi(canvas, currentDpi, maxDpi) {
  if (!maxDpi || currentDpi <= maxDpi) return canvas;
  const factor = maxDpi / currentDpi;
  const w = Math.max(1, Math.round(canvas.width * factor));
  const h = Math.max(1, Math.round(canvas.height * factor));
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return tmp;
}

function getSessionIdFromUrl() {
  return new URLSearchParams(location.search).get('session');
}

// Standard paper sizes in mm, given as [shortSide, longSide] (portrait orientation). B4/B5/B6
// use the JIS series (common for Japanese books), not ISO 216.
const PAGE_SIZE_PRESETS_MM = {
  a3: [297, 420],
  a4: [210, 297],
  a5: [148, 210],
  a6: [105, 148],
  b4: [257, 364],
  b5: [182, 257],
  b6: [128, 182],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6]
};
const MM_TO_PT = 72 / 25.4;

// Computes the PDF page's physical size (wPt/hPt) and where to draw the content image within
// it (imgXPt/imgYPt/imgWPt/imgHPt), given the content's own native size in points. 'auto'
// just fills the page with the image at its own aspect ratio (the original behavior); a fixed
// preset instead fits the image within that paper size, centered, so every page ends up the
// same physical size regardless of what aspect ratio was actually captured.
function computePdfPageGeometry(contentWPt, contentHPt, preset, orientation) {
  if (preset === 'auto' || !PAGE_SIZE_PRESETS_MM[preset]) {
    return { wPt: contentWPt, hPt: contentHPt, imgXPt: 0, imgYPt: 0, imgWPt: contentWPt, imgHPt: contentHPt };
  }
  const [shortMm, longMm] = PAGE_SIZE_PRESETS_MM[preset];
  const [wMm, hMm] = orientation === 'landscape' ? [longMm, shortMm] : [shortMm, longMm];
  const wPt = wMm * MM_TO_PT;
  const hPt = hMm * MM_TO_PT;

  const contentAspect = contentWPt / contentHPt;
  const pageAspect = wPt / hPt;
  let imgWPt;
  let imgHPt;
  if (contentAspect > pageAspect) {
    imgWPt = wPt;
    imgHPt = wPt / contentAspect;
  } else {
    imgHPt = hPt;
    imgWPt = hPt * contentAspect;
  }
  const imgXPt = (wPt - imgWPt) / 2;
  const imgYPt = (hPt - imgHPt) / 2;
  return { wPt, hPt, imgXPt, imgYPt, imgWPt, imgHPt };
}

function drawAcrossBands(bands, source, sourceX, sourceYStart, sourceHeight, destY, drawWidth) {
  let remaining = 0;
  let curY = destY;
  while (remaining < sourceHeight) {
    const band = bands.find((b) => curY >= b.start && curY < b.start + b.height);
    if (!band) break;
    const bandLocalY = curY - band.start;
    const spaceInBand = band.height - bandLocalY;
    const sliceHeight = Math.min(sourceHeight - remaining, spaceInBand);
    band.ctx.drawImage(
      source,
      sourceX,
      sourceYStart + remaining,
      drawWidth,
      sliceHeight,
      0,
      bandLocalY,
      drawWidth,
      sliceHeight
    );
    remaining += sliceHeight;
    curY += sliceHeight;
  }
}

function extractRegion(bands, sx, sw, startY, height) {
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  let remaining = 0;
  let curY = startY;
  while (remaining < height) {
    const band = bands.find((b) => curY >= b.start && curY < b.start + b.height);
    if (!band) break;
    const bandLocalY = curY - band.start;
    const spaceInBand = band.height - bandLocalY;
    const sliceHeight = Math.min(height - remaining, spaceInBand);
    ctx.drawImage(band.canvas, sx, bandLocalY, sw, sliceHeight, 0, remaining, sw, sliceHeight);
    remaining += sliceHeight;
    curY += sliceHeight;
  }
  return canvas;
}

// Tiles were captured with overlapPx of extra vertical overlap (see popup "重なり"). Trims
// half of that overlap off the top/bottom of every non-edge tile, so the seam between tiles
// lands in the middle of the overlapping region instead of right at a tile's own edge
// (where scrollbar/rendering artifacts tend to show up). Each tile carries its own
// containerRect measured at the moment it was captured (rather than reusing one measurement
// for the whole session) because on some SPA/virtualized viewers the container's on-screen
// position can drift a little over time — using a stale rect for a tile re-captured much
// later (e.g. "ここから撮り直す") would crop/place it slightly off from its neighbors.
function computeTileDrawParams(tile, img, meta, scale, isFirst, isLast) {
  const defaultRect = meta.containerRect || { left: 0, top: 0, width: meta.viewportWidth, height: meta.viewportHeight };
  const rect = tile.containerRect || defaultRect;
  const cropTop = Math.max(0, Math.round(rect.top * scale));
  const tileCropHeight = Math.max(1, Math.round(rect.height * scale));
  const rawMargin = Math.floor(((meta.overlapPx || 0) * scale) / 2);
  const margin = Math.max(0, Math.min(rawMargin, Math.floor(tileCropHeight / 2) - 1));
  const topTrim = isFirst ? 0 : margin;
  const bottomTrim = isLast ? 0 : margin;
  const sourceYStart = cropTop + topTrim;
  const wantedHeight = tileCropHeight - topTrim - bottomTrim;
  const sourceHeight = Math.min(wantedHeight, img.naturalHeight - sourceYStart);
  const destY = Math.round(tile.y * scale) + topTrim;
  return { sourceYStart, sourceHeight, destY };
}

async function buildComposite() {
  qs('status').textContent = '画像を結合しています...';
  const session = state.session;
  const images = await Promise.all(session.tiles.map((t, i) => loadCachedTileImage(i, t.dataUrl)));
  const meta = session.meta;

  // The overall canvas width/left-crop has to be one constant for the whole composite
  // (bands can't vary in width), so those two come from the first tile.
  const scale = images[0].naturalHeight / meta.viewportHeight;
  const defaultRect = meta.containerRect || { left: 0, top: 0, width: meta.viewportWidth, height: meta.viewportHeight };
  const baseRect = session.tiles[0].containerRect || defaultRect;
  const cropLeft = Math.max(0, Math.round(baseRect.left * scale));
  const cropWidth = Math.max(1, Math.round(baseRect.width * scale));

  // The composite's height comes from what was actually captured (each tile's own destY +
  // sourceHeight), not meta.scrollHeight — meta.scrollHeight is a single measurement taken
  // when the capture session started, and can end up larger than the real content: the
  // page's true height was overestimated to begin with, or the capture was stopped early
  // ("ここまでで終了") with fewer tiles than originally planned. Using it directly would
  // leave a blank canvas tail (and blank pages after page-splitting) below the last tile
  // that was actually drawn.
  const drawParams = [];
  let totalHeight = 0;
  for (let i = 0; i < images.length; i++) {
    const isFirst = i === 0;
    const isLast = i === images.length - 1;
    const params = computeTileDrawParams(session.tiles[i], images[i], meta, scale, isFirst, isLast);
    drawParams.push(params);
    if (params.sourceHeight > 0) {
      totalHeight = Math.max(totalHeight, params.destY + params.sourceHeight);
    }
  }

  const bands = [];
  let bandStart = 0;
  while (bandStart < totalHeight) {
    const bandHeight = Math.min(MAX_BAND_HEIGHT, totalHeight - bandStart);
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = bandHeight;
    bands.push({ canvas, ctx: canvas.getContext('2d'), start: bandStart, height: bandHeight });
    bandStart += bandHeight;
  }

  for (let i = 0; i < images.length; i++) {
    const params = drawParams[i];
    if (params.sourceHeight <= 0) continue;
    drawAcrossBands(bands, images[i], cropLeft, params.sourceYStart, params.sourceHeight, params.destY, cropWidth);
  }

  state.bands = bands;
  state.width = cropWidth;
  state.totalHeight = totalHeight;
  state.scale = scale;
  state.cropLeft = cropLeft;
  qs('status').textContent = '';
}

// Cheaper counterpart to buildComposite() for when only one tile changed (recapture):
// redraws just that tile's region onto the existing bands instead of rebuilding everything.
async function redrawTileInComposite(index) {
  const session = state.session;
  const tile = session.tiles[index];
  const img = await loadCachedTileImage(index, tile.dataUrl);
  const isFirst = index === 0;
  const isLast = index === session.tiles.length - 1;
  const params = computeTileDrawParams(tile, img, session.meta, state.scale, isFirst, isLast);
  if (params.sourceHeight <= 0) return;
  drawAcrossBands(state.bands, img, state.cropLeft, params.sourceYStart, params.sourceHeight, params.destY, state.width);
}

function previewScaleFactor() {
  return Math.min(1, 760 / Math.max(1, state.width));
}

function renderCompositePreview() {
  const wrap = qs('compositeWrap');
  wrap.innerHTML = '';
  const scale = previewScaleFactor();
  const displayWidth = Math.round(state.width * scale);

  const container = document.createElement('div');
  container.className = 'composite-inner';
  container.style.width = displayWidth + 'px';

  state.bands.forEach((band) => {
    const img = document.createElement('img');
    img.src = canvasThumbnailDataUrl(band.canvas, displayWidth);
    img.style.width = '100%';
    container.appendChild(img);
  });

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  container.appendChild(overlay);

  wrap.appendChild(container);
  updateOverlayLines();
}

function addLine(overlay, top, cls) {
  const line = document.createElement('div');
  line.className = 'guide-line ' + cls;
  line.style.top = Math.round(top) + 'px';
  overlay.appendChild(line);
}

function addVLine(overlay, left) {
  const line = document.createElement('div');
  line.className = 'guide-line v-line';
  line.style.left = Math.round(left) + 'px';
  overlay.appendChild(line);
}

function addTileMarker(overlay, top, index) {
  const line = document.createElement('div');
  line.className = 'guide-line tile-line';
  line.style.top = Math.round(top) + 'px';
  overlay.appendChild(line);

  const label = document.createElement('div');
  label.className = 'tile-marker-label';
  label.style.top = Math.round(top) + 'px';
  label.textContent = `#${index + 1}`;
  overlay.appendChild(label);
}

function updateOverlayLines() {
  if (!state.session) return;
  if (state.session.kind === 'pageturn') {
    updatePageTurnOverlayLines();
    return;
  }
  const overlay = document.querySelector('#compositeWrap .overlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  const scale = previewScaleFactor();

  // Faint per-tile boundary markers so a spot in the preview can be matched to a tile
  // number at a glance, without needing to click it.
  if (state.session) {
    state.session.tiles.forEach((tile, i) => {
      addTileMarker(overlay, tile.y * state.scale * scale, i);
    });
  }

  const left = Number(qs('trimLeft').value) || 0;
  const right = Number(qs('trimRight').value) || 0;
  const top = Number(qs('trimTop').value) || 0;
  const bottom = Number(qs('trimBottom').value) || 0;
  const pageHeight = Math.max(50, Number(qs('pageHeight').value) || 1400);

  addLine(overlay, top * scale, 'trim-line');
  addLine(overlay, (state.totalHeight - bottom) * scale, 'trim-line');
  addVLine(overlay, left * scale);
  addVLine(overlay, (state.width - right) * scale);

  let y = top;
  while (y < state.totalHeight - bottom) {
    addLine(overlay, y * scale, 'page-line');
    y += pageHeight;
  }
}

// Maps a click inside the composite preview to the tile whose captured region it falls
// in, so the user can click something odd-looking in the big preview and immediately see
// (and optionally redo) the exact source tile responsible for it.
function findTileIndexForPreviewY(yInComposite) {
  const tiles = state.session.tiles;
  let best = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].y * state.scale <= yInComposite) best = i;
    else break;
  }
  return best;
}

function hideTilePopup() {
  const existing = document.getElementById('tileClickPopup');
  if (existing) existing.remove();
}

function showTilePopup(index, clientX, clientY) {
  hideTilePopup();
  const tile = state.session.tiles[index];
  const popup = document.createElement('div');
  popup.id = 'tileClickPopup';
  popup.className = 'tile-popup';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tile-popup-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', hideTilePopup);

  const img = document.createElement('img');
  img.src = tile.dataUrl;

  const label = document.createElement('div');
  label.className = 'tile-popup-label';
  label.textContent = `タイル #${index + 1}`;

  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'この位置を再撮影';
  retryBtn.addEventListener('click', async () => {
    await recaptureTile(index, retryBtn, false);
    const updated = state.session.tiles[index];
    if (updated && updated.dataUrl) img.src = updated.dataUrl;
  });

  popup.appendChild(closeBtn);
  popup.appendChild(img);
  popup.appendChild(label);
  popup.appendChild(retryBtn);

  if (state.session.meta.mode === 'element') {
    const pickBtn = document.createElement('button');
    pickBtn.className = 'pick-btn';
    pickBtn.textContent = '範囲を選択して再撮影';
    pickBtn.addEventListener('click', async () => {
      await recaptureTile(index, pickBtn, true);
      const updated = state.session.tiles[index];
      if (updated && updated.dataUrl) img.src = updated.dataUrl;
    });
    popup.appendChild(pickBtn);
  }

  document.body.appendChild(popup);

  // Position after adding, now that its size is known, so it stays on screen.
  const popupRect = popup.getBoundingClientRect();
  const left = Math.min(clientX + 12, window.innerWidth - popupRect.width - 12);
  const top = Math.min(clientY + 12, window.innerHeight - popupRect.height - 12);
  popup.style.left = Math.max(8, left) + 'px';
  popup.style.top = Math.max(8, top) + 'px';
}

function setupCompositeClickHandler() {
  qs('compositeWrap').addEventListener('click', (e) => {
    if (!state.session || state.session.kind === 'pageturn') return; // no click-to-recapture popup in page-turn mode
    const container = e.currentTarget.querySelector('.composite-inner');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const yInPreview = e.clientY - rect.top;
    const scale = previewScaleFactor();
    const yInComposite = yInPreview / scale;
    const index = findTileIndexForPreviewY(yInComposite);
    showTilePopup(index, e.clientX, e.clientY);
  });

  document.addEventListener('click', (e) => {
    const popup = document.getElementById('tileClickPopup');
    if (popup && !popup.contains(e.target) && !qs('compositeWrap').contains(e.target)) {
      hideTilePopup();
    }
  });
}

let regenerateRunId = 0;

async function regeneratePages() {
  const runId = ++regenerateRunId;
  const left = Math.max(0, Number(qs('trimLeft').value) || 0);
  const right = Math.max(0, Number(qs('trimRight').value) || 0);
  const top = Math.max(0, Number(qs('trimTop').value) || 0);
  const bottom = Math.max(0, Number(qs('trimBottom').value) || 0);
  const pageHeight = Math.max(50, Number(qs('pageHeight').value) || 1400);

  const sw = Math.max(1, state.width - left - right);
  const usableHeight = Math.max(0, state.totalHeight - top - bottom);
  const count = Math.max(1, Math.ceil(usableHeight / pageHeight));

  const pages = [];
  for (let i = 0; i < count; i++) {
    const startY = top + i * pageHeight;
    const h = Math.min(pageHeight, state.totalHeight - bottom - startY);
    if (h <= 0) break;
    const canvas = extractRegion(state.bands, left, sw, startY, h);
    pages.push({ canvas, index: i });
    // Yield every so often on long books so the tab stays responsive (and the status text
    // below can actually paint) instead of blocking the main thread in one long stretch.
    if (i % 10 === 9) {
      qs('status').textContent = `ページを生成しています... (${i + 1}/${count})`;
      await yieldToUi();
      if (runId !== regenerateRunId) return; // a newer trim/pageHeight change superseded this run
    }
  }

  if (runId !== regenerateRunId) return;
  state.pages = pages;
  state.excluded = new Set();
  await renderPageGrid();
  updateOverlayLines();
  saveEditorSettings();
  qs('status').textContent = '';
}

async function renderPageGrid() {
  const runId = regenerateRunId;
  const grid = qs('pageGrid');
  grid.innerHTML = '';
  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    const cell = document.createElement('div');
    cell.className = 'page-cell' + (state.excluded.has(i) ? ' excluded' : '');

    const thumb = document.createElement('img');
    thumb.src = canvasThumbnailDataUrl(page.canvas, 220);

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `#${i + 1}`;

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = state.excluded.has(i) ? '復元する' : '除外する';
    toggleBtn.addEventListener('click', () => {
      if (state.excluded.has(i)) state.excluded.delete(i);
      else state.excluded.add(i);
      cell.classList.toggle('excluded');
      toggleBtn.textContent = state.excluded.has(i) ? '復元する' : '除外する';
      qs('excludedCount').textContent = state.excluded.size;
    });

    cell.appendChild(thumb);
    cell.appendChild(label);
    cell.appendChild(toggleBtn);
    grid.appendChild(cell);

    if (i % 15 === 14) {
      await yieldToUi();
      if (runId !== regenerateRunId) return; // superseded by a newer regeneratePages() run
    }
  }
  qs('pageCount').textContent = state.pages.length;
  qs('excludedCount').textContent = state.excluded.size;
}

function activePages() {
  return state.pages.filter((_, i) => !state.excluded.has(i));
}

function canvasToBlob(canvas, format, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, format === 'png' ? 'image/png' : 'image/jpeg', format === 'jpeg' ? quality / 100 : undefined);
  });
}

// Standard luma weighting, on a fresh canvas (never mutates the caller's — it's reused for
// previews and other export paths).
function toGrayscaleCanvas(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const imgData = ctx.getImageData(0, 0, out.width, out.height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = y;
  }
  ctx.putImageData(imgData, 0, 0);
  return out;
}

function updateRawTileThumb(index, dataUrl) {
  const item = qs('tileRawList').children[index];
  const img = item && item.querySelector('img');
  if (img) img.src = dataUrl;
}

function renderRawTileList() {
  const container = qs('tileRawList');
  container.innerHTML = '';
  state.session.tiles.forEach((tile, index) => {
    const item = document.createElement('div');
    item.className = 'tile-raw-item';

    const img = document.createElement('img');
    img.src = tile.dataUrl;

    const label = document.createElement('span');
    label.className = 'tile-raw-label';
    label.textContent = `#${index + 1}`;

    const retryBtn = document.createElement('button');
    retryBtn.textContent = 'この位置を再撮影';
    retryBtn.addEventListener('click', () => recaptureTile(index, retryBtn, false));

    item.appendChild(img);
    item.appendChild(label);
    item.appendChild(retryBtn);

    if (state.session.meta.mode === 'element') {
      const pickBtn = document.createElement('button');
      pickBtn.className = 'pick-btn';
      pickBtn.textContent = '範囲を選択して再撮影';
      pickBtn.addEventListener('click', () => recaptureTile(index, pickBtn, true));
      item.appendChild(pickBtn);
    }

    container.appendChild(item);
  });
}

async function recaptureTile(index, triggerBtn, usePicker, overrideTabId, force) {
  const session = state.session;
  const tile = session.tiles[index];
  const tabId = overrideTabId != null ? overrideTabId : session.meta.sourceTabId;

  if (tabId == null) {
    qs('status').textContent = '元のタブ情報が記録されていません。';
    return;
  }

  const buttons = qs('tileRawList').querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  const originalLabel = triggerBtn.textContent;
  triggerBtn.textContent = usePicker ? 'ページ上で範囲をクリック...' : '再撮影中...';
  qs('status').textContent = `#${index + 1} を再撮影しています...`;

  const hideFixed = !!(session.meta.captureOptions && session.meta.captureOptions.hideFixed) && index > 0;
  const response = await chrome.runtime
    .sendMessage({
      type: usePicker ? 'scc:pickAndRecaptureTile' : 'scc:recaptureTile',
      tabId,
      y: tile.y,
      options: session.meta.captureOptions || { delayMs: 600, format: 'png', quality: 90 },
      hideFixed,
      expectedUrl: session.meta.sourceUrl,
      force: !!force
    })
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));

  buttons.forEach((b) => (b.disabled = false));
  triggerBtn.textContent = originalLabel;

  if (response && response.cancelled) {
    qs('status').textContent = '再撮影をキャンセルしました。';
    return;
  }

  if (!response || !response.ok) {
    if (response && response.error === 'tab_mismatch') {
      const proceed = confirm(
        `対象タブのURLが撮影時と異なります（現在: ${response.tabUrl}）。\nこのタブのまま再撮影を続けますか？`
      );
      if (proceed) {
        await recaptureTile(index, triggerBtn, usePicker, tabId, true);
      } else {
        qs('status').textContent = '再撮影をキャンセルしました。';
      }
      return;
    }

    const message = (response && response.error) || '不明なエラー';
    const useActiveTab = confirm(
      `再撮影に失敗しました（${message}）。\n対象のページを表示しているタブをアクティブにしてから「OK」を押すと、` +
        '現在アクティブなタブを使って再試行します。'
    );
    if (useActiveTab) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id != null) {
        session.meta.sourceTabId = activeTab.id;
        await recaptureTile(index, triggerBtn, usePicker, activeTab.id, true);
      }
    } else {
      qs('status').textContent = '再撮影をキャンセルしました。';
    }
    return;
  }

  session.tiles[index] = { y: response.scrollY, dataUrl: response.dataUrl, containerRect: response.containerRect };
  if (overrideTabId != null) session.meta.sourceTabId = overrideTabId;
  await chrome.storage.local.set({ [session.id]: session });

  qs('status').textContent = `#${index + 1} を再撮影しました。プレビューを更新しています...`;
  // Only this one tile changed, so patch it into the existing composite/thumbnail instead
  // of rebuilding everything from scratch (buildComposite()/renderRawTileList() re-decode
  // and re-render every tile, which is the main cause of the editor freezing briefly after
  // a recapture on long books). The first/last tile are the exception: they define the
  // composite's overall extent (buildComposite() derives state.totalHeight from them), so a
  // recapture that changes their size needs the full rebuild to keep that extent correct.
  if (index === 0 || index === session.tiles.length - 1) {
    await buildComposite();
  } else {
    await redrawTileInComposite(index);
  }
  renderCompositePreview();
  updateRawTileThumb(index, response.dataUrl);
  await regeneratePages();
  qs('status').textContent = `#${index + 1} を再撮影し、プレビューを更新しました。`;
}

// --- Page-turn (click-through) session editing -------------------------------------------
//
// Each capture is already its own page (no scrolling/stitching happened), so there is no
// composite to build and no page-height splitting: "regenerating pages" here just means
// re-cropping every raw captured image by the SAME trim margins (applied in bulk to every
// page, per spec) and re-decoding only what actually changed.

async function regeneratePageTurnPages() {
  const runId = ++regenerateRunId;
  const left = Math.max(0, Number(qs('trimLeft').value) || 0);
  const right = Math.max(0, Number(qs('trimRight').value) || 0);
  const top = Math.max(0, Number(qs('trimTop').value) || 0);
  const bottom = Math.max(0, Number(qs('trimBottom').value) || 0);

  const rawPages = state.session.pages;
  const pages = [];
  for (let i = 0; i < rawPages.length; i++) {
    const img = await loadCachedTileImage(i, rawPages[i].dataUrl);
    const w = Math.max(1, img.naturalWidth - left - right);
    const h = Math.max(1, img.naturalHeight - top - bottom);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, left, top, w, h, 0, 0, w, h);
    pages.push({ canvas, index: i });
    if (i % 10 === 9) {
      qs('status').textContent = `ページを生成しています... (${i + 1}/${rawPages.length})`;
      await yieldToUi();
      if (runId !== regenerateRunId) return;
    }
  }

  if (runId !== regenerateRunId) return;
  state.pages = pages;
  state.excluded = new Set();
  await renderPageGrid();
  saveEditorSettings();
  qs('status').textContent = '';
}

// Large trim-preview for page-turn mode, mirroring scroll mode's compositeWrap: since pages
// aren't stitched here, this shows every captured page at a large size (CSS-scaled, no canvas
// re-encoding needed — these are already normal screenshot-sized images, not one huge stitched
// canvas) with the same dashed trim-line overlay. The trim margins are identical for every
// page (bulk trim), so each page gets its own overlay computed from its own natural size.
const PAGE_TURN_PREVIEW_MAX_WIDTH = 760;

async function renderPageTurnLargePreview() {
  const wrap = qs('compositeWrap');
  wrap.innerHTML = '';
  const session = state.session;
  const items = [];

  for (let i = 0; i < session.pages.length; i++) {
    const img = await loadCachedTileImage(i, session.pages[i].dataUrl);
    const scale = Math.min(1, PAGE_TURN_PREVIEW_MAX_WIDTH / img.naturalWidth);
    const displayWidth = Math.round(img.naturalWidth * scale);
    const displayHeight = Math.round(img.naturalHeight * scale);

    const item = document.createElement('div');
    item.className = 'page-turn-preview-item';

    const label = document.createElement('div');
    label.className = 'page-turn-preview-label';
    label.textContent = `#${i + 1}`;

    const inner = document.createElement('div');
    inner.className = 'composite-inner';
    inner.style.width = displayWidth + 'px';

    const imgEl = document.createElement('img');
    imgEl.src = session.pages[i].dataUrl;
    imgEl.style.width = '100%';

    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    inner.appendChild(imgEl);
    inner.appendChild(overlay);
    item.appendChild(label);
    item.appendChild(inner);
    wrap.appendChild(item);

    items.push({ overlay, imgEl, innerEl: inner, scale, displayWidth, displayHeight });

    if (i % 8 === 7) await yieldToUi();
  }

  state.pageTurnPreviewItems = items;
  updatePageTurnOverlayLines();
}

function updatePageTurnOverlayLines() {
  const items = state.pageTurnPreviewItems;
  if (!items) return;
  const left = Number(qs('trimLeft').value) || 0;
  const right = Number(qs('trimRight').value) || 0;
  const top = Number(qs('trimTop').value) || 0;
  const bottom = Number(qs('trimBottom').value) || 0;

  items.forEach(({ overlay, scale, displayWidth, displayHeight }) => {
    overlay.innerHTML = '';
    addLine(overlay, top * scale, 'trim-line');
    addLine(overlay, displayHeight - bottom * scale, 'trim-line');
    addVLine(overlay, left * scale);
    addVLine(overlay, displayWidth - right * scale);
  });
}

function renderPageTurnRawList() {
  const container = qs('tileRawList');
  container.innerHTML = '';
  state.session.pages.forEach((page, index) => {
    const item = document.createElement('div');
    item.className = 'tile-raw-item';

    const img = document.createElement('img');
    img.src = page.dataUrl;

    const label = document.createElement('span');
    label.className = 'tile-raw-label';
    label.textContent = `#${index + 1}`;

    const retryBtn = document.createElement('button');
    retryBtn.textContent = '今そのタブに表示されている画面で撮り直す';
    retryBtn.addEventListener('click', () => recapturePageTurnTile(index, retryBtn));

    item.appendChild(img);
    item.appendChild(label);
    item.appendChild(retryBtn);
    container.appendChild(item);
  });
}

// Always captures whatever is CURRENTLY shown in the source tab — no click, no navigation.
// Page-turn mode's recapture is explicitly human-driven: the user is expected to have
// already navigated the source tab to the desired page themselves before clicking this.
async function recapturePageTurnTile(index, triggerBtn, overrideTabId, force) {
  const session = state.session;
  const tabId = overrideTabId != null ? overrideTabId : session.meta.sourceTabId;

  if (tabId == null) {
    qs('status').textContent = '元のタブ情報が記録されていません。';
    return;
  }

  const buttons = qs('tileRawList').querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  const originalLabel = triggerBtn.textContent;
  triggerBtn.textContent = '再撮影中...';
  qs('status').textContent = `#${index + 1} を、今そのタブに表示されている画面で再撮影しています...`;

  const response = await chrome.runtime
    .sendMessage({
      type: 'scc:recapturePageTurnTile',
      tabId,
      options: session.meta.captureOptions || { format: 'png', quality: 90 },
      expectedUrl: session.meta.sourceUrl,
      force: !!force
    })
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));

  buttons.forEach((b) => (b.disabled = false));
  triggerBtn.textContent = originalLabel;

  if (!response || !response.ok) {
    if (response && response.error === 'tab_mismatch') {
      const proceed = confirm(
        `対象タブのURLが撮影時と異なります（現在: ${response.tabUrl}）。\nこのタブのまま再撮影を続けますか？`
      );
      if (proceed) {
        await recapturePageTurnTile(index, triggerBtn, tabId, true);
      } else {
        qs('status').textContent = '再撮影をキャンセルしました。';
      }
      return;
    }

    const message = (response && response.error) || '不明なエラー';
    const useActiveTab = confirm(
      `再撮影に失敗しました（${message}）。\n対象のページを表示しているタブをアクティブにしてから「OK」を押すと、` +
        '現在アクティブなタブを使って再試行します。'
    );
    if (useActiveTab) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id != null) {
        session.meta.sourceTabId = activeTab.id;
        await recapturePageTurnTile(index, triggerBtn, activeTab.id, true);
      }
    } else {
      qs('status').textContent = '再撮影をキャンセルしました。';
    }
    return;
  }

  session.pages[index] = { index, dataUrl: response.dataUrl };
  if (overrideTabId != null) session.meta.sourceTabId = overrideTabId;
  await chrome.storage.local.set({ [session.id]: session });

  qs('status').textContent = `#${index + 1} を再撮影しました。プレビューを更新しています...`;
  updateRawTileThumb(index, response.dataUrl);
  await renderPageTurnLargePreview();
  await regeneratePageTurnPages();
  qs('status').textContent = `#${index + 1} を再撮影し、プレビューを更新しました。`;
}

async function applySavedEditorSettings() {
  const { sccEditorSettings } = await chrome.storage.sync.get('sccEditorSettings');
  if (!sccEditorSettings) return;
  const s = sccEditorSettings;
  if (s.trimLeft != null) qs('trimLeft').value = s.trimLeft;
  if (s.trimRight != null) qs('trimRight').value = s.trimRight;
  if (s.trimTop != null) qs('trimTop').value = s.trimTop;
  if (s.trimBottom != null) qs('trimBottom').value = s.trimBottom;
  if (s.pageHeight != null) qs('pageHeight').value = s.pageHeight;
  if (s.dpi != null) qs('dpi').value = s.dpi;
  if (s.pageFormat != null) qs('pageFormat').value = s.pageFormat;
  if (s.pageQuality != null) qs('pageQuality').value = s.pageQuality;
  if (s.maxPdfDpi != null) qs('maxPdfDpi').value = s.maxPdfDpi;
  if (s.ocrLang != null) qs('ocrLang').value = s.ocrLang;
  if (s.pageSizePreset != null) qs('pageSizePreset').value = s.pageSizePreset;
  if (s.pageOrientation != null) {
    qs('orientPortrait').checked = s.pageOrientation !== 'landscape';
    qs('orientLandscape').checked = s.pageOrientation === 'landscape';
  }
  qs('pageQualityRow').style.display = qs('pageFormat').value === 'jpeg' ? '' : 'none';
  qs('pageOrientationRow').hidden = qs('pageSizePreset').value === 'auto';
}

function saveEditorSettings() {
  chrome.storage.sync.set({
    sccEditorSettings: {
      trimLeft: Number(qs('trimLeft').value) || 0,
      trimRight: Number(qs('trimRight').value) || 0,
      trimTop: Number(qs('trimTop').value) || 0,
      trimBottom: Number(qs('trimBottom').value) || 0,
      pageHeight: Number(qs('pageHeight').value) || 1400,
      dpi: Number(qs('dpi').value) || 150,
      pageFormat: qs('pageFormat').value,
      pageQuality: Number(qs('pageQuality').value) || 95,
      maxPdfDpi: qs('maxPdfDpi').value,
      ocrLang: qs('ocrLang').value,
      pageSizePreset: qs('pageSizePreset').value,
      pageOrientation: qs('orientLandscape').checked ? 'landscape' : 'portrait'
    }
  });
}

let regenerateTimer = null;

function scheduleRegeneratePages() {
  if (regenerateTimer) clearTimeout(regenerateTimer);
  regenerateTimer = setTimeout(() => {
    regenerateTimer = null;
    if (state.session && state.session.kind === 'pageturn') regeneratePageTurnPages();
    else regeneratePages();
  }, 400);
}

function wireEvents() {
  setupCompositeClickHandler();

  ['trimLeft', 'trimRight', 'trimTop', 'trimBottom', 'pageHeight'].forEach((id) => {
    qs(id).addEventListener('input', () => {
      updateOverlayLines();
      scheduleRegeneratePages();
    });
  });

  ['dpi', 'pageFormat', 'pageQuality', 'maxPdfDpi', 'ocrLang', 'pageSizePreset'].forEach((id) => {
    qs(id).addEventListener('change', saveEditorSettings);
  });
  ['orientPortrait', 'orientLandscape'].forEach((id) => {
    qs(id).addEventListener('change', saveEditorSettings);
  });

  qs('pageFormat').addEventListener('change', () => {
    qs('pageQualityRow').style.display = qs('pageFormat').value === 'jpeg' ? '' : 'none';
  });

  qs('pageSizePreset').addEventListener('change', () => {
    qs('pageOrientationRow').hidden = qs('pageSizePreset').value === 'auto';
  });

  document.querySelectorAll('.preset-row button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mm = Number(btn.dataset.mm);
      const dpi = Number(qs('dpi').value) || 150;
      qs('pageHeight').value = Math.round((mm / 25.4) * dpi);
      updateOverlayLines();
      scheduleRegeneratePages();
    });
  });

  qs('exportImagesBtn').addEventListener('click', async () => {
    const format = qs('pageFormat').value;
    const quality = Number(qs('pageQuality').value);
    const grayscale = qs('grayscaleOutput').checked;
    const pages = activePages();
    if (pages.length === 0) {
      qs('status').textContent = '書き出すページがありません。';
      return;
    }
    for (let i = 0; i < pages.length; i++) {
      qs('status').textContent = `画像を書き出し中 (${i + 1}/${pages.length})...`;
      const srcCanvas = grayscale ? toGrayscaleCanvas(pages[i].canvas) : pages[i].canvas;
      const blob = await canvasToBlob(srcCanvas, format, quality);
      const url = URL.createObjectURL(blob);
      const ext = format === 'png' ? 'png' : 'jpg';
      const filename = `capture2pdf/page-${String(i + 1).padStart(3, '0')}.${ext}`;
      await chrome.downloads.download({ url, filename, saveAs: false });
      URL.revokeObjectURL(url);
    }
    qs('status').textContent = '画像の書き出しが完了しました。';
  });

  qs('exportPdfBtn').addEventListener('click', async () => {
    const pages = activePages();
    if (pages.length === 0) {
      qs('status').textContent = '書き出すページがありません。';
      return;
    }
    const btn = qs('exportPdfBtn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '生成中...';
    try {
      await runPdfExport(pages);
    } catch (err) {
      console.error(err);
      qs('status').textContent = `PDFの生成に失敗しました: ${(err && err.message) || err}`;
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  async function runPdfExport(pages) {
    const dpi = Number(qs('dpi').value) || 150;
    const maxDpi = Number(qs('maxPdfDpi').value) || 0; // 0 = no cap, keep native capture resolution
    const format = qs('pageFormat').value; // 'png' = lossless, 'jpeg' = quality slider below
    const quality = Number(qs('pageQuality').value) || 95;
    const ocrLang = qs('ocrLang').value; // '' = no OCR text layer
    const sizePreset = qs('pageSizePreset').value; // 'auto' = page sized to the image itself
    const orientation = qs('orientLandscape').checked ? 'landscape' : 'portrait';
    const grayscale = qs('grayscaleOutput').checked;
    qs('status').textContent = 'PDFを生成しています...';

    // Only runs at export time, not while editing, so this doesn't affect interactive
    // responsiveness — but still yields periodically since a long book's worth of
    // full-resolution encoding (especially lossless PNG/FlateDecode) can take a while.
    const pdfPages = [];
    for (let idx = 0; idx < pages.length; idx++) {
      const srcCanvas = pages[idx].canvas;
      // The content's own natural physical size, always derived from the ORIGINAL captured
      // resolution and the DPI setting (independent of maxDpi below, which only affects how
      // much pixel data gets embedded, never the physical size). When a fixed paper size is
      // selected, this is fit-and-centered onto that page instead of defining the page itself.
      const contentWPt = (srcCanvas.width * 72) / dpi;
      const contentHPt = (srcCanvas.height * 72) / dpi;
      const geometry = computePdfPageGeometry(contentWPt, contentHPt, sizePreset, orientation);
      const encodeCanvas = downsampleCanvasToDpi(srcCanvas, dpi, maxDpi);
      const imgResult =
        format === 'png'
          ? await canvasToLosslessPdfImage(encodeCanvas, grayscale)
          : await canvasToLossyPdfImage(encodeCanvas, quality, grayscale);
      pdfPages.push({ ...imgResult, ...geometry, srcCanvas });
      if (idx % 5 === 4) {
        qs('status').textContent = `PDFを生成しています... (${idx + 1}/${pages.length})`;
        await yieldToUi();
      }
    }

    if (ocrLang) {
      // Fired off for every page at once rather than awaited one at a time — ocrCanvasLines
      // runs on a multi-worker scheduler (see ocr.js), so pages recognize in parallel across
      // several CPU cores instead of strictly one after another. Awaiting each page before
      // starting the next would leave the extra workers completely idle.
      let ocrDone = 0;
      qs('status').textContent = `文字を認識しています... (0/${pdfPages.length})`;
      await Promise.all(
        pdfPages.map(async (pdfPage) => {
          const rawLines = await ocrCanvasLines(pdfPage.srcCanvas, ocrLang);
          // OCR runs on srcCanvas (its ORIGINAL, pre-downsample resolution — same one the
          // image placement rectangle below was computed from), so this pixel->point scale
          // lines up the text with wherever the image actually ends up drawn on the page
          // (which, with a fixed paper size, may not be the full page — see
          // computePdfPageGeometry).
          const scaleX = pdfPage.imgWPt / pdfPage.srcCanvas.width;
          const scaleY = pdfPage.imgHPt / pdfPage.srcCanvas.height;
          pdfPage.words = rawLines.map((line) => ({
            text: line.text,
            xPt: pdfPage.imgXPt + line.x0 * scaleX,
            // PDF y-axis is bottom-up; pixel y-axis is top-down
            yPt: pdfPage.imgYPt + pdfPage.imgHPt - line.y1 * scaleY,
            wPt: (line.x1 - line.x0) * scaleX,
            hPt: (line.y1 - line.y0) * scaleY
          }));
          ocrDone++;
          qs('status').textContent = `文字を認識しています... (${ocrDone}/${pdfPages.length})`;
        })
      );
    }
    pdfPages.forEach((p) => {
      delete p.srcCanvas;
    });

    const pdfBlob = await buildPdfFromImages(pdfPages, (done, total) => {
      qs('status').textContent = `PDFを組み立てています... (${done}/${total})`;
    });
    const url = URL.createObjectURL(pdfBlob);
    await chrome.downloads.download({ url, filename: 'capture2pdf/book.pdf', saveAs: true });
    URL.revokeObjectURL(url);
    qs('status').textContent = 'PDFの書き出しが完了しました。';
  }

  qs('discardBtn').addEventListener('click', async () => {
    if (!confirm('このキャプチャデータを削除しますか？')) return;
    await chrome.storage.local.remove(state.session.id);
    qs('status').textContent = 'データを破棄しました。このタブは閉じても構いません。';
  });
}

async function init() {
  wireEvents();

  const sessionId = getSessionIdFromUrl();
  if (!sessionId) {
    qs('status').textContent = 'セッションIDが見つかりません。';
    return;
  }

  const store = await chrome.storage.local.get(sessionId);
  const session = store[sessionId];
  if (!session) {
    qs('status').textContent = 'キャプチャデータが見つかりません。拡張機能のポップアップから再度キャプチャしてください。';
    return;
  }
  state.session = session;

  if (session.kind === 'pageturn') {
    qs('pageHeightGroup').hidden = true;
    document.querySelector('#compositeSection h2').textContent =
      'トリミングプレビュー（点線＝トリミング位置。全ページ共通の設定です）';
    qs('tileRawListHeading').textContent = 'キャプチャ済みページ一覧（トリミングは全ページに一括で適用されます）';
    qs('sourceInfo').textContent = `ページ送りキャプチャ　(${session.pages.length} ページ)`;
    await applySavedEditorSettings();
    await renderPageTurnLargePreview();
    renderPageTurnRawList();
    await regeneratePageTurnPages();
    return;
  }

  qs('sourceInfo').textContent = `${session.meta.sourceTitle || session.meta.sourceUrl || ''}　(${session.tiles.length} タイル / 高さ ${session.meta.scrollHeight}px)`;

  await buildComposite();
  await applySavedEditorSettings();
  renderCompositePreview();
  renderRawTileList();
  await regeneratePages();
}

init();
