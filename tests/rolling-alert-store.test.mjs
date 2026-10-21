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
const { TARGET, NOW, makeDriver, fleet } = await import('./fixtures/rolling-alert-fixtures.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rolling-alert-test-'));
const file = path.join(dir, 'latest.json');
const clock = () => NOW;

const mk = (drivers, importedAt = '2026-10-21T01:00:00Z') =>
  AC.buildSnapshot(drivers, { targetDate: TARGET, dataImportedAt: importedAt, computedAt: importedAt });
const snapA = mk(fleet());
const snapB = mk(fleet().slice(0, 3), '2026-10-21T02:00:00Z'); // 別のシフトデータ
const snapC = mk(fleet().slice(0, 2), '2026-10-21T02:00:00Z'); // さらに別の端末のデータ（同時刻）
assert.notEqual(snapA.inputFingerprint, snapB.inputFingerprint);

// ===== ストア =====
const store = createStore({ fs, filePath: file, now: clock });
assert.equal(store.load(), null, '未保存なら null');
let r = store.put(snapA, { baseRevision: null });
assert.equal(r.status, 'saved');
const rev1 = r.current.revision;
assert.ok(r.current.savedAt, 'サーバー保存日時を持つ');
assert.equal(store.put({ ...snapA, dataImportedAt: '2026-10-21T05:00:00Z' }, { baseRevision: null }).status, 'unchanged', '同一指紋の再投入は変更なし（base不一致でも競合にしない）');
assert.equal(store.get().revision, rev1, '再投入でリビジョンは変わらない');
assert.equal(store.get().snapshot.alerts.length, snapA.alerts.length, '再投入で対象者が増えない');

// 別端末が先に更新 → こちらは古いリビジョンのまま保存しようとして競合
r = store.put(snapB, { baseRevision: rev1 });
assert.equal(r.status, 'saved');
const rev2 = r.current.revision;
assert.notEqual(rev2, rev1);
r = store.put(snapC, { baseRevision: rev1 }); // 古い base（同時刻の別データ）
assert.equal(r.status, 'conflict', '古いリビジョンでは上書きしない');
assert.equal(store.get().inputFingerprint, undefined);
assert.equal(store.get().snapshot.inputFingerprint, snapB.inputFingerprint, '既存結果は壊れない');
assert.equal(store.put(snapC, { baseRevision: null }).status, 'conflict', 'base 未指定でも既存があれば競合');
r = store.put(snapC, { baseRevision: rev2 });
assert.equal(r.status, 'saved', '最新リビジョンを見ていれば保存できる');
r = store.put(snapA, { baseRevision: rev1, overwrite: true });
assert.equal(r.status, 'saved', '明示 overwrite のときだけ上書き');

// 不正データは既存結果を壊さない
const before = JSON.stringify(store.get());
['x', null, 42, [], { schemaVersion: 1 }, { ...snapA, computedAt: '2099-01-01T00:00:00Z' }, { ...snapA, targetDate: 'DROP TABLE' }].forEach((bad) => {
  assert.equal(store.put(bad, { overwrite: true }).status, 'invalid');
});
assert.equal(JSON.stringify(store.get()), before, '不正入力後も既存結果は同一');

// 書き込み失敗: メモリも元に戻る
const failingFs = { ...fs, existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync() { throw new Error('disk full'); }, renameSync: fs.renameSync };
const fstore = createStore({ fs: failingFs, filePath: path.join(dir, 'f.json'), now: clock });
assert.throws(() => fstore.put(snapA, {}), /disk full/);
assert.equal(fstore.get(), null, '保存失敗時は保存済み扱いにしない');

// 再起動後の復元（同じストアID・リビジョン）
const store2 = createStore({ fs, filePath: file, now: clock });
const restored = store2.load();
assert.equal(restored.revision, store.get().revision, '再読み込み後も同じリビジョンで復元');
assert.equal(restored.snapshot.inputFingerprint, snapA.inputFingerprint);

// 再デプロイ（ファイル消失）後: 新しいストアIDになり、古いリビジョンの端末が黙って上書きしない
fs.rmSync(file);
const store3 = createStore({ fs, filePath: file, now: clock });
assert.equal(store3.load(), null);
const first = store3.put(snapB, { baseRevision: restored.revision });
assert.equal(first.status, 'saved', 'サーバーが空なら（古いbaseでも）保存できる＝ブラウザ保存からの再保存');
assert.notEqual(first.current.revision.split('.')[0], restored.revision.split('.')[0], 'ストアIDが世代ごとに変わる');
assert.equal(store3.put(snapA, { baseRevision: restored.revision }).status, 'conflict', '旧世代のリビジョンは新世代に対して競合になる');

// 壊れたファイルは未保存扱い
fs.writeFileSync(file, '{broken', 'utf8');
assert.equal(createStore({ fs, filePath: file, now: clock }).load(), null);

// ===== ルート（認証・検証）=====
const TOKEN = 'test-token-not-a-real-secret';
function boot(getTokens, opts = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const st = createStore({ fs, filePath: path.join(dir, 'route-' + Math.random().toString(16).slice(2) + '.json'), now: clock });
  Route.mount(app, { store: st, getTokens, now: opts.now });
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, st, base: 'http://127.0.0.1:' + server.address().port })));
}
const call = (base, p, { method = 'GET', token, header = 'x-tenko-sync-token', body } = {}) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { [header]: token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// トークン未設定 → fail-closed(503)。データは出ない
let s = await boot(() => ['', undefined]);
let res = await call(s.base, '/rolling-alerts/latest', { token: TOKEN });
assert.equal(res.status, 503);
res = await call(s.base, '/rolling-alerts/save', { method: 'POST', token: TOKEN, body: { snapshot: snapA } });
assert.equal(res.status, 503);
assert.equal(s.st.get(), null, '未設定時は書き込まれない');
s.server.close();

s = await boot(() => [TOKEN]);
// 無認証/誤キーは 401 で、レスポンスに氏名等を含めない
s.st.put(snapA, {});
res = await call(s.base, '/rolling-alerts/latest');
assert.equal(res.status, 401);
assert.ok(!(await res.text()).includes('テスト'), '無認証レスポンスに氏名を含まない');
res = await call(s.base, '/rolling-alerts/latest', { token: 'wrong' });
assert.equal(res.status, 401);
res = await call(s.base, '/rolling-alerts/save', { method: 'POST', token: 'wrong', body: { snapshot: snapB, overwrite: true } });
assert.equal(res.status, 401);
assert.equal(s.st.get().snapshot.inputFingerprint, snapA.inputFingerprint, '無認証の書き込みで既存結果は変わらない');

// 正規キー（既存と同じヘッダー名 / 専用ヘッダー / Bearer）
for (const [header, value] of [['x-tenko-sync-token', TOKEN], ['x-rolling-alert-token', TOKEN], ['authorization', 'Bearer ' + TOKEN]]) {
  res = await call(s.base, '/rolling-alerts/latest', { token: value, header });
  assert.equal(res.status, 200, header);
}
res = await call(s.base, '/rolling-alerts/latest', { token: TOKEN });
const latest = await res.json();
assert.equal(latest.status, 'ok');
assert.ok(latest.revision && latest.savedAt);
assert.equal(res.headers.get('cache-control'), 'no-store');

// 保存: 競合・不正・サイズ
res = await call(s.base, '/rolling-alerts/save', { method: 'POST', token: TOKEN, body: { snapshot: snapB, baseRevision: 'stale.1' } });
assert.equal(res.status, 409);
assert.equal((await res.json()).snapshot.inputFingerprint, snapA.inputFingerprint, '競合応答は現在のサーバー結果');
res = await call(s.base, '/rolling-alerts/save', { method: 'POST', token: TOKEN, body: { snapshot: snapB, baseRevision: latest.revision } });
assert.equal(res.status, 200);
assert.equal((await res.json()).status, 'saved');
res = await call(s.base, '/rolling-alerts/save', { method: 'POST', token: TOKEN, body: { snapshot: { bad: 1 } } });
assert.equal(res.status, 400);
res = await call(s.base, '/rolling-alerts/save', { method: 'POST', token: TOKEN, body: [1, 2] });
assert.equal(res.status, 400);
res = await fetch(s.base + '/rolling-alerts/save', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-tenko-sync-token': TOKEN }, body: 'nope' });
assert.equal(res.status, 400, 'JSON以外は拒否');
res = await call(s.base, '/rolling-alerts/save', { method: 'POST', token: TOKEN, body: { snapshot: snapB, baseRevision: 'x'.repeat(100) } });
assert.equal(res.status, 400);
const huge = { snapshot: snapB, pad: 'x'.repeat(1600000) };
res = await call(s.base, '/rolling-alerts/save', { method: 'POST', token: TOKEN, body: huge });
assert.equal(res.status, 413);
assert.equal(s.st.get().snapshot.inputFingerprint, snapB.inputFingerprint, '不正リクエスト後も既存結果は無事');
s.server.close();

// 総当たり対策: 連続失敗で 429（正しいキーでも一定時間拒否）
let t = NOW;
s = await boot(() => [TOKEN], { now: () => t });
for (let i = 0; i < 20; i++) assert.equal((await call(s.base, '/rolling-alerts/latest', { token: 'bad' + i })).status, 401);
assert.equal((await call(s.base, '/rolling-alerts/latest', { token: 'bad' })).status, 429);
assert.equal((await call(s.base, '/rolling-alerts/latest', { token: TOKEN })).status, 429);
t += 11 * 60 * 1000;
assert.equal((await call(s.base, '/rolling-alerts/latest', { token: TOKEN })).status, 200, '時間経過で解除');
s.server.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log('rolling-alert-store.test.mjs: ALL TESTS PASSED');
