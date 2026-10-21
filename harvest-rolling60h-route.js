/**
 * ローカル専用。ループバック以外と、同一画面以外からの POST は拒否する。
 * 応答は harvest-rolling60h-run の集計だけ。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestRolling60hRoute = api;
})(this, function () {
  'use strict';

  function isLoopback(req) {
    var addr = '';
    if (req && req.socket && req.socket.remoteAddress) addr = String(req.socket.remoteAddress);
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  function localHeaderOk(req) {
    if (!req || typeof req.get !== 'function') return false;
    return req.get('X-Harvest-Local') === '1';
  }

  function send(res, status, body) {
    res.status(status).json(body);
  }

  function handle(req, res, deps) {
    if (!isLoopback(req) || !localHeaderOk(req)) {
      send(res, 403, { ok: false, reason: 'local-only', sent: false, channel: 'dry-run' });
      return;
    }
    var execute = deps && deps.run;
    if (typeof execute !== 'function') {
      send(res, 500, { ok: false, reason: 'runner-missing', sent: false, channel: 'dry-run' });
      return;
    }
    try {
      send(res, 200, execute());
    } catch (e) {
      send(res, 500, { ok: false, reason: 'run-failed', sent: false, channel: 'dry-run' });
    }
  }

  function unavailablePayload() {
    return {
      ok: false,
      app: 'harvest-rolling60h',
      connected: false,
      fetchStatus: '',
      stale: true,
      checkedAt: null,
      approachRule: '',
      referenceDate: '',
      alerts: []
    };
  }

  function mount(app, deps) {
    app.post('/harvest/rolling60h/run', function (req, res) {
      handle(req, res, deps);
    });
    app.get('/harvest/rolling60h/alerts', function (req, res) {
      if (!isLoopback(req)) {
        send(res, 403, unavailablePayload());
        return;
      }
      var payload = null;
      try {
        payload = deps && typeof deps.readDispatch === 'function' ? deps.readDispatch() : null;
      } catch (e) {
        payload = null;
      }
      if (!payload || payload.app !== 'harvest-rolling60h') {
        send(res, 200, unavailablePayload());
        return;
      }
      send(res, 200, payload);
    });
  }

  return {
    isLoopback: isLoopback,
    handle: handle,
    mount: mount,
  };
});
