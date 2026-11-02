// 結合テスト (任意実行): OFK3 PR #78 の実サーバー (api-guard) に対して HARVEST の中継が取得できることを確認する。
// OFK3_GUARD_DIR=<PR #78 のチェックアウトのパス> を指定したときだけ動く。無ければSKIP。ローカルのみ・フェイクのトークン・フェイクのデータ。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.OFK3_GUARD_DIR;
if (!dir || !existsSync(join(dir, 'api-guard.js')) || !existsSync(join(dir, 'render-webhook-server.js'))) {
  console.log('harvest read-token OFK3-guard integration SKIPPED (OFK3_GUARD_DIR に PR #78 のチェックアウトを指定してください)'); process.exit(0);
}
const L = require(join(root, 'harvest-local-server.js'));
let passed = 0;
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); passed += 1; };
const eq = (a, b, m) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error('FAIL: ' + m + '\n  actual:   ' + x + '\n  expected: ' + y); passed += 1; };

const TOKEN = 'fake-read-token-0123456789abcdef', PS = 'fake-proxy-secret-value', INGEST = 'fake-ingest-token-value-xyz';
const children = new Set(); process.on('exit', () => children.forEach(c => { try { c.kill(); } catch {} }));
const free = () => new Promise(r => { const x = net.createServer().listen(0, () => { const p = x.address().port; x.close(() => r(p)); }); });
async function ofk3(env) {
  const port = await free();
  const p = spawn('node', ['render-webhook-server.js'], { cwd: dir, env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const origin = `http://127.0.0.1:${port}`;
  // フェイクの当日データを投入 (cortex-ingest は強制対象外なので資格不要)
  await fetch(origin + '/cortex-priority/import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ofk3-ingest-token': INGEST, 'x-proxy-secret': PS }, body: JSON.stringify({ localDate: '2026-11-02', packages: [{ routeCode: 'DCX-1', stop: 1, trackingId: 'T1' }], routeStops: [{ routeCode: 'DCX-1', sequenceNumber: 1, latitude: 33.5, longitude: 130.4, address: 'dummy' }] }) });
  return { origin, port, log: () => out, stop: () => new Promise(r => { p.once('exit', r); p.kill(); }) };
}
async function viaHarvest(origin, token) {
  const env = { HARVEST_UPSTREAM_BASE_URL: origin }; if (token) env.HARVEST_UPSTREAM_READ_TOKEN = token;
  const hs = L.createServer({ port: 0, env }); await new Promise(r => hs.listen(0, '127.0.0.1', r)); const hp = hs.address().port;
  const res = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: hp, path: '/cortex-priority?localDate=2026-11-02', headers: { host: '127.0.0.1:' + hp } }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => resolve({ status: x.statusCode, text: d, json: JSON.parse(d) })); }).on('error', reject));
  await new Promise(r => hs.close(r)); return res;
}

// A. cortex-read 強制 + 読取トークン設定済みのOFK3
{ const o = await ofk3({ API_GUARD_ENFORCE: 'cortex-read,cortex-ingest,masters,share-write,line-send', CORTEX_READ_TOKEN: TOKEN, PROXY_SECRET: PS, INGEST_TOKEN: INGEST });
  try {
    const ok = await viaHarvest(o.origin, TOKEN); eq([ok.status, ok.json.status, ok.json.stopCount], [200, 'ok', 1], 'OFK3 #78 と同じBearer方式で取得成功');
    assert(!ok.text.includes(TOKEN), '応答にトークンなし');
    const none = await viaHarvest(o.origin, null); eq([none.status, none.json.reason, none.json.upstreamStatus], [502, 'upstream-auth-required', 401], '未設定は401と分類');
    const bad = await viaHarvest(o.origin, TOKEN.replace('0123', '9999')); eq([bad.status, bad.json.reason], [502, 'upstream-token-rejected'], '不正トークンは拒否');
    assert(!bad.text.includes('9999'), '応答に不正トークンの値なし');
    // 用途制限はOFK3側で維持されている (読取トークンでは他APIは使えない)
    const hdr = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
    eq((await fetch(o.origin + '/cortex-priority?localDate=2026-11-02', { headers: hdr })).status, 200, '読取トークンで /cortex-priority は読める');
    for (const [m, u] of [['POST', '/cortex-priority/import'], ['GET', '/volume-master'], ['GET', '/tenko-master'], ['POST', '/route-data'], ['POST', '/proxy']]) {
      const r = await fetch(o.origin + u, { method: m, headers: hdr, body: m === 'POST' ? '{}' : undefined });
      eq(r.status, 401, '読取トークンでは他の保護APIを使えない(用途制限はOFK3側): ' + m + ' ' + u);
    }
    await new Promise(r => setTimeout(r, 200)); assert(!o.log().includes(TOKEN), 'OFK3ログにトークンなし');
  } finally { await o.stop(); } }

// B. OFK3 が認証を強制していない (切替前): トークンの有無によらず取得できる
{ const o = await ofk3({ PROXY_SECRET: PS });
  try { eq((await viaHarvest(o.origin, TOKEN)).status, 200, '強制前+トークン設定でも取得可'); eq((await viaHarvest(o.origin, null)).status, 200, '強制前+トークン未設定=従来互換'); } finally { await o.stop(); } }

// C. 強制だが資格が1つも設定されていない: 503 を OFK3側の未設定と分類
{ const o = await ofk3({ API_GUARD_ENFORCE: 'cortex-read' });
  try { const r = await viaHarvest(o.origin, TOKEN); eq([r.status, r.json.reason, r.json.upstreamStatus], [502, 'upstream-auth-not-configured', 503], 'OFK3側未設定(503)を分類'); } finally { await o.stop(); } }
console.log('harvest read-token OFK3-guard integration passed (' + passed + ' assertions)');
