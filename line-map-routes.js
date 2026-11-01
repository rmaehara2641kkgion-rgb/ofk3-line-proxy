/**
 * LINE MAP: 割当同期 / 署名付きWebhook / トークンMAP閲覧 / 管理者モックプレビュー。
 * 実LINE送信はここでは行わない。返信は deps.reply (本番では既定で無効) 経由のみ。
 */
'use strict';
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var Core = require('./line-map-reply-core.js');

function secretEquals(configured, presented) {
  if (!configured || typeof presented !== 'string' || !presented) return false;
  var a = crypto.createHash('sha256').update(configured).digest();
  var b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

var VIEW_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
  + '<title>担当MAP</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">'
  + '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>'
  + '<style>html,body,#map{height:100%;margin:0}#h{position:absolute;z-index:1000;top:8px;left:8px;right:8px;background:#fffd;padding:6px 10px;border-radius:8px;font:14px sans-serif}'
  + '.pin{background:#e94560;color:#fff;border-radius:50%;width:26px;height:26px;line-height:26px;text-align:center;font:700 12px sans-serif;border:2px solid #fff}</style></head>'
  + '<body><div id="h">読み込み中…</div><div id="map"></div><script>'
  + 'fetch(location.pathname.replace("/view/","/data/"),{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){'
  + 'if(d.status!=="ok"){document.getElementById("h").textContent=d.message||"表示できません";return}'
  + 'document.getElementById("h").textContent=d.routeCode+" / "+d.pins.length+"件";'
  + 'var m=L.map("map");L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(m);var b=[];'
  + 'd.pins.forEach(function(p){b.push([p.lat,p.lng]);L.marker([p.lat,p.lng],{icon:L.divIcon({className:"",html:"<div class=pin>"+p.pin+"</div>",iconSize:[26,26],iconAnchor:[13,13]})}).addTo(m).bindPopup((function(){var e=document.createElement("div");e.textContent="#"+p.pin+" "+p.address;return e})())});'
  + 'L.polyline(b,{color:"#e94560",weight:3,opacity:.6}).addTo(m);m.fitBounds(b,{padding:[30,30]})})'
  + '.catch(function(){document.getElementById("h").textContent="読み込みに失敗しました"});</script></body></html>';
var EXPIRED_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>期限切れ</title></head>'
  + '<body style="font:16px sans-serif;padding:24px">このMAPのURLは無効か期限切れです。<br>LINEで「マップ」と送ると新しいURLが届きます。</body></html>';

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex');
}

/**
 * deps: express, env{PROXY_SECRET, LINE_CHANNEL_SECRET, PUBLIC_ORIGIN}, assignmentStore, tokenStore, tokenFile?,
 *       getRouteStops(date), reply(replyToken, messages), now(), todayJst()
 */
function createLineMapRouter(deps) {
  var router = deps.express.Router();
  var env = deps.env || {};
  var nowFn = deps.now || Date.now;
  var dedup = deps.dedup || Core.createDedupStore();

  if (deps.tokenFile) {
    try { deps.tokenStore.importState(JSON.parse(fs.readFileSync(deps.tokenFile, 'utf8'))); } catch (e) { /* 初回/破損は空で開始 */ }
  }
  function persistTokens() {
    if (!deps.tokenFile) return;
    try {
      fs.mkdirSync(path.dirname(deps.tokenFile), { recursive: true });
      fs.writeFileSync(deps.tokenFile, JSON.stringify(deps.tokenStore.exportState()), { encoding: 'utf8', mode: 0o600 });
    } catch (e) { /* 永続化失敗は致命にしない */ }
  }
  var origIssue = deps.tokenStore.issue;
  var tokenStore = Object.assign({}, deps.tokenStore, { issue: function (b) { var t = origIssue(b); persistTokens(); return t; } });

  function requireProxySecret(req, res) {
    if (!env.PROXY_SECRET) { res.status(503).json({ status: 'error', message: 'not configured' }); return false; } // fail-closed
    if (!secretEquals(env.PROXY_SECRET, req.headers['x-proxy-secret'])) { res.status(403).json({ status: 'error', message: 'Forbidden' }); return false; }
    return true;
  }
  function mapUrlFor(token) { return (env.PUBLIC_ORIGIN || '') + '/line-map/view/' + token; }

  function pipelineDeps() {
    return {
      channelSecret: env.LINE_CHANNEL_SECRET, dedup: dedup, tokenStore: tokenStore,
      getLinkedMap: function (d) { return deps.assignmentStore.linkedMapFor(d); },
      getAssignments: function (d) { return deps.assignmentStore.assignmentsFor(d); },
      getRouteStops: deps.getRouteStops, reply: deps.reply, mapUrlFor: mapUrlFor, now: nowFn
    };
  }

  // 割当同期 (サーバー間/管理画面からPROXY_SECRET付きで)
  router.post('/line-map/assignments', function (req, res) {
    if (!requireProxySecret(req, res)) return;
    var r = deps.assignmentStore.sync(req.body, deps.todayJst ? deps.todayJst() : null);
    if (!r.ok) return res.status(400).json({ status: 'error', errors: r.errors });
    res.json({ status: 'ok', date: r.date, rowCount: r.rowCount, linkCount: r.linkCount, persisted: r.persisted });
  });

  // 新Webhook (常に署名必須。Secret未設定は503=fail-closed)
  router.post('/line-map/webhook', async function (req, res) {
    if (!env.LINE_CHANNEL_SECRET) return res.status(503).json({ status: 'error', message: 'not configured' });
    var out = await Core.handleWebhook(req.rawBody, req.headers['x-line-signature'], pipelineDeps());
    if (out.status !== 200) return res.status(out.status).json({ status: 'error' });
    res.json({ status: 'ok' });
  });

  // MAP閲覧 (トークン必須・本人/日付/ルートに束縛)
  router.get('/line-map/view/:token', function (req, res) {
    noStore(res);
    if (!tokenStore.resolve(req.params.token)) return res.status(410).type('html').send(EXPIRED_HTML);
    res.type('html').send(VIEW_HTML);
  });
  router.get('/line-map/data/:token', function (req, res) {
    noStore(res);
    var b = tokenStore.resolve(req.params.token);
    if (!b) return res.status(410).json({ status: 'error', message: '期限切れです。LINEで「マップ」と送ってください。' });
    // 発行後に割当が変わった場合は表示しない (本人・日付・サイクル・ルートの再照合)
    var cur = Core.resolveAssignment({
      lineUserId: b.lineUserId, linkedMap: deps.assignmentStore.linkedMapFor(b.date),
      assignments: deps.assignmentStore.assignmentsFor(b.date), date: b.date, cycle: b.cycle
    });
    if (!cur.ok || cur.routeCode !== b.routeCode) return res.status(409).json({ status: 'error', message: '割当が変更されたため表示できません。LINEで「マップ」と送り直してください。' });
    var model = Core.buildMapModel(deps.getRouteStops(b.date), b.routeCode);
    if (!model.ok) return res.status(409).json({ status: 'error', message: Core.safeReplyText(model.reason)[0].text });
    res.json({ status: 'ok', routeCode: model.routeCode, cycle: b.cycle, pins: model.pins });
  });

  // 管理者向け モック送信: 実LINE送信は行わず、送るはずのメッセージを返すだけ
  router.post('/line-map/test-preview', function (req, res) {
    if (!requireProxySecret(req, res)) return;
    var driverId = String(req.body && req.body.driverId || '');
    var t = nowFn(), jst = Core.toJst(t), cycle = Core.selectCycle(t);
    var lineUserId = deps.assignmentStore.linkFor(jst.date, driverId);
    var asg = lineUserId ? Core.resolveAssignment({
      lineUserId: lineUserId, linkedMap: deps.assignmentStore.linkedMapFor(jst.date),
      assignments: deps.assignmentStore.assignmentsFor(jst.date), date: jst.date, cycle: cycle
    }) : { ok: false, reason: 'unlinked' };
    var messages;
    if (!asg.ok) messages = Core.safeReplyText(asg.reason);
    else {
      var model = Core.buildMapModel(deps.getRouteStops(jst.date), asg.routeCode);
      messages = model.ok
        ? Core.buildMapReplyMessages(model, { cycle: cycle, mapUrl: mapUrlFor(tokenStore.issue({ lineUserId: lineUserId, date: jst.date, cycle: cycle, routeCode: asg.routeCode })) })
        : Core.safeReplyText(model.reason);
    }
    res.json({ status: 'ok', mock: true, sent: false, cycle: cycle, messages: messages });
  });

  router.pipelineDeps = pipelineDeps;
  return router;
}

module.exports = { createLineMapRouter: createLineMapRouter, secretEquals: secretEquals };
