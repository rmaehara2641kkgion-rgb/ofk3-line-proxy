import { spawn } from 'child_process';
import assert from 'assert';
import net from 'net';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const AS = require('../admin-session.js');
const G = require('../api-guard.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; }; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// ---- 単体: セッション / パスワード ----
{ const h = AS.hashPassword('correct-horse-battery', { N: 1024 }); ok(AS.verifyPassword('correct-horse-battery', h)); ok(!AS.verifyPassword('wrong', h)); ok(!AS.verifyPassword('x', 'garbage')); ok(!AS.verifyPassword('x', ''));
  let t = 1000; const sm = AS.createSessionManager({ secret: 's'.repeat(32), ttlMs: 500, clock: () => t });
  const c = sm.issue(); ok(sm.verify(c), '発行直後は有効'); ok(!sm.verify(c.slice(0, -2) + 'xx'), '改ざん不可'); ok(!sm.verify('v1.9999999999999.a.b'), '偽造不可');
  t = 1501; ok(!sm.verify(c), '期限切れ'); ok(!AS.createSessionManager({ secret: 'short' }).verify(c), 'secret短い場合は無効(fail-closed)');
  ok(AS.sameOrigin({ headers: { host: 'a.example', origin: 'https://a.example' } }) && !AS.sameOrigin({ headers: { host: 'a.example', origin: 'https://evil.example' } }) && !AS.sameOrigin({ headers: { host: 'a.example' } }), 'same-origin判定'); }
eq(G.groupOf('GET', '/route-data/abc'), null, 'ID指定の共有リンクは保護対象外(ドライバー利用)'); eq(G.groupOf('GET', '/map-image/x'), null); eq(G.groupOf('GET', '/pdf/x'), null);
eq(G.groupOf('POST', '/webhook'), null, 'Webhookは独自の署名検証'); eq(G.groupOf('GET', '/cortex-priority'), 'cortex-read');

// ---- サーバー統合 (子プロセス、フェイク値、一時環境) ----
const PW = 'integration-test-password-123', PS = 'ps-secret-value-xyz', IT = 'ingest-token-value-xyz', RT = 'read-token-value-xyz', SS = 'x'.repeat(40);
const HASH = AS.hashPassword(PW, { N: 1024 });
const children = new Set();
process.on('exit', () => children.forEach(c => { try { c.kill(); } catch {} }));
const freePort = () => new Promise(r => { const x = net.createServer().listen(0, () => { const pt = x.address().port; x.close(() => r(pt)); }); });
async function start(env) {
  const port = await freePort();
  const p = spawn('node', ['render-webhook-server.js'], { env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const base = `http://127.0.0.1:${port}`;
  return { p, log: () => out, base,
    req: (m, u, o = {}) => fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(o.h || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }),
    stop: () => new Promise(r => { p.once('exit', r); p.kill(); }) };
}
const IMPORT = { localDate: '2026-11-02', packages: [], routeStops: [{ routeCode: 'DCX-1', sequenceNumber: 1, latitude: 1, longitude: 1 }] };

// A. 既定(環境変数なし) = 現状から挙動不変
{ const s = await start({});
  eq((await s.req('GET', '/cortex-priority')).status, 404, '既定: 認証なしでも従来どおり(空=404)');
  eq((await s.req('POST', '/cortex-priority/import', { body: IMPORT })).status, 200, '既定: 拡張機能の取込は従来どおり');
  eq((await s.req('GET', '/cortex-priority?localDate=2026-11-02')).status, 200);
  const rd = await (await s.req('POST', '/route-data', { body: { points: [{ lat: 1 }] } })).json(); eq(rd.status, 'ok'); ok(/^[A-Za-z0-9_-]{24}$/.test(rd.id), 'IDは暗号論的乱数(24文字)');
  eq((await s.req('GET', '/route-data/' + rd.id)).status, 200, '既定: 共有リンクは従来どおり');
  eq((await s.req('GET', '/route-data/' + 'a'.repeat(24))).status, 404);
  eq((await s.req('POST', '/admin/login', { body: { password: PW } })).status, 503, '管理者認証未設定はログイン不可(fail-closed)');
  eq((await (await s.req('GET', '/admin/session')).json()).configured, false);
  eq((await s.req('GET', '/admin/api-guard-report')).status, 503);
  await s.stop(); }

// B. 監視モード: 遮断せず集計
{ const s = await start({ API_GUARD_MODE: 'report', PROXY_SECRET: PS });
  eq((await s.req('GET', '/cortex-priority')).status, 404, '監視モードは遮断しない');
  await s.req('GET', '/cortex-priority', { h: { 'x-proxy-secret': PS } }); await s.req('GET', '/cortex-priority', { h: { 'x-proxy-secret': 'bad' } });
  eq((await s.req('GET', '/admin/api-guard-report')).status, 401, 'レポートは認証必須');
  const rep = await (await s.req('GET', '/admin/api-guard-report', { h: { 'x-proxy-secret': PS } })).json();
  const c = rep.groups['cortex-read']; eq([c.total, c.anonymous, c.proxySecret, c.denied, c.wouldDeny], [3, 2, 1, 0, 2], '資格種別ごとの集計(無効な資格=anonymous)'); eq(rep.enforced, []);
  await s.stop(); }

// C. 強制モード
const ALL = 'cortex-ingest,cortex-read,share-write,masters,line-send,line-unlinked,exports';
{ const s = await start({ API_GUARD_ENFORCE: ALL, PROXY_SECRET: PS, INGEST_TOKEN: IT, CORTEX_READ_TOKEN: RT, ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: SS });
  const anon = [['GET', '/cortex-priority'], ['POST', '/cortex-priority/import'], ['POST', '/route-data'], ['POST', '/map-image'], ['POST', '/pdf-upload'], ['GET', '/volume-master'], ['POST', '/addr-master'], ['GET', '/tenko-master'], ['GET', '/area-experience-master'],
    ['POST', '/proxy'], ['GET', '/proxy'], ['POST', '/mentor-alert'], ['GET', '/mentor-notified'], ['GET', '/line-unlinked'], ['POST', '/line-unlinked/link'], ['POST', '/lat-export'], ['POST', '/encrypt-zip'], ['GET', '/wh60/status']];
  for (const [m, u] of anon) eq((await s.req(m, u, m === 'POST' ? { body: {} } : {})).status, 401, '未認証拒否 ' + m + ' ' + u);
  // 利用元を壊さない経路
  eq((await s.req('GET', '/ping')).status, 200); eq((await s.req('GET', '/')).status, 200, '管理画面本体は配信'); eq((await s.req('GET', '/route-data/' + 'a'.repeat(24))).status, 404, 'ID共有リンクは認証対象外'); eq((await s.req('GET', '/map-image/x')).status, 404); eq((await s.req('GET', '/pdf/x')).status, 404);
  eq((await s.req('POST', '/webhook', { body: { events: [] } })).status, 200, 'LINE webhookは影響なし(従来動作)');
  eq((await s.req('GET', '/line-notifications/status')).status, 200, '状態確認は従来どおり');
  // サーバー間
  eq((await s.req('GET', '/cortex-priority', { h: { 'x-proxy-secret': 'bad' } })).status, 401, '誤ったsecret拒否');
  eq((await s.req('POST', '/cortex-priority/import', { body: IMPORT, h: { 'x-proxy-secret': PS } })).status, 200, 'secretで取込可');
  // 拡張機能: 取込トークン
  eq((await s.req('POST', '/cortex-priority/import', { body: IMPORT, h: { 'x-ofk3-ingest-token': IT } })).status, 200, '拡張機能(取込トークン)互換');
  eq((await s.req('POST', '/route-data', { body: {}, h: { 'x-ofk3-ingest-token': IT } })).status, 401, '取込トークンは取込専用(スコープ限定)');
  eq((await s.req('GET', '/cortex-priority', { h: { 'x-ofk3-ingest-token': IT } })).status, 401, '取込トークンで読めない');
  // 読み取り専用トークン (HARVEST等の非ブラウザ向け・未配布)
  eq((await s.req('GET', '/cortex-priority?localDate=2026-11-02', { h: { authorization: 'Bearer ' + RT } })).status, 200, '読取トークンで読める');
  eq((await s.req('POST', '/cortex-priority/import', { body: IMPORT, h: { authorization: 'Bearer ' + RT } })).status, 401, '読取トークンで書けない');
  eq((await s.req('GET', '/volume-master', { h: { authorization: 'Bearer ' + RT } })).status, 401, '読取トークンはcortex以外不可');
  // 管理者セッション
  const bad = await s.req('POST', '/admin/login', { body: { password: 'nope' }, h: { origin: s.base } }); eq(bad.status, 401);
  eq((await s.req('POST', '/admin/login', { body: { password: PW }, h: { origin: 'https://evil.example' } })).status, 403, '別オリジンからのログイン不可');
  const li = await s.req('POST', '/admin/login', { body: { password: PW }, h: { origin: s.base } }); eq(li.status, 200);
  const sc = li.headers.get('set-cookie'); ok(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), 'HttpOnly/SameSite=Strict'); const cookie = sc.split(';')[0];
  ok(!JSON.stringify(await (await s.req('GET', '/admin/session', { h: { cookie } })).json()).includes(PW));
  eq((await (await s.req('GET', '/admin/session', { h: { cookie } })).json()).authenticated, true);
  eq((await s.req('GET', '/cortex-priority?localDate=2026-11-02', { h: { cookie } })).status, 200, '管理画面(ログイン済み)互換: Cookieで読める');
  eq((await s.req('GET', '/volume-master?action=list', { h: { cookie } })).status !== 401, true, 'マスタ系もCookieで通る');
  eq((await s.req('POST', '/route-data', { body: { points: [] }, h: { cookie, origin: s.base } })).status, 200, '同一オリジンの更新は可');
  eq((await s.req('POST', '/route-data', { body: {}, h: { cookie, origin: 'https://evil.example' } })).status, 403, 'CSRF: 他オリジンは拒否');
  eq((await s.req('POST', '/route-data', { body: {}, h: { cookie } })).status, 403, 'CSRF: Origin無しは拒否');
  eq((await s.req('GET', '/cortex-priority', { h: { cookie: cookie.slice(0, -3) + 'xxx' } })).status, 401, '改ざんCookie拒否');
  eq((await s.req('POST', '/route-data', { body: {}, h: { 'x-proxy-secret': PS } })).status, 200, 'サーバー間はOrigin不要');
  // ブルートフォース
  for (let i = 0; i < 5; i++) eq((await s.req('POST', '/admin/login', { body: { password: 'bad' + i }, h: { origin: s.base } })).status, 401);
  eq((await s.req('POST', '/admin/login', { body: { password: PW }, h: { origin: s.base } })).status, 429, 'ログイン総当たりで遮断');
  // ログに機微情報なし
  const lg = s.log(); for (const v of [PW, PS, IT, RT, SS, HASH]) ok(!lg.includes(v), 'ログに秘密値なし');
  await s.stop(); }

// D. 一部グループのみ強制 → 他は従来どおり / 資格が一つも無ければ503
{ const s = await start({ API_GUARD_ENFORCE: 'cortex-read', PROXY_SECRET: PS });
  eq((await s.req('GET', '/cortex-priority')).status, 401); eq((await s.req('POST', '/route-data', { body: {} })).status, 200, '強制対象外グループは従来どおり'); eq((await s.req('POST', '/cortex-priority/import', { body: IMPORT })).status, 200, '取込は未強制なら従来どおり');
  await s.stop(); }
{ const s = await start({ API_GUARD_ENFORCE: 'cortex-read' });
  eq((await s.req('GET', '/cortex-priority')).status, 503, '強制するが資格が未設定→安全側に停止'); await s.stop(); }
// E. ログの個人情報: /proxy は宛先LINE IDと本文をログに出さない (LINE通知は既定で停止中=実送信なし)
{ const s = await start({});
  const r = await s.req('POST', '/proxy', { body: { to: 'U' + 'e'.repeat(32), messages: [{ type: 'text', text: 'SECRET-BODY-TEXT' }] } }); ok(r.status === 200 || r.status === 502, '/proxyは従来どおり応答');
  await new Promise(r => setTimeout(r, 300)); const lg = s.log(); ok(!lg.includes('e'.repeat(32)) && !lg.includes('SECRET-BODY-TEXT'), '/proxy: 宛先ID・本文がログに出ない'); ok(/LINE push request: messages=1/.test(lg));
  await s.stop(); }
console.log('api-guard tests passed (' + n + ' assertions)');
