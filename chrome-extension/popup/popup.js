const els = {
  modeScroll: document.getElementById('modeScroll'),
  modePageTurn: document.getElementById('modePageTurn'),
  scrollSettings: document.getElementById('scrollSettings'),
  pageTurnSettings: document.getElementById('pageTurnSettings'),
  delay: document.getElementById('delay'),
  format: document.getElementById('format'),
  quality: document.getElementById('quality'),
  qualityRow: document.getElementById('qualityRow'),
  hideFixed: document.getElementById('hideFixed'),
  overlap: document.getElementById('overlap'),
  startFromCurrentPosition: document.getElementById('startFromCurrentPosition'),
  pageCount: document.getElementById('pageCount'),
  clickDelay: document.getElementById('clickDelay'),
  startBtn: document.getElementById('startBtn'),
  pickBtn: document.getElementById('pickBtn'),
  scrollPickHint: document.getElementById('scrollPickHint'),
  pageTurnStartBtn: document.getElementById('pageTurnStartBtn'),
  pageTurnHint: document.getElementById('pageTurnHint'),
  recoveryBanner: document.getElementById('recoveryBanner'),
  recoveryText: document.getElementById('recoveryText'),
  recoveryBtn: document.getElementById('recoveryBtn'),
  status: document.getElementById('status')
};

const DEFAULTS = {
  mode: 'scroll',
  delayMs: 600,
  format: 'png',
  quality: 90,
  hideFixed: true,
  overlapPx: 0,
  startFromCurrentPosition: false,
  pageCount: 10,
  clickDelayMs: 500
};

async function loadSettings() {
  const { sccSettings } = await chrome.storage.sync.get('sccSettings');
  return { ...DEFAULTS, ...(sccSettings || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ sccSettings: settings });
}

function applyToForm(settings) {
  els.modeScroll.checked = settings.mode !== 'pageturn';
  els.modePageTurn.checked = settings.mode === 'pageturn';
  els.delay.value = settings.delayMs;
  els.format.value = settings.format;
  els.quality.value = settings.quality;
  els.hideFixed.checked = settings.hideFixed;
  els.overlap.value = settings.overlapPx;
  els.startFromCurrentPosition.checked = settings.startFromCurrentPosition;
  els.pageCount.value = settings.pageCount;
  els.clickDelay.value = settings.clickDelayMs;
  els.qualityRow.style.display = settings.format === 'jpeg' ? '' : 'none';
  updateModeUI();
}

function currentMode() {
  return els.modePageTurn.checked ? 'pageturn' : 'scroll';
}

function updateModeUI() {
  const isPageTurn = currentMode() === 'pageturn';
  els.scrollSettings.hidden = isPageTurn;
  els.pageTurnSettings.hidden = !isPageTurn;
  els.startBtn.hidden = isPageTurn;
  els.pickBtn.hidden = isPageTurn;
  els.scrollPickHint.hidden = isPageTurn;
  els.pageTurnStartBtn.hidden = !isPageTurn;
  els.pageTurnHint.hidden = !isPageTurn;
}

function readForm() {
  return {
    mode: currentMode(),
    delayMs: Math.max(0, Number(els.delay.value) || 0),
    format: els.format.value,
    quality: Math.min(100, Math.max(1, Number(els.quality.value) || 90)),
    hideFixed: els.hideFixed.checked,
    overlapPx: Math.max(0, Number(els.overlap.value) || 0),
    startFromCurrentPosition: els.startFromCurrentPosition.checked,
    pageCount: Math.max(1, Number(els.pageCount.value) || 1),
    clickDelayMs: Math.max(0, Number(els.clickDelay.value) || 0)
  };
}

els.format.addEventListener('change', () => {
  els.qualityRow.style.display = els.format.value === 'jpeg' ? '' : 'none';
});

els.modeScroll.addEventListener('change', updateModeUI);
els.modePageTurn.addEventListener('change', updateModeUI);

async function getCapturableActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    els.status.textContent = 'アクティブなタブが見つかりません。';
    return null;
  }
  if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
    els.status.textContent = 'このページはキャプチャできません（ブラウザの内部ページ）。';
    return null;
  }
  return tab;
}

// All flows hand off to a dedicated control-panel window (background.js opens it) that shows
// live progress, captured thumbnails, and pause/resume/stop/cancel controls, so the popup
// itself only needs to kick things off and can close immediately.

els.startBtn.addEventListener('click', async () => {
  const settings = readForm();
  await saveSettings(settings);

  const tab = await getCapturableActiveTab();
  if (!tab) return;

  chrome.runtime
    .sendMessage({
      type: 'scc:startCapture',
      tabId: tab.id,
      windowId: tab.windowId,
      options: settings
    })
    .catch(() => {});

  window.close();
});

els.pickBtn.addEventListener('click', async () => {
  const settings = readForm();
  await saveSettings(settings);

  const tab = await getCapturableActiveTab();
  if (!tab) return;

  chrome.runtime
    .sendMessage({
      type: 'scc:startCaptureWithPicker',
      tabId: tab.id,
      windowId: tab.windowId,
      options: settings
    })
    .catch(() => {});

  // The popup will close as soon as the user clicks on the page to pick the
  // scroll target, so there is nothing useful left to await here.
  window.close();
});

els.pageTurnStartBtn.addEventListener('click', async () => {
  const settings = readForm();
  await saveSettings(settings);

  const tab = await getCapturableActiveTab();
  if (!tab) return;

  chrome.runtime
    .sendMessage({
      type: 'scc:startPageTurnCapture',
      tabId: tab.id,
      windowId: tab.windowId,
      options: settings
    })
    .catch(() => {});

  // Closes immediately, same as pickBtn: the user now interacts with the page itself to
  // pick the "next page" button, which happens entirely in background.js/content-script.js.
  window.close();
});

// Shows a recovery banner if there's a draft capture that never made it to the editor — e.g.
// a long unattended run (started before bed, checked the next morning) where the source tab,
// the panel window, or the whole browser didn't survive intact. Without this, the only way to
// notice was opening the (now-closed) panel and getting a dead-end "internal state lost"
// error; this surfaces it right in the popup instead, with a button that gets back to it.
async function checkForRecoverableDrafts() {
  const response = await chrome.runtime.sendMessage({ type: 'scc:listDrafts' }).catch(() => null);
  const drafts = (response && response.drafts) || [];
  if (drafts.length === 0) return;

  // In practice there's normally at most one; if several piled up, just offer the first and
  // mention there are more.
  const draft = drafts[0];
  const kindLabel = draft.kind === 'pageturn' ? 'ページ送り' : 'スクロール';
  const titlePart = draft.title ? `「${draft.title}」の` : '';
  const countPart = draft.total ? `${draft.current} / ${draft.total} ページ` : `${draft.current} ページ`;
  const morePart = drafts.length > 1 ? `\n（他に${drafts.length - 1}件あります）` : '';
  els.recoveryText.textContent =
    `前回中断した${titlePart}${kindLabel}キャプチャが見つかりました（${countPart}撮影済み）。` +
    `確認画面を開いて、そのまま編集画面へ進めます。${morePart}`;
  els.recoveryBanner.hidden = false;

  els.recoveryBtn.addEventListener('click', async () => {
    els.recoveryBtn.disabled = true;
    const result = await chrome.runtime
      .sendMessage({ type: 'scc:reopenPanel', tabId: draft.tabId })
      .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    if (!result || !result.ok) {
      els.recoveryBtn.disabled = false;
      els.status.textContent = `確認画面を開けませんでした: ${(result && result.error) || '不明なエラー'}`;
      return;
    }
    window.close();
  });
}

(async () => {
  applyToForm(await loadSettings());
  checkForRecoverableDrafts();
})();
