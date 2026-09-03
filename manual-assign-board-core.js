/**
 * OFK3 MANUAL ASSIGN BOARD — Amazon Cortex手動アサイン補助（コアロジック、UI非依存）
 *
 * 目的: RouteごとのDA番号をCortexへ貼り付け可能な改行区切りテキストとして
 * コピーできるようにする。Cortexの自動操作は一切行わない
 * （Clipboardへのコピーまでが本モジュールの責務）。
 *
 * マニフェスト（sequencedRoute_* シート）の走査・DA番号抽出そのものは
 * 既存の assign-support-core.js の parseManifestWorkbook() を再利用する
 * （同等の実装を独立して複数箇所に増やさない）。本モジュールは
 * parseManifestWorkbook() の出力（routeCode/daNumbers 等）を受け取り、
 * Cycle分類・自然順ソート・表示用グルーピングだけを行う。
 *
 * 右ペイン（AMAZON NAME）は、シフト表（点呼表シート）から選択中Cycleで
 * 稼働するAmazon Name一覧を抽出する。Route→Amazon Nameの自動紐付けは
 * 行わない（左右のペインは独立。組み合わせは人間が判断する）。
 * Cycle判定は既存の assign-support-core.js のシフト記号→Cycle定義
 * （filterWorkersByCycleEligibility 等）を再利用し、新しい対応表は
 * 定義しない。
 */
(function (global) {
  'use strict';

  // ===== Routeコードの prefix / 連番分解（自然順ソート・Cycle分類の共通処理） =====
  function splitRoutePrefixNumber(routeCode) {
    var s = String(routeCode || '');
    var m = s.match(/^([A-Za-z]+)(\d+)$/);
    if (!m) return { prefix: s, num: NaN };
    return { prefix: m[1], num: parseInt(m[2], 10) };
  }

  // ===== Cycle分類（既知prefixのみ。未知prefixはエラーにせず空文字＝分類不能として扱う） =====
  var CYCLE_PREFIX_MAP = { DCX: 'C1', DMX: 'C2', DSX: 'C3' };
  function classifyCycle(routeCode) {
    var prefix = splitRoutePrefixNumber(routeCode).prefix;
    return CYCLE_PREFIX_MAP[prefix] || '';
  }

  // ===== Route自然順ソート（DSX1, DSX2, ..., DSX10, DSX11 の順） =====
  function naturalRouteCompare(a, b) {
    var pa = splitRoutePrefixNumber(a);
    var pb = splitRoutePrefixNumber(b);
    if (pa.prefix !== pb.prefix) return pa.prefix < pb.prefix ? -1 : (pa.prefix > pb.prefix ? 1 : 0);
    if (isNaN(pa.num) || isNaN(pb.num)) return String(a).localeCompare(String(b));
    return pa.num - pb.num;
  }

  // ===== assign-support-core.js#parseManifestWorkbook() の出力を
  //       MANUAL ASSIGN BOARD表示用に変換 =====
  // manifestRoutes: [{routeCode, packages, stops, areas, daNumbers}, ...]
  // （マニフェストのシート走査・DA列抽出は行わない。既存実装の結果をそのまま使う）
  function buildBoardRoutesFromManifestRoutes(manifestRoutes) {
    var routes = [];
    for (var i = 0; i < (manifestRoutes || []).length; i++) {
      var r = manifestRoutes[i];
      if (!r || !r.routeCode) continue;
      var daNumbers = r.daNumbers || [];
      routes.push({
        routeCode: r.routeCode,
        cycle: classifyCycle(r.routeCode),
        count: daNumbers.length,
        daNumbers: daNumbers
      });
    }
    routes.sort(function (a, b) { return naturalRouteCompare(a.routeCode, b.routeCode); });
    return routes;
  }

  // ===== 表示用グルーピング（C1/C2/C3を優先、未知prefixはprefix名でグループ化） =====
  function groupRoutesByCycle(routes) {
    var groups = {};
    var order = [];
    for (var i = 0; i < (routes || []).length; i++) {
      var r = routes[i];
      var key = r.cycle || splitRoutePrefixNumber(r.routeCode).prefix || '?';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(r);
    }
    var priority = { C1: 0, C2: 1, C3: 2 };
    order.sort(function (a, b) {
      var pa = Object.prototype.hasOwnProperty.call(priority, a) ? priority[a] : 100;
      var pb = Object.prototype.hasOwnProperty.call(priority, b) ? priority[b] : 100;
      if (pa !== pb) return pa - pb;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return order.map(function (key) { return { key: key, routes: groups[key] }; });
  }

  // ===== Clipboard用テキスト整形（改行区切り。Cortexへそのままペースト可能） =====
  function formatDaListForClipboard(daNumbers) {
    return (daNumbers || []).join('\n');
  }

  // =====================================================================
  // AMAZON NAME（右ペイン）: シフト表（点呼表）解析
  //
  // 対象は「点呼表」という名前のシート（実データで確認済み: 名前/勤務コース/
  // Roman/Transport ID の4列を持つ1日分の点呼一覧）。列位置は固定しない。
  // ヘッダーテキストから動的に検出する。同名ヘッダーが複数存在する場合
  // （乗務前/乗務後の2ブロック構成）は左側＝最初に見つかった方を採用する
  // （乗務前後で対象者は同一人物のため、値も一致することを実データで確認済み）。
  //
  // Cycle判定は既存の assign-support-core.js のシフト記号→Cycle定義
  // （normalizeAssignShiftToken / isShiftEligibleForCycle /
  // filterWorkersByCycleEligibility）をそのまま再利用する。新しい
  // シフト記号→Cycle対応表はここでは定義しない。
  // =====================================================================

  // ===== シート名が点呼表（シフト表）かどうか =====
  function isTenkoRosterSheetName(sheetName) {
    return /^点呼表/.test(String(sheetName || '').trim());
  }

  // ===== 点呼表シートのタイトルセルから対象日を抽出（例: "2026/9/3" → "2026-09-03"） =====
  // 見つからない場合は空文字（＝日付不明。UI側はユーザー選択に委ねる）。
  function extractShiftDateLabel(rows) {
    for (var r = 0; r < Math.min((rows || []).length, 3); r++) {
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) {
        var v = String(row[c] == null ? '' : row[c]).trim();
        var m = v.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
        if (m) return m[1] + '-' + (m[2].length < 2 ? '0' : '') + m[2] + '-' + (m[3].length < 2 ? '0' : '') + m[3];
      }
    }
    return '';
  }

  // ===== 点呼表1シート分の行 → 稼働者一覧（TransportID / 表示名 / Amazon Name / 勤務コード） =====
  // 休み・勤務コード未記入の行、TransportID未記入行、ヘッダー残骸行は除外する。
  // Amazon Name（Roman列）が空の場合は amazonName: '' のまま返す（未解決として扱う。
  // ここで推測補完はしない）。
  function parseTenkoRosterRows(rows) {
    var headerRowIdx = -1, nameIdx = -1, courseIdx = -1, romanIdx = -1, tidIdx = -1;
    var limit = Math.min((rows || []).length, 20);
    for (var r = 0; r < limit; r++) {
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) {
        var v = String(row[c] == null ? '' : row[c]).trim();
        if (nameIdx < 0 && v.indexOf('名前') >= 0) { nameIdx = c; headerRowIdx = r; }
        if (courseIdx < 0 && v === '勤務コース') { courseIdx = c; headerRowIdx = r; }
        if (romanIdx < 0 && /^Roman/i.test(v)) { romanIdx = c; headerRowIdx = r; }
        if (tidIdx < 0 && /Transport\s*ID/i.test(v)) { tidIdx = c; headerRowIdx = r; }
      }
      if (nameIdx >= 0 && courseIdx >= 0 && romanIdx >= 0 && tidIdx >= 0) break;
    }
    if (courseIdx < 0 || romanIdx < 0 || tidIdx < 0) {
      return { entries: [], count: 0, duplicateCount: 0, error: 'columns_not_found' };
    }

    var entries = [];
    var seenTid = {};
    var duplicateCount = 0;
    for (var i = headerRowIdx + 1; i < (rows || []).length; i++) {
      var row2 = rows[i];
      if (!row2) continue;
      var tid = String(row2[tidIdx] == null ? '' : row2[tidIdx]).trim();
      // '0' は実データで確認済みのロースター末尾ダミー行
      if (!tid || tid === '0' || tid === 'Transport ID') continue;
      var shiftCode = String(row2[courseIdx] == null ? '' : row2[courseIdx]).trim();
      if (!shiftCode) continue; // 休み/勤務コード未記入 = 非稼働として除外
      if (seenTid[tid]) { duplicateCount++; continue; } // 重複TransportIDは最初の行のみ採用
      seenTid[tid] = true;
      entries.push({
        transportId: tid,
        name: nameIdx >= 0 ? String(row2[nameIdx] == null ? '' : row2[nameIdx]).trim() : '',
        amazonName: String(row2[romanIdx] == null ? '' : row2[romanIdx]).trim(),
        shiftCode: shiftCode
      });
    }
    return { entries: entries, count: entries.length, duplicateCount: duplicateCount, headerRowIdx: headerRowIdx };
  }

  // ===== マニフェストworkbook全体から点呼表シートを全て抽出 =====
  // 複数シフト日（複数の点呼表シート）が存在する場合、全て返す（UI側で選択させる）。
  function parseTenkoRosterWorkbook(workbook, XLSXLib) {
    var sheets = [];
    if (!workbook || !workbook.SheetNames || !XLSXLib) return sheets;
    for (var si = 0; si < workbook.SheetNames.length; si++) {
      var sheetName = workbook.SheetNames[si];
      if (!isTenkoRosterSheetName(sheetName)) continue;
      var rows = XLSXLib.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
      var parsed = parseTenkoRosterRows(rows);
      sheets.push({
        sheetName: sheetName,
        dateLabel: extractShiftDateLabel(rows),
        entries: parsed.entries,
        count: parsed.count,
        duplicateCount: parsed.duplicateCount,
        error: parsed.error || ''
      });
    }
    return sheets;
  }

  // ===== 選択中CycleタブのCycle対象者一覧（Amazon Name含む）を構築 =====
  // filterWorkersByCycleEligibilityFn は呼び出し側が注入する
  // assign-support-core.js#filterWorkersByCycleEligibility（本モジュールは
  // AssignSupportCoreに依存しない。シフト記号→Cycle定義を再定義しない）。
  // Route側で分類不能（未知prefix, cycleKeyがC1/C2/C3以外）の場合は
  // cycleClassified:false を返し、対象者一覧は作らない（勝手に分類しない）。
  function buildAmazonNameRosterForCycle(entries, cycleKey, filterWorkersByCycleEligibilityFn) {
    var cycleNum = { C1: 1, C2: 2, C3: 3 }[cycleKey];
    if (!cycleNum || typeof filterWorkersByCycleEligibilityFn !== 'function') {
      return { roster: [], cycleClassified: false, stats: null };
    }
    var result = filterWorkersByCycleEligibilityFn(entries || [], cycleNum);
    var roster = (result.eligible || []).map(function (w) {
      return {
        transportId: w.transportId,
        name: w.name,
        amazonName: w.amazonName || '',
        resolved: !!w.amazonName,
        shiftCode: w.shiftCode
      };
    });
    roster.sort(function (a, b) {
      var an = a.amazonName || a.name || '';
      var bn = b.amazonName || b.name || '';
      return an.localeCompare(bn, 'ja');
    });
    return { roster: roster, cycleClassified: true, stats: result.stats };
  }

  var ManualAssignBoardCore = {
    splitRoutePrefixNumber: splitRoutePrefixNumber,
    classifyCycle: classifyCycle,
    naturalRouteCompare: naturalRouteCompare,
    buildBoardRoutesFromManifestRoutes: buildBoardRoutesFromManifestRoutes,
    groupRoutesByCycle: groupRoutesByCycle,
    formatDaListForClipboard: formatDaListForClipboard,
    isTenkoRosterSheetName: isTenkoRosterSheetName,
    extractShiftDateLabel: extractShiftDateLabel,
    parseTenkoRosterRows: parseTenkoRosterRows,
    parseTenkoRosterWorkbook: parseTenkoRosterWorkbook,
    buildAmazonNameRosterForCycle: buildAmazonNameRosterForCycle
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ManualAssignBoardCore;
  }
  global.ManualAssignBoardCore = ManualAssignBoardCore;
})(typeof window !== 'undefined' ? window : global);
