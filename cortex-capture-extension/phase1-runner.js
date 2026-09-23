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
  var panelCollapsed = true;
  var lastAutoCollapsedKey = '';
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

  function setPanelCollapsed(collapsed) {
    panelCollapsed = !!collapsed;
    var box = document.getElementById(PANEL_ID);
    var body = document.getElementById('ofk3-poc-body');
    var toggle = document.getElementById('ofk3-poc-toggle');
    if (!box) return;
    if (body) body.style.display = panelCollapsed ? 'none' : 'block';
    if (panelCollapsed) {
      box.style.width = 'auto';
      box.style.maxHeight = 'none';
      box.style.overflow = 'visible';
      box.style.padding = '8px';
    } else {
      box.style.width = '620px';
      box.style.maxHeight = '78vh';
      box.style.overflow = 'auto';
      box.style.padding = '12px';
    }
    if (toggle) {
      if (sessionBusy || (tour && tour.status === 'running')) toggle.textContent = 'Cortex 取得中…';
      else toggle.textContent = 'Cortex';
    }
  }

  function maybeAutoCollapse() {
    if (sessionBusy) return;
    if (!tour || tour.status !== 'done') return;
    var key = String(tour.currentRouteId || '') + ':' + String(tour.progress || '') + ':done';
    if (lastAutoCollapsedKey === key) return;
    lastAutoCollapsedKey = key;
    setPanelCollapsed(true);
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
    var toggle = document.getElementById('ofk3-poc-toggle');
    if (toggle) {
      if (sessionBusy || (tour && tour.status === 'running')) toggle.textContent = 'Cortex 取得中…';
      else toggle.textContent = 'Cortex';
    }
    maybeAutoCollapse();
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
    var packages = (result && result.packages) || [];
    var routeStops = (result && result.routeStops) || [];
    var packageSequenceIndex = (result && result.packageSequenceIndex) || [];
    var packageAssistIndex = (result && result.packageAssistIndex) || [];
    if (!result || !result.ok || (!packages.length && !routeStops.length)) {
      alert('13時優先データがありません。先に取得を完了してください。');
      return;
    }
    try {
      var body = await extensionImport({
        localDate: currentLocalDate(),
        source: 'cortex-capture-extension',
        stopCount: result.stopCount || 0,
        packageCount: result.packageCount || 0,
        packages: packages,
        routeStops: routeStops,
        packageSequenceIndex: packageSequenceIndex,
        packageSequenceDiagnostics: result.packageSequenceDiagnostics || null,
        packageSequenceRouteCount: result.packageSequenceRouteCount || 0,
        packageAssistIndex: packageAssistIndex,
        packageAssistDiagnostics: result.packageAssistDiagnostics || null
      });
      var idxCount = Array.isArray(body.packageSequenceIndex)
        ? body.packageSequenceIndex.length
        : (body.packageSequenceIndexCount != null ? body.packageSequenceIndexCount : packageSequenceIndex.length);
      var assistCount = Array.isArray(body.packageAssistIndex)
        ? body.packageAssistIndex.length
        : (body.packageAssistIndexCount != null ? body.packageAssistIndexCount : packageAssistIndex.length);
      alert('OFK3 Previewへ送信しました：' + body.stopCount + ' Stops / ' + body.packageCount +
        ' Packages / index ' + idxCount + ' / assist ' + assistCount);
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
    box.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;padding:8px;font:12px/1.5 sans-serif;border-radius:8px;width:auto;max-width:calc(100vw - 24px);');
    box.innerHTML = '<button type="button" id="ofk3-poc-toggle" style="background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 10px;font:12px/1.2 sans-serif;cursor:pointer;">Cortex</button>' +
      '<div id="ofk3-poc-body" style="display:none;margin-top:8px;">' +
      '<b>OFK3 Cortex取得</b> <span style="opacity:.8">Phase 2</span>' +
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
      '<div style="margin-top:4px;word-break:break-word;max-height:130px;overflow:auto">Wheel履歴: <span id="ofk3-poc-wheeltrace">-</span></div></details>' +
      '<div style="margin-top:6px;word-break:break-word">Bag: <span id="ofk3-bag-status">未実行</span></div>' +
      '<div id="ofk3-poc-actions" style="margin-top:8px;"></div>' +
      '</div>';
    var row = box.querySelector('#ofk3-poc-actions');
    function mk(label, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('style', 'margin:0 6px 6px 0;');
      b.onclick = fn;
      return b;
    }
    if (row) {
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
      row.appendChild(mk('Bag取得', function () { startBagPhase(); }));
      row.appendChild(mk('Bag診断保存', function () { saveBagDiagnostics(); }));
      row.appendChild(mk('停止', function () {
        if (bagActive()) stopBagPhase();
        else stopPoc();
      }));
    }
    document.documentElement.appendChild(box);
    var toggle = box.querySelector('#ofk3-poc-toggle');
    if (toggle) {
      toggle.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        setPanelCollapsed(!panelCollapsed);
      };
    }
    setPanelCollapsed(true);
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
    lastAutoCollapsedKey = '';
    setPanelCollapsed(false);
    if (sessionBusy) return;
    if (pocRun && pocRun.active && !pocRun.ended) return;
    if (bagActive()) return;
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

  // ---- Bag enrichment phase ----
  // Separate from the Route tour above: started only by the「Bag取得」button after the
  // normal capture is complete. Route -> Stop -> Package order comes from Core.runBagEngine;
  // this block is only the DOM driver. Stops are opened and package numbers clicked via the
  // existing CDP click so Cortex itself POSTs /tasks/trDetails; the existing fetch/XHR hook
  // stores the Response. Normal results are frozen before and restored after; nothing is
  // added to store.failures.
  var BAG_PACKAGE_TIMEOUT_MS = 4500;
  var BAG_ROUTE_BUDGET_MS = 120000;
  var BAG_HISTORY_TIMEOUT_MS = 4000;
  var BAG_STOP_EXPAND_TIMEOUT_MS = 3000;
  var BAG_DIALOG_CLOSE_TIMEOUT_MS = 2000;
  var BAG_STOP_SCROLL_MAX_STEPS = 80;
  var BAG_PACKAGE_SCROLL_MAX_STEPS = 12;
  var BAG_ROUTE_OPEN_ATTEMPTS = 3;
  var BAG_STOP_APPEAR_TIMEOUT_MS = 6000;
  var BAG_BUILD = 'Bag v3.1';
  var bagRun = null;
  var bagTimer = 0;
  var bagSnapshot = null;
  var bagProgressText = '';
  var bagEngine = null;

  function bagActive() {
    return !!(bagRun && !bagRun.ended);
  }

  function bagIsCurrent(runId) {
    return !!(bagRun && bagRun.id === runId && !bagRun.ended && !bagRun.stopRequested);
  }

  // An exception inside a Bag timer ends only the current Route (never the tour or the page).
  function bagLater(fn, ms) {
    bagTimer = setTimeout(function () {
      bagTimer = 0;
      try {
        fn();
      } catch (e) {
        if (bagEngine && bagActive()) bagEngine.failRoute('exception: ' + (e && e.message ? e.message : String(e)));
      }
    }, ms);
  }

  function bagLog(line) {
    try { console.info(line); } catch (e1) {}
  }

  function setBagStatus(text) {
    bagProgressText = String(text || '');
    var el = document.getElementById('ofk3-bag-status');
    if (el) {
      el.style.whiteSpace = 'pre-line';
      el.textContent = bagProgressText;
    }
  }

  function afterBagLayout(fn) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { requestAnimationFrame(fn); });
    } else {
      bagLater(fn, 50);
    }
  }

  function hrefNow() {
    return String(global.location.href || '');
  }

  function waitBag(check, timeoutMs, runId, done) {
    var started = Date.now();
    function poll() {
      if (!bagIsCurrent(runId)) return;
      if (check()) { done(true); return; }
      if (Date.now() - started >= timeoutMs) { done(false); return; }
      bagLater(poll, 150);
    }
    poll();
  }

  // Short, non-secret description of an element for diagnostics (generated css-* classes dropped).
  function describeEl(el) {
    if (!el || !el.tagName) return '-';
    var out = String(el.tagName).toLowerCase();
    if (el.id) out += '#' + el.id;
    var cls = String(el.className && el.className.baseVal != null ? el.className.baseVal : (el.className || ''))
      .split(/\s+/).filter(function (c) { return c && !/^css-/.test(c); }).slice(0, 2);
    if (cls.length) out += '.' + cls.join('.');
    var role = el.getAttribute && el.getAttribute('role');
    if (role) out += '[role=' + role + ']';
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) out += '[aria-label=' + String(aria).slice(0, 20) + ']';
    var text = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (text) out += ' "' + text + '"';
    return out;
  }

  function elementVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e1) {}
    return !!(r && r.width > 0 && r.height > 0);
  }

  // Text-node walk: innermost element whose textContent passes accept(text). Panel excluded.
  function collectTextElements(root, acceptText) {
    var els = [];
    root = root || document.body || document.documentElement;
    if (!root) return els;
    var walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, null);
    var node;
    while ((node = walker.nextNode())) {
      var value = String(node.nodeValue || '').trim();
      if (!value) continue;
      var el = node.parentElement;
      if (!el || inPanel(el) || els.indexOf(el) >= 0) continue;
      if (!acceptText(String(el.textContent || ''), value)) continue;
      els.push(el);
    }
    return els;
  }

  // Exact textContent.trim() === scannableId, across the whole document (uniqueness is global).
  function collectExactDaElements(scannableIds) {
    var want = {};
    scannableIds.forEach(function (id) { want[id] = true; });
    var els = collectTextElements(null, function (full, own) { return !!want[own]; });
    var entries = els.map(function (el, i) { return { text: el.textContent, key: i }; });
    var byText = Core.indexExactDomTextMatches(entries, scannableIds);
    var out = {};
    Object.keys(byText).forEach(function (text) {
      out[text] = byText[text].map(function (idx) { return els[idx]; });
    });
    return out;
  }

  // Stop label = innermost element (text-node parent or up to 2 ancestors, short text only)
  // whose whole text is an exact label. Ancestors cover labels split over child elements,
  // e.g. <span>Stop</span><span>16</span> or <span>#</span><span>16</span>.
  function collectStopLabelElements(root) {
    var els = [];
    var base = root || document.body || document.documentElement;
    if (!base) return els;
    var walker = document.createTreeWalker(base, 4 /* NodeFilter.SHOW_TEXT */, null);
    var node;
    while ((node = walker.nextNode())) {
      if (!String(node.nodeValue || '').trim()) continue;
      var el = node.parentElement;
      for (var d = 0; el && d < 3; d += 1, el = el.parentElement) {
        if (inPanel(el) || (root && !root.contains(el))) break;
        var t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 20) break;
        if (Core.parseStopLabel(t) != null) {
          if (els.indexOf(el) < 0) els.push(el);
          break;
        }
      }
    }
    return els;
  }

  function stopLabelsFor(els, seq) {
    var entries = els.map(function (el, i) { return { text: el.textContent, key: i }; });
    return Core.matchStopLabelEntries(entries, seq).map(function (i) { return els[i]; });
  }

  function findStopLabels(seq) {
    return stopLabelsFor(collectStopLabelElements(null), seq);
  }

  // ---- Bag diagnostics (Stop detection). Short texts only; long texts become [text:N]. ----
  function diagText(el, max) {
    var t = String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length <= (max || 12) ? t : '[text:' + t.length + ']';
  }

  function diagEl(el) {
    if (!el || !el.tagName) return '-';
    var out = String(el.tagName).toLowerCase();
    if (el.id) out += '#' + String(el.id).slice(0, 30);
    var cls = String(el.className && el.className.baseVal != null ? el.className.baseVal : (el.className || ''))
      .split(/\s+/).filter(function (c) { return c && !/^css-/.test(c); }).slice(0, 3);
    if (cls.length) out += '.' + cls.join('.');
    ['role', 'aria-label', 'aria-expanded', 'data-testid', 'mdn-text'].forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a);
      if (v != null && v !== '') out += '[' + a + '=' + String(v).slice(0, 24) + ']';
    });
    var t = diagText(el, 12);
    if (t) out += ' "' + t + '"';
    return out;
  }

  function diagOutline(root, maxNodes) {
    var lines = [];
    function walk(el, depth) {
      if (!el || lines.length >= maxNodes || depth > 4 || inPanel(el)) return;
      var kids = el.children || [];
      lines.push(new Array(depth + 1).join('  ') + diagEl(el) + (kids.length ? ' {' + kids.length + '}' : ''));
      for (var i = 0; i < kids.length && i < 4; i++) walk(kids[i], depth + 1);
    }
    walk(root, 0);
    return lines;
  }

  function diagExactText(values, limit) {
    var want = {};
    values.forEach(function (v) { want[v] = true; });
    var hits = collectTextElements(null, function (full) {
      return !!want[String(full).replace(/\s+/g, ' ').trim()];
    });
    return {
      count: hits.length,
      samples: hits.slice(0, limit || 3).map(function (el) {
        return diagEl(el) + ' < ' + diagEl(el.parentElement) + ' < ' + diagEl(el.parentElement && el.parentElement.parentElement);
      })
    };
  }

  function routeDomSnapshot(route, extra) {
    var targets = (route && route.targets) || [];
    var labels = collectStopLabelElements(null);
    var all = document.querySelectorAll('*');
    var shadowHosts = 0;
    for (var i = 0; i < all.length; i++) { if (all[i].shadowRoot) shadowHosts += 1; }
    function list(sel, limit, fmt) {
      var out = [];
      var nodes = document.querySelectorAll(sel);
      for (var k = 0; k < nodes.length && out.length < limit; k++) {
        if (!inPanel(nodes[k]) && elementVisible(nodes[k])) out.push(fmt(nodes[k]));
      }
      return { count: nodes.length, samples: out };
    }
    var seqs = [];
    targets.forEach(function (t) { if (seqs.indexOf(t.stop) < 0) seqs.push(t.stop); });
    var probes = seqs.slice(0, 3).map(function (seq) {
      return {
        stop: seq,
        bareNumber: diagExactText([String(seq)], 3),
        labelForms: diagExactText(['#' + seq, '# ' + seq, 'Stop ' + seq, 'Stop #' + seq, 'ストップ ' + seq], 3)
      };
    });
    var das = targets.map(function (t) { return t.scannableId; });
    var visibleDa = collectExactDaElements(das);
    var scroller = bagMainScroller();
    var stopWords = collectTextElements(null, function (full) {
      var t = String(full).replace(/\s+/g, ' ').trim();
      return t.length <= 30 && /stop|ストップ|停車|配達先|訪問/i.test(t);
    });
    return Object.assign({
      at: new Date().toISOString(),
      routeCode: route && route.routeCode,
      url: hrefNow(),
      title: String(document.title || '').slice(0, 80),
      headings: list('h1, h2, h3, h4, [role="heading"]', 8, function (el) { return diagText(el, 30); }),
      tabs: list('[role="tab"]', 10, function (el) { return diagEl(el); }),
      controls: list('button, a[href], [role="button"], [role="link"], [role="tab"], [aria-expanded]', 25, function (el) { return diagEl(el); }),
      roles: ['list', 'listitem', 'row', 'grid', 'treeitem', 'region', 'dialog'].reduce(function (m, r) {
        m[r] = document.querySelectorAll('[role="' + r + '"]').length;
        return m;
      }, {}),
      iframes: document.querySelectorAll('iframe').length,
      shadowHosts: shadowHosts,
      elementCount: all.length,
      stopLabelCandidates: { count: labels.length, samples: labels.slice(0, 10).map(diagEl) },
      stopWordTexts: stopWords.slice(0, 10).map(diagEl),
      targetStopProbes: probes,
      packageNumbersVisible: collectTextElements(null, function (full) { return Core.isPackageNumberText(full); }).length,
      targetDaVisible: Object.keys(visibleDa).length,
      mainScroller: scroller ? {
        el: diagEl(scroller), scrollHeight: scroller.scrollHeight || 0, clientHeight: scroller.clientHeight || 0,
        children: (scroller.children || []).length
      } : null,
      outline: scroller ? diagOutline(scroller, 40) : []
    }, extra || {});
  }

  function pushRouteDiag(entry) {
    if (!bagRun) return;
    bagRun.routeDiagnostics = bagRun.routeDiagnostics || [];
    if (bagRun.routeDiagnostics.length < 60) bagRun.routeDiagnostics.push(entry);
  }

  // Highest ancestor holding this Stop label and no other Stop label.
  function stopBlockOf(label) {
    var block = label;
    for (var cur = label.parentElement, depth = 0; cur && depth < 10; depth += 1, cur = cur.parentElement) {
      if (cur === document.body || cur === document.documentElement || inPanel(cur)) break;
      if (collectStopLabelElements(cur).length > 1) break;
      block = cur;
    }
    return block;
  }

  // Package card: highest ancestor (<= 8 levels) containing exactly one package-number token.
  function packageCardOf(daEl) {
    var card = daEl;
    for (var cur = daEl.parentElement, depth = 0; cur && depth < 8; depth += 1, cur = cur.parentElement) {
      if (cur === document.body || cur === document.documentElement || inPanel(cur)) break;
      var numbers = collectTextElements(cur, function (full) { return Core.isPackageNumberText(full); });
      if (numbers.length !== 1) break;
      if (collectStopLabelElements(cur).length > 0) break;
      card = cur;
    }
    return card;
  }

  function isNativeClickable(el) {
    if (!el || !el.tagName) return false;
    var tag = String(el.tagName).toLowerCase();
    if (tag === 'a' || tag === 'button') return true;
    var role = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
    if (role === 'button' || role === 'link') return true;
    if (el.hasAttribute && (el.hasAttribute('tabindex') || el.hasAttribute('onclick'))) return true;
    var cursor = '';
    try { cursor = global.getComputedStyle(el).cursor; } catch (e1) {}
    return cursor === 'pointer';
  }

  // The package-number element itself or its nearest clickable ancestor inside the same card.
  function packageClickTarget(daEl, card) {
    for (var cur = daEl; cur; cur = cur.parentElement) {
      if (isNativeClickable(cur)) return cur;
      if (cur === card) break;
    }
    return null;
  }

  function scrollableAncestors(el) {
    var out = [];
    for (var cur = el && el.parentElement, depth = 0; cur && depth < 20; depth += 1, cur = cur.parentElement) {
      if (inPanel(cur)) break;
      var overflowY = '';
      try { overflowY = global.getComputedStyle(cur).overflowY; } catch (e1) {}
      if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
        (cur.scrollHeight || 0) - (cur.clientHeight || 0) > 20) out.push(cur);
    }
    return out;
  }

  // Main scroller of the Route detail: scrollable ancestor of any Stop label, else the largest one.
  function bagMainScroller() {
    var labels = collectStopLabelElements(null);
    for (var i = 0; i < labels.length; i++) {
      var anc = scrollableAncestors(labels[i]);
      if (anc.length) return anc[0];
    }
    var best = null;
    var nodes = document.querySelectorAll('div, section, main, ul, tbody, [role="list"], [role="grid"], [role="table"]');
    for (var j = 0; j < nodes.length; j++) {
      if (inPanel(nodes[j])) continue;
      var overflow = '';
      try { overflow = global.getComputedStyle(nodes[j]).overflowY; } catch (e2) {}
      if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') continue;
      var delta = (nodes[j].scrollHeight || 0) - (nodes[j].clientHeight || 0);
      if (delta > 40 && (!best || delta > (best.scrollHeight - best.clientHeight))) best = nodes[j];
    }
    return best || document.scrollingElement || document.documentElement;
  }

  // Scroll-search: current position first, then downward, then wrap once from the top.
  function scrollSearch(find, maxSteps, runId, done) {
    var scroller = bagMainScroller();
    var steps = 0;
    var wrapped = false;
    function scrollTo(y) {
      scroller.scrollTop = y;
      try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e1) {}
    }
    function tick() {
      if (!bagIsCurrent(runId)) return;
      var hit = find();
      if (hit) { done(hit); return; }
      if (!scroller || steps >= maxSteps) { done(null); return; }
      var maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
      var stepPx = Math.max(100, Math.floor((scroller.clientHeight || 300) * 0.6));
      steps += 1;
      if (scroller.scrollTop >= maxScroll - 1) {
        if (wrapped || maxScroll <= 0) { done(null); return; }
        wrapped = true;
        scrollTo(0);
      } else {
        scrollTo(Math.min(scroller.scrollTop + stepPx, maxScroll));
      }
      bagLater(tick, 160);
    }
    tick();
  }

  function hitAllowed(hit, el, container) {
    if (!hit || inPanel(hit)) return false;
    if (hit === el || el.contains(hit)) return true;
    if (container && (hit === container || container.contains(hit))) return true;
    return hit !== document.body && hit !== document.documentElement && hit.contains(el);
  }

  // Points inside the element's own rect (center first). Each is verified with elementFromPoint.
  function candidatePoints(rect) {
    var c = Core.viewportClickPoint(rect);
    if (!c) return [];
    var pts = [c];
    [[0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]].forEach(function (f) {
      pts.push({ x: rect.left + rect.width * f[0], y: rect.top + rect.height * f[1] });
    });
    return pts.filter(function (p) {
      return p.x > 0 && p.y > 0 && p.x < global.innerWidth && p.y < global.innerHeight;
    });
  }

  // scrollIntoView -> rAF x2 -> rect -> elementFromPoint check -> requestCdpClick.
  // resolve() re-finds the element after layout (virtualized lists re-render on scroll).
  function safeCdpClick(resolve, runId, done) {
    var first = resolve();
    if (!first || !first.el) { done({ ok: false, detail: 'element lost' }); return; }
    try { first.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e1) {}
    afterBagLayout(function () {
      if (!bagIsCurrent(runId)) return;
      var cur = resolve();
      if (!cur || !cur.el) { done({ ok: false, detail: 'element lost after scroll' }); return; }
      var rect = null;
      try { rect = cur.el.getBoundingClientRect(); } catch (e2) {}
      var pts = candidatePoints(rect);
      if (!pts.length) { done({ ok: false, detail: 'no coords' }); return; }
      setPanelClickable(false);
      var point = null;
      var lastHit = null;
      for (var i = 0; i < pts.length && !point; i++) {
        var hit = null;
        try { hit = document.elementFromPoint(pts[i].x, pts[i].y); } catch (e3) {}
        if (hitAllowed(hit, cur.el, cur.container)) point = pts[i];
        else lastHit = hit;
      }
      if (!point) {
        setPanelClickable(true);
        done({ ok: false, covered: true, detail: 'covered by ' + describeEl(lastHit) });
        return;
      }
      requestCdpClick(point, function (res) {
        setPanelClickable(true);
        if (!bagIsCurrent(runId)) return;
        done(res && res.ok ? { ok: true } : { ok: false, detail: (res && (res.message || res.error)) || 'CDP' });
      });
    });
  }

  function visibleDialogs() {
    var out = [];
    var nodes = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
    for (var i = 0; i < nodes.length; i++) {
      if (!inPanel(nodes[i]) && elementVisible(nodes[i]) && out.indexOf(nodes[i]) < 0) out.push(nodes[i]);
    }
    return out;
  }

  // Native close control inside a Cortex dialog: identified by role/aria-label/text, never by position.
  function dialogCloseControl(dialog) {
    var nodes = dialog.querySelectorAll('button, [role="button"], a');
    for (var i = 0; i < nodes.length; i++) {
      var aria = String((nodes[i].getAttribute && nodes[i].getAttribute('aria-label')) || '');
      var text = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(close|閉じる|キャンセル|cancel|戻る|back)$/i.test(aria) ||
        /^(×|✕|✖|x|close|閉じる|キャンセル|cancel|戻る|back)$/i.test(text)) {
        if (elementVisible(nodes[i])) return nodes[i];
      }
    }
    return null;
  }

  // Close dialogs that were not open before (before = list of dialogs to keep).
  function closeNewDialogs(before, runId, done) {
    var fresh = visibleDialogs().filter(function (d) { return (before || []).indexOf(d) < 0; });
    if (!fresh.length) { done({ ok: true }); return; }
    var dialog = fresh[0];
    var control = dialogCloseControl(dialog);
    if (!control) { done({ ok: false, detail: 'dialogの閉じるUIが見つかりません: ' + describeEl(dialog) }); return; }
    safeCdpClick(function () { return control.isConnected ? { el: control, container: dialog } : null; }, runId, function (res) {
      if (!res.ok) { done({ ok: false, detail: 'dialog close click失敗: ' + res.detail }); return; }
      waitBag(function () { return !dialog.isConnected || !elementVisible(dialog); }, BAG_DIALOG_CLOSE_TIMEOUT_MS, runId, function (gone) {
        if (!gone) { done({ ok: false, detail: 'dialogが閉じません: ' + describeEl(dialog) }); return; }
        closeNewDialogs(before, runId, done);
      });
    });
  }

  function historyBackTo(href, runId, done) {
    if (hrefNow() === href) { done(true); return; }
    try { global.history.back(); } catch (e1) { done(false); return; }
    waitBag(function () { return hrefNow() === href; }, BAG_HISTORY_TIMEOUT_MS, runId, done);
  }

  function anyRouteCardShown() {
    var cards = visibleRouteCards();
    for (var i = 0; i < cards.length; i++) {
      if (elementVisible(cards[i])) return true;
    }
    return false;
  }

  function routeListShown(ctx) {
    return hrefNow() === ctx.listHref && anyRouteCardShown();
  }

  // Same search order as the tour: exact card, then CDP wheel up 12 / down 30.
  function findBagRouteCard(route, runId, done) {
    var direction = 'up';
    var attempts = 0;
    function look() {
      if (!bagIsCurrent(runId)) return;
      var card = findRouteCardByRouteId(route.routeId) || findVisibleRouteByCode(route);
      if (card) { done(card); return; }
      attempts += 1;
      if (direction === 'up' && attempts > 12) { direction = 'down'; attempts = 1; }
      else if (direction === 'down' && attempts > 30) { done(null); return; }
      requestCdpWheel(routeViewportPoint(), direction === 'up' ? -720 : 520, function (res) {
        if (!bagIsCurrent(runId)) return;
        if (!res || !res.ok) { done(null); return; }
        bagLater(look, 220);
      });
    }
    look();
  }

  function createBagDriver(ctx, runId) {
    ctx.reopenedStops = {};

    // Route detail reached: wait (condition, bounded) for Stop labels or target DAs, then
    // record what the page shows so a Stop-detection mismatch is visible in the diagnostics.
    function afterRouteOpened(route, basis, cb) {
      ctx.route = route;
      var das = (route.targets || []).map(function (t) { return t.scannableId; });
      var started = Date.now();
      waitBag(function () {
        return collectStopLabelElements(null).length > 0 || Object.keys(collectExactDaElements(das)).length > 0;
      }, BAG_STOP_APPEAR_TIMEOUT_MS, runId, function (appeared) {
        ctx.routeDialogs = visibleDialogs();
        var snap = routeDomSnapshot(route, {
          phase: 'route_opened',
          routeDetailBasis: basis,
          stopWaitMs: Date.now() - started,
          stopCandidatesAppeared: appeared
        });
        pushRouteDiag(snap);
        bagLog('[Bag] ' + route.routeCode + ' opened (' + basis + ') stopLabelCandidates=' + snap.stopLabelCandidates.count +
          ' packageNumbers=' + snap.packageNumbersVisible + ' wait=' + snap.stopWaitMs + 'ms');
        cb({ ok: true });
      });
    }

    var driver = {
      // Up to BAG_ROUTE_OPEN_ATTEMPTS tries: close new dialogs, wait for the list, re-find the
      // card, scrollIntoView + hit test (inside safeCdpClick). Still covered -> UI blocked.
      openRoute: function (route, cb) {
        ctx.routeNoStopLabels = false;
        ctx.stopMissLogged = false;
        if (ctx.currentPage) {
          ctx.routeHref = hrefNow();
          afterRouteOpened(route, 'current page (no navigation)', cb);
          return;
        }
        var attempt = 0;
        var lastDetail = '';
        function tryOpen() {
          if (!bagIsCurrent(runId)) return;
          attempt += 1;
          closeNewDialogs(ctx.baseDialogs, runId, function () {
            waitBag(function () { return routeListShown(ctx); }, 2000, runId, function () {
              findBagRouteCard(route, runId, function (card) {
                if (!card) { cb({ ok: false, code: 'route_card_not_found', detail: 'Route一覧にRoute cardが見つかりません' }); return; }
                var beforeDetails = store.detailsByRouteId[route.routeId] || null;
                safeCdpClick(function () {
                  var c = findRouteCardByRouteId(route.routeId) || findVisibleRouteByCode(route);
                  return c ? { el: findInnerClickTarget(c, route) || c, container: c } : null;
                }, runId, function (res) {
                  if (!res.ok) {
                    lastDetail = 'Route click: ' + res.detail;
                    bagLog('[Bag] ' + route.routeCode + ' ' + (res.covered ? 'Route一覧が覆われています' : 'Route click失敗') +
                      ' (' + attempt + '/' + BAG_ROUTE_OPEN_ATTEMPTS + '): ' + res.detail);
                    if (attempt < BAG_ROUTE_OPEN_ATTEMPTS) { bagLater(tryOpen, 700); return; }
                    cb({ ok: false, blocked: !!res.covered, code: res.covered ? 'ui_blocked' : 'route_click_failed',
                      detail: lastDetail + '（' + attempt + '回試行）' });
                    return;
                  }
                  var basis = '';
                  waitBag(function () {
                    var fresh = store.detailsByRouteId[route.routeId];
                    if (fresh && fresh !== beforeDetails) { basis = 'route-details response captured'; return true; }
                    if (hrefNow() !== ctx.listHref && !anyRouteCardShown()) { basis = 'URL changed and Route list hidden'; return true; }
                    return false;
                  }, tour.timeoutMs || 15000, runId, function (ok) {
                    if (!ok) {
                      pushRouteDiag(routeDomSnapshot(route, { phase: 'route_detail_not_detected' }));
                      cb({ ok: false, code: 'route_detail_not_detected',
                        detail: 'Route click後' + Math.round((tour.timeoutMs || 15000) / 1000) + '秒以内にroute-details/URL変化なし' });
                      return;
                    }
                    ctx.routeHref = hrefNow();
                    afterRouteOpened(route, basis, cb);
                  });
                });
              });
            });
          });
        }
        tryOpen();
      },

      ensureStop: function (stop, pending, onState, cb) {
        if (ctx.routeNoStopLabels) {
          // A full sweep of this Route already found no Stop label of any number: check the
          // current view once (no scrolling) instead of sweeping again for every Stop.
          var quick = findStopLabels(stop.stop);
          var visible = !Core.stopNeedsExpand(pending, collectExactDaElements(pending.map(function (t) { return t.scannableId; })));
          if (!quick.length && !visible) {
            cb({ ok: false, status: Core.BAG_STATUS.STOP_NOT_FOUND,
              detail: 'Stop #' + stop.stop + ' label未発見（このRouteはStop label候補0件）' });
            return;
          }
        }
        ctx.stopBlock = null;
        ctx.stopHref = hrefNow();
        var das = pending.map(function (t) { return t.scannableId; });
        var outcome = null;
        var maxCandidates = 0;
        scrollSearch(function () {
          if (!Core.stopNeedsExpand(pending, collectExactDaElements(das))) {
            outcome = { present: true };
            return outcome;
          }
          var allLabels = collectStopLabelElements(null);
          if (allLabels.length > maxCandidates) maxCandidates = allLabels.length;
          var labels = stopLabelsFor(allLabels, stop.stop);
          if (labels.length > 1) { outcome = { ambiguous: labels.length }; return outcome; }
          if (labels.length === 1) { outcome = { label: labels[0] }; return outcome; }
          return null;
        }, BAG_STOP_SCROLL_MAX_STEPS, runId, function (found) {
          if (!found) {
            if (maxCandidates === 0) ctx.routeNoStopLabels = true;
            if (!ctx.stopMissLogged) {
              ctx.stopMissLogged = true;
              pushRouteDiag(routeDomSnapshot(ctx.route, { phase: 'stop_not_found', stop: stop.stop, maxStopLabelCandidates: maxCandidates }));
            }
            cb({ ok: false, status: Core.BAG_STATUS.STOP_NOT_FOUND,
              detail: 'Stop #' + stop.stop + ' label未発見（探索中のStop label候補 最大' + maxCandidates + '件）' });
            return;
          }
          if (found.present) { cb({ ok: true, clicked: false }); return; }
          if (found.ambiguous) {
            cb({ ok: false, status: Core.BAG_STATUS.STOP_AMBIGUOUS, detail: 'Stop #' + stop.stop + ' label ' + found.ambiguous + '件' });
            return;
          }
          var label = found.label;
          ctx.stopBlock = stopBlockOf(label);
          onState('Stop #' + stop.stop + '展開中');
          safeCdpClick(function () {
            if (label.isConnected) return { el: label, container: ctx.stopBlock };
            var again = findStopLabels(stop.stop);
            if (again.length !== 1) return null;
            label = again[0];
            ctx.stopBlock = stopBlockOf(label);
            return { el: label, container: ctx.stopBlock };
          }, runId, function (res) {
            if (!res.ok) {
              cb({ ok: false, status: Core.BAG_STATUS.STOP_EXPAND_FAILED, detail: 'Stop click: ' + res.detail, blocked: !!res.covered, code: 'stop_click_failed' });
              return;
            }
            waitBag(function () {
              var present = collectExactDaElements(das);
              return !Core.stopNeedsExpand(pending, present);
            }, BAG_STOP_EXPAND_TIMEOUT_MS, runId, function (opened) {
              if (opened) { cb({ ok: true, clicked: true }); return; }
              // Stop click did not render the targets; undo any navigation it caused.
              historyBackTo(ctx.stopHref, runId, function (back) {
                cb({
                  ok: false,
                  clicked: true,
                  status: Core.BAG_STATUS.STOP_EXPAND_FAILED,
                  detail: 'Stop #' + stop.stop + ' click後に対象DAが表示されません',
                  abortRoute: !back,
                  code: 'stop_click_navigation_not_restored'
                });
              });
            });
          });
        });
      },

      findPackage: function (target, stop, cb) {
        driver.searchPackage(target, function (res) {
          if (res.ok || res.status !== Core.BAG_STATUS.PACKAGE_DOM_NOT_FOUND || ctx.reopenedStops[stop.stop]) {
            cb(res);
            return;
          }
          // The Stop may have collapsed after returning from a package detail: reopen it once.
          ctx.reopenedStops[stop.stop] = true;
          driver.ensureStop(stop, [target], function () {}, function (sres) {
            if (sres && sres.clicked) bagRun.stopClicks = (bagRun.stopClicks || 0) + 1;
            if (!sres || !sres.ok) { cb(res); return; }
            driver.searchPackage(target, cb);
          });
        });
      },

      searchPackage: function (target, cb) {
        var lastCount = 0;
        scrollSearch(function () {
          var matches = collectExactDaElements([target.scannableId])[target.scannableId] || [];
          lastCount = matches.length;
          return matches.length ? matches : null;
        }, BAG_PACKAGE_SCROLL_MAX_STEPS, runId, function (matches) {
          var status = Core.domMatchStatus(matches || []);
          if (status === 'none') {
            cb({ ok: false, status: Core.BAG_STATUS.PACKAGE_DOM_NOT_FOUND, detail: 'DA未表示' });
            return;
          }
          if (status === 'ambiguous') {
            cb({ ok: false, status: Core.BAG_STATUS.DOM_AMBIGUOUS, detail: lastCount + ' matches' });
            return;
          }
          var da = matches[0];
          var card = packageCardOf(da);
          var clickEl = packageClickTarget(da, card);
          if (!clickEl) {
            cb({ ok: false, status: Core.BAG_STATUS.PACKAGE_CLICK_TARGET_NOT_FOUND, detail: 'card ' + describeEl(card) });
            return;
          }
          cb({ ok: true, handle: { scannableId: target.scannableId } });
        });
      },

      clickPackage: function (target, handle, cb) {
        ctx.packageHref = hrefNow();
        ctx.packageDialogs = visibleDialogs();
        safeCdpClick(function () {
          var m = collectExactDaElements([handle.scannableId])[handle.scannableId] || [];
          if (m.length !== 1) return null;
          var card = packageCardOf(m[0]);
          var el = packageClickTarget(m[0], card);
          return el ? { el: el, container: card } : null;
        }, runId, function (res) {
          if (res.ok) { cb({ ok: true }); return; }
          if (!res.covered) { cb({ ok: false, detail: res.detail }); return; }
          // Covered: close a native dialog left open (own close UI only) and retry once.
          closeNewDialogs(ctx.routeDialogs || [], runId, function () {
            bagLater(function () {
              safeCdpClick(function () {
                var m = collectExactDaElements([handle.scannableId])[handle.scannableId] || [];
                if (m.length !== 1) return null;
                var card = packageCardOf(m[0]);
                var el = packageClickTarget(m[0], card);
                return el ? { el: el, container: card } : null;
              }, runId, function (res2) {
                if (res2.ok) { cb({ ok: true }); return; }
                cb({ ok: false, detail: res2.detail, blocked: !!res2.covered });
              });
            }, 500);
          });
        });
      },

      waitTrDetails: function (target, cb) {
        waitBag(function () {
          return Core.hasTrDetails(store.trDetailsByTrId, target.referenceId);
        }, BAG_PACKAGE_TIMEOUT_MS, runId, cb);
      },

      restoreAfterPackage: function (target, cb) {
        bagLater(function () {
          historyBackTo(ctx.packageHref, runId, function (back) {
            if (!back) { cb({ ok: false, detail: 'Package detail後にURLが戻りません' }); return; }
            closeNewDialogs(ctx.packageDialogs, runId, function (closed) {
              cb(closed.ok ? { ok: true } : { ok: false, detail: closed.detail });
            });
          });
        }, 300);
      },

      leaveStop: function (stop, cb) {
        historyBackTo(ctx.stopHref, runId, function (back) {
          cb(back ? { ok: true } : { ok: false, detail: 'Stop表示からRoute詳細へ戻れません' });
        });
      },


      returnToList: function (cb) {
        if (ctx.currentPage) { cb({ ok: true }); return; }
        closeNewDialogs(ctx.baseDialogs, runId, function () {
          var backs = 0;
          function step() {
            if (!bagIsCurrent(runId)) return;
            if (routeListShown(ctx)) { cb({ ok: true }); return; }
            if (hrefNow() === ctx.listHref) {
              waitBag(function () { return anyRouteCardShown(); }, BAG_HISTORY_TIMEOUT_MS, runId, function (shown) {
                cb(shown ? { ok: true } : { ok: false, detail: 'Route一覧URLだがRoute cardが見えません' });
              });
              return;
            }
            if (backs >= 3) { cb({ ok: false, detail: 'history.back 3回でも一覧URLに戻りません' }); return; }
            backs += 1;
            try { global.history.back(); } catch (e1) { cb({ ok: false, detail: 'history.back失敗' }); return; }
            waitBag(function () { return hrefNow() === ctx.listHref; }, BAG_HISTORY_TIMEOUT_MS, runId, function () {
              step();
            });
          }
          step();
        });
      }
    };
    return driver;
  }

  function finishBagPhase(aborted) {
    if (!bagRun || bagRun.ended) return;
    if (bagTimer) { clearTimeout(bagTimer); bagTimer = 0; }
    setPanelClickable(true);
    bagRun.aborted = aborted || '';
    bagRun.ended = true;
    Core.restoreNormalCapture(store, bagSnapshot);
    bagSnapshot = null;
    var summary = Core.summarizeBagRun(bagRun, store.trDetailsByTrId);
    store.bagStatusByReferenceId = Object.assign({}, store.bagStatusByReferenceId || {}, summary.byReferenceId);
    bagRun.summary = summary;
    setBagStatus(Core.formatBagSummary(summary) + '\n(' + BAG_BUILD + ')');
    bagLog('[Bag] 完了: 対象 ' + summary.targetCount + ' / 試行済み ' + summary.attempted +
      ' / 未試行 ' + (summary.counts.not_attempted || 0) + (summary.aborted ? ' / 中断: ' + summary.aborted : ''));
    bagEngine = null;
    paint();
  }

  function stopBagPhase() {
    if (!bagActive()) return;
    bagRun.stopRequested = true;
    finishBagPhase('手動停止');
  }

  function routeFromHref(routes) {
    var href = hrefNow();
    var hits = routes.filter(function (r) {
      if (!r.routeId) return false;
      var re = new RegExp('(?:^|[/=?&])' + String(r.routeId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[/?#&])');
      return re.test(href);
    });
    return hits.length === 1 ? hits[0] : null;
  }

  function buildBagDiagnostics() {
    if (!bagRun) return null;
    var results = {};
    Object.keys(bagRun.results || {}).forEach(function (ref) { results[ref] = bagRun.results[ref]; });
    var payload = {
      localDate: currentLocalDate(),
      summary: bagRun.summary || Core.summarizeBagRun(bagRun, store.trDetailsByTrId),
      targets: bagRun.targets,
      results: results,
      routeResults: bagRun.routeResults || [],
      log: bagRun.log || [],
      routeDiagnostics: bagRun.routeDiagnostics || [],
      build: BAG_BUILD,
      selection: bagRun.selection ? bagRun.selection.skipped : null,
      progress: bagProgressText
    };
    return payload;
  }

  function saveBagDiagnostics() {
    var payload = buildBagDiagnostics();
    if (!payload) { alert('Bag取得はまだ実行されていません。'); return; }
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cortex-bag-diagnostics_' + currentLocalDate() + '.json';
      a.click();
    } catch (e) { alert('Bag診断JSONの保存に失敗しました。'); }
  }

  function startBagPhase() {
    show();
    setPanelCollapsed(false);
    if (bagActive()) return;
    if (sessionBusy || (tour && tour.status === 'running')) {
      alert('通常取得の完了後に「Bag取得」を押してください。');
      return;
    }
    var detailsList = Object.keys(store.detailsByRouteId || {}).map(function (id) {
      return store.detailsByRouteId[id];
    });
    if (!detailsList.length) {
      alert('先に「取得開始」で通常取得を完了してください。');
      return;
    }
    var selection = Core.selectBagTargets(detailsList, store.trDetailsByTrId);
    var routes = Core.groupBagTargetsByRoute(selection.targets);
    var currentPage = !anyRouteCardShown();
    if (currentPage && selection.targets.length) {
      // Not on the Route list: only the Route whose routeId is in the URL, no navigation.
      var only = routeFromHref(routes);
      if (!only) {
        alert('表示中のRouteを特定できません。Route一覧で「Bag取得」を押してください。');
        return;
      }
      routes = [only];
    }
    bagSnapshot = Core.snapshotNormalCapture(store);
    bagRun = Core.createBagRun(selection.targets);
    bagRun.selection = selection;
    var runId = bagRun.id;
    if (!selection.targets.length) {
      finishBagPhase('');
      return;
    }
    var ctx = {
      currentPage: currentPage,
      listHref: hrefNow(),
      routeHref: hrefNow(),
      baseDialogs: visibleDialogs()
    };
    setBagStatus('Bag取得中… (' + BAG_BUILD + ')');
    bagEngine = Core.runBagEngine({
      run: bagRun,
      routes: routes,
      getTrMap: function () { return store.trDetailsByTrId; },
      driver: createBagDriver(ctx, runId),
      routeBudgetMs: BAG_ROUTE_BUDGET_MS,
      log: bagLog,
      onProgress: function (p) {
        if (!bagIsCurrent(runId)) return;
        var tail = (bagRun.log || []).slice(-3);
        setBagStatus(Core.formatBagProgress(p) + (tail.length ? '\n' + tail.join('\n') : '') + '\n(' + BAG_BUILD + ')');
      },
      done: function (aborted) {
        if (bagRun && bagRun.id === runId) finishBagPhase(aborted);
      }
    });
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
    bag: startBagPhase,
    bagDiagnostics: buildBagDiagnostics,
    _store: store
  };
})(typeof window !== 'undefined' ? window : global);
