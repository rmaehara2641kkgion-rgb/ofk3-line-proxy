// reportモードの安全性: 同じ環境で API_GUARD_MODE の有無だけを変えた2台に同一リクエスト列を送り、応答が一致することを確認する。
// 外部通信なし(GAS・LINE未設定)、フェイク値のみ。HARVESTは変更せず、実際の中継経路(createServer)で読み取りを検証。
import { spawn } from 'child_process';
import assert from 'assert';
import net from 'net';
import http from 'http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Harvest = require('../harvest-local-server.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; }; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const PS = 'rm-proxy-secret-xyz', TS = 'rm-tenko-token-xyz', IT = 'rm-ingest-xyz';
const children = new Set(); process.on('exit', () => children.forEach(c => { try { c.kill(); } catch {} }));
const freePort = () => new Promise(r => { const x = net.createServer().listen(0, () => { const p = x.address().port; x.close(() => r(p)); }); });
async function start(env) {
  const port = await freePort();
  const p = spawn('node', ['render-webhook-server.js'], { env: { PATH: process.env.PATH, PORT: String(port), PROXY_SECRET: PS, TENKO_SYNC_TOKEN: TS, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  return { port, base: `http://127.0.0.1:${port}`, log: () => out, stop: () => new Promise(r => { p.once('exit', r); p.kill(); }) };
}
const norm = (t) => t.replace(/"(serverTime|time|receivedAt|updatedAt|date)":"[^"]*"/g, '"$1":"T"').replace(/"uptime":[0-9.]+/g, '"uptime":0').replace(/"(timestamp|serverSeq|serverInstanceId)":("[^"]*"|[0-9]+)/g, '"$1":"V"').replace(/"id":"[A-Za-z0-9_-]{20,}"/g, '"id":"ID"').replace(/[0-9a-f]{24}/g, 'HEX');
const IMPORT = { localDate: '2026-11-02', packages: [{ routeCode: 'DCX-1', stop: 1, trackingId: 'T1' }], routeStops: [{ routeCode: 'DCX-1', sequenceNumber: 1, latitude: 33.5, longitude: 130.4, address: 'dummy' }] };
// [method, path, body, headers]
const SEQ = [
  ['GET', '/ping'], ['GET', '/api/status'], ['GET', '/cortex-priority'],
  ['POST', '/cortex-priority/import', IMPORT], ['POST', '/cortex-priority/import', IMPORT, { 'x-ofk3-ingest-token': IT }],
  ['GET', '/cortex-priority?localDate=2026-11-02'], ['GET', '/cortex-priority?localDate=2026-11-02', null, { 'x-proxy-secret': PS }],
  ['POST', '/route-data', { points: [{ lat: 1, lng: 2 }] }], ['POST', '/map-image', { data: 'x' }], ['POST', '/pdf-upload', {}],
  ['GET', '/volume-master?action=list'], ['POST', '/volume-master?action=save', {}], ['GET', '/addr-master?action=lookup'], ['GET', '/tenko-master?action=getMaster'], ['POST', '/tenko-master', { x: 1 }], ['GET', '/area-experience-master?action=get'],
  ['POST', '/proxy', { to: 'Ux', messages: [{ type: 'text', text: 't' }] }], ['POST', '/proxy', { to: 'Ux', messages: [{ type: 'text', text: 't' }] }, { 'x-proxy-secret': PS }], ['GET', '/proxy?action=getProfile&userId=Ux'],
  ['POST', '/mentor-alert', { disappeared: [] }], ['GET', '/mentor-notified'], ['POST', '/mentor-notified', {}],
  ['GET', '/line-unlinked'], ['GET', '/line-unlinked', null, { 'x-proxy-secret': PS }], ['POST', '/line-unlinked/known', { mapping: {} }, { 'x-proxy-secret': PS }],
  ['POST', '/tenko-sync', {}], ['GET', '/tenko-sync'], ['POST', '/tenko-sync', { schedule: [] }, { authorization: 'Bearer ' + TS }],
  ['POST', '/lat-export', {}], ['POST', '/dnr-export', {}], ['POST', '/twc-export', {}], ['POST', '/cc-export', {}], ['POST', '/ftds-export', {}], ['POST', '/encrypt-zip', {}],
  ['GET', '/wh60/status'], ['POST', '/wh60/save', {}], ['POST', '/webhook', { events: [] }], ['GET', '/line-notifications/status'], ['POST', '/line-notifications/toggle', { enabled: false }], ['POST', '/line-notifications/toggle', { enabled: false }, { 'x-proxy-secret': PS }],
  ['GET', '/'], ['GET', '/route-map.html']
];
async function run(s) {
  const out = [];
  for (const [m, u, b, h] of SEQ) {
    const r = await fetch(s.base + u, { method: m, headers: { 'content-type': 'application/json', ...(h || {}) }, body: b == null ? undefined : JSON.stringify(b) });
    const t = await r.text(); out.push([m + ' ' + u, r.status, r.headers.get('content-type'), (u === '/' || u.endsWith('.html')) ? t.length : norm(t)]);
  }
  return out;
}
const off = await start({}), rep = await start({ API_GUARD_MODE: 'report', INGEST_TOKEN: IT });
try {
  const a = await run(off), b = await run(rep);
  a.forEach((row, i) => eq(b[i], row, 'reportモードでも応答不変: ' + row[0]));

  // 集計の確認 (遮断はしていない)
  const r = await (await fetch(rep.base + '/admin/api-guard-report', { headers: { 'x-proxy-secret': PS } })).json();
  eq(r.mode, 'report'); eq(r.enforced, []);
  ok(r.groups['cortex-read'].anonymous >= 1 && r.groups['cortex-read'].proxySecret >= 1, 'cortex-readの資格別集計'); ok(r.groups['cortex-ingest'].ingestToken === 1 && r.groups['cortex-ingest'].anonymous === 1, '拡張機能(取込トークン有無)の集計');
  ok(r.groups['cortex-read'].wouldDeny >= 1, '強制時に拒否される件数が見える');
  ok(!JSON.stringify(r).match(/127\.0\.0\.1|Ux|dummy|T1|DCX/), 'レポートに個人情報・IP・本文なし');

  // ログに秘密値・個人情報なし
  const lg = rep.log(); for (const v of [PS, TS, IT]) ok(!lg.includes(v), 'reportモードのログに秘密値なし'); ok(!lg.includes('dummy') && !lg.includes('"Ux"'), 'ログに本文・宛先なし');

  // HARVEST読み取り: 実際の中継 (HARVEST側は無変更・資格なし) — off/report とも取得できる
  const viaHarvest = async (s) => {
    const hs = Harvest.createServer({ port: 0, env: { HARVEST_UPSTREAM_BASE_URL: s.base } });
    await new Promise(r => hs.listen(0, '127.0.0.1', r)); const hp = hs.address().port;
    const res = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: hp, path: '/cortex-priority?localDate=2026-11-02', headers: { host: '127.0.0.1:' + hp } }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => resolve({ status: x.statusCode, body: d })); }).on('error', reject));
    await new Promise(r => hs.close(r)); return res;
  };
  const ha = await viaHarvest(off), hb = await viaHarvest(rep);
  eq(ha.status, 200, 'HARVEST中継(off)'); eq(hb.status, 200, 'HARVEST中継(report)'); eq(JSON.parse(hb.body).stopCount, JSON.parse(ha.body).stopCount, 'HARVESTの読み取り内容不変');

  // 参考(強制すると何が壊れるか): cortex-read 強制時、資格を持たない既存HARVEST中継は 502 になる = 強制前に読取トークン対応が必須
  const enf = await start({ API_GUARD_ENFORCE: 'cortex-read' }); await fetch(enf.base + '/cortex-priority/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(IMPORT) });
  const hc = await viaHarvest(enf); ok(hc.status !== 200, 'cortex-read強制時は現行HARVEST中継が読めなくなる(強制の前提条件として記録)'); await enf.stop();
} finally { await off.stop(); await rep.stop(); }
console.log('api-guard report-mode tests passed (' + n + ' assertions)');
