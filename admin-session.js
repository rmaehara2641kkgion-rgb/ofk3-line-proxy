/**
 * 管理者セッション認証 (ブラウザ向け)。共通secretをブラウザへ配らず、パスワードでログインして
 * HttpOnly + SameSite=Strict のCookieを受け取る。Cookieは署名付き・期限付き(ステートレス)。
 *
 * 環境変数 (未設定なら機能は無効= ログイン不可):
 *   ADMIN_PASSWORD_HASH  scrypt$N$r$p$saltB64$hashB64  (scripts/make-admin-password-hash.js で生成)
 *   ADMIN_SESSION_SECRET 32文字以上。変更すると全セッション失効。
 */
'use strict';
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var COOKIE = 'ofk3_admin';
var DEFAULT_TTL_MS = 12 * 3600 * 1000;

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(secret, data) { return crypto.createHmac('sha256', secret).update(data).digest('base64url'); }
function safeEq(a, b) {
  var x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashPassword(password, opts) {
  opts = opts || {};
  var N = opts.N || 16384, r = 8, p = 1, salt = crypto.randomBytes(16);
  var h = crypto.scryptSync(String(password), salt, 32, { N: N, r: r, p: p });
  return ['scrypt', N, r, p, salt.toString('base64'), h.toString('base64')].join('$');
}
function verifyPassword(password, stored) {
  var parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  var N = +parts[1], r = +parts[2], p = +parts[3];
  if (!(N >= 1024 && N <= 1 << 20 && r >= 1 && r <= 16 && p >= 1 && p <= 4)) return false;
  try {
    var salt = Buffer.from(parts[4], 'base64'), want = Buffer.from(parts[5], 'base64');
    var got = crypto.scryptSync(String(password), salt, want.length, { N: N, r: r, p: p, maxmem: 128 * N * r * 2 });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}

function parseCookies(header) {
  var out = {};
  String(header || '').split(';').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return out;
}

function createSessionManager(opts) {
  var secret = opts.secret || '', ttl = opts.ttlMs || DEFAULT_TTL_MS, clock = opts.clock || Date.now;
  var enabled = secret.length >= 32;
  return {
    enabled: enabled,
    issue: function () {
      var body = 'v1.' + (clock() + ttl) + '.' + b64u(crypto.randomBytes(12));
      return body + '.' + sign(secret, body);
    },
    verify: function (value) {
      if (!enabled || typeof value !== 'string') return false;
      var i = value.lastIndexOf('.');
      if (i < 0) return false;
      var body = value.slice(0, i), sig = value.slice(i + 1), p = body.split('.');
      if (p.length !== 3 || p[0] !== 'v1' || !safeEq(sig, sign(secret, body))) return false;
      return clock() <= Number(p[1]);
    },
    ttlMs: ttl
  };
}

// 同一オリジンからの操作か (Cookie認証のCSRF対策)。Origin優先、無ければReferer。どちらも無ければ不許可。
function sameOrigin(req) {
  var host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  var src = req.headers.origin || req.headers.referer || '';
  if (!host || !src) return false;
  try { return new URL(src).host.toLowerCase() === host; } catch (e) { return false; }
}

function createAdminAuth(deps) {
  var express = deps.express, env = deps.env || {};
  var clock = deps.clock || Date.now;
  var sessions = createSessionManager({ secret: env.ADMIN_SESSION_SECRET || '', clock: clock, ttlMs: deps.ttlMs });
  var fails = {}; // ip -> {n, start}
  var MAX_FAILS = 5, WINDOW = 10 * 60 * 1000;
  function failKey(req) {
    var xff = String(req.headers['x-forwarded-for'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : String((req.socket && req.socket.remoteAddress) || 'unknown');
  }
  function locked(k) { var f = fails[k]; if (f && clock() - f.start >= WINDOW) { delete fails[k]; f = null; } return !!f && f.n >= MAX_FAILS; }

  function isAuthenticated(req) { return sessions.verify(parseCookies(req.headers.cookie)[COOKIE]); }
  function setCookie(res, value, maxAgeSec) {
    var attrs = [COOKIE + '=' + value, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + maxAgeSec];
    if (env.NODE_ENV === 'production') attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  }
  function nostore(res) { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.removeHeader('Access-Control-Allow-Origin'); }

  var router = express.Router();
  var pageDir = path.join(__dirname, 'admin-login');
  router.get('/admin/login', function (req, res) {
    nostore(res);
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.type('html').send(fs.readFileSync(path.join(pageDir, 'index.html')));
  });
  router.get('/admin/login.js', function (req, res) { nostore(res); res.type('application/javascript').send(fs.readFileSync(path.join(pageDir, 'login.js'))); });
  router.get('/admin/session', function (req, res) { nostore(res); res.json({ status: 'ok', authenticated: isAuthenticated(req), configured: sessions.enabled && !!env.ADMIN_PASSWORD_HASH }); });
  router.post('/admin/login', function (req, res) {
    nostore(res);
    if (!sessions.enabled || !env.ADMIN_PASSWORD_HASH) return res.status(503).json({ status: 'error', message: 'not configured' }); // fail-closed
    if (!sameOrigin(req)) return res.status(403).json({ status: 'error', message: 'Forbidden' });
    var k = failKey(req);
    if (locked(k)) return res.status(429).json({ status: 'error', message: 'しばらくしてからお試しください。' });
    var pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!pw || pw.length > 256 || !verifyPassword(pw, env.ADMIN_PASSWORD_HASH)) {
      var f = fails[k] || (fails[k] = { n: 0, start: clock() }); f.n++;
      return res.status(401).json({ status: 'error', message: 'パスワードが違います。' });
    }
    delete fails[k];
    setCookie(res, sessions.issue(), Math.floor(sessions.ttlMs / 1000));
    res.json({ status: 'ok' });
  });
  router.post('/admin/logout', function (req, res) {
    nostore(res);
    if (!sameOrigin(req)) return res.status(403).json({ status: 'error', message: 'Forbidden' });
    setCookie(res, '', 0);
    res.json({ status: 'ok' });
  });
  return { router: router, isAuthenticated: isAuthenticated, sameOrigin: sameOrigin, sessions: sessions };
}

module.exports = { createAdminAuth: createAdminAuth, createSessionManager: createSessionManager, hashPassword: hashPassword, verifyPassword: verifyPassword, parseCookies: parseCookies, sameOrigin: sameOrigin, COOKIE: COOKIE };
