/**
 * 回収を再実行しない再送口。ループバックかつローカルヘッダだけを受ける。
 * 応答は結果コードだけ。スナップショット本文とトークンは返さない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DutyRiskRepublishRoute = api;
})(this, function () {
  'use strict';

  var Republish = null;
  try { Republish = require('./duty-risk-republish.js'); } catch (e) { Republish = null; }

  function localHeaderOk(req) {
    if (!req || typeof req.get !== 'function') return false;
    return req.get('X-Harvest-Local') === '1';
  }

  function safeBody(result) {
    var results = result && Array.isArray(result.results) ? result.results : [];
    return {
      ok: !!(result && result.ok === true),
      results: results.map(function (item) {
        var reason = Republish ? Republish.reasonCode(item && item.reason) : 'incomplete';
        var stage = item && item.stage && Republish ? Republish.reasonCode(item.stage) : null;
        var revision = item && item.revision && Republish ? Republish.reasonCode(item.revision) : null;
        var body = {
          checkedAt: item && item.checkedAt ? item.checkedAt : null,
          published: !!(item && item.published === true),
          reason: reason,
          generation: item && item.generation ? item.generation : null,
          duplicate: !!(item && item.duplicate === true),
        };
        if (stage && stage !== 'incomplete' && stage !== 'redacted') body.stage = stage;
        if (revision && revision !== 'incomplete' && revision !== 'redacted') body.revision = revision;
        if (item && typeof item.httpStatus === 'number') body.httpStatus = item.httpStatus;
        return body;
      }),
    };
  }

  function mount(app, deps) {
    app.post('/duty-risk-republish', function (req, res) {
      var loopback = deps && typeof deps.isLoopback === 'function' ? deps.isLoopback(req) : false;
      if (!loopback || !localHeaderOk(req)) {
        res.status(403).json({ ok: false, reason: 'local-only', results: [] });
        return;
      }
      var retry = deps && deps.retry;
      if (typeof retry !== 'function') {
        res.status(503).json({ ok: false, reason: 'not-configured', results: [] });
        return;
      }
      return Promise.resolve().then(function () { return retry(); }).then(function (result) {
        res.status(200).json(safeBody(result));
      }, function () {
        res.status(500).json({ ok: false, reason: 'incomplete', results: [] });
      });
    });
  }

  return {
    localHeaderOk: localHeaderOk,
    safeBody: safeBody,
    mount: mount,
  };
});
