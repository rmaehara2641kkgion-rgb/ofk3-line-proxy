/**
 * 既存のルート記号だけからサイクルを決める。
 * phase1-core の DCX=C1 / DMX=C2 / DSX=C3 と同じ対応。
 * シフト記号、開始時刻、氏名では決めない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MentorStartupCycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PREFIX = { DCX: '1', DMX: '2', DSX: '3' };
  var NO_ASSIGNMENT = 'アサインなし';
  var UNKNOWN_PREFIX = 'ルート記号からサイクルを特定できない';
  var MIXED = '複数サイクル';
  var NO_FIELD = 'スケジュールの予約にサイクル項目がない';

  function cycleFromRouteCode(routeCode) {
    var match = String(routeCode || '').toUpperCase().match(/^([A-Z]+)/);
    if (!match) return '';
    return PREFIX[match[1]] || '';
  }

  function cycleForRoutes(routeCodes) {
    var found = Object.create(null);
    var unknown = false;
    var any = false;
    (routeCodes || []).forEach(function (routeCode) {
      if (!routeCode) return;
      any = true;
      var cycle = cycleFromRouteCode(routeCode);
      if (!cycle) unknown = true;
      else found[cycle] = true;
    });
    var cycles = Object.keys(found);
    if (!any) return { cycle: null, reason: NO_ASSIGNMENT };
    if (cycles.length > 1) return { cycle: null, reason: MIXED };
    if (unknown || cycles.length !== 1) return { cycle: null, reason: UNKNOWN_PREFIX };
    return { cycle: cycles[0], reason: '' };
  }

  function routesByTransportId(assignments) {
    var byId = Object.create(null);
    (Array.isArray(assignments) ? assignments : []).forEach(function (row) {
      if (!row || typeof row.transportId !== 'string') return;
      var id = row.transportId.trim();
      if (!id || typeof row.routeCode !== 'string' || !row.routeCode.trim()) return;
      if (!byId[id]) byId[id] = [];
      byId[id].push(row.routeCode.trim());
    });
    return byId;
  }

  return {
    NO_ASSIGNMENT: NO_ASSIGNMENT,
    UNKNOWN_PREFIX: UNKNOWN_PREFIX,
    MIXED: MIXED,
    NO_FIELD: NO_FIELD,
    cycleFromRouteCode: cycleFromRouteCode,
    cycleForRoutes: cycleForRoutes,
    routesByTransportId: routesByTransportId
  };
});
