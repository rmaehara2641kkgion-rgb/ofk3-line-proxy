/**
 * OFK3 Cortex capture runner — page MAIN world only.
 * Wraps SPA fetch/XHR response JSON. Does not call Cortex APIs.
 * Does not read Cookie / Authorization / HMAC / session / timestamp.
 * Phase 1: one start() click = one Route CDP trial = always end.
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
    box.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;padding:12px;font:12px/1.5 sans-serif;border-radius:8px;max-width:280px;');
    box.innerHTML = '<b>OFK3 Cortex取得</b> <span style="opacity:.8">Phase 1</span>' +
      '<div>対象Route: <span id="ofk3-poc-code">-</span></div>' +
      '<div>routeId: <span id="ofk3-poc-id">-</span></div>' +
      '<div>DOM発見: <span id="ofk3-poc-dom">no</span></div>' +
      '<div>座標取得: <span id="ofk3-poc-xy">no</span></div>' +
      '<div>CDP attach: <span id="ofk3-poc-attach">-</span></div>' +
      '<div>mousePressed: <span id="ofk3-poc-down">-</span></div>' +
      '<div>mouseReleased: <span id="ofk3-poc-up">-</span></div>' +
      '<div>Route詳細捕捉: <span id="ofk3-poc-details">-</span></div>' +
      '<div>run終了: <span id="ofk3-poc-ended">no</span></div>';
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

  function findRouteElement(route) {
    route = route || {};
    var el = findRouteCardByRouteId(route.routeId);
    if (el) return el;
    var scroller = largestScroller();
    if (!scroller) return null;
    var y = 0;
    var guard = 0;
    var stepPx = Math.max(120, Math.floor((scroller.clientHeight || 300) * 0.7));
    while (y <= scroller.scrollHeight && guard < 40) {
      scroller.scrollTop = y;
      el = findRouteCardByRouteId(route.routeId);
      if (el) return el;
      y += stepPx;
      guard += 1;
    }
    return null;
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
  }

  function clickRoute(route, runId, done) {
    var card = findRouteElement(route);
    if (!card) {
      if (pocRun && pocRun.diagnostics) pocRun.diagnostics.domFound = 'no';
      paint();
      done(false);
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
        done(false);
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
  }

  function clearTimers() {
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = 0; }
    if (summariesWaitTimer) { clearInterval(summariesWaitTimer); summariesWaitTimer = 0; }
  }

  function finishPoc(failureInfo) {
    clearTimers();
    setPanelClickable(true);
    sessionBusy = false;
    if (pocRun) Core.endPocRun(pocRun, store, failureInfo || null);
    tour.status = 'done';
    paint();
  }

  function stopPoc() {
    if (pocRun && !pocRun.ended) {
      finishPoc({
        error: Core.ERROR.NETWORK,
        message: '手動停止'
      });
      return;
    }
    sessionBusy = false;
    clearTimers();
    tour.status = 'stopped';
    paint();
  }

  function waitForOneRoute(route, runId) {
    var started = Date.now();
    if (pocRun && pocRun.diagnostics && pocRun.diagnostics.details !== 'success') {
      pocRun.diagnostics.details = '-';
    }
    paint();
    function poll() {
      if (!Core.pocRunIsCurrent(pocRun, runId)) return;
      if (route.routeId && store.detailsByRouteId[route.routeId]) {
        pocRun.diagnostics.details = 'success';
        finishPoc(null);
        return;
      }
      if (Date.now() - started >= tour.timeoutMs) {
        pocRun.diagnostics.details = 'timeout';
        finishPoc({
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
    if (!store.summaries) {
      pocRun = Core.createPocRun({});
      finishPoc({
        error: Core.ERROR.MISSING_SUMMARIES,
        message: 'route-summaries が捕捉できません。Route一覧を開いた状態で再実行してください'
      });
      return;
    }
    var route = Core.firstUncapturedTourRoute(store, tour);
    if (!route) {
      pocRun = Core.createPocRun({});
      finishPoc(null);
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
        finishPoc({
          error: (cdpRes && cdpRes.error) || Core.ERROR.DOM_NOT_FOUND,
          message: (cdpRes && cdpRes.message) || 'RouteカードのCDPクリックに失敗しました'
        });
        return;
      }
      waitForOneRoute(route, runId);
    });
  }

  function start() {
    show();
    if (sessionBusy) return;
    if (pocRun && pocRun.active && !pocRun.ended) return;
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
    phase: 'poc-1',
    show: show,
    start: start,
    stop: stopPoc,
    save: saveBundle,
    _store: store
  };
})(typeof window !== 'undefined' ? window : global);
