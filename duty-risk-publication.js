/**
 * 勤務時間リスクの公開データ。
 * 計算はしない。成功済みのスナップショットと、同じ checkedAt の履歴runだけを選ぶ。
 * ポインタは両方の書き込みと照合が終わってから更新する。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DutyRiskPublication = api;
})(this, function () {
  'use strict';

  function selectPair(snapshot, history) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.checkedAt) {
      return { ok: false, reason: 'snapshot-missing' };
    }
    if (snapshot.usable !== true) return { ok: false, reason: 'snapshot-not-usable' };
    if (snapshot.fetchStatus !== 'success' && snapshot.fetchStatus !== 'partial') {
      return { ok: false, reason: 'snapshot-not-success' };
    }
    var runs = history && Array.isArray(history.runs) ? history.runs : [];
    var matches = [];
    runs.forEach(function (run) {
      if (run && run.predictedAt === snapshot.checkedAt) matches.push(run);
    });
    if (matches.length !== 1) return { ok: false, reason: 'mismatch' };
    var run = matches[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(run.referenceDate || '') || !Array.isArray(run.predictions)) {
      return { ok: false, reason: 'mismatch' };
    }
    return { ok: true, snapshot: snapshot, historyRun: run };
  }

  function readPointerCheckedAt(store) {
    try {
      var pointer = store.readPointer();
      return pointer && pointer.checkedAt ? pointer.checkedAt : null;
    } catch (e) {
      return null;
    }
  }

  function compareGeneration(currentCheckedAt, incomingCheckedAt) {
    if (!currentCheckedAt) return 'absent';
    if (currentCheckedAt === incomingCheckedAt) return 'same';
    var currentTime = Date.parse(currentCheckedAt);
    var incomingTime = Date.parse(incomingCheckedAt);
    if (!isFinite(currentTime) || !isFinite(incomingTime) || currentTime === incomingTime) return 'incomparable';
    return currentTime > incomingTime ? 'older' : 'newer';
  }

  function publishToStore(store, pair) {
    var previousPointer = null;
    try { previousPointer = store.readPointer(); } catch (e) { previousPointer = null; }
    var previous = previousPointer && previousPointer.checkedAt ? previousPointer.checkedAt : null;
    if (!pair || pair.ok !== true || !pair.snapshot || !pair.historyRun) {
      return { ok: false, published: false, reason: pair && pair.reason ? pair.reason : 'mismatch', lastSuccessAt: previous };
    }
    if (pair.snapshot.checkedAt !== pair.historyRun.predictedAt) {
      return { ok: false, published: false, reason: 'mismatch', lastSuccessAt: previous };
    }
    var relation = compareGeneration(previous, pair.snapshot.checkedAt);
    if (relation === 'same') {
      return {
        ok: true,
        published: false,
        duplicate: true,
        reason: 'already-published',
        generation: previousPointer.generation || null,
        checkedAt: previous,
        lastSuccessAt: previous,
      };
    }
    if (relation === 'older') {
      return { ok: false, published: false, reason: 'stale', lastSuccessAt: previous };
    }
    if (relation === 'incomparable') {
      return { ok: false, published: false, reason: 'mismatch', lastSuccessAt: previous };
    }
    var generation = 'gen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    try {
      store.writePart(generation, 'snapshot', pair.snapshot);
      store.writePart(generation, 'history-run', pair.historyRun);
      var savedSnapshot = store.readPart(generation, 'snapshot');
      var savedRun = store.readPart(generation, 'history-run');
      if (!savedSnapshot || savedSnapshot.checkedAt !== pair.snapshot.checkedAt) throw new Error('verify-snapshot');
      if (!savedRun || savedRun.predictedAt !== pair.snapshot.checkedAt) throw new Error('verify-run');
      if (!Array.isArray(savedRun.predictions) || savedRun.predictions.length !== pair.historyRun.predictions.length) {
        throw new Error('verify-run');
      }
      store.writePointer({
        generation: generation,
        checkedAt: pair.snapshot.checkedAt,
        snapshotPart: 'snapshot',
        historyPart: 'history-run',
      });
      return { ok: true, published: true, generation: generation, checkedAt: pair.snapshot.checkedAt };
    } catch (e) {
      var reason = e && e.message === 'timeout' ? 'timeout' : 'incomplete';
      return { ok: false, published: false, reason: reason, lastSuccessAt: readPointerCheckedAt(store) || previous };
    }
  }

  function readPublished(store) {
    var pointer = null;
    try { pointer = store.readPointer(); } catch (e) {
      return { ok: false, reason: 'read-failed', lastSuccessAt: null };
    }
    if (!pointer || !pointer.generation || !pointer.checkedAt) {
      return { ok: false, reason: 'not-published', lastSuccessAt: null };
    }
    try {
      var snapshot = store.readPart(pointer.generation, pointer.snapshotPart || 'snapshot');
      var historyRun = store.readPart(pointer.generation, pointer.historyPart || 'history-run');
      if (!snapshot || !historyRun || snapshot.checkedAt !== pointer.checkedAt || historyRun.predictedAt !== pointer.checkedAt) {
        return { ok: false, reason: 'read-failed', lastSuccessAt: pointer.checkedAt };
      }
      return { ok: true, snapshot: snapshot, historyRun: historyRun, checkedAt: pointer.checkedAt, generation: pointer.generation };
    } catch (e2) {
      var reason = e2 && e2.message === 'timeout' ? 'timeout' : 'read-failed';
      return { ok: false, reason: reason, lastSuccessAt: pointer.checkedAt };
    }
  }

  function authorize(expected, presented) {
    if (!expected) return { ok: false, status: 503, reason: 'not-configured' };
    if (!presented || presented !== expected) return { ok: false, status: 401, reason: 'unauthorized' };
    return { ok: true, status: 200 };
  }

  function presentedToken(message) {
    message = message || {};
    if (message.headerToken) return String(message.headerToken);
    if (message.body && message.body.token) return String(message.body.token);
    if (message.queryToken) return String(message.queryToken);
    return '';
  }

  function handleStoreRequest(message, store, expectedToken) {
    var auth = authorize(expectedToken, presentedToken(message));
    if (!auth.ok) {
      return { status: auth.status, body: { ok: false, reason: auth.reason, lastSuccessAt: null } };
    }
    var action = message && (message.action || (message.body && message.body.action));
    if (action === 'publish') {
      var body = message.body || {};
      var pair = selectPair(body.snapshot, { runs: [body.historyRun] });
      var saved = publishToStore(store, pair);
      return { status: saved.ok ? 200 : 409, body: saved };
    }
    if (action === 'current') {
      var current = readPublished(store);
      return { status: current.ok ? 200 : 502, body: current };
    }
    return { status: 400, body: { ok: false, reason: 'unknown-action', lastSuccessAt: readPointerCheckedAt(store) } };
  }

  function createMemoryStore() {
    var parts = {};
    var pointer = null;
    return {
      readPointer: function () { return pointer ? JSON.parse(JSON.stringify(pointer)) : null; },
      writePart: function (generation, name, value) {
        parts[generation + '/' + name] = JSON.parse(JSON.stringify(value));
      },
      readPart: function (generation, name) {
        var value = parts[generation + '/' + name];
        return value ? JSON.parse(JSON.stringify(value)) : null;
      },
      writePointer: function (value) { pointer = JSON.parse(JSON.stringify(value)); },
    };
  }

  return {
    selectPair: selectPair,
    compareGeneration: compareGeneration,
    publishToStore: publishToStore,
    readPublished: readPublished,
    authorize: authorize,
    presentedToken: presentedToken,
    handleStoreRequest: handleStoreRequest,
    createMemoryStore: createMemoryStore,
  };
});
