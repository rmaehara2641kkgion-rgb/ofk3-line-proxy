/**
 * LINE MAP: 割当同期 / 署名付きWebhook / トークンMAP閲覧 / 管理者モックプレビュー / 状態確認。
 * 実LINE送信はここでは行わない。返信は deps.reply (本番では既定で無効) 経由のみ。
 */
'use strict';
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var Core = require('./line-map-reply-core.js');

var VIEW_DIR = path.join(__dirname, 'line-map-view');
var VIEW_FILES = {
  '/line-map/view': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/line-map/assets/view.js': { file: 'view.js', type: 'application/javascript; charset=utf-8' },
  '/line-map/assets/view.css': { file: 'view.css', type: 'text/css; charset=utf-8' }
};
var CSP = "default-src 'none'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com; "
  + "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com; connect-src 'self'; "
  + "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function secretEquals(configured, presented) {
  if (!configured || typeof presented !== 'string' || !presented) return false;
  var a = crypto.createHash('sha256').update(configured).digest();
  var b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

// 固定窓レート制限 (メモリ)。count(key) が上限以内なら true。
function createRateLimiter(max, windowMs, clock) {
  var nowFn = clock || Date.now, hits = {};
  function prune(t) { Object.keys(hits).forEach(function (k) { if (t - hits[k].start >= windowMs) delete hits[k]; }); }
  return {
    hit: function (key) {
      var t = nowFn(); prune(t);
      var h = hits[key] || (hits[key] = { start: t, n: 0 });
      h.n++;
      return h.n <= max;
    },
    blocked: function (key) { var t = nowFn(); prune(t); return !!hits[key] && hits[key].n >= max; }
  };
}

// Render は XFF の末尾に実クライアントIPを追記する。先頭は偽装可能なので末尾を使う。
function clientKey(req) {
  var xff = String(req.headers['x-forwarded-for'] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : String((req.socket && req.socket.remoteAddress) || 'unknown');
}

function secure(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.removeHeader('Access-Control-Allow-Origin'); // 全体CORS(*)をこの経路では外す
}

/**
 * deps: express, env{PROXY_SECRET, LINE_CHANNEL_SECRET, PUBLIC_ORIGIN, SHOW_ADDRESS}, assignmentStore, tokenStore, tokenFile?,
 *       getRouteStops(date), reply(replyToken, messages), now(), todayJst(), clock?
 */
function createLineMapRouter(deps) {
  var router = deps.express.Router();
  var env = deps.env || {};
  var nowFn = deps.now || Date.now;
  var dedup = deps.dedup || Core.createDedupStore();
  var viewLimiter = deps.viewLimiter || createRateLimiter(60, 60000, deps.clock);       // 1IPあたり60回/分
  var badTokenLimiter = deps.badTokenLimiter || createRateLimiter(10, 600000, deps.clock); // 無効トークン10回/10分で遮断
  var badSecretLimiter = deps.badSecretLimiter || createRateLimiter(10, 600000, deps.clock);

  if (deps.tokenFile) {
    try { deps.tokenStore.importState(JSON.parse(fs.readFileSync(deps.tokenFile, 'utf8'))); } catch (e) { /* 初回/破損は空で開始 */ }
  }
  function persistTokens() {
    if (!deps.tokenFile) return;
    try {
      fs.mkdirSync(path.dirname(deps.tokenFile), { recursive: true });
      fs.writeFileSync(deps.tokenFile, JSON.stringify(deps.tokenStore.exportState()), { encoding: 'utf8', mode: 0o600 });
    } catch (e) { /* 永続化失敗は致命にしない (トークンは短命) */ }
  }
  var origIssue = deps.tokenStore.issue;
  var tokenStore = Object.assign({}, deps.tokenStore, { issue: function (b) { var t = origIssue(b); persistTokens(); return t; } });

  // 管理系エンドポイントの認証: X-Proxy-Secret (サーバー間) または 管理者セッション (ブラウザ。OFK3 #78 の方式)。
  // 更新系(POST)のセッション認証は同一Originのみ (CSRF対策)。どちらの資格も設定が無ければ503 (fail-closed)。
  function requireProxySecret(req, res) {
    var key = clientKey(req);
    if (badSecretLimiter.blocked(key)) { res.status(429).json({ status: 'error', message: 'too many requests' }); return false; }
    var sessionAvailable = !!(deps.isAdminSession && deps.sessionConfigured && deps.sessionConfigured());
    if (!env.PROXY_SECRET && !sessionAvailable) { res.status(503).json({ status: 'error', message: 'not configured' }); return false; } // fail-closed
    if (secretEquals(env.PROXY_SECRET, req.headers['x-proxy-secret'])) return true;
    if (sessionAvailable && deps.isAdminSession(req) && (req.method === 'GET' || (deps.sameOrigin && deps.sameOrigin(req)))) return true;
    badSecretLimiter.hit(key);
    res.status(403).json({ status: 'error', message: 'Forbidden' }); return false;
  }
  function mapUrlFor(token) { return (env.PUBLIC_ORIGIN || '') + '/line-map/view#' + token; } // トークンはフラグメント
  // 未復元(外部ストア障害) → 'not-ready'、その日の割当が一度も同期されていない(再起動で消えた/未取込) → 'not-synced'。
  // どちらも配送情報は返さない。「未割当」とは区別する。
  function readiness(date) {
    if (!deps.assignmentStore.isRestored()) return 'not-ready';
    if (date && !deps.assignmentStore.hasDate(date)) return 'not-synced';
    return null;
  }

  function pipelineDeps() {
    return {
      channelSecret: env.LINE_CHANNEL_SECRET, dedup: dedup, tokenStore: tokenStore,
      getReadiness: function (date) { return readiness(date); },
      getLinkedMap: function (d) { return deps.assignmentStore.linkedMapFor(d); },
      getAssignments: function (d) { return deps.assignmentStore.assignmentsFor(d); },
      getRouteStops: deps.getRouteStops, reply: deps.reply, mapUrlFor: mapUrlFor, now: nowFn
    };
  }

  // 割当同期
  router.post('/line-map/assignments', async function (req, res) {
    if (!requireProxySecret(req, res)) return;
    await deps.assignmentStore.ensureRestored();
    var r = deps.assignmentStore.sync(req.body, deps.todayJst ? deps.todayJst() : null);
    if (!r.ok) return res.status(400).json({ status: 'error', errors: r.errors });
    var remote = await deps.assignmentStore.flush();
    res.json({ status: 'ok', date: r.date, rowCount: r.rowCount, linkCount: r.linkCount, persisted: r.persisted, remote: remote });
  });

  // 新Webhook (常に署名必須。Secret未設定は503=fail-closed)
  router.post('/line-map/webhook', async function (req, res) {
    if (!env.LINE_CHANNEL_SECRET) return res.status(503).json({ status: 'error', message: 'not configured' });
    await deps.assignmentStore.ensureRestored();
    var out = await Core.handleWebhook(req.rawBody, req.headers['x-line-signature'], pipelineDeps());
    if (out.status !== 200) return res.status(out.status).json({ status: 'error' });
    res.json({ status: 'ok' });
  });

  // 閲覧ページ(静的シェル。トークンは含まない)
  Object.keys(VIEW_FILES).forEach(function (route) {
    router.get(route, function (req, res) {
      secure(res);
      if (route === '/line-map/view') res.set('Content-Security-Policy', CSP);
      if (!viewLimiter.hit('v|' + clientKey(req))) return res.status(429).type('text').send('Too Many Requests');
      var f = VIEW_FILES[route];
      res.type(f.type).send(fs.readFileSync(path.join(VIEW_DIR, f.file)));
    });
  });

  // MAPデータ (トークンはPOSTボディ。本人/日付/サイクル/ルートに束縛)
  router.post('/line-map/data', async function (req, res) {
    secure(res);
    var key = clientKey(req);
    if (badTokenLimiter.blocked(key) || !viewLimiter.hit('d|' + key)) return res.status(429).json({ status: 'error', message: 'アクセスが多すぎます。しばらくしてからお試しください。' });
    var token = req.body && req.body.token;
    var b = tokenStore.resolve(token);
    if (!b) {
      badTokenLimiter.hit(key);
      // 不正・改ざん・期限切れは区別せず同一応答 (情報を与えない)
      return res.status(410).json({ status: 'error', message: 'このMAPのURLは無効か期限切れです。LINEで「マップ」と送ると新しいURLが届きます。' });
    }
    await deps.assignmentStore.ensureRestored();
    var notReady = readiness(b.date);
    if (notReady) return res.status(503).json({ status: 'error', code: notReady, message: Core.safeReplyText(notReady)[0].text });
    // 発行後に割当が変わった場合は表示しない (本人・日付・サイクル・ルートの再照合)
    var cur = Core.resolveAssignment({
      lineUserId: b.lineUserId, linkedMap: deps.assignmentStore.linkedMapFor(b.date),
      assignments: deps.assignmentStore.assignmentsFor(b.date), date: b.date, cycle: b.cycle
    });
    if (!cur.ok || cur.routeCode !== b.routeCode) return res.status(409).json({ status: 'error', message: '割当が変更されたため表示できません。LINEで「マップ」と送り直してください。' });
    var stops = deps.getRouteStops(b.date);
    if (!stops || !stops.length) return res.status(503).json({ status: 'error', code: 'data-not-restored', message: Core.safeReplyText('no-stops')[0].text });
    var model = Core.buildMapModel(stops, b.routeCode);
    if (!model.ok) return res.status(409).json({ status: 'error', message: Core.safeReplyText(model.reason)[0].text });
    res.json({
      status: 'ok', routeCode: model.routeCode, cycle: b.cycle, stopCount: model.stopCount, missingCoordinateCount: model.missingCoordinateCount,
      // 個人情報の最小化: 住所は既定で返さない (LINE_MAP_SHOW_ADDRESS=1 のときだけ)
      pins: model.pins.map(function (p) {
        var o = { pin: p.pin, lat: p.lat, lng: p.lng, packageCount: p.packageCount };
        if (env.SHOW_ADDRESS) o.address = p.address;
        return o;
      })
    });
  });

  // 管理者向け モック送信: 実LINE送信は行わず、送るはずのメッセージを返すだけ
  router.post('/line-map/test-preview', function (req, res) {
    if (!requireProxySecret(req, res)) return;
    var driverId = String(req.body && req.body.driverId || '');
    var t = nowFn(), jst = Core.toJst(t), cycle = Core.selectCycle(t);
    var lineUserId = deps.assignmentStore.linkFor(jst.date, driverId);
    var messages;
    var preReady = readiness(jst.date);
    if (preReady) messages = Core.safeReplyText(preReady);
    else {
      var asg = lineUserId ? Core.resolveAssignment({
        lineUserId: lineUserId, linkedMap: deps.assignmentStore.linkedMapFor(jst.date),
        assignments: deps.assignmentStore.assignmentsFor(jst.date), date: jst.date, cycle: cycle
      }) : { ok: false, reason: 'unlinked' };
      if (!asg.ok) messages = Core.safeReplyText(asg.reason);
      else {
        var model = Core.buildMapModel(deps.getRouteStops(jst.date), asg.routeCode);
        messages = model.ok
          ? Core.buildMapReplyMessages(model, { cycle: cycle, mapUrl: mapUrlFor(tokenStore.issue({ lineUserId: lineUserId, date: jst.date, cycle: cycle, routeCode: asg.routeCode })) })
          : Core.safeReplyText(model.reason);
      }
    }
    res.json({ status: 'ok', mock: true, sent: false, cycle: cycle, messages: messages });
  });

  // 復元状況の確認 (件数のみ。個人情報は返さない)
  router.get('/line-map/status', function (req, res) {
    if (!requireProxySecret(req, res)) return;
    var date = deps.todayJst ? deps.todayJst() : Core.toJst(nowFn()).date;
    var stops = deps.getRouteStops(date) || [];
    res.json({
      status: 'ok', date: date, assignmentsRestored: deps.assignmentStore.isRestored(),
      assignmentRows: deps.assignmentStore.assignmentsFor(date).length, cortexRouteStops: stops.length
    });
  });

  router.pipelineDeps = pipelineDeps;
  return router;
}

module.exports = { createLineMapRouter: createLineMapRouter, secretEquals: secretEquals, createRateLimiter: createRateLimiter, clientKey: clientKey, CSP: CSP };
