const tabId = Number(new URLSearchParams(location.search).get('tabId'));

// MV3 service workers get suspended after ~30s of inactivity, which would otherwise wipe
// out the in-progress capture state (pause/review waits can last much longer than that
// while the user looks things over). An open long-lived port keeps the background script
// alive for as long as this panel window is open. Reconnect defensively if it ever drops.
function connectKeepAlive() {
  try {
    const port = chrome.runtime.connect({ name: 'scc-keepalive' });
    port.onDisconnect.addListener(() => {
      setTimeout(connectKeepAlive, 1000);
    });
  } catch (_err) {
    setTimeout(connectKeepAlive, 1000);
  }
}
connectKeepAlive();

const els = {
  statusText: document.getElementById('statusText'),
  progressBar: document.getElementById('progressBar'),
  countText: document.getElementById('countText'),
  finalizeBtn: document.getElementById('finalizeBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  errorBox: document.getElementById('errorBox'),
  errorText: document.getElementById('errorText'),
  errorHint: document.getElementById('errorHint'),
  reloadBtn: document.getElementById('reloadBtn'),
  tileListHeading: document.getElementById('tileListHeading'),
  tileList: document.getElementById('tileList')
};

let paused = false;
let reviewPhase = false; // true once the whole page has been captured once and is up for review
let ended = false;
let hasError = false;
let captureOptions = null;
let captureKind = 'scroll'; // 'scroll' | 'pageturn' — set once from scc:getCaptureStatus
const tileYs = new Map(); // index -> scrollY, needed to recapture a specific scroll tile later

function canRetryNow() {
  return paused || reviewPhase;
}

function setRetryButtonsEnabled(enabled) {
  els.tileList.querySelectorAll('.retry-btn, .recapture-btn').forEach((btn) => {
    btn.disabled = !enabled;
  });
}

function updateModeUI() {
  els.finalizeBtn.hidden = !reviewPhase;
  els.finalizeBtn.disabled = ended;
  els.pauseBtn.disabled = ended || reviewPhase;
  els.stopBtn.disabled = ended || reviewPhase;
  setRetryButtonsEnabled(canRetryNow() && !ended);
}

function removeTilesFrom(index) {
  els.tileList.querySelectorAll('.tile-thumb').forEach((el) => {
    if (Number(el.dataset.index) >= index) el.remove();
  });
}

function addTileThumb(dataUrl, index, y) {
  if (y != null) tileYs.set(index, y);

  const wrap = document.createElement('div');
  wrap.className = 'tile-thumb';
  wrap.dataset.index = String(index);

  const img = document.createElement('img');
  img.src = dataUrl;

  const row = document.createElement('div');
  row.className = 'tile-thumb-row';

  const label = document.createElement('span');
  label.className = 'tile-label';
  label.textContent = `#${index + 1}`;

  row.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'tile-thumb-actions';

  const isPageTurn = captureKind === 'pageturn';

  const retryBtn = document.createElement('button');
  retryBtn.className = 'retry-btn';
  retryBtn.textContent = isPageTurn ? 'ここから自動で続きを再開' : 'ここから撮り直す';
  retryBtn.disabled = !canRetryNow();
  retryBtn.addEventListener('click', async () => {
    removeTilesFrom(index);
    hideError();
    // scc:retryFrom always un-pauses/advances the loop on the background side, so reflect
    // that here immediately — otherwise the panel keeps showing a stale paused state while
    // capturing has actually already resumed. For page-turn mode this assumes the source
    // tab is still showing whatever page came right before #index (the loop clicks "next"
    // once before capturing #index again), same as resuming after a pause/error normally.
    paused = false;
    reviewPhase = false;
    updateModeUI();
    els.pauseBtn.textContent = '一時停止';
    els.statusText.textContent = `#${index + 1} からキャプチャをやり直しています...`;
    const response = await chrome.runtime.sendMessage({ type: 'scc:retryFrom', tabId, positionIndex: index });
    handleSessionLost(response);
  });

  const recaptureBtn = document.createElement('button');
  recaptureBtn.className = 'recapture-btn';
  recaptureBtn.textContent = isPageTurn ? '今の画面をこのページとして撮り直す' : 'この部分だけ撮り直す';
  recaptureBtn.disabled = !canRetryNow();
  recaptureBtn.addEventListener('click', async () => {
    hideError();
    const original = recaptureBtn.textContent;
    recaptureBtn.disabled = true;
    recaptureBtn.textContent = '再撮影中...';
    els.statusText.textContent = isPageTurn
      ? `#${index + 1} を今表示中の画面で撮り直しています...`
      : `#${index + 1} だけ撮り直しています...`;

    let response;
    if (isPageTurn) {
      // The human has already manually navigated the source tab to the page they want —
      // this captures exactly what's on screen right now, no click, no scrolling.
      response = await chrome.runtime
        .sendMessage({ type: 'scc:recapturePageTurnTileInPlace', tabId, positionIndex: index })
        .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    } else {
      const y = tileYs.get(index);
      if (y == null) {
        recaptureBtn.disabled = !canRetryNow();
        recaptureBtn.textContent = original;
        return;
      }
      const hideFixed = !!(captureOptions && captureOptions.hideFixed) && index > 0;
      response = await chrome.runtime
        .sendMessage({ type: 'scc:recaptureTileInPlace', tabId, positionIndex: index, y, hideFixed })
        .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    }

    recaptureBtn.disabled = !canRetryNow();
    recaptureBtn.textContent = original;

    if (handleSessionLost(response)) return;

    if (!response || !response.ok) {
      if (!(response && response.cancelled)) {
        els.statusText.textContent = `#${index + 1} の再撮影に失敗しました: ${(response && response.error) || '不明なエラー'}`;
      } else {
        els.statusText.textContent = '再撮影をキャンセルしました。';
      }
      return;
    }
    els.statusText.textContent = `#${index + 1} を撮り直しました。`;
  });

  actions.appendChild(retryBtn);
  actions.appendChild(recaptureBtn);

  wrap.appendChild(img);
  wrap.appendChild(row);
  wrap.appendChild(actions);
  els.tileList.appendChild(wrap);
  els.tileList.scrollTop = els.tileList.scrollHeight;
}

function updateTileThumbImage(index, dataUrl) {
  const wrap = els.tileList.querySelector(`.tile-thumb[data-index="${index}"]`);
  if (wrap) {
    const img = wrap.querySelector('img');
    if (img) img.src = dataUrl;
  }
}

function updateProgress(current, total) {
  els.countText.textContent = `${current} / ${total}`;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  els.progressBar.style.width = pct + '%';
  if (!ended && !hasError && !reviewPhase) {
    els.statusText.textContent = paused ? '一時停止中' : `キャプチャ中... (${current}/${total})`;
  }
}

function disableControls() {
  els.finalizeBtn.disabled = true;
  els.pauseBtn.disabled = true;
  els.stopBtn.disabled = true;
  els.cancelBtn.disabled = true;
  setRetryButtonsEnabled(false);
}

function showError(message, positionIndex) {
  hasError = true;
  paused = true;
  els.pauseBtn.textContent = '再開';
  els.errorBox.hidden = false;
  els.errorText.textContent = `#${positionIndex + 1} 付近でエラー: ${message}`;
  els.statusText.textContent = 'エラーのため一時停止しました。下の案内を確認してください。';
  updateModeUI();
}

function hideError() {
  hasError = false;
  els.errorBox.hidden = true;
}

// Returns true (and updates the UI) if `response` indicates the background lost track of
// this capture session — e.g. Chrome suspended the service worker while this panel sat
// idle for a long pause/review. There is no way to recover the in-progress capture at that
// point; the thumbnails already shown here are all that's left, so tell the user plainly.
function handleSessionLost(response) {
  if (response && response.error === 'session_lost') {
    ended = true;
    disableControls();
    els.statusText.textContent =
      '内部状態が失われたため、この操作を続行できません（バックグラウンド処理が休止した可能性が' +
      'あります）。お手数ですが、ここまでのタイルは失われるので、最初からキャプチャをやり直して' +
      'ください。';
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tabId !== tabId) return;
  if (msg.type === 'scc:tileCaptured') {
    hideError();
    addTileThumb(msg.dataUrl, msg.index, msg.y);
    updateProgress(msg.index + 1, msg.total);
  } else if (msg.type === 'scc:tileUpdated') {
    updateTileThumbImage(msg.index, msg.dataUrl);
  } else if (msg.type === 'scc:captureFinished') {
    reviewPhase = true;
    hideError();
    updateModeUI();
    els.statusText.textContent = 'キャプチャ完了。内容を確認し、問題なければ「編集画面へ進む」を押してください。';
  } else if (msg.type === 'scc:captureError') {
    showError(msg.message, msg.positionIndex);
  } else if (msg.type === 'scc:captureEnded') {
    ended = true;
    disableControls();
    if (msg.error) {
      els.statusText.textContent = 'エラー: ' + msg.error;
    } else if (msg.cancelled) {
      els.statusText.textContent = 'キャンセルしました。このウィンドウは閉じて構いません。';
    } else {
      els.statusText.textContent = '編集タブを開きました。このウィンドウは閉じて構いません。';
    }
  }
});

els.finalizeBtn.addEventListener('click', async () => {
  if (ended) return;
  els.finalizeBtn.disabled = true;
  els.statusText.textContent = '編集タブを開いています...';
  const response = await chrome.runtime.sendMessage({ type: 'scc:finalizeCapture', tabId });
  handleSessionLost(response);
});

els.pauseBtn.addEventListener('click', async () => {
  if (ended || reviewPhase) return;
  paused = !paused;
  els.pauseBtn.textContent = paused ? '再開' : '一時停止';
  if (!paused) hideError();
  els.statusText.textContent = paused ? '一時停止中' : 'キャプチャ中...';
  updateModeUI();
  const response = await chrome.runtime.sendMessage({
    type: paused ? 'scc:pauseCapture' : 'scc:resumeCapture',
    tabId
  });
  handleSessionLost(response);
});

els.stopBtn.addEventListener('click', async () => {
  if (ended || reviewPhase) return;
  els.statusText.textContent = 'ここまでで終了しています...';
  const response = await chrome.runtime.sendMessage({ type: 'scc:stopCaptureEarly', tabId });
  handleSessionLost(response);
});

els.cancelBtn.addEventListener('click', async () => {
  if (ended) return;
  els.statusText.textContent = 'キャンセルしています...';
  const response = await chrome.runtime.sendMessage({ type: 'scc:cancelCapture', tabId });
  handleSessionLost(response);
});

els.reloadBtn.addEventListener('click', async () => {
  els.statusText.textContent = 'ページを再読み込みしています...';
  await chrome.runtime.sendMessage({ type: 'scc:reloadTab', tabId });
  els.statusText.textContent = 'ページの読み込みが終わったら「再開」を押してください。';
});

async function init() {
  if (!tabId) {
    els.statusText.textContent = 'キャプチャ対象のタブが不明です。';
    disableControls();
    return;
  }
  const status = await chrome.runtime.sendMessage({ type: 'scc:getCaptureStatus', tabId });
  if (!status || !status.active) {
    els.statusText.textContent = 'キャプチャセッションが見つかりません（既に終了した可能性があります）。';
    disableControls();
    return;
  }
  paused = status.paused;
  reviewPhase = !!status.finished;
  captureOptions = status.options;
  captureKind = status.kind || 'scroll';
  if (captureKind === 'pageturn') {
    els.tileListHeading.textContent = 'キャプチャ済みページ';
    els.errorHint.textContent =
      'ページ送り先の状態を確認してください。読み込み直す必要があれば下のボタンで再読み込み' +
      'できます。準備ができたら「再開」でここから続きを再開します。おかしなページがあれば、その' +
      'サムネイルの「今の画面をこのページとして撮り直す」でそのページだけ手動で撮り直せます。';
  }
  els.pauseBtn.textContent = paused ? '再開' : '一時停止';
  status.tiles.forEach((tile, i) => addTileThumb(tile.dataUrl, i, tile.y));
  updateProgress(status.current, status.total);
  updateModeUI();
  if (reviewPhase) {
    els.statusText.textContent = 'キャプチャ完了。内容を確認し、問題なければ「編集画面へ進む」を押してください。';
  }
}

init();
