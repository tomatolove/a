if (!window.__sccLoaded) {
  window.__sccLoaded = true;

  let hiddenEls = [];
  let originalScroll = { x: 0, y: 0 };
  let scrollTarget = null; // element being scrolled, or null = the page itself scrolls
  let originalTargetScrollTop = 0;
  let manualTarget = null; // element picked explicitly by the user via the picker UI
  let nextButtonTarget = null; // page-turn mode: the "next page" button the user picked
  let progressEl = null;
  let scrollBehaviorTarget = null; // element whose inline scroll-behavior we forced to 'auto'
  let originalScrollBehaviorValue = '';

  function isScrollable(el) {
    const style = getComputedStyle(el);
    const overflowY = style.overflowY;
    return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 5;
  }

  // Many SPA readers (e-book / PDF viewers) keep the outer document fixed and scroll
  // a specific inner container instead. Prefer native page scroll when it works; otherwise
  // pick the largest visible element that actually scrolls.
  function findScrollContainer() {
    const docEl = document.scrollingElement || document.documentElement;
    if (docEl.scrollHeight > docEl.clientHeight + 5) return null;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const all = document.body ? document.body.querySelectorAll('*') : [];
    let best = null;
    let bestScore = 0;
    for (const el of all) {
      if (!isScrollable(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.3 || rect.height < vh * 0.3) continue;
      const visibleArea =
        Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)) *
        Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
      const scrollRange = el.scrollHeight - el.clientHeight;
      const score = visibleArea * Math.log(scrollRange + 2);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function resolveScrollTarget() {
    if (manualTarget && document.contains(manualTarget)) return manualTarget;
    return findScrollContainer();
  }

  function getMetrics(target) {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const base = {
      viewportWidth,
      viewportHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      sourceTitle: document.title,
      sourceUrl: location.href
    };
    if (!target) {
      const de = document.documentElement;
      const body = document.body;
      return {
        ...base,
        mode: 'page',
        scrollWidth: Math.max(de.scrollWidth, body ? body.scrollWidth : 0),
        scrollHeight: Math.max(de.scrollHeight, body ? body.scrollHeight : 0),
        clientWidth: de.clientWidth,
        clientHeight: de.clientHeight,
        containerRect: { left: 0, top: 0, width: viewportWidth, height: viewportHeight },
        currentScrollTop: window.scrollY
      };
    }
    const rect = target.getBoundingClientRect();
    return {
      ...base,
      mode: 'element',
      scrollWidth: target.scrollWidth,
      scrollHeight: target.scrollHeight,
      clientWidth: target.clientWidth,
      clientHeight: target.clientHeight,
      containerRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      currentScrollTop: target.scrollTop
    };
  }

  function findFixedElements() {
    const found = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
          found.push(el);
        }
      }
    }
    return found;
  }

  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function readCurrentPosition() {
    const rect = scrollTarget
      ? scrollTarget.getBoundingClientRect()
      : { left: 0, top: 0, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    return {
      scrollX: scrollTarget ? scrollTarget.scrollLeft : window.scrollX,
      scrollY: scrollTarget ? scrollTarget.scrollTop : window.scrollY,
      containerRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    };
  }

  function showProgressBanner(text) {
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.style.cssText =
        'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:#1f2328;color:#fff;padding:6px 14px;border-radius:6px;' +
        'font:12px -apple-system,sans-serif;pointer-events:none;';
      document.documentElement.appendChild(progressEl);
    }
    progressEl.textContent = text;
  }

  function hideProgressBanner() {
    if (progressEl) {
      progressEl.remove();
      progressEl = null;
    }
  }

  // Lets the user click a specific element on the page — the scroll region to capture (scroll
  // mode), or the "next page" button to click through (page-turn mode). `assign` is called
  // with the picked element the instant it's clicked, so the caller can stash it into
  // whichever module-level variable it needs (the element itself can't cross sendResponse's
  // structured-clone boundary, only the serializable summary returned here can).
  function startElementPicker(instructionText, assign) {
    return new Promise((resolve) => {
      const highlight = document.createElement('div');
      highlight.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #1f6feb;' +
        'background:rgba(31,111,235,0.15);';
      document.documentElement.appendChild(highlight);

      const instruction = document.createElement('div');
      instruction.textContent = instructionText;
      instruction.style.cssText =
        'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:#1f2328;color:#fff;padding:8px 14px;border-radius:6px;' +
        'font:13px -apple-system,sans-serif;pointer-events:none;';
      document.documentElement.appendChild(instruction);

      function updateHighlight(el) {
        const r = el.getBoundingClientRect();
        highlight.style.left = r.left + 'px';
        highlight.style.top = r.top + 'px';
        highlight.style.width = r.width + 'px';
        highlight.style.height = r.height + 'px';
      }

      function onMouseMove(e) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el) updateHighlight(el);
      }

      function cleanup() {
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        highlight.remove();
        instruction.remove();
      }

      function onClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        cleanup();
        if (el) {
          assign(el);
          resolve({ picked: true, tag: el.tagName, className: String(el.className).slice(0, 60) });
        } else {
          resolve({ picked: false });
        }
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          cleanup();
          resolve({ picked: false, cancelled: true });
        }
      }

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'scc:pick': {
          const result = await startElementPicker(
            'キャプチャしたいスクロール領域をクリックしてください（Escでキャンセル）',
            (el) => {
              manualTarget = el;
            }
          );
          sendResponse(result);
          break;
        }
        case 'scc:pickNextButton': {
          const result = await startElementPicker(
            'ページ送り（次のページに進む）ボタンをクリックしてください（Escでキャンセル）',
            (el) => {
              nextButtonTarget = el;
            }
          );
          sendResponse(result);
          break;
        }
        case 'scc:clickNextButton': {
          if (!nextButtonTarget || !document.contains(nextButtonTarget)) {
            sendResponse({ error: 'target_lost' });
            break;
          }
          nextButtonTarget.click();
          await waitForPaint();
          sendResponse({ ok: true });
          break;
        }
        case 'scc:restorePageTurn': {
          nextButtonTarget = null;
          hideProgressBanner();
          sendResponse({ ok: true });
          break;
        }
        case 'scc:getMetrics': {
          originalScroll = { x: window.scrollX, y: window.scrollY };
          const target = resolveScrollTarget();
          scrollTarget = target;
          originalTargetScrollTop = target ? target.scrollTop : 0;
          // Many paginated readers set `scroll-behavior: smooth` (on the container or on
          // <html>), which makes a plain `scrollTop = y` assignment animate over several
          // hundred ms instead of jumping instantly — a common cause of the captured image
          // not matching the position we record. Force instant scrolling for the rest of
          // this capture session; restored in scc:restore.
          scrollBehaviorTarget = target || document.documentElement;
          originalScrollBehaviorValue = scrollBehaviorTarget.style.scrollBehavior || '';
          scrollBehaviorTarget.style.setProperty('scroll-behavior', 'auto', 'important');
          sendResponse(getMetrics(target));
          break;
        }
        case 'scc:getScrollExtent': {
          // Lightweight re-measurement of just the scrollable height, reusing whichever
          // target scc:getMetrics already resolved (never re-resolves it, so this can't
          // accidentally switch to a different scroll container mid-session). Some
          // virtualized viewers only firm up their true total height once you've scrolled
          // far enough for more content to mount, so this can grow over the course of a
          // capture — checked whenever the scan is about to conclude, so a page that grows
          // isn't mistaken as finished early.
          if (scrollTarget) {
            sendResponse({ scrollHeight: scrollTarget.scrollHeight, clientHeight: scrollTarget.clientHeight });
          } else {
            const de = document.documentElement;
            const body = document.body;
            sendResponse({
              scrollHeight: Math.max(de.scrollHeight, body ? body.scrollHeight : 0),
              clientHeight: de.clientHeight
            });
          }
          break;
        }
        case 'scc:prepare': {
          hiddenEls = findFixedElements().map((el) => ({
            el,
            prevVisibility: el.style.visibility
          }));
          sendResponse({ count: hiddenEls.length });
          break;
        }
        case 'scc:scrollTo': {
          if (msg.hideFixed) {
            hiddenEls.forEach((h) => {
              h.el.style.visibility = 'hidden';
            });
          } else {
            hiddenEls.forEach((h) => {
              h.el.style.visibility = h.prevVisibility || '';
            });
          }
          if (scrollTarget) {
            scrollTarget.scrollTop = msg.y;
          } else {
            window.scrollTo(0, msg.y);
          }
          await waitForPaint();
          // This reading is provisional — some paginated SPA/PDF viewers snap the scroll
          // position to the nearest "page" boundary a little after a scroll settles, which
          // can happen later than this. The caller re-checks via scc:getCurrentPosition
          // right before it actually takes the screenshot, so what ends up recorded always
          // matches what's really on screen at that moment.
          sendResponse(readCurrentPosition());
          break;
        }
        case 'scc:getCurrentPosition': {
          sendResponse(readCurrentPosition());
          break;
        }
        case 'scc:showProgress': {
          showProgressBanner(msg.text);
          sendResponse({ ok: true });
          break;
        }
        case 'scc:restore': {
          hiddenEls.forEach((h) => {
            h.el.style.visibility = h.prevVisibility || '';
          });
          hiddenEls = [];
          if (scrollTarget) {
            scrollTarget.scrollTop = originalTargetScrollTop;
          } else {
            window.scrollTo(originalScroll.x, originalScroll.y);
          }
          if (scrollBehaviorTarget) {
            scrollBehaviorTarget.style.scrollBehavior = originalScrollBehaviorValue;
            scrollBehaviorTarget = null;
          }
          hideProgressBanner();
          scrollTarget = null;
          manualTarget = null;
          sendResponse({ ok: true });
          break;
        }
        default: {
          sendResponse({ error: 'unknown message: ' + msg.type });
        }
      }
    })();
    return true;
  });
}
