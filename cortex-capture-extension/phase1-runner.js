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
  var wheelTrace = [];
  var wheelTraceEarly = [];
  var lastRoutePoint = null;
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

  function domRouteSnapshot() {
    var found = [];
    var seen = {};
    var nodes = document.querySelectorAll('[class*="route-"], p[title]');
    for (var i = 0; i < nodes.length && found.length < 24; i++) {
      if (inPanel(nodes[i])) continue;
      var cls = String(nodes[i].className || '');
      var title = (nodes[i].getAttribute && nodes[i].getAttribute('title')) || '';
      var m = cls.match(/route-([^\\s]+)/);
      var value = m ? m[1] : (/^[A-Z]{2,}[A-Z0-9-]*\\d+$/.test(title) ? title : '');
      if (value && !seen[value]) {
        seen[value] = true;
        found.push(value);
      }
    }
    return found.length ? found.join(', ') : '0件';
  }

  function domRouteStats() {
    var raw = [];
    var nodes = document.querySelectorAll('[class*="route-"]');
    for (var i = 0; i < nodes.length && raw.length < 4; i++) {
      if (inPanel(nodes[i])) continue;
      var cls = String(nodes[i].className || '');
      var m = cls.match(/route-([^\\s]+)/);
      if (m) raw.push(m[1]);
    }
    return { count: nodes.length, sample: raw.join(',') || '-' };
  }

  function pushWheelTrace(label, point) {
    var s = domRouteStats();
    var xy = point ? Math.round(point.x) + ',' + Math.round(point.y) : '-';
    var line = label + ':DOM=' + s.count + '[' + s.sample + ']@' + xy;
    wheelTrace.push(line);
    if (wheelTraceEarly.length < 12) wheelTraceEarly.push(line);
    if (wheelTrace.length > 60) wheelTrace.shift();
  }

  function prioritySummary() {
    var bundle = Core.buildCaptureBundle(store, { localDate: currentLocalDate() });
    var summary = Core.ingestBundle(bundle);
    return {
      routes: summary.successCount || 0,
      selected: summary.selectedRouteCount || 0,
      stops: summary.stopCount || 0,
      packages: summary.packageCount || 0,
      failures: summary.failureCount || 0
    };
  }

  function priorityRows() {
    var bundle = Core.buildCaptureBundle(store, { localDate: currentLocalDate() });
    var summary = Core.ingestBundle(bundle);
    return (summary.packages || []).slice().sort(function (a, b) {
      var rc = String(a.routeCode || '').localeCompare(String(b.routeCode || ''), 'en', { numeric: true });
      if (rc) return rc;
      return Number(a.stop || 0) - Number(b.stop || 0);
    });
  }

  function paintPriorityTable() {
    var host = document.getElementById('ofk3-priority-list');
    if (!host) return;
    var rows = priorityRows();
    if (!rows.length) {
      host.innerHTML = '<div style="opacity:.7">13時優先データはまだありません</div>';
      return;
    }

    var groups = {};
    rows.forEach(function (p) {
      var key = String(p.routeCode || '') + '#' + String(p.stop == null ? '' : p.stop);
      if (!groups[key]) groups[key] = {
        routeCode: p.routeCode || '-',
        stop: p.stop,
        driverName: p.driverName || '-',
        plannedEndClock: p.plannedEndClock || '-',
        packages: []
      };
      groups[key].packages.push(p);
    });

    var stops = Object.keys(groups).map(function (k) { return groups[k]; });
    stops.sort(function (a, b) {
      var rc = String(a.routeCode || '').localeCompare(String(b.routeCode || ''), 'en', { numeric: true });
      if (rc) return rc;
      return Number(a.stop || 0) - Number(b.stop || 0);
    });

    var html = '<table style="width:100%;border-collapse:collapse;font-size:11px">' +
      '<thead><tr><th style="text-align:left">Route</th><th>Stop</th><th style="text-align:left">Driver</th><th>個数</th><th>予定</th></tr></thead><tbody>';
    stops.forEach(function (s) {
      var tids = s.packages.map(function (p) { return String(p.trackingId || '-'); });
      var detail = tids.map(function (tid) { return '<div style="padding:2px 0;font-family:monospace">' + escHtml(tid) + '</div>'; }).join('');
      html += '<tr style="border-top:1px solid #333">' +
        '<td>' + escHtml(s.routeCode) + '</td>' +
        '<td style="text-align:center">' + escHtml(String(s.stop == null ? '-' : s.stop)) + '</td>' +
        '<td>' + escHtml(s.driverName) + '</td>' +
        '<td style="text-align:center;font-weight:bold">' + s.packages.length + '</td>' +
        '<td style="text-align:center">' + escHtml(s.plannedEndClock) + '</td></tr>';
      if (s.packages.length > 1) {
        html += '<tr><td colspan="5" style="padding:0 8px 5px 28px"><details><summary style="cursor:pointer;opacity:.8">TID ' +
          s.packages.length + '件</summary>' + detail + '</details></td></tr>';
      } else {
        html += '<tr><td colspan="5" style="padding:0 8px 4px 28px;opacity:.65;font-family:monospace">' +
          escHtml(tids[0]) + '</td></tr>';
      }
    });
    host.innerHTML = html + '</tbody></table>';
  }

  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];
    });
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
    var ps = prioritySummary();
    setText('ofk3-poc-priority', ps.stops + ' Stops / ' + ps.packages + ' Packages');
    setText('ofk3-poc-progress', ps.routes + ' / ' + ps.selected + ' Routes（失敗 ' + ps.failures + '）');
    paintPriorityTable();
    setText('ofk3-poc-domroutes', domRouteSnapshot());
    var traceView = wheelTraceEarly.concat(wheelTrace.slice(-12));
    setText('ofk3-poc-wheeltrace', traceView.length ? traceView.join(' | ') : '-');
  }

  function setPanelClickable(on) {
    var box = document.getElementById(PANEL_ID);
    if (!box) return;
    box.style.pointerEvents = on ? 'auto' : 'none';
  }

  function extensionImport(payload) {
    return new Promise(function (resolve, reject) {
      var requestId = 'ofk3-import-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var timer = setTimeout(function () {
        global.removeEventListener('message', onMessage);
        reject(new Error('OFK3送信がタイムアウトしました'));
      }, 20000);
      function onMessage(ev) {
        if (ev.source !== global || !ev.data || ev.data.source !== 'OFK3_CORTEX') return;
        if (ev.data.type !== 'ofk3-priority-import-result' || ev.data.requestId !== requestId) return;
        clearTimeout(timer);
        global.removeEventListener('message', onMessage);
        if (ev.data.ok) resolve(ev.data.body || {});
        else reject(new Error(ev.data.message || 'OFK3送信に失敗しました'));
      }
      global.addEventListener('message', onMessage);
      global.postMessage({
        source: 'OFK3_CORTEX',
        type: 'ofk3-priority-import',
        requestId: requestId,
        payload: payload
      }, location.origin);
    });
  }

  async function sendPriorityToOfk3() {
    var bundle = Core.buildCaptureBundle(store, { localDate: currentLocalDate() });
    var result = Core.ingestBundle(bundle);
    if (!result || !result.ok || !result.packages || !result.packages.length) {
      alert('13時優先データがありません。先に取得を完了してください。');
      return;
    }
    try {
      var body = await extensionImport({
        localDate: currentLocalDate(),
        source: 'cortex-capture-extension',
        stopCount: result.stopCount || 0,
        packageCount: result.packageCount || 0,
        packages: result.packages
      });
      alert('OFK3 Previewへ送信しました：' + body.stopCount + ' Stops / ' + body.packageCount + ' Packages');
    } catch (e) {
      alert('OFK3送信に失敗しました: ' + e.message);
    }
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
    box.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;padding:12px;font:12px/1.5 sans-serif;border-radius:8px;width:620px;max-width:calc(100vw - 24px);max-height:78vh;overflow:auto;');
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
      '<div style="margin-top:6px;font-weight:bold">13:00優先: <span id="ofk3-poc-priority">0 Stops / 0 Packages</span></div>' +
      '<div>取得進捗: <span id="ofk3-poc-progress">0 / 0 Routes</span></div>' +
      '<div style="margin-top:8px;max-height:280px;overflow:auto;background:#181818;padding:6px;border-radius:4px" id="ofk3-priority-list"></div>' +
      '<details style="margin-top:8px"><summary style="cursor:pointer;opacity:.75">開発診断</summary>' +
      '<div style="margin-top:4px;word-break:break-word">診断: <span id="ofk3-poc-error">-</span></div>' +
      '<div style="margin-top:4px;word-break:break-word">DOM Route: <span id="ofk3-poc-domroutes">-</span></div>' +
      '<div style="margin-top:4px;word-break:break-word;max-height:130px;overflow:auto">Wheel履歴: <span id="ofk3-poc-wheeltrace">-</span></div></details>';
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
    row.appendChild(mk('OFK3へ送信', function () { sendPriorityToOfk3(); }));
    row.appendChild(mk('13時結果保存', function () {
      var bundle = Core.buildCaptureBundle(store, { localDate: currentLocalDate() });
      var result = Core.ingestBundle(bundle);
      try {
        var blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'cortex-13-priority_' + currentLocalDate() + '.json';
        a.click();
      } catch (e) { alert('13時結果JSONの保存に失敗しました。'); }
    }));
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

  function visibleRouteCards() {
    var out = [];
    var nodes = document.querySelectorAll('[class*="route-"]');
    for (var i = 0; i < nodes.length; i++) {
      if (inPanel(nodes[i])) continue;
      if (/(?:^|\s)route-[^\s]+/.test(String(nodes[i].className || ''))) out.push(nodes[i]);
    }
    return out;
  }

  function candidateScrollers() {
    var out = [];
    var seen = [];
    function add(el, force) {
      if (!el || inPanel(el)) return;
      if (seen.indexOf(el) >= 0) return;
      var delta = (el.scrollHeight || 0) - (el.clientHeight || 0);
      if (!force && delta < 40) return;
      seen.push(el);
      out.push(el);
    }

    var cards = visibleRouteCards();
    for (var c = 0; c < cards.length; c++) {
      var cur = cards[c].parentElement;
      for (var depth = 0; cur && depth < 12; depth += 1, cur = cur.parentElement) {
        var overflow = '';
        try { overflow = global.getComputedStyle(cur).overflowY; } catch (e1) {}
        var delta = (cur.scrollHeight || 0) - (cur.clientHeight || 0);
        if (delta >= 20 || overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') {
          add(cur, true);
        }
      }
    }

    add(document.scrollingElement || document.documentElement, false);
    var nodes = document.querySelectorAll('div, section, main, tbody, [role="rowgroup"], [role="grid"], [role="table"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var overflowY = '';
      try { overflowY = global.getComputedStyle(el).overflowY; } catch (e2) {}
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') add(el, false);
    }

    out.sort(function (a, b) {
      function routeDescendants(el) {
        try { return el.querySelectorAll('[class*="route-"]').length; } catch (e3) { return 0; }
      }
      var ar = routeDescendants(a);
      var br = routeDescendants(b);
      if (ar !== br) return br - ar;
      var aDelta = (a.scrollHeight || 0) - (a.clientHeight || 0);
      var bDelta = (b.scrollHeight || 0) - (b.clientHeight || 0);
      return bDelta - aDelta;
    });
    return out;
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
      var text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
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
    var scrollers = candidateScrollers();
    if (!scrollers.length) {
      done(null, {
        error: Core.ERROR.DOM_NOT_FOUND,
        message: 'Route DOM未発見（scroll候補なし）: routeId=' + String(route.routeId || '-') + ' / routeCode=' + String(route.routeCode || '-')
      });
      return;
    }
    var scrollerIndex = 0;
    var totalScans = 0;

    function scanScroller() {
      if (!Core.pocRunIsCurrent(pocRun, runId)) return;
      if (scrollerIndex >= scrollers.length) {
        waitTimer = 0;
        done(null, {
          error: Core.ERROR.DOM_NOT_FOUND,
          message: 'Route DOM未発見（scroll候補' + scrollers.length + '個 / scan ' + totalScans + '回）: routeId=' + String(route.routeId || '-') + ' / routeCode=' + String(route.routeCode || '-')
        });
        return;
      }
      var scroller = scrollers[scrollerIndex];
      var stepPx = Math.max(100, Math.floor((scroller.clientHeight || 300) * 0.55));
      var y = 0;
      var localScans = 0;

      function scan() {
        if (!Core.pocRunIsCurrent(pocRun, runId)) return;
        el = findRouteCardByRouteId(route.routeId) || findVisibleRouteByCode(route);
        if (el) {
          waitTimer = 0;
          done(el, null);
          return;
        }
        var maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
        if (localScans >= 100 || (localScans > 0 && y > maxScroll)) {
          scrollerIndex += 1;
          waitTimer = setTimeout(scanScroller, 80);
          return;
        }
        scroller.scrollTop = Math.min(y, maxScroll);
        try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e1) {}
        localScans += 1;
        totalScans += 1;
        y += stepPx;
        waitTimer = setTimeout(scan, 100);
      }
      scan();
    }
    scanScroller();
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

  function requestCdpWheel(point, deltaY, cb) {
    var finished = false;
    var timer = 0;
    function finish(result) {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', onMsg);
      if (timer) clearTimeout(timer);
      cb(result || { ok: false, error: 'DEBUGGER_WHEEL', message: 'CDP wheel失敗' });
    }
    function onMsg(ev) {
      if (ev.source !== window) return;
      var data = ev.data;
      if (!data || data.source !== 'OFK3_CORTEX' || data.type !== 'cdp-wheel-result') return;
      finish(data);
    }
    window.addEventListener('message', onMsg);
    window.postMessage({
      source: 'OFK3_CORTEX',
      type: 'cdp-wheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: deltaY
    }, location.origin);
    timer = setTimeout(function () {
      finish({ ok: false, error: 'DEBUGGER_WHEEL_TIMEOUT', message: 'CDP wheel応答なし' });
    }, 8000);
  }

  function visibleTargetRoute() {
    var routes = tour.routes || [];
    for (var i = 0; i < routes.length; i++) {
      var route = routes[i];
      if (!route || !route.routeId) continue;
      if (store.detailsByRouteId[route.routeId]) continue;
      if (tour.visitedRouteIds && tour.visitedRouteIds[route.routeId]) continue;
      var card = findRouteCardByRouteId(route.routeId);
      if (!card) continue;
      var rect = null;
      try { rect = card.getBoundingClientRect(); } catch (e1) {}
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      // The Cortex list keeps route cards mounted outside the viewport. Do not
      // reject an existing target merely because it is currently off-screen:
      // clickRoute() scrolls the exact card into view before deriving CDP coords.
      return { route: route, card: card };
    }
    return null;
  }

  function routeViewportPoint() {
    var scrollers = candidateScrollers();
    for (var s = 0; s < scrollers.length; s++) {
      var scroller = scrollers[s];
      var routeCount = 0;
      try { routeCount = scroller.querySelectorAll('[class*="route-"]').length; } catch (e0) {}
      if (!routeCount) continue;
      var sr = null;
      try { sr = scroller.getBoundingClientRect(); } catch (e1) {}
      if (!sr || sr.width <= 0 || sr.height <= 0) continue;
      var x = Math.max(sr.left + 8, Math.min(sr.right - 8, sr.left + sr.width / 2));
      var y = Math.max(sr.top + 8, Math.min(sr.bottom - 8, sr.top + sr.height / 2));
      if (x > 0 && x < global.innerWidth && y > 0 && y < global.innerHeight) {
        lastRoutePoint = { x: x, y: y };
        return lastRoutePoint;
      }
    }

    var cards = visibleRouteCards();
    for (var i = 0; i < cards.length; i++) {
      var rect = null;
      try { rect = cards[i].getBoundingClientRect(); } catch (e2) {}
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom < 0 || rect.top > global.innerHeight || rect.right < 0 || rect.left > global.innerWidth) continue;
      lastRoutePoint = { x: Math.max(1, Math.min(global.innerWidth - 1, rect.left + rect.width / 2)), y: Math.max(1, Math.min(global.innerHeight - 1, rect.top + rect.height / 2)) };
      return lastRoutePoint;
    }
    if (lastRoutePoint) return { x: lastRoutePoint.x, y: lastRoutePoint.y };
    return { x: Math.max(1, Math.floor(global.innerWidth * 0.22)), y: Math.max(1, Math.floor(global.innerHeight * 0.72)) };
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

  function firstPendingTourRoute() {
    var routes = tour.routes || [];
    for (var i = 0; i < routes.length; i++) {
      var route = routes[i];
      if (!route || !route.routeId) continue;
      if (store.detailsByRouteId[route.routeId]) continue;
      if (tour.visitedRouteIds && tour.visitedRouteIds[route.routeId]) continue;
      return route;
    }
    return null;
  }

  function runNextRoute() {
    pushWheelTrace('runNext/entry', null);
    paint();
    if (stopRequested || !sessionBusy) {
      tour.status = 'stopped';
      paint();
      return;
    }
    var remaining = firstPendingTourRoute();
    pushWheelTrace('runNext/pending', null);
    paint();
    if (!remaining) {
      sessionBusy = false;
      tour.status = 'done';
      if (pocRun && pocRun.diagnostics) {
        pocRun.diagnostics.error = '';
        pocRun.diagnostics.message = '';
      }
      paint();
      return;
    }

    pushWheelTrace('visible/before', null);
    var visible = visibleTargetRoute();
    pushWheelTrace('visible/after=' + (visible ? 'yes' : 'no'), null);
    paint();
    if (!visible) {

      if (!tour.wheelDirection) tour.wheelDirection = 'up';
      tour.wheelAttempts = (tour.wheelAttempts || 0) + 1;
      if (tour.wheelDirection === 'up' && tour.wheelAttempts > 12) {
        tour.wheelDirection = 'down';
        tour.wheelAttempts = 1;
      } else if (tour.wheelDirection === 'down' && tour.wheelAttempts > 30) {
        sessionBusy = false;
        tour.status = 'done';
        pocRun = Core.createPocRun(remaining);
        finishPoc({
          error: Core.ERROR.DOM_NOT_FOUND,
          message: '可視Route探索停止: 上方向12回＋下方向30回のCDP wheel後も未取得11時便が残っています'
        });
        return;
      }
      var point = routeViewportPoint();
      var deltaY = tour.wheelDirection === 'up' ? -720 : 520;
      pushWheelTrace((tour.wheelDirection || '?') + '#' + tour.wheelAttempts + '/before', point);
      paint();
      requestCdpWheel(point, deltaY, function (res) {
        pushWheelTrace((tour.wheelDirection || '?') + '#' + tour.wheelAttempts + '/after=' + ((res && res.ok) ? 'ok' : 'fail'), point);
        paint();
        if (stopRequested || !sessionBusy) return;
        if (!res || !res.ok) {
          sessionBusy = false;
          pocRun = Core.createPocRun(remaining);
          finishPoc({
            error: (res && res.error) || 'DEBUGGER_WHEEL',
            message: (res && res.message) || 'CDP wheelに失敗しました'
          });
          return;
        }
        waitTimer = setTimeout(function () {
          waitTimer = 0;
          runNextRoute();
        }, 220);
      });
      return;
    }

    tour.wheelAttempts = 0;
    var route = visible.route;
    route._ofk3BeforeHref = String(global.location.href || '');
    route._ofk3BeforeHistoryLength = global.history ? global.history.length : 0;
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
          message: (cdpRes && cdpRes.message) || '可視RouteのCDPクリックに失敗しました'
        });
        return;
      }
      waitForCurrentRoute(route, runId);
    });
  }

  function restoreRouteListThenContinue(route, failureInfo) {
    var beforeHref = String((route && route._ofk3BeforeHref) || '');
    var beforeLen = Number((route && route._ofk3BeforeHistoryLength) || 0);
    var nowHref = String(global.location.href || '');
    var nowLen = global.history ? global.history.length : 0;
    var hasRouteDom = document.querySelectorAll('[class*="route-"]').length > 0;

    if (hasRouteDom) {
      finishCurrentAndContinue(failureInfo);
      return;
    }

    if (global.history && (nowHref !== beforeHref || nowLen > beforeLen)) {
      pushWheelTrace('restore/back', null);
      try { global.history.back(); } catch (e1) {}
      var started = Date.now();
      function waitList() {
        var count = document.querySelectorAll('[class*="route-"]').length;
        if (count > 0) {
          pushWheelTrace('restore/ok', null);
          paint();
          finishCurrentAndContinue(failureInfo);
          return;
        }
        if (Date.now() - started >= 4000) {
          sessionBusy = false;
          tour.status = 'done';
          if (pocRun && pocRun.diagnostics) {
            pocRun.diagnostics.error = 'ROUTE_LIST_RESTORE_TIMEOUT';
            pocRun.diagnostics.message = 'route-details取得後、history.back()でRoute一覧へ戻れませんでした';
          }
          if (pocRun) Core.endPocRun(pocRun, store, { error: 'ROUTE_LIST_RESTORE_TIMEOUT' });
          paint();
          return;
        }
        waitTimer = setTimeout(waitList, 150);
      }
      waitTimer = setTimeout(waitList, 150);
      return;
    }

    sessionBusy = false;
    tour.status = 'done';
    if (pocRun && pocRun.diagnostics) {
      pocRun.diagnostics.error = 'ROUTE_LIST_NAV_UNKNOWN';
      pocRun.diagnostics.message = 'Routeクリック後にDOMは消えましたがURL/history変化がなく、安全に一覧へ戻す方法を判定できません';
    }
    if (pocRun) Core.endPocRun(pocRun, store, { error: 'ROUTE_LIST_NAV_UNKNOWN' });
    paint();
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
        restoreRouteListThenContinue(route, null);
        return;
      }
      if (Date.now() - started >= tour.timeoutMs) {
        pocRun.diagnostics.details = 'timeout';
        var key = String(route.routeId || route.routeCode || '');
        tour.retryCounts = tour.retryCounts || {};
        var retries = Number(tour.retryCounts[key] || 0);
        if (retries < 2) {
          tour.retryCounts[key] = retries + 1;
          // Allow this route to be selected again after returning to the list.
          if (tour.visitedRouteIds && route.routeId) delete tour.visitedRouteIds[route.routeId];
          pushWheelTrace('retry#' + (retries + 1) + ':' + (route.routeCode || route.routeId || '?'), null);
          if (pocRun && pocRun.diagnostics) {
            pocRun.diagnostics.message = 'route-details timeout。自動再試行 ' + (retries + 1) + '/2';
          }
          restoreRouteListThenContinue(route, {
            error: Core.ERROR.TIMEOUT,
            message: 'route-details timeout。自動再試行 ' + (retries + 1) + '/2'
          });
          return;
        }
        finishCurrentAndContinue({
          error: Core.ERROR.TIMEOUT,
          message: 'route-details が3回とも捕捉できませんでした（初回＋再試行2回）'
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
    tour.wheelAttempts = 0;
    tour.wheelDirection = 'up';
    tour.retryCounts = {};
    wheelTrace = [];
    wheelTraceEarly = [];
    lastRoutePoint = null;
    var initialPoint = routeViewportPoint();
    pushWheelTrace('start', initialPoint);
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
