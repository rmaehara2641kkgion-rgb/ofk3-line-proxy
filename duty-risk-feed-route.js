/**
 * 画面向けの取得口。GASトークンはサーバー側だけが使う。
 * ブラウザは既存の PROXY_SECRET を提示しないと本文を受け取れない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DutyRiskFeedRoute = api;
})(this, function () {
  'use strict';

  var Publication = null;
  try { Publication = require('./duty-risk-publication.js'); } catch (e) { Publication = null; }

  function presentedSecret(req) {
    if (!req) return '';
    if (req.headers && (req.headers['x-proxy-secret'] || req.headers['X-Proxy-Secret'])) {
      return String(req.headers['x-proxy-secret'] || req.headers['X-Proxy-Secret']);
    }
    if (typeof req.get === 'function') return String(req.get('X-Proxy-Secret') || '');
    return '';
  }

  function handle(req, res, deps) {
    deps = deps || {};
    var api = deps.publication || Publication;
    var expected = typeof deps.proxySecret === 'function' ? deps.proxySecret() : deps.proxySecret;
    var auth = api.authorize(expected || '', presentedSecret(req));
    if (!auth.ok) {
      res.status(auth.status).json({ ok: false, reason: auth.reason, lastSuccessAt: null });
      return;
    }
    var loader = deps.load;
    if (typeof loader !== 'function') {
      res.status(503).json({ ok: false, reason: 'not-configured', lastSuccessAt: deps.lastSuccessAt || null });
      return;
    }
    var log = typeof deps.log === 'function' ? deps.log : function () {};
    Promise.resolve(loader()).then(function (body) {
      if (!body || typeof body !== 'object') body = { ok: false, reason: 'invalid-response' };
      if (body.ok === true && body.checkedAt) deps.lastSuccessAt = body.checkedAt;
      // 成功していない応答に snapshot 等の本文が混ざっていても画面へ渡さない。
      var status = body.ok === true ? 200 : (body.reason === 'timeout' ? 504 : (body.reason === 'not-published' ? 200 : 502));
      if (body.ok !== true) {
        if (!body.lastSuccessAt && deps.lastSuccessAt) body.lastSuccessAt = deps.lastSuccessAt;
        delete body.snapshot;
        delete body.historyRun;
        log('duty-risk-feed not ok: reason=' + String(body.reason || 'unknown').replace(/[^\w-]/g, ''));
      }
      res.status(status).json(body);
    }).catch(function (error) {
      log('duty-risk-feed loader threw: ' + (error && error.name ? error.name : 'Error'));
      res.status(502).json({ ok: false, reason: 'read-failed', lastSuccessAt: deps.lastSuccessAt || null });
    });
  }

  function mount(app, deps) {
    app.get('/duty-risk-feed', function (req, res) {
      handle(req, res, deps);
    });
  }

  return {
    presentedSecret: presentedSecret,
    handle: handle,
    mount: mount,
  };
});
