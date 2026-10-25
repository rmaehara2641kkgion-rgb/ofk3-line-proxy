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

  // 秘密情報を含めず、原因の切り分けに足りる最小情報だけを返す。
  function describeError(error) {
    var response = error && error.response;
    var status = response && response.status ? response.status : null;
    var code = error && error.code ? String(error.code) : '';
    var reason = 'network';
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || (error && error.message === 'timeout')) reason = 'timeout';
    else if (status) reason = 'upstream-http';
    return { reason: reason, httpStatus: status, code: code };
  }

  function fetchCurrent(options) {
    options = options || {};
    var log = typeof options.log === 'function' ? options.log : function () {};
    if (!options.client || typeof options.client.current !== 'function') {
      return Promise.resolve({ ok: false, reason: 'not-configured', lastSuccessAt: options.lastSuccessAt || null });
    }
    var timeoutMs = options.timeoutMs || 60000;
    var lastSuccessAt = options.lastSuccessAt || null;
    var pending;
    try {
      pending = options.client.current({ timeoutMs: timeoutMs });
    } catch (syncError) {
      pending = Promise.reject(syncError);
    }
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        log('duty-risk fetchCurrent failed: reason=timeout');
        resolve({ ok: false, reason: 'timeout', lastSuccessAt: lastSuccessAt });
      }, timeoutMs);
      Promise.resolve(pending).then(function (value) {
        clearTimeout(timer);
        // GAS が JSON ではなくログイン画面等のHTMLを返した場合は文字列になる。
        if (!value || typeof value !== 'object') {
          log('duty-risk fetchCurrent failed: reason=invalid-response type=' + typeof value);
          resolve({ ok: false, reason: 'invalid-response', lastSuccessAt: lastSuccessAt });
          return;
        }
        if (value.ok !== true) {
          log('duty-risk fetchCurrent not ok: reason=' + String(value.reason || 'unknown').replace(/[^\w-]/g, ''));
        }
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        var info = describeError(error);
        log('duty-risk fetchCurrent failed: reason=' + info.reason + ' http=' + (info.httpStatus || '-') + ' code=' + (info.code || '-'));
        resolve({ ok: false, reason: info.reason, httpStatus: info.httpStatus, lastSuccessAt: lastSuccessAt });
      });
    });
  }

  return {
    afterHarvest: afterHarvest,
    fetchCurrent: fetchCurrent,
  };
});
