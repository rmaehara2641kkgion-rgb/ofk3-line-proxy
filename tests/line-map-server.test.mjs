import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Store = require('../line-map-store.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; }; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const LS = 'test-channel-secret', PS = 'test-proxy-secret';
const UA = 'U' + 'a'.repeat(32), UB = 'U' + 'b'.repeat(32);
const jstNow = () => new Date(Date.now() + 9 * 3600e3);
const today = jstNow().toISOString().slice(0, 10);
const h = jstNow().getUTCHours() * 60 + jstNow().getUTCMinutes();
const cycleNow = h >= 17 * 60 + 30 ? 'C3' : 'C1';
const prefix = cycleNow === 'C1' ? 'DCX' : 'DSX';
const sign = (b, s = LS) => crypto.createHmac('sha256', s).update(b).digest('base64');

// ---- store 単体 ----
{
  const t = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-')), 'a.json');
  const s = Store.createAssignmentStore({ filePath: t });
  const good = { date: today, rows: [{ routeCode: 'DCX-1', driverId: 'A001' }, { routeCode: 'DSX-1', driverId: 'A001' }], links: [{ driverId: 'A001', lineUserId: UA }] };
  eq(s.sync(good, today).ok, true); eq(s.assignmentsFor(today).map(r => r.cycle), ['C1', 'C3'], 'サイクルは接頭辞から導出');
  const s2 = Store.createAssignmentStore({ filePath: t }); eq(s2.assignmentsFor(today).length, 2, '再起動後に復元'); eq(s2.linkedMapFor(today)[UA], 'A001');
  const bad = (m, o) => { const r = s.sync({ ...good, ...o }, today); eq(r.ok, false, m); };
  bad('ルート多重担当', { rows: [{ routeCode: 'DCX-1', driverId: 'A001' }, { routeCode: 'DCX-1', driverId: 'A002' }] });
  bad('同サイクルで複数ルート', { rows: [{ routeCode: 'DCX-1', driverId: 'A001' }, { routeCode: 'DCX-2', driverId: 'A001' }] });
  bad('サイクル矛盾', { rows: [{ routeCode: 'DCX-1', driverId: 'A001', cycle: 'C3' }] });
  bad('未知接頭辞', { rows: [{ routeCode: 'ZZZ-1', driverId: 'A001' }] });
  bad('LINE ID形式不正', { links: [{ driverId: 'A001', lineUserId: 'x' }] });
  bad('LINE ID競合', { links: [{ driverId: 'A001', lineUserId: UA }, { driverId: 'A002', lineUserId: UA }] });
  bad('日付範囲外', { date: '2020-01-01' });
  eq(s.assignmentsFor(today).length, 2, '拒否時は既存データ不変');
}

// ---- サーバー統合 ----
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-srv-'));
async function start(env, port) {
  const p = spawn('node', ['render-webhook-server.js'], { env: { PATH: process.env.PATH, PORT: String(port), LINE_MAP_DATA_DIR: dataDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  return { p, port, log: () => out, url: (x) => `http://127.0.0.1:${port}${x}` };
}
const post = (s, u, body, hd = {}, raw) => fetch(s.url(u), { method: 'POST', headers: { 'content-type': 'application/json', ...hd }, body: raw ?? JSON.stringify(body) });
const stopS = (s) => new Promise(r => { s.p.once('exit', r); s.p.kill(); });

const env = { PROXY_SECRET: PS, LINE_CHANNEL_SECRET: LS };
let s = await start(env, 39201);
try {
  const route = prefix + '-7';
  const sync = { date: today, rows: [{ routeCode: route, driverId: 'A001' }, { routeCode: prefix + '-8', driverId: 'A002' }], links: [{ driverId: 'A001', lineUserId: UA }, { driverId: 'A002', lineUserId: UB }] };
  eq((await post(s, '/line-map/assignments', sync)).status, 403, 'シークレット無しは拒否');
  eq((await post(s, '/line-map/assignments', sync, { 'x-proxy-secret': 'wrong' })).status, 403);
  eq((await post(s, '/line-map/assignments', sync, { 'x-proxy-secret': PS })).status, 200, '同期成功');
  eq((await post(s, '/line-map/assignments', { ...sync, rows: [{ routeCode: route, driverId: 'A001' }, { routeCode: route, driverId: 'A002' }] }, { 'x-proxy-secret': PS })).status, 400, '矛盾は拒否');
  const stops = (rc, d) => [3, 1, 2].map(q => ({ routeCode: rc, sequenceNumber: q, latitude: 33.5 + q / 1000, longitude: d === 'Y' ? 131 : 130.4, address: d + q, packageCount: 1 }));
  eq((await post(s, '/cortex-priority/import', { localDate: today, packages: [], routeStops: [...stops(route, 'X'), ...stops(prefix + '-8', 'Y')] })).status, 200);

  // プレビュー(モック) → トークンURL
  const pv = await (await post(s, '/line-map/test-preview', { driverId: 'A001' }, { 'x-proxy-secret': PS })).json();
  eq([pv.mock, pv.sent], [true, false], '実送信しない'); const url = pv.messages[1].contents.footer.contents[0].action.uri; ok(url.includes('/line-map/view#'), 'トークンはURLフラグメント'); const tok = url.split('#')[1];
  const getData = (t) => post(s, '/line-map/data', { token: t });
  eq((await post(s, '/line-map/test-preview', { driverId: 'A001' })).status, 403, 'プレビューもシークレット必須');
  // 閲覧
  const d = await (await getData(tok)).json(); eq(d.pins.map(p => p.pin), [1, 2, 3], 'Amazon巡回順'); ok(d.pins.length === 3 && d.pins.every(p => p.lng === 130.4), '本人のルートのみ(他人=Yは経度131)');
  eq((await getData(tok.slice(0, -2) + 'zz')).status, 410, '改ざんトークン拒否');
  eq((await getData('a'.repeat(32))).status, 410, '推測トークン拒否');
  ok(!(await fetch(s.url('/line-map/data/' + tok))).ok, 'トークンをパスに載せるGET経路は存在しない');
  const vr = await fetch(s.url('/line-map/view')); eq(vr.headers.get('cache-control'), 'no-store'); eq(vr.headers.get('referrer-policy'), 'no-referrer');
  ok(/frame-ancestors 'none'/.test(vr.headers.get('content-security-policy')), 'CSP'); eq(vr.headers.get('x-content-type-options'), 'nosniff'); ok(!vr.headers.get('access-control-allow-origin'), 'CORS(*)なし');
  ok(!(await vr.text()).includes(tok), 'ページにトークンを含まない');
  ok(!('address' in d.pins[0]), '住所は既定で返さない'); ok(!JSON.stringify(d).includes('X1'), '住所文字列が漏れない');
  const dh = await getData(tok); eq(dh.headers.get('cache-control'), 'no-store'); ok(!dh.headers.get('access-control-allow-origin'));
  eq((await (await getData(null)).json()).status, 'error', 'トークン無しはエラー');
  const st = await (await fetch(s.url('/line-map/status'), { headers: { 'x-proxy-secret': PS } })).json(); eq([st.assignmentsRestored, st.cortexRouteStops], [true, 6]); eq((await fetch(s.url('/line-map/status'))).status, 403);
  // 既存の認証なし経路から保護データは取れない
  eq((await fetch(s.url('/route-data/' + tok))).status, 404, '/route-dataから取得不可');
  ok(!(await (await fetch(s.url('/route-data/' + tok))).text()).includes('X1'));

  // Webhook 署名
  const ev = (id, user, text = 'マップ') => JSON.stringify({ events: [{ type: 'message', webhookEventId: id, timestamp: Date.now(), replyToken: 'rt-secret-token', source: { type: 'user', userId: user }, message: { type: 'text', id: id, text } , deliveryContext: { isRedelivery: false } }] });
  let b = ev('e1', UA);
  eq((await post(s, '/webhook', null, { 'x-line-signature': 'bad' }, b)).status, 401, '不正署名拒否(既存/webhook)');
  eq((await post(s, '/webhook', null, {}, b)).status, 401, '署名なし拒否');
  eq((await post(s, '/line-map/webhook', null, { 'x-line-signature': sign(b, 'other') }, b)).status, 401, '別秘密の署名拒否');
  eq((await post(s, '/webhook', null, { 'x-line-signature': sign(b) }, b)).status, 200, '正署名OK');
  const b2 = ev('e2', UB); eq((await post(s, '/line-map/webhook', null, { 'x-line-signature': sign(b2) }, b2)).status, 200);
  // 既存未紐付け処理への影響: 署名OKの未知ユーザーが候補に入る
  const NEW = 'U' + 'c'.repeat(32); b = ev('e3', NEW, 'こんにちは');
  eq((await post(s, '/webhook', null, { 'x-line-signature': sign(b) }, b)).status, 200);
  const un = await (await fetch(s.url('/line-unlinked'), { headers: { 'x-proxy-secret': PS } })).json();
  ok(un.users.some(u => u.userId === NEW), '未紐付け候補取り込みは維持');
  eq((await getData(tok)).status, 410, '再発行(マップ再送)で旧トークンは失効');
  const pv2 = await (await post(s, '/line-map/test-preview', { driverId: 'A001' }, { 'x-proxy-secret': PS })).json(); const tok2 = pv2.messages[1].contents.footer.contents[0].action.uri.split('#')[1];
  // ログに秘密/返信トークン/ユーザーID全文なし
  const lg = s.log(); ok(!lg.includes('rt-secret-token') && !lg.includes(sign(b)) && !lg.includes(PS) && !lg.includes(LS), 'ログに機微情報なし');
  ok(!/x-line-signature/i.test(lg), 'ヘッダー全文ログなし');
  ok(/reply skipped/.test(lg), '返信は既定で無効(実送信なし)');

  // 再起動: 割当・トークンが復元
  await stopS(s); s = await start(env, 39202);
  const r0 = await getData(tok2); eq(r0.status, 503, '再起動後Cortex未復元なら表示しない'); eq((await r0.json()).code, 'data-not-restored', '明確なエラー');
  await post(s, '/cortex-priority/import', { localDate: today, packages: [], routeStops: stops(route, 'X') });
  eq((await (await getData(tok2)).json()).status, 'ok', '再起動後も割当/トークン復元');
  await stopS(s);

  // Secret未設定: 新webhookは503、既存/webhookは従来動作でMAP処理しない
  s = await start({ PROXY_SECRET: PS }, 39203);
  eq((await post(s, '/line-map/webhook', null, { 'x-line-signature': 'x' }, b)).status, 503, 'Secret未設定はfail-closed');
  eq((await post(s, '/webhook', null, {}, ev('e9', UA))).status, 200, '既存/webhookは従来動作');
  ok(!/reply skipped/.test(s.log()), 'Secret未設定ではMAPコマンドを処理しない');
  eq((await post(s, '/line-map/assignments', sync)).status, 403);
  await stopS(s);
  // PROXY_SECRET未設定: 同期はfail-closed
  s = await start({ LINE_CHANNEL_SECRET: LS }, 39204);
  eq((await post(s, '/line-map/assignments', sync, { 'x-proxy-secret': '' })).status, 503, 'PROXY_SECRET未設定は拒否');
  await stopS(s);
} finally { try { s.p.kill(); } catch {} }
console.log('line-map-server tests passed (' + n + ' assertions)');
