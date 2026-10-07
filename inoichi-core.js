/**
 * INOICHI core (Prototype 0).
 * HARVEST が回収済みの「時間指定(timeWindow)」「Bag」素材を受領・検証・正規化し、
 * OFK3 へ渡せる共通 Envelope を作る中継層。DOM非依存 (Nodeでテスト可能)。
 *
 * - 受領境界は HARVEST の 'harvest:handoff' (handoff record)。データ本体は record には無く、
 *   payloadReference に従い window.OFK3Cortex13 getter 群から読む (readInput)。
 * - dry-run 専用。OFK3 への書き込み・再POST・外部通信は一切行わない。
 * - 事実の正規化のみ。補完・推測・業務判定 (危険/遅配/修正要否 など) は行わない。
 *   不明値は不明値 (文字列 '' / 数値・座標 null) のまま保持する。
 * - Envelope.status は INOICHI 自身の変換結果のみ。HARVEST 側の状態は sourceMetadata に原情報で保持。
 * - Bag の14状態は status に潰さず、payload 行の bagStatus に元の値を保持する。
 * - テンプレートリテラル不使用。setInterval/MutationObserver不使用。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.InoichiCore = api;
})(this, function () {
  'use strict';

  var SCHEMA_VERSION = '0.1';
  var SUPPORTED_INPUT_SCHEMA_VERSIONS = ['0.1'];
  var HANDOFF_EVENT = 'harvest:handoff';
  var DATA_TYPES = ['timeWindow', 'bag'];
  var MAX_REJECTED_ROW_DETAILS = 100;

  var BAG_SUCCESS = ['captured', 'captured_null'];
  var BAG_NOT_ATTEMPTED = ['not_attempted'];
  var BAG_FAILURE = ['dom_not_found', 'dom_ambiguous', 'click_failed', 'timeout', 'stop_not_found',
    'stop_ambiguous', 'stop_expand_failed', 'package_dom_not_found', 'package_click_target_not_found',
    'route_aborted', 'ui_blocked'];
  var BAG_SOURCES = ['trDetails', 'stop_dom'];

  var TIME_WINDOW_FIELDS = [
    ['routeCode', 'str'], ['routeId', 'str'], ['stop', 'num'], ['driverName', 'str'], ['trackingId', 'str'],
    ['plannedEndTime', 'num'], ['plannedEndClock', 'str'], ['windowLabel', 'str'], ['address', 'str'],
    ['latitude', 'num'], ['longitude', 'num']
  ];
  var BAG_FIELDS = [
    ['routeCode', 'str'], ['trackingId', 'str'], ['referenceId', 'idlike'], ['driverAid', 'idlike'],
    ['bagName', 'strnull'], ['bagScannableId', 'idlike'], ['bagColorCode', 'idlike'], ['bagColor', 'strnull'],
    ['bagNumber', 'idlike'], ['bagDisplay', 'strnull'], ['bagStatus', 'strnull'], ['bagSource', 'strnull']
  ];

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNonEmptyStr(v) { return typeof v === 'string' && v.trim() !== ''; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function cloneJson(v) {
    if (v === undefined) return null;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
  }

  function toCount(v) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function bump(map, key, by) {
    map[key] = (map[key] || 0) + (by == null ? 1 : by);
  }

  function mapToList(map, keyName) {
    var out = [];
    Object.keys(map).forEach(function (k) {
      var o = {};
      o[keyName] = k;
      o.count = map[k];
      out.push(o);
    });
    return out;
  }

  function resolveNow(input) {
    var n = isObj(input) ? input.now : null;
    try {
      if (typeof n === 'function') n = n();
    } catch (e) { n = null; }
    if (typeof n === 'string' && n) return n;
    if (n instanceof Date && isFinite(n.getTime())) return n.toISOString();
    return new Date().toISOString();
  }

  function joinKey(routeCode, trackingId) {
    return String(routeCode) + '\u0000' + String(trackingId).trim();
  }

  function classifyBagStatus(status) {
    if (status === null) return 'legacy';
    if (typeof status !== 'string') return 'unknown';
    if (BAG_SUCCESS.indexOf(status) >= 0) return 'success';
    if (BAG_NOT_ATTEMPTED.indexOf(status) >= 0) return 'not-attempted';
    if (BAG_FAILURE.indexOf(status) >= 0) return 'failure';
    return 'unknown';
  }

  // field 検査: 'absent' | 'invalid' | 'ok'
  function checkField(kind, v) {
    if (v === undefined) return 'absent';
    if (kind === 'str') return typeof v === 'string' ? 'ok' : 'invalid';
    if (kind === 'num') return (v === null || isNum(v)) ? 'ok' : 'invalid';
    if (kind === 'strnull') return (v === null || typeof v === 'string') ? 'ok' : 'invalid';
    if (kind === 'idlike') return (v === null || typeof v === 'string' || isNum(v)) ? 'ok' : 'invalid';
    return 'ok';
  }

  function defaultFor(kind) {
    return kind === 'str' ? '' : null;
  }

  function newStats() {
    return {
      missing: {}, invalid: {}, rejectionReasons: {}, partialReasons: {},
      rejectedRows: [], partialCount: 0, rejectedCount: 0, normalizedCount: 0,
      duplicateKeyCount: 0, seen: {}
    };
  }

  function rejectRow(stats, idx, reasons) {
    stats.rejectedCount += 1;
    reasons.forEach(function (r) { bump(stats.rejectionReasons, r); });
    if (stats.rejectedRows.length < MAX_REJECTED_ROW_DETAILS) {
      stats.rejectedRows.push({ index: idx, reasons: reasons });
    }
  }

  // 共通: 行検証 + フィールド正規化。{ row, reasons(partial) } または null (reject)
  function normalizeRow(row, idx, fields, stats) {
    if (!isObj(row)) {
      rejectRow(stats, idx, ['row-not-object']);
      return null;
    }
    var rej = [];
    if (!isNonEmptyStr(row.routeCode)) rej.push('missing-routeCode');
    if (!isNonEmptyStr(row.trackingId)) rej.push('missing-trackingId');
    if (rej.length) {
      rejectRow(stats, idx, rej);
      return null;
    }
    var out = {};
    var partial = [];
    // 受領した全フィールドをそのまま保持 (未知フィールドも落とさない)
    Object.keys(row).forEach(function (k) { out[k] = cloneJson(row[k]); });
    fields.forEach(function (f) {
      var name = f[0];
      var res = checkField(f[1], row[name]);
      if (res === 'absent') {
        out[name] = defaultFor(f[1]);
        bump(stats.missing, name);
        partial.push('missing-field');
      } else if (res === 'invalid') {
        bump(stats.invalid, name);
        partial.push('invalid-field-type');
      }
    });
    var jk = joinKey(row.routeCode, row.trackingId);
    if (stats.seen[jk]) stats.duplicateKeyCount += 1;
    stats.seen[jk] = true;
    return { row: out, partial: partial };
  }

  function finishRow(stats, partialReasons) {
    stats.normalizedCount += 1;
    if (partialReasons.length) {
      stats.partialCount += 1;
      partialReasons.forEach(function (r) { bump(stats.partialReasons, r); });
    }
  }

  // ---- JOIN index (完全一致: routeCode + trackingId.trim()) ----
  function buildNumberIndex(rows, numField) {
    var idx = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!isObj(r) || !isNonEmptyStr(r.routeCode) || !isNonEmptyStr(r.trackingId)) return;
      var n = r[numField];
      if (!isNum(n)) return;
      var k = joinKey(r.routeCode, r.trackingId);
      if (!idx[k]) idx[k] = [];
      if (idx[k].indexOf(n) < 0) idx[k].push(n);
    });
    return idx;
  }

  function uniqueOf(idx, key) {
    var list = idx[key];
    if (!list || !list.length) return { state: 'none', value: null };
    if (list.length > 1) return { state: 'ambiguous', value: null };
    return { state: 'one', value: list[0] };
  }

  // ---- 入力検証 (Envelope 全体) ----
  function envelopeRejection(dataType, inp) {
    var reasons = [];
    if (!isObj(inp)) {
      reasons.push('input-not-object');
      return reasons;
    }
    if (DATA_TYPES.indexOf(dataType) < 0) reasons.push('unsupported-data-type');
    var h = inp.handoffRecord;
    if (h !== undefined && h !== null) {
      if (!isObj(h)) {
        reasons.push('handoff-not-object');
      } else {
        if (SUPPORTED_INPUT_SCHEMA_VERSIONS.indexOf(h.schemaVersion) < 0) reasons.push('unsupported-schema-version');
        if (h.harvestConfirmed !== true) reasons.push('handoff-not-confirmed');
        if (DATA_TYPES.indexOf(dataType) >= 0 && h.source !== dataType) reasons.push('handoff-source-mismatch');
      }
    }
    if (inp.schemaVersion !== undefined && inp.schemaVersion !== null &&
        SUPPORTED_INPUT_SCHEMA_VERSIONS.indexOf(inp.schemaVersion) < 0) {
      if (reasons.indexOf('unsupported-schema-version') < 0) reasons.push('unsupported-schema-version');
    }
    if (reasons.indexOf('unsupported-data-type') < 0) {
      var primary = dataType === 'bag' ? inp.packageAssistIndex : inp.packages;
      if (!Array.isArray(primary)) reasons.push('payload-missing');
      else if (primary.length === 0) reasons.push('payload-empty');
    }
    return reasons;
  }

  function buildSourceMetadata(inp) {
    var h = isObj(inp) && isObj(inp.handoffRecord) ? inp.handoffRecord : null;
    var hs = isObj(inp) && isObj(inp.harvestState) ? inp.harvestState : null;
    var entry = isObj(inp) && isObj(inp.entry) ? inp.entry : null;
    return {
      entrySource: entry && typeof entry.source === 'string' ? entry.source : null,
      harvestCollectorId: h && h.source != null ? h.source : (hs && hs.id != null ? hs.id : null),
      harvestStatus: hs && hs.status != null ? hs.status : (h && h.status != null ? h.status : null),
      harvestCounts: hs && hs.counts ? cloneJson(hs.counts) : (h ? { success: h.successCount, failure: h.failureCount } : null),
      harvestErrors: hs && Array.isArray(hs.errors) ? cloneJson(hs.errors) : (h && Array.isArray(h.errors) ? cloneJson(h.errors) : []),
      handoffSchemaVersion: h && h.schemaVersion !== undefined ? h.schemaVersion : null,
      harvestConfirmed: h ? h.harvestConfirmed === true : false,
      handoffConfirmedAt: h && h.confirmedAt ? h.confirmedAt : null,
      payloadReference: h && h.payloadReference != null ? cloneJson(h.payloadReference) : null
    };
  }

  function missingInputsOf(dataType, inp) {
    var m = [];
    function need(name, present) { if (!present) m.push(name); }
    need('handoffRecord', isObj(inp.handoffRecord));
    need('harvestState', isObj(inp.harvestState));
    need('entry', isObj(inp.entry));
    need('packages', Array.isArray(inp.packages));
    need('packageSequenceIndex', Array.isArray(inp.packageSequenceIndex));
    need('packageSequenceDiagnostics', isObj(inp.packageSequenceDiagnostics));
    if (dataType === 'bag') {
      need('packageAssistIndex', Array.isArray(inp.packageAssistIndex));
      need('packageAssistDiagnostics', isObj(inp.packageAssistDiagnostics));
    }
    return m;
  }

  function sumMapCounts(map) {
    var t = 0;
    Object.keys(map).forEach(function (k) { t += map[k]; });
    return t;
  }

  function emptyDiagnostics(inputCount) {
    return {
      inputCount: inputCount || 0,
      normalizedCount: 0,
      rejectedCount: 0,
      partialCount: 0,
      rejectionReasons: [],
      partialReasons: [],
      missingFields: [],
      invalidFields: [],
      rejectedRows: [],
      duplicateKeyCount: 0,
      missingInputs: [],
      getterErrors: [],
      inputSummary: {},
      join: null,
      bagStatusCounts: null,
      bagClassCounts: null,
      notes: []
    };
  }

  function inputSummaryOf(inp) {
    function len(v) { return Array.isArray(v) ? v.length : null; }
    return {
      packages: len(inp.packages),
      routeStops: len(inp.routeStops),
      packageSequenceIndex: len(inp.packageSequenceIndex),
      packageAssistIndex: len(inp.packageAssistIndex)
    };
  }

  function transform(dataType, input) {
    var inp = isObj(input) ? input : {};
    var now = resolveNow(input);
    var env;
    try {
      env = transformUnsafe(dataType, input, inp, now);
    } catch (e) {
      env = makeEnvelope(dataType, inp, now);
      env.status = 'rejected';
      env.diagnostics = emptyDiagnostics(0);
      env.diagnostics.rejectionReasons = [{ code: 'internal-error', count: 1, message: String(e && e.message ? e.message : e) }];
    }
    return env;
  }

  function makeEnvelope(dataType, inp, now) {
    var entry = isObj(inp.entry) ? inp.entry : null;
    var hs = isObj(inp.harvestState) ? inp.harvestState : null;
    var h = isObj(inp.handoffRecord) ? inp.handoffRecord : null;
    var localDate = entry && typeof entry.localDate === 'string' && entry.localDate ? entry.localDate : null;
    if (!localDate && h && isObj(h.payloadReference) && typeof h.payloadReference.localDate === 'string') {
      localDate = h.payloadReference.localDate || null;
    }
    var collectedAt = hs && hs.checkedAt ? hs.checkedAt : (h && h.collectedAt ? h.collectedAt : null);
    return {
      schemaVersion: SCHEMA_VERSION,
      producer: 'inoichi',
      source: 'harvest',
      dataType: typeof dataType === 'string' ? dataType : null,
      localDate: localDate,
      capturedAt: entry && entry.receivedAt ? entry.receivedAt : null,
      collectedAt: collectedAt,
      normalizedAt: now,
      status: 'rejected',
      sourceMetadata: buildSourceMetadata(inp),
      payload: { rows: [] },
      sourceDiagnostics: null,
      diagnostics: emptyDiagnostics(0)
    };
  }

  function transformUnsafe(dataType, rawInput, inp, now) {
    var env = makeEnvelope(dataType, inp, now);
    var diag = env.diagnostics;
    var isValidType = DATA_TYPES.indexOf(dataType) >= 0;
    diag.inputSummary = inputSummaryOf(inp);
    diag.missingInputs = missingInputsOf(isValidType ? dataType : 'timeWindow', inp);
    diag.getterErrors = Array.isArray(inp.getterErrors) ? cloneJson(inp.getterErrors) : [];
    if (!(isObj(inp.entry) && inp.entry.receivedAt)) diag.notes.push('capturedAt-unavailable');
    if (!env.localDate) diag.notes.push('localDate-unavailable');
    if (!env.collectedAt) diag.notes.push('collectedAt-unavailable');

    env.sourceDiagnostics = isValidType ? buildSourceDiagnostics(dataType, inp) : null;

    var primary = dataType === 'bag' ? inp.packageAssistIndex : inp.packages;
    diag.inputCount = Array.isArray(primary) ? primary.length : 0;

    var envReasons = envelopeRejection(dataType, rawInput);
    if (envReasons.length) {
      env.status = 'rejected';
      diag.rejectionReasons = envReasons.map(function (c) { return { code: c, count: 1 }; });
      return env;
    }

    var stats = newStats();
    var rows = [];
    if (dataType === 'bag') {
      processBag(inp, stats, rows, diag);
    } else {
      processTimeWindow(inp, stats, rows, diag);
    }
    env.payload = { rows: rows };
    diag.normalizedCount = stats.normalizedCount;
    diag.rejectedCount = stats.rejectedCount;
    diag.partialCount = stats.partialCount;
    diag.rejectionReasons = mapToList(stats.rejectionReasons, 'code');
    diag.partialReasons = mapToList(stats.partialReasons, 'code');
    diag.missingFields = mapToList(stats.missing, 'field');
    diag.invalidFields = mapToList(stats.invalid, 'field');
    diag.rejectedRows = stats.rejectedRows;
    diag.duplicateKeyCount = stats.duplicateKeyCount;

    if (stats.normalizedCount === 0) {
      env.status = 'rejected';
      diag.rejectionReasons.push({ code: 'no-valid-rows', count: 1 });
    } else if (stats.rejectedCount > 0 || stats.partialCount > 0) {
      env.status = 'partial';
    } else {
      env.status = 'ok';
    }
    return env;
  }

  function buildSourceDiagnostics(dataType, inp) {
    var sd = {
      packageSequenceDiagnostics: inp.packageSequenceDiagnostics === undefined ? null : cloneJson(inp.packageSequenceDiagnostics),
      packageSequenceRouteCount: inp.sequenceRouteCount === undefined ? null : cloneJson(inp.sequenceRouteCount)
    };
    if (dataType === 'bag') {
      sd.packageAssistDiagnostics = inp.packageAssistDiagnostics === undefined ? null : cloneJson(inp.packageAssistDiagnostics);
    }
    return sd;
  }

  function processTimeWindow(inp, stats, rows, diag) {
    var seqIdx = buildNumberIndex(inp.packageSequenceIndex, 'sequenceNumber');
    var join = { sequenceJoined: 0, sequenceUnjoined: 0, sequenceAmbiguous: 0 };
    inp.packages.forEach(function (r, i) {
      var n = normalizeRow(r, i, TIME_WINDOW_FIELDS, stats);
      if (!n) return;
      var u = uniqueOf(seqIdx, joinKey(n.row.routeCode, n.row.trackingId));
      if (u.state === 'one') {
        n.row.sequenceNumber = u.value;
        join.sequenceJoined += 1;
      } else if (u.state === 'ambiguous') {
        join.sequenceAmbiguous += 1;
      } else {
        join.sequenceUnjoined += 1;
      }
      finishRow(stats, n.partial);
      rows.push(n.row);
    });
    diag.join = join;
  }

  function processBag(inp, stats, rows, diag) {
    var pkgStops = buildNumberIndex(inp.packages, 'stop');
    var seqIdx = buildNumberIndex(inp.packageSequenceIndex, 'sequenceNumber');
    var join = { stopFromPackages: 0, stopFromSequence: 0, stopUnjoined: 0, stopAmbiguous: 0, stopConflicts: 0 };
    var statusCounts = {};
    var classCounts = {};
    inp.packageAssistIndex.forEach(function (r, i) {
      var n = normalizeRow(r, i, BAG_FIELDS, stats);
      if (!n) return;
      var row = n.row;
      var partial = n.partial;

      var status = row.bagStatus;
      var cls = classifyBagStatus(status);
      row.bagStatusClass = cls;
      if (cls === 'unknown') partial.push('unknown-bagStatus');
      if (typeof row.bagSource === 'string' && BAG_SOURCES.indexOf(row.bagSource) < 0) partial.push('unknown-bagSource');
      bump(statusCounts, status === null ? '(null)' : String(status));
      bump(classCounts, cls);

      var k = joinKey(row.routeCode, row.trackingId);
      var p = uniqueOf(pkgStops, k);
      var s = uniqueOf(seqIdx, k);
      row.stop = null;
      row.stopSource = null;
      if (p.state === 'one') {
        row.stop = p.value;
        row.stopSource = 'packages';
        join.stopFromPackages += 1;
        if (s.state === 'one' && s.value !== p.value) join.stopConflicts += 1;
      } else if (p.state === 'ambiguous') {
        join.stopAmbiguous += 1;
      } else if (s.state === 'one') {
        row.stop = s.value;
        row.stopSource = 'packageSequenceIndex';
        join.stopFromSequence += 1;
      } else if (s.state === 'ambiguous') {
        join.stopAmbiguous += 1;
      } else {
        join.stopUnjoined += 1;
      }
      finishRow(stats, partial);
      rows.push(row);
    });
    diag.join = join;
    diag.bagStatusCounts = statusCounts;
    diag.bagClassCounts = classCounts;
    diag.legacyBagStatusCount = statusCounts['(null)'] || 0;
    diag.bagStatusNullDistinguishable = (statusCounts['(null)'] || 0) === 0;
  }

  // ---- 入力取得 (getter 経由。fetch 等の外部通信はしない) ----
  function readGetter(api, name, errors) {
    if (!api || typeof api[name] !== 'function') {
      errors.push({ getter: name, message: 'getter-missing' });
      return undefined;
    }
    try {
      return api[name]();
    } catch (e) {
      errors.push({ getter: name, message: String(e && e.message ? e.message : e) });
      return undefined;
    }
  }

  // api: OFK3Cortex13 相当。opts: { hub, handoffRecords:{id:record}, now }
  // 返り値: dryRun に渡せる入力 (handoffRecords / harvestStates は dataType ごと)
  function readInput(api, opts) {
    opts = opts || {};
    var errors = [];
    var out = {
      entry: null, packages: null, routeStops: null, packageSequenceIndex: null,
      packageSequenceDiagnostics: null, packageAssistIndex: null, packageAssistDiagnostics: null,
      sequenceRouteCount: null, getterErrors: errors, handoffRecords: {}, harvestStates: {}
    };
    if (opts.now !== undefined) out.now = opts.now;
    if (!api) {
      errors.push({ getter: 'OFK3Cortex13', message: 'api-missing' });
    } else {
      var entry = readGetter(api, 'getEntry', errors);
      out.entry = isObj(entry) ? entry : null;
      var pk = readGetter(api, 'getPackages', errors);
      out.packages = Array.isArray(pk) ? pk : null;
      var rs = readGetter(api, 'getRouteStops', errors);
      out.routeStops = Array.isArray(rs) ? rs : null;
      var si = readGetter(api, 'getPackageSequenceIndex', errors);
      out.packageSequenceIndex = Array.isArray(si) ? si : null;
      var sd = readGetter(api, 'getPackageSequenceDiagnostics', errors);
      out.packageSequenceDiagnostics = isObj(sd) ? sd : null;
      if (isObj(sd) && sd.packageSequenceRouteCount !== undefined) out.sequenceRouteCount = sd.packageSequenceRouteCount;
      var ai = readGetter(api, 'getPackageAssistIndex', errors);
      out.packageAssistIndex = Array.isArray(ai) ? ai : null;
      var ad = readGetter(api, 'getPackageAssistDiagnostics', errors);
      out.packageAssistDiagnostics = isObj(ad) ? ad : null;
    }
    var hub = opts.hub;
    DATA_TYPES.forEach(function (id) {
      var rec = opts.handoffRecords && opts.handoffRecords[id] ? opts.handoffRecords[id] : null;
      if (!rec && hub && typeof hub.getLastHandoff === 'function') {
        try { rec = hub.getLastHandoff(id); } catch (e) { rec = null; }
      }
      out.handoffRecords[id] = rec || null;
      var st = null;
      if (hub && typeof hub.getState === 'function') {
        try { st = hub.getState(id); } catch (e2) { st = null; }
      }
      out.harvestStates[id] = st || null;
    });
    return out;
  }

  function inputFor(dataType, input) {
    var base = isObj(input) ? input : null;
    if (!base) return input;
    var o = {};
    Object.keys(base).forEach(function (k) {
      if (k === 'handoffRecords' || k === 'harvestStates') return;
      o[k] = base[k];
    });
    var recs = isObj(base.handoffRecords) ? base.handoffRecords : null;
    var sts = isObj(base.harvestStates) ? base.harvestStates : null;
    if (recs && recs[dataType] !== undefined) o.handoffRecord = recs[dataType];
    else if (isObj(base.handoffRecord) && base.handoffRecord.source !== dataType) o.handoffRecord = null;
    if (sts && sts[dataType] !== undefined) o.harvestState = sts[dataType];
    else if (isObj(base.harvestState) && base.harvestState.id !== undefined && base.harvestState.id !== dataType) o.harvestState = null;
    return o;
  }

  // dry-run: 両 dataType を処理。OFK3 への書き込みは行わない (written:false 固定)。
  function dryRun(input, dataTypes) {
    var types = Array.isArray(dataTypes) && dataTypes.length ? dataTypes : DATA_TYPES;
    var envelopes = [];
    var byDataType = {};
    var statusCounts = { ok: 0, partial: 0, rejected: 0 };
    var ready = [];
    types.forEach(function (t) {
      var env = transform(t, inputFor(t, input));
      envelopes.push(env);
      statusCounts[env.status] += 1;
      var d = env.diagnostics;
      byDataType[String(t)] = {
        status: env.status,
        inputCount: d.inputCount,
        normalizedCount: d.normalizedCount,
        partialCount: d.partialCount,
        rejectedCount: d.rejectedCount
      };
      if (env.status !== 'rejected') ready.push(String(t));
    });
    var totals = { inputCount: 0, normalizedCount: 0, partialCount: 0, rejectedCount: 0 };
    envelopes.forEach(function (e) {
      totals.inputCount += e.diagnostics.inputCount;
      totals.normalizedCount += e.diagnostics.normalizedCount;
      totals.partialCount += e.diagnostics.partialCount;
      totals.rejectedCount += e.diagnostics.rejectedCount;
    });
    var summary = {
      envelopeCount: envelopes.length,
      byDataType: byDataType,
      statusCounts: statusCounts,
      totals: totals,
      ofk3Handoff: { dryRun: true, written: false, readyDataTypes: ready, ready: ready.length > 0 }
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      dryRun: true,
      stages: buildStages(input, envelopes, summary),
      envelopes: envelopes,
      summary: summary
    };
  }

  function buildStages(input, envelopes, summary) {
    var inp = isObj(input) ? input : {};
    var recs = isObj(inp.handoffRecords) ? inp.handoffRecords : {};
    var received = [];
    DATA_TYPES.forEach(function (t) {
      if (isObj(recs[t])) received.push(t);
    });
    if (isObj(inp.handoffRecord) && received.indexOf(inp.handoffRecord.source) < 0 && typeof inp.handoffRecord.source === 'string') {
      received.push(inp.handoffRecord.source);
    }
    return {
      harvestInput: { handoffReceived: received, inputSummary: inputSummaryOf(inp), getterErrors: Array.isArray(inp.getterErrors) ? cloneJson(inp.getterErrors) : [] },
      validation: envelopes.map(function (e) {
        return { dataType: e.dataType, status: e.status, rejectionReasons: cloneJson(e.diagnostics.rejectionReasons) };
      }),
      normalization: envelopes.map(function (e) {
        return { dataType: e.dataType, normalizedCount: e.diagnostics.normalizedCount, partialCount: e.diagnostics.partialCount, rejectedCount: e.diagnostics.rejectedCount };
      }),
      canonicalPayload: envelopes.map(function (e) {
        return { dataType: e.dataType, rowCount: e.payload.rows.length };
      }),
      ofk3HandoffReady: summary.ofk3Handoff
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    SUPPORTED_INPUT_SCHEMA_VERSIONS: SUPPORTED_INPUT_SCHEMA_VERSIONS,
    HANDOFF_EVENT: HANDOFF_EVENT,
    DATA_TYPES: DATA_TYPES,
    BAG_STATUS: { success: BAG_SUCCESS.slice(), notAttempted: BAG_NOT_ATTEMPTED.slice(), failure: BAG_FAILURE.slice() },
    classifyBagStatus: classifyBagStatus,
    joinKey: joinKey,
    readInput: readInput,
    transform: transform,
    dryRun: dryRun
  };
});
