const MIN_CAPTURE_INTERVAL_MS = 350; // chrome.tabs.captureVisibleTab is rate-limited to ~2 calls/sec
const STEP_RETRY_ATTEMPTS = 3;
const STEP_RETRY_DELAY_MS = 1200;

// Belt-and-suspenders only: all capture progress is persisted to chrome.storage.local (see
// below) specifically so nothing depends on this service worker staying alive, but an open
// port from the panel still makes Chrome less likely to suspend it mid-operation.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'scc-keepalive') {
    port.onDisconnect.addListener(() => {});
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content-script.js']
  });
}

async function captureVisibleTabWithRetry(windowId, options, retries = 6) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, options);
    } catch (err) {
      const message = String((err && err.message) || err);
      if (message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') && attempt < retries - 1) {
        await sleep(600);
        continue;
      }
      throw err;
    }
  }
}

function computePositions(scrollHeight, clientHeight, overlapPx, startY) {
  const positions = [];
  if (clientHeight <= 0) return [Math.max(0, startY || 0)];
  const maxStart = Math.max(0, scrollHeight - clientHeight);
  if (scrollHeight <= clientHeight) {
    positions.push(0);
    return positions;
  }
  const step = Math.max(1, clientHeight - Math.max(0, Math.min(overlapPx || 0, clientHeight - 1)));
  let y = Math.max(0, Math.min(startY || 0, maxStart));
  while (y < maxStart) {
    positions.push(y);
    y += step;
  }
  positions.push(maxStart);
  return positions;
}

function broadcastProgress(data) {
  chrome.runtime.sendMessage({ type: 'scc:progress', ...data }).catch(() => {});
}

function broadcastTileCaptured(tabId, dataUrl, y, index, total) {
  chrome.runtime.sendMessage({ type: 'scc:tileCaptured', tabId, dataUrl, y, index, total }).catch(() => {});
}

function broadcastTileUpdated(tabId, index, dataUrl) {
  chrome.runtime.sendMessage({ type: 'scc:tileUpdated', tabId, index, dataUrl }).catch(() => {});
}

function broadcastCaptureError(tabId, data) {
  chrome.runtime.sendMessage({ type: 'scc:captureError', tabId, ...data }).catch(() => {});
}

function broadcastCaptureFinished(tabId, data) {
  chrome.runtime.sendMessage({ type: 'scc:captureFinished', tabId, ...data }).catch(() => {});
}

function broadcastCaptureEnded(tabId, data) {
  chrome.runtime.sendMessage({ type: 'scc:captureEnded', tabId, ...data }).catch(() => {});
}

async function showTabProgress(tabId, text) {
  await sendToTab(tabId, { type: 'scc:showProgress', text }).catch(() => {});
}

// --- Persistent capture state -----------------------------------------------------------
//
// MV3 service workers can be suspended after roughly 30s of inactivity, and there is no
// fully reliable way to force one to stay alive indefinitely (a long-lived port helps but
// is not guaranteed across every Chrome version/situation). A paused capture, or the
// post-capture review phase, can sit idle for however long the user takes to look things
// over — far longer than that window. So instead of keeping progress in an in-memory
// object with a JS function sitting there `await`-ing forever, all capture progress lives
// in chrome.storage.local (durable, survives a service worker restart) and every user
// action (pause/resume/retry/finalize/...) is its own short, self-contained operation that
// loads state, does its work, saves state, and returns — nothing is ever left "waiting".
//
// Layout: one small metadata record per source tab, plus one record per captured tile
// (so recording/overwriting a single tile never has to rewrite every other tile's image).

function metaKey(tabId) {
  return `scc_draft_meta_${tabId}`;
}
function tileKey(tabId, index) {
  return `scc_draft_tile_${tabId}_${index}`;
}

// Small registry of tabIds that currently have a draft in progress, kept in its own tiny
// storage entry so listing drafts (for the popup's recovery banner — see scc:listDrafts)
// never has to scan/read the potentially large tile image data to find them.
const DRAFT_INDEX_KEY = 'scc_draft_index';
async function addToDraftIndex(tabId) {
  const store = await chrome.storage.local.get(DRAFT_INDEX_KEY);
  const list = new Set(store[DRAFT_INDEX_KEY] || []);
  list.add(tabId);
  await chrome.storage.local.set({ [DRAFT_INDEX_KEY]: [...list] });
}
async function removeFromDraftIndex(tabId) {
  const store = await chrome.storage.local.get(DRAFT_INDEX_KEY);
  const list = (store[DRAFT_INDEX_KEY] || []).filter((id) => id !== tabId);
  await chrome.storage.local.set({ [DRAFT_INDEX_KEY]: list });
}

async function loadMeta(tabId) {
  const store = await chrome.storage.local.get(metaKey(tabId));
  return store[metaKey(tabId)] || null;
}
async function saveMeta(tabId, meta) {
  await chrome.storage.local.set({ [metaKey(tabId)]: meta });
  await addToDraftIndex(tabId);
}
async function clearMeta(tabId) {
  await chrome.storage.local.remove(metaKey(tabId));
  await removeFromDraftIndex(tabId);
}
async function saveTile(tabId, index, tile) {
  await chrome.storage.local.set({ [tileKey(tabId, index)]: tile });
}
async function loadDenseTiles(tabId, total) {
  const keys = [];
  for (let i = 0; i < total; i++) keys.push(tileKey(tabId, i));
  const store = keys.length ? await chrome.storage.local.get(keys) : {};
  const tiles = [];
  for (const k of keys) {
    const tile = store[k];
    if (!tile) break; // stop at the first gap: tiles are always filled in order
    tiles.push(tile);
  }
  return tiles;
}
async function clearTilesFrom(tabId, fromIndex, total) {
  const keys = [];
  for (let i = fromIndex; i < total; i++) keys.push(tileKey(tabId, i));
  if (keys.length) await chrome.storage.local.remove(keys);
}

// Coordination that only needs to survive while a loop is actively, continuously running
// (which Chrome does not suspend a service worker in the middle of) — never relied upon
// across an idle gap. Once a loop returns (paused/cancelled/error/done reviewing), nothing
// further depends on this; the next action re-derives everything from storage.
const liveLoops = new Map(); // tabId -> { pauseRequested, cancelRequested, stopRequested, jumpToIndex }
const activeCaptures = new Set(); // tabIds with a loop currently executing, to block double-starts

const PANEL_WIDTH = 640;
const PANEL_HEIGHT = 780;

async function openControlPanel(tabId) {
  let left = 40;
  let top = 40;
  try {
    const win = await chrome.windows.getCurrent();
    left = (win.left || 0) + Math.max(0, (win.width || 1200) - (PANEL_WIDTH + 20));
    top = (win.top || 0) + 40;
  } catch (_err) {
    // fall back to defaults
  }
  return chrome.windows.create({
    url: chrome.runtime.getURL(`panel/panel.html?tabId=${tabId}`),
    type: 'popup',
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    left,
    top,
    focused: false
  });
}

// Captures one scroll position. If messaging to the content script fails (e.g. the tab
// crashed, was reloaded, or navigated away and the script context was torn down), it
// re-injects the script and re-measures before retrying, up to STEP_RETRY_ATTEMPTS times.
// Some paginated SPA/PDF viewers snap the scroll position to the nearest "page" boundary
// a little after a scroll settles — often on a debounce timer, or via CSS scroll-behavior:
// smooth animating the scroll over several hundred ms (content-script.js now forces that to
// 'auto', which should remove most of this, but some sites re-apply it or animate scroll
// themselves in JS). Polls until two consecutive reads agree, up to a bounded max wait,
// instead of a single fixed-length pause — however long the settling actually takes.
async function settlePosition(tabId, fallback) {
  const maxWaitMs = 900;
  const intervalMs = 120;
  let current = await sendToTab(tabId, { type: 'scc:getCurrentPosition' }).catch(() => fallback);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(intervalMs);
    const next = await sendToTab(tabId, { type: 'scc:getCurrentPosition' }).catch(() => current);
    if (next.scrollY === current.scrollY) return next;
    current = next;
  }
  return current;
}

// Scrolls to y, waits for the page/content-script's own reaction plus the configured delay,
// waits again for the position to actually settle, captures, then re-checks the position one
// more time — if it moved again during/right after the screenshot, throws so the caller
// retries the whole step rather than silently keeping a tile whose recorded position doesn't
// match what's actually in its image.
async function scrollSettleCaptureVerify(tabId, windowId, options, y, hideFixed) {
  const scrollResult = await sendToTab(tabId, { type: 'scc:scrollTo', y, hideFixed });
  await sleep(Math.max(options.delayMs, MIN_CAPTURE_INTERVAL_MS));
  const settled = await settlePosition(tabId, scrollResult);

  // The progress banner is injected directly into the captured page (see content-script.js),
  // so without this it was showing up IN every captured tile. Hidden for the shortest possible
  // window — just around the actual screenshot — and restored right after, so it's still
  // visible to the user between captures.
  await sendToTab(tabId, { type: 'scc:setProgressBannerHidden', hidden: true }).catch(() => {});
  const dataUrl = await captureVisibleTabWithRetry(windowId, {
    format: options.format === 'jpeg' ? 'jpeg' : 'png',
    quality: options.format === 'jpeg' ? options.quality || 90 : undefined
  });
  await sendToTab(tabId, { type: 'scc:setProgressBannerHidden', hidden: false }).catch(() => {});

  const verify = await sendToTab(tabId, { type: 'scc:getCurrentPosition' }).catch(() => settled);
  if (verify.scrollY !== settled.scrollY) {
    throw new Error('スクロール位置が撮影中に変化しました');
  }

  return { scrollY: settled.scrollY, dataUrl, containerRect: settled.containerRect };
}

async function captureStepWithRetries(tabId, windowId, options, y, hideFixed) {
  let lastErr;
  for (let attempt = 0; attempt < STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      return await scrollSettleCaptureVerify(tabId, windowId, options, y, hideFixed);
    } catch (err) {
      lastErr = err;
      if (attempt < STEP_RETRY_ATTEMPTS - 1) {
        // Cheap and harmless to redo even for a pure timing mismatch (not just messaging
        // failures): re-injecting/re-measuring re-resolves the same scroll target in the
        // normal case, and recovers it if the tab reloaded/navigated in between.
        await injectContentScript(tabId).catch(() => {});
        await sendToTab(tabId, { type: 'scc:getMetrics' }).catch(() => {});
        if (options.hideFixed) await sendToTab(tabId, { type: 'scc:prepare' }).catch(() => {});
        await sleep(STEP_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

// Some virtualized viewers only firm up their true total scrollHeight once you've scrolled
// far enough for more content to mount — the value read at session start can understate it,
// which previously made the scan conclude (and report "done") before actually reaching the
// real end, with the exact tile count varying run to run depending on measurement timing.
// Called whenever the scan is about to conclude; extends `positions` in place (continuing
// the same step pattern from its current last entry) if the page has grown since, and
// returns whether it did.
async function tryExtendScan(tabId, meta, positions, options, capturedSoFar) {
  const extent = await sendToTab(tabId, { type: 'scc:getScrollExtent' }).catch(() => null);
  if (!extent) return false;
  const clientHeight = extent.clientHeight || meta.metrics.clientHeight;
  if (extent.scrollHeight <= meta.metrics.scrollHeight + 5) return false;

  const step = Math.max(1, clientHeight - Math.max(0, Math.min(options.overlapPx || 0, clientHeight - 1)));
  const newMaxStart = Math.max(0, extent.scrollHeight - clientHeight);
  let y = positions[positions.length - 1] + step;
  while (y < newMaxStart) {
    positions.push(y);
    y += step;
  }
  if (newMaxStart > positions[positions.length - 1]) {
    positions.push(newMaxStart);
  }

  meta.metrics.scrollHeight = extent.scrollHeight;
  meta.metrics.clientHeight = clientHeight;
  meta.total = positions.length;
  await saveMeta(tabId, meta);
  broadcastProgress({ tabId, current: capturedSoFar, total: positions.length });
  return true;
}

// Runs positions[startIndex..end], persisting each tile as it's captured, and returns as
// soon as it's paused/stopped/cancelled/errors/finishes — it never waits idly for anything.
// Used for the initial pass, for "再開", and for "ここから撮り直す" alike.
async function runLoop(tabId, windowId, meta, startIndex) {
  const live = { pauseRequested: false, cancelRequested: false, stopRequested: false, jumpToIndex: null };
  liveLoops.set(tabId, live);
  activeCaptures.add(tabId);

  const positions = meta.positions;
  const options = meta.options;
  let i = startIndex;

  try {
    while (true) {
      if (live.cancelRequested) {
        meta.phase = 'cancelled';
        await saveMeta(tabId, meta);
        return { status: 'cancelled' };
      }
      if (live.stopRequested || live.pauseRequested) {
        meta.phase = live.stopRequested ? 'review' : 'paused';
        meta.nextIndex = i;
        await saveMeta(tabId, meta);
        if (live.stopRequested) {
          broadcastCaptureFinished(tabId, { total: i });
          await showTabProgress(tabId, 'キャプチャ完了。パネルで確認し「編集画面へ」を押してください。').catch(() => {});
        }
        return { status: live.stopRequested ? 'review' : 'paused' };
      }
      if (live.jumpToIndex != null) {
        const jumpIndex = live.jumpToIndex;
        live.jumpToIndex = null;
        if (jumpIndex < i) {
          await clearTilesFrom(tabId, jumpIndex, positions.length);
        }
        i = jumpIndex;
      }

      if (i >= positions.length) {
        if (await tryExtendScan(tabId, meta, positions, options, i)) continue;
        break;
      }

      await showTabProgress(tabId, `キャプチャ中... (${i + 1}/${positions.length})`);

      let stepResult;
      try {
        stepResult = await captureStepWithRetries(tabId, windowId, options, positions[i], !!options.hideFixed && i > 0);
      } catch (err) {
        meta.phase = 'error';
        meta.errorMessage = String((err && err.message) || err);
        meta.errorIndex = i;
        meta.nextIndex = i;
        await saveMeta(tabId, meta);
        broadcastCaptureError(tabId, { message: meta.errorMessage, positionIndex: i });
        await showTabProgress(
          tabId,
          'エラーが発生したため一時停止しました。パネルの案内に従って対処後「再開」を押してください。'
        ).catch(() => {});
        return { status: 'error' };
      }

      await saveTile(tabId, i, { y: stepResult.scrollY, dataUrl: stepResult.dataUrl, containerRect: stepResult.containerRect });
      broadcastProgress({ tabId, current: i + 1, total: positions.length });
      broadcastTileCaptured(tabId, stepResult.dataUrl, stepResult.scrollY, i, positions.length);
      i++;
    }

    meta.phase = 'review';
    meta.nextIndex = positions.length;
    await saveMeta(tabId, meta);
    broadcastCaptureFinished(tabId, { total: positions.length });
    await showTabProgress(tabId, 'キャプチャ完了。パネルで確認し「編集画面へ」を押してください。').catch(() => {});
    return { status: 'review' };
  } finally {
    liveLoops.delete(tabId);
    activeCaptures.delete(tabId);
  }
}

// Handles the one truly terminal outcome a loop can produce on its own: cancellation.
async function wrapUpIfCancelled(tabId, meta, result) {
  if (result.status !== 'cancelled') return false;
  await sendToTab(tabId, { type: meta.kind === 'pageturn' ? 'scc:restorePageTurn' : 'scc:restore' }).catch(() => {});
  await clearTilesFrom(tabId, 0, meta.total);
  await clearMeta(tabId);
  broadcastCaptureEnded(tabId, { cancelled: true });
  return true;
}

// --- Page-turn (click-through) capture mode ---------------------------------------------
//
// For paginated readers that turn pages via a "next" button instead of scrolling. Captures
// are NOT stitched into one long image (unlike scroll mode) — each click+capture is its own
// independent page from the start. Reuses the same tile storage helpers (tileKey/saveTile/
// loadDenseTiles/clearTilesFrom) since "one image per index" is exactly what those already
// do; only the capture STEP itself (click+wait+capture instead of scroll+settle+capture) and
// the final assembly (a flat page array instead of a stitched composite) differ.

async function captureCurrentViewWithRetries(tabId, windowId, options) {
  let lastErr;
  for (let attempt = 0; attempt < STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      // See the equivalent hide/show in scrollSettleCaptureVerify — same reason: the banner is
      // part of the captured page's own DOM, so it must be hidden for the instant of the
      // screenshot or it shows up in every captured page.
      await sendToTab(tabId, { type: 'scc:setProgressBannerHidden', hidden: true }).catch(() => {});
      const dataUrl = await captureVisibleTabWithRetry(windowId, {
        format: options.format === 'jpeg' ? 'jpeg' : 'png',
        quality: options.format === 'jpeg' ? options.quality || 90 : undefined
      });
      await sendToTab(tabId, { type: 'scc:setProgressBannerHidden', hidden: false }).catch(() => {});
      return { dataUrl };
    } catch (err) {
      lastErr = err;
      if (attempt < STEP_RETRY_ATTEMPTS - 1) await sleep(STEP_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// Runs positions[startIndex..total), persisting each page as it's captured. Page 0 is
// captured as-is (whatever the user had on screen when they finished setup); every
// subsequent page clicks the pre-picked "next" button, waits clickDelayMs, then captures.
async function runPageTurnLoop(tabId, windowId, meta, startIndex) {
  const live = { pauseRequested: false, cancelRequested: false, stopRequested: false, jumpToIndex: null };
  liveLoops.set(tabId, live);
  activeCaptures.add(tabId);

  const options = meta.options;
  let i = startIndex;

  try {
    while (true) {
      if (live.cancelRequested) {
        meta.phase = 'cancelled';
        await saveMeta(tabId, meta);
        return { status: 'cancelled' };
      }
      if (live.stopRequested || live.pauseRequested) {
        meta.phase = live.stopRequested ? 'review' : 'paused';
        meta.nextIndex = i;
        await saveMeta(tabId, meta);
        if (live.stopRequested) {
          broadcastCaptureFinished(tabId, { total: i });
          await showTabProgress(tabId, 'キャプチャ完了。パネルで確認し「編集画面へ」を押してください。').catch(() => {});
        }
        return { status: live.stopRequested ? 'review' : 'paused' };
      }
      if (live.jumpToIndex != null) {
        const jumpIndex = live.jumpToIndex;
        live.jumpToIndex = null;
        if (jumpIndex < i) {
          await clearTilesFrom(tabId, jumpIndex, meta.total);
        }
        i = jumpIndex;
      }

      if (i >= meta.total) break;

      await showTabProgress(tabId, `キャプチャ中... (${i + 1}/${meta.total})`);

      try {
        if (i > 0) {
          const clickResult = await sendToTab(tabId, { type: 'scc:clickNextButton' }).catch(() => ({ error: 'messaging_failed' }));
          if (!clickResult || clickResult.error) {
            throw new Error(
              clickResult && clickResult.error === 'target_lost'
                ? '「次のページ」ボタンが見つかりません（ページの構造が変わった可能性があります）'
                : 'ページ送りに失敗しました'
            );
          }
          await sleep(Math.max(options.clickDelayMs || 0, MIN_CAPTURE_INTERVAL_MS));
        }
        const stepResult = await captureCurrentViewWithRetries(tabId, windowId, options);
        await saveTile(tabId, i, { dataUrl: stepResult.dataUrl });
        broadcastProgress({ tabId, current: i + 1, total: meta.total });
        broadcastTileCaptured(tabId, stepResult.dataUrl, null, i, meta.total);
        i++;
      } catch (err) {
        meta.phase = 'error';
        meta.errorMessage = String((err && err.message) || err);
        meta.errorIndex = i;
        meta.nextIndex = i;
        await saveMeta(tabId, meta);
        broadcastCaptureError(tabId, { message: meta.errorMessage, positionIndex: i });
        await showTabProgress(
          tabId,
          'エラーが発生したため一時停止しました。パネルの案内に従って対処後「再開」を押してください。'
        ).catch(() => {});
        return { status: 'error' };
      }
    }

    meta.phase = 'review';
    meta.nextIndex = meta.total;
    await saveMeta(tabId, meta);
    broadcastCaptureFinished(tabId, { total: meta.total });
    await showTabProgress(tabId, 'キャプチャ完了。パネルで確認し「編集画面へ」を押してください。').catch(() => {});
    return { status: 'review' };
  } finally {
    liveLoops.delete(tabId);
    activeCaptures.delete(tabId);
  }
}

async function startPageTurnCaptureFlow(tabId, windowId, options) {
  if (activeCaptures.has(tabId)) {
    throw new Error('このタブは既にキャプチャ中です');
  }
  const stale = await loadMeta(tabId);
  if (stale) {
    await clearTilesFrom(tabId, 0, stale.total || 0);
    await clearMeta(tabId);
  }

  await injectContentScript(tabId);
  const pickResult = await sendToTab(tabId, { type: 'scc:pickNextButton' });
  if (!pickResult || !pickResult.picked) {
    return { status: 'cancelled', picked: false };
  }

  openControlPanel(tabId).catch(() => {});

  const total = Math.max(1, Number(options.pageCount) || 1);
  const meta = {
    tabId,
    windowId,
    kind: 'pageturn',
    total,
    options,
    phase: 'capturing',
    nextIndex: 0,
    errorMessage: null,
    errorIndex: null,
    createdAt: Date.now()
  };
  await saveMeta(tabId, meta);
  broadcastProgress({ tabId, current: 0, total });

  const result = await runPageTurnLoop(tabId, windowId, meta, 0);
  await wrapUpIfCancelled(tabId, meta, result);
  return result;
}

async function finalizePageTurnCaptureFlow(tabId) {
  const meta = await loadMeta(tabId);
  if (!meta) throw new Error('セッションが見つかりません');

  const tiles = await loadDenseTiles(tabId, meta.total);
  await sendToTab(tabId, { type: 'scc:restorePageTurn' }).catch(() => {});

  if (tiles.length === 0) {
    await clearTilesFrom(tabId, 0, meta.total);
    await clearMeta(tabId);
    broadcastCaptureEnded(tabId, { cancelled: true });
    return { cancelled: true };
  }

  const sessionId = `scc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id: sessionId,
    createdAt: Date.now(),
    kind: 'pageturn',
    meta: {
      sourceTabId: tabId,
      captureOptions: {
        clickDelayMs: meta.options.clickDelayMs,
        format: meta.options.format,
        quality: meta.options.quality
      }
    },
    pages: tiles.map((t, i) => ({ index: i, dataUrl: t.dataUrl }))
  };

  await chrome.storage.local.set({ [sessionId]: session });

  const editorTab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`editor/editor.html?session=${sessionId}`)
  });
  if (editorTab && editorTab.id != null) {
    await chrome.storage.session.set({ [`tabmap_${editorTab.id}`]: sessionId });
  }

  await clearTilesFrom(tabId, 0, meta.total);
  await clearMeta(tabId);
  broadcastCaptureEnded(tabId, { cancelled: false, sessionId });
  return { sessionId };
}

async function startCaptureFlow(tabId, windowId, options) {
  if (activeCaptures.has(tabId)) {
    throw new Error('このタブは既にキャプチャ中です');
  }
  const stale = await loadMeta(tabId);
  if (stale) {
    await clearTilesFrom(tabId, 0, stale.total || 0);
    await clearMeta(tabId);
  }

  openControlPanel(tabId).catch(() => {});
  await injectContentScript(tabId);

  const metrics = await sendToTab(tabId, { type: 'scc:getMetrics' });
  const startY = options.startFromCurrentPosition ? metrics.currentScrollTop || 0 : 0;
  const positions = computePositions(metrics.scrollHeight, metrics.clientHeight, options.overlapPx, startY);

  if (options.hideFixed) {
    await sendToTab(tabId, { type: 'scc:prepare' });
  }

  const meta = {
    tabId,
    windowId,
    total: positions.length,
    positions,
    options,
    metrics,
    phase: 'capturing',
    nextIndex: 0,
    errorMessage: null,
    errorIndex: null,
    createdAt: Date.now()
  };
  await saveMeta(tabId, meta);
  broadcastProgress({ tabId, current: 0, total: positions.length });

  const result = await runLoop(tabId, windowId, meta, 0);
  await wrapUpIfCancelled(tabId, meta, result);
  return result;
}

async function performCaptureWithPicker(tabId, windowId, options) {
  await injectContentScript(tabId);
  const pickResult = await sendToTab(tabId, { type: 'scc:pick' });
  if (!pickResult || !pickResult.picked) {
    return { status: 'cancelled', picked: false };
  }
  return startCaptureFlow(tabId, windowId, options);
}

async function finalizeCaptureFlow(tabId) {
  const meta = await loadMeta(tabId);
  if (!meta) throw new Error('セッションが見つかりません');

  const tiles = await loadDenseTiles(tabId, meta.total);
  await sendToTab(tabId, { type: 'scc:restore' }).catch(() => {});

  if (tiles.length === 0) {
    await clearTilesFrom(tabId, 0, meta.total);
    await clearMeta(tabId);
    broadcastCaptureEnded(tabId, { cancelled: true });
    return { cancelled: true };
  }

  const sessionId = `scc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id: sessionId,
    createdAt: Date.now(),
    meta: {
      mode: meta.metrics.mode,
      viewportWidth: meta.metrics.viewportWidth,
      viewportHeight: meta.metrics.viewportHeight,
      scrollWidth: meta.metrics.scrollWidth,
      scrollHeight: meta.metrics.scrollHeight,
      clientWidth: meta.metrics.clientWidth,
      clientHeight: meta.metrics.clientHeight,
      containerRect: meta.metrics.containerRect,
      devicePixelRatio: meta.metrics.devicePixelRatio,
      overlapPx: meta.options.overlapPx || 0,
      sourceTitle: meta.metrics.sourceTitle,
      sourceUrl: meta.metrics.sourceUrl,
      sourceTabId: tabId,
      captureOptions: {
        delayMs: meta.options.delayMs,
        format: meta.options.format,
        quality: meta.options.quality,
        hideFixed: meta.options.hideFixed,
        overlapPx: meta.options.overlapPx || 0
      }
    },
    tiles
  };

  await chrome.storage.local.set({ [sessionId]: session });

  const editorTab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`editor/editor.html?session=${sessionId}`)
  });
  if (editorTab && editorTab.id != null) {
    await chrome.storage.session.set({ [`tabmap_${editorTab.id}`]: sessionId });
  }

  await clearTilesFrom(tabId, 0, meta.total);
  await clearMeta(tabId);
  broadcastCaptureEnded(tabId, { cancelled: false, sessionId });
  return { sessionId };
}

// Re-captures a single already-finished tile from the editor, once a session is fully
// finalized and saved (no live capture loop is depending on shared content-script state
// anymore, so it's safe/correct to re-resolve the scroll target and restore afterwards).
async function recaptureTile(tabId, windowId, y, options, hideFixed) {
  await injectContentScript(tabId);
  await sendToTab(tabId, { type: 'scc:getMetrics' });
  if (options.hideFixed) await sendToTab(tabId, { type: 'scc:prepare' });

  let lastErr;
  for (let attempt = 0; attempt < STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await scrollSettleCaptureVerify(tabId, windowId, options, y, hideFixed);
      await sendToTab(tabId, { type: 'scc:restore' }).catch(() => {});
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < STEP_RETRY_ATTEMPTS - 1) {
        await sendToTab(tabId, { type: 'scc:getMetrics' }).catch(() => {});
        if (options.hideFixed) await sendToTab(tabId, { type: 'scc:prepare' }).catch(() => {});
        await sleep(STEP_RETRY_DELAY_MS);
      }
    }
  }
  await sendToTab(tabId, { type: 'scc:restore' }).catch(() => {});
  throw lastErr;
}

// Same as above, but lets the user click the scroll target first (for sessions that were
// originally captured via the manual picker, where auto-detection may not find the same
// element on its own).
async function pickAndRecaptureTile(tabId, windowId, y, options, hideFixed) {
  await injectContentScript(tabId);
  const pickResult = await sendToTab(tabId, { type: 'scc:pick' });
  if (!pickResult || !pickResult.picked) {
    return { cancelled: true };
  }
  await sendToTab(tabId, { type: 'scc:getMetrics' });
  if (options.hideFixed) await sendToTab(tabId, { type: 'scc:prepare' });

  let lastErr;
  for (let attempt = 0; attempt < STEP_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await scrollSettleCaptureVerify(tabId, windowId, options, y, hideFixed);
      await sendToTab(tabId, { type: 'scc:restore' }).catch(() => {});
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < STEP_RETRY_ATTEMPTS - 1) {
        await sendToTab(tabId, { type: 'scc:getMetrics' }).catch(() => {});
        if (options.hideFixed) await sendToTab(tabId, { type: 'scc:prepare' }).catch(() => {});
        await sleep(STEP_RETRY_DELAY_MS);
      }
    }
  }
  await sendToTab(tabId, { type: 'scc:restore' }).catch(() => {});
  throw lastErr;
}

// --- Watchdog: keep a long, unattended capture actually finishing ------------------------
//
// A capture that's meant to run for hours unattended (started before bed, checked the next
// morning) can outlive the service worker itself — MV3 workers can be killed and restarted
// for reasons that have nothing to do with the capture (Chrome deciding it's been running
// too long, a browser update, etc). When that happens mid-loop, the tiles captured so far are
// already safely in storage (each one is saved as it's captured), but the loop itself just
// stops silently — nobody was there to notice and click "再開". This periodically checks for
// exactly that situation (a draft still marked "capturing" but with no loop actually running
// for it in this service worker instance — which, if the worker really did just start up
// fresh, means the previous run was cut off, not that it's still in progress) and resumes it
// from where it left off, so an interruption self-heals instead of just quietly stalling.
//
// activeCaptures is the same in-memory guard startCaptureFlow/etc. already use to block
// double-starts — if the worker DIDN'T restart and a loop for this tab is genuinely still
// running, this tab's id is already in there, so there is no risk of starting a second
// concurrent loop over the same capture.
const WATCHDOG_ALARM_NAME = 'scc-watchdog';
chrome.alarms.create(WATCHDOG_ALARM_NAME, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM_NAME) resumeStalledCaptures().catch(() => {});
});

async function resumeStalledCaptures() {
  const store = await chrome.storage.local.get(DRAFT_INDEX_KEY);
  const tabIds = store[DRAFT_INDEX_KEY] || [];
  for (const tabId of tabIds) {
    if (activeCaptures.has(tabId)) continue;
    const meta = await loadMeta(tabId);
    if (!meta || meta.phase !== 'capturing') continue;
    const runner = meta.kind === 'pageturn' ? runPageTurnLoop : runLoop;
    try {
      const result = await runner(tabId, meta.windowId, meta, meta.nextIndex || 0);
      await wrapUpIfCancelled(tabId, meta, result);
    } catch (_err) {
      // Best-effort: if this particular draft can't be resumed right now (e.g. its source tab
      // is genuinely gone), leave it as-is for the next tick or for manual recovery rather
      // than letting one bad draft stop the watchdog from checking the others.
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'scc:startCapture') {
    startCaptureFlow(msg.tabId, msg.windowId, msg.options)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === 'scc:startCaptureWithPicker') {
    performCaptureWithPicker(msg.tabId, msg.windowId, msg.options)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === 'scc:startPageTurnCapture') {
    startPageTurnCaptureFlow(msg.tabId, msg.windowId, msg.options)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === 'scc:getCaptureStatus') {
    (async () => {
      const meta = await loadMeta(msg.tabId);
      if (!meta) {
        sendResponse({ active: false });
        return;
      }
      const tiles = await loadDenseTiles(msg.tabId, meta.total);
      sendResponse({
        active: true,
        kind: meta.kind || 'scroll',
        total: meta.total,
        current: tiles.length,
        paused: meta.phase === 'paused' || meta.phase === 'error',
        finished: meta.phase === 'review',
        options: meta.options,
        tiles
      });
    })();
    return true;
  }
  if (msg.type === 'scc:listDrafts') {
    // Lets the popup show a recovery banner for a capture that never made it to the editor —
    // e.g. a long unattended run (started before bed, checked the next morning) where the
    // source tab, the panel window, or the whole browser didn't survive the night intact.
    // Deliberately cheap: reads only the small index + per-draft meta objects, never the
    // (potentially huge, for an all-night capture) tile image data.
    (async () => {
      const store = await chrome.storage.local.get(DRAFT_INDEX_KEY);
      const tabIds = store[DRAFT_INDEX_KEY] || [];
      const drafts = [];
      for (const tabId of tabIds) {
        const meta = await loadMeta(tabId);
        if (!meta) continue;
        const current = meta.nextIndex || 0;
        if (current <= 0) continue; // nothing captured yet, nothing to recover
        let title = (meta.metrics && (meta.metrics.sourceTitle || meta.metrics.sourceUrl)) || null;
        if (!title) {
          try {
            const tab = await chrome.tabs.get(tabId);
            title = tab.title || tab.url || null;
          } catch (_e) {
            title = null; // source tab is gone — still recoverable, just can't show a title
          }
        }
        drafts.push({ tabId, kind: meta.kind || 'scroll', total: meta.total, current, phase: meta.phase, title });
      }
      sendResponse({ drafts });
    })();
    return true;
  }
  if (msg.type === 'scc:pauseCapture') {
    const live = liveLoops.get(msg.tabId);
    if (live) live.pauseRequested = true;
    showTabProgress(msg.tabId, '一時停止中...');
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'scc:resumeCapture') {
    (async () => {
      try {
        if (activeCaptures.has(msg.tabId)) {
          sendResponse({ ok: true });
          return;
        }
        const meta = await loadMeta(msg.tabId);
        if (!meta) {
          sendResponse({ ok: false, error: 'session_lost' });
          return;
        }
        meta.phase = 'capturing';
        await saveMeta(msg.tabId, meta);
        const runner = meta.kind === 'pageturn' ? runPageTurnLoop : runLoop;
        const result = await runner(msg.tabId, meta.windowId, meta, meta.nextIndex || 0);
        await wrapUpIfCancelled(msg.tabId, meta, result);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  if (msg.type === 'scc:stopCaptureEarly') {
    // If a loop is actively running, just flag it and let it wind down on its own. But if
    // capture is currently paused (or stalled on an error), there is no live loop at all —
    // runLoop's finally block removes it from liveLoops as soon as it returns for a pause —
    // so nothing would ever notice a flag set at that point. Transition straight to the
    // review phase ourselves in that case instead.
    (async () => {
      const live = liveLoops.get(msg.tabId);
      if (live) {
        live.stopRequested = true;
        sendResponse({ ok: true });
        return;
      }
      const meta = await loadMeta(msg.tabId);
      if (!meta) {
        sendResponse({ ok: false, error: 'session_lost' });
        return;
      }
      meta.phase = 'review';
      await saveMeta(msg.tabId, meta);
      const tiles = await loadDenseTiles(msg.tabId, meta.total);
      broadcastCaptureFinished(msg.tabId, { total: tiles.length });
      await showTabProgress(msg.tabId, 'キャプチャ完了。パネルで確認し「編集画面へ」を押してください。').catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'scc:cancelCapture') {
    (async () => {
      const live = liveLoops.get(msg.tabId);
      if (live) {
        live.cancelRequested = true;
        sendResponse({ ok: true });
        return;
      }
      const meta = await loadMeta(msg.tabId);
      if (!meta) {
        sendResponse({ ok: false, error: 'session_lost' });
        return;
      }
      await sendToTab(msg.tabId, { type: meta.kind === 'pageturn' ? 'scc:restorePageTurn' : 'scc:restore' }).catch(() => {});
      await clearTilesFrom(msg.tabId, 0, meta.total);
      await clearMeta(msg.tabId);
      broadcastCaptureEnded(msg.tabId, { cancelled: true });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'scc:finalizeCapture') {
    (async () => {
      try {
        const meta = await loadMeta(msg.tabId);
        const fn = meta && meta.kind === 'pageturn' ? finalizePageTurnCaptureFlow : finalizeCaptureFlow;
        const result = await fn(msg.tabId);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  if (msg.type === 'scc:retryFrom') {
    // Discard the tile at positionIndex and everything captured after it, then rewind so
    // it re-captures starting from that same scroll position and continues. Works whether
    // a loop is actively running right now (mid pause) or fully idle (post-capture review).
    (async () => {
      const live = liveLoops.get(msg.tabId);
      if (live) {
        live.jumpToIndex = msg.positionIndex;
        sendResponse({ ok: true });
        return;
      }
      try {
        if (activeCaptures.has(msg.tabId)) {
          sendResponse({ ok: true });
          return;
        }
        const meta = await loadMeta(msg.tabId);
        if (!meta) {
          sendResponse({ ok: false, error: 'session_lost' });
          return;
        }
        await clearTilesFrom(msg.tabId, msg.positionIndex, meta.total);
        meta.phase = 'capturing';
        await saveMeta(msg.tabId, meta);
        const runner = meta.kind === 'pageturn' ? runPageTurnLoop : runLoop;
        const result = await runner(msg.tabId, meta.windowId, meta, msg.positionIndex);
        await wrapUpIfCancelled(msg.tabId, meta, result);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  if (msg.type === 'scc:reopenPanel') {
    // Used by the popup's recovery banner to get back to a draft whose panel window (or the
    // whole browser) didn't survive to the next time the user opened the popup.
    openControlPanel(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === 'scc:reloadTab') {
    chrome.tabs
      .reload(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === 'scc:recaptureTileInPlace') {
    // Used from the live panel, during an active session (paused or in the post-capture
    // review phase): replaces just one tile without touching any other tile, and without
    // ever calling scc:restore — that would reset the content script's shared scroll
    // target, breaking every subsequent "ここから撮り直す" for the rest of the session.
    (async () => {
      try {
        const meta = await loadMeta(msg.tabId);
        if (!meta) {
          sendResponse({ ok: false, error: 'session_lost' });
          return;
        }
        const result = await captureStepWithRetries(msg.tabId, meta.windowId, meta.options, msg.y, msg.hideFixed);
        await saveTile(msg.tabId, msg.positionIndex, {
          y: result.scrollY,
          dataUrl: result.dataUrl,
          containerRect: result.containerRect
        });
        broadcastTileUpdated(msg.tabId, msg.positionIndex, result.dataUrl);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  if (msg.type === 'scc:recapturePageTurnTileInPlace') {
    // Live-panel version, during an active page-turn session (paused or in post-capture
    // review): the human has already manually navigated the source tab to the page they want
    // — this just captures whatever is currently on screen, no click, no navigation.
    (async () => {
      try {
        const meta = await loadMeta(msg.tabId);
        if (!meta) {
          sendResponse({ ok: false, error: 'session_lost' });
          return;
        }
        const result = await captureCurrentViewWithRetries(msg.tabId, meta.windowId, meta.options);
        await saveTile(msg.tabId, msg.positionIndex, { dataUrl: result.dataUrl });
        broadcastTileUpdated(msg.tabId, msg.positionIndex, result.dataUrl);
        sendResponse({ ok: true, dataUrl: result.dataUrl });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  if (msg.type === 'scc:recapturePageTurnTile') {
    // Post-finalize version, called from the editor: same "capture whatever's on screen"
    // behavior, but the session is already saved (no draft meta left), so options come
    // straight from the message (mirrors scc:recaptureTile for scroll mode).
    (async () => {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        if (!msg.force && msg.expectedUrl && tab.url && tab.url !== msg.expectedUrl) {
          sendResponse({ ok: false, error: 'tab_mismatch', tabUrl: tab.url });
          return;
        }
        const result = await captureCurrentViewWithRetries(msg.tabId, tab.windowId, msg.options || {});
        sendResponse({ ok: true, dataUrl: result.dataUrl });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  if (msg.type === 'scc:recaptureTile' || msg.type === 'scc:pickAndRecaptureTile') {
    (async () => {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        if (!msg.force && msg.expectedUrl && tab.url && tab.url !== msg.expectedUrl) {
          sendResponse({ ok: false, error: 'tab_mismatch', tabUrl: tab.url });
          return;
        }
        const fn = msg.type === 'scc:pickAndRecaptureTile' ? pickAndRecaptureTile : recaptureTile;
        const result = await fn(msg.tabId, tab.windowId, msg.y, msg.options, msg.hideFixed);
        if (result.cancelled) {
          sendResponse({ ok: false, cancelled: true });
        } else {
          sendResponse({ ok: true, ...result });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = `tabmap_${tabId}`;
  const record = await chrome.storage.session.get(key);
  const sessionId = record[key];
  if (sessionId) {
    await chrome.storage.local.remove(sessionId);
    await chrome.storage.session.remove(key);
  }

  // The source tab closing mid-capture used to unconditionally discard the whole draft —
  // "there's no way to continue capturing from a tab that no longer exists". True, but for a
  // long unattended run (e.g. started before going to sleep, checked the next morning) the
  // tab can end up closed for all sorts of reasons having nothing to do with the user wanting
  // to abandon it: the computer slept, Chrome auto-restarted for an update, the tab crashed
  // under a very long run, etc. Throwing away hours of already-captured tiles in that case is
  // exactly the failure this is meant to avoid. Only discard when NOTHING was captured yet
  // (nothing to lose); otherwise treat it the same as "ここまでで終了" — preserve every tile
  // captured so far and leave it in the review phase so it can still be recovered later (see
  // scc:listDrafts / the popup's recovery banner), rather than erroring with "internal state
  // lost" the next time someone tries to reach the editor.
  const meta = await loadMeta(tabId);
  if (meta) {
    const tiles = await loadDenseTiles(tabId, meta.total);
    if (tiles.length === 0) {
      await clearTilesFrom(tabId, 0, meta.total);
      await clearMeta(tabId);
    } else if (meta.phase !== 'review') {
      meta.phase = 'review';
      meta.nextIndex = tiles.length;
      await saveMeta(tabId, meta);
    }
  }
});
