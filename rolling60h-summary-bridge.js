/**
 * Sends the count-only summary to local HARVEST after OFK3 has saved it.
 * A failed send does not change the board, IndexedDB, or the judgment.
 * No token is embedded. HARVEST accepts this page only from its Origin allow-list.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var ENDPOINT = 'http://127.0.0.1:3100/rolling60h-summary';
  var KIND = 'ofk3.rolling60h.friday-summary';

  function localPage(global) {
    var loc = global && global.location;
    var host = loc && loc.hostname ? String(loc.hostname).toLowerCase() : '';
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  function note(global, text) {
    var doc = global && global.document;
    if (!doc || !doc.body) return;
    var el = doc.getElementById('wh60-harvest-bridge');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'wh60-harvest-bridge';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:20;max-width:280px;padding:8px 10px;background:#fff;color:#334155;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;';
      doc.body.appendChild(el);
    }
    el.textContent = text;
  }

  function deliver(summary, fetchImpl) {
    if (!summary || summary.kind !== KIND || summary.schemaVersion !== 1 || summary.ready !== true) {
      return Promise.resolve({ ok: false, reason: 'not-ready' });
    }
    var send = fetchImpl;
    if (typeof send !== 'function') return Promise.resolve({ ok: false, reason: 'unreachable' });
    return Promise.resolve().then(function () {
      return send(ENDPOINT, {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(summary)
      });
    }).then(function (res) {
      return res.json().then(function (body) {
        return { ok: !!(res.ok && body && body.ok), status: res.status, reason: body && body.reason };
      }, function () {
        return { ok: false, status: res.status, reason: 'unreadable' };
      });
    }, function () {
      return { ok: false, reason: 'unreachable' };
    });
  }

  function message(result) {
    if (result && result.ok && result.reason === 'duplicate') return 'HARVESTは同じ人数要約を受信済みです。';
    if (result && result.ok) return 'HARVESTが人数要約を受信しました。';
    if (result && result.reason === 'unreachable') return 'HARVESTへ人数要約を送れませんでした。集計結果はこのブラウザに残っています。';
    if (result && result.reason === 'stale-summary') return 'HARVESTはより新しい人数要約を保持しているため、今回は送っていません。';
    return 'HARVESTは人数要約を受け取れませんでした。集計結果はこのブラウザに残っています。';
  }

  function install(global) {
    if (!global || global.__WH60_HARVEST_BRIDGE) return;
    global.__WH60_HARVEST_BRIDGE = true;
    // Renderなど公開ページは、初期状態では手元のHARVESTへ送らない。
    if (!localPage(global)) return;
    function send(summary) {
      var fetchImpl = global.fetch ? global.fetch.bind(global) : null;
      return deliver(summary, fetchImpl).then(function (result) {
        note(global, message(result));
        return result;
      });
    }
    global.addEventListener('ofk3:rolling60h-summary', function (event) {
      send(event && event.detail);
    });
    function resendSaved() {
      var ui = global.Rolling60hBoardUI;
      if (!ui || typeof ui.getFridaySummary !== 'function') return;
      ui.getFridaySummary().then(function (summary) {
        if (summary && summary.ready === true) send(summary);
      }, function () {});
    }
    if (global.document && global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', resendSaved);
    } else {
      resendSaved();
    }
  }

  return { ENDPOINT: ENDPOINT, localPage: localPage, deliver: deliver, message: message, install: install };
});
