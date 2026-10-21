/**
 * GET  /rolling-alerts/latest … 保存済みの最新アラート結果（要認証）
 * POST /rolling-alerts/save   … 画面で集計した結果を保存（要認証。最新1件を置換）
 *
 * 認証は既存OFK3方式（環境変数のトークン＋リクエストヘッダー。未設定は503、不一致は401。fail-closed）。
 * 受け付けるトークンは deps.getTokens() が返す（ソースコードには埋め込まない）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(this, function () {
  'use strict';

  var crypto = require('crypto');
  var MAX_BODY_CHARS = 1500000;
  var FAIL_WINDOW_MS = 10 * 60 * 1000;
  var FAIL_LIMIT = 20;

  function digest(s) {
    return crypto.createHash('sha256').update(String(s)).digest();
  }

  function tokenMatches(provided, tokens) {
    var d = digest(provided);
    var ok = false;
    tokens.forEach(function (t) {
      if (crypto.timingSafeEqual(d, digest(t))) ok = true; // 全候補と比較（早期returnしない）
    });
    return ok;
  }

  function providedToken(req) {
    var auth = req.headers['authorization'] || '';
    var m = /^Bearer\s+(.+)$/i.exec(auth);
    return (m ? m[1] : '') || req.headers['x-rolling-alert-token'] || req.headers['x-tenko-sync-token'] || '';
  }

  function mount(app, deps) {
    var store = deps.store;
    var getTokens = deps.getTokens || function () { return []; };
    var clock = deps.now || function () { return Date.now(); };
    var failures = {}; // ip -> [timestamps]

    function ipOf(req) {
      return (req.socket && req.socket.remoteAddress) || 'unknown';
    }

    function authorize(req, res) {
      res.set('Cache-Control', 'no-store');
      var tokens = getTokens().filter(Boolean);
      if (tokens.length === 0) {
        res.status(503).json({ status: 'error', message: 'rolling alerts not configured' });
        return false;
      }
      var ip = ipOf(req);
      var now = clock();
      failures[ip] = (failures[ip] || []).filter(function (t) { return now - t < FAIL_WINDOW_MS; });
      if (failures[ip].length >= FAIL_LIMIT) {
        res.status(429).json({ status: 'error', message: 'too many attempts' });
        return false;
      }
      var provided = providedToken(req);
      if (!provided || !tokenMatches(provided, tokens)) {
        failures[ip].push(now);
        res.status(401).json({ status: 'error', message: 'unauthorized' });
        return false;
      }
      return true;
    }

    function body(out) {
      var cur = out.current;
      return { status: out.status, revision: cur.revision, savedAt: cur.savedAt, snapshot: cur.snapshot };
    }

    app.get('/rolling-alerts/latest', function (req, res) {
      if (!authorize(req, res)) return;
      var cur = store.get();
      res.json(cur ? { status: 'ok', revision: cur.revision, savedAt: cur.savedAt, snapshot: cur.snapshot } : { status: 'empty' });
    });

    app.post('/rolling-alerts/save', function (req, res) {
      if (!authorize(req, res)) return;
      try {
        var b = req.body;
        if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ status: 'error', reason: 'body' });
        if (JSON.stringify(b).length > MAX_BODY_CHARS) return res.status(413).json({ status: 'error', reason: 'too-large' });
        if (b.baseRevision != null && (typeof b.baseRevision !== 'string' || b.baseRevision.length > 40)) return res.status(400).json({ status: 'error', reason: 'base-revision' });
        var out = store.put(b.snapshot, { baseRevision: b.baseRevision == null ? null : b.baseRevision, overwrite: b.overwrite === true });
        if (out.status === 'invalid') return res.status(400).json({ status: 'error', reason: out.reason });
        if (out.status === 'conflict') return res.status(409).json(body(out));
        res.json(body(out));
      } catch (e) {
        res.status(500).json({ status: 'error', reason: 'save-failed' });
      }
    });
  }

  return { mount: mount, tokenMatches: tokenMatches };
});
