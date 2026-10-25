import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = /function tenkoSyncStateFor503\(xhr\) \{[\s\S]*?\n    \}/.exec(html);
assert.ok(m, 'helper exists');
const fn = new Function(m[0] + '; return tenkoSyncStateFor503;')();

// このアプリの「未設定」503だけを設定未完了と表示する
assert.equal(fn({ responseText: JSON.stringify({ status: 'error', message: 'sync not configured' }) }), 'server-not-configured');
// Render起動中のHTML 503・空本文・壊れたJSONは一時的な利用不可
assert.equal(fn({ responseText: '<html>Service Unavailable</html>' }), 'server-unavailable');
assert.equal(fn({ responseText: '' }), 'server-unavailable');
assert.equal(fn({}), 'server-unavailable');
assert.equal(fn({ responseText: 'null' }), 'server-unavailable');

// 503の分岐はすべてこの判別を通る（直接 server-not-configured にしない）
assert.equal((html.match(/tenkoSyncStateFor503\(xhr\)/g) || []).length, 5, '定義1 + 呼び出し4');
const direct = html.split('\n').filter((l) => l.includes('status === 503') && l.includes("'server-not-configured'"));
assert.equal(direct.length, 0);
assert.ok(html.includes("'server-unavailable': ['🟡"));

// サーバー側: 未設定は503 'sync not configured'、不一致は401（認証は無効化されていない）
const src = fs.readFileSync(new URL('../render-webhook-server.js', import.meta.url), 'utf8');
assert.ok(/if \(!TENKO_SYNC_TOKEN\) \{\s*res\.status\(503\)\.json\(\{ status: 'error', message: 'sync not configured' \}\)/.test(src));
assert.ok(/providedToken !== TENKO_SYNC_TOKEN\) \{\s*res\.status\(401\)/.test(src));

console.log('tenko-sync-503.test.mjs: ALL PASSED');
