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
    if (!ROUTE_RE.test(routeCode) || !DRIVER_RE.test(driverId)) { errors.push('row' + i + ':bad-id'); return; }
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


// ---- 保存データ(外部ストア/ファイル)のスキーマ検証と整合性 ----
var ROUTE_RE = /^[A-Z0-9_./-]{1,32}$/;
var DRIVER_RE = /^[^\s\u0000-\u001f]{1,64}$/;
var MAX_STORED_DATES = KEEP_DATES + 2;

function onlyKeys(o, keys) {
  return o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; });
}
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(v[k]); }).join(',') + '}';
  return JSON.stringify(v);
}
function checksumOf(data) { return require('crypto').createHash('sha256').update(canonicalJson(data)).digest('hex'); }

// 厳密な許可リスト方式: 想定外のキー(住所・座標・荷物情報・トークン等)が1つでもあれば全体を拒否する。
function validateStoredState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'not-object' };
  var dates = Object.keys(data);
  if (dates.length > MAX_STORED_DATES) return { ok: false, reason: 'too-many-dates' };
  for (var d = 0; d < dates.length; d++) {
    var date = dates[d], e = data[date];
    if (!DATE_RE.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) return { ok: false, reason: 'bad-date' };
    if (!onlyKeys(e, ['rows', 'links', 'syncedAt']) || !Array.isArray(e.rows) || !Array.isArray(e.links)) return { ok: false, reason: 'bad-entry' };
    if (typeof e.syncedAt !== 'string' || isNaN(Date.parse(e.syncedAt))) return { ok: false, reason: 'bad-syncedAt' };
    if (e.rows.length > MAX_ROWS || e.links.length > MAX_ROWS) return { ok: false, reason: 'too-many-rows' };
    var routeOwner = {}, driverCycle = {}, byLine = {}, byDriver = {};
    for (var i = 0; i < e.rows.length; i++) {
      var r = e.rows[i];
      if (!onlyKeys(r, ['date', 'cycle', 'routeCode', 'driverId']) || r.date !== date) return { ok: false, reason: 'bad-row' };
      if (typeof r.routeCode !== 'string' || !ROUTE_RE.test(r.routeCode) || typeof r.driverId !== 'string' || !DRIVER_RE.test(r.driverId)) return { ok: false, reason: 'bad-row' };
      if (cycleOfRoute(r.routeCode) !== r.cycle) return { ok: false, reason: 'cycle-mismatch' };
      if (routeOwner[r.routeCode] && routeOwner[r.routeCode] !== r.driverId) return { ok: false, reason: 'route-multi-driver' };
      var dk = r.driverId + '|' + r.cycle;
      if (driverCycle[dk] && driverCycle[dk] !== r.routeCode) return { ok: false, reason: 'driver-multi-route' };
      routeOwner[r.routeCode] = r.driverId; driverCycle[dk] = r.routeCode;
    }
    for (var k = 0; k < e.links.length; k++) {
      var l = e.links[k];
      if (!onlyKeys(l, ['driverId', 'lineUserId']) || typeof l.driverId !== 'string' || !DRIVER_RE.test(l.driverId) || typeof l.lineUserId !== 'string' || !LINE_ID_RE.test(l.lineUserId)) return { ok: false, reason: 'bad-link' };
      if ((byLine[l.lineUserId] && byLine[l.lineUserId] !== l.driverId) || (byDriver[l.driverId] && byDriver[l.driverId] !== l.lineUserId)) return { ok: false, reason: 'link-conflict' };
      byLine[l.lineUserId] = l.driverId; byDriver[l.driverId] = l.lineUserId;
    }
  }
  return { ok: true };
}
function verifyEnvelope(env) {
  if (!env || typeof env !== 'object' || env.v !== 1 || !Number.isInteger(env.seq) || env.seq < 0 || typeof env.checksum !== 'string' || !env.data) return { ok: false, reason: 'bad-envelope' };
  if (checksumOf(env.data) !== env.checksum) return { ok: false, reason: 'checksum-mismatch' }; // 欠落・改ざん・部分データ
  var v = validateStoredState(env.data);
  return v.ok ? { ok: true, data: env.data } : { ok: false, reason: v.reason };
}

function createAssignmentStore(opts) {
  opts = opts || {};
  var filePath = opts.filePath || null;
  var backend = opts.backend || null; // 任意: 再デプロイ後も残る外部ストア (GAS)
  var clock = opts.clock || Date.now;
  var data = {}; // date -> { rows, links, syncedAt }
  var restored = !backend; // 外部ストア使用時は復元成功まで「未復元」
  var lastAttempt = 0;
  var remoteSeq = 0;   // 最後に確認した外部ストアの世代 (楽観ロック)
  var dirty = false;   // 外部ストアに未反映の変更あり
  var lastError = null; // 固定コードのみ (URL・トークン・本文は入れない)

  function trim() {
    var keys = Object.keys(data).sort();
    keys.slice(0, Math.max(0, keys.length - KEEP_DATES)).forEach(function (d) { delete data[d]; });
  }
  function load() {
    if (!filePath) return;
    try {
      var j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      var v = j && validateStoredState(j.assignments);
      data = v && v.ok ? j.assignments : {}; // 破損・想定外の内容は丸ごと捨てる (部分採用しない)
      trim();
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

  // 日付ごとに syncedAt が新しい方を採用 (古いデータで新しい割当を上書きしない)。メモリ側が新しければ未反映として印を付ける。
  function mergeRemote(remote) {
    Object.keys(remote).forEach(function (d) {
      var local = data[d], r = remote[d];
      if (!local || Date.parse(r.syncedAt) > Date.parse(local.syncedAt)) data[d] = r;
      else if (Date.parse(local.syncedAt) > Date.parse(r.syncedAt)) dirty = true;
    });
    Object.keys(data).forEach(function (d) { if (!remote[d]) dirty = true; });
    trim();
  }

  async function restore() {
    lastAttempt = clock();
    try {
      var env = await backend.load();
      if (env === null) { remoteSeq = 0; } // 初回: まだ何も保存されていない
      else {
        var v = verifyEnvelope(env);
        if (!v.ok) { var ce = new Error('corrupt'); ce.code = 'remote-corrupt'; throw ce; } // 部分復元はしない
        mergeRemote(v.data);
        remoteSeq = env.seq;
      }
      restored = true; lastError = null;
    } catch (e) { restored = false; lastError = (e && /^[a-z0-9-]{1,40}$/.test(e.code || '')) ? e.code : 'restore-failed'; }
    return restored;
  }

  function makeEnvelope(seq) {
    var snapshot = JSON.parse(JSON.stringify(data));
    return { v: 1, seq: seq, savedAt: new Date(clock()).toISOString(), checksum: checksumOf(snapshot), data: snapshot };
  }

  return {
    init: function () { return backend ? restore() : Promise.resolve(true); },
    // 未復元なら30秒間隔で再試行
    ensureRestored: async function () {
      if (restored || !backend) return restored;
      if (clock() - lastAttempt < 30000) return false;
      return restore();
    },
    isRestored: function () { return restored; },
    status: function () { return { configured: !!backend, restored: restored, remoteSeq: remoteSeq, dirty: dirty, lastError: lastError }; },
    // 外部ストアへ書き戻す。GASが同じ seq / checksum を返したときだけ 'ok'。失敗してもメモリ/ファイルの内容は有効。
    // 競合(別の世代が先に保存された)時は再読込→日付ごとに新しい方を採用→1回だけ再試行。
    flush: async function () {
      if (!backend) return 'none';
      if (!restored) return 'skipped-unrestored'; // 部分データで外部ストアを上書きしない
      for (var attempt = 0; attempt < 2; attempt++) {
        var env = makeEnvelope(remoteSeq + 1);
        try { await backend.save(env, remoteSeq); remoteSeq = env.seq; dirty = false; lastError = null; return 'ok'; }
        catch (e) {
          lastError = (e && /^[a-z0-9-]{1,40}$/.test(e.code || '')) ? e.code : 'save-failed';
          if (e && e.code === 'gas-conflict' && attempt === 0) { if (!(await restore())) return 'failed'; continue; }
          dirty = true; return 'failed';
        }
      }
      dirty = true; return 'failed';
    },
    sync: function (input, todayJst) {
      var v = validateSync(input, todayJst);
      if (!v.ok) return v;
      data[v.date] = { rows: v.rows, links: v.links, syncedAt: new Date(clock()).toISOString() };
      trim(); dirty = true;
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

module.exports = { createAssignmentStore: createAssignmentStore, validateSync: validateSync, validateStoredState: validateStoredState, verifyEnvelope: verifyEnvelope, checksumOf: checksumOf, cycleOfRoute: cycleOfRoute };
