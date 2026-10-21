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
    Promise.resolve(loader()).then(function (body) {
      if (body && body.ok === true && body.checkedAt) deps.lastSuccessAt = body.checkedAt;
      var status = body && body.ok === true ? 200 : (body && body.reason === 'timeout' ? 504 : 502);
      if (body && body.ok !== true && !body.lastSuccessAt && deps.lastSuccessAt) body.lastSuccessAt = deps.lastSuccessAt;
      res.status(status).json(body || { ok: false, reason: 'read-failed', lastSuccessAt: deps.lastSuccessAt || null });
    }).catch(function () {
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
