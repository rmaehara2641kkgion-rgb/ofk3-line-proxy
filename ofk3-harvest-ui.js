/**
 * OFK3 HARVEST UI (Prototype 0).
 * Collector Hub の状態表示オーバーレイ。ダッシュボードの Cortex カード (#ofk3-cortex13-dash-card) 隣にボタンを挿入する。
 *
 * - 「再確認」ボタンは Cortex 取得を開始しない。Cortex 拡張で既に回収・送信された素材を
 *   OFK3Cortex13 経由で再確認・検証・正規化するだけ。
 * - 更新は手動ボタンのみ。setInterval / MutationObserver は使わない。
 * - テンプレートリテラル不使用。
 */
(function () {
  'use strict';

  var BTN_WRAP_ID = 'ofk3-harvest-btn-wrap';
  var OVERLAY_ID = 'ofk3-harvest-overlay';
  var CONTENT_ID = 'ofk3-harvest-content';
  var ANCHOR_ID = 'ofk3-cortex13-dash-card';
  var TW_WRAP_ID = 'ofk3-tw-board-btn-wrap';

  var Core = (typeof window !== 'undefined') ? window.HarvestCore : null;
  var Cols = (typeof window !== 'undefined') ? window.HarvestCollectorsCortex : null;
  if (!Core || !Cols) {
    try { console.warn('OFK3Harvest: harvest-core.js / harvest-collectors-cortex.js not loaded'); } catch (e) {}
    return;
  }

  var FleetCols = (typeof window !== 'undefined') ? window.HarvestCollectorsFleet : null;

  var hub = Core.getDefaultHub();
  if (!hub.listIds().length) {
    try { Cols.registerCortexCollectors(hub); } catch (e) {
      try { console.error('OFK3Harvest: collector registration failed', e); } catch (e2) {}
    }
  }
  // 台数照合 (fleetCapacity)。harvest-collectors-fleet.js が未読込でも既存Collectorの動作は変えない。
  if (FleetCols && hub.listIds().indexOf(FleetCols.COLLECTOR_ID) < 0) {
    try { FleetCols.registerFleetCollector(hub); } catch (e) {
      try { console.error('OFK3Harvest: fleet collector registration failed', e); } catch (e2) {}
    }
  }

  var STATUS_COLOR = {
    'idle': '#6b7280',
    'awaiting-data': '#b45309',
    'checking': '#2563eb',
    'ok': '#15803d',
    'partial': '#c2410c',
    'error': '#b91c1c',
    'stale': '#a16207'
  };

  var OVERALL_LABEL = {
    COMPLETE: 'COMPLETE (全Collector正常)',
    PARTIAL: 'PARTIAL (一部のCollectorに未回収/異常あり)',
    FAILED: 'FAILED (正常なCollectorなし)'
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    try {
      return new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).format(new Date(iso));
    } catch (e) {
      return String(iso);
    }
  }

  function errorCell(state) {
    var errs = state.errors || [];
    if (!errs.length) return '-';
    var first = errs[0];
    var text = esc(first.message || first.code) + (first.count != null ? ' (' + esc(first.count) + '件)' : '');
    if (errs.length > 1) text += ' <span style="color:#6b7280;">他' + (errs.length - 1) + '件</span>';
    return text;
  }

  function detailNotes(state) {
    var d = state.details || {};
    var notes = [];
    if (state.summary) notes.push(esc(state.summary));
    if (d.stale) notes.push('データ日付 ' + esc(d.localDate) + ' は本日分ではありません。');
    if (state.id === 'bag' && d.scopePackageCount) {
      if (d.legacyUnknown || d.legacyCaptured) {
        notes.push('旧データ形式の行があります (bagStatusなし): 「未試行」と「取得成功だがBagなし(null)」は区別できません。');
      }
      if (d.bagStatusCounts) {
        var parts = [];
        Object.keys(d.bagStatusCounts).forEach(function (k) { parts.push(esc(k) + ': ' + esc(d.bagStatusCounts[k])); });
        if (parts.length) notes.push('Bag状態内訳: ' + parts.join(' / '));
      }
      notes.push('完了済みStopは Bag なし(captured_null)が正常で、異常とは扱いません。');
    }
    if (state.id === 'fleetCapacity') {
      var def = hub.getCollector(state.id);
      if (def && def.trigger && def.trigger.instruction) notes.push('操作: ' + esc(def.trigger.instruction));
      notes.push('cortexCount / inputCount は取得元の値をそのまま保持します。不足判定や重要度の付与は行いません。');
    }
    return notes.join('<br>');
  }

  function buildHtml() {
    var all = hub.getAll();
    var runningAll = hub.isRunningAll();
    var overall = hub.getOverall();
    var h = '';
    h += '<div style="font-size:13px;line-height:1.7;background:#f3f4f6;border-radius:8px;padding:10px 12px;margin-bottom:12px;">';
    h += '<b>人間の操作手順:</b> Cortexで拡張パネルの「取得開始」→「Bag取得」→「OFK3へ送信」を実行後、ここで「再確認」を押してください。<br>';
    h += '<span style="color:#6b7280;">この画面はCortexの取得を開始しません。すでにOFK3へ送信された素材を確認・検証・正規化するだけです。</span>';
    h += '</div>';
    h += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">';
    h += '<button type="button" data-hv-act="run-all"' + (runningAll ? ' disabled' : '')
      + ' style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;">'
      + 'HARVEST ALL (全Collector再確認)</button>';
    if (overall) {
      h += '<span style="font-size:13px;"><b>全体結果:</b> ' + esc(OVERALL_LABEL[overall] || overall) + '</span>';
    } else {
      h += '<span style="font-size:13px;color:#6b7280;">全体結果: 未確認</span>';
    }
    h += '</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    h += '<thead><tr style="background:#f9fafb;text-align:left;">';
    ['Collector', '状態', '最終確認', '成功', '失敗', 'エラー', 'Action'].forEach(function (t) {
      h += '<th style="padding:8px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">' + t + '</th>';
    });
    h += '</tr></thead><tbody>';
    all.forEach(function (s) {
      var running = hub.isRunning(s.id);
      var canHandoff = s.status === 'ok' || s.status === 'partial' || s.status === 'stale';
      var color = STATUS_COLOR[s.status] || '#374151';
      var def = hub.getCollector(s.id) || {};
      h += '<tr>';
      h += '<td style="padding:8px;border-bottom:1px solid #e5e7eb;"><b>' + esc(s.label) + '</b>'
        + (def.dependsOn && def.dependsOn.length ? '<br><span style="color:#6b7280;font-size:11px;">依存: ' + esc(def.dependsOn.join(', ')) + '</span>' : '')
        + '</td>';
      h += '<td style="padding:8px;border-bottom:1px solid #e5e7eb;white-space:nowrap;color:' + color + ';font-weight:700;">'
        + esc(Core.statusLabel(s.status)) + '</td>';
      h += '<td style="padding:8px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">' + esc(fmtTime(s.checkedAt)) + '</td>';
      h += '<td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">' + esc(s.counts.success) + '</td>';
      h += '<td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">' + esc(s.counts.failure) + '</td>';
      h += '<td style="padding:8px;border-bottom:1px solid #e5e7eb;">' + errorCell(s) + '</td>';
      h += '<td style="padding:8px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">'
        + '<button type="button" data-hv-act="run" data-hv-id="' + esc(s.id) + '"' + (running ? ' disabled' : '')
        + ' style="padding:5px 12px;background:#0f766e;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;">再確認</button> '
        + '<button type="button" data-hv-act="handoff" data-hv-id="' + esc(s.id) + '"' + (canHandoff ? '' : ' disabled')
        + ' title="確認済みフラグを付けて harvest:handoff イベントを発火します (再POST・再保存はしません)"'
        + ' style="padding:5px 12px;background:#e5e7eb;color:#111;border:none;border-radius:6px;font-size:12px;cursor:pointer;">handoff準備</button>'
        + '</td>';
      h += '</tr>';
      var notes = detailNotes(s);
      if (notes) {
        h += '<tr><td colspan="7" style="padding:4px 8px 10px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#4b5563;">' + notes + '</td></tr>';
      }
    });
    h += '</tbody></table>';
    return h;
  }

  function render() {
    var content = document.getElementById(CONTENT_ID);
    if (content) content.innerHTML = buildHtml();
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
    var act = t.getAttribute('data-hv-act');
    if (!act || t.disabled) return;
    if (act === 'run-all') {
      hub.runAll();
    } else if (act === 'run') {
      hub.runCollector(t.getAttribute('data-hv-id'));
    } else if (act === 'handoff') {
      hub.handoff(t.getAttribute('data-hv-id'));
    }
    render();
  }

  function ensureOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('section');
    el.id = OVERLAY_ID;
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:99996;background:rgba(0,0,0,0.5);';
    var inner = document.createElement('div');
    inner.style.cssText = 'position:absolute;top:20px;left:50%;transform:translateX(-50%);width:min(980px,calc(100vw - 24px));max-height:calc(100vh - 40px);overflow:auto;background:#fff;color:#111;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,0.35);';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;z-index:1;flex-wrap:wrap;gap:8px;';
    bar.innerHTML = ''
      + '<b style="font-size:14px;">HARVEST Collector 確認</b>'
      + '<button type="button" data-hv-act="close" style="padding:6px 14px;background:#e5e7eb;color:#111;border:none;border-radius:6px;font-size:12px;cursor:pointer;">閉じる</button>';
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
      var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-hv-act');
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
      try { console.error('OFK3Harvest.open error:', e); } catch (e2) {}
      alert('HARVEST画面の表示中にエラーが発生しました。');
    }
  }

  function insertButton() {
    if (document.getElementById(BTN_WRAP_ID)) return;
    var html = ''
      + '<div id="' + BTN_WRAP_ID + '" class="card p-4 mb-4" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">'
      + '<div><p class="text-sm font-medium">HARVEST 回収データ確認</p>'
      + '<p class="text-xs text-ink-lighter mt-1">Cortex拡張で送信済みの素材をCollector単位で再確認します (取得は開始しません)</p></div>'
      + '<button type="button" data-hv-open="1" style="padding:8px 16px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;">HARVEST 確認</button>'
      + '</div>';
    try {
      var anchor = document.getElementById(TW_WRAP_ID) || document.getElementById(ANCHOR_ID);
      if (anchor && anchor.insertAdjacentHTML) {
        anchor.insertAdjacentHTML('afterend', html);
      } else {
        var host = document.getElementById('dashboard-content') || document.body;
        host.insertAdjacentHTML('afterbegin', html);
      }
      var wrap = document.getElementById(BTN_WRAP_ID);
      if (wrap) {
        wrap.addEventListener('click', function (ev) {
          var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-hv-open');
          if (a) openOverlay();
        });
      }
    } catch (e) {}
  }

  hub.onChange(function () {
    if (isOpen()) {
      try { render(); } catch (e) {}
    }
  });

  // index.html は無変更。既存の onDashboardRender フックに連結してダッシュボード再描画後にボタンを再挿入する。
  function chainDashboardHook() {
    var tw = window.OFK3TimeWindowBoard;
    if (!tw || typeof tw.onDashboardRender !== 'function' || tw.__harvestChained) return;
    var orig = tw.onDashboardRender;
    tw.onDashboardRender = function () {
      try { orig.apply(this, arguments); } catch (e) {}
      try { insertButton(); } catch (e2) {}
    };
    tw.__harvestChained = true;
  }

  function boot() {
    try { chainDashboardHook(); } catch (e) {}
    try { insertButton(); } catch (e) {}
  }

  window.OFK3Harvest = {
    open: openOverlay,
    close: hideOverlay,
    render: render,
    buildHtml: buildHtml,
    insertButton: insertButton,
    getHub: function () { return hub; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
