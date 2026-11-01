import { createRequire } from 'module';
import assert from 'assert';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const C = require('../line-map-reply-core.js');

// ---- 架空データ (実配送データ・実LINE IDは使わない) ----
const SECRET = 'test-secret-not-real';
const UA = 'Utest0000000000000000000000000001', UB = 'Utest0000000000000000000000000002';
const T0 = Date.parse('2026-11-02T03:00:00Z'); // 12:00 JST
const stops = (code, seqs, o = {}) => seqs.map((q, i) => ({
  routeCode: code, sequenceNumber: q, latitude: o.noCoord ? null : 33.5 + i * 0.001, longitude: 130.4 + i * 0.001,
  address: 'ダミー' + q, packageCount: 1, plannedEndClock: '', ...(o.extra || {})
}));
const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64');
const mkEvent = (o = {}) => ({
  type: 'message', webhookEventId: o.id || 'ev1', timestamp: o.ts ?? T0, replyToken: 'rt-' + (o.id || 'ev1'),
  source: { type: o.srcType || 'user', userId: o.user || UA }, message: { type: 'text', id: 'm1', text: o.text || 'マップ' },
  deliveryContext: { isRedelivery: !!o.redeliver }
});
function mkDeps(over = {}) {
  const sent = [];
  const deps = {
    channelSecret: SECRET, dedup: C.createDedupStore(), tokenStore: C.createMapTokenStore({ clock: () => T0 }),
    getLinkedMap: () => ({ [UA]: 'DA-A', [UB]: 'DA-B' }),
    getAssignments: () => [
      { date: '2026-11-02', cycle: 'C1', driverName: 'DA-A', routeCode: 'DCX-1' },
      { date: '2026-11-02', cycle: 'C3', driverName: 'DA-A', routeCode: 'DSX-9' },
      { date: '2026-11-02', cycle: 'C1', driverName: 'DA-B', routeCode: 'DCX-2' }],
    getRouteStops: () => [...stops('DCX-1', [3, 1, 2]), ...stops('DCX-2', [1, 2]), ...stops('DSX-9', [1])],
    reply: async (t, m) => { sent.push({ t, m }); }, mapUrlFor: (tok) => 'https://example.invalid/m/' + tok, now: () => T0, ...over
  };
  return { deps, sent };
}
const post = (events, deps, sig) => { const raw = JSON.stringify({ events }); return C.handleWebhook(raw, sig === undefined ? sign(raw) : sig, deps); };
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// サイクル境界
eq(C.selectCycle(Date.parse('2026-11-02T08:29:00Z')), 'C1', '17:29=C1');
eq(C.selectCycle(Date.parse('2026-11-02T08:30:00Z')), 'C3', '17:30=C3');
eq(C.selectCycle(Date.parse('2026-11-02T00:00:00Z')), 'C1', '09:00=C1');
// 署名
ok(C.verifyLineSignature('{}', sign('{}'), SECRET), '正しい署名');
ok(!C.verifyLineSignature('{}', sign('{}x'), SECRET), '不正署名');
ok(!C.verifyLineSignature('{}', '', SECRET) && !C.verifyLineSignature('{}', sign('{}'), ''), '署名/秘密欠落');

// 正常系 + Amazon巡回順維持 + 時間指定0件でもPIN
{ const m = C.buildMapModel([...stops('R', [3, 1, 2])], 'R');
  ok(m.ok); eq(m.pins.map(p => p.pin), [1, 2, 3], '巡回番号順・PIN番号=巡回番号'); }
{ const { deps, sent } = mkDeps(); const r = await post([mkEvent()], deps);
  eq(r.status, 200); eq(sent.length, 1); eq(sent[0].m.length, 2); ok(/DCX-1/.test(sent[0].m[0].text));
  const uri = sent[0].m[1].contents.footer.contents[0].action.uri; const tok = uri.split('/').pop();
  ok(deps.tokenStore.resolve(tok, UA), '本人はMAP取得可'); }
// C3 (17:30)
{ const { deps, sent } = mkDeps({ now: () => Date.parse('2026-11-02T08:30:00Z') });
  await post([mkEvent({ ts: Date.parse('2026-11-02T08:30:00Z') })], deps); ok(/DSX-9/.test(sent[0].m[0].text), '17:30はC3の担当'); }
// 他人のMAP拒否
{ const { deps, sent } = mkDeps(); await post([mkEvent()], deps);
  const tok = sent[0].m[1].contents.footer.contents[0].action.uri.split('/').pop();
  eq(deps.tokenStore.resolve(tok, UB), null, '他人は取得不可'); eq(deps.tokenStore.resolve('guess', UA), null, '推測トークン不可'); }
// トークン期限
{ let t = T0; const ts = C.createMapTokenStore({ clock: () => t, ttlMs: 1000 }); const k = ts.issue({ lineUserId: UA, routeCode: 'R' });
  ok(ts.resolve(k, UA)); t += 1001; eq(ts.resolve(k, UA), null, '期限切れ'); }
// 未紐付け/未割当/重複/欠損
{ const { deps, sent } = mkDeps(); await post([mkEvent({ user: 'Uunknown' })], deps); ok(/紐付いていません/.test(sent[0].m[0].text)); eq(sent[0].m.length, 1, '配送情報なし'); }
{ const { deps, sent } = mkDeps({ getAssignments: () => [] }); await post([mkEvent()], deps); ok(/割り当てられていません/.test(sent[0].m[0].text)); }
{ const { deps, sent } = mkDeps({ getAssignments: () => [
  { date: '2026-11-02', cycle: 'C1', driverName: 'DA-A', routeCode: 'DCX-1' }, { date: '2026-11-02', cycle: 'C1', driverName: 'DA-A', routeCode: 'DCX-7' }] });
  await post([mkEvent()], deps); ok(/重複/.test(sent[0].m[0].text), '1人に複数ルート'); }
{ const { deps, sent } = mkDeps({ getAssignments: () => [
  { date: '2026-11-02', cycle: 'C1', driverName: 'DA-A', routeCode: 'DCX-1' }, { date: '2026-11-02', cycle: 'C1', driverName: 'DA-B', routeCode: 'DCX-1' }] });
  await post([mkEvent()], deps); ok(/重複/.test(sent[0].m[0].text), '同一ルートに複数DA'); }
{ const { deps, sent } = mkDeps({ getRouteStops: () => [] }); await post([mkEvent()], deps); ok(/取得できていません/.test(sent[0].m[0].text)); }
eq(C.buildMapModel(stops('R', [1, 1]), 'R').reason, 'sequence-duplicate');
eq(C.buildMapModel([{ routeCode: 'R', latitude: 1, longitude: 1 }], 'R').reason, 'sequence-missing');
eq(C.buildMapModel(stops('R', [1, 2], { noCoord: true }), 'R').reason, 'no-coordinates');
{ const s = stops('R', [1, 2, 3]); s[1].latitude = null; const m = C.buildMapModel(s, 'R');
  eq(m.pins.map(p => p.pin), [1, 3], '欠損PINは詰めず番号維持'); eq(m.missingCoordinateCount, 1); }
// 署名不正 → 何も返信しない
{ const { deps, sent } = mkDeps(); const r = await post([mkEvent()], deps, 'bad'); eq(r.status, 401); eq(sent.length, 0); }
// 重複受信
{ const { deps, sent } = mkDeps(); await post([mkEvent({ id: 'dup' })], deps); const r = await post([mkEvent({ id: 'dup', redeliver: true })], deps);
  eq(sent.length, 1, '再送は1回のみ'); eq(r.results[0].outcome, 'duplicate'); }
// 返信トークン期限切れ
{ const { deps, sent } = mkDeps(); const r = await post([mkEvent({ ts: T0 - 120000 })], deps); eq(sent.length, 0); eq(r.results[0].outcome, 'reply-token-expired'); }
// LINE API障害 (reply失敗でも200・例外なし)
{ const { deps } = mkDeps({ reply: async () => { throw new Error('LINE 500'); } }); const r = await post([mkEvent()], deps);
  eq(r.status, 200); eq(r.results[0].outcome, 'reply-failed'); }
// グループ発言・他コマンドは無反応
{ const { deps, sent } = mkDeps(); await post([mkEvent({ srcType: 'group' }), mkEvent({ id: 'e2', text: 'こんにちは' })], deps); eq(sent.length, 0); }
// 内部例外時も配送情報を漏らさない
{ const { deps, sent } = mkDeps({ getRouteStops: () => { throw new Error('boom'); } }); await post([mkEvent()], deps); ok(/一時的なエラー/.test(sent[0].m[0].text)); }
console.log('line-map-reply tests passed (' + n + ' assertions)');
