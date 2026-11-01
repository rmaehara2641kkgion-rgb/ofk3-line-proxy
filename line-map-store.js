/**
 * LINE MAP用 割当ストア。管理画面から同期された最小データのみ保持する:
 *   date, cycle(ルート接頭辞から導出), routeCode, driverId(安定ID), lineUserId(DAと1対1)
 * 検証に失敗した同期は全体を拒否 (部分適用しない)。ファイルへ永続化し再起動後に復元する。
 */
'use strict';
var fs = require('fs');
var path = require('path');

var CYCLE_BY_PREFIX = { DCX: 'C1', DMX: 'C2', DSX: 'C3' }; // manual-assign-board-core.js と同一
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var LINE_ID_RE = /^U[0-9a-f]{32}$/i;
var MAX_ROWS = 2000;
var KEEP_DATES = 3;

function cycleOfRoute(routeCode) {
  var m = /^([A-Z]{3})/.exec(String(routeCode || '').toUpperCase());
  return m && CYCLE_BY_PREFIX[m[1]] ? CYCLE_BY_PREFIX[m[1]] : null;
}

function validateSync(input, todayJst) {
  var errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['body'] };
  if (!DATE_RE.test(String(input.date || ''))) errors.push('date');
  else if (todayJst) {
    var diff = Math.abs(Date.parse(input.date + 'T00:00:00Z') - Date.parse(todayJst + 'T00:00:00Z')) / 86400000;
    if (diff > 1) errors.push('date-out-of-range');
  }
  if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > MAX_ROWS) errors.push('rows');
  if (errors.length) return { ok: false, errors: errors };

  var rows = [], routeOwner = {}, driverCycleRoute = {};
  input.rows.forEach(function (r, i) {
    var routeCode = String(r && r.routeCode || '').trim().toUpperCase();
    var driverId = String(r && r.driverId || '').trim();
    var cycle = cycleOfRoute(routeCode);
    if (!routeCode || !driverId) { errors.push('row' + i + ':missing'); return; }
    if (!cycle) { errors.push('row' + i + ':unknown-route-prefix'); return; }
    if (r.cycle && String(r.cycle).toUpperCase() !== cycle) { errors.push('row' + i + ':cycle-mismatch'); return; }
    if (routeOwner[routeCode] && routeOwner[routeCode] !== driverId) { errors.push('row' + i + ':route-multi-driver'); return; }
    var dk = driverId + '|' + cycle;
    if (driverCycleRoute[dk] && driverCycleRoute[dk] !== routeCode) { errors.push('row' + i + ':driver-multi-route'); return; }
    routeOwner[routeCode] = driverId; driverCycleRoute[dk] = routeCode;
    rows.push({ date: input.date, cycle: cycle, routeCode: routeCode, driverId: driverId });
  });

  var links = [], byLine = {}, byDriver = {};
  (Array.isArray(input.links) ? input.links : []).forEach(function (l, i) {
    var driverId = String(l && l.driverId || '').trim();
    var lineUserId = String(l && l.lineUserId || '').trim();
    if (!driverId || !LINE_ID_RE.test(lineUserId)) { errors.push('link' + i + ':invalid'); return; }
    if ((byLine[lineUserId] && byLine[lineUserId] !== driverId) || (byDriver[driverId] && byDriver[driverId] !== lineUserId)) {
      errors.push('link' + i + ':conflict'); return;
    }
    byLine[lineUserId] = driverId; byDriver[driverId] = lineUserId;
    links.push({ driverId: driverId, lineUserId: lineUserId });
  });
  if (errors.length) return { ok: false, errors: errors };
  return { ok: true, date: input.date, rows: rows, links: links };
}

function createAssignmentStore(opts) {
  opts = opts || {};
  var filePath = opts.filePath || null;
  var backend = opts.backend || null; // 任意: 再デプロイ後も残る外部ストア (GAS)
  var data = {}; // date -> { rows, links, syncedAt }
  var restored = !backend; // 外部ストア使用時は init() 成功まで「未復元」
  var lastAttempt = 0;

  function load() {
    if (!filePath) return;
    try {
      var j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (j && typeof j === 'object') data = j.assignments || {};
    } catch (e) { data = {}; }
  }
  function persist() {
    if (!filePath) return true;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      var tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ assignments: data }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, filePath);
      return true;
    } catch (e) { return false; }
  }
  load();

  async function restore() {
    lastAttempt = Date.now();
    try {
      var remote = await backend.load();
      // 起動後に同期済みの日付(メモリ)を優先し、無い日付だけ外部ストアから補う
      Object.keys(remote).forEach(function (d) { if (!data[d] && remote[d] && Array.isArray(remote[d].rows)) data[d] = remote[d]; });
      restored = true;
    } catch (e) { restored = false; }
    return restored;
  }

  return {
    init: function () { return backend ? restore() : Promise.resolve(true); },
    // 未復元なら30秒間隔で再試行
    ensureRestored: async function () {
      if (restored || !backend) return restored;
      if (Date.now() - lastAttempt < 30000) return false;
      return restore();
    },
    isRestored: function () { return restored; },
    // 外部ストアへ書き戻す。失敗してもメモリ/ファイルの内容は有効 (呼び出し側へ結果のみ返す)。
    flush: async function () {
      if (!backend) return 'none';
      if (!restored) return 'skipped-unrestored'; // 部分データで外部ストアを上書きしない
      try { await backend.save(data); return 'ok'; } catch (e) { return 'failed'; }
    },
    sync: function (input, todayJst) {
      var v = validateSync(input, todayJst);
      if (!v.ok) return v;
      data[v.date] = { rows: v.rows, links: v.links, syncedAt: new Date().toISOString() };
      Object.keys(data).sort().slice(0, Math.max(0, Object.keys(data).length - KEEP_DATES)).forEach(function (d) { delete data[d]; });
      return { ok: true, date: v.date, rowCount: v.rows.length, linkCount: v.links.length, persisted: persist() };
    },
    assignmentsFor: function (date) { return data[date] ? data[date].rows.slice() : []; },
    linkedMapFor: function (date) {
      var m = {};
      if (data[date]) data[date].links.forEach(function (l) { m[l.lineUserId] = l.driverId; });
      return m;
    },
    linkFor: function (date, driverId) {
      var l = data[date] && data[date].links.filter(function (x) { return x.driverId === driverId; })[0];
      return l ? l.lineUserId : null;
    },
    hasDate: function (date) { return !!data[date]; }
  };
}

module.exports = { createAssignmentStore: createAssignmentStore, validateSync: validateSync, cycleOfRoute: cycleOfRoute };
