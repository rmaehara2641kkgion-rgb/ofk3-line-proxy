import { createRequire } from 'module';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const Archive = require('../harvest-daily-archive.js');
const Route = require('../harvest-daily-archive-route.js');
const Rolling = require('../rolling60h-core.js');
const Harvest = require('../harvest-daily-manifest.js');
const Run = require('../harvest-rolling60h-run.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');
const express = require('express');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function atJst(day, hour, minute) {
  const parts = day.split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 9, minute, 0));
}

function writeBook(file, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Report5_Daily_Data');
  XLSX.writeFile(wb, file);
}

function dailyRows(dates, hours) {
  const rows = [['transporter_id', 'working_day', 'estimated_working_hour', 'station_code']];
  dates.forEach(function (date) { rows.push(['TID-FICTION', date, hours, 'OFK3']); });
  return rows;
}

function weekEnding(end) {
  const dates = [];
  for (let i = 6; i >= 0; i -= 1) dates.push(Archive.addDays(end, -i));
  return dates;
}

const defaults = Archive.defaultSettings();
assert(defaults.hour === 8 && defaults.minute === 0 && defaults.intervalMinutes === 15, '初期値は8:00、間隔15分');
assert(Archive.normalizeSettings({ hour: 24, minute: 0, intervalMinutes: 15 }).reason === 'invalid-hour', '時は0から23');
assert(Archive.normalizeSettings({ hour: 8, minute: 60, intervalMinutes: 15 }).reason === 'invalid-minute', '分は0から59');
assert(Archive.normalizeSettings({ hour: 8, minute: 0, intervalMinutes: 7 }).reason === 'invalid-interval', '間隔は選択肢だけ');
assert(Archive.judge('2026-10-23', ['2026-10-23'], '2026-10-22').reason === 'future-file', '翌日のファイル名は当日分にしない');
assert(Archive.judge('2026-10-22', weekEnding('2026-10-23'), '2026-10-22').reason === 'next-day', '内部の最大日が翌日なら拒否');
assert(Archive.judge('2026-10-22', weekEnding('2026-10-21'), '2026-10-22').reason === 'date-mismatch', '内部日がファイル名と違うときは拒否');
assert(Archive.judge('2026-10-22', weekEnding('2026-10-22'), '2026-10-22').ok === true, 'ファイル名と最大稼働日が当日なら一致');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-archive-'));
const source = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-source-'));
const todayName = 'Daily_AMZL_JP_Working_Hour_2026-10-22_(FICTION).xlsx';
const todayFile = path.join(source, todayName);
writeBook(todayFile, dailyRows(weekEnding('2026-10-22'), 8));
const beforeHash = sha(todayFile);
let now = atJst('2026-10-22', 7, 59);
const early = Archive.create({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, sourceDir: source, root: root, now: function () { return now; },
});
const earlyResult = early.tick();
assert(earlyResult.status === 'waiting' && earlyResult.reason === 'before-time', '設定時刻前は待機');
assert(earlyResult.lastFailureAt == null, '待機は失敗にしない');
assert(fs.readdirSync(source).length === 1 && sha(todayFile) === beforeHash, '時刻前は原本を変えない');

now = atJst('2026-10-22', 8, 0);
const saved = early.saveSettings({ hour: 9, minute: 30, intervalMinutes: 30 });
assert(saved.ok === true && saved.settings.hour === 9 && saved.settings.intervalMinutes === 30, '設定を保存できる');
const rejected = early.saveSettings({ hour: 99, minute: 0, intervalMinutes: 15 });
assert(rejected.ok === false && early.settings().hour === 9 && early.settings().minute === 30, '不正な設定は保存済みの値を上書きしない');
early.saveSettings({ hour: 8, minute: 0, intervalMinutes: 15 });

const archived = early.tick();
assert(archived.status === 'ok' && archived.reason === 'archived' && archived.archivedDate === '2026-10-22', '当日分を保管する');
assert(sha(todayFile) === beforeHash, '原本の内容は保管後も同じ');
const again = early.tick();
assert(again.reason === 'unchanged' && again.revisionCount === 1, '同じ内容は重複保管しない');

writeBook(todayFile, dailyRows(weekEnding('2026-10-22'), 9));
const changed = early.tick();
assert(changed.reason === 'archived' && changed.revisionCount === 2, '同名でも内容が変われば別版として保管する');
assert(fs.existsSync(todayFile) && fs.readdirSync(path.join(root, 'files', '2026-10-22')).length === 2, '旧版も原本も残す');

const restored = Archive.create({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, sourceDir: source, root: root, now: function () { return now; },
});
assert(restored.settings().hour === 8 && restored.settings().intervalMinutes === 15, '再起動後も設定を維持する');
assert(restored.publicState().revisionCount === 2 && restored.publicState().lastSuccessAt, '再起動後も保管状態を維持する');

const tomorrowOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-tomorrow-'));
const tomorrowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-tomorrow-root-'));
writeBook(path.join(tomorrowOnly, 'Daily_AMZL_JP_Working_Hour_2026-10-23_(FICTION).xlsx'), dailyRows(weekEnding('2026-10-23'), 8));
const tomorrow = Archive.create({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, sourceDir: tomorrowOnly, root: tomorrowRoot, now: function () { return now; },
});
const tomorrowResult = tomorrow.tick();
assert(tomorrowResult.status === 'waiting' && tomorrowResult.reason === 'file-absent', '翌日ファイルしか無いときは当日分の待機');
assert(fs.existsSync(path.join(tomorrowRoot, 'files')) === false, '翌日ファイルはコピーしない');

const mismatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-mismatch-root-'));
const mismatchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-mismatch-'));
writeBook(path.join(mismatchDir, todayName), dailyRows(weekEnding('2026-10-23'), 8));
const mismatch = Archive.create({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, sourceDir: mismatchDir, root: mismatchRoot, now: function () { return now; },
});
const mismatchResult = mismatch.tick();
assert(mismatchResult.status === 'error' && mismatchResult.reason === 'next-day', '当日のファイル名でも内部が翌日なら失敗');
assert(fs.existsSync(path.join(mismatchRoot, 'files')) === false, '日付不一致のファイルは保管しない');

const missing = Archive.create({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling,
  sourceDir: path.join(os.tmpdir(), 'daily-missing-' + Date.now()),
  root: fs.mkdtempSync(path.join(os.tmpdir(), 'daily-missing-root-')),
  now: function () { return now; },
});
const missingResult = missing.tick();
assert(missingResult.status === 'waiting' && missingResult.reason === 'file-absent' && missingResult.lastFailureAt == null, 'ファイルが無いのは正常な待機');

const boom = Object.create(fs);
boom.existsSync = function () { throw new Error('boom'); };
const isolated = Archive.create({
  fs: boom, path: path, xlsx: XLSX, rolling: Rolling, sourceDir: source,
  root: fs.mkdtempSync(path.join(os.tmpdir(), 'daily-isolated-')),
  now: function () { return now; },
});
let isolatedThrown = false;
let isolatedResult = null;
try { isolatedResult = isolated.tick(); } catch (e) { isolatedThrown = true; }
assert(isolatedThrown === false && isolatedResult.reason === 'read-failed', '保管処理の例外は外へ出さない');

const rows = restored.rowsForDate('2026-10-22');
assert(rows.ok === true && rows.sheet === 'Report5_Daily_Data' && rows.file === todayName, '保管済みデータを日付指定で読める');
const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-other-'));
const otherName = 'Daily_AMZL_JP_Working_Hour_2026-10-21_(FICTION).xlsx';
writeBook(path.join(otherDir, otherName), dailyRows(weekEnding('2026-10-21'), 4));
const used = Run.capture({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyDir: otherDir, shiftDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daily-shift-')),
  historyFile: false, referenceDate: '2026-10-22', dailyArchive: restored,
});
assert(used.summary.dailyFile === todayName, 'ローリング60hは保管済みの当日分を使う');
const fallback = Run.capture({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyDir: otherDir, shiftDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daily-shift-')),
  historyFile: false, referenceDate: '2026-10-21',
  dailyArchive: { rowsForDate: function () { throw new Error('archive down'); } },
});
assert(fallback.summary.dailyFile === otherName, '保管の失敗時は従来のフォルダ読み取りに戻る');

const ui = fs.readFileSync(new URL('../harvest-daily-archive-ui.js', import.meta.url), 'utf8');
assert(ui.includes('ofk3-daily-archive-hour') && ui.includes('ofk3-daily-archive-minute') && ui.includes('監視間隔'), '画面に時・分・間隔がある');
assert(ui.includes('最終回収') && ui.includes('最終失敗'), '画面に成功と失敗の時刻がある');
const server = fs.readFileSync(new URL('../render-webhook-server.js', import.meta.url), 'utf8');
assert(server.includes('dailyArchive: dailyArchiveService'), 'ローリング60hへ保管先を渡す');
assert(server.includes('if (dailyArchiveService) dailyArchiveService.start()'), '起動失敗をサーバー全体から分離する');

const app = express();
app.use(express.json());
Route.mount(app, { isLoopback: function () { return true; }, service: restored });
const denied = express();
denied.use(express.json());
Route.mount(denied, { isLoopback: function () { return false; }, service: restored });

function listen(application) {
  return new Promise(function (resolve) {
    const server = application.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}
function request(port, method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const req = http.request({ hostname: '127.0.0.1', port: port, path: urlPath, method: method, headers: { 'Content-Type': 'application/json' } }, function (res) {
      let data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () { resolve({ status: res.statusCode, body: JSON.parse(data) }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const live = await listen(app);
const blocked = await listen(denied);
const posted = await request(live.address().port, 'POST', '/harvest/daily-archive/settings', { hour: 7, minute: 15, intervalMinutes: 10 });
assert(posted.status === 200 && posted.body.settings.hour === 7 && posted.body.settings.minute === 15, '画面からの設定保存');
const got = await request(live.address().port, 'GET', '/harvest/daily-archive/status');
assert(got.status === 200 && got.body.settings.intervalMinutes === 10 && got.body.revisionCount === 2, '保存した設定と保管状態を返す');
const forbidden = await request(blocked.address().port, 'GET', '/harvest/daily-archive/status');
assert(forbidden.status === 403 && forbidden.body.reason === 'local-only', 'ループバック以外は設定を読めない');
live.close();
blocked.close();
restored.stop();

const restarted = Archive.create({ fs: fs, path: path, xlsx: XLSX, rolling: Rolling, sourceDir: source, root: root });
assert(restarted.settings().hour === 7 && restarted.settings().minute === 15 && restarted.settings().intervalMinutes === 10, 'ルート保存も再起動後に残る');
restarted.stop();

console.log('harvest-daily-archive.test.mjs: ALL TESTS PASSED');
