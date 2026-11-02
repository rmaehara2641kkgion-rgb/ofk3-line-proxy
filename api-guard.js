/**
 * 既存APIの段階的保護。既定では何もしない (環境変数が空なら素通り)。
 *   API_GUARD_MODE=report         ... 遮断せず、グループ別・資格種別の件数だけ集計 (個人情報・IP・ヘッダーは記録しない)
 *   API_GUARD_ENFORCE=g1,g2       ... 指定グループだけ遮断 (資格なし=401、資格が1つも設定されていない=503)
 * 資格: 管理者セッションCookie / X-Proxy-Secret (サーバー間) / X-Ofk3-Ingest-Token (拡張機能の取込専用) /
 *       Authorization: Bearer <CORTEX_READ_TOKEN> (読み取り専用の非ブラウザ利用元)
 */
'use strict';
var crypto = require('crypto');

// グループ定義: [method|'*', 正規表現]。順に最初に一致したものを採用。
var GROUP_RULES = {
  'cortex-ingest': [['POST', /^\/cortex-priority\/import$/]],
  'cortex-read': [['GET', /^\/cortex-priority$/]],
  'share-write': [['POST', /^\/(route-data|map-image|pdf-upload)$/]],
  'masters': [['*', /^\/(volume-master|addr-master|tenko-master|area-experience-master|area-experience-events)$/], ['GET', /^\/mentor-notified$/]],
  'line-send': [['*', /^\/proxy$/], ['POST', /^\/mentor-alert$/], ['POST', /^\/line-notifications\/toggle$/]],
  'line-unlinked': [['*', /^\/line-unlinked(\/.*)?$/]],
  'exports': [['POST', /^\/(encrypt-zip|decrypt-zip|ftds-export|cc-export|dnr-export|twc-export|lat-export)$/], ['*', /^\/wh60\/(save|status)$/]]
};
// 資格の種類ごとの許可 (グループごと)
var ACCEPT = {
  'cortex-ingest': ['ingestToken', 'session', 'proxySecret'],
  'cortex-read': ['session', 'proxySecret', 'readToken'],
  _default: ['session', 'proxySecret']
};

function groupOf(method, pathname) {
  var names = Object.keys(GROUP_RULES);
  for (var i = 0; i < names.length; i++) {
    var rules = GROUP_RULES[names[i]];
    for (var j = 0; j < rules.length; j++) {
      if ((rules[j][0] === '*' || rules[j][0] === method) && rules[j][1].test(pathname)) return names[i];
    }
  }
  return null;
}

function eq(configured, presented) {
  if (!configured || typeof presented !== 'string' || !presented) return false;
  var a = crypto.createHash('sha256').update(configured).digest();
  var b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

function createApiGuard(deps) {
  var env = deps.env || {};
  var adminAuth = deps.adminAuth; // { isAuthenticated(req), sameOrigin(req) }
  var log = deps.log || function () {};
  var counters = {};

  function enforced() { return String(env.API_GUARD_ENFORCE || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
  function reporting() { return String(env.API_GUARD_MODE || '') === 'report'; }

  function credentials(req) {
    var found = [];
    var bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (adminAuth && adminAuth.isAuthenticated(req)) found.push('session');
    if (eq(env.PROXY_SECRET, req.headers['x-proxy-secret'])) found.push('proxySecret');
    if (eq(env.INGEST_TOKEN, req.headers['x-ofk3-ingest-token'])) found.push('ingestToken');
    if (eq(env.CORTEX_READ_TOKEN, bearer && bearer[1])) found.push('readToken');
    return found;
  }
  function anyConfigured() {
    return !!(env.PROXY_SECRET || env.INGEST_TOKEN || env.CORTEX_READ_TOKEN || (adminAuth && adminAuth.sessions && adminAuth.sessions.enabled));
  }
  function count(group, kind) {
    var c = counters[group] || (counters[group] = { total: 0, anonymous: 0, denied: 0, session: 0, proxySecret: 0, ingestToken: 0, readToken: 0, wouldDeny: 0 });
    c.total++; c[kind]++;
    return c;
  }

  function middleware(req, res, next) {
    var group = groupOf(req.method, req.path);
    if (!group) return next();
    var on = enforced(), isEnforced = on.indexOf(group) >= 0;
    if (!isEnforced && !reporting()) return next();

    var creds = credentials(req), accept = ACCEPT[group] || ACCEPT._default;
    var used = creds.filter(function (c) { return accept.indexOf(c) >= 0; });
    // Cookie認証の更新系はCSRF対策として同一オリジンのみ。他の資格(サーバー間)は対象外。
    var csrfBlocked = used.length === 1 && used[0] === 'session' && req.method !== 'GET' && req.method !== 'HEAD' && adminAuth && !adminAuth.sameOrigin(req);
    var ok = used.length > 0 && !csrfBlocked;
    var kind = ok ? used[0] : (creds.length ? 'denied' : 'anonymous');
    var c = count(group, kind);
    if (!ok && !isEnforced) c.wouldDeny++;

    if (ok || !isEnforced) return next();
    if (!anyConfigured()) { log('[api-guard] ' + group + ' blocked: no credential configured'); return res.status(503).json({ status: 'error', message: 'not configured' }); }
    res.set('Cache-Control', 'no-store');
    return res.status(csrfBlocked ? 403 : 401).json({ status: 'error', message: csrfBlocked ? 'Forbidden' : 'unauthorized' });
  }

  function reportRoute(req, res) {
    var creds = credentials(req);
    if (!anyConfigured()) return res.status(503).json({ status: 'error', message: 'not configured' });
    if (!(creds.indexOf('session') >= 0 || creds.indexOf('proxySecret') >= 0)) return res.status(401).json({ status: 'error', message: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', mode: reporting() ? 'report' : 'off', enforced: enforced(), groups: counters });
  }

  return { middleware: middleware, reportRoute: reportRoute, groupOf: groupOf, GROUP_RULES: GROUP_RULES };
}

module.exports = { createApiGuard: createApiGuard, groupOf: groupOf, GROUP_RULES: GROUP_RULES };
