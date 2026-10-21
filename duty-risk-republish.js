/**
 * 公開に失敗したスナップショットと履歴runをローカルに残し、回収を再実行せず再送する。
 * checkedAt と predictedAt が完全一致する組だけを送る。
 * 公開済みの同じ世代は再送しない。古い世代で新しい公開済みデータを上書きしない。
 * ログには結果コードだけを出す。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DutyRiskRepublish = api;
})(this, function () {
  'use strict';

  var Publication = null;
  try { Publication = require('./duty-risk-publication.js'); } catch (e) { Publication = null; }

  var REASONS = [
    'timeout', 'incomplete', 'mismatch', 'stale', 'already-published', 'published',
    'not-configured', 'unauthorized', 'busy', 'read-failed', 'queue-unreadable',
    'queue-not-saved', 'nothing-pending', 'duplicate'
  ];

  function reasonCode(value) {
    return REASONS.indexOf(value) >= 0 ? value : 'incomplete';
  }

  function reasonOfError(error) {
    var code = error && error.code;
    var message = error && error.message ? String(error.message) : '';
    if (code === 'timeout' || code === 'ECONNABORTED' || message === 'timeout' || message.indexOf('timeout') >= 0) return 'timeout';
    return 'incomplete';
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readQueue(fs, file) {
    var text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { version: 1, items: [] };
      return null;
    }
    try {
      var parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.items)) return null;
      return parsed;
    } catch (e2) {
      return null;
    }
  }

  function writeQueue(fs, pathMod, file, queue) {
    try {
      var dir = pathMod.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      var tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: queue.items }));
      var parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      if (!parsed || !Array.isArray(parsed.items) || parsed.items.length !== queue.items.length) {
        try { fs.unlinkSync(tmp); } catch (e) {}
        return false;
      }
      fs.renameSync(tmp, file);
      return true;
    } catch (e2) {
      return false;
    }
  }

  function findItem(queue, checkedAt) {
    var found = null;
    (queue.items || []).forEach(function (item) {
      if (item && item.checkedAt === checkedAt) found = item;
    });
    return found;
  }

  function storePair(fs, pathMod, file, snapshot, history, status, reason) {
    if (!Publication) return { ok: false, reason: 'not-configured' };
    var pair = Publication.selectPair(snapshot, history);
    if (!pair.ok || pair.snapshot.checkedAt !== pair.historyRun.predictedAt) {
      return { ok: false, reason: 'mismatch' };
    }
    var queue = readQueue(fs, file);
    if (!queue) return { ok: false, reason: 'queue-unreadable' };
    var found = findItem(queue, pair.snapshot.checkedAt);
    if (found && (found.status === 'published' || found.status === 'superseded') && status === 'pending') {
      return { ok: true, kept: true, reason: found.status === 'published' ? 'already-published' : 'stale' };
    }
    if (!found) {
      found = { checkedAt: pair.snapshot.checkedAt, attempts: 0 };
      queue.items.push(found);
    }
    found.snapshot = clone(pair.snapshot);
    found.historyRun = clone(pair.historyRun);
    found.status = status;
    found.lastReason = reasonCode(reason);
    if (status !== 'published') found.generation = found.generation || null;
    if (!writeQueue(fs, pathMod, file, queue)) return { ok: false, reason: 'queue-not-saved', kept: true };
    return { ok: true, kept: true, reason: found.lastReason, checkedAt: found.checkedAt };
  }

  function markPublished(fs, pathMod, file, checkedAt, generation) {
    if (!checkedAt) return { ok: false, reason: 'mismatch' };
    var queue = readQueue(fs, file);
    if (!queue) return { ok: false, reason: 'queue-unreadable' };
    var found = findItem(queue, checkedAt);
    if (!found) {
      found = { checkedAt: checkedAt, attempts: 0, snapshot: null, historyRun: null };
      queue.items.push(found);
    }
    found.status = 'published';
    found.generation = generation || found.generation || null;
    found.lastReason = 'published';
    if (!writeQueue(fs, pathMod, file, queue)) return { ok: false, reason: 'queue-not-saved', kept: true };
    return { ok: true, kept: true, reason: 'published', checkedAt: checkedAt, generation: found.generation };
  }

  function remember(fs, pathMod, file, snapshot, history, outcome) {
    outcome = outcome || {};
    var checkedAt = snapshot && snapshot.checkedAt;
    var confirmed = outcome.published === true || outcome.duplicate === true || outcome.reason === 'already-published';
    if (confirmed && checkedAt && (!outcome.checkedAt || outcome.checkedAt === checkedAt)) {
      return markPublished(fs, pathMod, file, checkedAt, outcome.generation || null);
    }
    if (outcome.reason === 'stale') {
      return storePair(fs, pathMod, file, snapshot, history, 'superseded', 'stale');
    }
    return storePair(fs, pathMod, file, snapshot, history, 'pending', outcome.reason || 'incomplete');
  }

  function withTimeout(pending, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var error = new Error('timeout');
        error.code = 'timeout';
        reject(error);
      }, timeoutMs);
      Promise.resolve(pending).then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function publicResult(checkedAt, published, reason, generation, duplicate) {
    return {
      checkedAt: checkedAt || null,
      published: published === true,
      reason: reasonCode(reason),
      generation: generation || null,
      duplicate: duplicate === true,
    };
  }

  function emit(options, logs, result) {
    var line = '再送結果 ' + JSON.stringify(publicResult(result.checkedAt, result.published, result.reason, result.generation, result.duplicate));
    logs.push(line);
    if (typeof options.log === 'function') options.log(line);
  }

  function readCurrent(options, timeoutMs) {
    if (!options.client || typeof options.client.current !== 'function') {
      return Promise.resolve({ ok: false, reason: 'not-configured', skippedPreflight: true });
    }
    var pending;
    try {
      pending = options.client.current({ timeoutMs: timeoutMs });
    } catch (error) {
      return Promise.resolve({ ok: false, reason: reasonOfError(error) });
    }
    return withTimeout(pending, timeoutMs).then(function (value) {
      return value || { ok: false, reason: 'read-failed' };
    }, function (error) {
      return { ok: false, reason: reasonOfError(error) };
    });
  }

  function sendPublish(options, pair, timeoutMs) {
    var pending;
    try {
      pending = options.client.publish({
        snapshot: pair.snapshot,
        historyRun: pair.historyRun,
        timeoutMs: timeoutMs,
      });
    } catch (error) {
      return Promise.resolve({ ok: false, published: false, reason: reasonOfError(error) });
    }
    return withTimeout(pending, timeoutMs).then(function (value) {
      return value || { ok: false, published: false, reason: 'incomplete' };
    }, function (error) {
      return { ok: false, published: false, reason: reasonOfError(error) };
    });
  }

  function blockingReason(reason) {
    return reason === 'timeout' || reason === 'incomplete' || reason === 'unauthorized'
      || reason === 'not-configured' || reason === 'busy' || reason === 'read-failed' || reason === 'queue-not-saved';
  }

  function attempt(options, item, timeoutMs) {
    item.attempts = (item.attempts || 0) + 1;
    if (!Publication) {
      item.lastReason = 'not-configured';
      return Promise.resolve({ result: publicResult(item.checkedAt, false, 'not-configured', null, false), stop: true });
    }
    var pair = Publication.selectPair(item.snapshot, { runs: [item.historyRun] });
    if (!pair.ok || pair.snapshot.checkedAt !== pair.historyRun.predictedAt) {
      item.status = 'rejected';
      item.lastReason = 'mismatch';
      return Promise.resolve({ result: publicResult(item.snapshot && item.snapshot.checkedAt, false, 'mismatch', null, false), stop: false });
    }
    return readCurrent(options, timeoutMs).then(function (current) {
      if (!(current && current.skippedPreflight)) {
        if (!current || current.ok !== true) {
          if (!current || current.reason !== 'not-published') {
            var stopped = reasonCode(current && current.reason);
            item.status = 'pending';
            item.lastReason = stopped;
            return { result: publicResult(pair.snapshot.checkedAt, false, stopped, null, false), stop: true };
          }
        } else {
          var relation = Publication.compareGeneration(current.checkedAt, pair.snapshot.checkedAt);
          if (relation === 'same') {
            item.status = 'published';
            item.generation = current.generation || null;
            item.lastReason = 'already-published';
            return { result: publicResult(pair.snapshot.checkedAt, false, 'already-published', item.generation, true), stop: false };
          }
          if (relation === 'older' || relation === 'incomparable') {
            item.status = relation === 'older' ? 'superseded' : 'rejected';
            item.lastReason = relation === 'older' ? 'stale' : 'mismatch';
            return { result: publicResult(pair.snapshot.checkedAt, false, item.lastReason, null, false), stop: false };
          }
        }
      }
      return sendPublish(options, pair, timeoutMs).then(function (value) {
        if (value && value.published === true && value.checkedAt === pair.snapshot.checkedAt) {
          item.status = 'published';
          item.generation = value.generation || null;
          item.lastReason = 'published';
          return { result: publicResult(pair.snapshot.checkedAt, true, 'published', item.generation, false), stop: false };
        }
        if (value && (value.duplicate === true || value.reason === 'already-published') && (!value.checkedAt || value.checkedAt === pair.snapshot.checkedAt)) {
          item.status = 'published';
          item.generation = value.generation || item.generation || null;
          item.lastReason = 'already-published';
          return { result: publicResult(pair.snapshot.checkedAt, false, 'already-published', item.generation, true), stop: false };
        }
        if (value && value.reason === 'stale') {
          item.status = 'superseded';
          item.lastReason = 'stale';
          return { result: publicResult(pair.snapshot.checkedAt, false, 'stale', null, false), stop: false };
        }
        if (value && value.reason === 'mismatch') {
          item.status = 'rejected';
          item.lastReason = 'mismatch';
          return { result: publicResult(pair.snapshot.checkedAt, false, 'mismatch', null, false), stop: false };
        }
        var reason = reasonCode(value && value.reason);
        item.status = 'pending';
        item.lastReason = reason;
        return { result: publicResult(pair.snapshot.checkedAt, false, reason, null, false), stop: blockingReason(reason) };
      });
    });
  }

  function retrySaved(options) {
    options = options || {};
    var logs = [];
    function finish(ok, results) {
      return { ok: ok === true, results: results, lines: logs.slice() };
    }
    if (!options.fs || !options.path || !options.queueFile) {
      var missing = publicResult(null, false, 'not-configured', null, false);
      emit(options, logs, missing);
      return Promise.resolve(finish(false, [missing]));
    }
    var queue = readQueue(options.fs, options.queueFile);
    if (!queue) {
      var unreadable = publicResult(null, false, 'queue-unreadable', null, false);
      emit(options, logs, unreadable);
      return Promise.resolve(finish(false, [unreadable]));
    }
    var pending = queue.items.filter(function (item) { return item && item.status === 'pending'; });
    pending.sort(function (a, b) {
      var at = Date.parse(a.checkedAt || '');
      var bt = Date.parse(b.checkedAt || '');
      if (!isFinite(at) || !isFinite(bt)) return 0;
      return bt - at;
    });
    if (!pending.length) {
      var empty = publicResult(null, false, 'nothing-pending', null, false);
      emit(options, logs, empty);
      return Promise.resolve(finish(true, [empty]));
    }
    if (!options.client || typeof options.client.publish !== 'function') {
      var skipped = pending.map(function (item) {
        item.lastReason = 'not-configured';
        return publicResult(item.checkedAt, false, 'not-configured', null, false);
      });
      writeQueue(options.fs, options.path, options.queueFile, queue);
      skipped.forEach(function (result) { emit(options, logs, result); });
      return Promise.resolve(finish(false, skipped));
    }
    var timeoutMs = options.timeoutMs || 60000;
    function step(index, results) {
      if (index >= pending.length) return Promise.resolve(finish(true, results));
      return attempt(options, pending[index], timeoutMs).then(function (outcome) {
        if (!writeQueue(options.fs, options.path, options.queueFile, queue)) {
          outcome.result = publicResult(outcome.result.checkedAt, false, 'queue-not-saved', outcome.result.generation, outcome.result.duplicate);
          outcome.stop = true;
        }
        results.push(outcome.result);
        emit(options, logs, outcome.result);
        if (outcome.stop) return finish(false, results);
        return step(index + 1, results);
      });
    }
    return step(0, []);
  }

  return {
    reasonCode: reasonCode,
    readQueue: readQueue,
    remember: remember,
    markPublished: markPublished,
    retrySaved: retrySaved,
  };
});
