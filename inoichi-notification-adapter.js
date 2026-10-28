(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InoichiNotificationAdapter = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = '0.1';
  var PRODUCER = 'inoichi';

  var ELIGIBLE = 'eligible';
  var SUPPRESSED = 'suppressed';

  var NOTIFY_TARGET_STATUSES = { OPEN: true, REOPENED: true };
  var SUPPORTED_SEVERITIES = { critical: true, warning: true, info: true };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string'; }
  function isNum(v) { return typeof v === 'number' && !isNaN(v); }
  function isArr(v) { return Array.isArray(v); }

  function isSampleRule(candidate, opts) {
    if (opts && opts.isSampleRule === true) return true;
    if (isStr(candidate.ruleId) && candidate.ruleId.toLowerCase().indexOf('sample') !== -1) return true;
    return false;
  }

  function hasDestinations(opts) {
    if (!opts) return false;
    if (!isArr(opts.destinations)) return false;
    return opts.destinations.length > 0;
  }

  function isEvidenceComplete(candidate) {
    var ev = isObj(candidate.latestEvidence) ? candidate.latestEvidence : {};
    if (!isStr(ev.localDate) || ev.localDate === '') return false;
    if (!isNum(ev.hours) || ev.hours <= 0) return false;
    if (!isStr(ev.block) || ev.block === '') return false;
    if (!isNum(ev.expected) || ev.expected < 0) return false;
    if (!isNum(ev.actual)) return false;
    if (!isNum(ev.shortage)) return false;
    return true;
  }

  function buildTransitionId(alert) {
    var history = isArr(alert.transitionHistory) ? alert.transitionHistory : [];
    var status = alert.status;
    var entry = null;
    for (var i = history.length - 1; i >= 0; i--) {
      var h = history[i];
      if (isObj(h) && h.to === status) {
        entry = h;
        break;
      }
    }
    if (!entry && history.length > 0) {
      entry = history[history.length - 1];
    }
    if (!isObj(entry)) {
      return status + '|' + String(alert.firstDetectedAt || '') + '|' + String(alert.latestAlertId || '');
    }
    return String(entry.to || '') + '|' + String(entry.at || '') + '|' + String(entry.reason || '') + '|' + String(entry.alertId || '');
  }

  function buildDeduplicationKey(alert) {
    var alertKey = isStr(alert.alertKey) ? alert.alertKey : '';
    return alertKey + '|' + buildTransitionId(alert);
  }

  function buildTitle(candidate) {
    if (candidate.notificationType === 'fleet-shortage') {
      return '欠車リスク検出';
    }
    return 'アラート通知';
  }

  function buildMessage(candidate) {
    var ev = isObj(candidate.latestEvidence) ? candidate.latestEvidence : {};
    if (candidate.notificationType === 'fleet-shortage') {
      return [
        String(ev.localDate || candidate.localDate || ''),
        ' / ',
        String(ev.block || ''),
        ' / 必要',
        String(ev.expected !== undefined ? ev.expected : ''),
        '台 / 計画',
        String(ev.actual !== undefined ? ev.actual : ''),
        '台 / 不足',
        String(ev.shortage !== undefined ? ev.shortage : ''),
        '台'
      ].join('');
    }
    return [
      'rule: ',
      String(candidate.ruleId || ''),
      ' / status: ',
      String(candidate.alertStatus || ''),
      ' / severity: ',
      String(candidate.severity || '')
    ].join('');
  }

  function buildCandidate(alert, opts) {
    opts = opts || {};
    var alertKey = isStr(alert.alertKey) ? alert.alertKey : '';
    var ruleId = isStr(alert.ruleId) ? alert.ruleId : '';
    var localDate = isStr(alert.localDate) ? alert.localDate : '';
    var hours = isNum(alert.hours) ? alert.hours : null;
    var severity = isStr(alert.severity) ? alert.severity : '';
    var status = isStr(alert.status) ? alert.status : '';
    var category = isStr(alert.category) ? alert.category : '';
    var notificationType = category === 'fleet-capacity' ? 'fleet-shortage' : 'alert';

    var candidate = {
      alertKey: alertKey,
      ruleId: ruleId,
      localDate: localDate,
      hours: hours,
      severity: severity,
      alertStatus: status,
      notificationType: notificationType,
      latestEvidence: isObj(alert.latestEvidence) ? JSON.parse(JSON.stringify(alert.latestEvidence)) : null,
      title: '',
      message: '',
      deduplicationKey: buildDeduplicationKey(alert),
      eligibility: ELIGIBLE,
      suppressionReason: null
    };

    candidate.title = buildTitle(candidate);
    candidate.message = buildMessage(candidate);

    var policy = evaluateNotificationPolicy(candidate, opts);
    candidate.eligibility = policy.eligibility;
    candidate.suppressionReason = policy.suppressionReason;

    return candidate;
  }

  function evaluateNotificationPolicy(candidate, opts) {
    opts = opts || {};
    var status = candidate.alertStatus;

    if (status === 'ONGOING') {
      return { eligibility: SUPPRESSED, suppressionReason: 'ongoing' };
    }
    if (status === 'RESOLVED') {
      return { eligibility: SUPPRESSED, suppressionReason: 'resolved' };
    }
    if (!NOTIFY_TARGET_STATUSES[status]) {
      return { eligibility: SUPPRESSED, suppressionReason: 'unsupported-status' };
    }
    if (opts.dryRun !== true) {
      return { eligibility: SUPPRESSED, suppressionReason: 'not-dry-run' };
    }
    if (opts.persistenceFailed === true) {
      return { eligibility: SUPPRESSED, suppressionReason: 'persistence-failed' };
    }
    if (isSampleRule(candidate, opts)) {
      return { eligibility: SUPPRESSED, suppressionReason: 'sample-rule' };
    }
    if (!hasDestinations(opts)) {
      return { eligibility: SUPPRESSED, suppressionReason: 'missing-destinations' };
    }
    if (!SUPPORTED_SEVERITIES[candidate.severity]) {
      return { eligibility: SUPPRESSED, suppressionReason: 'missing-data' };
    }
    if (!isEvidenceComplete(candidate)) {
      return { eligibility: SUPPRESSED, suppressionReason: 'missing-data' };
    }

    return { eligibility: SUPPRESSED, suppressionReason: 'policy-not-confirmed' };
  }

  function buildNotificationCandidates(alerts, opts) {
    var candidates = [];
    if (!isArr(alerts)) return candidates;
    for (var i = 0; i < alerts.length; i++) {
      var alert = alerts[i];
      if (!isObj(alert)) continue;
      candidates.push(buildCandidate(alert, opts));
    }
    return candidates;
  }

  function buildNotificationPreview(candidate) {
    var lines = [
      '[' + candidate.notificationType + ' ' + candidate.severity + ' ' + candidate.alertStatus + '] ' + candidate.title,
      candidate.message,
      '(dry-run: ' + candidate.eligibility + (candidate.suppressionReason ? ', ' + candidate.suppressionReason : '') + ')'
    ];
    return lines.join('\n');
  }

  function createNotificationDryRun(alerts, opts) {
    opts = opts || {};
    var candidates = buildNotificationCandidates(alerts, opts);
    var suppressed = 0;
    var eligible = 0;
    var byReason = {};
    var previews = [];

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c.eligibility === ELIGIBLE) {
        eligible += 1;
      } else {
        suppressed += 1;
        var reason = c.suppressionReason || 'unknown';
        byReason[reason] = (byReason[reason] || 0) + 1;
      }
      previews.push(buildNotificationPreview(c));
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      producer: PRODUCER,
      dryRun: true,
      candidates: candidates,
      previews: previews,
      summary: {
        total: candidates.length,
        eligible: eligible,
        suppressed: suppressed,
        byReason: byReason
      }
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PRODUCER: PRODUCER,
    buildNotificationCandidates: buildNotificationCandidates,
    evaluateNotificationPolicy: evaluateNotificationPolicy,
    buildNotificationPreview: buildNotificationPreview,
    createNotificationDryRun: createNotificationDryRun
  };
}));