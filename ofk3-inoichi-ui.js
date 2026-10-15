/**
 * OFK3 INOICHI UI (Prototype 0).
 * HARVEST が回収した素材 (harvest:handoff + OFK3Cortex13 getter) を INOICHI で検証・正規化する dry-run 表示。
 *
 * - dry-run のみ。OFK3 (サーバー store / 既存UI state / ブラウザ保存領域) へは一切書き込まない。
 * - 変換は手動ボタンのみ。harvest:handoff 受信時は受領記録の更新だけで変換は起動しない。
 * - setInterval / MutationObserver / 外部通信は使わない。テンプレートリテラル不使用。
 *
 * Step 3: 「品質検知 (dry-run)」。ボタン押下時のみ、HARVEST確認済みの timeWindow を
 *   アダプタ -> 検知エンジン(time-window-data-freshness-v1 のみ)で評価して画面に表示する。
 *   ルール定義は enabled:false のまま。結果は画面内メモリのみ (保存・送信・通知なし)。
 *   配送遅延・配送完了は判定しない。
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
  var lastQuality = null;
  var qualityAlerts = [];
  var QualityDryRun = (typeof window !== 'undefined') ? window.InoichiQualityDryRun : null;
  var QUALITY_THRESHOLD_MINUTES = 30;

  var ISSUE_LABEL = {
    'now-missing': '評価時刻(now)が未指定', 'now-invalid': '評価時刻(now)が不正', 'threshold-invalid': '鮮度閾値が不正',
    'target-date-invalid': '評価対象日が不正', 'envelope-invalid': 'Envelopeが不正', 'unsupported-data-type': 'timeWindow以外のデータ',
    'unsupported-envelope-schema': 'Envelopeのschemaが非対応', 'handoff-schema-missing': 'handoffのschemaVersionがない',
    'unsupported-schema-version': 'handoffのschemaVersionが非対応', 'handoff-not-confirmed': 'HARVEST確認済みのhandoffがない',
    'handoff-source-mismatch': 'handoffのsourceがtimeWindowと不一致', 'envelope-rejected': 'Envelopeが却下された',
    'envelope-partial': '一部の行が欠損・不正 (有効行は利用可)', 'duplicate-keys': 'route/trackingIdの重複',
    'no-valid-rows': '有効な行が0件', 'payload-missing': 'payloadがない', 'payload-empty': 'payloadが空',
    'harvest-partial': 'HARVESTが部分取得と判定', 'harvest-stale': 'HARVESTが古いデータと判定',
    'harvest-error': 'HARVESTがエラー状態', 'harvest-not-ready': 'HARVESTが未確認/取得待ち',
    'harvest-status-unknown': 'HARVEST状態が不明', 'harvest-status-unrecognized': 'HARVEST状態が未知の値',
    'local-date-unknown': '日付(localDate)が不明', 'local-date-invalid': '日付(localDate)の形式が不正',
    'local-date-mismatch': '評価対象日と不一致', 'captured-at-unknown': '取得時刻(capturedAt)が不明で鮮度を判定不可',
    'captured-at-invalid': '取得時刻(capturedAt)が不正', 'captured-at-in-future': '取得時刻が未来(時刻異常)',
    'refetch-recommended': '取得から閾値を超過 (再取得推奨。配送遅延の判定ではありません)'
  };

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

  // getter / hub の読み取りのみ (取得・再送信なし)。P0 dry-run と品質検知で共用。
  function collectInput(api) {
    var hub = getHub();
    if (!hub) {
      try { console.warn('OFK3Inoichi: HARVEST hub not available'); } catch (e1) {}
    }
    return Core.readInput(api, { hub: hub, handoffRecords: handoffRecords });
  }

  function runDryRun() {
    lastError = null;
    try {
      var api = window.OFK3Cortex13 || null;
      if (!api) {
        try { console.warn('OFK3Inoichi: OFK3Cortex13 not found'); } catch (e0) {}
      }
      lastInput = collectInput(api);
      lastResult = Core.dryRun(lastInput);
    } catch (e) {
      lastResult = null;
      lastError = String(e && e.message ? e.message : e);
      try { console.error('OFK3Inoichi.dryRun error:', e); } catch (e2) {}
    }
    return lastResult;
  }

  // 手動ボタン専用。HARVEST確認済みの timeWindow のみを対象に、現在時刻を明示的に渡して評価する。
  function runQuality() {
    var q = window.InoichiQualityDryRun || QualityDryRun;
    if (!q) {
      lastQuality = { error: 'dependency-missing', adapterOutput: null, alerts: [] };
      return lastQuality;
    }
    try {
      var api = window.OFK3Cortex13 || null;
      var input = collectInput(api);
      var env = Core.dryRun(input, ['timeWindow']).envelopes[0];
      lastQuality = q.evaluateTimeWindowQuality(env, {
        now: new Date().toISOString(),
        freshnessThresholdMinutes: QUALITY_THRESHOLD_MINUTES,
        existingAlerts: qualityAlerts
      });
      if (!lastQuality.error) qualityAlerts = lastQuality.alerts;
    } catch (e) {
      lastQuality = { error: String(e && e.message ? e.message : e), adapterOutput: null, alerts: [] };
    }
    return lastQuality;
  }

  function issueRowHtml(i) {
    var color = i.level === 'blocking' ? '#b91c1c' : '#c2410c';
    var label = ISSUE_LABEL[i.code] || '';
    var h = '<li style="margin:4px 0;"><span style="color:' + color + ';font-weight:700;">[' + esc(i.level === 'blocking' ? '評価不能の要因' : '警告') + ']</span> '
      + '<code>' + esc(i.code) + '</code>' + (label ? ' ' + esc(label) : '');
    if (i.detail !== undefined) h += jsonBlock(i.detail);
    return h + '</li>';
  }

  function qualityHtml() {
    var h = '<div style="border:1px solid #c4b5fd;border-radius:8px;padding:12px;margin-top:16px;">';
    h += '<div style="font-size:14px;margin-bottom:6px;"><b>品質検知 (dry-run)</b> <span style="font-size:11px;color:#6b7280;">time-window-data-freshness-v1 のみ</span></div>';
    h += '<div style="font-size:12px;color:#6b7280;line-height:1.6;">取得したデータの信頼性だけを評価します。配送遅延・配送完了は判定しません (配送状態は取得していません)。'
      + '鮮度閾値は暫定' + QUALITY_THRESHOLD_MINUTES + '分。ルール定義は無効のままで、押下時のこの画面内評価のみです。通知・保存・送信はしません。</div>';
    h += '<button type="button" data-ino-act="quality" style="margin-top:10px;padding:8px 16px;background:#4f46e5;color:#fff;border:none;'
      + 'border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;">品質検知 (dry-run)</button>';
    if (!lastQuality) {
      return h + '<div style="margin-top:8px;font-size:12px;color:#6b7280;">未実行 (ボタンを押したときだけ評価します)</div></div>';
    }
    if (lastQuality.error) {
      return h + '<div style="margin-top:10px;font-size:12px;color:#b91c1c;">評価できませんでした: ' + esc(lastQuality.error)
        + (lastQuality.error === 'dependency-missing' ? ' (inoichi-time-window-adapter.js / inoichi-detection-*.js / inoichi-quality-dryrun.js の読込を確認してください)' : '') + '</div></div>';
    }
    var a = lastQuality.adapterOutput;
    var badge = a.evaluable
      ? '<span style="color:#15803d;font-weight:700;">evaluable: true (評価可能)</span>'
      : '<span style="color:#b91c1c;font-weight:700;">evaluable: false (評価不能)</span>';
    h += '<div style="margin:12px 0 6px;font-size:13px;">' + badge + '</div>';
    h += '<table style="font-size:12px;border-collapse:collapse;">';
    h += kv('評価時刻 (now)', a.now) + kv('capturedAt', a.capturedAt) + kv('鮮度', a.freshness.state
        + (a.freshness.ageMinutes != null ? ' (' + Math.round(a.freshness.ageMinutes * 10) / 10 + '分経過 / 閾値' + a.freshness.thresholdMinutes + '分)' : ''))
      + kv('localDate', a.localDate) + kv('日付判定', a.dateCheck) + kv('HARVEST状態', a.harvestStatus)
      + kv('Envelope状態', a.envelopeStatus) + kv('行数 (有効)', a.rowCount)
      + kv('評価不能の要因 / 警告', a.blockingCount + ' / ' + a.warningCount)
      + kv('配送状態', a.unknowns.deliveryStatus + ' (配送遅延・完了は判定しません)');
    h += '</table>';
    h += '<div style="margin:10px 0 4px;font-size:12px;"><b>issues[]</b> (' + a.issueCount + ')</div>';
    if (a.issues.length) {
      h += '<ul style="font-size:12px;margin:0;padding-left:18px;">';
      a.issues.forEach(function (i) { h += issueRowHtml(i); });
      h += '</ul>';
    } else {
      h += '<div style="font-size:12px;color:#15803d;">品質上の問題は検出されませんでした</div>';
    }
    var d = lastQuality.detection && lastQuality.detection.diagnostics ? lastQuality.detection.diagnostics : {};
    h += '<div style="margin:10px 0 4px;font-size:12px;"><b>アラート (画面内のみ)</b> 新規 ' + (d.created || 0) + ' / 更新 ' + (d.updated || 0) + ' / 解決 ' + (d.resolved || 0) + '</div>';
    if (lastQuality.alerts.length) {
      lastQuality.alerts.forEach(function (al) {
        h += '<div style="font-size:12px;border:1px solid #e5e7eb;border-radius:6px;padding:8px;margin-top:4px;">'
          + '<b>' + esc(al.title) + '</b> [' + esc(al.severity) + ' / ' + esc(al.status) + ']<br>' + esc(al.summary) + '</div>';
      });
    } else {
      h += '<div style="font-size:12px;color:#6b7280;">アラートなし</div>';
    }
    h += '<div style="margin-top:8px;font-size:12px;"><b>アダプタ出力 (診断)</b></div>' + jsonBlock(a);
    return h + '</div>';
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
    h += qualityHtml();
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
    else if (act === 'quality') runQuality();
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
    runQuality: runQuality,
    getLastQuality: function () { return lastQuality; },
    getLastResult: function () { return lastResult; },
    getHandoffRecords: function () { return handoffRecords; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
