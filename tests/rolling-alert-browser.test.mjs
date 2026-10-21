/**
 * 実画面の統合テスト: 実際の index.html を、実サーバー(render-webhook-server.js)から配信して検証する。
 * シフトExcel投入 → 集計中 → アラート一覧 → 同一ファイル再投入 → 別ファイル更新 → 再読み込み復元
 * → 認証/APIエラー/競合/ブラウザ保存失敗/再デプロイ消失 → 既存Rolling 60h表の維持。
 * 外部CDNは遮断し、xlsx だけ node_modules から供給する。データは全て架空。
 * Playwright が無い環境では SKIP する（test:all には含めない）。
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean)) {
  try { chromium = require(spec).chromium; break; } catch (e) { /* next */ }
}
if (!chromium) { console.log('rolling-alert-browser.test.mjs: SKIPPED (playwright not found)'); process.exit(0); }

const XLSX = require('xlsx');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rolling-alert-e2e-'));
const TOKEN = 'e2e-fictional-token';
const TARGET = '2026-10-21';
const PAST = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];

// ---- 架空のシフト/実績Excel ----
const d = (iso) => { const [y, m, dd] = iso.split('-').map(Number); return new Date(y, m - 1, dd); };
const allDates = [];
for (let i = 8; i <= 25; i++) allDates.push('2026-10-' + String(i).padStart(2, '0'));
const DRIVERS = [
  ['TID001', '架空 確定'], ['TID002', '架空 予測'], ['TID003', '架空 接近'],
  ['TID004', '架空 当日休'], ['TID005', '架空 予定未確認'], ['TID006', '架空 通常'],
];
function sheetRows(todayBy, list = DRIVERS) {
  const rows = [['社名', '名前', 'Transport ID'].concat(allDates.map(d))];
  list.forEach(([tid, name]) => {
    const row = ['DSP', name, tid];
    allDates.forEach((iso) => row.push(iso === TARGET ? todayBy[tid] : iso < TARGET ? '○' : '休'));
    rows.push(row);
  });
  return rows;
}
function rosterBook(todayBy, sheets = ['GDS']) {
  const wb = XLSX.utils.book_new();
  sheets.forEach((nm) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows(todayBy)), nm));
  return wb;
}
function amazonBook(hoursBy) {
  const rows = [['transporter_id', 'working_day', 'estimated_working_hour', 'station_code']];
  Object.keys(hoursBy).forEach((tid) => PAST.forEach((day) => rows.push([tid, day, hoursBy[tid], 'OFK3'])));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Report5_Daily_Data');
  return wb;
}
const hoursBy = { TID001: 11, TID002: 9, TID003: 8.5, TID004: 8.5, TID005: 8.5, TID006: 5 };
const todayV1 = { TID001: '休', TID002: '○', TID003: '❽', TID004: '休', TID005: '', TID006: '❽' };
const f = (name) => path.join(work, name);
const write = (wb, name) => XLSX.writeFile(wb, f(name), { cellDates: true });
write(rosterBook(todayV1), 'roster-v1.xlsx');
write(rosterBook({ ...todayV1, TID002: '休' }), 'roster-v2.xlsx');
write(rosterBook({ ...todayV1, TID002: '休', TID003: '休', TID005: '休' }), 'roster-v3.xlsx');
write(rosterBook(todayV1, ['GDS', 'DSP2']), 'roster-dup.xlsx'); // 同じ人が複数DSPシートに載る
write(rosterBook({ TID001: '休', TID002: '休', TID003: '休', TID004: '休', TID005: '休', TID006: '❽' }), 'roster-none.xlsx');
write(amazonBook(hoursBy), 'amazon.xlsx');
write(amazonBook({ TID001: 5, TID002: 5, TID003: 5, TID004: 5, TID005: 5, TID006: 5 }), 'amazon-low.xlsx');

// ---- 実サーバー ----
const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = 'http://127.0.0.1:' + port;
let srv = null;
async function startServer() {
  srv = spawn('node', ['render-webhook-server.js'], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), TENKO_SYNC_TOKEN: TOKEN, TMPDIR: work, NODE_ENV: 'test', CHANNEL_ACCESS_TOKEN: '' },
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/ping')).ok) return; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!srv) return;
  const p = srv; srv = null;
  await new Promise((r) => { p.once('exit', r); p.kill(); });
}
await startServer();
const api = (p, token = TOKEN, init = {}) => fetch(base + p, { ...init, headers: { ...(token ? { 'X-Tenko-Sync-Token': token } : {}), ...(init.headers || {}) } });

// ---- ブラウザ ----
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const appErrors = [];
async function device(label, { token = TOKEN, failLocalStorage = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(({ token, failLocalStorage }) => {
    if (token) { try { localStorage.setItem('tenkoSyncToken', token); } catch (e) {} }
    if (failLocalStorage) {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (String(k).indexOf('ofk3.rollingAlerts') === 0) throw new Error('QuotaExceededError'); return orig.call(this, k, v); };
    }
  }, { token, failLocalStorage });
  await ctx.route((u) => !['127.0.0.1', 'localhost'].includes(u.hostname), (r) => {
    const req = r.request();
    if (req.url().includes('xlsx.full')) return r.fulfill({ path: path.join(root, 'node_modules/xlsx/dist/xlsx.full.min.js'), contentType: 'application/javascript' });
    return r.fulfill({ status: 200, body: '', contentType: req.resourceType() === 'stylesheet' ? 'text/css' : 'application/javascript' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { if (!/tailwind is not defined/.test(e.message)) appErrors.push(label + ': ' + e.message); });
  const dev = {
    ctx, page,
    state: () => page.locator('#rolling-alert-body [data-alert-state]').first().getAttribute('data-alert-state'),
    rows: () => page.locator('#rolling-alert-body tbody tr'),
    text: (sel = '#rolling-alert-body') => page.locator(sel).innerText(),
    meta: () => page.locator('#rolling-alert-meta').innerText(),
    async open() {
      await page.goto(base + '/', { waitUntil: 'load' });
      await page.evaluate(() => switchTab('wh60'));
      await page.waitForSelector('#rolling-alert-card');
      await page.fill('#rolling-reference-date', TARGET);
    },
    async upload(rosterFile, amazonFile) {
      await page.fill('#rolling-reference-date', TARGET);
      // ファイル読込は非同期。投入ごとに集計の世代番号(seq)が進むのを待ってから、集計・保存の完了を待つ
      for (const [sel, file] of [['#rolling-file-roster', rosterFile], ['#rolling-file-amazon', amazonFile]]) {
        if (!file) continue;
        const seq0 = await page.evaluate(() => RollingUI._alertState.seq);
        await page.setInputFiles(sel, f(file));
        await page.waitForFunction((x) => RollingUI._alertState.seq > x, seq0);
      }
      await dev.settled();
    },
    settled: () => page.waitForFunction(() => {
      const s = RollingUI._alertState;
      return s.phase !== 'computing' && s.saveState !== 'saving';
    }),
    clear: () => page.click('#rolling-btn-roster-reset'),
  };
  return dev;
}

let n = 0;
async function step(name, fn) { await fn(); n++; console.log('  ok - ' + name); }
let A, B, C, D, E;

try {
  A = await device('A');
  await A.open();

  await step('実index.html: Rolling 60hパネルとアラート一覧が表示され、未投入は「シフトデータ未投入」', async () => {
    assert.equal(await A.state(), 'no-data');
    assert.match(await A.text(), /シフトデータ未投入/);
    assert.equal(await A.page.locator('#rolling-grid-wrap').count(), 1, '既存のRolling表コンテナ');
  });

  await A.page.evaluate(() => {
    window.__seen = [];
    new MutationObserver(() => {
      const t = document.getElementById('rolling-alert-phase').innerText;
      if (t && window.__seen[window.__seen.length - 1] !== t) window.__seen.push(t);
    }).observe(document.getElementById('rolling-alert-phase'), { childList: true, subtree: true });
  });

  await step('初回投入: 集計中を経て一覧へ自動反映、サーバー保存済み、既存Rolling表も維持', async () => {
    await A.upload('roster-v1.xlsx', 'amazon.xlsx');
    assert.ok((await A.page.evaluate(() => window.__seen)).some((t) => t.includes('集計中')), '集計中を表示');
    assert.equal(await A.state(), 'list');
    const text = await A.text();
    ['架空 確定', '架空 予測', '架空 接近', '架空 予定未確認'].forEach((nm) => assert.ok(text.includes(nm), nm));
    ['架空 当日休', '架空 通常'].forEach((nm) => assert.ok(!text.includes(nm), nm + ' は一覧に出ない'));
    assert.equal(await A.rows().count(), 4);
    assert.deepEqual(await A.page.locator('#rolling-alert-body thead th').allInnerTexts(),
      ['対象者名', '対象日', 'アラート区分', '過去6日の勤務時間', '当日の勤務予定', 'ローリング7日合計', '60hまで', '判定根拠', 'データ更新日時']);
    assert.match(await A.meta(), /対象日: 2026-10-21.*データ投入日時.*集計日時.*サーバー保存日時.*サーバー保存済み/s);
    assert.ok(!(await A.meta()).includes('Amazon実績が未投入'), '実績込みの集計に警告は出ない');
    // 既存のRolling 60h表（ドライバー×日付）と件数カードが従来どおり
    assert.equal(await A.page.locator('#rolling-grid-wrap table.rolling-grid-table tbody tr').count(), 6);
    assert.equal((await A.text('#rolling-total-drivers')).trim(), '6');
  });

  await step('認証: 無認証・誤キーのAPIは401で氏名を返さず、正規キーは200', async () => {
    let r = await api('/rolling-alerts/latest', '');
    assert.equal(r.status, 401);
    assert.ok(!(await r.text()).includes('架空'));
    r = await api('/rolling-alerts/latest', 'wrong');
    assert.equal(r.status, 401);
    r = await api('/rolling-alerts/latest');
    const body = await r.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.snapshot.alerts.length, 4);
    r = await api('/rolling-alerts/save', 'wrong', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: body.snapshot, overwrite: true }) });
    assert.equal(r.status, 401);
  });

  await step('ページ再読み込み: 保存済みの最新結果を復元（ブラウザ保存あり）', async () => {
    await A.open();
    await A.page.waitForSelector('#rolling-alert-body [data-alert-state="list"]');
    assert.equal(await A.rows().count(), 4);
    assert.match(await A.text('#rolling-alert-phase'), /保存済み結果/);
  });

  await step('ページ再読み込み: ブラウザ保存が空でもサーバーから復元', async () => {
    await A.page.evaluate(() => localStorage.removeItem('ofk3.rollingAlerts.latest.v1'));
    await A.open();
    await A.page.waitForSelector('#rolling-alert-body [data-alert-state="list"]');
    assert.equal(await A.rows().count(), 4);
  });

  await step('同じファイルの再投入: 二重計上なし・サーバー保存は変更なし（リビジョン不変）', async () => {
    await A.upload('roster-v1.xlsx', 'amazon.xlsx');
    const rev = (await (await api('/rolling-alerts/latest')).json()).revision;
    const before = await A.page.evaluate(() => RollingUI._alertState.snapshot.computedAt);
    await A.page.setInputFiles('#rolling-file-roster', f('roster-v1.xlsx'));
    await A.page.waitForFunction((b) => RollingUI._alertState.snapshot.computedAt !== b, before);
    await A.settled();
    assert.equal(await A.rows().count(), 4);
    assert.equal(await A.page.evaluate(() => RollingUI._alertState.saveState), 'unchanged');
    assert.equal((await (await api('/rolling-alerts/latest')).json()).revision, rev);
  });

  await step('同じ人が複数DSPシートに載っても二重計上しない', async () => {
    await A.clear();
    await A.upload('roster-dup.xlsx', null);
    await A.settled();
    assert.equal(await A.page.locator('#rolling-alert-body tbody tr').count() >= 0, true);
    const keys = await A.page.evaluate(() => RollingUI._alertState.snapshot.alerts.map((a) => a.driverKey));
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(await A.page.locator('#rolling-grid-wrap table.rolling-grid-table tbody tr').count(), 6);
    assert.equal((await A.text('#rolling-total-drivers')).trim(), '6');
  });

  await step('Amazon実績なしの集計は、過去6日が予定ベースであることを警告', async () => {
    await A.open(); // 画面の読込状態をリセット（クリアはシフトのみ消すため）
    await A.upload('roster-v1.xlsx', null);
    assert.match(await A.meta(), /Amazon実績が未投入/);
    assert.equal(await A.page.evaluate(() => RollingUI._alertState.snapshot.alerts.some((a) => a.alertClass === 'exceed_confirmed')), false, '実績なしでは超過確定にしない');
  });

  await step('別ファイルへの更新: 一覧が置き換わり（追記されず）サーバーも更新', async () => {
    await A.clear();
    await A.upload('roster-v2.xlsx', 'amazon.xlsx');
    assert.equal(await A.rows().count(), 3);
    assert.ok(!(await A.text()).includes('架空 予測'));
    assert.equal((await (await api('/rolling-alerts/latest')).json()).snapshot.alerts.length, 3);
  });

  await step('対象者0名: 「該当者なし」', async () => {
    await A.clear();
    await A.upload('roster-none.xlsx', 'amazon-low.xlsx');
    assert.equal(await A.state(), 'empty');
    assert.match(await A.text(), /該当者なし/);
  });

  await step('基準日が集計済みの対象日と違う: 古い結果として警告', async () => {
    await A.page.fill('#rolling-reference-date', '2026-10-22');
    await A.page.dispatchEvent('#rolling-reference-date', 'change');
    assert.match(await A.text('#rolling-alert-phase'), /古い集計結果/);
    await A.page.fill('#rolling-reference-date', TARGET);
    await A.page.dispatchEvent('#rolling-reference-date', 'change');
  });

  // ---- APIエラー時の表示 ----
  await step('同期キー未設定の端末: 結果は表示し、サーバー未保存を明示（キー無しでAPIを叩かない）', async () => {
    C = await device('C', { token: '' });
    let apiCalls = 0;
    C.page.on('request', (r) => { if (r.url().includes('/rolling-alerts/')) apiCalls++; });
    await C.open();
    await C.upload('roster-v1.xlsx', 'amazon.xlsx');
    assert.equal(await C.rows().count(), 4);
    assert.match(await C.meta(), /同期キー未設定/);
    assert.equal(apiCalls, 0);
  });

  await step('誤った同期キーの端末: 401を「同期キーが正しくない」と表示。サーバーの結果は不変', async () => {
    const before = (await (await api('/rolling-alerts/latest')).json()).revision;
    D = await device('D', { token: 'wrong-token' });
    await D.open();
    await D.upload('roster-v1.xlsx', 'amazon.xlsx');
    assert.equal(await D.rows().count(), 4);
    assert.match(await D.meta(), /同期キーが正しくない/);
    assert.equal((await (await api('/rolling-alerts/latest')).json()).revision, before);
  });

  await step('保存APIが503/通信断/500: それぞれ画面に明示', async () => {
    for (const [mode, re] of [[503, /設定が未完了/], ['abort', /サーバーに接続できない/], [500, /保存に失敗/]]) {
      await A.page.route('**/rolling-alerts/save', (r) => (mode === 'abort' ? r.abort() : r.fulfill({ status: mode, contentType: 'application/json', body: '{}' })));
      await A.clear();
      await A.upload('roster-v3.xlsx', 'amazon.xlsx');
      assert.match(await A.meta(), re, String(mode));
      assert.equal(await A.rows().count(), 1, '集計結果自体は表示される');
      await A.page.unroute('**/rolling-alerts/save');
    }
  });

  await step('ブラウザ保存失敗(localStorage不可): 画面に警告、サーバー保存は成功', async () => {
    E = await device('E', { failLocalStorage: true });
    await E.open();
    await E.upload('roster-v1.xlsx', 'amazon.xlsx');
    assert.match(await E.meta(), /ブラウザ保存に失敗/);
    assert.match(await E.meta(), /サーバー保存済み/);
  });

  // ---- 別端末の競合 ----
  await step('別端末が先に更新: こちらの保存は上書きされず競合を表示 → 他端末の結果を採用', async () => {
    await A.clear();
    await A.upload('roster-v1.xlsx', 'amazon.xlsx'); // A が R_a を保存
    B = await device('B');
    await B.open();
    await B.page.waitForSelector('#rolling-alert-body [data-alert-state="list"]'); // B は A の結果(R_a)を復元
    await A.clear();
    await A.upload('roster-v2.xlsx', 'amazon.xlsx'); // A がさらに更新 → R_b
    const serverRev = (await (await api('/rolling-alerts/latest')).json()).revision;
    await B.upload('roster-v3.xlsx', 'amazon.xlsx'); // B は古い R_a を見たまま別データを保存しようとする
    assert.equal(await B.page.evaluate(() => RollingUI._alertState.saveState), 'conflict');
    assert.match(await B.meta(), /他の端末が.*別の結果.*上書きしていません/s);
    const srv = await (await api('/rolling-alerts/latest')).json();
    assert.equal(srv.revision, serverRev, 'サーバーの結果は変わらない');
    assert.equal(srv.snapshot.alerts.length, 3);
    await B.page.click('#rolling-alert-accept');
    assert.equal(await B.rows().count(), 3);
    assert.match(await B.meta(), /サーバー保存済み/);
  });

  await step('競合時に明示的に上書きを選ぶと、その端末の結果が保存される', async () => {
    await B.clear();
    await B.upload('roster-v1.xlsx', 'amazon.xlsx'); // B は最新を見ているので通常保存（4名）
    assert.equal((await (await api('/rolling-alerts/latest')).json()).snapshot.alerts.length, 4);
    await A.clear();
    await A.upload('roster-v3.xlsx', 'amazon.xlsx'); // A は古い base → 競合
    assert.equal(await A.page.evaluate(() => RollingUI._alertState.saveState), 'conflict');
    await A.page.click('#rolling-alert-overwrite');
    await A.settled();
    assert.equal((await (await api('/rolling-alerts/latest')).json()).snapshot.alerts.length, 1);
    assert.match(await A.meta(), /サーバー保存済み/);
  });

  // ---- 再起動・再デプロイ ----
  await step('サーバー再起動(ファイル保持): 再読み込みで同じ結果を復元', async () => {
    const before = await (await api('/rolling-alerts/latest')).json();
    await stopServer(); await startServer();
    const after = await (await api('/rolling-alerts/latest')).json();
    assert.equal(after.revision, before.revision);
    await A.open();
    await A.page.waitForSelector('#rolling-alert-body [data-alert-state="list"]');
    assert.equal(await A.rows().count(), 1);
  });

  await step('再デプロイ(保存ファイル消失): ブラウザ保存から自動再保存され、別端末も復元できる', async () => {
    await stopServer();
    fs.rmSync(path.join(work, 'rolling-alerts-latest.json'), { force: true });
    await startServer();
    assert.equal((await (await api('/rolling-alerts/latest')).json()).status, 'empty');
    await A.open();
    await A.page.waitForFunction(() => RollingUI._alertState.saveState === 'saved');
    const r = await (await api('/rolling-alerts/latest')).json();
    assert.equal(r.status, 'ok');
    assert.equal(r.snapshot.alerts.length, 1);
    // 旧世代のリビジョンを持つ別端末(B)は、新世代に黙って上書きしない
    await B.clear();
    await B.upload('roster-v1.xlsx', 'amazon.xlsx');
    assert.equal(await B.page.evaluate(() => RollingUI._alertState.saveState), 'conflict');
  });

  await step('集計失敗: エラー表示し、前回の結果を最新として出さない。復旧後は再表示', async () => {
    await A.upload('roster-v1.xlsx', 'amazon.xlsx');
    await A.page.evaluate(() => { window.__orig = RollingAlertCore.buildSnapshot; RollingAlertCore.buildSnapshot = () => { throw new Error('テスト用の集計エラー'); }; });
    await A.page.click('#rolling-btn-recompute');
    await A.page.waitForSelector('#rolling-alert-body [data-alert-state="error"]');
    assert.match(await A.text(), /集計に失敗しました.*テスト用の集計エラー/s);
    assert.equal(await A.rows().count(), 0);
    await A.page.evaluate(() => { RollingAlertCore.buildSnapshot = window.__orig; });
    await A.page.click('#rolling-btn-recompute');
    await A.settled();
    assert.ok(await A.rows().count() > 0);
  });

  assert.deepEqual(appErrors, [], '画面側に未処理エラーなし: ' + appErrors.join('; '));
  await A.page.screenshot({ path: f('alerts.png'), fullPage: false });
  console.log('rolling-alert-browser.test.mjs: ALL TESTS PASSED (' + n + ' steps) screenshot=' + f('alerts.png'));
} catch (e) {
  for (const dv of [A, B, C, D, E]) if (dv) await dv.page.screenshot({ path: f('failure-' + Math.random().toString(16).slice(2, 6) + '.png') }).catch(() => {});
  console.error('FAILED; screenshots in ' + work);
  throw e;
} finally {
  await browser.close();
  await stopServer();
}
