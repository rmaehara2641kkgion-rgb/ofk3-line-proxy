/**
 * OFK3 INOICHI UI (Prototype 0).
 * HARVEST が回収した素材 (harvest:handoff + OFK3Cortex13 getter) を INOICHI で検証・正規化する dry-run 表示。
 *
 * - dry-run のみ。OFK3 (サーバー store / 既存UI state / ブラウザ保存領域) へは一切書き込まない。
 * - 変換は手動ボタンのみ。harvest:handoff 受信時は受領記録の更新だけで変換は起動しない。
 * - setInterval / MutationObserver / 外部通信は使わない。テンプレートリテラル不使用。
 */
(function () {
  'use strict';

  var BTN_WRAP_ID = 'ofk3-inoichi-btn-wrap';
  var OVERLAY_ID = 'ofk3-inoichi-overlay';
  var CONTENT_ID = 'ofk3-inoichi-content';
  var HARVEST_WRAP_ID = 'ofk3-harvest-btn-wrap';
  var TW_WRAP_ID = 'ofk3-tw-board-btn-wrap';
  var ANCHOR_ID = 'ofk3-cortex13-dash-card';
  var MAX_DISPLAY_ROWS = 50;

  var Core = (typeof window !== 'undefined') ? window.InoichiCore : null;
  if (!Core) {
    try { console.warn('OFK3Inoichi: inoichi-core.js not loaded'); } catch (e) {}
    return;
  }

  var handoffRecords = {};
  var lastResult = null;
  var lastInput = null;
  var lastError = null;

  var STATUS_COLOR = { ok: '#15803d', partial: '#c2410c', rejected: '#b91c1c' };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function getHub() {
    try {
      var h = window.OFK3Harvest;
      return h && typeof h.getHub === 'function' ? h.getHub() : null;
    } catch (e) {
      return null;
    }
  }

  function runDryRun() {
    lastError = null;
    try {
      var api = window.OFK3Cortex13 || null;
      if (!api) {
        try { console.warn('OFK3Inoichi: OFK3Cortex13 not found'); } catch (e0) {}
      }
      var hub = getHub();
      if (!hub) {
        try { console.warn('OFK3Inoichi: HARVEST hub not available'); } catch (e1) {}
      }
      lastInput = Core.readInput(api, { hub: hub, handoffRecords: handoffRecords });
      lastResult = Core.dryRun(lastInput);
    } catch (e) {
      lastResult = null;
      lastError = String(e && e.message ? e.message : e);
      try { console.error('OFK3Inoichi.dryRun error:', e); } catch (e2) {}
    }
    return lastResult;
  }

  function kv(label, value) {
    return '<tr><td style="padding:3px 10px 3px 0;color:#6b7280;white-space:nowrap;">' + esc(label)
      + '</td><td style="padding:3px 0;">' + esc(value) + '</td></tr>';
  }

  function jsonBlock(obj) {
    var text;
    try { text = JSON.stringify(obj, null, 2); } catch (e) { text = '(表示できません)'; }
    return '<pre style="margin:6px 0 0;padding:10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;'
      + 'font-size:11px;line-height:1.5;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-all;">'
      + esc(text) + '</pre>';
  }

  function displayEnvelope(env) {
    var copy = {};
    Object.keys(env).forEach(function (k) { copy[k] = env[k]; });
    var rows = env.payload && Array.isArray(env.payload.rows) ? env.payload.rows : [];
    if (rows.length > MAX_DISPLAY_ROWS) {
      copy.payload = { rows: rows.slice(0, MAX_DISPLAY_ROWS), displayNote: '表示は先頭' + MAX_DISPLAY_ROWS + '行のみ (全' + rows.length + '行)' };
    }
    return copy;
  }

  function envelopeHtml(env) {
    var d = env.diagnostics || {};
    var color = STATUS_COLOR[env.status] || '#374151';
    var h = '<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:14px;">';
    h += '<div style="font-size:14px;margin-bottom:6px;"><b>dataType: ' + esc(env.dataType) + '</b> '
      + '<span style="color:' + color + ';font-weight:700;">[' + esc(env.status) + ']</span></div>';
    h += '<table style="font-size:12px;border-collapse:collapse;">';
    h += kv('入力件数', d.inputCount) + kv('正常 (normalized)', d.normalizedCount)
      + kv('partial', d.partialCount) + kv('rejected', d.rejectedCount)
      + kv('localDate', env.localDate) + kv('capturedAt', env.capturedAt) + kv('collectedAt', env.collectedAt)
      + kv('harvestStatus (原情報)', env.sourceMetadata ? env.sourceMetadata.harvestStatus : null);
    h += '</table>';
    h += '<div style="font-size:12px;margin-top:8px;"><b>INOICHI diagnostics</b></div>' + jsonBlock(d);
    h += '<div style="font-size:12px;margin-top:8px;"><b>sourceDiagnostics (getter由来・無改変)</b></div>' + jsonBlock(env.sourceDiagnostics);
    h += '<div style="font-size:12px;margin-top:8px;"><b>sourceMetadata</b></div>' + jsonBlock(env.sourceMetadata);
    h += '<div style="font-size:12px;margin-top:8px;"><b>最終Payload (Envelope)</b></div>' + jsonBlock(displayEnvelope(env));
    h += '</div>';
    return h;
  }

  function buildHtml() {
    var h = '';
    h += '<div style="font-size:13px;line-height:1.7;background:#f3f4f6;border-radius:8px;padding:10px 12px;margin-bottom:12px;">';
    h += '<b>INOICHI (dry-run):</b> HARVEST が回収した素材を検証・正規化し、OFK3 へ渡せる Envelope の形を表示します。<br>';
    h += '<span style="color:#6b7280;">OFK3 へは書き込みません。取得・再送信も行いません。</span></div>';

    var got = [];
    Object.keys(handoffRecords).forEach(function (k) { got.push(k); });
    h += '<div style="font-size:12px;margin-bottom:10px;">harvest:handoff 受領: '
      + (got.length ? esc(got.join(', ')) : '未受領 (HARVEST画面の「handoff準備」で発火。未受領でも hub の記録と getter から変換できます)') + '</div>';

    h += '<button type="button" data-ino-act="run" style="padding:8px 16px;background:#7c3aed;color:#fff;border:none;'
      + 'border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;">INOICHI 変換 (dry-run)</button>';

    if (!window.OFK3Cortex13) {
      h += '<div style="margin-top:10px;font-size:12px;color:#b45309;">OFK3Cortex13 が見つかりません。Cortex の読込後に再実行してください。</div>';
    }
    if (!getHub()) {
      h += '<div style="margin-top:6px;font-size:12px;color:#b45309;">HARVEST hub が見つかりません。harvest 系スクリプトの読込後に再実行してください。</div>';
    }
    if (lastError) {
      h += '<div style="margin-top:10px;font-size:12px;color:#b91c1c;">変換中にエラーが発生しました: ' + esc(lastError) + '</div>';
    }

    if (lastResult) {
      var s = lastResult.summary;
      h += '<div style="margin:14px 0 8px;font-size:13px;"><b>結果サマリ</b></div>';
      h += '<table style="font-size:12px;border-collapse:collapse;">';
      h += kv('入力件数 (合計)', s.totals.inputCount) + kv('正常 (normalized)', s.totals.normalizedCount)
        + kv('partial 行', s.totals.partialCount) + kv('rejected 行', s.totals.rejectedCount)
        + kv('Envelope ok / partial / rejected', s.statusCounts.ok + ' / ' + s.statusCounts.partial + ' / ' + s.statusCounts.rejected);
      Object.keys(s.byDataType).forEach(function (t) {
        var b = s.byDataType[t];
        h += kv('dataType ' + t, b.status + ' (入力 ' + b.inputCount + ' / 正常 ' + b.normalizedCount + ' / partial ' + b.partialCount + ' / rejected ' + b.rejectedCount + ')');
      });
      h += kv('OFK3 HANDOFF READY (dry-run)', s.ofk3Handoff.ready ? ('READY: ' + s.ofk3Handoff.readyDataTypes.join(', ') + ' (書き込みなし)') : 'NOT READY');
      h += '</table>';
      h += '<div style="margin:12px 0 6px;font-size:12px;"><b>ステージ</b></div>' + jsonBlock(lastResult.stages);
      h += '<div style="margin-top:14px;">';
      lastResult.envelopes.forEach(function (env) { h += envelopeHtml(env); });
      h += '</div>';
    }
    return h;
  }

  function render() {
    try {
      var content = document.getElementById(CONTENT_ID);
      if (content) content.innerHTML = buildHtml();
    } catch (e) {
      try { console.error('OFK3Inoichi.render error:', e); } catch (e2) {}
    }
  }

  function isOpen() {
    var el = document.getElementById(OVERLAY_ID);
    return !!(el && el.style.display !== 'none');
  }

  function hideOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
  }

  function onContentClick(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var act = t.getAttribute('data-ino-act');
    if (!act || t.disabled) return;
    if (act === 'run') runDryRun();
    render();
  }

  function ensureOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('section');
    el.id = OVERLAY_ID;
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:99995;background:rgba(0,0,0,0.5);';
    var inner = document.createElement('div');
    inner.style.cssText = 'position:absolute;top:20px;left:50%;transform:translateX(-50%);width:min(980px,calc(100vw - 24px));max-height:calc(100vh - 40px);overflow:auto;background:#fff;color:#111;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,0.35);';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;z-index:1;flex-wrap:wrap;gap:8px;';
    bar.innerHTML = ''
      + '<b style="font-size:14px;">INOICHI 変換 (dry-run)</b>'
      + '<button type="button" data-ino-act="close" style="padding:6px 14px;background:#e5e7eb;color:#111;border:none;border-radius:6px;font-size:12px;cursor:pointer;">閉じる</button>';
    var content = document.createElement('div');
    content.id = CONTENT_ID;
    content.style.cssText = 'padding:16px;';
    inner.appendChild(bar);
    inner.appendChild(content);
    el.appendChild(inner);
    el.addEventListener('click', function (ev) {
      if (ev.target === el) hideOverlay();
    });
    bar.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-ino-act');
      if (a === 'close') hideOverlay();
    });
    content.addEventListener('click', onContentClick);
    document.body.appendChild(el);
    return el;
  }

  function openOverlay() {
    try {
      var el = ensureOverlay();
      render();
      el.style.display = 'block';
    } catch (e) {
      try { console.error('OFK3Inoichi.open error:', e); } catch (e2) {}
      alert('INOICHI画面の表示中にエラーが発生しました。');
    }
  }

  function insertButton() {
    if (document.getElementById(BTN_WRAP_ID)) return;
    var html = ''
      + '<div id="' + BTN_WRAP_ID + '" class="card p-4 mb-4" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">'
      + '<div><p class="text-sm font-medium">INOICHI 変換 (dry-run)</p>'
      + '<p class="text-xs text-ink-lighter mt-1">HARVEST の回収素材を共通Envelopeへ正規化して表示します (OFK3へは書き込みません)</p></div>'
      + '<button type="button" data-ino-open="1" style="padding:8px 16px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;">INOICHI 確認</button>'
      + '</div>';
    try {
      var anchor = document.getElementById(HARVEST_WRAP_ID) || document.getElementById(TW_WRAP_ID) || document.getElementById(ANCHOR_ID);
      if (anchor && anchor.insertAdjacentHTML) {
        anchor.insertAdjacentHTML('afterend', html);
      } else {
        var host = document.getElementById('dashboard-content') || document.body;
        host.insertAdjacentHTML('afterbegin', html);
      }
      var wrap = document.getElementById(BTN_WRAP_ID);
      if (wrap) {
        wrap.addEventListener('click', function (ev) {
          var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-ino-open');
          if (a) openOverlay();
        });
      }
    } catch (e) {}
  }

  // harvest:handoff は受領記録の更新のみ。変換は手動ボタン起点。
  function onHandoff(ev) {
    try {
      var d = ev && ev.detail;
      if (d && typeof d === 'object' && typeof d.source === 'string') {
        handoffRecords[d.source] = d;
        if (isOpen()) render();
      }
    } catch (e) {
      try { console.warn('OFK3Inoichi: handoff listener error', e); } catch (e2) {}
    }
  }

  function chainDashboardHook() {
    var tw = window.OFK3TimeWindowBoard;
    if (!tw || typeof tw.onDashboardRender !== 'function' || tw.__inoichiChained) return;
    var orig = tw.onDashboardRender;
    tw.onDashboardRender = function () {
      try { orig.apply(this, arguments); } catch (e) {}
      try { insertButton(); } catch (e2) {}
    };
    tw.__inoichiChained = true;
  }

  function boot() {
    try { chainDashboardHook(); } catch (e) {}
    try { insertButton(); } catch (e) {}
  }

  try {
    if (typeof window.addEventListener === 'function') window.addEventListener(Core.HANDOFF_EVENT, onHandoff);
  } catch (e) {}

  window.OFK3Inoichi = {
    open: openOverlay,
    close: hideOverlay,
    render: render,
    buildHtml: buildHtml,
    insertButton: insertButton,
    runDryRun: runDryRun,
    getLastResult: function () { return lastResult; },
    getHandoffRecords: function () { return handoffRecords; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
