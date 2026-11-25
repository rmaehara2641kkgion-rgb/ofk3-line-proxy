// SEC-04 静的ファイル公開ポリシーのテスト。実際のExpressミドルウェア経由のHTTPテスト。
// 合成データのみ（一時ディレクトリ）。外部通信・実業務データ・LINE送信は行わない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const express = require('express');
const Policy = require('../static-public-policy.js');
const AdminSession = require('../admin-session.js');
const ApiGuard = require('../api-guard.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.equal(a, b, msg); passed++; }

// ---------- HTTPヘルパー（パスを一切正規化しない生のリクエスト）
function request(port, method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

// ======================================================================
// A. 独立したテスト用Expressアプリ + 合成ルート（許可リストの挙動）
// ======================================================================
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec04-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sec04-outside-'));
const W = (rel, data) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const SECRET = 'SYNTHETIC-SECRET-DO-NOT-SERVE';
W('app.js', 'console.log("app");');
W('style.css', 'body{color:#000}');
W('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
W('video.mp4', Buffer.alloc(2048, 7));
W('vendor/lib.min.js', 'var lib=1;');
W('page.html', '<html>page</html>');
W('server.js', 'const token="' + SECRET + '";');
W('docs/spec.md', SECRET);
W('tests/data.csv', SECRET);
W('local/queue.json', '{"s":"' + SECRET + '"}');
W('.env', 'TOKEN=' + SECRET);
W('node_modules/x/index.js', SECRET);
W('gas/code.gs', SECRET);
W('extra.js', SECRET);               // 許可リストに無い .js（拡張子単位の許可が無いことの確認）
W('assets/other.png', SECRET);       // 許可リストに無い画像（ディレクトリ単位の許可が無いことの確認）
fs.mkdirSync(path.join(tmp, 'dirasfile.js'));
fs.writeFileSync(path.join(outside, 'secret.js'), SECRET);

let symlinkOk = true;
try {
  fs.symlinkSync(path.join(tmp, 'server.js'), path.join(tmp, 'link.js'));          // 許可名 → 別の内部ファイル
  fs.symlinkSync(outside, path.join(tmp, 'linkdir'), 'dir');                        // 許可名のディレクトリ → ルート外
} catch (e) { symlinkOk = false; }

const FILES = ['app.js', 'style.css', 'logo.png', 'video.mp4', 'vendor/lib.min.js', 'page.html', 'missing.js', 'dirasfile.js', 'link.js', 'linkdir/secret.js'];
const appA = express();
appA.use(express.json());
appA.use(Policy.createStaticPublicPolicy({ root: tmp, files: FILES }));
appA.get('/api/ping', (req, res) => res.json({ status: 'ok' }));
appA.post('/app.js', (req, res) => res.status(201).send('post-handler'));
appA.get('/admin/login', (req, res) => res.send('login-page'));
appA.use((req, res) => res.status(404).send('not-found'));
const srvA = await listen(appA);
const pA = srvA.address().port;

// A1. 許可ファイルの取得（GET）
for (const [url, type, content] of [
  ['/app.js', /javascript/, 'console.log("app");'],
  ['/style.css', /text\/css/, 'body{color:#000}'],
  ['/logo.png', /image\/png/, null],
  ['/video.mp4', /video\/mp4/, null],
  ['/vendor/lib.min.js', /javascript/, 'var lib=1;'],
  ['/page.html', /text\/html/, '<html>page</html>'],
]) {
  const r = await request(pA, 'GET', url);
  eq(r.status, 200, 'GET ' + url);
  ok(type.test(r.headers['content-type'] || ''), 'content-type ' + url + ' ' + r.headers['content-type']);
  if (content) eq(r.body.toString(), content, 'body ' + url);
}
// A2. HEAD
{
  const r = await request(pA, 'HEAD', '/app.js');
  eq(r.status, 200, 'HEAD 200'); eq(r.body.length, 0, 'HEAD ボディなし');
  eq(Number(r.headers['content-length']), 'console.log("app");'.length, 'HEAD content-length');
  eq((await request(pA, 'HEAD', '/server.js')).status, 404, 'HEAD 未許可は404');
}
// A3. クエリ文字列（キャッシュバスター）
for (const q of ['/app.js?v=20261025-1', '/style.css?v=1&x=%2e%2e%2fserver.js', '/vendor/lib.min.js?']) {
  eq((await request(pA, 'GET', q)).status, 200, 'クエリ付き ' + q);
}
// A4. 範囲リクエスト（動画再生）
{
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: pA, method: 'GET', path: '/video.mp4', headers: { Range: 'bytes=0-9' } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, len: Buffer.concat(c).length }));
    }); req.on('error', reject); req.end();
  });
  eq(r.status, 206, 'Range 206'); eq(r.len, 10, 'Range 10バイト');
}
// A5. 未許可ファイル（サーバーソース・仕様書・テストデータ・内部JSON・環境変数・node_modules・GAS等）
for (const u of ['/server.js', '/docs/spec.md', '/tests/data.csv', '/local/queue.json', '/.env', '/node_modules/x/index.js', '/gas/code.gs', '/extra.js', '/assets/other.png', '/', '/vendor/', '/vendor', '/docs/', '/index.html']) {
  const r = await request(pA, 'GET', u);
  eq(r.status, 404, '未許可は404 ' + u);
  ok(!r.body.toString().includes(SECRET), '内容が漏れない ' + u);
  eq(r.body.toString(), 'not-found', '後続の404ハンドラへ渡る ' + u);
}
// A6. パストラバーサル・エンコード迂回・Windowsパス表現（すべて拒否＝秘密を返さない）
const ATTACKS = [
  '/../server.js', '/%2e%2e/server.js', '/%2E%2E/server.js', '/%2e%2e%2fserver.js', '/..%2fserver.js', '/vendor/../server.js',
  '/vendor/%2e%2e/server.js', '/app.js/../server.js', '/./app.js', '/vendor//lib.min.js', '//app.js',
  '/%252e%252e/server.js', '/%252e%252e%252fserver.js', '/app%252ejs', '/%2561pp.js%2500',
  '/app.js%00', '/app.js%00.png', '/%00/app.js', '/app.js%0a', '/app.js%0d%0a',
  '/..%5cserver.js', '/..\\server.js', '/vendor%5clib.min.js', '/vendor\\lib.min.js', '/%5c..%5cserver.js', '/%5Cserver.js',
  '/C:/server.js', '/C%3a/server.js', '/c:%5cserver.js', '/app.js::$DATA', '/app.js:stream', '/app.js%3a%3a%24DATA',
  '/app.js.', '/app.js%20', '/app.js%2e', '/vendor/lib.min.js.', '/SERVER.JS', '/APP.JS', '/App.js', '/VENDOR/lib.min.js',
  '/%c0%ae%c0%ae/server.js', '/%ef%bc%8e%ef%bc%8e/server.js', '/server.js%2f', '/server.js/', '/.env', '/%2eenv',
  '/' + 'a'.repeat(600) + '.js', '/%', '/%zz', '/%e3%81', // 不正なパーセントエンコード
];
for (const u of ATTACKS) {
  const r = await request(pA, 'GET', u);
  ok(r.status === 404 || r.status === 400, '攻撃パスは配信されない ' + JSON.stringify(u) + ' → ' + r.status);
  ok(!r.body.toString().includes(SECRET), '秘密が漏れない ' + JSON.stringify(u));
}
// 大文字小文字違いは別名（許可リストは完全一致）
eq((await request(pA, 'GET', '/APP.JS')).status, 404, '大文字小文字違いは拒否');
// 1回だけのパーセントエンコードによる許可ファイル自体へのアクセスは許可ファイルを返すだけ（別ファイルには到達しない）
eq((await request(pA, 'GET', '/%61pp.js')).body.toString(), 'console.log("app");', '許可ファイルの単純エンコードは同一ファイル');
// A7. GET/HEAD 以外は静的配信しない（既存ハンドラ/404へ）
eq((await request(pA, 'POST', '/app.js')).status, 201, 'POST は静的配信せず既存ハンドラへ');
eq((await request(pA, 'PUT', '/app.js')).status, 404, 'PUT は拒否');
eq((await request(pA, 'DELETE', '/style.css')).status, 404, 'DELETE は拒否');
eq((await request(pA, 'OPTIONS', '/app.js')).status, 404, 'OPTIONS は静的配信しない');
// A8. 許可リストにあっても存在しない/ディレクトリ/シンボリックリンクは安全に処理
eq((await request(pA, 'GET', '/missing.js')).status, 404, '存在しない許可ファイルは404(クラッシュしない)');
eq((await request(pA, 'GET', '/dirasfile.js')).status, 404, 'ディレクトリは配信しない');
if (symlinkOk) {
  const a = await request(pA, 'GET', '/link.js');
  eq(a.status, 404, '別の内部ファイルを指すシンボリックリンクは拒否');
  ok(!a.body.toString().includes(SECRET), 'リンク先の内容が漏れない');
  const b = await request(pA, 'GET', '/linkdir/secret.js');
  eq(b.status, 404, 'ルート外を指すディレクトリリンクは拒否');
  ok(!b.body.toString().includes(SECRET), 'ルート外の内容が漏れない');
} else {
  console.log('  (skip) この環境ではシンボリックリンクを作成できないため、リンク系テストをスキップ');
}
// A9. 既存ルートへ影響しない
eq((await request(pA, 'GET', '/api/ping')).status, 200, 'API ルート');
eq((await request(pA, 'GET', '/admin/login')).body.toString(), 'login-page', '管理者ログイン専用ルート');
// A10. 許可リスト定義の検証
for (const bad of ['../x.js', '/abs.js', 'a\\b.js', '*.js', 'a/../b.js', 'dir/*', 'a:b.js', '']) {
  assert.throws(() => Policy.createStaticPublicPolicy({ root: tmp, files: [bad] }), /invalid allowlist/, '不正な許可エントリを拒否: ' + bad); passed++;
}
// A11. normalizeRequestPath 単体
eq(Policy.normalizeRequestPath('/vendor/lib.min.js'), '/vendor/lib.min.js', '正常パス');
eq(Policy.normalizeRequestPath('/%61.js'), '/a.js', '単純エンコードのデコード');
for (const bad of ['/a/../b', '/a/%2e%2e/b', '/%252e', '/a\\b', '/a%5cb', '/a%00', '/C:/a', '/a/', '//a', '/a.', 'a', '', '/%zz', null, undefined, 5]) {
  eq(Policy.normalizeRequestPath(bad), null, '拒否: ' + JSON.stringify(bad));
}
srvA.close();

// ======================================================================
// B. 実リポジトリの許可リスト（実ファイルに対する検証）
// ======================================================================
const FILES_REAL = Policy.PUBLIC_FILES;
eq(new Set(FILES_REAL).size, FILES_REAL.length, '許可リストに重複なし');
const ALLOWED_EXT = new Set(['.js', '.css', '.png', '.mp4', '.html']);
const SERVER_SIDE = /^(render-webhook-server|admin-session|api-guard|harvest-local-server|inject-tenko-audit|static-public-policy|duty-risk-feed-route|duty-risk-gas-client|duty-risk-publication|duty-risk-republish|duty-risk-republish-route|harvest-rolling60h-route|harvest-rolling60h-history|rolling60h-archive-reader|rolling60h-dispatch-feed)\.js$/;
for (const f of FILES_REAL) {
  ok(fs.existsSync(path.join(REPO, f)), '許可ファイルが存在する ' + f);
  ok(ALLOWED_EXT.has(path.extname(f)), '許可拡張子 ' + f);
  ok(!/^(docs|tests|local|gas|node_modules|\.git|scripts|legacy|demo-app|cortex-capture-extension)\//.test(f), '内部ディレクトリを含まない ' + f);
  ok(!SERVER_SIDE.test(f), 'サーバー側ファイルを含まない ' + f);
  ok(!/[*?]/.test(f) && f.indexOf('\\') < 0, 'ワイルドカード/バックスラッシュなし ' + f);
  if (path.extname(f) === '.html') eq(f, 'route-map.html', 'HTMLは route-map.html のみ');
}
ok(FILES_REAL.includes('vendor/sheetjs/xlsx-0.20.3.full.min.js'), 'SheetJS 0.20.3 の自社配信を維持');
ok(!FILES_REAL.some((f) => /xlsx-0\.18/.test(f)), '旧SheetJSは含めない');
ok(FILES_REAL.includes('route-map.html'), 'route-map.html を維持');
ok(!FILES_REAL.includes('index.html'), 'index.html は注入ルートが配信（許可リストに含めない）');

// B1. 完全性: index.html のローカル依存、サーバー/起動スクリプトが注入するscriptタグは全て許可リストに含まれる
{
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const srv = fs.readFileSync(path.join(REPO, 'render-webhook-server.js'), 'utf8') + fs.readFileSync(path.join(REPO, 'inject-tenko-audit.js'), 'utf8');
  const need = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\/?[A-Za-z0-9_./-]+\.(?:js|css|png|mp4|gif|ico|svg|html))(?:\?[^"]*)?"/g)) need.add(m[1].replace(/^\//, ''));
  for (const m of srv.matchAll(/'\/([a-z0-9-]+\.js)\?v=/g)) need.add(m[1]);
  for (const m of srv.matchAll(/src=\\?"\/([A-Za-z0-9_./-]+\.js)/g)) need.add(m[1]);
  ok(need.size >= 55, '依存ファイル抽出数 ' + need.size);
  const missing = [...need].filter((f) => !FILES_REAL.includes(f));
  eq(missing.join(','), '', '依存ファイルが許可リストに無い: ' + missing.join(','));
}

// B2. 実リポジトリを使ったHTTP: 管理者ログイン(実モジュール)・API Guard(実モジュール)と同じ並びで組み込む
const adminAuth = AdminSession.createAdminAuth({ express, env: { ADMIN_PASSWORD_HASH: '', ADMIN_SESSION_SECRET: '', NODE_ENV: 'test' } });
const guard = ApiGuard.createApiGuard({ adminAuth, env: { API_GUARD_MODE: '', API_GUARD_ENFORCE: '', PROXY_SECRET: '', INGEST_TOKEN: '', CORTEX_READ_TOKEN: '' }, log() {} });
const appB = express();
appB.use(express.json());
appB.use(adminAuth.router);
appB.use(guard.middleware);
appB.get(['/', '/index.html'], (req, res) => res.type('html').send('<html>index-route</html>'));
appB.use(Policy.createStaticPublicPolicy({ root: REPO }));
appB.get('/api/status', (req, res) => res.json({ status: 'ok' }));
appB.use((req, res) => res.status(404).send('not-found'));
const srvB = await listen(appB);
const pB = srvB.address().port;

for (const f of FILES_REAL) {
  const r = await request(pB, 'GET', '/' + f.split('/').map(encodeURIComponent).join('/') + '?v=20261125-1');
  eq(r.status, 200, '許可ファイル取得 ' + f);
  eq(r.body.length, fs.statSync(path.join(REPO, f)).size, 'サイズ一致 ' + f);
}
{
  const sheet = await request(pB, 'GET', '/vendor/sheetjs/xlsx-0.20.3.full.min.js');
  ok(sheet.status === 200 && /javascript/.test(sheet.headers['content-type']) && sheet.body.toString('utf8').includes('"0.20.3"'), 'SheetJS 0.20.3 の取得');
  const rm = await request(pB, 'GET', '/route-map.html?route=DCX1&id=abc');
  ok(rm.status === 200 && /text\/html/.test(rm.headers['content-type']), 'route-map.html の取得');
  eq((await request(pB, 'HEAD', '/ofk3-ops-console.css')).status, 200, 'CSS HEAD');
  ok(/video\/mp4/.test((await request(pB, 'HEAD', '/ofk3-splash.mp4')).headers['content-type']), '動画の content-type');
}
// 管理者ログイン専用ルート・既存API・index注入ルートは影響を受けない
eq((await request(pB, 'GET', '/admin/login')).status, 200, '/admin/login');
ok(/javascript/.test((await request(pB, 'GET', '/admin/login.js')).headers['content-type']), '/admin/login.js');
eq(JSON.parse((await request(pB, 'GET', '/admin/session')).body.toString()).status, 'ok', '/admin/session');
eq((await request(pB, 'GET', '/api/status')).status, 200, '既存APIルート');
eq((await request(pB, 'GET', '/')).body.toString(), '<html>index-route</html>', 'ルートは index 注入ルート');
eq((await request(pB, 'GET', '/index.html?v=1')).body.toString(), '<html>index-route</html>', '/index.html も注入ルート');

// 原則非公開: リポジトリ内の許可リスト外のファイルはすべて 404（node_modules/.git を除く全ファイルを走査）
{
  const all = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else all.push(path.relative(REPO, p).split(path.sep).join('/'));
    }
  })(REPO);
  const denied = all.filter((f) => !FILES_REAL.includes(f) && f !== 'index.html');
  ok(denied.length > 100, '非公開対象ファイル数 ' + denied.length);
  let leaked = 0;
  for (const f of denied) {
    const r = await request(pB, 'GET', '/' + f.split('/').map(encodeURIComponent).join('/'));
    if (r.status !== 404) leaked++;
  }
  eq(leaked, 0, '許可リスト外は全て404');
  for (const f of ['render-webhook-server.js', 'admin-session.js', 'api-guard.js', 'harvest-local-server.js', 'inject-tenko-audit.js', 'static-public-policy.js',
    'package.json', 'package-lock.json', 'render.yaml', 'README.md', 'PROJECT_OVERVIEW.md', '.gitignore', '.gitattributes',
    'docs/STATIC_PUBLIC_POLICY.md', 'docs/API_PROTECTION.md', 'tests/static-public-policy.test.mjs', 'gas/addr-master.gs', 'gas-proxy-code-token.gs',
    'cortex-capture-extension/manifest.json', 'demo-app/server.js', 'demo-app/index.html', 'manual.html', 'presentation-short.html', 'index.html',
    'vendor/sheetjs/LICENSE', 'local/duty-risk-publish-queue.json', 'node_modules/express/package.json', '.git/config', '.git/HEAD', '.env', '.env.local']) {
    if (f === 'index.html') continue; // index.html は注入ルートが配信する（静的ポリシーは配信しない）
    eq((await request(pB, 'GET', '/' + f)).status, 404, '非公開 ' + f);
  }
  // 実リポジトリに対するトラバーサル/エンコード迂回
  for (const u of ['/../package.json', '/%2e%2e/package.json', '/%252e%252e/package.json', '/vendor/sheetjs/../../package.json', '/vendor%5csheetjs%5cxlsx-0.20.3.full.min.js',
    '/..%5crender-webhook-server.js', '/render-webhook-server.js%00.png', '/logo.png%00.js', '/C:/Windows/win.ini', '/assets/../render-webhook-server.js']) {
    const r = await request(pB, 'GET', u);
    ok(r.status !== 200 || r.body.toString().indexOf('createStaticPublicPolicy') < 0, '実リポジトリへの迂回拒否 ' + u);
    ok(r.body.toString().indexOf('require(') < 0 && r.body.toString().indexOf('"name": "ofk3-line-proxy"') < 0, '内部ファイルの内容が出ない ' + u);
  }
}
srvB.close();

// ======================================================================
// C. 実サーバー(render-webhook-server.js)の配線: express.static(ルート全体)が残っていない + 起動してHTTP確認
// ======================================================================
{
  const src = fs.readFileSync(path.join(REPO, 'render-webhook-server.js'), 'utf8');
  ok(!/express\.static\s*\(/.test(src), 'render-webhook-server.js にルート全体の express.static が無い');
  ok(src.includes("require('./static-public-policy.js').createStaticPublicPolicy({ root: __dirname })"), 'ポリシーを組み込み');
  for (const f of ['harvest-local-server.js', 'demo-app/server.js', 'admin-session.js', 'api-guard.js']) {
    const s = fs.readFileSync(path.join(REPO, f), 'utf8');
    ok(!/express\.static\s*\(\s*(path\.join\(__dirname\)|__dirname|path\.resolve\(__dirname\))\s*\)/.test(s) || f === 'demo-app/server.js', 'ルート全体公開のコードが他に無い ' + f);
  }
  // 起動テスト（ローカルのみ。外部通信なし。トークン等の環境変数は渡さない）
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const env = { PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'test', HOME: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const child = spawn(process.execPath, ['render-webhook-server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false;
  child.stdout.on('data', (d) => { if (String(d).includes('Server running')) started = true; });
  try {
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 100));
    ok(started, '実サーバーが起動');
    const home = await request(port, 'GET', '/');
    ok(home.status === 200 && home.body.toString().includes('/ofk3-time-window-board.js') && home.body.toString().includes('/vendor/sheetjs/xlsx-0.20.3.full.min.js'), '実サーバー: index.html 注入ルート');
    for (const u of ['/ofk3-cortex-priority-ui.js?v=1', '/ofk3-time-window-board.js', '/ofk3-inoichi-ui.js', '/harvest-core.js', '/tenko-transport-audit.js', '/vendor/sheetjs/xlsx-0.20.3.full.min.js', '/route-map.html', '/assets/gion-ofk3-logo.png', '/ofk3-splash.mp4', '/ofk3-ops-console.css', '/nearby-course-core.js']) {
      eq((await request(port, 'GET', u)).status, 200, '実サーバー: ' + u);
    }
    for (const u of ['/render-webhook-server.js', '/admin-session.js', '/package.json', '/docs/API_PROTECTION.md', '/tests/api-guard.test.mjs', '/gas/addr-master.gs', '/render.yaml', '/.git/config', '/node_modules/express/package.json', '/manual.html', '/demo-app/server.js', '/../package.json', '/%2e%2e/package.json']) {
      const r = await request(port, 'GET', u);
      ok(r.status !== 200 && !r.body.toString().includes('require('), '実サーバー: 非公開 ' + u + ' → ' + r.status);
    }
    eq((await request(port, 'GET', '/admin/login')).status, 200, '実サーバー: /admin/login');
    ok(/javascript/.test((await request(port, 'GET', '/admin/login.js')).headers['content-type']), '実サーバー: /admin/login.js');
    eq((await request(port, 'GET', '/api/status')).status, 200, '実サーバー: 既存API');
    eq((await request(port, 'GET', '/tenko-sync')).status === 503 || (await request(port, 'GET', '/tenko-sync')).status === 401, true, '実サーバー: 既存の認証(fail-closed)が維持される');
  } finally {
    child.kill();
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log('static-public-policy.test.mjs: ' + passed + ' assertions passed');
