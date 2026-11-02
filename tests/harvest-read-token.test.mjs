// HARVEST 読取トークン対応のテスト。モックの上流サーバーとフェイクのトークンのみ使用 (実OFK3・実データには接続しない)。
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const L = require(join(root, 'harvest-local-server.js'));

let passed = 0;
function assert(c, m) { if (!c) throw new Error('FAIL: ' + m); passed += 1; }
function eq(a, b, m) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error('FAIL: ' + m + '\n  actual:   ' + x + '\n  expected: ' + y); passed += 1; }

const TOKEN = 'fake-read-token-0123456789abcdef';
const DATA = { status: 'ok', localDate: '2026-11-02', packages: [{ routeCode: 'DCX-1', stop: 1 }], routeStops: [], stopCount: 1, packageCount: 1 };

// モック上流 (OFK3を模す): 受信ヘッダーを記録し、設定に応じて応答する
function mockUpstream(mode) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const tok = req.headers['x-ofk3-read-token'];
    const j = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (mode === 'open') return j(200, DATA);                                     // 認証強制前
    if (mode === 'enforce') return !tok ? j(401, { status: 'error', message: 'unauthorized' }) : tok === TOKEN ? j(200, DATA) : j(401, { status: 'error', message: 'unauthorized' });
    if (mode === '403') return j(403, { status: 'error', message: 'Forbidden' });
    if (mode === 'notcfg') return j(503, { status: 'error', message: 'not configured' });
    if (mode === 'sleep503') { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<html>Service Unavailable</html>'); }
    if (mode === 'hang') return; // 応答しない
    if (mode === 'other-api') return j(200, {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, seen, origin: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise(c => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(c); }) })));
}
function harvest(env, opts) {
  const s = L.createServer(Object.assign({ port: 0, env }, opts || {}));
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, port: s.address().port, close: () => new Promise(c => s.close(c)) })));
}
function get(port, path) {
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path, headers: { host: '127.0.0.1:' + port } }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: x.statusCode, text: d, json: j }); }); }).on('error', reject));
}
const Q = '/cortex-priority?localDate=2026-11-02';
async function scenario(mode, env, fn) {
  const up = await mockUpstream(mode); const h = await harvest(Object.assign({ HARVEST_UPSTREAM_BASE_URL: up.origin }, env));
  try { await fn(h, up); } finally { await h.close(); await up.close(); }
}

// 1. パーサ
eq(L.parseReadToken(undefined), { ok: true, token: null }, '未設定');
eq(L.parseReadToken('   '), { ok: true, token: null }, '空白のみ=未設定');
eq(L.parseReadToken(TOKEN), { ok: true, token: TOKEN }, '有効');
for (const bad of ['short', 'has space inside-xxxxxxxxxxxxxxxx', 'line\nbreak-xxxxxxxxxxxxxxxxxxxx', 'x'.repeat(513), 'ok-token-xxxxxxxxxxxx\r\nX-Evil: 1']) {
  const r = L.parseReadToken(bad); assert(r.ok === false && !String(r.error).includes(bad.slice(0, 8)), '不正形式を拒否しエラーに値を含めない: ' + JSON.stringify(bad).slice(0, 20));
}
eq(L.READ_TOKEN_HEADER, 'X-Ofk3-Read-Token', 'ヘッダー名');

// 2. トークンあり・上流が認証強制 → 正常取得 (ヘッダーはこれ1つだけ追加)
await scenario('enforce', { HARVEST_UPSTREAM_READ_TOKEN: TOKEN }, async (h, up) => {
  const r = await get(h.port, Q); eq([r.status, r.json.status], [200, 'ok'], '認証強制下でも正常取得');
  eq(up.seen.length, 1, '上流へは1回のみ(再試行なし)');
  eq(Object.keys(up.seen[0].headers).filter(k => /^x-ofk3|authorization|cookie/i.test(k)).sort(), ['x-ofk3-read-token'], '追加されるのは読取トークンのみ');
  assert(!up.seen[0].url.includes(TOKEN), 'URLにトークンなし');
  assert(!r.text.includes(TOKEN), 'ブラウザへの応答にトークンなし');
  const st = await get(h.port, '/harvest-status.json'); assert(!st.text.includes(TOKEN) && st.json.readTokenConfigured === true, '状態JSONは設定有無のみ');
  const page = await get(h.port, '/harvest'); const js = await get(h.port, '/harvest-shell.js'); assert(!page.text.includes(TOKEN) && !js.text.includes(TOKEN), '画面・スクリプトにトークンなし');
});

// 3. トークンなし: 既存互換 (上流が認証前なら従来どおり、ヘッダー無し)
await scenario('open', {}, async (h, up) => {
  const r = await get(h.port, Q); eq([r.status, r.json.stopCount], [200, 1], 'トークンなしの既存互換');
  eq(Object.keys(up.seen[0].headers).filter(k => /^x-ofk3|authorization|cookie/i.test(k)), [], '従来どおり認証ヘッダーなし');
  eq((await get(h.port, '/harvest-status.json')).json.readTokenConfigured, false);
});
// 3b. トークンあり・上流が認証前でも問題なし
await scenario('open', { HARVEST_UPSTREAM_READ_TOKEN: TOKEN }, async (h) => { eq((await get(h.port, Q)).status, 200, '強制前の上流でもトークン付きで取得できる(切替順序に依存しない)'); });

// 4. 認証強制下でトークンなし / 不正トークン → 原因分類・再試行なし
await scenario('enforce', {}, async (h, up) => {
  const r = await get(h.port, Q); eq([r.status, r.json.reason, r.json.upstreamStatus, r.json.tokenConfigured], [502, 'upstream-auth-required', 401, false], 'トークン未設定で401');
  assert(/HARVEST_UPSTREAM_READ_TOKEN/.test(r.json.message), '設定方法を案内'); eq(up.seen.length, 1, '再試行しない');
});
await scenario('enforce', { HARVEST_UPSTREAM_READ_TOKEN: TOKEN.replace('0123', '9999') }, async (h, up) => {
  const r = await get(h.port, Q); eq([r.status, r.json.reason, r.json.tokenConfigured], [502, 'upstream-token-rejected', true], '不正トークン');
  assert(!r.text.includes('9999'), '応答にトークンを含まない'); eq(up.seen.length, 1, '再試行しない');
});
await scenario('403', { HARVEST_UPSTREAM_READ_TOKEN: TOKEN }, async (h, up) => { const r = await get(h.port, Q); eq([r.status, r.json.reason], [502, 'upstream-forbidden'], '403の分類'); eq(up.seen.length, 1, '再試行しない'); });
await scenario('notcfg', { HARVEST_UPSTREAM_READ_TOKEN: TOKEN }, async (h, up) => { const r = await get(h.port, Q); eq([r.status, r.json.reason], [502, 'upstream-auth-not-configured'], '503(OFK3側未設定)の分類'); eq(up.seen.length, 1, '再試行しない'); });
await scenario('sleep503', {}, async (h) => { const r = await get(h.port, Q); eq([r.status, r.json.reason], [502, 'upstream-unavailable'], '503(スリープ等)は認証問題と区別'); });

// 5. 形式不正トークン → 上流へ一切送らない
await scenario('open', { HARVEST_UPSTREAM_READ_TOKEN: 'bad token with spaces!!' }, async (h, up) => {
  const r = await get(h.port, Q); eq([r.status, r.json.reason], [502, 'read-token-invalid'], '形式不正は中継を止める'); eq(up.seen.length, 0, '上流へ送信しない');
  assert(!r.text.includes('bad token'), '応答に値を含まない'); eq((await get(h.port, '/harvest-status.json')).json.readTokenError, true);
});

// 6. タイムアウト / サーバー停止
{
  const up = await mockUpstream('hang'); const h = await harvest({ HARVEST_UPSTREAM_BASE_URL: up.origin, HARVEST_UPSTREAM_READ_TOKEN: TOKEN },
    { fetchImpl: (u, init) => fetch(u, Object.assign({}, init, { signal: AbortSignal.timeout(300) })) });
  const t0 = Date.now(); const r = await get(h.port, Q); eq([r.status], [504], 'タイムアウトは504'); assert(Date.now() - t0 < 3000, '長時間待たない'); assert(!r.text.includes(TOKEN), 'エラーにトークンなし');
  eq(up.seen.length, 1, 'タイムアウト後も再試行しない'); await h.close(); await up.close();
}
{
  const up = await mockUpstream('open'); const origin = up.origin; await up.close();
  const h = await harvest({ HARVEST_UPSTREAM_BASE_URL: origin, HARVEST_UPSTREAM_READ_TOKEN: TOKEN });
  const r = await get(h.port, Q); eq([r.status, r.json.message], [502, 'upstream unreachable'], 'サーバー停止'); assert(!r.text.includes(TOKEN), 'エラーにトークンなし'); await h.close();
}

// 7. 他のOFK3 APIに影響しない: 中継は /cortex-priority の GET のみ。他パスは上流に出ない
await scenario('other-api', { HARVEST_UPSTREAM_READ_TOKEN: TOKEN }, async (h, up) => {
  for (const p of ['/route-data/x', '/proxy', '/volume-master', '/tenko-master', '/line-unlinked', '/admin/login']) assert((await get(h.port, p)).status === 404, p + ' は中継されない');
  eq(up.seen.length, 0, '他パスのリクエストは上流へ出ない');
  const bad = await get(h.port, '/cortex-priority?localDate=2026-11-02&token=zzz'); eq(bad.status, 400, '許可外クエリは拒否(トークンをクエリで渡せない)'); eq(up.seen.length, 0);
});

// 8. ログ漏えい: 実プロセスを起動して起動ログ・エラー時ログにトークンが出ないこと
{
  const up = await mockUpstream('enforce');
  const child = spawn('node', ['harvest-local-server.js'], { cwd: root, env: { PATH: process.env.PATH, HARVEST_PORT: '39455', HARVEST_UPSTREAM_BASE_URL: up.origin, HARVEST_UPSTREAM_READ_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  try {
    for (let i = 0; i < 40 && !/read token:/.test(out); i++) await new Promise(r => setTimeout(r, 100));
    assert(/read token: configured/.test(out), '起動ログは設定有無のみ'); await get(39455, Q);
    await new Promise(r => setTimeout(r, 200)); assert(!out.includes(TOKEN) && !out.includes('9876'), 'ログにトークンなし');
  } finally { child.kill(); await up.close(); }
}
console.log('harvest read-token tests passed (' + passed + ' assertions)');
