/**
 * OFK3 Rolling 60h — UI層（ブラウザ専用: FileReader / XLSX読込 / DOM描画）
 *
 * 計算・データ変換は一切ここに書かない。全て window.RollingCore
 * （rolling60h-core.js）の純粋関数に委譲する。
 * 既存の wh60*（日次WH60）、tenko*、shiftMasterData、SHIFT_MASTER、
 * EXEC_RATE_TABLE、normalizeShiftCode、normalizeExecCourseType、
 * processShiftMaster 等の既存グローバルは参照・変更しない
 * （唯一の連携点は index.html 側の wh60SwitchSubTab() からの
 *   RollingUI.onShown() 呼び出しのみ）。
 *
 * 対応範囲（初回実装＋月またぎ対応拡張）:
 *   - 高橋さんExcel（月間シフト・複数DSPシート）読込。最大2か月分（2ファイル）まで
 *     読み込み、日付単位でマージして月またぎ・年またぎのRolling判定に対応する
 *   - Amazon Daily Working Hour Excel（Report5_Daily_Data のみ。貼付は読まない）
 *   - Transport ID を一次キーにした実績＋予定の合成
 *   - Rolling 7 Days 判定・roster_only / actual_progress の判別
 *   - 隣接月データが無く7日分揃わないウィンドウは「complete:false」として
 *     over/warningを確定させない（休=0h等の推測をしない）
 *   - 同一Transport ID・同一日付が複数のシフトファイルに存在する場合の
 *     重複検知・採用ソースの明示（二重加算はしない）
 *   - ドライバー×日付のシフト表グリッド描画、超過期間のハイライト、詳細モーダル
 *
 * 未対応（今回のスコープ外。将来追加）:
 *   - ○→❽ 等の仮変更シミュレーションUI（計算コア側 computeRolling60h の
 *     overrides引数は既に対応済み。UIからの呼び出し口は未実装）
 */
(function (global) {
  'use strict';

  var MAX_ROSTER_SOURCES = 2; // 「最大2か月分」＝最大2ファイルまで保持する

  var STATE = {
    initialized: false,
    rosterSources: [], // [{ label, sheetsData: {sheetName: rows2D} }]（読込順、最大2件）
    amazonRows: null,
    referenceDate: null, // 'YYYY-MM-DD'
    limitHours: 60.0,
    warningHours: 60.0,
    stationFilter: 'OFK3',
    dataImportedAt: null, // 最後にシフト/実績ファイルを投入した時刻(ISO)。集計時刻とは別に保持する
    // 計算結果
    drivers: [], // [{ key, meta, dateList, windows, seriesByDate }]
    diagnostics: { undefinedCodeCounts: {}, warnings: [], rosterDuplicates: [] },
  };

  // シフト読込対象から除外するシート（実績・システム系・集計系シートで、
  // Transport IDを持つ「DSP別ドライバー一覧」シートではないため）
  var ROSTER_SHEET_BLACKLIST = ['貼付', 'WH60', '点呼表', 'Export', 'システム', 'メイン'];

  function el(html) {
    var div = document.createElement('div');
    div.innerHTML = html.trim();
    return div.firstChild;
  }

  function fmtHours(h) {
    if (h === null || h === undefined || isNaN(h)) return '-';
    return h.toFixed(1) + 'h';
  }

  // ===========================================================================
  // 初回描画（コンテナへUIを流し込む）
  // ===========================================================================
  function ensureRendered() {
    var container = document.getElementById('wh60-rolling-subpanel');
    if (!container || STATE.initialized) return;
    container.innerHTML =
      '<div class="flex items-center justify-between mb-4">' +
      '  <div>' +
      '    <h2 class="text-lg font-bold">📅 Rolling 60h</h2>' +
      '    <p class="text-sm text-ink-lighter">任意の連続7日間で60時間超過を判定（固定週ではありません）</p>' +
      '  </div>' +
      '</div>' +
      '<div class="grid grid-cols-2 gap-4 mb-4">' +
      '  <div class="card p-4">' +
      '    <h3 class="text-sm font-bold mb-2">① 月間シフト表（高橋さんExcel）読込　※最大2か月分</h3>' +
      '    <p class="text-xs text-ink-lighter mb-2">DSP別シート（GDS等）からTransport ID・勤務記号を抽出します。前月分＋当月分など2ファイルまで読込可能（月またぎ判定用）</p>' +
      '    <input type="file" id="rolling-file-roster" accept=".xlsx,.xls" class="hidden">' +
      '    <button id="rolling-btn-roster" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700">📂 ファイルを追加読込</button>' +
      '    <button id="rolling-btn-roster-reset" class="px-3 py-2 ml-2 bg-gray-600 text-white rounded-lg text-sm hover:bg-gray-700">🗑 クリア</button>' +
      '    <div id="rolling-roster-status" class="text-xs mt-2 text-ink-lighter"></div>' +
      '  </div>' +
      '  <div class="card p-4">' +
      '    <h3 class="text-sm font-bold mb-2">② Amazon Daily Working Hour 読込</h3>' +
      '    <p class="text-xs text-ink-lighter mb-2">マニフェストの Report5_Daily_Data だけを読みます。時間は estimated_working_hour（推定）です。貼付シートは使いません。</p>' +
      '    <input type="file" id="rolling-file-amazon" accept=".xlsx,.xls" class="hidden">' +
      '    <button id="rolling-btn-amazon" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700">📂 ファイル選択</button>' +
      '    <div id="rolling-amazon-status" class="text-xs mt-2 text-ink-lighter"></div>' +
      '  </div>' +
      '</div>' +
      '<div class="card p-4 mb-4 flex flex-wrap items-end gap-4">' +
      '  <div>' +
      '    <label class="block text-xs text-ink-lighter mb-1">基準日（この日より前=実績優先／以降=予定優先）</label>' +
      '    <input type="date" id="rolling-reference-date" class="border rounded px-2 py-1 text-sm">' +
      '  </div>' +
      '  <div>' +
      '    <label class="block text-xs text-ink-lighter mb-1">超過しきい値(h)</label>' +
      '    <input type="number" id="rolling-limit-hours" value="60" step="0.5" class="border rounded px-2 py-1 text-sm w-24">' +
      '  </div>' +
      '  <div>' +
      '    <label class="block text-xs text-ink-lighter mb-1">警戒ライン(h)　※超過とは別の注意状態</label>' +
      '    <input type="number" id="rolling-warning-hours" value="60" step="0.5" class="border rounded px-2 py-1 text-sm w-24">' +
      '  </div>' +
      '  <button id="rolling-btn-recompute" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold hover:bg-indigo-700">🔄 再計算</button>' +
      '</div>' +
      '<div class="grid grid-cols-4 gap-3 mb-4" id="rolling-summary">' +
      '  <div class="card p-3 text-center"><div class="text-2xl font-bold" id="rolling-total-drivers">-</div><div class="text-xs text-ink-lighter">対象ドライバー数</div></div>' +
      '  <div class="card p-3 text-center border-l-4 border-red-500"><div class="text-2xl font-bold text-red-500" id="rolling-roster-only-count">-</div><div class="text-xs text-ink-lighter">🔴 シフト予定超過(roster_only)</div></div>' +
      '  <div class="card p-3 text-center border-l-4 border-orange-500"><div class="text-2xl font-bold text-orange-500" id="rolling-actual-progress-count">-</div><div class="text-xs text-ink-lighter">🟠 実績進捗リスク(actual_progress)</div></div>' +
      '  <div class="card p-3 text-center border-l-4 border-gray-400"><div class="text-2xl font-bold text-gray-400" id="rolling-undefined-count">-</div><div class="text-xs text-ink-lighter">⚠ 未定義勤務記号(種類)</div></div>' +
      '</div>' +
      '<div id="rolling-undefined-detail" class="text-xs text-ink-lighter mb-3"></div>' +
      '<div id="rolling-duplicate-detail" class="text-xs text-orange-500 mb-3"></div>' +
      '<div id="rolling-period-detail" class="text-xs text-ink-lighter mb-3"></div>' +
      '<div class="card p-4 mb-4" id="rolling-alert-card">' +
      '  <div class="flex flex-wrap items-center justify-between gap-2 mb-2">' +
      '    <h3 class="text-sm font-bold">🚨 ローリングシフト アラート者（過去6日＋当日の7日間）</h3>' +
      '    <span id="rolling-alert-phase" class="text-xs"></span>' +
      '  </div>' +
      '  <div id="rolling-alert-meta" class="text-xs text-ink-lighter mb-2"></div>' +
      '  <div id="rolling-alert-counts" class="text-xs mb-2"></div>' +
      '  <div id="rolling-alert-body"></div>' +
      '  <p class="text-[10px] text-ink-lighter mt-2">判定: 60hちょうどは超過ではありません。接近警告は過去6日が49〜60hで当日の勤務が確認できる人のみ（当日休は除外）。空白・データなしの日は0hにせず「未取得」として扱います。</p>' +
      '</div>' +
      '<style id="rolling-name-sticky-style">' +
      '#wh60-rolling-subpanel .rolling-grid-scroll{overflow-x:auto;max-width:100%;min-width:0;}' +
      '#wh60-rolling-subpanel .rolling-grid-table{width:max-content;min-width:100%;border-collapse:separate;border-spacing:0;}' +
      '#wh60-rolling-subpanel .rolling-name-col{position:sticky;left:0;z-index:2;background-color:#fff!important;background-image:none!important;border-right:1px solid #cbd5e1;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;}' +
      '#wh60-rolling-subpanel thead .rolling-name-col{z-index:4;}' +
      '</style>' +
      '<div class="card p-4">' +
      '  <h3 class="text-sm font-bold mb-3">ドライバー×日付 シフト表（Rolling超過期間ハイライト）</h3>' +
      '  <div class="rolling-grid-scroll" id="rolling-grid-wrap">' +
      '    <div id="rolling-grid-empty" class="text-center text-ink-lighter py-8">月間シフト表とAmazon実績を読み込んでください</div>' +
      '  </div>' +
      '</div>' +
      '<div id="rolling-detail-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center" style="background:rgba(0,0,0,0.5);">' +
      '  <div class="bg-white rounded-lg p-5 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto" id="rolling-detail-modal-body"></div>' +
      '</div>';

    document.getElementById('rolling-btn-roster').onclick = function () {
      document.getElementById('rolling-file-roster').click();
    };
    document.getElementById('rolling-btn-roster-reset').onclick = function () {
      STATE.rosterSources = [];
      STATE.dataImportedAt = null;
      document.getElementById('rolling-roster-status').textContent = '';
      readOptionsFromUI();
      recomputeAndRender();
    };
    document.getElementById('rolling-btn-amazon').onclick = function () {
      document.getElementById('rolling-file-amazon').click();
    };
    document.getElementById('rolling-file-roster').onchange = handleRosterFile;
    document.getElementById('rolling-file-amazon').onchange = handleAmazonFile;
    document.getElementById('rolling-btn-recompute').onclick = function () {
      readOptionsFromUI();
      recomputeAndRender();
    };
    document.getElementById('rolling-detail-modal').onclick = function (e) {
      if (e.target.id === 'rolling-detail-modal') closeModal();
    };

    // 基準日の初期値: 既存 getTodayJst() があれば流用（読み取りのみ、変更しない）
    var todayStr = null;
    try {
      if (typeof getTodayJst === 'function') todayStr = getTodayJst();
    } catch (e) {}
    if (!todayStr) {
      var d = new Date();
      todayStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    document.getElementById('rolling-reference-date').value = todayStr;
    STATE.referenceDate = todayStr;
    document.getElementById('rolling-reference-date').addEventListener('change', function () {
      renderAlerts(); // 基準日が集計済みの対象日とずれたら古い結果の警告を出す
    });

    STATE.initialized = true;
    restoreAlerts();
  }

  function readOptionsFromUI() {
    var refInput = document.getElementById('rolling-reference-date');
    var limitInput = document.getElementById('rolling-limit-hours');
    var warnInput = document.getElementById('rolling-warning-hours');
    if (refInput && refInput.value) STATE.referenceDate = refInput.value;
    if (limitInput && limitInput.value) STATE.limitHours = parseFloat(limitInput.value) || 60.0;
    if (warnInput && warnInput.value) STATE.warningHours = parseFloat(warnInput.value) || STATE.limitHours;
  }

  // ===========================================================================
  // ファイル読込
  // ===========================================================================
  function handleRosterFile(evt) {
    var file = evt.target.files[0];
    if (!file) return;
    evt.target.value = ''; // 同じファイルを選び直しても change が発火するようにする
    var statusEl = document.getElementById('rolling-roster-status');
    statusEl.textContent = '読み込み中...';
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        var sheetsData = {};
        var scannedSheets = [];
        wb.SheetNames.forEach(function (sn) {
          if (ROSTER_SHEET_BLACKLIST.indexOf(sn) !== -1) return;
          var ws = wb.Sheets[sn];
          var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
          sheetsData[sn] = rows;
          scannedSheets.push(sn);
        });

        // 「最大2か月分」＝最大2ファイルまで保持。3件目以降は最も古いファイルを
        // 追い出す（FIFO）。既存のクリアボタンで明示的にリセットも可能。
        STATE.dataImportedAt = new Date().toISOString();
        STATE.rosterSources.push({ label: file.name || 'ファイル' + (STATE.rosterSources.length + 1), sheetsData: sheetsData });
        var evicted = null;
        if (STATE.rosterSources.length > MAX_ROSTER_SOURCES) {
          evicted = STATE.rosterSources.shift();
        }

        readOptionsFromUI();
        recomputeAndRender();
        renderRosterStatus(scannedSheets, evicted);
      } catch (ex) {
        statusEl.innerHTML = '<span class="text-red-400">読込エラー: ' + ex.message + '</span>';
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderRosterStatus(lastScannedSheets, evicted) {
    var statusEl = document.getElementById('rolling-roster-status');
    var lines = STATE.rosterSources.map(function (src) {
      var range = STATE.rosterSourceRanges && STATE.rosterSourceRanges[src.label];
      return '・' + src.label + '（' + Object.keys(src.sheetsData).length + 'シート' + (range ? '／' + range.min + '〜' + range.max : '') + '）';
    });
    var html = '<span class="text-green-400">✓ 読込済み（' + STATE.rosterSources.length + '/' + MAX_ROSTER_SOURCES + '）</span><br>' + lines.join('<br>');
    if (evicted) {
      html += '<br><span class="text-yellow-400">⚠ 最大' + MAX_ROSTER_SOURCES + 'ファイルまでのため「' + evicted.label + '」を破棄しました。必要な場合は再読込してください。</span>';
    }
    statusEl.innerHTML = html;
  }

  function handleAmazonFile(evt) {
    var file = evt.target.files[0];
    if (!file) return;
    evt.target.value = ''; // 同じファイルを選び直しても change が発火するようにする
    var statusEl = document.getElementById('rolling-amazon-status');
    statusEl.textContent = '読み込み中...';
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        var sheetName = global.RollingCore && global.RollingCore.pickReport5Sheet
          ? global.RollingCore.pickReport5Sheet(wb.SheetNames)
          : null;
        if (!sheetName) {
          var legacyPaste = wb.SheetNames.indexOf('貼付') !== -1;
          statusEl.innerHTML = legacyPaste
            ? '<span class="text-yellow-400">貼付シートは旧方式のため読みません。マニフェストの Report5_Daily_Data を選んでください。</span>'
            : '<span class="text-red-400">Report5_Daily_Data が見つかりません。</span>';
          return;
        }
        var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true });
        STATE.amazonRows = rows;
        STATE.dataImportedAt = new Date().toISOString();
        statusEl.innerHTML = '<span class="text-green-400">✓ ' + sheetName + ' シート読込（' + (rows.length - 1) + '行）</span>';
        readOptionsFromUI();
        recomputeAndRender();
      } catch (ex) {
        statusEl.innerHTML = '<span class="text-red-400">読込エラー: ' + ex.message + '</span>';
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ===========================================================================
  // 計算 → 描画
  // ===========================================================================
  function recomputeAndRender() {
    try {
      recomputeAndRenderInner();
    } catch (ex) {
      ALERT.seq++;
      ALERT.phase = 'error';
      ALERT.error = ex && ex.message ? ex.message : String(ex);
      renderAlerts();
      throw ex;
    }
  }

  function recomputeAndRenderInner() {
    if (STATE.rosterSources.length === 0 && !STATE.amazonRows) {
      ALERT.seq++;
      ALERT.phase = ALERT.snapshot && ALERT.source === 'restored' ? 'ready' : 'no-data';
      renderAlerts();
      return;
    }
    var RollingCore = global.RollingCore;
    if (!RollingCore) return;

    var undefinedCodeCounts = {};
    var warnings = [];

    // 1) ロースター（最大2ファイル×複数DSPシート）を解析し、driverごとに
    //    「ソース単位のblocksByDate」を集める（マージ・重複検知は後段でまとめて行う。
    //    ここでは絶対に単純concatで二重加算しない）。
    var driverMeta = {}; // key -> {name, company, transportId}
    var driverSourceContributions = {}; // key -> [{label, blocksByDate}, ...]（読込順）
    var rosterSourceRanges = {}; // sourceLabel -> {min,max}（読込済みシフト月の表示用）

    STATE.rosterSources.forEach(function (source) {
      var sourceRange = null;
      Object.keys(source.sheetsData).forEach(function (sheetName) {
        var rows = source.sheetsData[sheetName];
        var parsed = RollingCore.parseMonthlyRosterSheetRows(rows, {
          isNonDriverRow: typeof AssignSupportCore !== 'undefined' && AssignSupportCore.isShiftNonDriverRow ? AssignSupportCore.isShiftNonDriverRow : null,
        });
        warnings = warnings.concat(
          parsed.warnings.map(function (w) {
            return Object.assign({ file: source.label, sheet: sheetName }, w);
          })
        );
        if (parsed.meta && parsed.meta.dateRange) {
          if (!sourceRange) {
            sourceRange = { min: parsed.meta.dateRange.min, max: parsed.meta.dateRange.max };
          } else {
            if (parsed.meta.dateRange.min < sourceRange.min) sourceRange.min = parsed.meta.dateRange.min;
            if (parsed.meta.dateRange.max > sourceRange.max) sourceRange.max = parsed.meta.dateRange.max;
          }
        }

        var grouped = RollingCore.groupRosterRecordsByDriver(parsed.records);
        Object.keys(grouped).forEach(function (key) {
          driverMeta[key] = grouped[key].meta;
          driverSourceContributions[key] = driverSourceContributions[key] || [];
          driverSourceContributions[key].push({
            label: source.label + '::' + sheetName,
            blocksByDate: grouped[key].blocksByDate,
          });
        });
      });
      if (sourceRange) rosterSourceRanges[source.label] = sourceRange;
    });
    STATE.rosterSourceRanges = rosterSourceRanges;

    // 1-b) driverごとに複数ソースを日付単位でマージ（重複日付は「後読込優先」＋警告）
    var rosterBlocksByDriver = {}; // key -> {date: blocks[]}
    var rosterDuplicates = [];
    Object.keys(driverSourceContributions).forEach(function (key) {
      var mergeResult = RollingCore.mergeRosterBlocksByDateAcrossSources(driverSourceContributions[key]);
      rosterBlocksByDriver[key] = mergeResult.merged;
      mergeResult.duplicates.forEach(function (dup) {
        rosterDuplicates.push(Object.assign({ driverKey: key, driverName: (driverMeta[key] || {}).name || key }, dup));
      });
      Object.keys(mergeResult.merged).forEach(function (date) {
        mergeResult.merged[date].forEach(function (b) {
          if (!b.defined) {
            var label = b.rawCode || b.code;
            undefinedCodeCounts[label] = (undefinedCodeCounts[label] || 0) + 1;
          }
        });
      });
    });

    // 2) Amazon実績を解析
    var actualBlocksByTid = {};
    STATE.amazonDateRange = null;
    if (STATE.amazonRows) {
      var amazonParsed = RollingCore.parseAmazonDailyRows(STATE.amazonRows, { stationFilter: STATE.stationFilter });
      warnings = warnings.concat(amazonParsed.warnings);
      actualBlocksByTid = RollingCore.groupActualRecordsByTransportId(amazonParsed.records);
      STATE.amazonDateRange = amazonParsed.dateRange;
    }

    // 3) Transport IDを一次キーに実績を紐付け（無ければ氏名キーのまま＝実績と突合できない旨を警告）
    Object.keys(actualBlocksByTid).forEach(function (tid) {
      var matched = Object.keys(driverMeta).some(function (key) {
        return driverMeta[key].transportId && driverMeta[key].transportId === tid;
      });
      if (!matched) {
        driverMeta[tid] = driverMeta[tid] || { name: '(氏名未特定・Amazon実績のみ)', company: '', transportId: tid };
        rosterBlocksByDriver[tid] = rosterBlocksByDriver[tid] || {};
      }
    });

    // 4) ドライバー毎にタイムライン構築 → Rolling判定
    var driverResults = [];
    var skippedShort = 0;
    Object.keys(driverMeta).forEach(function (key) {
      var meta = driverMeta[key];
      var tid = meta.transportId;
      var roster = rosterBlocksByDriver[key] || {};
      var actual = (tid && actualBlocksByTid[tid]) || {};

      var allDates = Object.keys(roster).concat(Object.keys(actual));
      if (allDates.length === 0) return;
      allDates.sort();
      var minDate = allDates[0];
      var maxDate = allDates[allDates.length - 1];

      var rosterOnlySeries = RollingCore.buildContinuousDailySeries(roster, minDate, maxDate);
      var blended = RollingCore.mergeActualAndRoster(actual, roster, STATE.referenceDate);
      var blendedSeries = RollingCore.buildContinuousDailySeries(blended, minDate, maxDate);

      if (blendedSeries.length < 7) { skippedShort++; return; } // 7日未満は判定対象外（件数は一覧に表示）

      var windows = RollingCore.computeRollingRisk(rosterOnlySeries, blendedSeries, {
        limitHours: STATE.limitHours,
        warningHours: STATE.warningHours,
      });

      driverResults.push({
        key: key,
        meta: meta,
        minDate: minDate,
        maxDate: maxDate,
        series: blendedSeries,
        windows: windows,
      });
    });

    driverResults.sort(function (a, b) {
      return (a.meta.name || '').localeCompare(b.meta.name || '', 'ja');
    });

    STATE.drivers = driverResults;
    STATE.skippedShortSeries = skippedShort;
    STATE.diagnostics = { undefinedCodeCounts: undefinedCodeCounts, warnings: warnings, rosterDuplicates: rosterDuplicates };
    STATE.dryRun = global.InoichiRollingDryRun && global.InoichiRollingDryRun.fromDrivers
      ? global.InoichiRollingDryRun.fromDrivers(driverResults, { previousKeys: STATE.dryRunKeys || [] })
      : null;
    if (STATE.dryRun) {
      STATE.dryRunKeys = (STATE.dryRun.alerts || []).map(function (alert) { return alert.alertKey; });
    }

    renderSummary();
    renderGrid();
    runAlertPipeline();
  }

  // ===========================================================================
  // アラート者一覧（データ投入 → 判定 → 一覧更新 → 保存）
  // ===========================================================================
  var ALERT_CACHE_KEY = 'ofk3.rollingAlerts.latest.v1';
  var ALERT = {
    phase: 'no-data', // no-data | computing | ready | error
    snapshot: null,
    source: null, // 'computed'(今回の投入から集計) | 'restored'(保存済みを復元)
    saveState: null, // saving | saved | unchanged | local-only | no-token | auth-failed | not-configured | conflict | error
    localSaveState: null, // ok | error（ブラウザ保存）
    serverRevision: null, // 最後に確認したサーバー側リビジョン（保存時の競合判定に使う）
    serverSavedAt: null,
    conflict: null, // 他端末の結果 {revision, savedAt, snapshot}
    error: '',
    inflight: false, // 保存リクエスト実行中
    pending: null, // 実行中に来た次の保存（最新1件）
    seq: 0, // 新しい集計が始まったら古い非同期結果を捨てるための世代番号
  };

  function alertCore() {
    return global.RollingAlertCore;
  }

  function currentTargetDate() {
    var input = document.getElementById('rolling-reference-date');
    return (input && input.value) || STATE.referenceDate;
  }

  // 同期キーは既存の点呼同期と同じ端末localStorage（tenkoSyncToken）を流用する。ソースには埋め込まない。
  function syncToken() {
    try { return global.localStorage.getItem('tenkoSyncToken') || ''; } catch (e) { return ''; }
  }

  function apiHeaders() {
    var h = { 'Content-Type': 'application/json' };
    var t = syncToken();
    if (t) h['X-Tenko-Sync-Token'] = t;
    return h;
  }

  function cacheSnapshot(snap) {
    try {
      global.localStorage.setItem(ALERT_CACHE_KEY, JSON.stringify({ snapshot: snap, revision: ALERT.serverRevision }));
      ALERT.localSaveState = 'ok';
    } catch (e) {
      ALERT.localSaveState = 'error'; // 容量超過・プライベートモード等。画面に明示する
    }
  }

  function readCachedSnapshot() {
    try {
      var raw = JSON.parse(global.localStorage.getItem(ALERT_CACHE_KEY) || 'null');
      var r = raw && raw.snapshot ? alertCore().sanitizeSnapshot(raw.snapshot) : { ok: false };
      return r.ok ? { snapshot: r.snapshot, revision: typeof raw.revision === 'string' ? raw.revision : null } : null;
    } catch (e) {
      return null;
    }
  }

  function adopt(snapshot, revision, savedAt, source) {
    ALERT.snapshot = snapshot;
    ALERT.source = source;
    ALERT.phase = 'ready';
    ALERT.serverRevision = revision || null;
    ALERT.serverSavedAt = savedAt || null;
    ALERT.conflict = null;
    cacheSnapshot(snapshot);
  }

  function runAlertPipeline() {
    var core = alertCore();
    var seq = ++ALERT.seq;
    if (!core) {
      ALERT.phase = 'error';
      ALERT.error = 'rolling-alert-core.js が読み込まれていません';
      renderAlerts();
      return;
    }
    ALERT.phase = 'computing';
    ALERT.error = '';
    ALERT.conflict = null;
    renderAlerts();
    // 「集計中」を描画してから判定する。途中で新しい投入があれば seq が進み、この結果は捨てる。
    setTimeout(function () {
      if (seq !== ALERT.seq) return;
      var snap;
      try {
        snap = core.buildSnapshot(STATE.drivers, {
          targetDate: STATE.referenceDate,
          limitHours: STATE.limitHours,
          dataImportedAt: STATE.dataImportedAt,
          computedAt: new Date().toISOString(),
          skippedShortSeries: STATE.skippedShortSeries || 0,
          sources: STATE.rosterSources.map(function (r) { return r.label; }).concat(STATE.amazonRows ? ['Amazon Daily Working Hour'] : []),
        });
      } catch (ex) {
        ALERT.phase = 'error';
        ALERT.error = ex && ex.message ? ex.message : String(ex);
        renderAlerts();
        return;
      }
      ALERT.snapshot = snap;
      ALERT.source = 'computed';
      ALERT.phase = 'ready';
      ALERT.saveState = 'saving';
      cacheSnapshot(snap);
      renderAlerts();
      saveSnapshot(snap, seq, false);
    }, 0);
  }

  // 保存は同時に1件だけ送る。連続投入（シフト→Amazon）で前の保存応答を待たずに次を送ると、
  // 古いリビジョンのまま自分自身と競合するため、実行中に来た保存は最新の1件にまとめて後から送る。
  function saveSnapshot(snap, seq, overwrite) {
    if (typeof global.fetch !== 'function') {
      ALERT.saveState = 'local-only';
      renderAlerts();
      return;
    }
    if (!syncToken()) {
      ALERT.saveState = 'no-token';
      renderAlerts();
      return;
    }
    if (ALERT.inflight) {
      ALERT.pending = { snap: snap, seq: seq, overwrite: overwrite };
      return;
    }
    ALERT.inflight = true;
    var finish = function () {
      ALERT.inflight = false;
      var p = ALERT.pending;
      ALERT.pending = null;
      if (p && p.seq === ALERT.seq) saveSnapshot(p.snap, p.seq, p.overwrite);
    };
    global.fetch('/rolling-alerts/save', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ snapshot: snap, baseRevision: ALERT.serverRevision, overwrite: !!overwrite }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (r) {
        // サーバーのリビジョンは事実なので、集計が新しくなっていても必ず反映する
        if (r.status === 200) {
          ALERT.serverRevision = r.body.revision || null;
          ALERT.serverSavedAt = r.body.savedAt || null;
        }
        if (seq !== ALERT.seq) return;
        if (r.status === 200) {
          ALERT.saveState = r.body.status === 'unchanged' ? 'unchanged' : 'saved';
          cacheSnapshot(ALERT.snapshot);
        } else if (r.status === 409 && r.body && r.body.snapshot) {
          var v = alertCore().sanitizeSnapshot(r.body.snapshot);
          ALERT.saveState = 'conflict';
          ALERT.conflict = v.ok ? { revision: r.body.revision, savedAt: r.body.savedAt, snapshot: v.snapshot } : null;
        } else if (r.status === 401 || r.status === 403) {
          ALERT.saveState = 'auth-failed';
        } else if (r.status === 503) {
          ALERT.saveState = 'not-configured';
        } else {
          ALERT.saveState = 'error';
        }
        renderAlerts();
      })
      .catch(function () {
        if (seq !== ALERT.seq) return;
        ALERT.saveState = 'local-only';
        renderAlerts();
      })
      .then(finish, finish);
  }

  /** 他端末の結果と競合したとき: 利用者の選択で、サーバー側の結果を採用する */
  function acceptServerResult() {
    if (!ALERT.conflict) return;
    ALERT.seq++;
    var c = ALERT.conflict;
    adopt(c.snapshot, c.revision, c.savedAt, 'restored');
    ALERT.saveState = 'saved';
    renderAlerts();
  }

  /** 他端末の結果と競合したとき: 利用者の選択で、この端末の結果を上書き保存する */
  function overwriteServerResult() {
    if (!ALERT.conflict || !ALERT.snapshot) return;
    var seq = ++ALERT.seq;
    ALERT.serverRevision = ALERT.conflict.revision;
    ALERT.conflict = null;
    ALERT.saveState = 'saving';
    renderAlerts();
    saveSnapshot(ALERT.snapshot, seq, true);
  }

  /**
   * ページ再読み込み後の復元。サーバー保存を正（リビジョン管理）とし、端末の時計で新旧を比べない。
   * サーバーに届かない/キー未設定のときだけブラウザ保存を表示する。
   * サーバーが空（再デプロイ等で消失）でブラウザ保存が残っていれば、それを再保存する。
   */
  function restoreAlerts() {
    var core = alertCore();
    if (!core) return;
    var cached = readCachedSnapshot();
    if (cached && !ALERT.snapshot) {
      ALERT.snapshot = cached.snapshot;
      ALERT.serverRevision = cached.revision;
      ALERT.source = 'restored';
      ALERT.phase = 'ready';
      renderAlerts();
    }
    if (typeof global.fetch !== 'function') return;
    if (!syncToken()) {
      ALERT.saveState = 'no-token';
      renderAlerts();
      return;
    }
    global.fetch('/rolling-alerts/latest', { cache: 'no-store', headers: apiHeaders() })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { ALERT.saveState = 'auth-failed'; renderAlerts(); return null; }
        if (res.status === 503) { ALERT.saveState = 'not-configured'; renderAlerts(); return null; }
        if (res.status !== 200) { ALERT.saveState = 'error'; renderAlerts(); return null; }
        return res.json();
      })
      .then(function (body) {
        if (!body) return;
        if (ALERT.source === 'computed') return; // 今回投入した集計を優先（保存側で競合判定する）
        if (body.status === 'ok') {
          var v = core.sanitizeSnapshot(body.snapshot);
          if (!v.ok) return;
          adopt(v.snapshot, body.revision, body.savedAt, 'restored');
          ALERT.saveState = 'saved';
          renderAlerts();
        } else if (body.status === 'empty' && ALERT.snapshot) {
          // サーバー側の保存が消えている（再デプロイ等）。ブラウザ保存の結果を再保存する。
          ALERT.serverRevision = null;
          ALERT.saveState = 'saving';
          renderAlerts();
          saveSnapshot(ALERT.snapshot, ALERT.seq, false);
        }
      })
      .catch(function () {
        ALERT.saveState = 'local-only';
        renderAlerts();
      });
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtJst(iso) {
    if (!iso) return '未取得';
    var t = Date.parse(iso);
    if (isNaN(t)) return '未取得';
    return new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
  }

  var CLASS_BADGE = {
    exceed_confirmed: 'background:#fee2e2;color:#b91c1c;',
    exceed_forecast: 'background:#ffedd5;color:#c2410c;',
    approach: 'background:#fef9c3;color:#a16207;',
    schedule_unconfirmed: 'background:#e5e7eb;color:#374151;',
  };
  var SAVE_LABEL = {
    saving: '保存中…',
    saved: 'サーバー保存済み',
    unchanged: 'サーバー保存済み（同一データのため変更なし）',
    'local-only': 'サーバーに接続できないため未保存（このブラウザにのみ保存）',
    'no-token': '同期キー未設定のためサーバー未保存（点呼管理タブの「端末間同期キー」で設定）',
    'auth-failed': '同期キーが正しくないためサーバー未保存',
    'not-configured': 'サーバー側の同期設定が未完了のため未保存（管理者に確認）',
    conflict: '他の端末がより新しい結果を保存しています（上書きしていません）',
    error: 'サーバー保存に失敗しました',
  };

  function alertRowHtml(a, dataImportedAt) {
    var past = a.past6Hours !== null
      ? fmtHours(a.past6Hours) + '<div class="text-[10px] text-ink-lighter">実績 ' + fmtHours(a.past6ActualHours) + ' / 予定 ' + fmtHours(a.past6PlanHours) + '</div>'
      : '既知 ' + fmtHours(a.past6KnownHours) + '<div class="text-[10px] text-ink-lighter">未取得 ' + a.past6MissingDates.length + '日</div>';
    var today = a.todayStatus === 'work' ? fmtHours(a.todayHours)
      : a.todayStatus === 'off' ? '休 (0.0h)' : '勤務予定未確認';
    var total = a.rollingTotalHours !== null ? fmtHours(a.rollingTotalHours) : '未確認';
    var rem;
    if (!a.remainingExact) {
      rem = a.remainingHours < 0 ? '超過 +' + fmtHours(-a.remainingHours) + ' 以上' : '未確認';
    } else {
      rem = a.remainingHours < 0 ? '超過 +' + fmtHours(-a.remainingHours) : a.remainingHours === 0 ? '残り 0.0h（ちょうど60h）' : '残り ' + fmtHours(a.remainingHours);
    }
    return '<tr class="border-b border-gray-700 align-top">' +
      '<td class="p-2 font-medium">' + esc(a.name || '(氏名未特定)') + '<div class="text-[10px] text-ink-lighter">' + esc(a.transportId || 'Transport ID 未取得') + '</div></td>' +
      '<td class="p-2 whitespace-nowrap">' + esc(a.targetDate) + '</td>' +
      '<td class="p-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded font-bold" style="' + CLASS_BADGE[a.alertClass] + '">' + esc(a.label) + '</span></td>' +
      '<td class="p-2 whitespace-nowrap">' + past + '</td>' +
      '<td class="p-2 whitespace-nowrap">' + today + '</td>' +
      '<td class="p-2 whitespace-nowrap">' + total + '</td>' +
      '<td class="p-2 whitespace-nowrap">' + rem + '</td>' +
      '<td class="p-2" style="min-width:260px;">' + esc(a.basis) + '</td>' +
      '<td class="p-2 whitespace-nowrap">' + esc(fmtJst(dataImportedAt)) + '</td>' +
      '</tr>';
  }

  function renderAlerts() {
    var phaseEl = document.getElementById('rolling-alert-phase');
    var metaEl = document.getElementById('rolling-alert-meta');
    var countsEl = document.getElementById('rolling-alert-counts');
    var bodyEl = document.getElementById('rolling-alert-body');
    if (!phaseEl || !bodyEl) return;
    var core = alertCore();
    var snap = ALERT.snapshot;
    metaEl.innerHTML = '';
    countsEl.innerHTML = '';
    phaseEl.innerHTML = '';

    if (ALERT.phase === 'computing') {
      phaseEl.innerHTML = '<span style="color:#2563eb;font-weight:700;">集計中…</span>';
      bodyEl.innerHTML = '<div class="text-center text-ink-lighter py-6" data-alert-state="computing">集計中</div>';
      return;
    }
    if (ALERT.phase === 'error') {
      phaseEl.innerHTML = '<span style="color:#dc2626;font-weight:700;">集計失敗</span>';
      bodyEl.innerHTML = '<div class="p-3 rounded" style="background:#fee2e2;color:#991b1b;" data-alert-state="error">アラート者の集計に失敗しました: ' + esc(ALERT.error) +
        '<div class="text-xs mt-1">前回の結果は最新として表示していません。ファイルを確認して「再計算」を押してください。</div></div>';
      return;
    }
    if (ALERT.phase === 'no-data' || !snap) {
      bodyEl.innerHTML = '<div class="text-center text-ink-lighter py-6" data-alert-state="no-data">シフトデータ未投入</div>';
      return;
    }

    var stale = core.isStale(snap, currentTargetDate());
    phaseEl.innerHTML = stale
      ? '<span style="color:#b45309;font-weight:700;">⚠ 古い集計結果</span>'
      : ALERT.source === 'restored'
      ? '<span style="color:#4b5563;font-weight:700;">保存済み結果を表示</span>'
      : '<span style="color:#15803d;font-weight:700;">最新</span>';
    var conflictHtml = '';
    if (ALERT.saveState === 'conflict' && ALERT.conflict) {
      conflictHtml = '<div class="p-2 my-1 rounded" style="background:#fef3c7;color:#92400e;" data-alert-conflict="1">他の端末が ' + esc(fmtJst(ALERT.conflict.savedAt)) +
        ' に別の結果（対象日 ' + esc(ALERT.conflict.snapshot.targetDate) + '）を保存しています。この端末の結果は上書きしていません。' +
        ' <button id="rolling-alert-accept" class="px-2 py-0.5 rounded bg-gray-700 text-white">他端末の結果を表示</button>' +
        ' <button id="rolling-alert-overwrite" class="px-2 py-0.5 rounded bg-red-600 text-white">この端末の結果で上書き保存</button></div>';
    }
    metaEl.innerHTML =
      '対象日: <b>' + esc(snap.targetDate) + '</b>' +
      '　データ投入日時: <b>' + esc(fmtJst(snap.dataImportedAt)) + '</b>' +
      '　集計日時: <b>' + esc(fmtJst(snap.computedAt)) + '</b>' +
      (ALERT.serverSavedAt ? '　サーバー保存日時: <b>' + esc(fmtJst(ALERT.serverSavedAt)) + '</b>' : '') +
      (ALERT.saveState ? '<div>保存: ' + esc(SAVE_LABEL[ALERT.saveState] || '') + '</div>' : '') +
      (ALERT.localSaveState === 'error' ? '<div style="color:#b91c1c;">ブラウザ保存に失敗しました（容量超過・プライベートモード等）。再読み込みすると、サーバー保存がない場合は結果が消えます。</div>' : '') +
      (snap.sources && snap.sources.indexOf('Amazon Daily Working Hour') < 0 ? '<div style="color:#b45309;">Amazon実績が未投入の集計です。過去6日はシフト予定で判定しており、超過確定は出ません。</div>' : '') +
      conflictHtml +
      (stale ? '<div style="color:#b45309;">この結果は対象日 ' + esc(snap.targetDate) + ' の集計で、現在の基準日 ' + esc(currentTargetDate()) + ' とは異なります。「再計算」で更新してください。</div>' : '');
    var acceptBtn = document.getElementById('rolling-alert-accept');
    var overwriteBtn = document.getElementById('rolling-alert-overwrite');
    if (acceptBtn) acceptBtn.onclick = acceptServerResult;
    if (overwriteBtn) overwriteBtn.onclick = overwriteServerResult;

    var c = snap.counts || {};
    countsEl.innerHTML =
      '超過確定 <b>' + (c.exceed_confirmed || 0) + '</b>名 / 超過予測 <b>' + (c.exceed_forecast || 0) + '</b>名 / 接近警告 <b>' + (c.approach || 0) +
      '</b>名 / 勤務予定未確認 <b>' + (c.schedule_unconfirmed || 0) + '</b>名　（対象外: 判定不能 ' + (c.undetermined || 0) + '名 / 当日休で除外 ' + (c.day_off || 0) + '名 / 7日未満で対象外 ' + (c.skippedShortSeries || 0) + '名 / 全' + (c.driverCount || 0) + '名）';

    if (!snap.alerts.length) {
      bodyEl.innerHTML = '<div class="text-center text-ink-lighter py-6" data-alert-state="empty">該当者なし</div>';
      return;
    }
    var html = '<div class="rolling-grid-scroll" style="' + (stale ? 'opacity:.55;' : '') + '"><table class="text-xs" style="width:max-content;min-width:100%;border-collapse:collapse;" data-alert-state="list">' +
      '<thead><tr class="text-left text-ink-lighter border-b border-gray-700">' +
      ['対象者名', '対象日', 'アラート区分', '過去6日の勤務時間', '当日の勤務予定', 'ローリング7日合計', '60hまで', '判定根拠', 'データ更新日時']
        .map(function (h) { return '<th class="p-2 whitespace-nowrap">' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>';
    snap.alerts.forEach(function (a) { html += alertRowHtml(a, snap.dataImportedAt); });
    html += '</tbody></table></div>';
    bodyEl.innerHTML = html;
  }

  function renderSummary() {
    var totalDrivers = STATE.drivers.length;
    var rosterOnlyCount = 0,
      actualProgressCount = 0;
    STATE.drivers.forEach(function (d) {
      var hasRosterOnly = d.windows.some(function (w) {
        return w.riskType === 'roster_only';
      });
      var hasActualProgress = d.windows.some(function (w) {
        return w.riskType === 'actual_progress';
      });
      if (hasRosterOnly) rosterOnlyCount++;
      if (hasActualProgress) actualProgressCount++;
    });
    document.getElementById('rolling-total-drivers').textContent = totalDrivers;
    document.getElementById('rolling-roster-only-count').textContent = rosterOnlyCount;
    document.getElementById('rolling-actual-progress-count').textContent = actualProgressCount;

    var undefinedCodes = Object.keys(STATE.diagnostics.undefinedCodeCounts);
    document.getElementById('rolling-undefined-count').textContent = undefinedCodes.length;
    var detailEl = document.getElementById('rolling-undefined-detail');
    if (undefinedCodes.length > 0) {
      var parts = undefinedCodes
        .sort(function (a, b) {
          return STATE.diagnostics.undefinedCodeCounts[b] - STATE.diagnostics.undefinedCodeCounts[a];
        })
        .map(function (c) {
          return c + '（' + STATE.diagnostics.undefinedCodeCounts[c] + '件）';
        });
      detailEl.innerHTML =
        '⚠ 時間未確定の勤務記号があります。その日を含む7日間は判定不能です。推測の時間では計算していません: ' +
        parts.join(' / ');
    } else {
      detailEl.textContent = '';
    }

    // 重複日付の警告（同一Transport ID・同一日付が複数のシフトファイルに存在した場合）
    var dupEl = document.getElementById('rolling-duplicate-detail');
    var dups = STATE.diagnostics.rosterDuplicates || [];
    if (dups.length > 0) {
      var dupParts = dups.slice(0, 20).map(function (d) {
        return d.driverName + ' ' + d.date + '（採用: ' + d.keptLabel + '=' + d.keptRawCode + ' ／ 破棄: ' + d.discardedLabel + '=' + d.discardedRawCode + '）';
      });
      dupEl.innerHTML = '⚠ 同一日付が複数のシフトファイルに重複していました（' + dups.length + '件、二重加算はしていません。後から読み込んだファイルを採用）: <br>' + dupParts.join('<br>');
    } else {
      dupEl.textContent = '';
    }

    // 判定対象期間・読込済みシフト月・月端データ不足の表示
    var periodEl = document.getElementById('rolling-period-detail');
    var periodLines = [];
    var ranges = STATE.rosterSourceRanges || {};
    Object.keys(ranges).forEach(function (label) {
      periodLines.push('読込済みシフト: ' + label + '（' + ranges[label].min + '〜' + ranges[label].max + '）');
    });
    if (STATE.amazonDateRange) {
      periodLines.push('読込済みAmazon実績: ' + STATE.amazonDateRange.min + '〜' + STATE.amazonDateRange.max);
    }
    var incompleteCount = 0;
    STATE.drivers.forEach(function (d) {
      incompleteCount += d.windows.filter(function (w) { return !w.complete; }).length;
    });
    if (incompleteCount > 0) {
      periodLines.push('判定不能（7日分が揃っていない窓）: ' + incompleteCount + '件');
    }
    if (STATE.dryRun) {
      var exceedN = 0;
      var approachN = 0;
      var ongoingN = 0;
      (STATE.dryRun.alerts || []).forEach(function (alert) {
        if (alert.status === 'ONGOING') ongoingN++;
        if (alert.level === 'exceed') exceedN++;
        else if (alert.level === 'approach') approachN++;
      });
      periodLines.push('INO-1 dry-run（未送信） 超過 ' + exceedN + ' / 接近 ' + approachN + ' / 継続 ' + ongoingN + ' / 判定不能 ' + (STATE.dryRun.undetermined || []).length);
    }
    periodEl.innerHTML = periodLines.join('<br>');
  }

  function renderGrid() {
    var wrap = document.getElementById('rolling-grid-wrap');
    if (STATE.drivers.length === 0) {
      wrap.innerHTML = '<div id="rolling-grid-empty" class="text-center text-ink-lighter py-8">月間シフト表とAmazon実績を読み込んでください</div>';
      return;
    }

    // 全ドライバー通しての日付範囲を求める
    var allMin = STATE.drivers.reduce(function (m, d) {
      return !m || d.minDate < m ? d.minDate : m;
    }, null);
    var allMax = STATE.drivers.reduce(function (m, d) {
      return !m || d.maxDate > m ? d.maxDate : m;
    }, null);
    var RollingCore = global.RollingCore;
    var dateList = [];
    var cursor = allMin;
    while (true) {
      dateList.push(cursor);
      if (cursor === allMax) break;
      cursor = RollingCore.addDays(cursor, 1);
    }

    var html = '<table class="rolling-grid-table text-xs">';
    html += '<thead><tr class="text-left text-ink-lighter border-b border-gray-700">';
    html += '<th class="p-2 rolling-name-col" style="min-width:140px;">ドライバー</th>';
    dateList.forEach(function (d) {
      html += '<th class="p-1 text-center" style="min-width:34px;">' + d.slice(5).replace('-', '/') + '</th>';
    });
    html += '</tr></thead><tbody>';

    STATE.drivers.forEach(function (driver) {
      var dayByDate = {};
      driver.series.forEach(function (d) {
        dayByDate[d.date] = d;
      });
      // 日付 -> このドライバーで、その日を含む超過(over)ウィンドウのリスト
      var windowsByDate = {};
      driver.windows.forEach(function (w, idx) {
        if (!w.over && !w.warning) return;
        var d = w.startDate;
        while (true) {
          (windowsByDate[d] = windowsByDate[d] || []).push(idx);
          if (d === w.endDate) break;
          d = RollingCore.addDays(d, 1);
        }
      });
      var overWindowCount = driver.windows.filter(function (w) {
        return w.over;
      }).length;
      var incompleteWindowCount = driver.windows.filter(function (w) {
        return !w.complete;
      }).length;

      var nameTitle = driver.meta.name;
      if (overWindowCount > 0) nameTitle += ' (超過期間' + overWindowCount + '件)';
      if (incompleteWindowCount > 0) nameTitle += ' (判定対象外' + incompleteWindowCount + '件)';
      html += '<tr class="border-b border-gray-800">';
      html += '<td class="p-2 rolling-name-col font-medium" title="' + escapeAttr(nameTitle) + '">' + driver.meta.name +
        (overWindowCount > 0 ? ' <span class="text-red-400 text-[10px]">(超過期間' + overWindowCount + '件)</span>' : '') +
        (incompleteWindowCount > 0 ? ' <span class="text-gray-400 text-[10px]" title="隣接月データ不足のため判定対象外">(判定対象外' + incompleteWindowCount + '件)</span>' : '') +
        '</td>';

      dateList.forEach(function (date) {
        var dayRec = dayByDate[date];
        var cellText = '-';
        var cellCls = 'p-1 text-center';
        if (dayRec) {
          if (dayRec.noData) {
            cellText = '';
          } else if (dayRec.blocks.length === 0) {
            cellText = '休';
            cellCls += ' text-gray-500';
          } else {
            cellText = dayRec.blocks
              .map(function (b) {
                return b.code === 'AMAZON_ACTUAL' ? '(実)' + b.hours.toFixed(1) : b.rawCode;
              })
              .join('+');
            if (dayRec.blocks.some(function (b) { return b.source === 'actual'; })) cellCls += ' text-blue-500';
            if (dayRec.hasUndefinedHours) cellCls += ' bg-gray-700 text-gray-300';
          }
        }
        var touchingWindows = windowsByDate[date] || [];
        if (touchingWindows.length > 0) {
          var worst = touchingWindows
            .map(function (i) {
              return driver.windows[i];
            })
            .sort(function (a, b) {
              // roster_only(赤) > actual_progress(橙) > warning(黄) の優先度で見た目を決める
              function rank(w) {
                if (w.riskType === 'roster_only') return 3;
                if (w.riskType === 'actual_progress') return 2;
                if (w.warning) return 1;
                return 0;
              }
              return rank(b) - rank(a);
            })[0];
          var color = worst.riskType === 'roster_only' ? '#ef4444' : worst.riskType === 'actual_progress' ? '#f97316' : '#eab308';
          cellCls += ' cursor-pointer';
          var borderStyle = 'box-shadow: inset 0 0 0 2px ' + color + ';';
          html +=
            '<td class="' + cellCls + '" style="' + borderStyle + '" data-driver-key="' + escapeAttr(driver.key) + '" data-date="' + date + '">' +
            cellText +
            '</td>';
        } else {
          html += '<td class="' + cellCls + '">' + cellText + '</td>';
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    // クリックで詳細モーダル（イベント委譲）
    wrap.onclick = function (e) {
      var td = e.target.closest('td[data-driver-key]');
      if (!td) return;
      showDetailModal(td.getAttribute('data-driver-key'), td.getAttribute('data-date'));
    };
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  function showDetailModal(driverKey, date) {
    var driver = STATE.drivers.filter(function (d) {
      return d.key === driverKey;
    })[0];
    if (!driver) return;
    var RollingCore = global.RollingCore;
    var touching = driver.windows.filter(function (w) {
      return date >= w.startDate && date <= w.endDate && (w.over || w.warning);
    });
    if (touching.length === 0) return;

    var body = document.getElementById('rolling-detail-modal-body');
    var html = '<div class="flex justify-between items-center mb-3">' +
      '<h3 class="font-bold text-base">' + driver.meta.name + ' さんの超過期間（' + touching.length + '件）</h3>' +
      '<button onclick="RollingUI.closeModal()" class="text-gray-500 hover:text-gray-800">✕</button></div>';

    touching.forEach(function (w) {
      var riskLabel =
        w.riskType === 'roster_only'
          ? '🔴 シフト予定だけで超過見込み（roster_only）'
          : w.riskType === 'actual_progress'
          ? '🟠 実績が予定より伸びたことによる超過リスク（actual_progress）'
          : '🟡 警戒ライン到達（超過ではありません）';
      var comment;
      if (w.riskType === 'roster_only') {
        comment =
          '登録済みシフトの予定だけで、' + w.endDate + '時点で' + w.overBy.toFixed(1) + '時間超過する見込みです。' +
          '勤務記号の変更や休暇への変更を検討してください。';
      } else if (w.riskType === 'actual_progress') {
        comment =
          '当初のシフト予定では60時間以内でしたが、Amazon実績が予定より長くなったため、' +
          '実績＋今後の予定では' + w.endDate + '時点で' + w.overBy.toFixed(1) + '時間超過する見込みです。' +
          '残りの勤務時間短縮や勤務記号変更を検討してください。';
      } else {
        comment = '正式な超過（>' + w.limitHours + 'h）ではありませんが、警戒ライン(' + w.warningHours + 'h)に達しています。';
      }
      html +=
        '<div class="border rounded-lg p-3 mb-3" style="border-color:' + (w.riskType === 'roster_only' ? '#ef4444' : w.riskType === 'actual_progress' ? '#f97316' : '#eab308') + '">' +
        '<div class="text-sm font-bold mb-1">対象期間：' + w.startDate + ' 〜 ' + w.endDate + '</div>' +
        '<div class="text-xs mb-2">' + riskLabel + '</div>' +
        '<div class="text-sm mb-1">Rolling合計：<b>' + fmtHours(w.totalHours) + '</b>　上限：' + fmtHours(w.limitHours) + (w.over ? '　超過：<b class="text-red-500">+' + w.overBy.toFixed(1) + 'h</b>' : '') + '</div>' +
        '<div class="text-xs text-ink-lighter mb-1">実績：' + fmtHours(w.actualHours) + '　／　予定：' + fmtHours(w.rosterHours) + '</div>' +
        (w.rosterOnlyTotalHours !== null ? '<div class="text-xs text-ink-lighter mb-2">（参考）予定のみの場合の合計：' + fmtHours(w.rosterOnlyTotalHours) + '</div>' : '') +
        (w.undefinedDates.length > 0 ? '<div class="text-xs text-gray-500 mb-2">⚠ この期間には時間未定義の勤務記号が含まれています（' + w.undefinedDates.join(', ') + '）。実際の合計はこれより多い可能性があります。</div>' : '') +
        '<div class="text-sm bg-gray-50 rounded p-2">' + comment + '</div>' +
        '</div>';
    });

    body.innerHTML = html;
    document.getElementById('rolling-detail-modal').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('rolling-detail-modal').classList.add('hidden');
  }

  // ===========================================================================
  // Public API
  // ===========================================================================
  var RollingUI = {
    onShown: function () {
      ensureRendered();
      if (STATE.rosterSources.length > 0 || STATE.amazonRows) {
        recomputeAndRender();
      }
    },
    closeModal: closeModal,
    _alertState: ALERT, // テスト用: 画面の状態確認
  };

  global.RollingUI = RollingUI;
})(typeof window !== 'undefined' ? window : this);
