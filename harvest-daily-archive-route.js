/**
 * デイリー実績の自動保管設定。ループバック以外からは変更できない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestDailyArchiveRoute = api;
})(this, function () {
  'use strict';

  function mount(app, deps) {
    deps = deps || {};
    function localOnly(req) {
      return typeof deps.isLoopback === 'function' && deps.isLoopback(req);
    }
    function send(res, status, body) {
      res.status(status).json(body);
    }
    app.get('/harvest/daily-archive/status', function (req, res) {
      try {
        if (!localOnly(req)) return send(res, 403, { ok: false, reason: 'local-only' });
        if (!deps.service) return send(res, 503, { ok: false, reason: 'not-configured' });
        send(res, 200, deps.service.publicState());
      } catch (e) {
        send(res, 500, { ok: false, reason: 'read-failed' });
      }
    });
    app.post('/harvest/daily-archive/settings', function (req, res) {
      try {
        if (!localOnly(req)) return send(res, 403, { ok: false, reason: 'local-only' });
        if (!deps.service) return send(res, 503, { ok: false, reason: 'not-configured' });
        var saved = deps.service.saveSettings(req.body || {});
        send(res, saved.ok ? 200 : 400, saved.ok ? deps.service.publicState() : { ok: false, reason: saved.reason });
      } catch (e) {
        send(res, 500, { ok: false, reason: 'save-failed' });
      }
    });
  }

  return { mount: mount };
});
