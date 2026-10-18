import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Run = require('../harvest-rolling60h-run.js');
const Route = require('../harvest-rolling60h-route.js');
const Collector = require('../harvest-collector-rolling60h.js');
const Harvest = require('../harvest-daily-manifest.js');
const Rolling = require('../rolling60h-core.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');
const Core = require('../harvest-core.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

const dailyHeader = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];
const days = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'];

function dailyRow(tid, date, hours) {
  return [tid, date, hours, 'OFK3'];
}

function shiftSheet(rows) {
  const header = ['社名', '名前', 'Transport ID'].concat(days.map(function (iso) {
    const p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }));
  return [header].concat(rows);
}

function writeBook(dir, name, sheets) {
  const wb = XLSX.utils.book_new();
  Object.keys(sheets).forEach(function (sheetName) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets[sheetName]), sheetName);
  });
  XLSX.writeFile(wb, path.join(dir, name));
}

const dailyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-daily-'));
const shiftDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-shift-'));
const dailyRows = [dailyHeader];
days.forEach(function (date) { dailyRows.push(dailyRow('TID-FICTION-A', date, 10)); });
days.forEach(function (date, index) { dailyRows.push(dailyRow('TID-FICTION-B', date, index === 6 ? 0 : 10)); });
days.forEach(function (date, index) { dailyRows.push(dailyRow('TID-FICTION-C', date, index === 0 ? 10 : 8)); });
dailyRows.push(dailyRow('TID-FICTION-C', days[0], 12));
writeBook(dailyDir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  '貼付': [dailyHeader, dailyRow('TID-PASTE-SECRET', days[0], 99)],
  'Report5_Daily_Data': dailyRows,
});
writeBook(shiftDir, '最新10月DAシフト.xlsx', {
  '貼付': [dailyHeader, dailyRow('TID-PASTE-SECRET', days[0], 99)],
  'GDS': shiftSheet([
    ['GDS', 'Fiction Driver', 'TID-FICTION-D'].concat(days.map(function () { return '嘉'; })),
    ['GDS', 'Name Only', '', '○', '○', '○', '○', '○', '○', '○'],
  ]),
});

const summary = Run.run({
  fs: fs,
  path: path,
  xlsx: XLSX,
  rolling: Rolling,
  harvest: Harvest,
  dryRun: DryRun,
  dailyDir: dailyDir,
  shiftDir: shiftDir,
  referenceDate: '2026-10-18',
  historyFile: false,
});
const packed = JSON.stringify(summary);
assert(summary.sent === false && summary.channel === 'dry-run', 'dry-runのまま');
assert(summary.fileSuccess === 2 && summary.fileFailure === 0, 'デイリーとシフトを取得できる');
assert(summary.dailyFile.indexOf('2026-10-17') !== -1, '最新デイリーのファイル名');
assert(summary.shiftFile === '最新10月DAシフト.xlsx', '最新シフトのファイル名');
assert(summary.driverCount === 4, 'IDがある4人だけが対象');
assert(summary.exceedCount === 1, '10時間×7日は超過1人');
assert(summary.approachCount === 1, '60時間ちょうどは接近1人');
assert(summary.undeterminedCount === 2, '重複と未知記号は完全判定不能');
assert(summary.clearCount === 0 && summary.partialCount === 0, 'この組に正常と部分欠損はない');
assert(summary.unmatchedCount === 1, 'IDのないシフト行は未照合件数');
assert(summary.clearCount + summary.exceedCount + summary.approachCount + summary.partialCount + summary.undeterminedCount === summary.driverCount, '人数は排他で対象人数と一致する');
assert(packed.indexOf('TID-') === -1 && packed.indexOf('Fiction') === -1 && packed.indexOf('Name Only') === -1, '個人名とIDを応答に出さない');

const ambiguousDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-shift-tie-'));
writeBook(ambiguousDir, '9月DAシフト.xlsx', { 'GDS': shiftSheet([['GDS', 'Fiction Driver', 'TID-FICTION-A', '休', '休', '休', '休', '休', '休', '休']]) });
writeBook(ambiguousDir, '10月DAシフト.xlsx', { 'GDS': shiftSheet([['GDS', 'Fiction Driver', 'TID-FICTION-A', '休', '休', '休', '休', '休', '休', '休']]) });
const stamp = new Date('2026-10-01T00:00:00Z');
fs.utimesSync(path.join(ambiguousDir, '9月DAシフト.xlsx'), stamp, stamp);
fs.utimesSync(path.join(ambiguousDir, '10月DAシフト.xlsx'), stamp, stamp);
const tied = Run.run({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyDir: dailyDir, shiftDir: ambiguousDir, referenceDate: '2026-10-18', historyFile: false,
});
assert(tied.fileSuccess === 1 && tied.fileFailure === 1 && tied.shiftFile === '', '同時刻のシフトは失敗にしてファイルを選ばない');

const missing = Run.run({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyDir: path.join(os.tmpdir(), 'hv-missing-' + Date.now()),
  shiftDir: path.join(os.tmpdir(), 'hv-missing-shift-' + Date.now()),
  referenceDate: '2026-10-18',
  historyFile: false,
});
assert(missing.ok === false && missing.fileSuccess === 0 && missing.fileFailure === 2 && missing.driverCount === 0, 'フォルダが無いときは両方失敗');

let remoteCalled = false;
const remote = { statusCode: 0, body: '' };
Route.handle({
  socket: { remoteAddress: '203.0.113.8' },
  headers: { 'x-forwarded-for': '127.0.0.1', origin: 'https://evil.example' },
  get: function () { return '1'; },
}, {
  status: function (code) { remote.statusCode = code; return this; },
  json: function (body) { remote.body = JSON.stringify(body); },
}, { run: function () { remoteCalled = true; return summary; } });
assert(remote.statusCode === 403 && remoteCalled === false && remote.body.indexOf('2026-10-17') === -1, '外部アドレスでは計算しない');

const localDenied = { statusCode: 0 };
Route.handle({
  socket: { remoteAddress: '127.0.0.1' },
  get: function () { return ''; },
}, {
  status: function (code) { localDenied.statusCode = code; return this; },
  json: function () {},
}, { run: function () { throw new Error('should not run'); } });
assert(localDenied.statusCode === 403, 'ローカルでも専用ヘッダーが無い要求は拒否する');

const collector = Collector.createCollector({
  request: function () {
    return Promise.resolve({
      status: 200,
      body: Object.assign({}, summary, { transportId: 'TID-SECRET', driverName: 'Fiction Driver' }),
    });
  },
});
const hub = Core.createHub();
hub.register(collector);
const state = await hub.runCollector('rolling60h');
const shown = JSON.stringify(state.state);
assert(state.state.counts.success === 2 && state.state.counts.failure === 0, '取得成功件数をCollectorへ渡す');
assert(state.state.details.exceedCount === 1 && state.state.details.approachCount === 1 && state.state.details.undeterminedCount === 2, '人数をCollectorへ渡す');
assert(state.state.checkedAt, '最終実行日時がある');
assert(shown.indexOf('TID-SECRET') === -1 && shown.indexOf('Fiction Driver') === -1, '画面状態に個人名とIDを残さない');
assert(state.state.details.unmatchedCount === 1, '未照合件数を画面状態に残す');

const boundaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-boundary-'));
const boundaryShift = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-boundary-shift-'));
const boundaryRows = [dailyHeader];
days.forEach(function (date, index) { boundaryRows.push(dailyRow('TID-EDGE-60', date, index === 6 ? 0 : 10)); });
days.forEach(function (date, index) { boundaryRows.push(dailyRow('TID-EDGE-OVER', date, index === 6 ? 0.1 : 10)); });
const partialDays = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
partialDays.forEach(function (date, index) {
  boundaryRows.push(dailyRow('TID-EDGE-PARTIAL', date, index === 0 ? 'n/a' : 1));
});
days.forEach(function (date) { boundaryRows.push(dailyRow('TID-EDGE-CLEAR', date, 1)); });
writeBook(boundaryDir, 'Daily_AMZL_JP_Working_Hour_2026-10-18_(FICTION).xlsx', { 'Report5_Daily_Data': boundaryRows });
writeBook(boundaryShift, '10月DAシフト.xlsx', { 'GDS': [['社名', '名前', 'Transport ID']] });
const boundary = Run.run({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyDir: boundaryDir, shiftDir: boundaryShift, referenceDate: '2026-10-19', historyFile: false,
});
assert(boundary.approachCount === 1, '60時間ちょうどは接近であり超過ではない');
assert(boundary.exceedCount === 1, '60.1時間は超過');
assert(boundary.partialCount === 1 && boundary.partialExceedCount === 0, '一部の窓だけ読めない人は部分欠損');
assert(boundary.clearCount === 1, '全窓が基準内の人だけを正常にする');
assert(boundary.clearCount + boundary.exceedCount + boundary.approachCount + boundary.partialCount + boundary.undeterminedCount === boundary.driverCount, '境界データの人数も排他');
assert(JSON.stringify(boundary).indexOf('TID-EDGE') === -1, '境界テストの応答にもIDを出さない');

const sameDayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-sameday-'));
const sameDayShift = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-sameday-shift-'));
const sameHeader = ['社名', '名前', 'Transport ID'].concat(days.map(function (iso) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}));
writeBook(sameDayDir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  'Report5_Daily_Data': [dailyHeader].concat(days.map(function (date) { return dailyRow('TID-SAME', date, 4); })),
});
writeBook(sameDayShift, '10月DAシフト.xlsx', {
  'GDS': [sameHeader, ['GDS', 'Fiction Driver', 'TID-SAME'].concat(days.map(function () { return '○'; }))],
});
const sameAudit = Run.audit({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyDir: sameDayDir, shiftDir: sameDayShift, referenceDate: '2026-10-18',
});
const sameSummary = Run.run({
  fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyDir: sameDayDir, shiftDir: sameDayShift, referenceDate: '2026-10-18', historyFile: false,
});
assert(sameAudit.overlapPersonDays === 7 && sameAudit.overlapKeptDaily === 7 && sameAudit.overlapSummed === 0, '同日は推定時間を使い予定時間を足さない');
assert(sameSummary.exceedCount === 0 && sameSummary.clearCount === 1, '4時間×7は予定11時間と足しても超過にしない');
assert(JSON.stringify(sameAudit).indexOf('TID-SAME') === -1, '監査結果にIDを出さない');
assert(hub.listIds().join(',') === 'rolling60h', 'このテスト用ハブはローリングだけ');

console.log('harvest-rolling60h-collector.test.mjs: ALL TESTS PASSED');
