import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Core = require('../line-map-reply-core.js');
const Store = require('../line-map-store.js');
const Routes = require('../line-map-routes.js');
const Gas = require('../line-map-gas-backend.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; }; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const UA = 'U' + 'a'.repeat(32);
const payload = { date: today, rows: [{ routeCode: 'DCX-1', driverId: 'A001' }], links: [{ driverId: 'A001', lineUserId: UA }] };

// ---- レート制限 / クライアントIP ----
{ let t = 0; const rl = Routes.createRateLimiter(3, 1000, () => t);
  ok(rl.hit('a') && rl.hit('a') && rl.hit('a')); ok(!rl.hit('a'), '4回目は拒否'); ok(rl.blocked('a')); ok(rl.hit('b'), '別キーは独立');
  t = 1001; ok(rl.hit('a'), '窓経過で解除'); }
eq(Routes.clientKey({ headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: {} }), '1.2.3.4', 'XFF先頭(偽装可)ではなく末尾を使う');

// ---- GASバックエンド(モック。実接続なし) ----
{ const calls = []; let store = null, mode = 'ok';
  const fetchImpl = async (url, o) => { const b = JSON.parse(o.body); calls.push({ url, b, o });
    if (mode === 'down') throw new Error('network'); if (mode === '500') return { ok: false, status: 500 };
    if (b.token !== 'gas-token') return { ok: true, json: async () => ({ status: 'error', reason: 'unauthorized' }) };
    if (b.action === 'save') { store = JSON.parse(JSON.stringify(b.data)); return { ok: true, json: async () => ({ status: 'ok' }) }; }
    return { ok: true, json: async () => ({ status: 'ok', data: store || {} }) }; };
  eq(Gas.createGasBackend({ url: '', token: 't', fetchImpl }), null, 'URL未設定なら接続しない'); eq(Gas.createGasBackend({ url: 'https://x.invalid/e', token: '', fetchImpl }), null, 'トークン未設定なら接続しない');
  const be = () => Gas.createGasBackend({ url: 'https://gas.invalid/exec', token: 'gas-token', fetchImpl });
  const s1 = Store.createAssignmentStore({ backend: be() }); ok(!s1.isRestored(), '外部ストア使用時は復元完了まで未復元'); await s1.init(); ok(s1.isRestored());
  eq(s1.sync(payload, today).ok, true); eq(await s1.flush(), 'ok');
  ok(calls.every(c => !c.url.includes('gas-token') && c.o.method === 'POST'), 'トークンはURLに載せずPOSTボディ');
  ok(!JSON.stringify(calls.find(c => c.b.action === 'save').b.data).match(/address|latitude|longitude/), '配送先住所・座標は保存しない');
  // 再デプロイ相当: 新しいストアが外部から復元
  const s2 = Store.createAssignmentStore({ backend: be() }); await s2.init(); eq(s2.assignmentsFor(today).length, 1, '再デプロイ後に割当を復元'); eq(s2.linkedMapFor(today)[UA], 'A001');
  // GAS障害
  mode = 'down'; const s3 = Store.createAssignmentStore({ backend: be() }); eq(await s3.init(), false, '障害時は未復元'); ok(!s3.isRestored());
  eq(await s3.ensureRestored(), false, '30秒以内は再試行しない'); const before = calls.length; await s3.ensureRestored(); eq(calls.length, before, 'リトライ間隔の抑制');
  eq(s3.sync(payload, today).ok, true, '未復元でもメモリへの同期は可能'); eq(await s3.flush(), 'skipped-unrestored', '部分データで外部ストアを上書きしない');
  mode = '500'; const s4 = Store.createAssignmentStore({ backend: be() }); eq(await s4.init(), false, 'HTTPエラーも未復元');
  mode = 'ok'; const s5 = Store.createAssignmentStore({ backend: Gas.createGasBackend({ url: 'https://gas.invalid/exec', token: 'wrong', fetchImpl }) }); eq(await s5.init(), false, 'トークン不一致は未復元');
  mode = 'ok'; const s6 = Store.createAssignmentStore({ backend: be() }); await s6.init(); mode = 'down'; s6.sync(payload, today); eq(await s6.flush(), 'failed', '保存失敗は結果で返す'); eq(s6.assignmentsFor(today).length, 1, '保存失敗でもメモリは有効'); }

// ---- 未復元時の応答: Webhook / データAPI ----
{ const C = Core; const sent = []; const T0 = Date.now();
  const deps = { channelSecret: 's', dedup: C.createDedupStore(), tokenStore: C.createMapTokenStore(), getReadiness: () => 'not-ready',
    getLinkedMap: () => ({ [UA]: 'A001' }), getAssignments: () => [], getRouteStops: () => [], reply: async (t, m) => sent.push(m), mapUrlFor: x => x, now: () => T0 };
  const raw = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'x', timestamp: T0, replyToken: 'r', source: { type: 'user', userId: UA }, message: { type: 'text', id: '1', text: 'マップ' } }] });
  const sig = require('crypto').createHmac('sha256', 's').update(raw).digest('base64');
  await C.handleWebhook(raw, sig, deps); ok(/復元中/.test(sent[0][0].text) && sent[0].length === 1, '復元前は配送情報を返さず明確な案内'); }

// ---- ルーター単体: レート制限 / 無効トークン遮断 / 未復元503 / 割当変更409 ----
async function boot(over = {}) {
  let t = Date.now(); const clock = () => t;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmh-'));
  const store = over.store || Store.createAssignmentStore({ filePath: path.join(dir, 'a.json') });
  store.sync(payload, today);
  const tokenStore = Core.createMapTokenStore({ clock });
  const stopsList = over.stops || [1, 2, 3].map(q => ({ routeCode: 'DCX-1', sequenceNumber: q, latitude: 33.5 + q / 100, longitude: 130.4, address: 'SECRET-ADDR-' + q, packageCount: 2 }));
  const app = express(); app.use(express.json());
  app.use(Routes.createLineMapRouter({ express, env: { PROXY_SECRET: 'ps', LINE_CHANNEL_SECRET: 'cs', PUBLIC_ORIGIN: 'https://example.invalid', SHOW_ADDRESS: !!over.showAddress },
    assignmentStore: store, tokenStore, getRouteStops: () => stopsList, reply: async () => {}, now: () => t, clock, todayJst: () => today }));
  const srv = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = 'http://127.0.0.1:' + srv.address().port;
  const tok = tokenStore.issue({ lineUserId: UA, date: today, cycle: 'C1', routeCode: 'DCX-1' });
  const call = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
  return { base, tok, call, store, tokenStore, advance: ms => { t += ms; }, close: () => srv.close() };
}
{ const e = await boot(); // 無効トークン連打 → 429 (正しいトークンも遮断)
  for (let i = 0; i < 10; i++) eq((await e.call('/line-map/data', { token: 'x'.repeat(30) + i })).status, 410);
  eq((await e.call('/line-map/data', { token: e.tok })).status, 429, '無効トークン連打でIP遮断'); e.close(); }
{ const e = await boot(); // 正常アクセス頻度上限
  let last; for (let i = 0; i < 61; i++) last = (await e.call('/line-map/data', { token: e.tok })).status; eq(last, 429, '60回/分超過で429'); e.close(); }
{ const e = await boot(); // PROXY_SECRET総当たり
  for (let i = 0; i < 10; i++) eq((await e.call('/line-map/assignments', payload, { 'x-proxy-secret': 'bad' + i })).status, 403);
  eq((await e.call('/line-map/assignments', payload, { 'x-proxy-secret': 'ps' })).status, 429, 'シークレット総当たりで遮断'); e.close(); }
{ const e = await boot({ showAddress: true }); const j = await (await e.call('/line-map/data', { token: e.tok })).json(); ok(j.pins[0].address.startsWith('SECRET-ADDR'), '住所表示は明示設定時のみ'); e.close(); }
{ const e = await boot(); const j = await (await e.call('/line-map/data', { token: e.tok })).json(); ok(!JSON.stringify(j).includes('SECRET-ADDR'), '既定では住所を返さない');
  eq(j.pins.map(p => p.pin), [1, 2, 3]);
  e.advance(30 * 60 * 1000 + 1); const x = await e.call('/line-map/data', { token: e.tok }); eq(x.status, 410, '30分で失効'); ok(/LINEで「マップ」/.test((await x.json()).message), '再発行の案内'); e.close(); }
{ const e = await boot({ stops: [] }); const x = await e.call('/line-map/data', { token: e.tok }); eq(x.status, 503); eq((await x.json()).code, 'data-not-restored', 'Cortex未復元は明確なエラー(古いMAPは出さない)'); e.close(); }
{ // 他人のルート: 他DAの同コースを持つ別ルートのstopsしか無い場合は表示しない
  const e = await boot({ stops: [{ routeCode: 'DCX-2', sequenceNumber: 1, latitude: 1, longitude: 1 }] }); eq((await e.call('/line-map/data', { token: e.tok })).status, 409, '自分のルートのstopsが無ければ他ルートを出さない'); e.close(); }
{ // 発行後に割当が別DAへ変更 → 旧トークンで表示不可
  const e = await boot(); e.store.sync({ date: today, rows: [{ routeCode: 'DCX-1', driverId: 'A999' }], links: [{ driverId: 'A999', lineUserId: 'U' + 'd'.repeat(32) }] }, today);
  eq((await e.call('/line-map/data', { token: e.tok })).status, 409, '割当変更後は旧トークンで見えない'); e.close(); }
{ // 外部ストア復元前 → 503 not-ready
  const be = { load: async () => { throw new Error('down'); }, save: async () => {} };
  const st = Store.createAssignmentStore({ backend: be }); await st.init(); const e = await boot({ store: st });
  const x = await e.call('/line-map/data', { token: e.tok }); eq(x.status, 503); eq((await x.json()).code, 'not-ready'); e.close(); }
console.log('line-map-hardening tests passed (' + n + ' assertions)');
