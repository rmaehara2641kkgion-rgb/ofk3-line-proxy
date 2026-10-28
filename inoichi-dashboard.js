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

    return {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      meta: {
        title: 'INO-1',
        banner: opts.sampleMode ? 'サンプル表示（試験用・実運用データではありません）/ 実通知なし' : '実通知なし',
        dryRunBanner: 'Dry-run専用・実通知なし',
        generatedAt: opts.now || nowIso(),
        sampleMode: opts.sampleMode === true,
        dataSource: diagnostics.dataSource
      },
      summary: summary,
      riskRows: riskRows,
      alertHistory: alertHistory,
      dryRun: notificationDryRun,
      diagnostics: diagnostics
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

  function renderDashboard(element, state) {
    if (!element) return;
    var meta = state.meta || {};
    var h = '';
    var petals = '';
    for (var pi = 0; pi < 14; pi++) { petals += '<i class="ino-petal ino-petal-' + (pi + 1) + '"></i>'; }
    h += '<div class="ino-petals" aria-hidden="true">' + petals + '</div>';
    h += '<header class="ino-header">';
    h += '<img class="ino-logo" src="./assets/inoichi-logo-light.webp" alt="INO-1 SENSORY INTELLIGENCE" decoding="async" onerror="if(!this.dataset.fb){this.dataset.fb=\'1\';this.src=\'./assets/inoichi-logo.png\';}else{this.style.display=\'none\'}">';
    h += '<div class="ino-banner">';
    h += '<div class="ino-header-tagline">人間道：勤務監視・異常検知・リスク予測（ローカル専用）</div>';
    h += '<div class="ino-header-title">' + escapeHtml(meta.title) + '</div>';
    h += '<div class="ino-header-subtitle">' + escapeHtml(meta.banner) + '</div>';
    h += '<div class="ino-header-meta">生成時刻: ' + escapeHtml(formatDateTime(meta.generatedAt)) + ' / データ取得元: ' + escapeHtml(meta.dataSource) + '</div>';
    h += '</div>';
    h += '</header>';
    h += '<main class="ino-main">';
    h += card('A. サマリー', renderSummary(state.summary));
    h += card('B. 欠車リスク一覧', renderRiskRows(state.riskRows), { full: true });
    h += card('C. アラート履歴', renderHistory(state.alertHistory), { full: true });
    h += card('D. 通知Dry-run', renderDryRun(state.dryRun), { full: true });
    h += card('E. 診断情報', renderDiagnostics(state.diagnostics));
    h += '</main>';
    h += '<footer class="ino-footer">INO-1 — read-only / dry-run only</footer>';
    element.innerHTML = h;
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
      ruleId: opts.ruleId
    });

    renderDashboard(container, state);
    return state;
  }

  // ---- Live monitor view (real data only; no sample data) ----

  var LIVE_POLL_MS = 60000;   // gentle auto refresh; OFK3 is also cached 5s server-side
  var LIVE_STALE_MS = 3 * LIVE_POLL_MS;

  var STATUS_CLASS = {
    ok: 'ino-st-ok', warn: 'ino-st-warn', undetermined: 'ino-st-undetermined',
    failed: 'ino-st-failed', stale: 'ino-st-stale', unsupported: 'ino-st-unsupported'
  };

  function statusPill(status, label) {
    return '<span class="ino-pill ' + (STATUS_CLASS[status] || 'ino-st-undetermined') + '">' + escapeHtml(label || status) + '</span>';
  }

  function renderCardBody(c) {
    var h = '<div class="ino-live-reason">' + escapeHtml(c.reason) + '</div>';
    if (isArr(c.metrics) && c.metrics.length) {
      h += '<div class="ino-metric-row">';
      for (var i = 0; i < c.metrics.length; i++) {
        var m = c.metrics[i];
        h += '<span class="ino-metric">' + escapeHtml(m.label) + ': <b>' + (m.value === null || m.value === undefined ? '—' : escapeHtml(m.value)) + '</b></span>';
      }
      h += '</div>';
    }
    return h;
  }

  function renderDetail(c) {
    var h = '<div class="ino-live-detail" id="ino-detail-' + escapeHtml(c.id) + '">';
    h += '<div class="ino-diagnostics-grid">';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">状態</span><span class="ino-diag-value">' + escapeHtml(c.statusLabel) + '</span></div>';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">データ取得元</span><span class="ino-diag-value">' + escapeHtml(c.source || '—') + '</span></div>';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">判定時刻（OFK3の計算時刻）</span><span class="ino-diag-value">' + escapeHtml(c.judgedAt ? formatDateTime(c.judgedAt) : '—') + '</span></div>';
    h += '<div class="ino-diag-item"><span class="ino-diag-label">元データ最終取得（古い方）</span><span class="ino-diag-value">' + escapeHtml(c.sourceUpdatedAt ? (String(c.sourceUpdatedAt).indexOf('T') > 0 ? formatDateTime(c.sourceUpdatedAt) : c.sourceUpdatedAt) : '—') + '</span></div>';
    h += '</div>';
    if (isArr(c.rows) && c.rows.length) {
      h += '<div class="ino-table-wrap"><table class="ino-table"><thead><tr><th>対象</th><th>範囲</th><th>区分</th><th>期間</th><th>見込み時間</th><th>理由</th></tr></thead><tbody>';
      for (var i = 0; i < c.rows.length; i++) {
        var r = c.rows[i];
        h += '<tr><td>' + escapeHtml(r.driver) + '</td><td>' + escapeHtml(r.scope || '') + '</td><td>' + escapeHtml(r.categoryLabel) + '</td>';
        h += '<td>' + escapeHtml(r.period || '') + '</td><td>' + (r.forecastHours === null || r.forecastHours === undefined ? '—' : escapeHtml(r.forecastHours)) + '</td>';
        h += '<td>' + escapeHtml(r.reason || '') + '</td></tr>';
      }
      h += '</tbody></table></div>';
    }
    if (isArr(c.notes) && c.notes.length) {
      h += '<ul class="ino-live-notes">';
      for (var j = 0; j < c.notes.length; j++) h += '<li>' + escapeHtml(c.notes[j]) + '</li>';
      h += '</ul>';
    }
    h += '</div>';
    return h;
  }

  // view: { state, error, loading, lastSuccessAt, selected, nowMs }
  function renderLive(element, view) {
    if (!element) return;
    var state = view.state;
    var nowMs = typeof view.nowMs === 'number' ? view.nowMs : Date.now();
    var h = '';
    var petals = '';
    for (var pi = 0; pi < 14; pi++) { petals += '<i class="ino-petal ino-petal-' + (pi + 1) + '"></i>'; }
    h += '<div class="ino-petals" aria-hidden="true">' + petals + '</div>';
    h += '<header class="ino-header">';
    h += '<img class="ino-logo" src="./assets/inoichi-logo-light.webp" alt="INO-1" decoding="async" onerror="if(!this.dataset.fb){this.dataset.fb=\'1\';this.src=\'./assets/inoichi-logo.png\';}else{this.style.display=\'none\'}">';
    h += '<div class="ino-banner">';
    h += '<div class="ino-header-tagline">人間道：勤務監視・異常検知・リスク予測（ローカル専用）</div>';
    h += '<div class="ino-header-title">INO-1</div>';

    var link = state ? state.link : { status: 'failed', statusLabel: STATUS_LABEL_FAILED };
    var engine = state ? state.engine : { status: 'failed', statusLabel: STATUS_LABEL_FAILED };
    var staleLocal = false;
    if (view.error) {
      link = { status: 'failed', statusLabel: STATUS_LABEL_FAILED };
    } else if (state && state.lastFetchedAt) {
      var age = nowMs - new Date(state.lastFetchedAt).getTime();
      if (age > LIVE_STALE_MS) { staleLocal = true; link = { status: 'stale', statusLabel: 'データ遅延' }; }
    }
    h += '<div class="ino-statusbar">';
    h += '<span>データ連携 ' + statusPill(link.status, link.statusLabel) + '</span>';
    h += '<span>検知エンジン ' + statusPill(engine.status, engine.statusLabel) + '</span>';
    h += '<span>監視対象日 <b>' + escapeHtml(state && state.referenceDate ? state.referenceDate : '—') + '</b></span>';
    h += '<span>最終更新 <b>' + escapeHtml(view.lastSuccessAt ? formatDateTime(view.lastSuccessAt) : '—') + '</b></span>';
    h += '<button type="button" class="ino-refresh" id="ino-refresh"' + (view.loading ? ' disabled' : '') + '>' + (view.loading ? '取得中…' : '更新') + '</button>';
    h += '</div>';
    if (view.error) {
      h += '<div class="ino-live-error">INO-1 の取得処理に失敗しました（' + escapeHtml(view.error) + '）。' +
        (view.lastSuccessAt ? '最後の成功は ' + escapeHtml(formatDateTime(view.lastSuccessAt)) + ' ですが、その値は現在値として表示しません。' : '') + '</div>';
    } else if (staleLocal) {
      h += '<div class="ino-live-error">最後の取得から時間が経っています。以下は過去データです（取得: ' + escapeHtml(formatDateTime(state.lastFetchedAt)) + '）。</div>';
    }
    h += '</div></header>';

    h += '<main class="ino-main">';
    if (!state || view.error) {
      h += card('状態', '<p class="ino-empty">実データを取得できていません。正常・0件とは判定しません。</p>', { full: true });
    } else {
      var cards = state.cards;
      var dataIsPast = staleLocal;
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var shownStatus = dataIsPast && (c.status === 'ok' || c.status === 'warn') ? 'stale' : c.status;
        var shownLabel = dataIsPast && shownStatus === 'stale' ? '過去データ' : c.statusLabel;
        var sel = view.selected === c.id;
        h += '<section class="ino-card ino-live-card' + (sel ? ' is-selected' : '') + '">';
        h += '<h2 class="ino-card-title"><button type="button" class="ino-live-toggle" data-card="' + escapeHtml(c.id) + '" aria-expanded="' + (sel ? 'true' : 'false') + '">' +
          escapeHtml(c.title) + '</button> ' + statusPill(shownStatus, shownLabel) + '</h2>';
        h += '<div class="ino-card-body">' + renderCardBody(c) + (sel ? renderDetail(c) : '<div class="ino-live-hint">タップで詳細</div>') + '</div>';
        h += '</section>';
      }
    }
    h += '</main>';
    h += '<footer class="ino-footer">INO-1 — read-only / 実通知なし / データ取得元: OFK3（読み取り専用）</footer>';
    element.innerHTML = h;
  }

  var STATUS_LABEL_FAILED = '取得失敗';

  function initLiveDashboard(opts) {
    opts = opts || {};
    var container = opts.container || document.getElementById('inoichi-dashboard');
    if (!container) return null;
    var fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(window) : null);
    var view = { state: null, error: '', loading: false, lastSuccessAt: null, selected: '' };
    var timer = null;

    function draw() { view.nowMs = Date.now(); renderLive(container, view); bind(); }

    function bind() {
      var btn = container.querySelector('#ino-refresh');
      if (btn) btn.onclick = function () { refresh(); };
      var toggles = container.querySelectorAll('.ino-live-toggle');
      for (var i = 0; i < toggles.length; i++) {
        toggles[i].onclick = function (ev) {
          var id = ev.currentTarget.getAttribute('data-card');
          view.selected = view.selected === id ? '' : id;
          draw();
        };
      }
    }

    function refresh() {
      if (view.loading) return;
      if (!fetchImpl) { view.error = 'fetch unavailable'; draw(); return; }
      view.loading = true;
      draw();
      fetchImpl('/api/monitor', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (state) {
        view.state = state;
        view.error = '';
        view.lastSuccessAt = new Date().toISOString();
      }).catch(function (e) {
        // Never keep the previous state as if it were current.
        view.state = null;
        view.error = (e && e.message) || 'error';
      }).then(function () { view.loading = false; draw(); });
    }

    function schedule() {
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        if (typeof document !== 'undefined' && document.hidden) return;
        refresh();
      }, opts.pollMs || LIVE_POLL_MS);
    }

    draw();
    refresh();
    schedule();
    return { refresh: refresh, view: view, stop: function () { if (timer) clearInterval(timer); } };
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
    generateSampleStore: generateSampleStore,
    generateSampleInputs: generateSampleInputs,
    initDashboard: initDashboard,
    renderLive: renderLive,
    initLiveDashboard: initLiveDashboard
  };
});
