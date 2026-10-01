/**
 * HARVEST core (Prototype 0).
 * 観測・確認・正規化・状態管理・handoff準備 層。DOM非依存 (Nodeでテスト可能)。
 *
 * - Cortex取得そのものは起動しない。回収は人間が Cortex 拡張で行い、HARVEST は
 *   既に回収された素材 (既存の Cortex import 経路でOFK3へ送信済み) を Collector 単位で
 *   再確認・検証・正規化する。
 * - Collector契約:
 *   { id, label, dependsOn[], trigger:{kind,instruction},
 *     probe(ctx): Promise<RawSnapshot>, normalize(raw, ctx): HarvestResult,
 *     summarize(result): string, handoff(result): { payloadReference } }
 * - HarvestResult: { status, counts:{success,failure,total}, errors:[{code,message,count?}], details:{} }
 * - 状態は in-memory のみ。住所/ドライバー名等のPIIは保持しない (件数とコードのみ)。
 * - 独立評価: 1 Collector の失敗/例外は他 Collector に波及しない。
 * - テンプレートリテラル不使用。setInterval/MutationObserver不使用。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestCore = api;
})(this, function () {
  'use strict';

  var SCHEMA_VERSION = '0.1';
  var HANDOFF_EVENT = 'harvest:handoff';
  var MAX_ERRORS = 20;

  var STATUS = {
    IDLE: 'idle',
    AWAITING: 'awaiting-data',
    CHECKING: 'checking',
    OK: 'ok',
    PARTIAL: 'partial',
    ERROR: 'error',
    STALE: 'stale'
  };

  var STATUS_LABEL = {
    'idle': '未確認',
    'awaiting-data': '回収データ待ち',
    'checking': '検証中',
    'ok': '正常',
    'partial': '一部異常',
    'error': '異常',
    'stale': '本日分でない'
  };

  var OVERALL = { COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', FAILED: 'FAILED' };

  var TRIGGER_KIND = {
    HUMAN_EXTERNAL: 'human-external',
    HUMAN_FILE_UPLOAD: 'human-file-upload'
  };

  function isKnownStatus(s) {
    return Object.prototype.hasOwnProperty.call(STATUS_LABEL, s);
  }

  function statusLabel(s) {
    return isKnownStatus(s) ? STATUS_LABEL[s] : String(s);
  }

  function toCount(v) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function normalizeErrors(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < MAX_ERRORS; i++) {
      var e = list[i];
      if (e == null) continue;
      if (typeof e === 'string') {
        out.push({ code: 'error', message: e });
        continue;
      }
      var item = { code: String(e.code || 'error'), message: String(e.message || '') };
      if (e.count != null && isFinite(Number(e.count))) item.count = Number(e.count);
      out.push(item);
    }
    return out;
  }

  function cloneJson(v) {
    if (v == null) return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
  }

  function normalizeResult(r) {
    r = r && typeof r === 'object' ? r : {};
    var status = isKnownStatus(r.status) && r.status !== STATUS.CHECKING && r.status !== STATUS.IDLE
      ? r.status : STATUS.ERROR;
    var c = r.counts && typeof r.counts === 'object' ? r.counts : {};
    var success = toCount(c.success);
    var failure = toCount(c.failure);
    var total = c.total != null ? toCount(c.total) : success + failure;
    var errors = normalizeErrors(r.errors);
    if (status === STATUS.ERROR && !errors.length && !(r.status === STATUS.ERROR)) {
      errors.push({ code: 'invalid-result', message: 'normalize() が不正な結果を返しました' });
    }
    return {
      status: status,
      counts: { success: success, failure: failure, total: total },
      errors: errors,
      details: r.details && typeof r.details === 'object' ? cloneJson(r.details) || {} : {}
    };
  }

  // 全体結果: 全Collector正常=COMPLETE / 正常または一部異常が1つも無い=FAILED / それ以外=PARTIAL
  function computeOverall(statuses) {
    if (!Array.isArray(statuses) || !statuses.length) return OVERALL.FAILED;
    var allOk = true;
    var anyUsable = false;
    for (var i = 0; i < statuses.length; i++) {
      var s = statuses[i];
      if (s !== STATUS.OK) allOk = false;
      if (s === STATUS.OK || s === STATUS.PARTIAL) anyUsable = true;
    }
    if (allOk) return OVERALL.COMPLETE;
    return anyUsable ? OVERALL.PARTIAL : OVERALL.FAILED;
  }

  function defaultSummarize(result) {
    if (!result) return '';
    var c = result.counts || {};
    return statusLabel(result.status) + ' (成功 ' + toCount(c.success) + ' / 失敗 ' + toCount(c.failure) + ')';
  }

  function defaultHandoff() {
    return { payloadReference: null };
  }

  // handoff共通形式。実データは持たず payloadReference で既存getter経由の取得先を示す。
  function buildHandoff(source, entry, extra, nowIso) {
    entry = entry || {};
    extra = extra || {};
    var counts = entry.counts || {};
    return {
      source: String(source),
      collectedAt: entry.checkedAt || nowIso || null,
      status: entry.status || STATUS.IDLE,
      successCount: toCount(counts.success),
      failureCount: toCount(counts.failure),
      errors: normalizeErrors(entry.errors),
      payloadReference: extra.payloadReference == null ? null : cloneJson(extra.payloadReference),
      schemaVersion: SCHEMA_VERSION,
      harvestConfirmed: true,
      confirmedAt: nowIso || entry.checkedAt || null
    };
  }

  function defaultNow() {
    return new Date().toISOString();
  }

  function defaultDispatch(name, detail) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' &&
        typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
      return true;
    }
    return false;
  }

  function createHub(opts) {
    opts = opts || {};
    var now = typeof opts.now === 'function' ? opts.now : defaultNow;
    var dispatch = typeof opts.dispatch === 'function' ? opts.dispatch : defaultDispatch;

    var order = [];
    var defs = {};
    var store = {};
    var running = {};
    var lastHandoff = {};
    var listeners = [];
    var cache = {};
    var activeScopes = 0;
    var runAllPromise = null;

    function notify(id) {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](id); } catch (e) {}
      }
    }

    function onChange(fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }

    function register(def) {
      if (!def || typeof def !== 'object') throw new Error('collector definition required');
      if (!def.id || typeof def.id !== 'string') throw new Error('collector.id must be a non-empty string');
      if (defs[def.id]) throw new Error('collector already registered: ' + def.id);
      if (typeof def.probe !== 'function') throw new Error('collector.probe must be a function: ' + def.id);
      if (typeof def.normalize !== 'function') throw new Error('collector.normalize must be a function: ' + def.id);
      var deps = Array.isArray(def.dependsOn) ? def.dependsOn.filter(function (d) { return typeof d === 'string' && d; }) : [];
      var trigger = def.trigger && typeof def.trigger === 'object' ? def.trigger : {};
      defs[def.id] = {
        id: def.id,
        label: def.label ? String(def.label) : def.id,
        dependsOn: deps,
        trigger: {
          kind: trigger.kind || TRIGGER_KIND.HUMAN_EXTERNAL,
          instruction: trigger.instruction ? String(trigger.instruction) : ''
        },
        probe: def.probe,
        normalize: def.normalize,
        summarize: typeof def.summarize === 'function' ? def.summarize : defaultSummarize,
        handoff: typeof def.handoff === 'function' ? def.handoff : defaultHandoff
      };
      order.push(def.id);
      store[def.id] = {
        status: STATUS.IDLE,
        counts: { success: 0, failure: 0, total: 0 },
        checkedAt: null,
        errors: [],
        details: {},
        summary: ''
      };
      notify(def.id);
      return def.id;
    }

    function listIds() {
      return order.slice();
    }

    function getCollector(id) {
      var d = defs[id];
      if (!d) return null;
      return {
        id: d.id,
        label: d.label,
        dependsOn: d.dependsOn.slice(),
        trigger: { kind: d.trigger.kind, instruction: d.trigger.instruction }
      };
    }

    function getState(id) {
      var s = store[id];
      if (!s) return null;
      return {
        id: id,
        label: defs[id].label,
        status: s.status,
        counts: { success: s.counts.success, failure: s.counts.failure, total: s.counts.total },
        checkedAt: s.checkedAt,
        errors: normalizeErrors(s.errors),
        details: cloneJson(s.details) || {},
        summary: s.summary
      };
    }

    function getAll() {
      return order.map(function (id) { return getState(id); });
    }

    function getOverall() {
      var statuses = order.map(function (id) { return store[id].status; });
      for (var i = 0; i < statuses.length; i++) {
        if (statuses[i] === STATUS.IDLE || statuses[i] === STATUS.CHECKING) return null;
      }
      return computeOverall(statuses);
    }

    function isRunning(id) {
      return !!running[id];
    }

    // probe結果の共有キャッシュ。実行スコープ内 (単発/HARVEST ALL) で同一keyは1回のみ実行。
    function shared(key, fn) {
      if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
      cache[key] = Promise.resolve().then(fn);
      return cache[key];
    }

    function acquireScope() {
      if (activeScopes === 0) cache = {};
      activeScopes += 1;
      var released = false;
      return function () {
        if (released) return;
        released = true;
        activeScopes -= 1;
        if (activeScopes === 0) cache = {};
      };
    }

    function makeCtx() {
      return {
        shared: shared,
        now: now,
        getResult: function (id) { return getState(id); }
      };
    }

    function errorFromException(e) {
      var msg = e && e.message ? String(e.message) : String(e);
      return { code: 'collector-exception', message: msg.slice(0, 200) };
    }

    // 単一Collectorを実行。重複実行は無視 (skipped)。例外は握りつぶして error 状態に変換。
    function runCollector(id) {
      var def = defs[id];
      if (!def) return Promise.resolve({ ok: false, skipped: true, reason: 'unknown-collector', id: id });
      if (running[id]) return Promise.resolve({ ok: true, skipped: true, reason: 'already-running', id: id });

      var release = acquireScope();
      var s = store[id];
      s.status = STATUS.CHECKING;
      s.errors = [];
      notify(id);

      var p = Promise.resolve().then(function () {
        return def.probe(makeCtx());
      }).then(function (raw) {
        return normalizeResult(def.normalize(raw, makeCtx()));
      }).catch(function (e) {
        return normalizeResult({
          status: STATUS.ERROR,
          counts: { success: 0, failure: 0, total: 0 },
          errors: [errorFromException(e)],
          details: {}
        });
      }).then(function (result) {
        var summary = '';
        try { summary = String(def.summarize(result) || ''); } catch (e) { summary = defaultSummarize(result); }
        s.status = result.status;
        s.counts = result.counts;
        s.errors = result.errors;
        s.details = result.details;
        s.summary = summary;
        s.checkedAt = now();
        release();
        delete running[id];
        notify(id);
        return { ok: true, skipped: false, id: id, state: getState(id) };
      });
      running[id] = p;
      return p;
    }

    // 依存順 (レベル) に並べる。未登録dependsOnは無視。循環は最終レベルにまとめる。
    function levels() {
      var level = {};
      var visiting = {};
      function calc(id) {
        if (level[id] != null) return level[id];
        if (visiting[id]) return 0;
        visiting[id] = true;
        var lv = 0;
        var deps = defs[id].dependsOn;
        for (var i = 0; i < deps.length; i++) {
          if (defs[deps[i]]) lv = Math.max(lv, calc(deps[i]) + 1);
        }
        visiting[id] = false;
        level[id] = lv;
        return lv;
      }
      var groups = [];
      order.forEach(function (id) {
        var lv = calc(id);
        if (!groups[lv]) groups[lv] = [];
        groups[lv].push(id);
      });
      return groups.filter(function (g) { return !!g; });
    }

    // HARVEST ALL: 全Collectorを依存順に再確認。1つの失敗で全体異常終了しない。
    function runAll() {
      if (runAllPromise) {
        return Promise.resolve({ ok: true, skipped: true, reason: 'already-running', overall: null, results: {} });
      }
      var release = acquireScope();
      var groups = levels();
      var chain = Promise.resolve();
      groups.forEach(function (ids) {
        chain = chain.then(function () {
          return Promise.all(ids.map(function (id) {
            if (running[id]) return running[id];
            return runCollector(id);
          }));
        });
      });
      runAllPromise = chain.catch(function () {}).then(function () {
        var results = {};
        order.forEach(function (id) { results[id] = getState(id); });
        var statuses = order.map(function (id) { return store[id].status; });
        release();
        runAllPromise = null;
        notify('*');
        return { ok: true, skipped: false, overall: computeOverall(statuses), results: results };
      });
      return runAllPromise;
    }

    function isRunningAll() {
      return !!runAllPromise;
    }

    // handoff: HARVEST確認済みフラグ付与 + CustomEvent発火のみ。再POST・再保存はしない。
    function handoff(id) {
      var def = defs[id];
      if (!def) return { ok: false, reason: 'unknown-collector', id: id };
      var s = store[id];
      if (s.status !== STATUS.OK && s.status !== STATUS.PARTIAL && s.status !== STATUS.STALE) {
        return { ok: false, reason: 'not-handoff-ready', id: id, status: s.status };
      }
      var extra = null;
      try { extra = def.handoff(getState(id)); } catch (e) { extra = null; }
      var record = buildHandoff(id, { status: s.status, counts: s.counts, checkedAt: s.checkedAt, errors: s.errors }, extra, now());
      lastHandoff[id] = record;
      var dispatched = false;
      try { dispatched = !!dispatch(HANDOFF_EVENT, record); } catch (e) { dispatched = false; }
      notify(id);
      return { ok: true, id: id, dispatched: dispatched, record: cloneJson(record) };
    }

    function handoffAll() {
      var results = {};
      order.forEach(function (id) { results[id] = handoff(id); });
      return results;
    }

    function getLastHandoff(id) {
      return lastHandoff[id] ? cloneJson(lastHandoff[id]) : null;
    }

    return {
      register: register,
      listIds: listIds,
      getCollector: getCollector,
      getState: getState,
      getAll: getAll,
      getOverall: getOverall,
      isRunning: isRunning,
      isRunningAll: isRunningAll,
      runCollector: runCollector,
      runAll: runAll,
      handoff: handoff,
      handoffAll: handoffAll,
      getLastHandoff: getLastHandoff,
      onChange: onChange
    };
  }

  var defaultHub = null;
  function getDefaultHub() {
    if (!defaultHub) defaultHub = createHub();
    return defaultHub;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    HANDOFF_EVENT: HANDOFF_EVENT,
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    OVERALL: OVERALL,
    TRIGGER_KIND: TRIGGER_KIND,
    statusLabel: statusLabel,
    normalizeResult: normalizeResult,
    normalizeErrors: normalizeErrors,
    computeOverall: computeOverall,
    defaultSummarize: defaultSummarize,
    buildHandoff: buildHandoff,
    createHub: createHub,
    getDefaultHub: getDefaultHub
  };
});
