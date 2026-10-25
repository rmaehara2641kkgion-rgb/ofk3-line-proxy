(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.InoichiDashboard = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DASHBOARD_SCHEMA_VERSION = '0.1';

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string'; }
  function isNum(v) { return typeof v === 'number' && !isNaN(v); }
  function isArr(v) { return Array.isArray(v); }

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function nowIso() { return new Date().toISOString(); }

  function formatNumber(n, fallback) {
    if (isNum(n)) return String(n);
    return arguments.length > 1 ? fallback : '—';
  }

  function formatDateTime(dt) {
    if (!dt) return '不明';
    try {
      var d = new Date(dt);
      if (isNaN(d.getTime())) return '不明';
      return d.toLocaleString('ja-JP');
    } catch (e) { return '不明'; }
  }

  function buildAlertKey(ruleId, localDate, hours) {
    return [String(ruleId || ''), String(localDate || ''), String(hours === undefined || hours === null ? '' : hours)].join('|');
  }

  function findAlertRecord(store, ruleId, localDate, hours) {
    if (!isObj(store) || !isObj(store.alerts)) return null;
    var key = buildAlertKey(ruleId, localDate, hours);
    return store.alerts[key] || null;
  }

  function countBy(arr, keyFn) {
    var out = {};
    if (!isArr(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var k = keyFn(arr[i]);
      if (k === null || k === undefined) continue;
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  function buildSeverityCounts(records) {
    var counts = { critical: 0, warning: 0, info: 0 };
    for (var i = 0; i < records.length; i++) {
      var sev = records[i].severity;
      if (counts.hasOwnProperty(sev)) counts[sev] += 1;
    }
    return counts;
  }

  function buildSummary(store, canonicalInputs, opts) {
    opts = opts || {};
    var records = (isObj(store) && isObj(store.alerts)) ? [] : [];
    if (isObj(store) && isObj(store.alerts)) {
      var keys = Object.keys(store.alerts);
      for (var i = 0; i < keys.length; i++) records.push(store.alerts[keys[i]]);
    }

    var statusCounts = countBy(records, function (r) { return r.status; });
    var missingActualCount = 0;
    var unevaluatedCount = 0;
    if (isArr(canonicalInputs)) {
      for (var j = 0; j < canonicalInputs.length; j++) {
        var inp = canonicalInputs[j];
        if (!isObj(inp)) continue;
        if (inp.actual === undefined || inp.actual === null) {
          missingActualCount += 1;
          unevaluatedCount += 1;
        }
      }
    }

    return {
      totalAlerts: records.length,
      openCount: statusCounts.OPEN || 0,
      ongoingCount: statusCounts.ONGOING || 0,
      reopenedCount: statusCounts.REOPENED || 0,
      resolvedCount: statusCounts.RESOLVED || 0,
      severityCounts: buildSeverityCounts(records),
      unevaluatedCount: unevaluatedCount,
      missingActualCount: missingActualCount
    };
  }

  function buildRiskRows(canonicalInputs, store, opts) {
    opts = opts || {};
    var ruleId = opts.ruleId || 'fleet-capacity-shortage-v1';
    var rows = [];
    if (!isArr(canonicalInputs)) return rows;

    for (var i = 0; i < canonicalInputs.length; i++) {
      var inp = canonicalInputs[i];
      if (!isObj(inp)) continue;
      var actualMissing = inp.actual === undefined || inp.actual === null;
      var actualNum = actualMissing ? null : inp.actual;
      var shortage = (isNum(inp.expected) && isNum(actualNum)) ? inp.expected - actualNum : null;
      var record = findAlertRecord(store, ruleId, inp.localDate, inp.hours);

      var status;
      var severity;
      var lastDetectedAt;
      var alertKey;
      if (record) {
        status = record.status;
        severity = record.severity || 'info';
        lastDetectedAt = record.lastDetectedAt;
        alertKey = record.alertKey;
      } else if (actualMissing) {
        status = '未取得';
        severity = 'none';
        lastDetectedAt = null;
        alertKey = buildAlertKey(ruleId, inp.localDate, inp.hours);
      } else {
        status = '正常';
        severity = 'none';
        lastDetectedAt = null;
        alertKey = buildAlertKey(ruleId, inp.localDate, inp.hours);
      }

      rows.push({
        localDate: inp.localDate,
        block: inp.block,
        hours: inp.hours,
        expected: inp.expected,
        actual: actualNum,
        actualMissing: actualMissing,
        shortage: shortage,
        severity: severity,
        status: status,
        lastDetectedAt: lastDetectedAt,
        alertKey: alertKey,
        inputIndex: i
      });
    }

    rows.sort(function (a, b) {
      var d = String(a.localDate).localeCompare(String(b.localDate));
      if (d !== 0) return d;
      if (a.hours !== b.hours) return b.hours - a.hours;
      return String(a.block).localeCompare(String(b.block));
    });
    return rows;
  }

  function buildAlertHistory(store) {
    if (!isObj(store) || !isObj(store.alerts)) return [];
    var keys = Object.keys(store.alerts);
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push(store.alerts[keys[i]]);
    out.sort(function (a, b) {
      return String(a.firstDetectedAt || '').localeCompare(String(b.firstDetectedAt || ''));
    });
    return out;
  }

  function getFleetAdapter() {
    if (typeof window !== 'undefined' && window.InoichiFleetAdapter) return window.InoichiFleetAdapter;
    try { var req = require; return req('./inoichi-fleet-adapter.js'); } catch (e) {}
    return null;
  }

  function getAlertView() {
    if (typeof window !== 'undefined' && window.InoichiAlertView) return window.InoichiAlertView;
    try { var req = require; return req('./inoichi-alert-view.js'); } catch (e) {}
    return null;
  }

  function buildDiagnostics(canonicalInputs, fleetResult, store, opts) {
    opts = opts || {};
    var fleetDiagnostics = (fleetResult && isObj(fleetResult.diagnostics)) ? fleetResult.diagnostics : {};
    var inputCount = isArr(canonicalInputs) ? canonicalInputs.length : 0;
    var missingActualCount = isArr(fleetDiagnostics.missingActuals) ? fleetDiagnostics.missingActuals.length : 0;

    var invalidCanonicalCount = 0;
    var Fleet = getFleetAdapter();
    if (Fleet && isArr(canonicalInputs)) {
      for (var i = 0; i < canonicalInputs.length; i++) {
        if (!Fleet.validateFleetCanonicalInput(canonicalInputs[i]).ok) invalidCanonicalCount++;
      }
    }
    var invalidCount = fleetDiagnostics.skippedCount || (isArr(fleetDiagnostics.invalidEntries) ? fleetDiagnostics.invalidEntries.length : 0);
    if (invalidCanonicalCount > 0) invalidCount = invalidCanonicalCount;
    var validCount = inputCount - invalidCanonicalCount;

    var persistenceErrors = false;
    if (isObj(store) && isObj(store.diagnostics) && isArr(store.diagnostics.persistenceErrors)) {
      persistenceErrors = store.diagnostics.persistenceErrors.length > 0;
    }

    var lastEvaluatedAt = null;
    if (isObj(store) && store._updatedAt) lastEvaluatedAt = store._updatedAt;
    else if (opts && opts.detectedAt) lastEvaluatedAt = opts.detectedAt;

    return {
      inputCount: inputCount,
      validCount: validCount,
      invalidCount: invalidCount,
      missingActualCount: missingActualCount,
      lastEvaluatedAt: lastEvaluatedAt,
      persistenceErrors: persistenceErrors,
      dataSource: opts.dataSource || 'unknown'
    };
  }

  function buildDashboardState(opts) {
    opts = opts || {};
    var canonicalInputs = isArr(opts.canonicalInputs) ? opts.canonicalInputs : [];
    var fleetResult = opts.fleetResult || null;
    var store = opts.store || null;
    var notificationDryRun = opts.notificationDryRun || { dryRun: true, candidates: [], previews: [], summary: { total: 0, eligible: 0, suppressed: 0, byReason: {} } };

    var summary = buildSummary(store, canonicalInputs, opts);
    var riskRows = buildRiskRows(canonicalInputs, store, opts);
    var alertHistory = buildAlertHistory(store);
    var diagnostics = buildDiagnostics(canonicalInputs, fleetResult, store, opts);
    var rollingView = opts.rollingView || emptyRollingView();
    var threeWay = opts.threeWay || null;
    var meta = {
      title: 'INO-1 Prototype 1 — 調査用Dashboard',
      banner: opts.sampleMode ? 'Prototype 1 / サンプルデータ / 本番未接続 / 実通知なし' : '本番未接続 / 実通知なし',
      dryRunBanner: 'Dry-run専用・実通知なし',
      generatedAt: opts.now || nowIso(),
      sampleMode: opts.sampleMode === true,
      dataSource: diagnostics.dataSource
    };
    var state = {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      meta: meta,
      summary: summary,
      riskRows: riskRows,
      alertHistory: alertHistory,
      dryRun: notificationDryRun,
      diagnostics: diagnostics,
      rollingView: rollingView,
      threeWay: threeWay,
      command: null
    };
    refreshCommand(state);
    return state;
  }

  function refreshCommand(state) {
    if (!isObj(state)) return null;
    var View = getAlertView();
    if (!View || typeof View.buildCommandCenter !== 'function') {
      state.command = null;
      return null;
    }
    state.command = View.buildCommandCenter({
      meta: state.meta,
      alertHistory: state.alertHistory,
      diagnostics: state.diagnostics,
      rollingView: state.rollingView,
      threeWay: state.threeWay
    });
    return state.command;
  }

  function emptyRollingView() {
    return {
      fetchStatus: 'missing',
      fetchLabel: 'データ未取得',
      checkedAt: null,
      usable: false,
      counts: {
        driverCount: null,
        clearCount: null,
        exceedCount: null,
        approachCount: null,
        partialCount: null,
        undeterminedCount: null
      },
      changes: {
        newExceed: 0,
        ongoingExceed: 0,
        resolvedExceed: 0,
        becameUndetermined: 0,
        dataUnchanged: 0
      },
      history: {},
      alerts: [],
      approachNote: '',
      sent: false,
      channel: 'dry-run',
      lastSuccess: null
    };
  }

  function severityClass(severity) {
    if (severity === 'critical') return 'ino-severity-critical';
    if (severity === 'warning') return 'ino-severity-warning';
    if (severity === 'info') return 'ino-severity-info';
    return 'ino-severity-none';
  }

  function statusClass(status) {
    if (status === 'OPEN') return 'ino-status-open';
    if (status === 'ONGOING') return 'ino-status-ongoing';
    if (status === 'REOPENED') return 'ino-status-reopened';
    if (status === 'RESOLVED') return 'ino-status-resolved';
    if (status === '未取得') return 'ino-status-missing';
    return 'ino-status-normal';
  }

  function card(title, body, opts) {
    opts = opts || {};
    var cls = 'ino-card' + (opts.full ? ' ino-card-full' : '');
    return '<section class="' + cls + '"><h2 class="ino-card-title">' + escapeHtml(title) + '</h2><div class="ino-card-body">' + body + '</div></section>';
  }

  function renderSummary(summary) {
    var h = '<div class="ino-summary-grid">';
    h += '<div class="ino-stat"><div class="ino-stat-value">' + escapeHtml(summary.totalAlerts) + '</div><div class="ino-stat-label">アラート総数</div></div>';
    h += '<div class="ino-stat ino-stat-open"><div class="ino-stat-value">' + escapeHtml(summary.openCount) + '</div><div class="ino-stat-label">OPEN</div></div>';
    h += '<div class="ino-stat ino-stat-ongoing"><div class="ino-stat-value">' + escapeHtml(summary.ongoingCount) + '</div><div class="ino-stat-label">ONGOING</div></div>';
    h += '<div class="ino-stat ino-stat-reopened"><div class="ino-stat-value">' + escapeHtml(summary.reopenedCount) + '</div><div class="ino-stat-label">REOPENED</div></div>';
    h += '<div class="ino-stat ino-stat-resolved"><div class="ino-stat-value">' + escapeHtml(summary.resolvedCount) + '</div><div class="ino-stat-label">RESOLVED</div></div>';
    h += '</div>';
    h += '<div class="ino-severity-bar">';
    h += '<span class="ino-sev ino-severity-critical">critical ' + escapeHtml(summary.severityCounts.critical) + '</span>';
    h += '<span class="ino-sev ino-severity-warning">warning ' + escapeHtml(summary.severityCounts.warning) + '</span>';
    h += '<span class="ino-sev ino-severity-info">info ' + escapeHtml(summary.severityCounts.info) + '</span>';
    h += '</div>';
    h += '<div class="ino-metric-row">';
    h += '<span class="ino-metric">データ不足・未評価: <b>' + escapeHtml(summary.unevaluatedCount) + '</b></span>';
    h += '<span class="ino-metric">actual未取得: <b>' + escapeHtml(summary.missingActualCount) + '</b></span>';
    h += '</div>';
    return h;
  }

  function renderRiskRows(rows) {
    if (!rows.length) return '<p class="ino-empty">該当する入力がありません。</p>';
    var h = '<div class="ino-table-wrap"><table class="ino-table">';
    h += '<thead><tr>';
    h += '<th>対象日</th><th>ブロック</th><th>時間</th><th>必要台数</th><th>計画台数</th><th>不足台数</th><th>severity</th><th>状態</th><th>最終検知時刻</th>';
    h += '</tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      h += '<tr>';
      h += '<td>' + escapeHtml(r.localDate) + '</td>';
      h += '<td>' + escapeHtml(r.block) + '</td>';
      h += '<td>' + escapeHtml(formatNumber(r.hours)) + 'h</td>';
      h += '<td>' + escapeHtml(formatNumber(r.expected)) + '</td>';
      h += '<td>' + (r.actualMissing ? '<span class="ino-missing">未取得</span>' : escapeHtml(formatNumber(r.actual))) + '</td>';
      h += '<td>' + (r.shortage === null ? '—' : escapeHtml(formatNumber(r.shortage))) + '</td>';
      h += '<td><span class="ino-pill ' + severityClass(r.severity) + '">' + escapeHtml(r.severity || 'none') + '</span></td>';
      h += '<td><span class="ino-pill ' + statusClass(r.status) + '">' + escapeHtml(r.status) + '</span></td>';
      h += '<td>' + escapeHtml(formatDateTime(r.lastDetectedAt)) + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return h;
  }

  function renderHistory(records) {
    if (!records.length) return '<p class="ino-empty">アラート履歴はありません。</p>';
    var h = '<div class="ino-history-list">';
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      h += '<div class="ino-history-item">';
      h += '<div class="ino-history-header">';
      h += '<code class="ino-key">' + escapeHtml(r.alertKey) + '</code>';
      h += '<span class="ino-pill ' + statusClass(r.status) + '">' + escapeHtml(r.status) + '</span>';
      h += '<span class="ino-pill ' + severityClass(r.severity) + '">' + escapeHtml(r.severity) + '</span>';
      if (r.acknowledgedAt) h += '<span class="ino-pill ino-status-ack">acknowledged</span>';
      h += '</div>';
      h += '<div class="ino-history-meta">';
      h += '初回: ' + escapeHtml(formatDateTime(r.firstDetectedAt));
      h += ' / 最終: ' + escapeHtml(formatDateTime(r.lastDetectedAt));
      h += ' / 検知回数: ' + escapeHtml(r.occurrenceCount);
      h += '</div>';
      if (isArr(r.transitionHistory) && r.transitionHistory.length) {
        h += '<ul class="ino-transition-list">';
        for (var j = 0; j < r.transitionHistory.length; j++) {
          var t = r.transitionHistory[j];
          h += '<li>';
          h += escapeHtml(t.from || '(なし)') + ' → ' + escapeHtml(t.to);
          h += ' <span class="ino-transition-at">' + escapeHtml(formatDateTime(t.at)) + '</span>';
          h += ' <span class="ino-transition-reason">' + escapeHtml(t.reason) + '</span>';
          h += '</li>';
        }
        h += '</ul>';
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  function renderDryRun(dryRun) {
    var summary = isObj(dryRun.summary) ? dryRun.summary : {};
    var h = '<div class="ino-dryrun-banner">' + escapeHtml('Dry-run専用・実通知なし') + '</div>';
    h += '<div class="ino-metric-row">';
    h += '<span class="ino-metric">候補数: <b>' + escapeHtml(summary.total || 0) + '</b></span>';
    h += '<span class="ino-metric">eligible: <b>' + escapeHtml(summary.eligible || 0) + '</b></span>';
    h += '<span class="ino-metric">suppressed: <b>' + escapeHtml(summary.suppressed || 0) + '</b></span>';
    h += '</div>';
    if (isObj(summary.byReason)) {
      var reasons = Object.keys(summary.byReason);
      if (reasons.length) {
        h += '<div class="ino-suppression-reasons">抑止理由: ';
        for (var i = 0; i < reasons.length; i++) {
          var k = reasons[i];
          h += '<span class="ino-reason-chip">' + escapeHtml(k) + ' ' + escapeHtml(summary.byReason[k]) + '</span>';
        }
        h += '</div>';
      }
    }
    if (isArr(dryRun.candidates) && dryRun.candidates.length) {
      h += '<div class="ino-candidate-list">';
      for (var j = 0; j < dryRun.candidates.length; j++) {
        var c = dryRun.candidates[j];
        h += '<div class="ino-candidate">';
        h += '<div class="ino-candidate-title">' + escapeHtml(c.title) + ' <span class="ino-pill ' + (c.eligibility === 'eligible' ? 'ino-status-normal' : 'ino-status-ongoing') + '">' + escapeHtml(c.eligibility) + '</span></div>';
        h += '<div class="ino-candidate-message">' + escapeHtml(c.message) + '</div>';
        h += '<div class="ino-candidate-meta">';
        h += 'alertKey: ' + escapeHtml(c.alertKey) + ' / ';
        h += 'status: ' + escapeHtml(c.alertStatus) + ' / ';
        h += 'dedup: ' + escapeHtml(c.deduplicationKey);
        if (c.suppressionReason) h += ' <span class="ino-reason-chip">' + escapeHtml(c.suppressionReason) + '</span>';
        h += '</div>';
        if (isArr(dryRun.previews) && dryRun.previews[j]) {
          h += '<pre class="ino-preview">' + escapeHtml(dryRun.previews[j]) + '</pre>';
        }
        h += '</div>';
      }
      h += '</div>';
    } else {
      h += '<p class="ino-empty">通知候補はありません。</p>';
    }
    return h;
  }

  function renderDiagnostics(d) {
    var h = '<div class="ino-diagnostics-grid">';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">入力件数</span><span class="ino-diag-value">' + escapeHtml(d.inputCount) + '</span></div>';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">正常なCanonical Input</span><span class="ino-diag-value">' + escapeHtml(d.validCount) + '</span></div>';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">不正データ</span><span class="ino-diag-value">' + escapeHtml(d.invalidCount) + '</span></div>';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">actual未取得</span><span class="ino-diag-value">' + escapeHtml(d.missingActualCount) + '</span></div>';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">最終評価日時</span><span class="ino-diag-value">' + escapeHtml(formatDateTime(d.lastEvaluatedAt)) + '</span></div>';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">永続化エラー</span><span class="ino-diag-value">' + (d.persistenceErrors ? 'あり' : 'なし') + '</span></div>';
    h += '<div class="ino-diag-item ino-diag-wide"><span class="ino-diag-label">データ取得元</span><span class="ino-diag-value">' + escapeHtml(d.dataSource) + '</span></div>';
    h += '</div>';
    return h;
  }

  function rollingCountText(n) {
    if (n === null || n === undefined || n === '') return '—';
    return String(n);
  }

  function rollingStatusClass(status) {
    if (status === 'success') return 'ino-status-resolved';
    if (status === 'partial') return 'ino-status-ongoing';
    if (status === 'failed' || status === 'expired') return 'ino-status-open';
    return 'ino-status-missing';
  }

  function rollingRowClass(disposition) {
    if (disposition === 'exceed' || disposition === 'partial-exceed') return 'ino-rolling-row-exceed';
    if (disposition === 'approach' || disposition === 'partial-approach') return 'ino-rolling-row-approach';
    if (disposition === 'undetermined') return 'ino-rolling-row-undetermined';
    if (disposition === 'partial') return 'ino-rolling-row-partial';
    if (disposition === 'resolved') return 'ino-rolling-row-resolved';
    return '';
  }

  function rollingHourCell(hours) {
    if (typeof hours !== 'number' || !isFinite(hours)) return '取得不可';
    return (Math.round(hours * 10) / 10).toFixed(1);
  }

  function rollingForecastCell(row) {
    if (row.basis !== 'forecast' && row.basis !== 'plan') return '取得不可';
    return typeof row.totalHours === 'number' ? row.totalHoursText || rollingHourCell(row.totalHours) : '取得不可';
  }

  function rollingDutyCell(duty, legacy) {
    if (duty === 'work') return '当日勤務あり';
    if (duty === 'off') return '当日休み';
    if (duty === 'unknown') return '勤務予定未確認';
    return legacy ? '旧集計' : '勤務予定未確認';
  }

  function rollingGapCell(row) {
    var base = (row.disposition === 'approach' || row.disposition === 'partial-approach') ? row.preTodayHours : row.totalHours;
    var kind = (row.disposition === 'approach' || row.disposition === 'partial-approach') ? 'approach'
      : (row.disposition === 'exceed' || row.disposition === 'partial-exceed') ? 'exceed' : '';
    if (!kind || typeof base !== 'number') return '取得不可';
    var minutes = Math.round(Math.abs((kind === 'approach' ? 60 - base : base - 60)) * 60);
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    var label = kind === 'approach' ? '残り' : (row.basis === 'actual' ? '実績超過' : '予測超過');
    return label + h + '時間' + m + '分';
  }

  function rollingAddDays(iso, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
    var parts = iso.split('-').map(Number);
    var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    date.setUTCDate(date.getUTCDate() + days);
    var month = date.getUTCMonth() + 1;
    var day = date.getUTCDate();
    return date.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
  }

  function rollingReferenceDate(view) {
    if (view && /^\d{4}-\d{2}-\d{2}$/.test(view.referenceDate || '')) return view.referenceDate;
    var ends = {};
    var rows = view && view.alerts || [];
    for (var i = 0; i < rows.length; i++) {
      var end = rows[i] && rows[i].preTodayEnd;
      if (/^\d{4}-\d{2}-\d{2}$/.test(end || '')) ends[end] = true;
    }
    var keys = Object.keys(ends);
    if (keys.length !== 1) return '';
    return rollingAddDays(keys[0], 1);
  }

  function rollingWindowClass(row, referenceDate) {
    var disposition = row && row.disposition ? row.disposition : '';
    if (disposition === 'resolved') return 'resolved';
    if (disposition === 'partial') return 'partial';
    if (disposition === 'approach' || disposition === 'partial-approach') return 'approach';
    if (disposition === 'exceed' || disposition === 'partial-exceed') {
      var end = row && row.endDate ? row.endDate : '';
      if (!referenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return 'unconfirmed';
      if (end === referenceDate) return 'today';
      if (end < referenceDate) return 'past';
      if (end > referenceDate) return 'future';
    }
    return 'unconfirmed';
  }

  function rollingWindowLabel(kind) {
    if (kind === 'today') return '今日の7日窓で超過';
    if (kind === 'past') return '過去の7日窓で超過';
    if (kind === 'future') return '未来の7日窓の予測超過';
    if (kind === 'approach') return '接近警告';
    if (kind === 'partial') return '一部取得';
    if (kind === 'resolved') return '超過解消';
    return '未確認';
  }

  function rollingWindowCounts(rows, referenceDate) {
    var counts = { today: 0, past: 0, future: 0, approach: 0, partial: 0, resolved: 0, unconfirmed: 0 };
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var kind = rollingWindowClass(list[i], referenceDate);
      if (!Object.prototype.hasOwnProperty.call(counts, kind)) kind = 'unconfirmed';
      counts[kind] += 1;
    }
    return counts;
  }

  function renderRollingRows(rows, legacy, referenceDate) {
    if (!rows || !rows.length) return '<p class="ino-empty">該当なし</p>';
    var h = '<div class="ino-table-wrap"><table class="ino-table ino-rolling-table">';
    h += '<thead><tr>';
    h += '<th>対象者</th><th>判定区分</th><th>今日の勤務状態</th><th>対象7日窓</th><th>判定対象累計</th><th>合計労働時間</th><th>実績時間</th><th>予定込み予測</th><th>超過時間または残り時間</th><th>超過時間</th><th>保存された判定</th><th>実績・予定</th><th>前回からの変化</th><th>データ取得日時</th>';
    h += '</tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var kind = rollingWindowClass(row, referenceDate);
      h += '<tr class="' + rollingRowClass(row.disposition) + '" data-ino-rolling-window="' + kind + '">';
      h += '<td>' + escapeHtml(row.name || '氏名未照合');
      if (row.transportId) h += '<div class="ino-rolling-id">' + escapeHtml(row.transportId) + '</div>';
      h += '</td>';
      h += '<td>' + escapeHtml(rollingWindowLabel(kind)) + '</td>';
      h += '<td>' + escapeHtml(rollingDutyCell(row.todayDuty, legacy)) + '</td>';
      h += '<td>' + escapeHtml(row.startDate && row.endDate ? (row.startDate + ' 〜 ' + row.endDate) : (row.windowLabel && row.windowLabel !== '—' ? row.windowLabel : '未確認'));
      if (row.extraWindows) h += '<div class="ino-rolling-extra">他' + escapeHtml(row.extraWindows) + '窓</div>';
      h += '</td>';
      h += '<td>' + escapeHtml(typeof row.preTodayHours === 'number' ? (Math.round(row.preTodayHours * 10) / 10).toFixed(1) : '取得不可');
      if (row.preTodayStart && row.preTodayEnd) h += '<div class="ino-rolling-extra">' + escapeHtml(row.preTodayStart + ' 〜 ' + row.preTodayEnd) + '</div>';
      h += '</td>';
      h += '<td>' + escapeHtml(row.totalHoursText || '—') + '</td>';
      h += '<td>' + escapeHtml(rollingHourCell(row.actualHours)) + '</td>';
      h += '<td>' + escapeHtml(rollingForecastCell(row)) + '</td>';
      h += '<td>' + escapeHtml(rollingGapCell(row)) + '</td>';
      h += '<td>' + escapeHtml(row.overByText || '—') + '</td>';
      h += '<td><span class="ino-pill ' + rollingStatusClass(row.disposition === 'exceed' || row.disposition === 'partial-exceed' ? 'failed' : row.disposition === 'approach' || row.disposition === 'partial-approach' ? 'partial' : row.disposition === 'resolved' ? 'success' : 'missing') + '">' + escapeHtml(row.statusLabel || '判定不能') + '</span></td>';
      h += '<td><span class="ino-pill ' + (row.basis === 'actual' ? 'ino-status-open' : row.basis === 'forecast' ? 'ino-status-ongoing' : 'ino-status-missing') + '">' + escapeHtml(row.basisLabel || '根拠なし') + '</span></td>';
      h += '<td>' + escapeHtml(row.change || '変化なし') + '</td>';
      h += '<td>' + escapeHtml(formatDateTime(row.checkedAt)) + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return h;
  }

  function renderRollingSections(rows, legacy, referenceDate) {
    var groups = { today: [], past: [], future: [], approach: [], partial: [], resolved: [], unconfirmed: [] };
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var kind = rollingWindowClass(list[i], referenceDate);
      if (!groups[kind]) kind = 'unconfirmed';
      groups[kind].push(list[i]);
    }
    var order = [
      ['today', '今日で終わる7日窓の超過'],
      ['past', '過去の7日窓で検出された超過'],
      ['future', '未来の7日窓で予測される超過'],
      ['approach', '接近警告'],
      ['partial', '一部取得'],
      ['resolved', '超過解消'],
      ['unconfirmed', '未確認'],
    ];
    var h = '';
    for (var s = 0; s < order.length; s++) {
      var key = order[s][0];
      var section = groups[key];
      if (!section.length && key !== 'today') continue;
      h += '<section class="ino-rolling-section" data-ino-rolling-section="' + key + '">';
      h += '<h3 class="ino-rolling-subtitle">' + order[s][1] + ' <span data-ino-rolling-count="' + key + '">' + section.length + '</span></h3>';
      h += section.length ? renderRollingRows(section, legacy, referenceDate) : '<p class="ino-empty">該当なし</p>';
      h += '</section>';
    }
    return h;
  }

  function renderRolling(view) {
    view = view || emptyRollingView();
    var counts = view.counts || {};
    var changes = view.changes || {};
    var failed = view.fetchStatus === 'failed' || view.fetchStatus === 'expired';
    var legacy = view.approachRule !== 'prefix6-margin11';
    var referenceDate = rollingReferenceDate(view);
    var windows = rollingWindowCounts(view.alerts || [], referenceDate);
    var h = '<div id="ino-rolling-panel" data-ino-rolling-panel="1">';
    if (legacy && view.checkedAt) h += '<div class="ino-rolling-banner ino-rolling-banner-failed">この表示は旧ルールの保存済み集計です。接近人数は60時間ちょうどの件数です。11時間前の接近は、次の集計が保存されたあと表示します。</div>';
    if (view.notice) h += '<div class="ino-rolling-banner ino-rolling-banner-failed">' + escapeHtml(view.notice) + '</div>';
    if (failed) h += '<div class="ino-rolling-banner ino-rolling-banner-failed">今回の取得は成功していません。上の人数は今回の結果ではありません。</div>';
    h += '<div class="ino-metric-row">';
    h += '<span class="ino-metric">最終データ取得日時: <b>' + escapeHtml(view.checkedAt ? formatDateTime(view.checkedAt) : '未取得') + '</b></span>';
    h += '<span class="ino-pill ' + rollingStatusClass(view.fetchStatus) + '">HARVEST取得状態 ' + escapeHtml(view.fetchLabel || 'データ未取得') + '</span>';
    h += '</div>';
    h += '<div class="ino-summary-grid ino-rolling-grid">';
    h += '<div class="ino-stat"><div class="ino-stat-value" data-ino-rolling-count="drivers">' + escapeHtml(rollingCountText(counts.driverCount)) + '</div><div class="ino-stat-label">判定対象人数</div></div>';
    h += '<div class="ino-stat ino-stat-resolved"><div class="ino-stat-value" data-ino-rolling-count="clear">' + escapeHtml(rollingCountText(counts.clearCount)) + '</div><div class="ino-stat-label">正常人数</div></div>';
    h += '<div class="ino-stat ino-stat-ongoing"><div class="ino-stat-value" data-ino-rolling-count="approach">' + escapeHtml(rollingCountText(counts.approachCount)) + '</div><div class="ino-stat-label">' + (legacy ? '旧ルール接近人数' : '60h接近人数') + '</div></div>';
    h += '<div class="ino-stat ino-stat-open"><div class="ino-stat-value" data-ino-rolling-count="exceed">' + escapeHtml(rollingCountText(counts.exceedCount)) + '</div><div class="ino-stat-label">ローリング窓の超過</div></div>';
    h += '<div class="ino-stat ino-stat-reopened"><div class="ino-stat-value" data-ino-rolling-count="partial">' + escapeHtml(rollingCountText(counts.partialCount)) + '</div><div class="ino-stat-label">一部取得人数</div></div>';
    h += '<div class="ino-stat"><div class="ino-stat-value" data-ino-rolling-count="undetermined">' + escapeHtml(rollingCountText(counts.undeterminedCount)) + '</div><div class="ino-stat-label">判定不能人数</div></div>';
    h += '<div class="ino-stat"><div class="ino-stat-value" data-ino-rolling-count="duty">' + escapeHtml(legacy ? '旧集計' : rollingCountText(counts.dutyUnconfirmedCount)) + '</div><div class="ino-stat-label">勤務予定未確認</div></div>';
    h += '</div>';
    h += '<div class="ino-metric-row"><span class="ino-metric">前回取得からの変化: 新規超過 <b>' + escapeHtml(changes.newExceed || 0) + '</b> / 継続超過 <b>' + escapeHtml(changes.ongoingExceed || 0) + '</b> / 超過解消 <b>' + escapeHtml(changes.resolvedExceed || 0) + '</b> / 判定不能への変化 <b>' + escapeHtml(changes.becameUndetermined || 0) + '</b> / データ更新なし <b>' + escapeHtml(changes.dataUnchanged ? 'あり' : 'なし') + '</b></span></div>';
    var basisCounts = view.basisCounts || {};
    h += '<div class="ino-metric-row"><span class="ino-metric">根拠: 実績超過 <b>' + escapeHtml(basisCounts.actualExceed || 0) + '</b> / 超過予測 <b>' + escapeHtml(basisCounts.forecastExceed || 0) + '</b> / 予定を含む <b>' + escapeHtml(basisCounts.planExceed || 0) + '</b> / 根拠なし <b>' + escapeHtml(basisCounts.unknownExceed || 0) + '</b></span></div>';
    h += '<div class="ino-metric-row"><span class="ino-metric">日付窓: 今日の7日窓の超過 <b data-ino-rolling-count="todayExceed">' + windows.today + '</b> / 過去の7日窓の超過 <b data-ino-rolling-count="pastExceed">' + windows.past + '</b> / 未来の7日窓の予測超過 <b data-ino-rolling-count="futureExceed">' + windows.future + '</b> / 超過解消 <b data-ino-rolling-count="resolvedRows">' + windows.resolved + '</b> / 未確認 <b data-ino-rolling-count="windowUnknown">' + windows.unconfirmed + '</b></span></div>';
    if (!referenceDate) h += '<div class="ino-rolling-banner ino-rolling-banner-window">基準日が保存データにないため、今日の窓か別の窓かは未確認です。</div>';
    else if (windows.today === 0) h += '<div class="ino-rolling-banner ino-rolling-banner-window">今日で終わる7日窓の超過は0名です。ローリング窓の超過は、過去または未来の別の7日窓です。基準日は ' + escapeHtml(referenceDate) + ' です。</div>';
    if (view.missingShiftMonths) {
      h += '<div class="ino-metric-row"><span class="ino-metric">シフト未提出: <b>' + escapeHtml(view.missingShiftMonths) + '</b>（月をまたぐ7日はデータ不足。空白を休日にはせず、実績確定にもしない）</span></div>';
    }
    if (view.approachNote) h += '<p class="ino-rolling-note">' + escapeHtml(view.approachNote) + '</p>';
    h += '<div class="ino-rolling-actions">';
    h += '<button type="button" class="ino-rolling-button" data-ino-rolling-action="reload">表示を更新</button>';
    h += '<button type="button" class="ino-rolling-button ino-rolling-button-strong" data-ino-rolling-action="collect">今すぐ回収</button>';
    h += '</div>';
    h += '<h3 class="ino-rolling-subtitle">現在の警告一覧</h3>';
    h += renderRollingSections(view.alerts || [], legacy, referenceDate);
    if (view.lastSuccess) {
      var prev = view.lastSuccess;
      var prevCounts = prev.counts || {};
      h += '<section class="ino-rolling-previous">';
      h += '<h3 class="ino-rolling-subtitle">前回取得分</h3>';
      h += '<p class="ino-rolling-note">前回取得分です。最新の判定結果ではありません。取得日時: ' + escapeHtml(prev.checkedAt ? formatDateTime(prev.checkedAt) : '不明') + '</p>';
      h += '<div class="ino-metric-row">';
      h += '<span class="ino-metric">対象 ' + escapeHtml(rollingCountText(prevCounts.driverCount)) + '</span>';
      h += '<span class="ino-metric">正常 ' + escapeHtml(rollingCountText(prevCounts.clearCount)) + '</span>';
      h += '<span class="ino-metric">超過 ' + escapeHtml(rollingCountText(prevCounts.exceedCount)) + '</span>';
      h += '<span class="ino-metric">接近 ' + escapeHtml(rollingCountText(prevCounts.approachCount)) + '</span>';
      h += '<span class="ino-metric">一部取得 ' + escapeHtml(rollingCountText(prevCounts.partialCount)) + '</span>';
      h += '<span class="ino-metric">判定不能 ' + escapeHtml(rollingCountText(prevCounts.undeterminedCount)) + '</span>';
      h += '</div>';
      h += renderRollingSections(prev.alerts || [], true, rollingReferenceDate(prev));
      h += '</section>';
    }
    h += '</div>';
    return h;
  }

  var rollingHost = null;
  var rollingState = null;

  function threeWayStatusLabel(status) {
    if (status === 'match') return '3点一致';
    if (status === 'mismatch') return '台数不一致';
    if (status === 'missing') return 'データ未取得';
    if (status === 'source_conflict') return '同一ソース内の衝突';
    if (status === 'measure_mismatch') return '人数とコース台数の別件数';
    return status || '不明';
  }

  function threeWayCount(value) {
    if (Array.isArray(value)) return value.join(' / ');
    if (value == null) return '未取得';
    return String(value);
  }

  function renderThreeWay(result) {
    var summary = result.summary || {};
    var h = '<p class="ino-rolling-note">固定台数マスタの欠車判定とは別です。日付・サイクル・車種・数え方が3ソースとも揃った行だけを一致にします。</p>';
    h += '<div class="ino-metric-row">';
    h += '<span class="ino-metric">3点一致 <b>' + escapeHtml(summary.match || 0) + '</b></span>';
    h += '<span class="ino-metric">台数不一致 <b>' + escapeHtml(summary.mismatch || 0) + '</b></span>';
    h += '<span class="ino-metric">データ未取得 <b>' + escapeHtml(summary.missing || 0) + '</b></span>';
    h += '<span class="ino-metric">同一ソース内の衝突 <b>' + escapeHtml(summary.source_conflict || 0) + '</b></span>';
    h += '</div>';
    var rows = (result.rows || []).filter(function (row) { return row.status !== 'match'; });
    (result.measureSplits || []).forEach(function (split) { rows.push(split); });
    if (!rows.length) {
      h += '<p class="ino-rolling-note">不一致・未取得・衝突はありません。</p>';
      return h;
    }
    h += '<table class="ino-table"><thead><tr><th>状態</th><th>日付</th><th>サイクル</th><th>車種</th><th>数え方</th><th>入力サイト</th><th>スケジュール</th><th>社内Excel</th></tr></thead><tbody>';
    rows.forEach(function (row) {
      var counts = row.counts || {};
      h += '<tr><td>' + escapeHtml(threeWayStatusLabel(row.status)) + '</td>';
      h += '<td>' + escapeHtml(row.date || '') + '</td>';
      h += '<td>' + escapeHtml(row.cycle || '') + '</td>';
      h += '<td>' + escapeHtml(row.vehicle || '') + '</td>';
      h += '<td>' + escapeHtml(row.measure === 'people' ? '人数' : (row.measure === 'courses' ? 'コース台数' : '')) + '</td>';
      h += '<td>' + escapeHtml(threeWayCount(counts.amazon_input)) + '</td>';
      h += '<td>' + escapeHtml(threeWayCount(counts.amazon_schedule)) + '</td>';
      h += '<td>' + escapeHtml(threeWayCount(counts.internal_excel)) + '</td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  var commandUi = { tab: 'overview', date: '', cycle: '' };
  var COMMAND_TABS = [
    ['overview', '概要'],
    ['fleet', '台数照合'],
    ['da', 'DA・シフト'],
    ['fetch', 'データ取得'],
    ['process', '処理エラー'],
    ['system', 'システム状態'],
    ['history', 'アラート履歴']
  ];

  function commandTime(value) {
    if (!value) return '未確認';
    var formatted = formatDateTime(value);
    return formatted === '不明' ? '未確認' : formatted;
  }

  function commandNumber(value) {
    if (value == null) return '未確認';
    return String(value);
  }

  function toneClass(tone) {
    if (tone === 'critical') return 'ino-tone-critical';
    if (tone === 'warning') return 'ino-tone-warning';
    if (tone === 'clear') return 'ino-tone-clear';
    if (tone === 'info') return 'ino-tone-info';
    return 'ino-tone-unknown';
  }

  function severityWord(severity) {
    if (severity === 'critical') return '重大';
    if (severity === 'warning') return '注意';
    if (severity === 'info') return '情報';
    return '未確認';
  }

  function statusWord(status) {
    if (status === 'active') return '未解消';
    if (status === 'resolved') return '解消';
    return '未確認';
  }

  function categoryLabel(id) {
    if (id === 'fleet_count') return '台数照合';
    if (id === 'da_shift') return 'DA・シフト';
    if (id === 'data_fetch') return 'データ取得';
    if (id === 'processing_error') return '処理エラー';
    if (id === 'system_status') return 'システム状態';
    return '未確認';
  }

  function tabForCategory(id) {
    if (id === 'fleet_count') return 'fleet';
    if (id === 'da_shift') return 'da';
    if (id === 'data_fetch') return 'fetch';
    if (id === 'processing_error') return 'process';
    if (id === 'system_status') return 'system';
    return 'overview';
  }

  function alertVisible(item) {
    if (commandUi.date && item.target_date !== commandUi.date) return false;
    if (commandUi.cycle && item.cycle !== commandUi.cycle) return false;
    return true;
  }

  function fleetRowVisible(row) {
    if (commandUi.date && row.date !== commandUi.date) return false;
    if (commandUi.cycle && row.cycle !== commandUi.cycle) return false;
    return true;
  }

  function fleetCountCell(value) {
    if (Array.isArray(value)) return escapeHtml(value.join(' / '));
    if (value == null || value === '') return '未取得';
    return escapeHtml(String(value));
  }

  function measureLabel(measure) {
    if (measure === 'people') return '人数';
    if (measure === 'courses') return 'コース台数';
    return '未確認';
  }

  function renderStatusBar(command) {
    var cells = [
      ['running', 'INO-1稼働状態', command.runningLabel || '未確認', ''],
      ['today', '本日のアラート', commandNumber(command.todayTotal), ''],
      ['critical', '重大', commandNumber(command.critical), command.critical > 0 ? ' ino-tone-critical' : ''],
      ['warning', '注意', commandNumber(command.warning), command.warning > 0 ? ' ino-tone-warning' : ''],
      ['fetch', 'データ取得状態', command.fetchLabel || '未確認', command.fetchLabel && command.fetchLabel !== '取得済み' ? ' ino-tone-unknown' : ''],
      ['updated', '最終更新', commandTime(command.updatedAt), '']
    ];
    var h = '<section id="ino-status-bar" class="ino-status-bar" aria-label="総合ステータス">';
    for (var i = 0; i < cells.length; i++) {
      h += '<div class="ino-status-cell' + cells[i][3] + '" data-ino-status="' + cells[i][0] + '">';
      h += '<div class="ino-status-label">' + escapeHtml(cells[i][1]) + '</div>';
      h += '<div class="ino-status-value">' + escapeHtml(cells[i][2]) + '</div>';
      h += '</div>';
    }
    h += '</section>';
    return h;
  }

  function renderCategoryCards(categories) {
    var h = '<section id="ino-category-cards" class="ino-cat-grid" aria-label="カテゴリ別アラート">';
    for (var i = 0; i < categories.length; i++) {
      var item = categories[i];
      h += '<button type="button" class="ino-cat-card ' + toneClass(item.tone) + '" data-ino-card="' + escapeHtml(item.id) + '" data-ino-card-state="' + escapeHtml(item.tone) + '" data-ino-tab="' + escapeHtml(item.tab) + '" onclick="InoichiDashboard.openAlertTab(this)">';
      h += '<span class="ino-cat-name">' + escapeHtml(item.label) + '</span>';
      h += '<span class="ino-cat-count">' + escapeHtml(item.countLabel) + '</span>';
      h += '<span class="ino-cat-severity">' + escapeHtml(item.severityLabel) + '</span>';
      h += '<span class="ino-cat-time">最終 ' + escapeHtml(commandTime(item.lastAt)) + '</span>';
      h += '<span class="ino-cat-summary" data-ino-card-summary>' + escapeHtml(item.summary) + '</span>';
      h += '</button>';
    }
    h += '</section>';
    return h;
  }

  function renderFilterControls(command) {
    var h = '<div class="ino-filters">';
    h += '<label>対象日 <select data-ino-filter="date" onchange="InoichiDashboard.applyCommandFilter(this)">';
    h += '<option value="">すべて</option>';
    var dates = command.dates || [];
    for (var i = 0; i < dates.length; i++) {
      h += '<option value="' + escapeHtml(dates[i]) + '"' + (commandUi.date === dates[i] ? ' selected' : '') + '>' + escapeHtml(dates[i]) + '</option>';
    }
    h += '</select></label>';
    h += '<label>サイクル <select data-ino-filter="cycle" onchange="InoichiDashboard.applyCommandFilter(this)">';
    h += '<option value="">すべて</option>';
    var cycles = command.cycles || [];
    for (var c = 0; c < cycles.length; c++) {
      h += '<option value="' + escapeHtml(cycles[c]) + '"' + (commandUi.cycle === cycles[c] ? ' selected' : '') + '>' + escapeHtml(cycles[c]) + '</option>';
    }
    h += '</select></label>';
    if (commandUi.date || commandUi.cycle) h += '<span class="ino-filter-note">絞り込み中</span>';
    h += '</div>';
    return h;
  }

  function renderTabs() {
    var h = '<div class="ino-tab-bar"><div class="ino-tabs" role="tablist">';
    for (var i = 0; i < COMMAND_TABS.length; i++) {
      var id = COMMAND_TABS[i][0];
      var selected = commandUi.tab === id;
      h += '<button type="button" class="ino-tab' + (selected ? ' is-active' : '') + '" role="tab" data-ino-tab="' + id + '" aria-selected="' + (selected ? 'true' : 'false') + '" onclick="InoichiDashboard.openAlertTab(this)">';
      h += escapeHtml(COMMAND_TABS[i][1]) + '</button>';
    }
    h += '</div>';
    return h;
  }

  function renderActiveList(command) {
    var list = [];
    var alerts = command.alerts || [];
    for (var i = 0; i < alerts.length; i++) {
      var item = alerts[i];
      if (item.status !== 'active') continue;
      if (item.severity !== 'critical' && item.severity !== 'warning') continue;
      if (!alertVisible(item)) continue;
      list.push(item);
    }
    list.sort(function (a, b) {
      var rank = { critical: 0, warning: 1 };
      var diff = (rank[a.severity] || 9) - (rank[b.severity] || 9);
      if (diff !== 0) return diff;
      return String(b.updated_at || b.occurred_at || '').localeCompare(String(a.updated_at || a.occurred_at || ''));
    });
    if (!list.length) {
      if (commandUi.date || commandUi.cycle) return '<p class="ino-empty">絞り込みに一致するアラートはありません。</p>';
      var unclear = false;
      var categories = command.categories || [];
      for (var c = 0; c < categories.length; c++) {
        if (categories[c].tone !== 'clear') unclear = true;
      }
      var note = unclear ? '未接続・未取得・未実装の項目があります。正常とは判定していません。' : '現在の重大・注意アラートはありません。';
      return '<p class="ino-empty">' + escapeHtml(note) + '</p>';
    }
    var h = '<ul class="ino-active-list">';
    var shown = Math.min(list.length, 6);
    for (var n = 0; n < shown; n++) {
      var alertItem = list[n];
      h += '<li><button type="button" class="ino-active-jump ' + toneClass(alertItem.severity === 'critical' ? 'critical' : 'warning') + '" data-ino-tab="' + tabForCategory(alertItem.category) + '" onclick="InoichiDashboard.openAlertTab(this)">';
      h += '<span class="ino-pill ' + severityClass(alertItem.severity) + '">' + escapeHtml(severityWord(alertItem.severity)) + '</span>';
      h += '<span>' + escapeHtml(categoryLabel(alertItem.category)) + '</span>';
      h += '<span>' + escapeHtml(alertItem.summary) + '</span>';
      h += '</button></li>';
    }
    h += '</ul>';
    if (list.length > shown) h += '<p class="ino-empty">ほか ' + escapeHtml(list.length - shown) + '件は詳細タブにあります。</p>';
    return h;
  }

  function renderFleetTable(command) {
    var all = command.fleetRows || [];
    var rows = [];
    for (var i = 0; i < all.length; i++) {
      if (fleetRowVisible(all[i])) rows.push(all[i]);
    }
    if (!all.length) {
      var summary = '未接続';
      var categories = command.categories || [];
      for (var c = 0; c < categories.length; c++) {
        if (categories[c].id === 'fleet_count' && categories[c].summary) summary = categories[c].summary;
      }
      if (summary === '未接続') return '<p class="ino-empty" data-ino-fleet-state="unconnected">台数照合は未接続です。届いていない台数は0台にしません。</p>';
      return '<p class="ino-empty" data-ino-fleet-state="' + escapeHtml(summary) + '">' + escapeHtml(summary) + '。届いていない台数は0台にしません。</p>';
    }
    if (!rows.length) return '<p class="ino-empty">絞り込みに一致する行はありません。</p>';
    var h = '<div class="ino-table-wrap"><table class="ino-table ino-fleet-table">';
    h += '<thead><tr><th>対象日</th><th>サイクル</th><th>車種</th><th>数え方</th><th>拠点</th><th>Amazon入力</th><th>Amazon予定</th><th>社内Excel</th><th>判定</th><th>不一致の系統</th></tr></thead><tbody>';
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      h += '<tr data-ino-fleet-judgment="' + escapeHtml(row.judgment) + '">';
      h += '<td>' + escapeHtml(row.date || '未確認') + '</td>';
      h += '<td>' + escapeHtml(row.cycle || '未確認') + '</td>';
      h += '<td>' + escapeHtml(row.vehicle || '未確認') + '</td>';
      h += '<td>' + escapeHtml(measureLabel(row.measure)) + '</td>';
      h += '<td>' + escapeHtml(row.site || '未確認') + '</td>';
      h += '<td>' + fleetCountCell(row.counts && row.counts.amazon_input) + '</td>';
      h += '<td>' + fleetCountCell(row.counts && row.counts.amazon_schedule) + '</td>';
      h += '<td>' + fleetCountCell(row.counts && row.counts.internal_excel) + '</td>';
      h += '<td>' + escapeHtml(row.judgment || '判定保留') + '</td>';
      h += '<td>' + escapeHtml(row.divergentLabel || '—') + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return h;
  }

  function renderAlertTable(alerts) {
    if (!alerts.length) return '<p class="ino-empty">該当するアラートはありません。</p>';
    var h = '<div class="ino-table-wrap"><table class="ino-table">';
    h += '<thead><tr><th>状態</th><th>重大度</th><th>種別</th><th>対象日</th><th>サイクル</th><th>概要</th><th>詳細</th><th>対応</th></tr></thead><tbody>';
    for (var i = 0; i < alerts.length; i++) {
      var item = alerts[i];
      h += '<tr>';
      h += '<td>' + escapeHtml(statusWord(item.status)) + '</td>';
      h += '<td>' + escapeHtml(severityWord(item.severity)) + '</td>';
      h += '<td>' + escapeHtml(categoryLabel(item.category)) + '</td>';
      h += '<td>' + escapeHtml(item.target_date || '未確認') + '</td>';
      h += '<td>' + escapeHtml(item.cycle || '—') + '</td>';
      h += '<td>' + escapeHtml(item.summary) + '</td>';
      h += '<td>' + escapeHtml(item.detail) + '</td>';
      h += '<td>' + escapeHtml(item.action_required || '—') + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return h;
  }

  function alertsFor(command, category) {
    var out = [];
    var alerts = command.alerts || [];
    for (var i = 0; i < alerts.length; i++) {
      if (category && alerts[i].category !== category) continue;
      if (!alertVisible(alerts[i])) continue;
      out.push(alerts[i]);
    }
    return out;
  }

  function renderCommand(state) {
    var command = state.command;
    var h = renderStatusBar(command);
    h += renderTabs();
    h += renderFilterControls(command);
    h += '</div>';
    h += '<section' + panelOpen('overview') + '>';
    h += renderCategoryCards(command.categories || []);
    h += '<h2 class="ino-card-title">いま見ること</h2>';
    h += renderActiveList(command);
    h += '<details class="ino-legacy"><summary>既存の内訳</summary>';
    h += card('A. サマリー', renderSummary(state.summary));
    h += '</details>';
    h += '</section>';
    h += '<section' + panelOpen('fleet') + '>';
    h += '<h2 class="ino-card-title">台数照合</h2>';
    h += '<p class="ino-rolling-note">Amazon車両台数入力サイト、Amazonスケジュール画面、社内Excel InputFileが揃った行だけを比較します。欠けている値は0台にしません。</p>';
    h += renderFleetTable(command);
    var notes = command.fleetNotes || [];
    for (var n = 0; n < notes.length; n++) h += '<p class="ino-rolling-note">' + escapeHtml(notes[n]) + '</p>';
    if (state.threeWay) h += card('F. 車両台数3点照合', renderThreeWay(state.threeWay), { full: true });
    h += '</section>';
    h += '<section' + panelOpen('da') + '>';
    h += '<h2 class="ino-card-title">DA・シフト</h2>';
    h += '<ul class="ino-contract-list">';
    var contract = command.daContract || [];
    for (var d = 0; d < contract.length; d++) {
      h += '<li data-ino-da-check="' + escapeHtml(contract[d].id) + '" data-ino-implemented="' + (contract[d].implemented ? 'yes' : 'no') + '">';
      h += escapeHtml(contract[d].label) + '：' + (contract[d].implemented ? '検知する' : '未実装') + '</li>';
    }
    h += '</ul>';
    h += '<p class="ino-rolling-note">未実装の項目は検知していません。既存の欠車判定とローリング60hだけを表示します。</p>';
    h += card('B. 欠車リスク一覧', renderRiskRows(state.riskRows), { full: true });
    h += card('ローリング60h監視', renderRolling(state.rollingView));
    h += '</section>';
    h += '<section' + panelOpen('fetch') + '>';
    h += '<h2 class="ino-card-title">データ取得</h2>';
    h += renderSourceTable(command.sources || []);
    h += '</section>';
    h += '<section' + panelOpen('process') + '>';
    h += '<h2 class="ino-card-title">処理エラー</h2>';
    var processAlerts = alertsFor(command, 'processing_error');
    if (!processAlerts.length) {
      h += '<p class="ino-empty">' + (command.processingEvaluated ? '記録された処理エラーはありません。' : '未確認') + '</p>';
    } else {
      h += renderAlertTable(processAlerts);
    }
    h += card('E. 診断情報', renderDiagnostics(state.diagnostics));
    h += '</section>';
    h += '<section' + panelOpen('system') + '>';
    h += '<h2 class="ino-card-title">システム状態</h2>';
    h += renderSystem(command.system || {});
    h += card('D. 通知Dry-run', renderDryRun(state.dryRun), { full: true });
    h += '</section>';
    h += '<section' + panelOpen('history') + '>';
    h += '<h2 class="ino-card-title">アラート履歴</h2>';
    h += '<p class="ino-rolling-note">解消済みも残します。本日の重大・注意の件数には含めません。</p>';
    h += renderAlertTable(alertsFor(command, ''));
    h += card('C. アラート履歴', renderHistory(state.alertHistory), { full: true });
    h += '</section>';
    return h;
  }

  function panelOpen(id) {
    var hidden = commandUi.tab === id ? '' : ' hidden';
    return ' id="ino-tab-' + id + '" class="ino-tab-panel" role="tabpanel"' + hidden;
  }

  function renderSourceTable(sources) {
    if (!sources.length) return '<p class="ino-empty">未確認</p>';
    var h = '<div class="ino-table-wrap"><table class="ino-table">';
    h += '<thead><tr><th>ソース</th><th>接続状態</th><th>最終取得時刻</th><th>最終取得結果</th><th>失敗理由</th><th>データ鮮度</th></tr></thead><tbody>';
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i];
      h += '<tr data-ino-source="' + escapeHtml(source.id) + '">';
      h += '<td>' + escapeHtml(source.name) + '</td>';
      h += '<td>' + escapeHtml(source.connectionLabel || '未確認') + '</td>';
      h += '<td>' + escapeHtml(commandTime(source.lastFetchedAt)) + '</td>';
      h += '<td>' + escapeHtml(source.lastResult || '未確認') + '</td>';
      h += '<td>' + escapeHtml(source.failureReason || '—') + '</td>';
      h += '<td>' + escapeHtml(source.freshness || '未確認') + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return h;
  }

  function renderSystem(system) {
    var unconnected = system.unconnected && system.unconnected.length ? system.unconnected.join('、') : '未確認';
    var available = system.available && system.available.length ? system.available.join('、') : '未確認';
    var rows = [
      ['動作状態', system.running || '未確認'],
      ['最終正常処理', commandTime(system.lastSuccess)],
      ['最終エラー', system.lastError || '未確認'],
      ['監視対象数', system.monitored || '未確認'],
      ['未接続機能', unconnected],
      ['利用できる状態', available],
      ['データ取得元', system.dataSource || '未確認']
    ];
    var h = '<dl class="ino-system-list">';
    for (var i = 0; i < rows.length; i++) {
      h += '<div><dt>' + escapeHtml(rows[i][0]) + '</dt><dd>' + escapeHtml(rows[i][1]) + '</dd></div>';
    }
    h += '</dl>';
    return h;
  }

  function renderLegacyMain(state) {
    var h = '';
    h += card('ローリング60h監視', renderRolling(state.rollingView));
    h += card('A. サマリー', renderSummary(state.summary));
    h += card('B. 欠車リスク一覧', renderRiskRows(state.riskRows), { full: true });
    h += card('C. アラート履歴', renderHistory(state.alertHistory), { full: true });
    h += card('D. 通知Dry-run', renderDryRun(state.dryRun), { full: true });
    h += card('E. 診断情報', renderDiagnostics(state.diagnostics));
    if (state.threeWay) h += card('F. 車両台数3点照合', renderThreeWay(state.threeWay), { full: true });
    return h;
  }

  function renderDashboard(element, state) {
    if (!element || !state) return;
    refreshCommand(state);
    var meta = state.meta || {};
    var h = '';
    var petals = '';
    for (var pi = 0; pi < 14; pi++) { petals += '<i class="ino-petal ino-petal-' + (pi + 1) + '"></i>'; }
    h += '<div class="ino-petals" aria-hidden="true">' + petals + '</div>';
    h += '<header class="ino-header">';
    h += '<img class="ino-logo" src="./assets/inoichi-logo-light.webp" alt="INO-1 SENSORY INTELLIGENCE" decoding="async" onerror="if(!this.dataset.fb){this.dataset.fb=\'1\';this.src=\'./assets/inoichi-logo.png\';}else{this.style.display=\'none\'}">';
    h += '<div class="ino-banner">';
    h += '<div class="ino-header-tagline">人間道：勤務監視・異常検知・リスク予測（ローカル専用）</div>';
    h += '<div class="ino-header-kicker">アラート司令室</div>';
    h += '<div class="ino-header-title">' + escapeHtml(meta.title) + '</div>';
    h += '<div class="ino-header-subtitle">' + escapeHtml(meta.banner) + '</div>';
    h += '<div class="ino-header-meta">生成時刻: ' + escapeHtml(formatDateTime(meta.generatedAt)) + ' / データ取得元: ' + escapeHtml(meta.dataSource) + '</div>';
    h += '</div>';
    h += '</header>';
    h += '<main class="ino-main ino-command" data-ino-command="1">';
    h += state.command ? renderCommand(state) : renderLegacyMain(state);
    h += '</main>';
    h += '<footer class="ino-footer">INO-1 Prototype 1 Dashboard — read-only / dry-run only</footer>';
    element.innerHTML = h;
    rollingHost = element;
    rollingState = state;
  }

  function pageOffset() {
    if (typeof window === 'undefined') return null;
    return {
      x: window.pageXOffset || 0,
      y: window.pageYOffset || 0
    };
  }

  function restorePageOffset(offset) {
    if (!offset || typeof window === 'undefined' || !window.scrollTo) return;
    window.scrollTo(offset.x, offset.y);
  }

  function keepActiveTabVisible() {
    if (!rollingHost || !rollingHost.querySelector) return;
    var scroller = rollingHost.querySelector('.ino-tabs');
    var active = rollingHost.querySelector('.ino-tab.is-active');
    if (!scroller || !active) return;
    var view = scroller.getBoundingClientRect();
    var item = active.getBoundingClientRect();
    if (!view || !item) return;
    if (item.left < view.left) scroller.scrollLeft -= (view.left - item.left) + 8;
    else if (item.right > view.right) scroller.scrollLeft += (item.right - view.right) + 8;
  }

  function rerenderCommand() {
    if (!rollingState || !rollingHost) return;
    var offset = pageOffset();
    renderDashboard(rollingHost, rollingState);
    restorePageOffset(offset);
    keepActiveTabVisible();
  }

  function openAlertTab(node) {
    var tab = node && node.getAttribute ? node.getAttribute('data-ino-tab') : '';
    if (!tab) return;
    commandUi.tab = tab;
    rerenderCommand();
  }

  function applyCommandFilter(node) {
    if (!node || !node.getAttribute) return;
    var key = node.getAttribute('data-ino-filter');
    if (key !== 'date' && key !== 'cycle') return;
    commandUi[key] = node.value || '';
    rerenderCommand();
  }

  function applyRollingView(view) {
    if (!rollingState || !rollingHost) return null;
    rollingState.rollingView = view || emptyRollingView();
    renderDashboard(rollingHost, rollingState);
    return rollingState;
  }

  function ingestSequence(store, alertsByKey, now, ruleId) {
    ruleId = ruleId || 'fleet-capacity-shortage-v1';
    var Alerts = (typeof window !== 'undefined' && window.InoichiAlertStore) ? window.InoichiAlertStore : null;
    if (!Alerts) {
      try { var req = require; Alerts = req('./inoichi-alert-store.js'); } catch (e) {}
    }
    if (!Alerts) throw new Error('InoichiAlertStore not available for sample data');

    var newAlerts = [];
    var keys = Object.keys(alertsByKey);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var ev = alertsByKey[k];
      if (!ev) continue;
      newAlerts.push({
        alertId: 'sample-' + k + '-' + now,
        ruleId: ruleId,
        category: 'fleet-capacity',
        sourceDataType: 'fleet-capacity-canonical',
        localDate: ev.localDate,
        severity: ev.severity,
        detectedAt: now,
        evidence: ev
      });
    }
    Alerts.ingest(store, { alerts: newAlerts }, { now: now });
  }

  function generateSampleStore(opts) {
    opts = opts || {};
    var Alerts = (typeof window !== 'undefined' && window.InoichiAlertStore) ? window.InoichiAlertStore : null;
    if (!Alerts) {
      try { var req = require; Alerts = req('./inoichi-alert-store.js'); } catch (e) {}
    }
    if (!Alerts) throw new Error('InoichiAlertStore not available');

    var store = Alerts.createStore();
    var ruleId = opts.ruleId || 'fleet-capacity-shortage-v1';

    // 1. OPEN alert for 2026-10-07 8h
    ingestSequence(store, {
      'fleet-capacity-shortage-v1|2026-10-07|8': {
        localDate: '2026-10-07', block: '8B', hours: 8, expected: 12, actual: 10, shortage: 2,
        severity: 'warning'
      }
    }, '2026-10-07T08:00:00.000Z', ruleId);

    // 2. ONGOING alert for 2026-10-07 6.5h
    ingestSequence(store, {
      'fleet-capacity-shortage-v1|2026-10-07|6.5': {
        localDate: '2026-10-07', block: '6B30S', hours: 6.5, expected: 16, actual: 14, shortage: 2,
        severity: 'warning'
      }
    }, '2026-10-07T08:00:00.000Z', ruleId);
    ingestSequence(store, {
      'fleet-capacity-shortage-v1|2026-10-07|6.5': {
        localDate: '2026-10-07', block: '6B30S', hours: 6.5, expected: 16, actual: 13, shortage: 3,
        severity: 'critical'
      }
    }, '2026-10-07T09:00:00.000Z', ruleId);

    // 3. REOPENED alert for 2026-10-07 4.5h
    ingestSequence(store, {
      'fleet-capacity-shortage-v1|2026-10-07|4.5': {
        localDate: '2026-10-07', block: '4B30S', hours: 4.5, expected: 16, actual: 15, shortage: 1,
        severity: 'warning'
      }
    }, '2026-10-07T08:00:00.000Z', ruleId);
    var key45 = Alerts.buildAlertKey(ruleId, '2026-10-07', 4.5);
    Alerts.ingest(store, { alerts: [] }, { evaluatedKeys: [key45], now: '2026-10-07T10:00:00.000Z' });
    ingestSequence(store, {
      'fleet-capacity-shortage-v1|2026-10-07|4.5': {
        localDate: '2026-10-07', block: '4B30S', hours: 4.5, expected: 16, actual: 14, shortage: 2,
        severity: 'warning'
      }
    }, '2026-10-07T11:00:00.000Z', ruleId);

    // 4. RESOLVED alert for 2026-10-07 3h
    ingestSequence(store, {
      'fleet-capacity-shortage-v1|2026-10-07|3': {
        localDate: '2026-10-07', block: '3B', hours: 3, expected: 4, actual: 3, shortage: 1,
        severity: 'info'
      }
    }, '2026-10-07T08:00:00.000Z', ruleId);
    var key3 = Alerts.buildAlertKey(ruleId, '2026-10-07', 3);
    Alerts.ingest(store, { alerts: [] }, { evaluatedKeys: [key3], now: '2026-10-07T10:00:00.000Z' });

    // 5. actual未取得 and 8. アラート0件 entries are in canonicalInputs only, not alerts.
    // 6. invalid inputs handled by fleet diagnostics.
    // 7. notification dry-run suppression handled by using sample rule.

    return store;
  }

  function generateSampleInputs(opts) {
    opts = opts || {};
    var Adapter = (typeof window !== 'undefined' && window.InoichiFleetAdapter) ? window.InoichiFleetAdapter : null;
    if (!Adapter) {
      try { var req = require; Adapter = req('./inoichi-fleet-adapter.js'); } catch (e) {}
    }
    if (!Adapter) throw new Error('InoichiFleetAdapter not available');

    var master = [
      { block: '8B', hours: 8, count: 12 },
      { block: '6B30S', hours: 6.5, count: 16 },
      { block: '4B30S', hours: 4.5, count: 16 },
      { block: '3B', hours: 3, count: 4 },
      { block: '2B', hours: 2, count: 8 },
      { block: '', hours: 1, count: NaN }
    ];
    var dateMap = {
      '2026-10-07': { 8: 10, 6.5: 13, 4.5: 14, 3: 4, 2: undefined }
    };
    return Adapter.buildFleetCanonicalInputs(master, dateMap, { now: '2026-10-07' });
  }

  function initDashboard(opts) {
    opts = opts || {};
    var container = opts.container || document.getElementById('inoichi-dashboard');
    if (!container) return;
    var Fleet = (typeof window !== 'undefined' && window.InoichiFleetAdapter) ? window.InoichiFleetAdapter : null;
    var Core = (typeof window !== 'undefined' && window.InoichiDetectionCore) ? window.InoichiDetectionCore : null;
    var Rules = (typeof window !== 'undefined' && window.InoichiDetectionRules) ? window.InoichiDetectionRules : null;
    var Alerts = (typeof window !== 'undefined' && window.InoichiAlertStore) ? window.InoichiAlertStore : null;
    var Notification = (typeof window !== 'undefined' && window.InoichiNotificationAdapter) ? window.InoichiNotificationAdapter : null;

    var fleetResult;
    var store;
    if (opts.sampleMode !== false) {
      fleetResult = generateSampleInputs();
      store = generateSampleStore();
    } else {
      fleetResult = opts.fleetResult || { inputs: [], diagnostics: {} };
      store = opts.store || Alerts.createStore();
    }

    var canonicalInputs = isArr(fleetResult.inputs) ? fleetResult.inputs : [];

    var detectionOutputs = [];
    if (Core && Rules && canonicalInputs.length) {
      var rule = Rules.getSampleFleetCapacityRule();
      rule.enabled = true;
      for (var i = 0; i < canonicalInputs.length; i++) {
        var det = Core.detect(canonicalInputs[i], [rule], { now: opts.now });
        detectionOutputs.push(det);
      }
    }

    var dryRun = { dryRun: true, candidates: [], previews: [], summary: { total: 0, eligible: 0, suppressed: 0, byReason: {} } };
    if (Notification) {
      var alerts = [];
      if (isObj(store) && isObj(store.alerts)) {
        var keys = Object.keys(store.alerts);
        for (var j = 0; j < keys.length; j++) alerts.push(store.alerts[keys[j]]);
      }
      dryRun = Notification.createNotificationDryRun(alerts, {
        dryRun: true,
        destinations: [{ type: 'line-group', id: 'dashboard-dry-run' }],
        isSampleRule: true
      });
    }

    var state = buildDashboardState({
      canonicalInputs: canonicalInputs,
      fleetResult: fleetResult,
      store: store,
      notificationDryRun: dryRun,
      sampleMode: opts.sampleMode !== false,
      dataSource: opts.dataSource || 'サンプルデータ（本番未接続）',
      now: opts.now,
      ruleId: opts.ruleId,
      rollingView: opts.rollingView,
      threeWay: opts.threeWayResult || null
    });

    renderDashboard(container, state);
    return state;
  }

  return {
    DASHBOARD_SCHEMA_VERSION: DASHBOARD_SCHEMA_VERSION,
    escapeHtml: escapeHtml,
    formatNumber: formatNumber,
    formatDateTime: formatDateTime,
    buildAlertKey: buildAlertKey,
    buildSummary: buildSummary,
    buildRiskRows: buildRiskRows,
    buildAlertHistory: buildAlertHistory,
    buildDiagnostics: buildDiagnostics,
    buildDashboardState: buildDashboardState,
    renderDashboard: renderDashboard,
    rollingReferenceDate: rollingReferenceDate,
    rollingWindowClass: rollingWindowClass,
    rollingWindowCounts: rollingWindowCounts,
    emptyRollingView: emptyRollingView,
    applyRollingView: applyRollingView,
    generateSampleStore: generateSampleStore,
    generateSampleInputs: generateSampleInputs,
    initDashboard: initDashboard,
    openAlertTab: openAlertTab,
    applyCommandFilter: applyCommandFilter
  };
});
