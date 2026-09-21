/**
 * OFK3 GDS台数自動照合 Phase 1 — UI（既存「台数照合」タブの拡張）.
 * 判定ロジックは gds-fleet-audit-core.js（DOM非依存）に委譲し、本ファイルは
 * ファイル読込・DOM描画のみを担当する。
 *
 * 安全設計:
 *  - #panel-fleet 配下に新規rootを追加するだけ。既存の直下要素（正常台数マスタ・
 *    旧InputFileドロップゾーン・旧alert/detail）は非表示にするだけで削除しない
 *    （既存JS関数・localStorageキーには一切触れない）。
 *  - MutationObserver・setInterval不使用。boot()は既存の明示的タブ切替フック
 *    （switchTab内のtry/catchガード付き呼び出し）からのみ再入される。
 *  - 新機能が例外を投げてもOFK3本体の起動には影響しない（全体をtry/catchで保護）。
 *  - テンプレートリテラルは使用しない（プロジェクト規約: 文字列連結のみ）。
 */
(function () {
  'use strict';

  var PANEL_ID = 'panel-fleet';
  var ROOT_ID = 'ofk3-gds-fleet-audit-root';

  var state = {
    cortex: null,   // {ok, error, byDate, meta, fileName}
    input: null,    // {ok, error, byDate, meta, fileName}
    lastCompare: null
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function core() { return window.GdsFleetAuditCore; }

  // ===== 既存UIの非破壊的な非表示 =====
  function hideLegacyChildren(panel, root) {
    var children = Array.prototype.slice.call(panel.children);
    children.forEach(function (el) {
      if (el === root) return;
      if (el.id === ROOT_ID) return;
      el.classList.add('hidden');
      el.setAttribute('data-gds-fleet-audit-legacy', '1');
    });
  }

  // ===== ファイル読込 =====
  function handleCortexFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var text = String(e.target.result || '');
        var result = core().parseCortexWeeklyCsv(text);
        result.fileName = file.name;
        state.cortex = result;
      } catch (err) {
        state.cortex = { ok: false, error: '読込エラー: ' + (err && err.message), byDate: {}, meta: {}, fileName: file.name };
      }
      renderAll();
    };
    reader.onerror = function () {
      state.cortex = { ok: false, error: 'ファイル読込に失敗しました', byDate: {}, meta: {}, fileName: file.name };
      renderAll();
    };
    reader.readAsText(file, 'UTF-8');
  }

  function handleInputFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', bookVBA: true, cellStyles: false, cellFormula: false });
        var picked = null;
        var attempts = [];
        for (var i = 0; i < wb.SheetNames.length; i++) {
          var ws = wb.Sheets[wb.SheetNames[i]];
          var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          var r = core().parseInputFileRows(rows);
          attempts.push({ sheet: wb.SheetNames[i], ok: r.ok, error: r.error });
          if (r.ok && !picked) picked = r;
        }
        if (!picked) {
          state.input = {
            ok: false,
            error: '想定するNode/Block/B-S列を持つシートが見つかりません（試行: ' + attempts.map(function (a) { return a.sheet + '=' + (a.ok ? 'OK' : a.error); }).join(' / ') + '）',
            byDate: {},
            meta: { attempts: attempts },
            fileName: file.name
          };
        } else {
          picked.fileName = file.name;
          state.input = picked;
        }
      } catch (err) {
        state.input = { ok: false, error: '読込エラー: ' + (err && err.message), byDate: {}, meta: {}, fileName: file.name };
      }
      renderAll();
    };
    reader.onerror = function () {
      state.input = { ok: false, error: 'ファイル読込に失敗しました', byDate: {}, meta: {}, fileName: file.name };
      renderAll();
    };
    reader.readAsArrayBuffer(file);
  }

  // ===== 描画 =====
  function statusText(entry, waitingLabel) {
    if (!entry) return waitingLabel;
    if (!entry.ok) return '⚠️ 解析エラー / 判定不可：' + (entry.error || '');
    var rows = entry.meta && entry.meta.ofk3Rows != null ? entry.meta.ofk3Rows : '-';
    var dates = entry.meta && entry.meta.dates ? entry.meta.dates.length : 0;
    return '✅ ' + esc(entry.fileName || '') + '（OFK3: ' + rows + '行 / ' + dates + '日分）';
  }

  function renderDropzoneStatus() {
    var cEl = document.getElementById('gds-cortex-status');
    var iEl = document.getElementById('gds-input-status');
    if (cEl) cEl.innerHTML = statusText(state.cortex, 'Cortexファイル待ち');
    if (iEl) iEl.innerHTML = statusText(state.input, 'InputFile待ち');
  }

  function categoryLabel(key) {
    return ({ bike2h: 'Bike 2h', bike3h: 'Bike 3h', pair: 'Pair', eightB: '8B' })[key] || key;
  }

  function statusBadge(status) {
    if (status === 'ok') return '<span style="color:#059669;font-weight:700;">✅</span>';
    if (status === 'alert' || status === 'inconsistent') return '<span style="color:#dc2626;font-weight:700;">🚨</span>';
    return '<span style="color:#b45309;font-weight:700;">⚪判定不可</span>';
  }

  function diffText(cat) {
    if (cat.status === 'unknown') return '—';
    if (cat.status === 'inconsistent') return '—';
    if (cat.diff === 0) return '0';
    return (cat.diff > 0 ? '+' : '') + cat.diff;
  }

  function valText(v) { return v == null ? '—' : String(v); }

  function renderSummary(cmp) {
    var el = document.getElementById('gds-fleet-summary');
    if (!el) return;
    if (!cmp || !cmp.summary.total) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    var overall = cmp.summary.alert > 0
      ? '<span style="color:#dc2626;font-weight:700;">🚨 GDS差異あり</span>'
      : (cmp.summary.unknown > 0 ? '<span style="color:#b45309;font-weight:700;">⚪ 一部判定不可</span>' : '<span style="color:#059669;font-weight:700;">✅ 全日正常</span>');
    var html = '<div class="card p-3 mb-3">'
      + '<div class="text-sm font-bold mb-2">照合期間：' + esc(cmp.rangeLabel) + '　　' + overall + '</div>'
      + '<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">'
      + '<div class="card p-3 text-center"><div class="text-xs text-ink-lighter">対象日数</div><div class="text-lg font-bold">' + cmp.summary.total + '日</div></div>'
      + '<div class="card p-3 text-center"><div class="text-xs text-ink-lighter">正常</div><div class="text-lg font-bold text-emerald-600">' + cmp.summary.ok + '日</div></div>'
      + '<div class="card p-3 text-center"><div class="text-xs text-ink-lighter">差異あり 🚨</div><div class="text-lg font-bold text-red-600">' + cmp.summary.alert + '日</div></div>'
      + '<div class="card p-3 text-center"><div class="text-xs text-ink-lighter">判定不可</div><div class="text-lg font-bold" style="color:#b45309;">' + cmp.summary.unknown + '日</div></div>'
      + '</div></div>';
    el.innerHTML = html;
  }

  function renderDays(cmp) {
    var el = document.getElementById('gds-fleet-days');
    if (!el) return;
    if (!cmp || !cmp.days.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    var html = '';
    var keys = ['bike2h', 'bike3h', 'pair', 'eightB'];
    cmp.days.forEach(function (day) {
      var borderClass = day.dayStatus === 'alert' ? 'border-red-400 bg-red-50' : (day.dayStatus === 'unknown' ? 'border-amber-300 bg-amber-50' : 'border-emerald-400 bg-emerald-50');
      var headBadge = day.dayStatus === 'alert' ? '<span class="text-red-600 font-bold">🚨 GDS差異あり / 要確認</span>'
        : (day.dayStatus === 'unknown' ? '<span style="color:#b45309;font-weight:700;">⚪ 判定不可</span>' : '<span class="text-emerald-600 font-bold">✅ 正常</span>');
      html += '<div class="card mb-4 border-2 ' + borderClass + '">';
      html += '<div class="px-4 py-2 font-bold text-sm flex items-center justify-between flex-wrap gap-1">';
      html += '<span>' + esc(day.date) + ' OFK3</span>' + headBadge;
      html += '</div>';
      html += '<table class="w-full text-sm"><thead><tr class="border-b border-border bg-surface">'
        + '<th class="px-3 py-1.5 text-left text-xs">種別</th>'
        + '<th class="px-3 py-1.5 text-center text-xs">Cortex</th>'
        + '<th class="px-3 py-1.5 text-center text-xs">Input</th>'
        + '<th class="px-3 py-1.5 text-center text-xs">差分</th>'
        + '<th class="px-3 py-1.5 text-center text-xs">判定</th>'
        + '</tr></thead><tbody>';
      keys.forEach(function (k) {
        var cat = day.categories[k];
        var rowBg = (cat.status === 'alert' || cat.status === 'inconsistent') ? ' bg-yellow-50' : '';
        html += '<tr class="border-b border-border' + rowBg + '">'
          + '<td class="px-3 py-1.5 text-xs font-medium">' + esc(categoryLabel(k)) + '</td>'
          + '<td class="px-3 py-1.5 text-center text-xs">' + esc(valText(cat.cortex)) + '</td>'
          + '<td class="px-3 py-1.5 text-center text-xs font-bold">' + esc(valText(cat.input)) + '</td>'
          + '<td class="px-3 py-1.5 text-center text-xs">' + esc(diffText(cat)) + '</td>'
          + '<td class="px-3 py-1.5 text-center text-xs">' + statusBadge(cat.status) + '</td>'
          + '</tr>';
        if (k === 'pair' && cat.status === 'inconsistent') {
          html += '<tr class="border-b border-border bg-yellow-50"><td colspan="5" class="px-3 py-1.5 text-xs" style="color:#b45309;">'
            + '⚠️ Cortex Pair内部不整合（4.5B=' + esc(valText(cat.cortex45)) + ' / 6.5B=' + esc(valText(cat.cortex65)) + '）。判定不可として扱います。'
            + '</td></tr>';
        }
      });
      html += '</tbody></table></div>';
    });
    el.innerHTML = html;
  }

  function renderWaitingOrError() {
    var el = document.getElementById('gds-fleet-message');
    if (!el) return;
    var cortexOk = state.cortex && state.cortex.ok;
    var inputOk = state.input && state.input.ok;
    if (cortexOk && inputOk) { el.classList.add('hidden'); el.innerHTML = ''; return; }

    el.classList.remove('hidden');
    var lines = [];
    if (state.cortex && !state.cortex.ok) lines.push('⚠️ Cortex GDS Weekly Report: 解析エラー / 判定不可（' + esc(state.cortex.error || '') + '）');
    else if (!state.cortex) lines.push('Cortexファイル待ち');
    if (state.input && !state.input.ok) lines.push('⚠️ Amazon InputFile: 解析エラー / 判定不可（' + esc(state.input.error || '') + '）');
    else if (!state.input) lines.push('InputFile待ち');
    el.innerHTML = '<div class="card p-3 mb-3 text-xs" style="color:#b45309;background:#fffbeb;border:1px solid #fde68a;">' + lines.join('<br>') + '</div>';
  }

  function renderDebug() {
    var pre = document.getElementById('gds-fleet-debug-pre');
    if (!pre) return;
    var debug = {
      cortexFile: state.cortex ? state.cortex.fileName : null,
      cortexOfk3Rows: state.cortex && state.cortex.meta ? state.cortex.meta.ofk3Rows : null,
      cortexDates: state.cortex && state.cortex.meta ? state.cortex.meta.dates : null,
      cortexWarnings: state.cortex && state.cortex.meta ? state.cortex.meta.warnings : null,
      inputFile: state.input ? state.input.fileName : null,
      inputOfk3Rows: state.input && state.input.meta ? state.input.meta.ofk3Rows : null,
      inputWarnings: state.input && state.input.meta ? state.input.meta.warnings : null,
      summary: state.lastCompare ? state.lastCompare.summary : null
    };
    pre.textContent = JSON.stringify(debug, null, 2);
    try { console.log('[GDS台数照合] debug:', debug); } catch (e) {}
  }

  function renderAll() {
    try {
      renderDropzoneStatus();
      var cmp = null;
      if (state.cortex && state.cortex.ok) {
        cmp = core().compareGdsFleet(state.cortex, state.input && state.input.ok ? state.input : { ok: false, byDate: {} });
      }
      state.lastCompare = cmp;
      renderSummary(cmp);
      renderDays(cmp);
      renderWaitingOrError();
      renderDebug();
    } catch (e) {
      try { console.error('[GDS台数照合] render error:', e); } catch (e2) {}
    }
  }

  // ===== root構築 =====
  function buildRootHtml() {
    var html = '';
    html += '<div class="flex items-center justify-between mb-4">';
    html += '<div><h2 class="text-sm font-medium">🚚 GDS台数照合</h2>';
    html += '<p class="text-xs text-ink-lighter mt-1">Cortex実績を正として、Amazon InputFile登録台数を自動照合します。</p></div>';
    html += '</div>';

    html += '<div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">';
    html += '<div id="gds-cortex-drop" class="border-2 border-dashed border-blue-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition">';
    html += '<p class="text-sm font-medium" style="color:#2563eb">Cortex / GDS Weekly Report</p>';
    html += '<p class="text-xs text-ink-lighter mt-1">GDS Weekly Report-*.csv をドラッグ＆ドロップ、またはクリックして選択</p>';
    html += '<input type="file" id="gds-cortex-file" accept=".csv" class="hidden">';
    html += '<div id="gds-cortex-status" class="text-xs mt-2 text-ink-lighter">Cortexファイル待ち</div>';
    html += '</div>';
    html += '<div id="gds-input-drop" class="border-2 border-dashed border-orange-300 rounded-lg p-6 text-center cursor-pointer hover:border-orange-500 hover:bg-orange-50 transition">';
    html += '<p class="text-sm font-medium" style="color:#ea580c">Amazon / GDS InputFile</p>';
    html += '<p class="text-xs text-ink-lighter mt-1">dsp1.0_inputfile_gds_*.xlsm をドラッグ＆ドロップ、またはクリックして選択</p>';
    html += '<input type="file" id="gds-input-file" accept=".xlsm,.xlsx,.xls" class="hidden">';
    html += '<div id="gds-input-status" class="text-xs mt-2 text-ink-lighter">InputFile待ち</div>';
    html += '</div>';
    html += '</div>';

    html += '<div id="gds-fleet-message" class="hidden"></div>';
    html += '<div id="gds-fleet-summary" class="hidden"></div>';
    html += '<div id="gds-fleet-days" class="hidden"></div>';
    html += '<details class="mt-4 text-xs text-ink-lighter"><summary class="cursor-pointer">🔍 デバッグ情報</summary><pre id="gds-fleet-debug-pre" class="mt-2 p-2 bg-surface-secondary rounded overflow-x-auto" style="white-space:pre-wrap;"></pre></details>';
    return html;
  }

  function wireDropzone(dropId, fileInputId, onFile) {
    var drop = document.getElementById(dropId);
    var input = document.getElementById(fileInputId);
    if (!drop || !input) return;
    drop.addEventListener('click', function (ev) {
      if (ev.target === input) return;
      input.click();
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) onFile(input.files[0]);
    });
    drop.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      drop.classList.add('ring-2');
    });
    drop.addEventListener('dragleave', function () {
      drop.classList.remove('ring-2');
    });
    drop.addEventListener('drop', function (ev) {
      ev.preventDefault();
      drop.classList.remove('ring-2');
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files[0]) onFile(files[0]);
    });
  }

  function renameTabLabel() {
    var tabBtn = document.getElementById('tab-fleet');
    if (tabBtn && tabBtn.textContent.indexOf('GDS台数照合') < 0) {
      tabBtn.textContent = '🚚 GDS台数照合';
    }
  }

  function insertRoot() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    try { renameTabLabel(); } catch (e) {}
    var existing = document.getElementById(ROOT_ID);
    if (existing) return; // 既に構築済み（冪等）
    if (!core()) return; // gds-fleet-audit-core.js未ロード時は何もしない（安全側）

    var root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = buildRootHtml();

    hideLegacyChildren(panel, root);
    panel.insertBefore(root, panel.firstChild);

    wireDropzone('gds-cortex-drop', 'gds-cortex-file', handleCortexFile);
    wireDropzone('gds-input-drop', 'gds-input-file', handleInputFile);
    renderAll();
  }

  function onTab(tab) {
    if (tab !== 'fleet') return;
    try { insertRoot(); } catch (e) {}
  }

  function boot() {
    try { insertRoot(); } catch (e) {}
  }

  window.OFK3GdsFleetAudit = {
    onTab: onTab,
    getState: function () { return state; },
    _renderAll: renderAll
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
