/**
 * ローカル回収のあと、GASへ公開用の2ファイルを送る。
 * 履歴ファイル自体は読まない以外の更新をしない。GASトークンはブラウザへ出さない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DutyRiskGasClient = api;
})(this, function () {
  'use strict';

  var Publication = null;
  try { Publication = require('./duty-risk-publication.js'); } catch (e) { Publication = null; }

  function readJson(fs, filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      return null;
    }
  }

  function afterHarvest(options) {
    options = options || {};
    var summary = options.summary;
    if (!summary || summary.ok !== true) return Promise.resolve({ ok: false, published: false, reason: 'harvest-not-ok' });
    var api = options.publication || Publication;
    var snapshot = options.snapshot != null ? options.snapshot : readJson(options.fs, options.snapshotFile);
    var history = options.history != null ? options.history : readJson(options.fs, options.historyFile);
    var pair = api.selectPair(snapshot, history);
    if (!pair.ok) return Promise.resolve({ ok: false, published: false, reason: pair.reason });
    if (!options.client || typeof options.client.publish !== 'function') {
      return Promise.resolve({ ok: false, published: false, reason: 'not-configured' });
    }
    var timeoutMs = options.timeoutMs || 60000;
    var pending = options.client.publish({
      snapshot: pair.snapshot,
      historyRun: pair.historyRun,
      timeoutMs: timeoutMs,
    });
    var timed = new Promise(function (resolve, reject) {
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
    return timed.then(function (value) {
      return value && value.ok === true ? value : { ok: false, published: false, reason: (value && value.reason) || 'incomplete', lastSuccessAt: value && value.lastSuccessAt || null };
    }).catch(function (error) {
      var code = error && error.code;
      var message = error && error.message ? String(error.message) : '';
      var reason = (code === 'timeout' || code === 'ECONNABORTED' || message === 'timeout' || message.indexOf('timeout') >= 0) ? 'timeout' : 'incomplete';
      return { ok: false, published: false, reason: reason, lastSuccessAt: null };
    });
  }

  function fetchCurrent(options) {
    options = options || {};
    if (!options.client || typeof options.client.current !== 'function') {
      return Promise.resolve({ ok: false, reason: 'not-configured', lastSuccessAt: null });
    }
    var timeoutMs = options.timeoutMs || 60000;
    var pending = options.client.current({ timeoutMs: timeoutMs });
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        resolve({ ok: false, reason: 'timeout', lastSuccessAt: options.lastSuccessAt || null });
      }, timeoutMs);
      Promise.resolve(pending).then(function (value) {
        clearTimeout(timer);
        resolve(value || { ok: false, reason: 'read-failed', lastSuccessAt: options.lastSuccessAt || null });
      }, function () {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'read-failed', lastSuccessAt: options.lastSuccessAt || null });
      });
    });
  }

  return {
    afterHarvest: afterHarvest,
    fetchCurrent: fetchCurrent,
  };
});
