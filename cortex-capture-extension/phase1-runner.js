/**
 * OFK3 Cortex capture runner — page MAIN world only.
 * Wraps SPA fetch/XHR response JSON. Does not call Cortex APIs.
 * Does not read Cookie / Authorization / HMAC / session / timestamp.
 * Phase 2: one start() walks all uncaptured 11:00 routes sequentially.
 */
(function (global) {
  'use strict';

  var Core = global.Cortex13PriorityCore;
  if (!Core) return;

  var prev = global.__OFK3_CORTEX_CAPTURE__;
  if (prev && typeof prev.stop === 'function') {
    try { prev.stop(); } catch (e0) {}
  }

  var PANEL_ID = 'ofk3-cortex-capture-panel';
  var store = (prev && prev._store) ? prev._store : Core.createCaptureStore();
  var tour = Core.createTourState();
  var pocRun = null;
  var sessionBusy = false;
  var stopRequested = false;
  var localDate = '';
  var waitTimer = 0;
  var summariesWaitTimer = 0;

  function tokyoDate() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  function currentLocalDate() {
    try {
      var params = new URLSearchParams(location.search);
      return params.get('localDate') || tokyoDate();
    } catch (e) {
      return tokyoDate();
    }
  }

  localDate = currentLocalDate();

  function installHooks() {
    var origFetch = global.fetch;
    if (typeof origFetch === 'function') {
      global.fetch = function (input) {
        var url = '';
        try {
          if (typeof input === 'string') url = input;
          else if (input && typeof input.url === 'string') url = input.url;
          else if (input && typeof input.href === 'string') url = input.href;
        } catch (e1) {}
        return origFetch.apply(this, arguments).then(function (res) {
          var u = url || res.url || '';
          if (Core.isCortexApiCaptureUrl(u)) {
            res.clone().json().then(function (body) {
              if (typeof global.__OFK3_CORTEX_NOTE__ === 'function') {
                global.__OFK3_CORTEX_NOTE__(u, res.status, body);
              }
            }).catch(function () {});
          }
          return res;
        });
      };
    }
    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ofk3Url = url;
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        var u = this.__ofk3Url || this.responseURL || '';
        if (!Core.isCortexApiCaptureUrl(u)) return;
        var body = null;
        try { body = JSON.parse(this.responseText); } catch (e2) { return; }
        if (typeof global.__OFK3_CORTEX_NOTE__ === 'function') {
          global.__OFK3_CORTEX_NOTE__(u, this.status, body);
        }
      });
      return xhrSend.apply(this, arguments);
    };
  }

  function note(url, status, body) {
    Core.applyCapturedCortexResponse(store, { url: url, status: status, body: body });
    if (pocRun && !pocRun.ended && pocRun.route && pocRun.route.routeId && store.detailsByRouteId[pocRun.route.routeId]) {
      pocRun.diagnostics.details = 'success';
      pocRun.diagnostics.error = '';
      pocRun.diagnostics.message = '';
    }
    paint();
  }

  global.__OFK3_CORTEX_NOTE__ = note;
  if (!global.__OFK3_CORTEX_HOOKED__) {
    installHooks();
    global.__OFK3_CORTEX_HOOKED__ = true;
  }

  function progress() {
    return Core.tourProgress(store, tour);
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function diag() {
    return (pocRun && pocRun.diagnostics) || Core.createPocDiagnostics();
  }

  function paint() {
    var d = diag();
    var box = document.getElementById(PANEL_ID);
    if (!box) return;
    setText('ofk3-poc-code', d.routeCode ? d.routeCode : '-');
    setText('ofk3-poc-id', d.routeId ? d.routeId : '-');
    setText('ofk3-poc-dom', d.domFound || 'no');
    setText('ofk3-poc-xy', d.coords || 'no');
    setText('ofk3-poc-attach', d.attach || '-');
    setText('ofk3-poc-down', d.mousePressed || '-');
    setText('ofk3-poc-up', d.mouseReleased || '-');
    setText('ofk3-poc-details', d.details || '-');
    setText('ofk3-poc-ended', d.runEnded || 'no');
    setText('ofk3-poc-error', d.message || d.error || '-');
  }

  function setPanelClickable(on) {
    var box = document.getElementById(PANEL_ID);
    if (!box) return;
    box.style.pointerEvents = on ? 'auto' : 'none';
  }

  function ensurePanel() {
    if (!document.documentElement) return;
    var box = document.getElementById(PANEL_ID);
    if (box && !document.getElementById('ofk3-poc-ended')) {
      try { box.parentNode.removeChild(box); } catch (e1) {}
      box = null;
    }
    if (box) {
      box.style.display = 'block';
      paint();
      return box;
    }
    box = document.createElement('div');
    box.id = PANEL_ID;
    box.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;padding:12px;font:12px/1.5 sans-serif;border-radius:8px;max-width:320px;max-height:70vh;overflow:auto;');
    box.innerHTML = '<b>OFK3 Cortex取得</b> <span style="opacity:.8">Phase 2</span>' +
      '<div>対象Route: <span id="ofk3-poc-code">-</span></div>' +
      '<div>routeId: <span id="ofk3-poc-id">-</span></div>' +
      '<div>DOM発見: <span id="ofk3-poc-dom">no</span></div>' +
      '<div>座標取得: <span id="ofk3-poc-xy">no</span></div>' +
      '<div>CDP attach: <span id="ofk3-poc-attach">-</span></div>' +
      '<div>mousePressed: <span id="ofk3-poc-down">-</span></div>' +
      '<div>mouseReleased: <span id="ofk3-poc-up">-</span></div>' +
      '<div>Route詳細捕捉: <span id="ofk3-poc-details">-</span></div>' +
      '<div>run終了: <span id="ofk3-poc-ended">no</span></div>' +
      '<div style="margin-top:4px;word-break:break-word">診断: <span id="ofk3-poc-error">-</span></div>';
    var row = document.createElement('div');
    row.setAttribute('style', 'margin-top:8px;');
    function mk(label, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('style', 'margin:0 6px 6px 0;');
      b.onclick = fn;
      return b;
    }
    row.appendChild(mk('取得開始', function () { start(); }));
    row.appendChild(mk('JSON保存', function () { saveBundle(); }));
    row.appendChild(mk('停止', function () { stopPoc(); }));
    box.appendChild(row);
    document.documentElement.appendChild(box);
    paint();
    return box;
  }

  function show() {
    ensurePanel();
  }

  function saveBundle(opts) {
    opts = opts || {};
    localDate = currentLocalDate();
    var bundle = Core.buildCaptureBundle(store, { localDate: localDate });
    if (!(bundle.summaries || (bundle.details && bundle.details.length))) {
      if (!opts.quiet) alert('まだ捕捉できていません。Route一覧で取得開始してください');
      return false;
    }
    try {
      var blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cortex-13-bundle_' + localDate + '.json';
      a.click();
      if (!opts.quiet) {
        var d = diag();
        alert('Cortex捕捉 JSONを保存しました。\n対象: ' + (d.routeCode || '-') + '\n詳細捕捉: ' + (d.details || '-'));
      }
      return true;
    } catch (err) {
      if (!opts.quiet) alert('JSON保存に失敗しました。');
      return false;
    }
  }

  function inPanel(el) {
    var panel = document.getElementById(PANEL_ID);
    return !!(panel && el && panel.contains(el));
  }

  function collectCardClickNodes(card) {
    var out = [];
    if (!card || !card.querySelectorAll) return out;
    var els = card.querySelectorAll('p, span');
    for (var i = 0; i < els.length; i++) {
      out.push({
        el: els[i],
        tag: (els[i].tagName || '').toLowerCase(),
        title: (els[i].getAttribute && els[i].getAttribute('title')) || '',
        text: String(els[i].textContent || '').replace(/\s+/g, ' ').trim()
      });
    }
    return out;
  }

  function findInnerClickTarget(card, route) {
    if (!card) return null;
    var nodes = collectCardClickNodes(card);
    var idx = Core.pickRouteCardClickTarget(nodes, route);
    if (idx >= 0) return nodes[idx].el;
    return card;
  }

  function largestScroller() {
    var best = document.scrollingElement || document.documentElement;
    var bestSize = 0;
    var nodes = document.querySelectorAll('div, section, main, tbody, [role="rowgroup"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.id === PANEL_ID) continue;
      var overflow = '';
      try { overflow = global.getComputedStyle(el).overflowY; } catch (e) {}
      if (el.scrollHeight - el.clientHeight < 80) continue;
      if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') continue;
      var size = el.scrollHeight * el.clientWidth;
      if (size > bestSize) {
        bestSize = size;
        best = el;
      }
    }
    return best;
  }

  function findRouteCardByRouteId(routeId) {
    if (!routeId) return null;
    var sel = Core.routeCardSelector(routeId);
    var el = null;
    try { el = document.querySelector(sel); } catch (e1) {}
    if (el && !inPanel(el)) return el;
    var nodes = document.querySelectorAll('[class*="route-"]');
    for (var i = 0; i < nodes.length; i++) {
      if (inPanel(nodes[i])) continue;
      if (Core.classListHasRouteCard(nodes[i].className, routeId)) return nodes[i];
    }
    return null;
  }

  function findVisibleRouteByCode(route) {
    route = route || {};
    var code = String(route.routeCode || '');
    if (!code) return null;
    var nodes = document.querySelectorAll('p[title], span, a, button, [role="button"], [role="link"]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (inPanel(node)) continue;
      var title = (node.getAttribute && node.getAttribute('title')) || '';
      var text = String(node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (title !== code && text !== code) continue;
      var cur = node;
      for (var depth = 0; cur && depth < 8; depth += 1, cur = cur.parentElement) {
        if (inPanel(cur)) break;
        if (cur.className && String(cur.className).indexOf('route-') >= 0) return cur;
      }
      return node;
    }
    return null;
  }

  function findRouteElementAsync(route, runId, done) {
    route = route || {};
    var el = findRouteCardByRouteId(route.routeId) || findVisibleRouteByCode(route);
    if (el) {
      done(el, null);
      return;
    }
    var scroller = largestScroller();
    if (!scroller) {
      done(null, {
        error: Core.ERROR.DOM_NOT_FOUND,
        message: 'Route DOM未発見（scroll領域なし）: routeId=' + String(route.routeId || '-') + ' / routeCode=' + String(route.routeCode || '-')
      });
      return;
    }
    var stepPx = Math.max(120, Math.floor((scroller.clientHeight || 300) * 0.65));
    var y = 0;
    var guard = 0;
    var maxGuard = 80;

    function scan() {
      if (!Core.pocRunIsCurrent(pocRun, runId)) return;
      el = findRouteCardByRouteId(route.routeId) || findVisibleRouteByCode(route);
      if (el) {
        waitTimer = 0;
        done(el, null);
        return;
      }
      var maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (guard >= maxGuard || (guard > 0 && y > maxScroll)) {
        waitTimer = 0;
        done(null, {
          error: Core.ERROR.DOM_NOT_FOUND,
          message: 'Route DOM未発見（非同期scan ' + guard + '回）: routeId=' + String(route.routeId || '-') + ' / routeCode=' + String(route.routeCode || '-')
        });
        return;
      }
      scroller.scrollTop = Math.min(y, maxScroll);
      try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e1) {}
      guard += 1;
      y += stepPx;
      waitTimer = setTimeout(scan, 90);
    }
    scan();
  }
  function requestCdpClick(point, cb) {
    var finished = false;
    var timer = 0;
    function finish(result) {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', onMsg);
      if (timer) clearTimeout(timer);
      cb(result || {
        ok: false,
        attach: 'fail',
        mousePressed: 'fail',
        mouseReleased: 'fail',
        error: 'DEBUGGER',
        message: 'CDP失敗'
      });
    }
    function onMsg(ev) {
      if (ev.source !== window) return;
      var data = ev.data;
      if (!data || data.source !== 'OFK3_CORTEX' || data.type !== 'cdp-click-result') return;
      finish(data);
    }
    window.addEventListener('message', onMsg);
    window.postMessage({
      source: 'OFK3_CORTEX',
      type: 'cdp-click',
      x: point.x,
      y: point.y
    }, location.origin);
    timer = setTimeout(function () {
      finish({
        ok: false,
        attach: 'fail',
        mousePressed: 'fail',
        mouseReleased: 'fail',
        error: 'DEBUGGER_TIMEOUT',
        message: 'CDP応答なし。DevToolsを閉じて再実行してください'
      });
    }, 8000);
  }

  function applyCdpStages(res) {
    if (!pocRun || !pocRun.diagnostics) return;
    pocRun.diagnostics.attach = (res && res.attach) || 'fail';
    pocRun.diagnostics.mousePressed = (res && res.mousePressed) || 'fail';
    pocRun.diagnostics.mouseReleased = (res && res.mouseReleased) || 'fail';
    if (res && res.error) pocRun.diagnostics.error = String(res.error);
    if (res && (res.message || res.error)) {
      pocRun.diagnostics.message = String(res.message || res.error);
    }
  }

  function clickRoute(route, runId, done) {
    findRouteElementAsync(route, runId, function (card, findError) {
      if (!Core.pocRunIsCurrent(pocRun, runId)) return;
      if (!card) {
        if (pocRun && pocRun.diagnostics) pocRun.diagnostics.domFound = 'no';
        paint();
        done(false, findError || {
          ok: false,
          error: Core.ERROR.DOM_NOT_FOUND,
          message: 'Route DOM未発見: routeId=' + String(route.routeId || '-') + ' / routeCode=' + String(route.routeCode || '-')
        });
        return;
      }
      if (pocRun && pocRun.diagnostics) pocRun.diagnostics.domFound = 'yes';
      try {
        card.scrollIntoView({ block: 'center', inline: 'center' });
      } catch (e1) {}
      function afterLayout() {
        if (!Core.pocRunIsCurrent(pocRun, runId)) return;
        var target = findInnerClickTarget(card, route) || card;
        var rect = null;
        try { rect = target.getBoundingClientRect(); } catch (e2) {}
        var point = Core.viewportClickPoint(rect);
        if (!point) {
          try { rect = card.getBoundingClientRect(); } catch (e3) {}
          point = Core.viewportClickPoint(rect);
        }
        if (!point) {
          if (pocRun && pocRun.diagnostics) pocRun.diagnostics.coords = 'no';
          paint();
          done(false, {
            ok: false,
            error: 'CLICK_COORD',
            message: 'Route座標取得失敗: routeId=' + String(route.routeId || '-') + ' / routeCode=' + String(route.routeCode || '-')
          });
          return;
        }
        if (pocRun && pocRun.diagnostics) pocRun.diagnostics.coords = 'yes';
        paint();
        setPanelClickable(false);
        requestCdpClick(point, function (res) {
          setPanelClickable(true);
          if (!Core.pocRunIsCurrent(pocRun, runId)) return;
          applyCdpStages(res);
          paint();
          done(!!(res && res.ok), res);
        });
      }
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { requestAnimationFrame(afterLayout); });
      } else {
        waitTimer = setTimeout(afterLayout, 50);
      }
    });
  }

  function clearTimers() {
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = 0; }
    if (summariesWaitTimer) { clearInterval(summariesWaitTimer); summariesWaitTimer = 0; }
  }

  function finishPoc(failureInfo) {
    clearTimers();
    setPanelClickable(true);
    sessionBusy = false;
    if (pocRun && pocRun.diagnostics && failureInfo) {
      pocRun.diagnostics.error = failureInfo.error || '';
      pocRun.diagnostics.message = failureInfo.message || failureInfo.error || '';
    }
    if (pocRun) Core.endPocRun(pocRun, store, failureInfo || null);
    tour.status = 'done';
    paint();
  }

  function stopPoc() {
    stopRequested = true;
    sessionBusy = false;
    clearTimers();
    setPanelClickable(true);
    tour.status = 'stopped';
    if (pocRun && !pocRun.ended) {
      if (pocRun.diagnostics) {
        pocRun.diagnostics.error = '';
        pocRun.diagnostics.message = '手動停止';
      }
      Core.endPocRun(pocRun, store, null);
    }
    paint();
  }

  function runNextRoute() {
    if (stopRequested || !sessionBusy) {
      tour.status = 'stopped';
      paint();
      return;
    }
    var route = Core.firstUncapturedTourRoute(store, tour);
    if (!route) {
      sessionBusy = false;
      tour.status = 'done';
      if (pocRun && pocRun.diagnostics) {
        pocRun.diagnostics.error = '';
        pocRun.diagnostics.message = '';
      }
      paint();
      return;
    }
    pocRun = Core.createPocRun(route);
    var runId = pocRun.id;
    tour.status = 'running';
    tour.currentRouteId = route.routeId;
    tour.currentRouteCode = route.routeCode || '';
    Core.markRouteVisited(tour, route.routeId);
    paint();

    clickRoute(route, runId, function (ok, cdpRes) {
      if (!Core.pocRunIsCurrent(pocRun, runId)) return;
      if (!ok) {
        applyCdpStages(cdpRes);
        finishCurrentAndContinue({
          error: (cdpRes && cdpRes.error) || Core.ERROR.DOM_NOT_FOUND,
          message: (cdpRes && cdpRes.message) || 'RouteカードのCDPクリックに失敗しました'
        });
        return;
      }
      waitForCurrentRoute(route, runId);
    });
  }

  function finishCurrentAndContinue(failureInfo) {
    clearTimers();
    setPanelClickable(true);
    if (pocRun && pocRun.diagnostics) {
      if (failureInfo) {
        pocRun.diagnostics.error = failureInfo.error || '';
        pocRun.diagnostics.message = failureInfo.message || failureInfo.error || '';
      } else {
        pocRun.diagnostics.error = '';
        pocRun.diagnostics.message = '';
      }
    }
    if (pocRun) Core.endPocRun(pocRun, store, failureInfo || null);
    paint();
    waitTimer = setTimeout(function () {
      waitTimer = 0;
      if (stopRequested || !sessionBusy) return;
      runNextRoute();
    }, 350);
  }

  function waitForCurrentRoute(route, runId) {
    var started = Date.now();
    if (pocRun && pocRun.diagnostics && pocRun.diagnostics.details !== 'success') {
      pocRun.diagnostics.details = '-';
    }
    paint();
    function poll() {
      if (!Core.pocRunIsCurrent(pocRun, runId)) return;
      if (route.routeId && store.detailsByRouteId[route.routeId]) {
        pocRun.diagnostics.details = 'success';
        finishCurrentAndContinue(null);
        return;
      }
      if (Date.now() - started >= tour.timeoutMs) {
        pocRun.diagnostics.details = 'timeout';
        finishCurrentAndContinue({
          error: Core.ERROR.TIMEOUT,
          message: 'route-details が時間内に捕捉できませんでした（XHR未検出）'
        });
        return;
      }
      waitTimer = setTimeout(poll, 200);
    }
    poll();
  }

  function beginPoc() {
    localDate = currentLocalDate();
    tour.routes = store.summaries ? Core.tourRoutesFromSummaries(store.summaries) : [];
    tour.index = 0;
    tour.status = 'idle';
    tour.visitedRouteIds = {};
    if (!store.summaries) {
      pocRun = Core.createPocRun({});
      finishPoc({
        error: Core.ERROR.MISSING_SUMMARIES,
        message: 'route-summaries が捕捉できません。Route一覧を開いた状態で再実行してください'
      });
      return;
    }
    runNextRoute();
  }

  function start() {
    show();
    if (sessionBusy) return;
    if (pocRun && pocRun.active && !pocRun.ended) return;
    stopRequested = false;
    sessionBusy = true;
    clearTimers();
    if (store.summaries) {
      beginPoc();
      return;
    }
    var waited = 0;
    summariesWaitTimer = setInterval(function () {
      waited += 250;
      paint();
      if (store.summaries) {
        clearInterval(summariesWaitTimer);
        summariesWaitTimer = 0;
        beginPoc();
      } else if (waited >= 10000) {
        clearInterval(summariesWaitTimer);
        summariesWaitTimer = 0;
        beginPoc();
      }
    }, 250);
  }

  function onReady(fn) {
    if (document.body || document.documentElement) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(function () {
    localDate = currentLocalDate();
    ensurePanel();
  });

  global.__OFK3_CORTEX_CAPTURE__ = {
    phase: 'poc-2',
    show: show,
    start: start,
    stop: stopPoc,
    save: saveBundle,
    _store: store
  };
})(typeof window !== 'undefined' ? window : global);
