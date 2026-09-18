/**
 * OFK3 Cortex capture runner — page MAIN world only.
 * Wraps SPA fetch/XHR response JSON. Does not call Cortex APIs.
 * Does not read Cookie / Authorization / HMAC / session / timestamp.
 */
(function (global) {
  'use strict';

  var Core = global.Cortex13PriorityCore;
  if (!Core) return;
  if (global.__OFK3_CORTEX_CAPTURE__) {
    if (typeof global.__OFK3_CORTEX_CAPTURE__.show === 'function') {
      global.__OFK3_CORTEX_CAPTURE__.show();
    }
    return;
  }

  var PANEL_ID = 'ofk3-cortex-capture-panel';
  var store = Core.createCaptureStore();
  var tour = Core.createTourState();
  var localDate = '';
  var hooked = false;
  var stepTimer = 0;
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
    if (hooked) return;
    hooked = true;
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
              note(u, res.status, body);
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
        note(u, this.status, body);
      });
      return xhrSend.apply(this, arguments);
    };
  }

  function note(url, status, body) {
    Core.applyCapturedCortexResponse(store, { url: url, status: status, body: body });
    paint();
  }

  function progress() {
    return Core.tourProgress(store, tour);
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function paint() {
    var p = progress();
    var box = document.getElementById(PANEL_ID);
    if (!box) return;
    setText('ofk3-cortex-sum', p.summariesReady ? '捕捉済' : '未捕捉');
    setText('ofk3-cortex-eleven', String(p.selectedCount));
    setText('ofk3-cortex-det', p.detailsCount + ' / ' + p.detailsTotal);
    setText('ofk3-cortex-current', p.currentRouteCode || (p.status === 'done' ? '完了' : (p.status === 'stopped' ? '停止' : '-')));
    setText('ofk3-cortex-ok', String(p.successCount));
    setText('ofk3-cortex-fail', String(p.failureCount));
  }

  function ensurePanel() {
    if (!document.documentElement) return;
    var box = document.getElementById(PANEL_ID);
    if (box) {
      box.style.display = 'block';
      paint();
      return box;
    }
    box = document.createElement('div');
    box.id = PANEL_ID;
    box.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;padding:12px;font:12px/1.5 sans-serif;border-radius:8px;max-width:280px;');
    box.innerHTML = '<b>OFK3 Cortex取得</b>' +
      '<div>summaries: <span id="ofk3-cortex-sum">未捕捉</span></div>' +
      '<div>11時Route: <span id="ofk3-cortex-eleven">0</span></div>' +
      '<div>details: <span id="ofk3-cortex-det">0 / 0</span></div>' +
      '<div>現在: <span id="ofk3-cortex-current">-</span></div>' +
      '<div>成功: <span id="ofk3-cortex-ok">0</span></div>' +
      '<div>失敗: <span id="ofk3-cortex-fail">0</span></div>';
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
    row.appendChild(mk('停止', function () { stopTour(); }));
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
        var p = progress();
        alert('Cortex捕捉完了\n11時Route: ' + p.selectedCount + '\ndetails: ' + p.detailsCount + ' / ' + p.detailsTotal + '\nfailures: ' + (bundle.failures || []).length + '\n\nJSONを保存しました。');
      }
      return true;
    } catch (err) {
      if (!opts.quiet) alert('JSON保存に失敗しました。');
      return false;
    }
  }

  function collectCandidates(root) {
    var out = [];
    if (!root || !root.querySelectorAll) return out;
    var panel = root.querySelector('#' + PANEL_ID);
    var els = root.querySelectorAll('a, button, tr, [role="row"], [role="link"], [role="button"], [data-route-id], [data-routeid], td, li, span');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (panel && panel.contains(el)) continue;
      out.push({
        el: el,
        tag: (el.tagName || '').toLowerCase(),
        role: (el.getAttribute && el.getAttribute('role')) || '',
        text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        href: (el.getAttribute && el.getAttribute('href')) || '',
        dataRouteId: (el.getAttribute && (el.getAttribute('data-route-id') || el.getAttribute('data-routeid'))) || '',
        dataRouteCode: (el.getAttribute && el.getAttribute('data-route-code')) || ''
      });
    }
    return out;
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

  function findRouteElement(route) {
    var mapped = collectCandidates(document);
    var idx = Core.pickRouteClickCandidate(mapped, route);
    if (idx >= 0) return mapped[idx].el;
    var scroller = largestScroller();
    if (!scroller) return null;
    var y = 0;
    var guard = 0;
    var step = Math.max(120, Math.floor((scroller.clientHeight || 300) * 0.7));
    while (y <= scroller.scrollHeight && guard < 40) {
      scroller.scrollTop = y;
      mapped = collectCandidates(document);
      idx = Core.pickRouteClickCandidate(mapped, route);
      if (idx >= 0) return mapped[idx].el;
      y += step;
      guard += 1;
    }
    return null;
  }

  function findBackButton() {
    var panel = document.getElementById(PANEL_ID);
    var els = document.querySelectorAll('button, a, [role="button"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (panel && panel.contains(el)) continue;
      var label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).replace(/\s+/g, ' ');
      if (/戻る|back/i.test(label) && label.length < 40) return el;
    }
    return null;
  }

  function clickRoute(route, done) {
    var el = findRouteElement(route);
    if (el) {
      try { el.scrollIntoView({ block: 'center' }); } catch (e1) {}
      try { el.click(); } catch (e2) {}
      done(true);
      return;
    }
    var back = findBackButton();
    if (back) {
      try { back.click(); } catch (e3) {}
      waitTimer = setTimeout(function () {
        var el2 = findRouteElement(route);
        if (el2) {
          try { el2.scrollIntoView({ block: 'center' }); } catch (e4) {}
          try { el2.click(); } catch (e5) {}
          done(true);
        } else done(false);
      }, 600);
      return;
    }
    done(false);
  }

  function clearTimers() {
    if (stepTimer) { clearTimeout(stepTimer); stepTimer = 0; }
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = 0; }
    if (summariesWaitTimer) { clearInterval(summariesWaitTimer); summariesWaitTimer = 0; }
  }

  function stopTour() {
    tour.status = 'stopped';
    clearTimers();
    paint();
  }

  function finishTour() {
    if (tour.status !== 'stopped') tour.status = 'done';
    tour.currentRouteCode = '';
    tour.currentRouteId = '';
    clearTimers();
    paint();
    saveBundle({ quiet: false });
  }

  function waitForDetails(route) {
    var started = Date.now();
    function poll() {
      if (tour.status !== 'running') return;
      if (route.routeId && store.detailsByRouteId[route.routeId]) {
        tour.index += 1;
        stepTimer = setTimeout(step, 400);
        return;
      }
      if (Date.now() - started >= tour.timeoutMs) {
        Core.applyTourTimeout(store, tour);
        paint();
        stepTimer = setTimeout(step, 400);
        return;
      }
      waitTimer = setTimeout(poll, 200);
    }
    poll();
  }

  function step() {
    if (tour.status !== 'running') return;
    var route = Core.nextTourRoute(store, tour);
    paint();
    if (!route) {
      finishTour();
      return;
    }
    clickRoute(route, function (ok) {
      if (tour.status !== 'running') return;
      if (!ok) {
        Core.recordTourFailure(store, route, {
          error: Core.ERROR.DOM_NOT_FOUND,
          message: '一覧に Route 行が見つかりませんでした'
        });
        tour.index += 1;
        paint();
        stepTimer = setTimeout(step, 400);
        return;
      }
      waitForDetails(route);
    });
  }

  function beginTour() {
    localDate = currentLocalDate();
    Core.armTour(store, tour);
    paint();
    if (tour.status !== 'running') {
      if (!store.summaries) {
        Core.recordTourFailure(store, {}, {
          error: Core.ERROR.MISSING_SUMMARIES,
          message: 'route-summaries が捕捉できません。Route一覧を開いた状態で再実行してください'
        });
      }
      finishTour();
      return;
    }
    step();
  }

  function start() {
    show();
    if (tour.status === 'running') return;
    clearTimers();
    if (store.summaries) {
      beginTour();
      return;
    }
    var waited = 0;
    summariesWaitTimer = setInterval(function () {
      waited += 250;
      paint();
      if (store.summaries) {
        clearInterval(summariesWaitTimer);
        summariesWaitTimer = 0;
        beginTour();
      } else if (waited >= 10000) {
        clearInterval(summariesWaitTimer);
        summariesWaitTimer = 0;
        beginTour();
      }
    }, 250);
  }

  function onReady(fn) {
    if (document.body || document.documentElement) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  installHooks();
  onReady(function () {
    localDate = currentLocalDate();
    ensurePanel();
  });

  global.__OFK3_CORTEX_CAPTURE__ = {
    show: show,
    start: start,
    stop: stopTour,
    save: saveBundle
  };
})(typeof window !== 'undefined' ? window : global);
