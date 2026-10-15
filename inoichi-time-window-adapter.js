/**
 * INOICHI timeWindow adapter (Step 2) — pure function.
 *
 * Converts a P0 canonical envelope (dataType 'timeWindow', inoichi-core.js) into a flat
 * 'time-window-canonical' input for the detection engine (inoichi-detection-core.js).
 *
 * Scope: DATA QUALITY of the HARVEST timeWindow data only. It never judges delivery
 * lateness / completion: the envelope carries no delivery status (deliveryStatus is always
 * reported as 'not-available'). A stale capture is "re-fetch recommended", not "late".
 *
 * Pure: no network, no storage, no clock (opts.now is required), no side effects,
 * never throws. The envelope and its rows are not modified or copied.
 *
 * evaluable
 *   false = at least one BLOCKING issue: the data must not be used as the latest normal data
 *           by later rules. Quality problems are still reported in issues[].
 *   true  = no blocking issue. Warnings (partial, re-fetch recommended, unknown capture time, ...)
 *           may still be present and are reported separately.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InoichiTimeWindowAdapter = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = '0.1';
  var INPUT_TYPE = 'time-window-canonical';
  var DATA_TYPE = 'timeWindow';
  var SUPPORTED_SCHEMA_VERSIONS = ['0.1'];
  var LEVEL = { BLOCKING: 'blocking', WARNING: 'warning' };

  // Provisional default (30 min). Override with opts.freshnessThresholdMinutes.
  var DEFAULTS = Object.freeze({ freshnessThresholdMinutes: 30 });

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string' && v !== ''; }

  // string (ISO) / Date / epoch ms number -> epoch ms, else null.
  function toMs(v) {
    if (v === null || v === undefined || v === '') return null;
    var n;
    if (v instanceof Date) n = v.getTime();
    else if (typeof v === 'number') n = v;
    else if (typeof v === 'string') n = Date.parse(v);
    else return null;
    return isFinite(n) ? n : null;
  }

  function createCollector() {
    var byCode = {};
    var list = [];
    return {
      add: function (code, level, detail) {
        if (byCode[code]) {
          if (level === LEVEL.BLOCKING) byCode[code].level = LEVEL.BLOCKING;
          return;
        }
        var issue = { code: code, level: level };
        if (detail !== undefined) issue.detail = detail;
        byCode[code] = issue;
        list.push(issue);
      },
      list: list
    };
  }

  function resolveThreshold(opts, issues) {
    if (isObj(opts) && opts.freshnessThresholdMinutes !== undefined && opts.freshnessThresholdMinutes !== null) {
      var t = opts.freshnessThresholdMinutes;
      if (typeof t === 'number' && isFinite(t) && t > 0) return t;
      issues.add('threshold-invalid', LEVEL.BLOCKING);
      return null;
    }
    return DEFAULTS.freshnessThresholdMinutes;
  }

  function adaptTimeWindow(envelope, opts) {
    var issues = createCollector();
    var env = isObj(envelope) ? envelope : null;
    var o = isObj(opts) ? opts : {};
    var meta = env && isObj(env.sourceMetadata) ? env.sourceMetadata : {};
    var diag = env && isObj(env.diagnostics) ? env.diagnostics : {};

    // ---- opts ----
    var nowMs = toMs(typeof o.now === 'function' ? safeCall(o.now) : o.now);
    if (nowMs === null) issues.add(o.now === undefined || o.now === null ? 'now-missing' : 'now-invalid', LEVEL.BLOCKING);
    var thresholdMinutes = resolveThreshold(o, issues);

    var targetLocalDate = null;
    if (o.targetLocalDate !== undefined && o.targetLocalDate !== null) {
      if (typeof o.targetLocalDate === 'string' && DATE_RE.test(o.targetLocalDate)) targetLocalDate = o.targetLocalDate;
      else issues.add('target-date-invalid', LEVEL.BLOCKING);
    }

    // ---- envelope / HARVEST boundary ----
    if (!env) {
      issues.add('envelope-invalid', LEVEL.BLOCKING);
    } else {
      if (env.dataType !== DATA_TYPE) issues.add('unsupported-data-type', LEVEL.BLOCKING, { dataType: env.dataType === undefined ? null : env.dataType });
      if (SUPPORTED_SCHEMA_VERSIONS.indexOf(env.schemaVersion) < 0) issues.add('unsupported-envelope-schema', LEVEL.BLOCKING);
      if (meta.handoffSchemaVersion === null || meta.handoffSchemaVersion === undefined) {
        issues.add('handoff-schema-missing', LEVEL.BLOCKING);
      } else if (SUPPORTED_SCHEMA_VERSIONS.indexOf(meta.handoffSchemaVersion) < 0) {
        issues.add('unsupported-schema-version', LEVEL.BLOCKING, { handoffSchemaVersion: meta.handoffSchemaVersion });
      }
      if (meta.harvestConfirmed !== true) issues.add('handoff-not-confirmed', LEVEL.BLOCKING);
      if (meta.harvestCollectorId !== DATA_TYPE) {
        issues.add('handoff-source-mismatch', LEVEL.BLOCKING, { source: meta.harvestCollectorId === undefined ? null : meta.harvestCollectorId });
      }
      if (env.status === 'rejected') issues.add('envelope-rejected', LEVEL.BLOCKING);
      var rej = Array.isArray(diag.rejectionReasons) ? diag.rejectionReasons : [];
      if (env.status === 'rejected') {
        // Whole-envelope rejection reasons (schema, source, payload, ...).
        rej.forEach(function (r) {
          if (isObj(r) && isStr(r.code)) issues.add(r.code, LEVEL.BLOCKING);
        });
      } else if (env.status === 'partial') {
        // In a partial envelope the reasons are per-row; valid rows remain usable.
        issues.add('envelope-partial', LEVEL.WARNING, {
          partialCount: numOrNull(diag.partialCount),
          rejectedCount: numOrNull(diag.rejectedCount),
          rowReasons: rej.filter(function (r) { return isObj(r) && isStr(r.code); }).map(function (r) { return { code: r.code, count: numOrNull(r.count) }; })
        });
      }
      if (typeof diag.duplicateKeyCount === 'number' && diag.duplicateKeyCount > 0) {
        issues.add('duplicate-keys', LEVEL.WARNING, { count: diag.duplicateKeyCount });
      }
    }

    var rows = env && isObj(env.payload) && Array.isArray(env.payload.rows) ? env.payload.rows : null;
    var rowCount = rows ? rows.length : 0;
    if (env && rowCount === 0) issues.add('no-valid-rows', LEVEL.BLOCKING);

    // ---- HARVEST state (cleared/unknown values are handled, not assumed) ----
    var harvestStatus = isStr(meta.harvestStatus) ? meta.harvestStatus : null;
    if (env) {
      switch (harvestStatus) {
        case 'ok': break;
        case 'partial': issues.add('harvest-partial', LEVEL.WARNING); break;
        case 'stale': issues.add('harvest-stale', LEVEL.BLOCKING); break;
        case 'error': issues.add('harvest-error', LEVEL.BLOCKING); break;
        case 'idle':
        case 'awaiting-data':
        case 'checking': issues.add('harvest-not-ready', LEVEL.BLOCKING, { status: harvestStatus }); break;
        case null: issues.add('harvest-status-unknown', LEVEL.WARNING); break;
        default: issues.add('harvest-status-unrecognized', LEVEL.WARNING, { status: harvestStatus });
      }
    }

    // ---- localDate (never guessed; compared only against an explicit target) ----
    var localDate = env && isStr(env.localDate) ? env.localDate : null;
    var dateState;
    if (localDate !== null && !DATE_RE.test(localDate)) {
      issues.add('local-date-invalid', LEVEL.BLOCKING);
      dateState = 'invalid';
    } else if (localDate === null) {
      if (env) issues.add('local-date-unknown', targetLocalDate !== null ? LEVEL.BLOCKING : LEVEL.WARNING);
      dateState = 'unknown';
    } else if (targetLocalDate === null) {
      dateState = 'not-checked';
    } else if (localDate === targetLocalDate) {
      dateState = 'match';
    } else {
      issues.add('local-date-mismatch', LEVEL.BLOCKING, { localDate: localDate, targetLocalDate: targetLocalDate });
      dateState = 'mismatch';
    }

    // ---- freshness: capturedAt vs opts.now ----
    var capturedAt = env && env.capturedAt !== undefined ? env.capturedAt : null;
    var freshState;
    var ageMinutes = null;
    if (!env || nowMs === null) {
      freshState = 'not-evaluated';
    } else if (capturedAt === null || capturedAt === '') {
      freshState = 'unknown';
      issues.add('captured-at-unknown', LEVEL.WARNING);
    } else {
      var capMs = toMs(capturedAt);
      if (capMs === null) {
        freshState = 'anomaly';
        issues.add('captured-at-invalid', LEVEL.BLOCKING);
      } else if (capMs > nowMs) {
        freshState = 'anomaly';
        issues.add('captured-at-in-future', LEVEL.BLOCKING, { aheadMinutes: (capMs - nowMs) / 60000 });
      } else {
        ageMinutes = (nowMs - capMs) / 60000;
        if (thresholdMinutes === null) {
          freshState = 'not-evaluated';
        } else if (ageMinutes > thresholdMinutes) {
          freshState = 'refetch-recommended';
          issues.add('refetch-recommended', LEVEL.WARNING, { ageMinutes: ageMinutes, thresholdMinutes: thresholdMinutes });
        } else {
          freshState = 'fresh';
        }
      }
    }

    // ---- result ----
    var blocking = 0;
    var warning = 0;
    var notEvaluableReasons = [];
    issues.list.forEach(function (i) {
      if (i.level === LEVEL.BLOCKING) { blocking += 1; notEvaluableReasons.push(i.code); } else { warning += 1; }
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      inputType: INPUT_TYPE,
      dataType: DATA_TYPE,
      evaluable: blocking === 0,
      notEvaluableReasons: notEvaluableReasons,
      issues: issues.list,
      issueCount: issues.list.length,
      blockingCount: blocking,
      warningCount: warning,
      localDate: localDate,
      targetLocalDate: targetLocalDate,
      dateCheck: dateState,
      capturedAt: capturedAt === undefined ? null : capturedAt,
      collectedAt: env && env.collectedAt !== undefined ? env.collectedAt : null,
      now: nowMs === null ? null : new Date(nowMs).toISOString(),
      freshness: { state: freshState, ageMinutes: ageMinutes, thresholdMinutes: thresholdMinutes },
      harvestStatus: harvestStatus,
      envelopeStatus: env && isStr(env.status) ? env.status : null,
      rowCount: rowCount,
      normalizedCount: numOrNull(diag.normalizedCount),
      partialCount: numOrNull(diag.partialCount),
      rejectedCount: numOrNull(diag.rejectedCount),
      unknowns: { deliveryStatus: 'not-available' }
    };
  }

  function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function safeCall(fn) { try { return fn(); } catch (e) { return null; } }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    INPUT_TYPE: INPUT_TYPE,
    DEFAULTS: DEFAULTS,
    LEVEL: LEVEL,
    adaptTimeWindow: adaptTimeWindow
  };
}));
