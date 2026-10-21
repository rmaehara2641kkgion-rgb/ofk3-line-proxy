/**
 * GET  /rolling-alerts/latest … 保存済みの最新アラート結果
 * POST /rolling-alerts/save   … 画面で集計した結果を保存（最新1件を置換）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(this, function () {
  'use strict';

  function mount(app, deps) {
    var store = deps.store;

    app.get('/rolling-alerts/latest', function (req, res) {
      res.set('Cache-Control', 'no-store');
      var snap = store.get();
      res.json(snap ? { status: 'ok', snapshot: snap } : { status: 'empty' });
    });

    app.post('/rolling-alerts/save', function (req, res) {
      res.set('Cache-Control', 'no-store');
      try {
        var out = store.put(req.body && req.body.snapshot);
        if (out.status === 'invalid') return res.status(400).json({ status: 'error', reason: out.reason });
        if (out.status === 'stale-rejected') return res.status(409).json({ status: 'stale-rejected', snapshot: out.snapshot });
        res.json({ status: out.status, snapshot: out.snapshot });
      } catch (e) {
        res.status(500).json({ status: 'error', reason: 'save-failed' });
      }
    });
  }

  return { mount: mount };
});
