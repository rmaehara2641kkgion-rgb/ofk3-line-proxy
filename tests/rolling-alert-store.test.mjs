import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const express = require('express');
const AC = require('../rolling-alert-core.js');
const { createStore } = require('../rolling-alert-store.js');
const Route = require('../rolling-alert-route.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rolling-alert-test-'));
const file = path.join(dir, 'latest.json');

function alertRow(key) {
  return { driverKey: key, name: key, alertClass: 'approach', label: '接近警告' };
}
function snap({ imported, fp = 'fp1', keys = ['A', 'B'], target = '2026-10-21' }) {
  return {
    schemaVersion: AC.SCHEMA_VERSION, ruleVersion: AC.RULE_VERSION, targetDate: target,
    dataImportedAt: imported, computedAt: imported, inputFingerprint: fp,
    counts: { alertCount: keys.length, driverCount: keys.length },
    alerts: keys.map(alertRow),
  };
}

// --- ストア ---
const store = createStore({ fs, filePath: file });
assert.equal(store.load(), null, '未保存なら null');
assert.equal(store.put(snap({ imported: '2026-10-21T01:00:00Z' })).status, 'saved');
assert.equal(store.put(snap({ imported: '2026-10-21T02:00:00Z' })).status, 'unchanged', '同一指紋の再投入は変更なし');
assert.equal(store.get().alerts.length, 2, '再投入で対象者が増えない');
assert.equal(store.get().dataImportedAt, '2026-10-21T02:00:00Z', '取り込み時刻だけ更新');
assert.equal(store.put(snap({ imported: '2026-10-21T03:00:00Z', fp: 'fp2', keys: ['A'] })).status, 'saved');
assert.equal(store.get().alerts.length, 1, '更新後は置換される（追記しない）');
assert.equal(store.put(snap({ imported: '2026-10-21T01:30:00Z', fp: 'fp3', keys: ['X', 'Y', 'Z'] })).status, 'stale-rejected', '古い取り込みは新しい結果を上書きしない');
assert.equal(store.get().inputFingerprint, 'fp2');
assert.equal(store.put({ nope: true }).status, 'invalid');

// 再起動（プロセス再生成）後の復元
const store2 = createStore({ fs, filePath: file });
assert.equal(store2.load().inputFingerprint, 'fp2', '再読み込み後も保存済みの最新結果を復元');

// 壊れたファイルは未保存扱い
fs.writeFileSync(file, '{broken', 'utf8');
assert.equal(createStore({ fs, filePath: file }).load(), null);

// --- ルート ---
const app = express();
app.use(express.json({ limit: '10mb' }));
const routeStore = createStore({ fs, filePath: path.join(dir, 'route.json') });
Route.mount(app, { store: routeStore });
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const post = (body) => fetch(base + '/rolling-alerts/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let res = await fetch(base + '/rolling-alerts/latest');
assert.deepEqual(await res.json(), { status: 'empty' });
res = await post({ snapshot: snap({ imported: '2026-10-21T01:00:00Z' }) });
assert.equal(res.status, 200);
assert.equal((await res.json()).status, 'saved');
res = await post({ snapshot: snap({ imported: '2026-10-21T01:10:00Z' }) });
assert.equal((await res.json()).status, 'unchanged');
res = await fetch(base + '/rolling-alerts/latest');
const latest = await res.json();
assert.equal(latest.status, 'ok');
assert.equal(latest.snapshot.alerts.length, 2);
assert.equal(res.headers.get('cache-control'), 'no-store');
res = await post({ snapshot: { bad: 1 } });
assert.equal(res.status, 400);
res = await post({ snapshot: snap({ imported: '2026-10-20T00:00:00Z', fp: 'old' }) });
assert.equal(res.status, 409);
assert.equal((await res.json()).status, 'stale-rejected');

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('rolling-alert-store.test.mjs: ALL TESTS PASSED');
