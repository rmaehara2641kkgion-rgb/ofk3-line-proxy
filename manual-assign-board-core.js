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
 * Amazon Name（Route→担当者の紐付け）はv1では扱わない。
 * シフト表の構造確認後に別途対応する。
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

  var ManualAssignBoardCore = {
    splitRoutePrefixNumber: splitRoutePrefixNumber,
    classifyCycle: classifyCycle,
    naturalRouteCompare: naturalRouteCompare,
    buildBoardRoutesFromManifestRoutes: buildBoardRoutesFromManifestRoutes,
    groupRoutesByCycle: groupRoutesByCycle,
    formatDaListForClipboard: formatDaListForClipboard
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ManualAssignBoardCore;
  }
  global.ManualAssignBoardCore = ManualAssignBoardCore;
})(typeof window !== 'undefined' ? window : global);
