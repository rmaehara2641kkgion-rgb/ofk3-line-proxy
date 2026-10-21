/**
 * ブラウザ実機確認: シフトExcel投入 → 自動判定 → アラート者一覧表示 → 保存 → 再読み込み復元。
 * rolling60h-ui.js を実ブラウザ(Chromium)で動かし、保存APIは本番と同じ route/store を使う。
 * Playwright が無い環境では SKIP する（test:all には含めない）。
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean)) {
  try { chromium = require(spec).chromium; break; } catch (e) { /* next */ }
}
if (!chromium) { console.log('rolling-alert-browser.test.mjs: SKIPPED (playwright not found)'); process.exit(0); }

const express = require('express');
const XLSX = require('xlsx');
const { createStore } = require('../rolling-alert-store.js');
const Route = require('../rolling-alert-route.js');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rolling-alert-e2e-'));
const TARGET = '2026-10-21';
const PAST = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];

// ---- 架空のシフト/実績Excel ----
function d(iso) { const [y, m, dd] = iso.split('-').map(Number); return new Date(y, m - 1, dd); }
const allDates = [];
for (let i = 8; i <= 25; i++) allDates.push('2026-10-' + String(i).padStart(2, '0'));

function rosterBook(todayBy) {
  const drivers = [
    ['TID001', '架空 確定'], ['TID002', '架空 予測'], ['TID003', '架空 接近'],
    ['TID004', '架空 当日休'], ['TID005', '架空 予定未確認'], ['TID006', '架空 通常'],
  ];
  const rows = [['社名', '名前', 'Transport ID'].concat(allDates.map(d))];
  drivers.forEach(([tid, name]) => {
    const row = ['DSP', name, tid];
    allDates.forEach((iso) => {
      if (iso === TARGET) row.push(todayBy[tid]);
      else row.push(iso < TARGET ? '○' : '休');
    });
    rows.push(row);
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'GDS');
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
XLSX.writeFile(rosterBook(todayV1), f('roster-v1.xlsx'), { cellDates: true });
XLSX.writeFile(rosterBook({ ...todayV1, TID002: '休' }), f('roster-v2.xlsx'), { cellDates: true });
XLSX.writeFile(rosterBook({ TID001: '休', TID002: '休', TID003: '休', TID004: '休', TID005: '休', TID006: '❽' }), f('roster-none.xlsx'), { cellDates: true });
XLSX.writeFile(amazonBook(hoursBy), f('amazon.xlsx'), { cellDates: true });
XLSX.writeFile(amazonBook({ TID001: 5, TID002: 5, TID003: 5, TID004: 5, TID005: 5, TID006: 5 }), f('amazon-low.xlsx'), { cellDates: true });

// ---- サーバー: 静的ファイル + 保存API（本番と同じ route/store）----
const store = createStore({ fs, filePath: path.join(work, 'store.json') });
let failSave = false;
const app = express();
app.use(express.json({ limit: '10mb' }));
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div id="wh60-rolling-subpanel"></div>
  <script src="/vendor/xlsx.full.min.js"></script>
  <script src="/rolling60h-core.js"></script>
  <script src="/rolling-alert-core.js"></script>
  <script src="/inoichi-rolling-dryrun.js"></script>
  <script src="/rolling60h-ui.js"></script>
  <script>RollingUI.onShown();</script></body></html>`);
});
app.get('/vendor/xlsx.full.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/xlsx/dist/xlsx.full.min.js')));
app.post('/rolling-alerts/save', (req, res, next) => (failSave ? res.status(500).json({ status: 'error' }) : next()));
Route.mount(app, { store });
app.use(express.static(root));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port + '/';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const state = () => page.locator('#rolling-alert-body [data-alert-state]').first().getAttribute('data-alert-state');
const rows = () => page.locator('#rolling-alert-body tbody tr');
async function load() {
  await page.goto(url);
  await page.waitForSelector('#rolling-alert-card');
  await page.fill('#rolling-reference-date', TARGET);
}
async function upload(rosterFile, amazonFile) {
  await page.fill('#rolling-reference-date', TARGET);
  if (rosterFile) await page.setInputFiles('#rolling-file-roster', f(rosterFile));
  if (amazonFile) await page.setInputFiles('#rolling-file-amazon', f(amazonFile));
  await page.waitForFunction(() => document.querySelector('#rolling-alert-body [data-alert-state="computing"]') === null);
}
const settled = () => page.waitForFunction(() => {
  const s = RollingUI._alertState;
  return s.phase !== 'computing' && s.saveState !== 'saving';
});
let n = 0;
async function step(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

try {
  await load();
  await step('データ未投入: 「シフトデータ未投入」を表示', async () => {
    assert.equal(await state(), 'no-data');
    assert.match(await page.locator('#rolling-alert-body').innerText(), /シフトデータ未投入/);
  });

  // 「集計中」表示を観測
  await page.evaluate(() => {
    window.__seen = [];
    new MutationObserver(() => {
      const t = document.getElementById('rolling-alert-phase').innerText;
      if (t && window.__seen[window.__seen.length - 1] !== t) window.__seen.push(t);
    }).observe(document.getElementById('rolling-alert-phase'), { childList: true, subtree: true });
  });

  await step('初回投入: アラート者一覧へ自動反映（手動集計なし）', async () => {
    await upload('roster-v1.xlsx', 'amazon.xlsx');
    await settled();
    assert.equal(await state(), 'list');
    const text = await page.locator('#rolling-alert-body').innerText();
    ['架空 確定', '架空 予測', '架空 接近', '架空 予定未確認'].forEach((nm) => assert.ok(text.includes(nm), nm));
    ['架空 当日休', '架空 通常'].forEach((nm) => assert.ok(!text.includes(nm), nm + ' は一覧に出ない'));
    assert.equal(await rows().count(), 4);
    ['超過確定', '超過予測', '接近警告', '勤務予定未確認', '未確認', '未取得'].forEach((w) => assert.ok(text.includes(w) || w === '未取得', w));
    const headers = await page.locator('#rolling-alert-body thead th').allInnerTexts();
    assert.deepEqual(headers, ['対象者名', '対象日', 'アラート区分', '過去6日の勤務時間', '当日の勤務予定', 'ローリング7日合計', '60hまで', '判定根拠', 'データ更新日時']);
    assert.match(await page.locator('#rolling-alert-meta').innerText(), /対象日: 2026-10-21.*データ投入日時.*集計日時/s);
  });

  await step('「集計中」を経由して表示された', async () => {
    const seen = await page.evaluate(() => window.__seen);
    assert.ok(seen.some((t) => t.includes('集計中')), JSON.stringify(seen));
  });

  await step('保存済み: サーバーに最新結果がある', async () => {
    const latest = await (await fetch(url + 'rolling-alerts/latest')).json();
    assert.equal(latest.status, 'ok');
    assert.equal(latest.snapshot.alerts.length, 4);
  });

  await step('ページ再読み込み: 保存済みの最新結果を復元（ブラウザ保存）', async () => {
    await load();
    await page.waitForSelector('#rolling-alert-body [data-alert-state="list"]');
    assert.equal(await rows().count(), 4);
    assert.match(await page.locator('#rolling-alert-phase').innerText(), /保存済み結果/);
  });

  await step('ページ再読み込み: ブラウザ保存が空でもサーバーから復元', async () => {
    await page.evaluate(() => localStorage.clear());
    await load();
    await page.waitForSelector('#rolling-alert-body [data-alert-state="list"]');
    assert.equal(await rows().count(), 4);
  });

  await step('同一データの再投入: 二重計上されない・保存は変更なし', async () => {
    await upload('roster-v1.xlsx', 'amazon.xlsx');
    await settled();
    const before = await page.evaluate(() => RollingUI._alertState.snapshot.computedAt);
    await page.setInputFiles('#rolling-file-roster', f('roster-v1.xlsx'));
    await page.waitForFunction((b) => RollingUI._alertState.snapshot.computedAt !== b, before);
    await settled();
    assert.equal(await rows().count(), 4);
    assert.equal(await page.evaluate(() => RollingUI._alertState.saveState), 'unchanged');
    assert.equal((await (await fetch(url + 'rolling-alerts/latest')).json()).snapshot.alerts.length, 4);
  });

  await step('データ更新後の再集計: 当日が○→休で超過予測者が消える', async () => {
    await page.click('#rolling-btn-roster-reset');
    await upload('roster-v2.xlsx', null);
    await settled();
    assert.equal(await rows().count(), 3);
    assert.ok(!(await page.locator('#rolling-alert-body').innerText()).includes('架空 予測'));
    assert.equal((await (await fetch(url + 'rolling-alerts/latest')).json()).snapshot.alerts.length, 3);
  });

  await step('対象者0名: 「該当者なし」', async () => {
    await page.click('#rolling-btn-roster-reset');
    await upload('roster-none.xlsx', 'amazon-low.xlsx');
    await settled();
    assert.equal(await state(), 'empty');
    assert.match(await page.locator('#rolling-alert-body').innerText(), /該当者なし/);
  });

  await step('基準日が集計済み対象日と違う: 古い結果として警告', async () => {
    await page.fill('#rolling-reference-date', '2026-10-22');
    await page.dispatchEvent('#rolling-reference-date', 'change');
    assert.match(await page.locator('#rolling-alert-phase').innerText(), /古い集計結果/);
    await page.fill('#rolling-reference-date', TARGET);
    await page.dispatchEvent('#rolling-reference-date', 'change');
  });

  await step('サーバー保存失敗: 画面は集計結果を出し、未保存を明示', async () => {
    failSave = true;
    await page.click('#rolling-btn-roster-reset');
    await upload('roster-v1.xlsx', 'amazon.xlsx');
    await settled();
    assert.equal(await rows().count(), 4);
    assert.match(await page.locator('#rolling-alert-meta').innerText(), /サーバー未保存|保存失敗/);
    failSave = false;
  });

  await step('集計失敗: エラー表示し、前回の結果を最新として出さない', async () => {
    await page.evaluate(() => { window.__orig = RollingAlertCore.buildSnapshot; RollingAlertCore.buildSnapshot = () => { throw new Error('テスト用の集計エラー'); }; });
    await page.click('#rolling-btn-recompute');
    await page.waitForSelector('#rolling-alert-body [data-alert-state="error"]');
    const text = await page.locator('#rolling-alert-body').innerText();
    assert.match(text, /集計に失敗しました.*テスト用の集計エラー/s);
    assert.equal(await rows().count(), 0);
    await page.evaluate(() => { RollingAlertCore.buildSnapshot = window.__orig; });
    await page.click('#rolling-btn-recompute');
    await settled();
    assert.equal(await rows().count(), 4, '復旧後は再び表示');
  });

  assert.deepEqual(errors, [], 'ブラウザ側に未処理エラーなし: ' + errors.join('; '));
  await page.screenshot({ path: f('alerts.png'), fullPage: true });
  console.log('rolling-alert-browser.test.mjs: ALL TESTS PASSED (' + n + ' steps) screenshot=' + f('alerts.png'));
} catch (e) {
  await page.screenshot({ path: f('failure.png'), fullPage: true }).catch(() => {});
  console.error('FAILED; screenshot=' + f('failure.png'));
  throw e;
} finally {
  await browser.close();
  server.close();
}
