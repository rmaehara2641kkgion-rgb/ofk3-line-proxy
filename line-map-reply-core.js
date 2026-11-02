/**
 * LINE「マップ」返信のコア (DOM/ネットワーク非依存)。
 * - Webhook署名検証 / イベント重複排除 / 返信トークン期限
 * - 本人識別 (LINE userId -> ドライバー) / 当日ルート解決 / サイクル判定
 * - Amazon巡回順を保持した MAP モデル検証 (誤ったMAPは作らない)
 * - 推測困難なMAP閲覧トークン (本人・日付・ルートに束縛、期限付き)
 * 実送信は一切行わない。送信は呼び出し側が注入する関数で行う。
 */
(function (root) {
  'use strict';

  var crypto = (typeof require === 'function') ? require('crypto') : null;

  var JST_OFFSET_MS = 9 * 3600 * 1000;
  var REPLY_TOKEN_TTL_MS = 60 * 1000; // LINE仕様: 返信トークンは受信後すぐ(目安1分)に失効
  var MAP_TOKEN_TTL_MS = 30 * 60 * 1000; // 初期30分
  var CYCLE_SWITCH_MIN = 17 * 60 + 30; // 17:30

  // ---- 署名検証 -------------------------------------------------------
  function verifyLineSignature(rawBody, signature, channelSecret) {
    if (!channelSecret || !signature || rawBody == null) return false;
    var body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    var expected = crypto.createHmac('sha256', channelSecret).update(body).digest();
    var given;
    try { given = Buffer.from(String(signature), 'base64'); } catch (e) { return false; }
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected);
  }

  // ---- 時刻/サイクル ----------------------------------------------------
  function toJst(now) {
    var d = new Date(new Date(now).getTime() + JST_OFFSET_MS);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return {
      date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
    };
  }
  // 業務ルール(指示書記載): 17:29まではC1、17:30以降はC3。
  function selectCycle(now) {
    return toJst(now).minutes >= CYCLE_SWITCH_MIN ? 'C3' : 'C1';
  }

  // ---- 重複排除 ---------------------------------------------------------
  function createDedupStore(ttlMs, clock) {
    var seen = {};
    var ttl = ttlMs || 24 * 3600 * 1000;
    var nowFn = clock || Date.now;
    return {
      // true = 初回(処理してよい) / false = 既処理
      claim: function (key) {
        if (!key) return true; // IDが無いイベントは重複判定できない
        var t = nowFn();
        Object.keys(seen).forEach(function (k) { if (t - seen[k] > ttl) delete seen[k]; });
        if (seen[key]) return false;
        seen[key] = t;
        return true;
      },
      size: function () { return Object.keys(seen).length; }
    };
  }

  function isReplyTokenFresh(eventTimestampMs, nowMs) {
    var ts = Number(eventTimestampMs);
    if (!isFinite(ts)) return false;
    var age = nowMs - ts;
    return age >= -5000 && age <= REPLY_TOKEN_TTL_MS;
  }

  // ---- MAP閲覧トークン --------------------------------------------------
  function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
  function createMapTokenStore(opts) {
    opts = opts || {};
    var ttl = opts.ttlMs || MAP_TOKEN_TTL_MS;
    var clock = opts.clock || Date.now;
    var tokens = {}; // sha256(token) -> binding (平文トークンは保持しない)
    function purge() { var t = clock(); Object.keys(tokens).forEach(function (h) { if (t > tokens[h].expiresAt) delete tokens[h]; }); }
    return {
      issue: function (binding) {
        purge();
        // 同一の本人・日付・サイクル・ルートで再発行したら旧トークンは失効 (転送されたURLの寿命を縮める)
        Object.keys(tokens).forEach(function (h) {
          var o = tokens[h];
          if (o.lineUserId === binding.lineUserId && o.date === binding.date && o.cycle === binding.cycle && o.routeCode === binding.routeCode) delete tokens[h];
        });
        var token = crypto.randomBytes(24).toString('base64url'); // 192bit
        tokens[hashToken(token)] = {
          lineUserId: binding.lineUserId, date: binding.date, cycle: binding.cycle,
          routeCode: binding.routeCode, expiresAt: clock() + ttl
        };
        return token;
      },
      // lineUserId を渡した場合は本人一致も要求。期限切れ/不一致は null。
      resolve: function (token, lineUserId) {
        if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
        var h = hashToken(token), e = tokens[h];
        if (!e) return null;
        if (clock() > e.expiresAt) { delete tokens[h]; return null; }
        if (lineUserId != null && e.lineUserId !== lineUserId) return null;
        return e;
      },
      revoke: function (token) { delete tokens[hashToken(token)]; },
      exportState: function () { purge(); return JSON.parse(JSON.stringify(tokens)); },
      importState: function (state) {
        tokens = {};
        Object.keys(state || {}).forEach(function (h) {
          var e = state[h];
          if (/^[0-9a-f]{64}$/.test(h) && e && e.lineUserId && e.routeCode && isFinite(e.expiresAt)) tokens[h] = e;
        });
        purge();
      }
    };
  }

  // ---- ルート解決 -------------------------------------------------------
  // linkedMap: { lineUserId: driverId } / assignments: [{date,cycle,driverId,routeCode}]
  function resolveAssignment(input) {
    var driverId = (input.linkedMap || {})[input.lineUserId];
    if (!input.lineUserId || !driverId) return { ok: false, reason: 'unlinked' };
    var rows = (input.assignments || []).filter(function (a) {
      return a && a.driverId === driverId && a.date === input.date && a.cycle === input.cycle;
    });
    if (rows.length === 0) return { ok: false, reason: 'unassigned', driverId: driverId };
    var codes = {};
    rows.forEach(function (r) { codes[r.routeCode] = true; });
    var list = Object.keys(codes).filter(Boolean);
    if (list.length === 0) return { ok: false, reason: 'route-missing', driverId: driverId };
    if (list.length > 1) return { ok: false, reason: 'route-duplicate', driverId: driverId };
    // 同一ルートを別ドライバーが持っていないか
    var otherOwner = (input.assignments || []).some(function (a) {
      return a && a.routeCode === list[0] && a.date === input.date && a.cycle === input.cycle && a.driverId !== driverId;
    });
    if (otherOwner) return { ok: false, reason: 'route-duplicate', driverId: driverId };
    return { ok: true, driverId: driverId, routeCode: list[0] };
  }

  // ---- MAPモデル (Amazon巡回順を保持) --------------------------------------
  function hasCoord(lat, lng) {
    if (lat == null || lng == null || lat === '' || lng === '') return false;
    var a = Number(lat), b = Number(lng);
    return isFinite(a) && isFinite(b) && !(a === 0 && b === 0);
  }
  function buildMapModel(routeStops, routeCode) {
    var stops = (Array.isArray(routeStops) ? routeStops : []).filter(function (s) {
      return s && String(s.routeCode) === String(routeCode);
    });
    if (stops.length === 0) return { ok: false, reason: 'no-stops' };
    var seen = {};
    for (var i = 0; i < stops.length; i++) {
      var q = stops[i].sequenceNumber;
      if (q == null || q === '' || !isFinite(Number(q))) return { ok: false, reason: 'sequence-missing' };
      if (seen[Number(q)]) return { ok: false, reason: 'sequence-duplicate' };
      seen[Number(q)] = true;
    }
    var ordered = stops.slice().sort(function (a, b) { return Number(a.sequenceNumber) - Number(b.sequenceNumber); });
    var pins = [], noCoord = 0;
    ordered.forEach(function (s) {
      if (!hasCoord(s.latitude, s.longitude)) { noCoord++; return; }
      // PIN番号 = Amazonの巡回番号そのもの (再採番しない)
      pins.push({
        pin: Number(s.sequenceNumber), lat: Number(s.latitude), lng: Number(s.longitude),
        address: s.address || '', packageCount: Number(s.packageCount) || 0,
        plannedEndClock: s.plannedEndClock || ''
      });
    });
    if (pins.length === 0) return { ok: false, reason: 'no-coordinates' };
    return { ok: true, routeCode: String(routeCode), stopCount: ordered.length, pins: pins, missingCoordinateCount: noCoord };
  }

  // ---- 返信メッセージ ---------------------------------------------------
  var SAFE_TEXT = {
    'unlinked': 'LINEアカウントがまだドライバーに紐付いていません。管理者にご連絡ください。',
    'unassigned': '本日の担当コースがまだ割り当てられていません。',
    'route-missing': '担当コースのデータを確認できませんでした。管理者にご連絡ください。',
    'route-duplicate': 'コースの割当に重複があるためMAPを表示できません。管理者にご連絡ください。',
    'no-stops': '本日の配送データがまだ取得・復元できていません。しばらくしてからもう一度「マップ」と送ってください。',
    'sequence-missing': '巡回順データが不足しているためMAPを表示できません。',
    'sequence-duplicate': '巡回順データに重複があるためMAPを表示できません。',
    'no-coordinates': '位置情報が不足しているためMAPを表示できません。',
    'unverified': 'ご本人確認ができないため、配送情報は表示できません。',
    'not-ready': '現在データを復元中のためMAPを表示できません。しばらくしてからもう一度「マップ」と送ってください。',
    'not-synced': '本日の割当データがまだ届いていません。管理者の取り込み完了後に、もう一度「マップ」と送ってください。',
    'error': '一時的なエラーのためMAPを表示できません。時間をおいて再度お試しください。'
  };
  function safeReplyText(reason) {
    return [{ type: 'text', text: SAFE_TEXT[reason] || SAFE_TEXT.error }];
  }
  function buildMapReplyMessages(model, info) {
    var text = '【' + info.cycle + ' 担当コース】\nコース: ' + model.routeCode
      + '\n配送先: ' + model.stopCount + '件'
      + (model.missingCoordinateCount ? '\n(位置不明 ' + model.missingCoordinateCount + '件はMAP非表示)' : '')
      + '\nMAPは下のボタンから開けます。';
    return [
      { type: 'text', text: text },
      {
        type: 'flex', altText: '📍 担当MAP',
        contents: {
          type: 'bubble',
          body: { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '🗺 ' + model.routeCode, weight: 'bold', size: 'md' },
            { type: 'text', text: model.pins.length + '件のPIN / 巡回順どおりの番号', size: 'xs', color: '#888888', margin: 'sm' }
          ] },
          footer: { type: 'box', layout: 'vertical', contents: [
            { type: 'button', style: 'primary', color: '#e94560', action: { type: 'uri', label: '📍 マップを見る', uri: info.mapUrl } }
          ] }
        }
      }
    ];
  }

  // ---- コマンド処理 -----------------------------------------------------
  function isMapCommand(text) {
    return String(text || '').trim().replace(/[　\s]+/g, '') === 'マップ';
  }

  /**
   * deps: { channelSecret, dedup, tokenStore, getLinkedMap(), getAssignments(date), getRouteStops(date),
   *         reply(replyToken, messages) -> Promise, mapUrlFor(token), now() }
   * rawBody/signature: 署名検証用。検証失敗時は何も処理せず { status: 401 }。
   */
  async function handleWebhook(rawBody, signature, deps) {
    if (!verifyLineSignature(rawBody, signature, deps.channelSecret)) return { status: 401, handled: 0 };
    var body;
    try { body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); }
    catch (e) { return { status: 400, handled: 0 }; }
    return handleEvents(Array.isArray(body.events) ? body.events : [], deps);
  }

  async function handleEvents(events, deps) {
    var results = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i] || {};
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !isMapCommand(ev.message.text)) continue;
      if (!(ev.source && ev.source.type === 'user' && ev.source.userId)) { continue; } // グループ等では返信しない
      var dedupKey = ev.webhookEventId || (ev.message && ev.message.id);
      if (!deps.dedup.claim(dedupKey)) { results.push({ outcome: 'duplicate' }); continue; }
      var nowMs = deps.now ? deps.now() : Date.now();
      if (!ev.replyToken || !isReplyTokenFresh(ev.timestamp, nowMs)) { results.push({ outcome: 'reply-token-expired' }); continue; }
      var messages, reason = null;
      try {
        var jst = toJst(nowMs), cycle = selectCycle(nowMs);
        var notReady = deps.getReadiness ? deps.getReadiness(jst.date) : null;
        var asg = notReady ? { ok: false, reason: notReady } : resolveAssignment({
          lineUserId: ev.source.userId, linkedMap: deps.getLinkedMap(jst.date),
          assignments: deps.getAssignments(jst.date), date: jst.date, cycle: cycle
        });
        if (!asg.ok) { reason = asg.reason; }
        else {
          var model = buildMapModel(deps.getRouteStops(jst.date), asg.routeCode);
          if (!model.ok) reason = model.reason;
          else {
            var token = deps.tokenStore.issue({ lineUserId: ev.source.userId, date: jst.date, cycle: cycle, routeCode: asg.routeCode });
            messages = buildMapReplyMessages(model, { cycle: cycle, mapUrl: deps.mapUrlFor(token) });
          }
        }
      } catch (e) { reason = 'error'; }
      if (reason) messages = safeReplyText(reason);
      try {
        await deps.reply(ev.replyToken, messages);
        results.push({ outcome: reason ? 'safe-reply:' + reason : 'replied' });
      } catch (e) {
        results.push({ outcome: 'reply-failed' }); // 例外は握りつぶしWebhookは200を返す(再送ループ防止)
      }
    }
    return { status: 200, handled: results.length, results: results };
  }

  var api = {
    verifyLineSignature: verifyLineSignature, selectCycle: selectCycle, toJst: toJst,
    createDedupStore: createDedupStore, isReplyTokenFresh: isReplyTokenFresh,
    createMapTokenStore: createMapTokenStore, resolveAssignment: resolveAssignment,
    buildMapModel: buildMapModel, buildMapReplyMessages: buildMapReplyMessages,
    safeReplyText: safeReplyText, isMapCommand: isMapCommand, handleWebhook: handleWebhook, handleEvents: handleEvents,
    REPLY_TOKEN_TTL_MS: REPLY_TOKEN_TTL_MS, MAP_TOKEN_TTL_MS: MAP_TOKEN_TTL_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OFK3LineMapReply = api;
})(typeof window !== 'undefined' ? window : this);
