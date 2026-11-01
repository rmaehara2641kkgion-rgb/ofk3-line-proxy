(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InoichiAlertStore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = '0.1';
  var STATUS = {
    OPEN: 'OPEN',
    ONGOING: 'ONGOING',
    RESOLVED: 'RESOLVED',
    REOPENED: 'REOPENED'
  };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string'; }
  function isNum(v) { return typeof v === 'number' && !isNaN(v); }
  function isDateStr(v) { return isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v); }

  function nowIso() { return new Date().toISOString(); }
  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

  function emptyStore() {
    return {
      _schemaVersion: SCHEMA_VERSION,
      _createdAt: nowIso(),
      _updatedAt: nowIso(),
      alerts: {},
      diagnostics: {
        ingestCount: 0,
        persistenceErrors: [],
        deserializationErrors: []
      }
    };
  }

  function buildAlertKey(ruleId, localDate, hours) {
    return [
      String(ruleId || ''),
      String(localDate || ''),
      String(hours === undefined || hours === null ? '' : hours)
    ].join('|');
  }

  function alertKeyFromDetection(alert) {
    if (!isObj(alert)) return null;
    var ruleId = alert.ruleId;
    var localDate = alert.localDate;
    var hours;
    if (alert.evidence && alert.evidence.hours !== undefined) {
      hours = alert.evidence.hours;
    } else if (alert.sourceReference && alert.sourceReference.hours !== undefined) {
      hours = alert.sourceReference.hours;
    }
    return buildAlertKey(ruleId, localDate, hours);
  }

  function getBlock(alert) {
    if (!isObj(alert)) return null;
    if (alert.evidence && alert.evidence.block !== undefined) return alert.evidence.block;
    if (alert.sourceReference && alert.sourceReference.block !== undefined) return alert.sourceReference.block;
    return null;
  }

  function getSourceType(alert) {
    if (!isObj(alert)) return null;
    return alert.sourceDataType || alert.sourceType || null;
  }

  function collectRuleIds(alerts) {
    var ids = [];
    if (!Array.isArray(alerts)) return ids;
    var seen = {};
    for (var i = 0; i < alerts.length; i++) {
      var rid = alerts[i] && alerts[i].ruleId;
      if (rid && !seen[rid]) {
        seen[rid] = true;
        ids.push(rid);
      }
    }
    return ids;
  }

  function deriveEvaluatedKeys(evaluatedInputs, ruleIds) {
    var keys = {};
    if (!Array.isArray(evaluatedInputs) || evaluatedInputs.length === 0) return keys;
    if (!Array.isArray(ruleIds) || ruleIds.length === 0) return keys;
    for (var i = 0; i < evaluatedInputs.length; i++) {
      var inp = evaluatedInputs[i];
      if (!isObj(inp)) continue;
      if (inp.actual === undefined || inp.actual === null) continue;
      if (!isDateStr(inp.localDate)) continue;
      if (!isNum(inp.hours) || inp.hours <= 0) continue;
      for (var r = 0; r < ruleIds.length; r++) {
        var key = buildAlertKey(ruleIds[r], inp.localDate, inp.hours);
        keys[key] = true;
      }
    }
    return keys;
  }

  function createRecord(alert, key, now) {
    var ev = isObj(alert.evidence) ? deepClone(alert.evidence) : {};
    return {
      alertKey: key,
      ruleId: alert.ruleId,
      category: alert.category,
      sourceType: getSourceType(alert),
      localDate: alert.localDate,
      hours: ev.hours,
      block: ev.block !== undefined ? ev.block : getBlock(alert),
      severity: alert.severity || 'info',
      status: STATUS.OPEN,
      firstDetectedAt: now,
      lastDetectedAt: now,
      resolvedAt: null,
      reopenedAt: null,
      acknowledgedAt: null,
      occurrenceCount: 1,
      transitionHistory: [
        { from: null, to: STATUS.OPEN, at: now, reason: 'detected', alertId: alert.alertId }
      ],
      latestEvidence: ev,
      latestAlertId: alert.alertId
    };
  }

  function updateRecord(record, alert, newStatus, now) {
    var oldStatus = record.status;
    record.status = newStatus;
    record.severity = alert.severity || record.severity;
    record.lastDetectedAt = now;
    record.latestAlertId = alert.alertId;
    var ev = isObj(alert.evidence) ? deepClone(alert.evidence) : null;
    if (ev) {
      record.latestEvidence = ev;
      if (ev.block !== undefined) record.block = ev.block;
    }
    record.occurrenceCount += 1;
    if (newStatus === STATUS.REOPENED) {
      record.reopenedAt = now;
      record.resolvedAt = null;
    }
    if (oldStatus !== newStatus) {
      record.transitionHistory.push({
        from: oldStatus,
        to: newStatus,
        at: now,
        reason: newStatus === STATUS.REOPENED ? 'reopened' : 'ongoing',
        alertId: alert.alertId
      });
    }
    return record;
  }

  function resolveRecord(record, now, reason) {
    if (record.status === STATUS.RESOLVED) return record;
    var oldStatus = record.status;
    record.status = STATUS.RESOLVED;
    record.resolvedAt = now;
    record.transitionHistory.push({
      from: oldStatus,
      to: STATUS.RESOLVED,
      at: now,
      reason: reason || 'cleared',
      alertId: record.latestAlertId
    });
    return record;
  }

  function matchesFilter(alert, filter) {
    if (!isObj(filter)) return true;
    var keys = Object.keys(filter);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (alert[k] !== filter[k]) return false;
    }
    return true;
  }

  function ingest(store, detectionOutput, opts) {
    opts = opts || {};
    var result = { created: [], updated: [], resolved: [], unchanged: [] };
    if (!isObj(store)) {
      result.error = 'store is not an object';
      return result;
    }
    if (!isObj(detectionOutput)) {
      result.error = 'detectionOutput is not an object';
      if (isObj(store) && isObj(store.diagnostics)) store.diagnostics.ingestCount += 1;
      return result;
    }

    var now = opts.now || detectionOutput.detectedAt || nowIso();
    var newAlerts = Array.isArray(detectionOutput.alerts) ? detectionOutput.alerts : [];

    var evaluatedKeys = {};
    if (Array.isArray(opts.evaluatedKeys)) {
      for (var i = 0; i < opts.evaluatedKeys.length; i++) {
        evaluatedKeys[opts.evaluatedKeys[i]] = true;
      }
    } else if (Array.isArray(opts.evaluatedInputs)) {
      var ruleIds = collectRuleIds(newAlerts);
      evaluatedKeys = deriveEvaluatedKeys(opts.evaluatedInputs, ruleIds);
    }

    var newKeys = {};
    for (var j = 0; j < newAlerts.length; j++) {
      var alert = newAlerts[j];
      var key = alertKeyFromDetection(alert);
      if (!key) continue;
      newKeys[key] = true;
      var existing = store.alerts[key];
      if (!existing) {
        var created = createRecord(alert, key, now);
        store.alerts[key] = created;
        result.created.push(created);
      } else {
        var newStatus;
        if (existing.status === STATUS.RESOLVED) {
          newStatus = STATUS.REOPENED;
        } else if (existing.status === STATUS.OPEN || existing.status === STATUS.REOPENED) {
          newStatus = STATUS.ONGOING;
        } else {
          newStatus = existing.status;
        }
        var updated = updateRecord(existing, alert, newStatus, now);
        result.updated.push(updated);
      }
    }

    var existingKeys = Object.keys(store.alerts);
    for (var k = 0; k < existingKeys.length; k++) {
      var exKey = existingKeys[k];
      if (evaluatedKeys[exKey] && !newKeys[exKey]) {
        var ex = store.alerts[exKey];
        if (ex.status !== STATUS.RESOLVED) {
          resolveRecord(ex, now, 'cleared');
          result.resolved.push(ex);
        } else {
          result.unchanged.push(ex);
        }
      }
    }

    store._updatedAt = now;
    store.diagnostics.ingestCount += 1;

    if (store._adapter && opts.persist !== false) {
      var saveRes = store._adapter.save(store);
      if (!saveRes.ok) {
        store.diagnostics.persistenceErrors.push({
          at: nowIso(),
          error: saveRes.error,
          message: saveRes.message
        });
      }
    }

    return result;
  }

  function getAlerts(store, filter) {
    if (!isObj(store) || !isObj(store.alerts)) return [];
    var keys = Object.keys(store.alerts);
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var alert = store.alerts[keys[i]];
      if (matchesFilter(alert, filter)) out.push(deepClone(alert));
    }
    return out.sort(function (a, b) {
      return String(a.firstDetectedAt).localeCompare(String(b.firstDetectedAt));
    });
  }

  function getAlert(store, alertKey) {
    if (!isObj(store) || !isObj(store.alerts) || !store.alerts[alertKey]) return null;
    return deepClone(store.alerts[alertKey]);
  }

  function acknowledge(store, alertKey, opts) {
    opts = opts || {};
    if (!isObj(store) || !isObj(store.alerts) || !store.alerts[alertKey]) {
      return { ok: false, error: 'alert not found' };
    }
    var alert = store.alerts[alertKey];
    if (alert.status === STATUS.RESOLVED) {
      return { ok: false, error: 'cannot acknowledge resolved alert' };
    }
    alert.acknowledgedAt = opts.now || nowIso();
    store._updatedAt = opts.now || nowIso();
    if (store._adapter && opts.persist !== false) {
      var saveRes = store._adapter.save(store);
      if (!saveRes.ok) {
        store.diagnostics.persistenceErrors.push({
          at: nowIso(),
          error: saveRes.error,
          message: saveRes.message
        });
      }
    }
    return { ok: true, alert: deepClone(alert) };
  }

  function resolve(store, alertKey, opts) {
    opts = opts || {};
    if (!isObj(store) || !isObj(store.alerts) || !store.alerts[alertKey]) {
      return { ok: false, error: 'alert not found' };
    }
    var alert = store.alerts[alertKey];
    var now = opts.now || nowIso();
    resolveRecord(alert, now, opts.reason || 'manual');
    store._updatedAt = now;
    if (store._adapter && opts.persist !== false) {
      var saveRes = store._adapter.save(store);
      if (!saveRes.ok) {
        store.diagnostics.persistenceErrors.push({
          at: nowIso(),
          error: saveRes.error,
          message: saveRes.message
        });
      }
    }
    return { ok: true, alert: deepClone(alert) };
  }

  function createStore(storageAdapter) {
    var store = emptyStore();
    if (storageAdapter) {
      store._adapter = storageAdapter;
      var loaded = storageAdapter.load();
      if (loaded) {
        if (loaded._schemaVersion === SCHEMA_VERSION) {
          store.alerts = isObj(loaded.alerts) ? loaded.alerts : {};
          store._createdAt = loaded._createdAt || store._createdAt;
          store._updatedAt = loaded._updatedAt || store._updatedAt;
          store.diagnostics = isObj(loaded.diagnostics) ? loaded.diagnostics : store.diagnostics;
        } else {
          store.diagnostics.deserializationErrors.push({
            at: nowIso(),
            reason: 'schema-mismatch',
            found: loaded._schemaVersion
          });
        }
      }
    }
    return store;
  }

  function serialize(store) {
    if (!isObj(store)) return JSON.stringify(null);
    return JSON.stringify({
      _schemaVersion: store._schemaVersion,
      _createdAt: store._createdAt,
      _updatedAt: store._updatedAt,
      alerts: store.alerts,
      diagnostics: store.diagnostics
    });
  }

  function deserialize(json) {
    var out = { ok: false, state: null, diagnostics: { reason: null } };
    try {
      var state = JSON.parse(json);
      if (!isObj(state)) {
        out.diagnostics.reason = 'not-an-object';
        return out;
      }
      if (state._schemaVersion !== SCHEMA_VERSION) {
        out.diagnostics.reason = 'schema-mismatch';
        out.diagnostics.found = state._schemaVersion;
        return out;
      }
      out.ok = true;
      out.state = state;
      return out;
    } catch (e) {
      out.diagnostics.reason = 'parse-error';
      out.diagnostics.message = e.message;
      return out;
    }
  }

  function createMemoryStorage() {
    var state = null;
    return {
      load: function () { return state ? deepClone(state) : null; },
      save: function (data) { state = deepClone(data); return { ok: true }; }
    };
  }

  function createLocalStorageAdapter(keyPrefix, fallback) {
    var key = (keyPrefix || 'inoichi-alert-store-v1') + '-state';
    fallback = fallback || null;
    return {
      load: function () {
        try {
          var raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
          if (!raw) return fallback;
          return JSON.parse(raw);
        } catch (e) {
          return fallback;
        }
      },
      save: function (data) {
        try {
          var raw = JSON.stringify(data);
          if (typeof localStorage !== 'undefined') localStorage.setItem(key, raw);
          return { ok: true };
        } catch (e) {
          if (e && e.name === 'QuotaExceededError') {
            return { ok: false, error: 'quota-exceeded', message: e.message };
          }
          return { ok: false, error: 'save-failed', message: String(e.message) };
        }
      }
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATUS: STATUS,
    buildAlertKey: buildAlertKey,
    alertKeyFromDetection: alertKeyFromDetection,
    createStore: createStore,
    ingest: ingest,
    getAlerts: getAlerts,
    getAlert: getAlert,
    acknowledge: acknowledge,
    resolve: resolve,
    serialize: serialize,
    deserialize: deserialize,
    createMemoryStorage: createMemoryStorage,
    createLocalStorageAdapter: createLocalStorageAdapter
  };
}));
