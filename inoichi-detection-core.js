(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InoichiDetectionCore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = '0.1';
  var PRODUCER = 'inoichi';
  var ALERT_STATUS = {
    DETECTED: 'detected',
    ACKNOWLEDGED: 'acknowledged',
    RESOLVED: 'resolved'
  };

  var SUPPORTED_OPERATORS = [
    'less-than',
    'less-than-or-equal',
    'greater-than',
    'greater-than-or-equal',
    'equal',
    'not-equal'
  ];

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && !isNaN(v); }
  function isStr(v) { return typeof v === 'string'; }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function getByPath(obj, path) {
    if (!isObj(obj) && !Array.isArray(obj)) return undefined;
    if (!isStr(path) || path === '') return undefined;
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function getOperandValue(operand, input) {
    if (!isObj(operand)) return { ok: true, value: operand };
    if (operand.path !== undefined) {
      return { ok: true, value: getByPath(input, operand.path) };
    }
    if (operand.value !== undefined) {
      return { ok: true, value: operand.value };
    }
    return { ok: false, error: 'operand must have either path or value' };
  }

  function evaluateCondition(condition, input) {
    var out = {
      matched: false,
      ok: true,
      error: null,
      left: null,
      right: null
    };
    if (!isObj(condition)) {
      out.ok = false;
      out.error = 'condition is not an object';
      return out;
    }
    if (SUPPORTED_OPERATORS.indexOf(condition.operator) < 0) {
      out.ok = false;
      out.error = 'unsupported operator: ' + String(condition.operator);
      return out;
    }
    var lv = getOperandValue(condition.left, input);
    var rv = getOperandValue(condition.right, input);
    if (!lv.ok) {
      out.ok = false;
      out.error = lv.error;
      return out;
    }
    if (!rv.ok) {
      out.ok = false;
      out.error = rv.error;
      return out;
    }
    out.left = lv.value;
    out.right = rv.value;
    var l = lv.value;
    var r = rv.value;
    switch (condition.operator) {
      case 'less-than': out.matched = l < r; break;
      case 'less-than-or-equal': out.matched = l <= r; break;
      case 'greater-than': out.matched = l > r; break;
      case 'greater-than-or-equal': out.matched = l >= r; break;
      case 'equal': out.matched = l === r; break;
      case 'not-equal': out.matched = l !== r; break;
    }
    return out;
  }

  function resolveSeverity(severitySpec, input) {
    var out = { severity: 'info', ok: true, error: null };
    if (!severitySpec) {
      out.severity = 'info';
      return out;
    }
    if (isStr(severitySpec)) {
      out.severity = severitySpec;
      return out;
    }
    if (isObj(severitySpec) && severitySpec.mapping) {
      var map = severitySpec.mapping;
      if (!Array.isArray(map.cases)) {
        out.error = 'severity mapping.cases must be an array';
        out.ok = false;
        return out;
      }
      var defaultSev = isStr(map.default) ? map.default : 'info';
      var matched = false;
      for (var i = 0; i < map.cases.length; i++) {
        var c = map.cases[i];
        if (!isObj(c) || !c.condition) continue;
        var r = evaluateCondition(c.condition, input);
        if (!r.ok) {
          out.error = r.error;
          out.ok = false;
          return out;
        }
        if (r.matched) {
          out.severity = isStr(c.severity) ? c.severity : defaultSev;
          matched = true;
          break;
        }
      }
      if (!matched) out.severity = defaultSev;
      return out;
    }
    out.error = 'severity must be string or {mapping} object';
    out.ok = false;
    return out;
  }

  function validateRule(rule) {
    var errors = [];
    if (!isObj(rule)) {
      errors.push('rule is not an object');
      return { ok: false, errors: errors };
    }
    if (!isStr(rule.ruleId) || rule.ruleId === '') errors.push('ruleId is required');
    if (!isStr(rule.category) || rule.category === '') errors.push('category is required');
    if (!isStr(rule.inputType) || rule.inputType === '') errors.push('inputType is required');
    if (!isObj(rule.condition)) errors.push('condition is required');
    if (SUPPORTED_OPERATORS.indexOf(rule.condition && rule.condition.operator) < 0) {
      errors.push('condition.operator is unsupported: ' + String(rule.condition && rule.condition.operator));
    }
    if (!isObj(rule.messageTemplate)) errors.push('messageTemplate is required');
    else {
      if (!isStr(rule.messageTemplate.title)) errors.push('messageTemplate.title is required');
      if (!isStr(rule.messageTemplate.summary)) errors.push('messageTemplate.summary is required');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function renderTemplate(template, values) {
    if (!isStr(template)) return '';
    var out = template;
    var keys = Object.keys(values || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = values[k];
      if (v === null || v === undefined) v = '';
      out = out.split('{' + k + '}').join(String(v));
    }
    return out;
  }

  function evaluateRule(rule, input) {
    var validation = validateRule(rule);
    var out = {
      ok: true,
      matched: false,
      error: null,
      rule: rule,
      conditionResult: null,
      severityResult: { severity: 'info', ok: true, error: null }
    };
    if (!validation.ok) {
      out.ok = false;
      out.error = validation.errors.join('; ');
      return out;
    }
    var cr = evaluateCondition(rule.condition, input);
    out.conditionResult = cr;
    if (!cr.ok) {
      out.ok = false;
      out.error = cr.error;
      return out;
    }
    out.matched = cr.matched;
    if (out.matched) {
      var severityInput = input;
      if (isObj(input) && isNum(input.expected) && isNum(input.actual)) {
        severityInput = {};
        Object.keys(input).forEach(function (k) { severityInput[k] = input[k]; });
        severityInput.shortage = input.expected - input.actual;
      }
      var sr = resolveSeverity(rule.severity, severityInput);
      out.severityResult = sr;
      if (!sr.ok) {
        out.ok = false;
        out.error = sr.error;
      }
    }
    return out;
  }

  function evaluateRules(rules, input) {
    var out = [];
    var diagnostics = { total: 0, matched: 0, errors: 0, invalidRules: 0 };
    if (!Array.isArray(rules)) {
      return { results: out, diagnostics: diagnostics, ok: false, error: 'rules is not an array' };
    }
    diagnostics.total = rules.length;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!isObj(r) || r.enabled === false) continue;
      var er = evaluateRule(r, input);
      if (!er.ok) diagnostics.errors += 1;
      if (er.matched) diagnostics.matched += 1;
      out.push(er);
    }
    return { results: out, diagnostics: diagnostics, ok: true, error: null };
  }

  function buildEvidence(rule, input, result) {
    var ev = {};
    if (input && input.localDate !== undefined) ev.localDate = input.localDate;
    if (input && input.block !== undefined) ev.block = input.block;
    if (input && input.hours !== undefined) ev.hours = input.hours;
    if (input && input.expected !== undefined) ev.expected = input.expected;
    if (input && input.actual !== undefined) ev.actual = input.actual;
    if (result && result.conditionResult) {
      var cr = result.conditionResult;
      if (isNum(cr.left) && isNum(cr.right)) {
        ev.shortage = cr.right - cr.left;
      } else if (isNum(input.expected) && isNum(input.actual)) {
        ev.shortage = input.expected - input.actual;
      }
    }
    return ev;
  }

  function buildDeduplicationKey(rule, input) {
    var ruleId = isObj(rule) ? String(rule.ruleId || '') : '';
    var localDate = isObj(input) ? String(input.localDate || '') : '';
    var scope = '';
    if (isObj(input) && input.block !== undefined) scope = String(input.block);
    return [ruleId, localDate, scope].join('|');
  }

  function buildAlert(rule, input, result, opts) {
    var out = {
      ok: true,
      alert: null,
      error: null
    };
    if (!isObj(rule) || !isObj(result)) {
      out.ok = false;
      out.error = 'rule or result missing';
      return out;
    }
    if (!result.matched) {
      out.alert = null;
      return out;
    }
    var evidence = buildEvidence(rule, input, result);
    var values = {};
    if (isObj(input)) {
      values.localDate = input.localDate;
      values.block = input.block;
      values.hours = input.hours;
      values.expected = input.expected;
      values.actual = input.actual;
      values.shortage = evidence.shortage;
    }
    var sev = result.severityResult && result.severityResult.severity ? result.severityResult.severity : 'info';
    var detectedAt = (opts && opts.now) ? opts.now : nowIso();
    var alert = {
      alertId: uuid(),
      schemaVersion: SCHEMA_VERSION,
      producer: PRODUCER,
      ruleId: rule.ruleId,
      ruleVersion: isStr(rule.version) ? rule.version : '0.1.0',
      category: rule.category,
      severity: sev,
      status: ALERT_STATUS.DETECTED,
      detectedAt: detectedAt,
      updatedAt: detectedAt,
      localDate: isObj(input) ? input.localDate : null,
      title: renderTemplate(rule.messageTemplate.title, values),
      summary: renderTemplate(rule.messageTemplate.summary, values),
      source: PRODUCER,
      sourceDataType: rule.inputType,
      sourceReference: {
        ruleId: rule.ruleId,
        category: rule.category,
        localDate: isObj(input) ? input.localDate : null,
        block: isObj(input) ? input.block : null
      },
      evidence: evidence,
      acknowledged: false,
      acknowledgedAt: null,
      resolved: false,
      resolvedAt: null,
      diagnostics: {
        deduplicationKey: buildDeduplicationKey(rule, input),
        conditionOperator: rule.condition.operator,
        conditionMatched: result.conditionResult ? result.conditionResult.matched : null
      }
    };
    out.alert = alert;
    return out;
  }

  function alertsEqualKey(a, b) {
    if (!isObj(a) || !isObj(b)) return false;
    return a.diagnostics && b.diagnostics && a.diagnostics.deduplicationKey === b.diagnostics.deduplicationKey;
  }

  function copyAlert(alert) {
    return JSON.parse(JSON.stringify(alert));
  }

  function deduplicateAlerts(newAlerts, existingAlerts) {
    var out = {
      alerts: [],
      created: [],
      updated: [],
      unchanged: [],
      resolved: [],
      diagnostics: { totalNew: 0, created: 0, updated: 0, unchanged: 0, resolved: 0 }
    };
    if (!Array.isArray(newAlerts)) newAlerts = [];
    if (!Array.isArray(existingAlerts)) existingAlerts = [];
    out.diagnostics.totalNew = newAlerts.length;

    var existingByKey = {};
    for (var i = 0; i < existingAlerts.length; i++) {
      var e = existingAlerts[i];
      if (!isObj(e) || !e.diagnostics || !e.diagnostics.deduplicationKey) continue;
      existingByKey[e.diagnostics.deduplicationKey] = e;
    }

    var newKeys = {};
    for (var j = 0; j < newAlerts.length; j++) {
      var n = newAlerts[j];
      if (!isObj(n) || !n.diagnostics || !n.diagnostics.deduplicationKey) continue;
      var key = n.diagnostics.deduplicationKey;
      newKeys[key] = true;
      var prev = existingByKey[key];
      if (prev && !prev.resolved) {
        var updated = copyAlert(prev);
        updated.updatedAt = n.updatedAt;
        updated.evidence = n.evidence;
        updated.severity = n.severity;
        updated.status = ALERT_STATUS.DETECTED;
        if (n.title) updated.title = n.title;
        if (n.summary) updated.summary = n.summary;
        out.alerts.push(updated);
        out.updated.push(updated);
      } else {
        var created = copyAlert(n);
        out.alerts.push(created);
        out.created.push(created);
        if (prev && prev.resolved) {
          out.alerts.push(copyAlert(prev));
        }
      }
    }

    for (var k = 0; k < existingAlerts.length; k++) {
      var ex = existingAlerts[k];
      if (!isObj(ex) || !ex.diagnostics || !ex.diagnostics.deduplicationKey) continue;
      var k2 = ex.diagnostics.deduplicationKey;
      if (!newKeys[k2] && !ex.resolved) {
        var resolved = copyAlert(ex);
        resolved.resolved = true;
        resolved.resolvedAt = nowIso();
        resolved.status = ALERT_STATUS.RESOLVED;
        resolved.updatedAt = resolved.resolvedAt;
        out.alerts.push(resolved);
        out.resolved.push(resolved);
      } else if (!newKeys[k2] && ex.resolved) {
        out.alerts.push(copyAlert(ex));
      }
    }

    out.diagnostics.created = out.created.length;
    out.diagnostics.updated = out.updated.length;
    out.diagnostics.unchanged = out.unchanged.length;
    out.diagnostics.resolved = out.resolved.length;
    return out;
  }

  function detect(input, rules, opts) {
    var out = {
      schemaVersion: SCHEMA_VERSION,
      producer: PRODUCER,
      detectedAt: (opts && opts.now) ? opts.now : nowIso(),
      inputType: isObj(input) ? input.inputType : null,
      alerts: [],
      diagnostics: {
        inputOk: true,
        inputError: null,
        ruleCount: 0,
        matchedCount: 0,
        alertCount: 0,
        errors: []
      }
    };
    if (!isObj(input)) {
      out.diagnostics.inputOk = false;
      out.diagnostics.inputError = 'input is not an object';
      return out;
    }
    var er = evaluateRules(rules, input);
    out.diagnostics.ruleCount = er.diagnostics.total;
    out.diagnostics.matchedCount = er.diagnostics.matched;
    if (!er.ok) {
      out.diagnostics.errors.push({ phase: 'evaluateRules', message: er.error });
      return out;
    }
    var newAlerts = [];
    for (var i = 0; i < er.results.length; i++) {
      var r = er.results[i];
      if (!r.ok) {
        out.diagnostics.errors.push({ phase: 'evaluateRule', ruleId: r.rule && r.rule.ruleId, message: r.error });
        continue;
      }
      if (!r.matched) continue;
      var ba = buildAlert(r.rule, input, r, opts);
      if (!ba.ok) {
        out.diagnostics.errors.push({ phase: 'buildAlert', ruleId: r.rule && r.rule.ruleId, message: ba.error });
        continue;
      }
      if (ba.alert) newAlerts.push(ba.alert);
    }
    var existing = (opts && Array.isArray(opts.existingAlerts)) ? opts.existingAlerts : [];
    var dedup = deduplicateAlerts(newAlerts, existing);
    out.alerts = dedup.alerts;
    out.diagnostics.created = dedup.diagnostics.created;
    out.diagnostics.updated = dedup.diagnostics.updated;
    out.diagnostics.resolved = dedup.diagnostics.resolved;
    out.diagnostics.alertCount = out.alerts.length;
    return out;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PRODUCER: PRODUCER,
    ALERT_STATUS: ALERT_STATUS,
    SUPPORTED_OPERATORS: SUPPORTED_OPERATORS,
    validateRule: validateRule,
    evaluateCondition: evaluateCondition,
    evaluateRule: evaluateRule,
    evaluateRules: evaluateRules,
    buildAlert: buildAlert,
    buildDeduplicationKey: buildDeduplicationKey,
    deduplicateAlerts: deduplicateAlerts,
    detect: detect
  };
}));
