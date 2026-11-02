// GAS永続化・再起動復元・住所非表示の検証。すべてローカル: GASはモック(実GAS/Driveに接続しない)、LINE送信なし、フェイクのデータのみ。
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { spawn } from 'child_process';
import net from 'net';
import { createRequire } from 'module';
import { createGasMock } from './helpers/gas-mock.mjs';
const require = createRequire(import.meta.url);
const Core = require('../line-map-reply-core.js');
const Store = require('../line-map-store.js');
const Routes = require('../line-map-routes.js');
const Gas = require('../line-map-gas-backend.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; }; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const hm = new Date(Date.now() + 9 * 3600e3); const cyc = hm.getUTCHours() * 60 + hm.getUTCMinutes() >= 17 * 60 + 30 ? 'C3' : 'C1'; const pre = cyc === 'C1' ? 'DCX' : 'DSX';
const UA = 'U' + 'a'.repeat(32), UB = 'U' + 'b'.repeat(32), UC = 'U' + 'c'.repeat(32);
const ROUTE_A = pre + '-1', ROUTE_B = pre + '-2';
const SENT = ['SENTINEL-ADDR', 'SENTINEL-DRIVER', 'SENTINEL-TRACKING'];
const stopsFor = (rc, lng) => [3, 1, 2].map(q => ({ routeCode: rc, sequenceNumber: q, latitude: 33.5 + q / 1000, longitude: lng, address: 'SENTINEL-ADDR-' + rc + '-' + q, driverName: 'SENTINEL-DRIVER', trackingId: 'SENTINEL-TRACKING', packageCount: 2 }));
const ALLSTOPS = [...stopsFor(ROUTE_A, 130.1), ...stopsFor(ROUTE_B, 131.2)]; // A: 経度130.1 / B: 経度131.2
const SYNC = { date: today, rows: [{ routeCode: ROUTE_A, driverId: 'A001' }, { routeCode: ROUTE_B, driverId: 'A002' }], links: [{ driverId: 'A001', lineUserId: UA }, { driverId: 'A002', lineUserId: UB }] };
const CS = 'cs-fake', PS = 'ps-fake';
const sign = (b) => crypto.createHmac('sha256', CS).update(b).digest('base64');
const sweep = (label, obj) => { const t = typeof obj === 'string' ? obj : JSON.stringify(obj); for (const s of SENT) ok(!t.includes(s), label + ' に ' + s + ' を含まない'); };

// 1インスタンス = 「Renderの1回の起動」。同じ gas / dir を渡して作り直すと再起動を再現する。
async function boot({ gas, dir, stops = ALLSTOPS, showAddress = false, timeoutMs = 300, clock }) {
  const backend = Gas.createGasBackend({ url: 'https://gas.invalid/exec', token: gas.token, fetchImpl: gas.fetchImpl, timeoutMs });
  const store = Store.createAssignmentStore({ backend, clock, filePath: path.join(dir, 'a-' + crypto.randomBytes(3).toString('hex') + '.json') }); // 毎回新しいローカル(=再デプロイで一時ファイルが消えた状態)
  await store.init();
  const sent = []; const tokenStore = Core.createMapTokenStore();
  const app = express(); app.use(express.json({ verify: (req, res, buf) => { if (req.url === '/line-map/webhook') req.rawBody = buf; } }));
  app.use(Routes.createLineMapRouter({ express, env: { PROXY_SECRET: PS, LINE_CHANNEL_SECRET: CS, PUBLIC_ORIGIN: 'https://example.invalid', SHOW_ADDRESS: showAddress }, assignmentStore: store, tokenStore, getRouteStops: () => stops, reply: async (t, m) => { sent.push(m); }, todayJst: () => today }));
  const srv = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = 'http://127.0.0.1:' + srv.address().port;
  let evN = 0;
  const api = { store, sent, base, close: () => srv.close(),
    post: (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) }),
    sync: (b = SYNC) => api.post('/line-map/assignments', b, { 'x-proxy-secret': PS }),
    say: async (user, text = 'マップ') => { const raw = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'e' + (++evN) + crypto.randomBytes(4).toString('hex'), timestamp: Date.now(), replyToken: 'rt', source: { type: 'user', userId: user }, message: { type: 'text', id: String(evN), text } }] });
      const before = sent.length; const r = await fetch(base + '/line-map/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': sign(raw) }, body: raw }); eq(r.status, 200, 'webhook 200'); return sent.length > before ? sent[sent.length - 1] : null; },
    tokenOf: (msgs) => msgs[1].contents.footer.contents[0].action.uri.split('#')[1],
    data: (token) => api.post('/line-map/data', { token }) };
  return api;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmp-'));

// ================= 1. 正常保存 → 再起動 → 正常復元 (10:割当+Cortex両方OK → 本人の正しいMAPのみ) =================
{ const gas = createGasMock(); const a = await boot({ gas, dir });
  const r = await (await a.sync()).json(); eq([r.status, r.remote], ['ok', 'ok'], '保存成功(GASの確認応答を検証済み)'); eq(gas.envelope.seq, 1);
  ok(!JSON.stringify(gas.envelope).match(/address|latitude|longitude|token|Tracking|SENTINEL/i), 'GASに住所・座標・荷物・トークンは保存されない');
  ok(!gas.bodies.some(b => b.includes(PS) || b.includes(CS)), 'GASへ送る内容にOFK3の秘密値を含まない');
  ok(gas.calls.every(c => !c.url.includes(gas.token)), 'GASトークンはURLに載せない'); a.close();
  const b = await boot({ gas, dir }); ok(b.store.isRestored(), '再起動後に復元'); eq(b.store.assignmentsFor(today).length, 2); eq(b.store.status().remoteSeq, 1);
  const m = await b.say(UA); ok(m && m.length === 2, '本人にMAPを返信'); ok(/DCX-1|DSX-1/.test(m[0].text) && !m[0].text.includes('-2'), '本人のコースのみ');
  const d = await (await b.data(b.tokenOf(m))).json(); eq(d.status, 'ok'); eq(d.pins.map(p => p.pin), [1, 2, 3], 'Amazon巡回順'); ok(d.pins.every(p => p.lng === 130.1), '本人のルートの座標のみ(他人=131.2は含まない)');
  const mB = await b.say(UB); ok(/-2/.test(mB[0].text), 'BにはBのコース'); const dB = await (await b.data(b.tokenOf(mB))).json(); ok(dB.pins.every(p => p.lng === 131.2), 'Bの座標のみ');
  eq((await b.data(b.tokenOf(m))).status, 200); b.close(); }

// ================= 2. GAS接続不可 / 3. 認証エラー / 4. 破損 / 5. 部分取得 → 未復元で安全に停止 =================
{ const gas = createGasMock(); const a = await boot({ gas, dir }); await a.sync(); a.close();
  const cases = [['down', 'gas-network'], ['timeout', 'gas-timeout'], ['unauthorized', 'gas-unauthorized'], ['401', 'gas-unauthorized'], ['429', 'gas-rate-limited'], ['500', 'gas-server-error'], ['503', 'gas-server-error'],
    ['html', 'gas-bad-json'], ['badjson', 'gas-bad-json'], ['empty', 'gas-bad-json'], ['huge', 'gas-too-large'], ['partial-load', 'gas-partial-response'], ['corrupt-load', 'remote-corrupt'], ['schema-load', 'remote-corrupt']];
  for (const [fault, code] of cases) {
    gas.fault = fault; const b = await boot({ gas, dir });
    ok(!b.store.isRestored(), fault + ': 未復元'); eq(b.store.status().lastError, code, fault + ': エラーは固定コードのみ'); eq(b.store.assignmentsFor(today).length, 0, fault + ': 部分復元しない');
    const m = await b.say(UA); ok(m && m.length === 1 && /復元中/.test(m[0].text), fault + ': 配送情報を返さず「復元中」');
    const st = JSON.stringify(b.store.status()); ok(!st.includes('gas.invalid') && !st.includes(gas.token), fault + ': 状態に秘密値・URLなし');
    eq((await b.sync()).status, 200, fault + ': 同期自体は受け付ける'); eq((await (await b.sync()).json()).remote, 'skipped-unrestored', fault + ': 部分データでGASを上書きしない'); b.close();
  }
  gas.fault = null; eq(gas.envelope.seq, 1, '障害中もGASの内容は無傷'); }

// ================= 6. 古い日付の割当 / 7. 別人のLINE ID =================
{ const gas = createGasMock(); const a = await boot({ gas, dir }); await a.sync({ ...SYNC, date: today }); a.close();
  // 昨日の割当だけが保存されている状態を作る
  const env = JSON.parse(JSON.stringify(gas.envelope)); const d0 = Object.keys(env.data)[0]; const e0 = env.data[d0];
  e0.rows.forEach(r => r.date = yesterday); env.data = { [yesterday]: e0 }; env.checksum = Store.checksumOf(env.data); gas.envelope = env;
  const b = await boot({ gas, dir }); ok(b.store.isRestored() && b.store.hasDate(yesterday) && !b.store.hasDate(today), '昨日の割当のみ復元');
  const m = await b.say(UA); ok(m.length === 1 && /届いていません/.test(m[0].text), '古い日付の割当を当日MAPとして返さない(未同期と案内)'); sweep('古い日付の応答', m); b.close(); }
{ const gas = createGasMock(); const a = await boot({ gas, dir }); await a.sync(); a.close(); const b = await boot({ gas, dir });
  const m = await b.say(UC); ok(m.length === 1 && /紐付いていません/.test(m[0].text), '別人(未紐付けのLINE ID)にはMAPを返さない'); sweep('未紐付け応答', m);
  const g = await boot({ gas: createGasMock(), dir }); await g.sync({ ...SYNC, links: [{ driverId: 'A001', lineUserId: UA }] }); const mu = await g.say(UB); ok(mu.length === 1 && /紐付いていません/.test(mu[0].text), 'リンクが無い人は同じルートを持つ別人でも見られない');
  // 他人のトークンでは本人の応答にならない: Aのトークンを使ってもBの座標は出ない
  const tA = b.tokenOf(await b.say(UA)); const dA = await (await b.data(tA)).json(); ok(dA.pins.every(p => p.lng === 130.1), 'Aのトークン=Aの座標のみ'); b.close(); g.close(); }

// ================= 8. 割当だけ復元・Cortex未復元 / 9. Cortexだけ復元・割当未復元 =================
{ const gas = createGasMock(); const a = await boot({ gas, dir }); await a.sync(); a.close();
  const noCortex = await boot({ gas, dir, stops: [] }); const m = await noCortex.say(UA); ok(m.length === 1 && /復元できていません|取得/.test(m[0].text), '割当のみ復元: MAPを返さない'); sweep('Cortex未復元応答', m); noCortex.close(); }
{ const gas = createGasMock(); const a = await boot({ gas, dir }); await a.sync(); a.close();
  const b = await boot({ gas, dir, stops: [] }); const mm = await (await b.post('/line-map/test-preview', { driverId: 'A001' }, { 'x-proxy-secret': PS })).json(); ok(mm.messages.length === 1, '割当のみ復元: プレビューもMAPなし'); b.close();
  }
{ const gas = createGasMock(); // GAS空 (割当未復元=未同期) + Cortexは復元済み
  const b = await boot({ gas, dir }); ok(b.store.isRestored() && !b.store.hasDate(today), 'GAS空: 同期済みの割当なし');
  const m = await b.say(UA); ok(m.length === 1 && /届いていません/.test(m[0].text), 'Cortexだけ復元・割当なし: 「未同期」としてMAPを返さない'); sweep('未同期応答', m);
  const fresh = await boot({ gas: createGasMock(), dir }); await fresh.sync(); const tkn = fresh.tokenOf(await fresh.say(UA));
  // 同じトークンを、割当が無いインスタンスへ持ち込んでも表示されない (トークンは別インスタンスでは無効)
  eq((await b.data(tkn)).status, 410, '別インスタンスのトークンは無効'); fresh.close(); b.close(); }
{ const gas = createGasMock(); const a = await boot({ gas, dir }); await a.sync(); const tk = a.tokenOf(await a.say(UA)); a.close();
  // 割当のみ復元されたが Cortex が空の状態で、(トークンファイルを共有する形で) 同じトークンを提示 → 503 data-not-restored
  const tokenFile = path.join(dir, 'shared-tokens.json');
  const mk = async (stops) => { const store = Store.createAssignmentStore({ backend: Gas.createGasBackend({ url: 'https://gas.invalid/exec', token: gas.token, fetchImpl: gas.fetchImpl }) }); await store.init(); const app = express(); app.use(express.json());
    app.use(Routes.createLineMapRouter({ express, env: { PROXY_SECRET: PS, LINE_CHANNEL_SECRET: CS, PUBLIC_ORIGIN: 'https://e.invalid', SHOW_ADDRESS: false }, assignmentStore: store, tokenStore: Core.createMapTokenStore(), tokenFile, getRouteStops: () => stops, reply: async () => {}, todayJst: () => today }));
    const srv = await new Promise(r => { const x = app.listen(0, () => r(x)); }); return { base: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close(), store }; };
  const one = await mk(ALLSTOPS); const env1 = JSON.parse(fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : '{}'); one.close();
  // 発行(プレビュー)してファイルに残す
  const two = await mk(ALLSTOPS); const pv = await (await fetch(two.base + '/line-map/test-preview', { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-secret': PS }, body: JSON.stringify({ driverId: 'A001' }) })).json();
  const tok2 = pv.messages[1].contents.footer.contents[0].action.uri.split('#')[1]; two.close();
  const three = await mk([]); const r3 = await fetch(three.base + '/line-map/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok2 }) }); eq(r3.status, 503, '割当は復元・Cortex未復元: データを返さない'); eq((await r3.json()).code, 'data-not-restored', 'Cortex未復元は明確なエラー'); three.close();
  const four = await mk(ALLSTOPS); const r4 = await fetch(four.base + '/line-map/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok2 }) }); eq(r4.status, 200, '両方復元後は同じトークンで表示(期限内)'); four.close(); }

// ================= 競合・古いデータによる上書き防止・保存確認 =================
{ const gas = createGasMock(); let tA = Date.parse('2026-11-02T10:00:00Z'); let tB = Date.parse('2026-11-02T09:00:00Z');
  const A = await boot({ gas, dir, clock: () => tA }); const B = await boot({ gas, dir, clock: () => tB }); // 同じ世代(seq 0)から起動した2インスタンス
  eq((await (await A.sync()).json()).remote, 'ok', 'Aが先に保存'); eq(gas.envelope.seq, 1);
  const stale = { ...SYNC, rows: [{ routeCode: ROUTE_A, driverId: 'A999' }], links: [{ driverId: 'A999', lineUserId: UC }] }; // Bの古い(09:00)割当
  eq((await (await B.sync(stale)).json()).remote, 'ok', 'Bは競合を検知して再読込→マージ→再保存');
  ok(B.store.assignmentsFor(today).some(r => r.driverId === 'A001'), '新しいAの割当が残る(古いBのデータで上書きされない)'); ok(!B.store.assignmentsFor(today).some(r => r.driverId === 'A999'), '古いBの割当は採用されない');
  eq(gas.envelope.seq >= 2, true, 'GAS側の世代は単調増加'); A.close(); B.close();
  // 別の日付の同期は両方残る
  const gas2 = createGasMock(); const C = await boot({ gas: gas2, dir }), D = await boot({ gas: gas2, dir });
  await C.sync(); const other = { ...SYNC, date: new Date(Date.parse(today) + 86400e3).toISOString().slice(0, 10) }; eq((await (await D.sync(other)).json()).remote, 'ok');
  ok(Object.keys(gas2.envelope.data).length === 2, '別日付の同期は上書きし合わず両方保存'); C.close(); D.close(); }
for (const [fault, label] of [['save-no-ack', '確認応答なし'], ['save-wrong-ack', '確認応答が不一致']]) {
  const gas = createGasMock(); const a = await boot({ gas, dir }); gas.fault = fault; const r = await (await a.sync()).json();
  eq(r.remote, 'failed', label + ': 「外部保存成功」としない'); eq(r.remoteError, 'gas-partial-response', label + ': 原因コード'); ok(a.store.status().dirty, '未反映の印'); eq(a.store.assignmentsFor(today).length, 2, 'メモリの内容は有効'); a.close(); }
{ const gas = createGasMock(); gas.folderPrivate = false; const a = await boot({ gas, dir }); const r = await (await a.sync()).json(); eq([r.remote, r.remoteError], ['failed', 'gas-folder-not-private'], '保存先が非公開でなければGASは書き込まない'); eq(gas.envelope, null); a.close(); }
for (const [fault, code] of [['timeout', 'gas-timeout'], ['429', 'gas-rate-limited'], ['500', 'gas-server-error'], ['down', 'gas-network']]) {
  const gas = createGasMock(); const a = await boot({ gas, dir }); gas.fault = fault; const t0 = Date.now(); const r = await (await a.sync()).json(); ok(Date.now() - t0 < 3000, fault + ': 長時間ブロックしない');
  eq([r.remote, r.remoteError], ['failed', code], fault + ': 保存失敗は固定コード'); ok(!JSON.stringify(r).includes('gas.invalid'), fault + ': 応答にURLなし');
  gas.fault = null; eq((await (await a.sync()).json()).remote, 'ok', fault + ': 回復後の次の同期で自動的に保存される'); a.close(); }
{ const be = Gas.createGasBackend({ url: 'https://secret-deployment-id.invalid/exec', token: 'tok-should-not-leak', fetchImpl: async (u) => { throw new TypeError('fetch failed ' + u + ' tok-should-not-leak'); } });
  const e = await be.load().then(() => null, x => x); ok(e instanceof Error, '例外が投げられる'); eq(e.message, 'gas-network', '例外メッセージは固定コードのみ'); ok(!e.stack.includes('secret-deployment-id') && !e.stack.includes('tok-should-not-leak'), 'スタックにもURL・トークンを含まない'); }

// ================= スキーマ・件数・重複・1対1 =================
{ const good = { [today]: { rows: [{ date: today, cycle: cyc, routeCode: ROUTE_A, driverId: 'A001' }], links: [{ driverId: 'A001', lineUserId: UA }], syncedAt: new Date().toISOString() } };
  ok(Store.validateStoredState(good).ok, '正常なデータは受理');
  const mut = (f) => { const c = JSON.parse(JSON.stringify(good)); f(c[today], c); return Store.validateStoredState(c); };
  ok(!mut(e => { e.rows[0].address = 'x'; }).ok, '想定外キー(住所)を拒否'); ok(!mut(e => { e.links[0].token = 'x'; }).ok, '想定外キー(トークン)を拒否'); ok(!mut(e => { e.extra = 1; }).ok, 'エントリの想定外キーを拒否');
  ok(!mut(e => { e.rows[0].cycle = cyc === 'C1' ? 'C3' : 'C1'; }).ok, 'サイクル不一致を拒否'); ok(!mut(e => { e.rows.push({ date: today, cycle: cyc, routeCode: ROUTE_A, driverId: 'A002' }); }).ok, '1ルートに複数DAを拒否');
  ok(!mut(e => { e.rows.push({ date: today, cycle: cyc, routeCode: pre + '-9', driverId: 'A001' }); }).ok, '同一DAが同サイクルで複数ルートを拒否'); ok(!mut(e => { e.links.push({ driverId: 'A002', lineUserId: UA }); }).ok, '1つのLINE IDに複数DAを拒否');
  ok(!mut(e => { e.links.push({ driverId: 'A001', lineUserId: UB }); }).ok, '1DAに複数LINE IDを拒否'); ok(!mut(e => { e.links[0].lineUserId = 'bad'; }).ok, 'LINE ID形式不正を拒否'); ok(!mut(e => { e.syncedAt = 'x'; }).ok, 'syncedAt不正を拒否');
  ok(!mut(e => { e.rows = Array.from({ length: 2001 }, (_, i) => ({ date: today, cycle: cyc, routeCode: pre + '-' + i, driverId: 'D' + i })); }).ok, '2000件超を拒否');
  ok(!mut((e, c) => { for (let i = 1; i <= 6; i++) c['2026-01-0' + i] = e; }).ok, '日付数の上限超を拒否'); ok(!Store.validateStoredState({ 'not-a-date': good[today] }).ok, '日付形式不正を拒否'); ok(!Store.validateStoredState([]).ok && !Store.validateStoredState(null).ok, '型違いを拒否');
  const env = { v: 1, seq: 1, savedAt: 'x', checksum: Store.checksumOf(good), data: good }; ok(Store.verifyEnvelope(env).ok, 'envelope正常'); ok(!Store.verifyEnvelope({ ...env, checksum: 'f'.repeat(64) }).ok, 'checksum不一致を拒否'); ok(!Store.verifyEnvelope({ ...env, v: 2 }).ok && !Store.verifyEnvelope({ ...env, seq: -1 }).ok, 'バージョン・世代不正を拒否');
  // 同期入力側: 空白・制御文字を含むIDを拒否
  const sv = Store.createAssignmentStore({}); ok(!sv.sync({ ...SYNC, rows: [{ routeCode: ROUTE_A, driverId: 'A 001' }] }, today).ok, '同期: 空白を含むDA IDを拒否'); }
// ローカルファイルが破損/改ざんされていても部分採用しない
{ const f = path.join(dir, 'tampered.json'); fs.writeFileSync(f, JSON.stringify({ assignments: { [today]: { rows: [{ date: today, cycle: cyc, routeCode: ROUTE_A, driverId: 'A001', address: 'SENTINEL-ADDR' }], links: [], syncedAt: new Date().toISOString() } } }));
  const s = Store.createAssignmentStore({ filePath: f }); eq(s.assignmentsFor(today).length, 0, '改ざんされたローカルファイルは丸ごと破棄'); fs.writeFileSync(f, '{broken'); eq(Store.createAssignmentStore({ filePath: f }).assignmentsFor(today).length, 0, '壊れたJSONも破棄'); }

// ================= 住所非表示 (API・表示・エラー・プレビュー・ログ) =================
for (const showAddress of [false]) {
  const gas = createGasMock(); const a = await boot({ gas, dir, showAddress }); await a.sync(); const m = await a.say(UA); sweep('LINE返信', m);
  const tok = a.tokenOf(m); const d = await a.data(tok); const dj = await d.json(); sweep('データAPI', dj); ok(dj.pins.every(p => !('address' in p)), 'pinsにaddressキーなし');
  const bad = await a.data('x'.repeat(30)); sweep('410応答', await bad.text());
  const pv = await (await a.post('/line-map/test-preview', { driverId: 'A001' }, { 'x-proxy-secret': PS })).json(); sweep('プレビュー', pv);
  const st = await (await fetch(a.base + '/line-map/status', { headers: { 'x-proxy-secret': PS } })).json(); sweep('状態', st);
  for (const p of ['/line-map/view', '/line-map/assets/view.js', '/line-map/assets/view.css']) { const t = await (await fetch(a.base + p)).text(); sweep(p, t); }
  sweep('GAS保存内容', gas.bodies.join('')); sweep('GAS保存内容(envelope)', gas.envelope);
  const nm = Core.buildMapModel(ALLSTOPS, ROUTE_A); ok(nm.pins.every(p => p.address === undefined), 'MAPモデル自体に住所を載せない(既定)'); eq(Core.buildMapModel(ALLSTOPS, ROUTE_A, { includeAddress: true }).pins[0].address.startsWith('SENTINEL-ADDR'), true, '明示した場合のみ載る');
  a.close(); }
{ const gas = createGasMock(); const a = await boot({ gas, dir, showAddress: true }); await a.sync(); const dj = await (await a.data(a.tokenOf(await a.say(UA)))).json(); ok(dj.pins[0].address && dj.pins[0].address.startsWith('SENTINEL-ADDR'), 'LINE_MAP_SHOW_ADDRESS=1 相当のときだけ住所が出る(既定OFFの対照)'); sweep('(参考) 運転手名・追跡IDは常に出さない', (dj.pins || []).map(p => ({ ...p, address: undefined }))); a.close(); }

// ================= 実サーバー(子プロセス)+ 実HTTPのGASモック: 環境変数の解釈・ログ・実fetch経路 =================
{
  const free = () => new Promise(r => { const x = net.createServer().listen(0, () => { const p = x.address().port; x.close(() => r(p)); }); });
  const children = new Set(); process.on('exit', () => children.forEach(c => { try { c.kill(); } catch {} }));
  const spawnServer = async (env) => { const port = await free(); const p = spawn('node', ['render-webhook-server.js'], { env: { PATH: process.env.PATH, PORT: String(port), PROXY_SECRET: PS, LINE_CHANNEL_SECRET: CS, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(p);
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
    return { port, base: `http://127.0.0.1:${port}`, log: () => out, stop: () => new Promise(r => { p.once('exit', r); p.kill(); }) }; };
  const gas = createGasMock({ token: 'real-http-gas-token-abcdef' }); const hs = await gas.serve();
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-')); const post = (s, p, b, h = {}) => fetch(s.base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
  const cortex = (s) => post(s, '/cortex-priority/import', { localDate: today, packages: [], routeStops: ALLSTOPS.map(({ driverName, trackingId, ...r }) => ({ ...r, driverName: 'SENTINEL-DRIVER' })) });
  for (const addrEnv of [{}, { LINE_MAP_SHOW_ADDRESS: '0' }]) { // 未設定 と '0' はどちらも住所非表示
    let s = await spawnServer({ ...addrEnv, LINE_MAP_GAS_URL: hs.url, LINE_MAP_GAS_TOKEN: gas.token, LINE_MAP_DATA_DIR: dirS });
    try {
      eq((await (await post(s, '/line-map/assignments', SYNC, { 'x-proxy-secret': PS })).json()).remote, 'ok', '実HTTPのGASへ保存: ' + JSON.stringify(addrEnv)); await cortex(s);
      const pv = await (await post(s, '/line-map/test-preview', { driverId: 'A001' }, { 'x-proxy-secret': PS })).json(); sweep('サーバー: プレビュー', pv);
      const tok = pv.messages[1].contents.footer.contents[0].action.uri.split('#')[1]; const dj = await (await post(s, '/line-map/data', { token: tok })).json();
      eq(dj.status, 'ok'); sweep('サーバー: データAPI ' + JSON.stringify(addrEnv), dj); ok(dj.pins.every(p => !('address' in p)));
      await s.stop();
      // 再起動 (割当の一時ファイルは別ディレクトリ=消えた状態) + 認証エラーのGAS
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lms2-')); gas.fault = 'unauthorized';
      s = await spawnServer({ ...addrEnv, LINE_MAP_GAS_URL: hs.url, LINE_MAP_GAS_TOKEN: gas.token, LINE_MAP_DATA_DIR: dir2 }); await cortex(s);
      const st = await (await fetch(s.base + '/line-map/status', { headers: { 'x-proxy-secret': PS } })).json(); eq([st.assignmentsRestored, st.remote.lastError], [false, 'gas-unauthorized'], '認証エラー: 復元せず原因コードのみ');
      const pv2 = await (await post(s, '/line-map/test-preview', { driverId: 'A001' }, { 'x-proxy-secret': PS })).json(); ok(pv2.messages.length === 1 && /復元中/.test(pv2.messages[0].text), '復元前は配送情報を返さない');
      const lg = s.log(); ok(!lg.includes(gas.token) && !lg.includes(hs.url) && !lg.includes('127.0.0.1:' + new URL(hs.url).port), 'ログにGASトークン・URLなし'); sweep('サーバーログ', lg); ok(!lg.includes(PS) && !lg.includes(CS), 'ログにOFK3の秘密値なし');
      // GAS復旧 → 次の要求で自動的に復元 (復元試行は30秒間隔のため、ここでは同期APIの再試行経路を確認)
      gas.fault = null; await s.stop();
      s = await spawnServer({ ...addrEnv, LINE_MAP_GAS_URL: hs.url, LINE_MAP_GAS_TOKEN: gas.token, LINE_MAP_DATA_DIR: dir2 }); await cortex(s);
      const st2 = await (await fetch(s.base + '/line-map/status', { headers: { 'x-proxy-secret': PS } })).json(); eq([st2.assignmentsRestored, st2.assignmentRows], [true, 2], '再起動+GAS復旧: 割当が復元(ローカルファイルなしでも)');
      const pv3 = await (await post(s, '/line-map/test-preview', { driverId: 'A001' }, { 'x-proxy-secret': PS })).json(); ok(pv3.messages.length === 2, '復元後はMAPを生成'); sweep('復元後プレビュー', pv3);
    } finally { await s.stop(); }
  }
  await hs.close();
}
console.log('line-map-persistence tests passed (' + n + ' assertions)');
