import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Run = require('../harvest-rolling60h-run.js');
const History = require('../harvest-rolling60h-history.js');
const Collector = require('../harvest-collector-rolling60h.js');
const Harvest = require('../harvest-daily-manifest.js');
const Rolling = require('../rolling60h-core.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

const dailyHeader = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code', 'snapshot_date'];
const week = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'];

function assertPublic(summary) {
  const packed = JSON.stringify(summary);
  assert(summary.sent === false && summary.channel === 'dry-run' && summary.confirmedActual === false, 'dry-runのまま、確定値とは返さない');
  assert(packed.indexOf('TID-') === -1 && packed.indexOf('Fiction') === -1, '応答にIDと氏名を出さない');
}

function datesOf(list) {
  return list.map(function (iso) {
    const p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  });
}

function writeBook(dir, name, sheets) {
  const wb = XLSX.utils.book_new();
  Object.keys(sheets).forEach(function (sheetName) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets[sheetName]), sheetName);
  });
  XLSX.writeFile(wb, path.join(dir, name));
}

function dailySheet(tid, dates, hours, snapshot) {
  const rows = [dailyHeader];
  dates.forEach(function (date, index) {
    const value = Array.isArray(hours) ? hours[index] : hours;
    rows.push([tid, date, value, 'OFK3', snapshot || '2026-10-17']);
  });
  return rows;
}

function shiftSheet(tid, dates, marks) {
  return [
    ['社名', '名前', 'Transport ID'].concat(datesOf(dates)),
    ['GDS', 'Fiction Driver', tid].concat(marks),
  ];
}

function runPair(dailyDir, shiftDir, historyFile, referenceDate) {
  return Run.run({
    fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyDir: dailyDir, shiftDir: shiftDir, historyFile: historyFile, referenceDate: referenceDate,
  });
}

const changed = History.logicIdentity({ MARU: 11, KYU: 0 });
const original = History.logicIdentity(Rolling.SHIFT_HOUR_TABLE);
assert(changed !== original, '勤務記号の換算が変わると計算版が変わる');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-hist-'));
const dailyDir = path.join(base, 'daily');
const shiftDir = path.join(base, 'shift');
const historyFile = path.join(base, 'history.json');
fs.mkdirSync(dailyDir);
fs.mkdirSync(shiftDir);
writeBook(dailyDir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-A', week, 10),
});
writeBook(shiftDir, '10月DAシフト.xlsx', {
  'GDS': shiftSheet('TID-FICTION-A', week, week.map(function () { return '休'; })).concat([
    ['GDS', 'Name Only', '', '○', '○', '○', '○', '○', '○', '○'],
  ]),
});
const first = runPair(dailyDir, shiftDir, historyFile, '2026-10-18');
assertPublic(first);
assert(first.historyCreated === 1 && first.historySaved === true && first.historyRuns === 1, '初回予測を1件保存する');
assert(first.exceedCount === 1 && first.estimateCoveredWindows === 1 && first.futureOpenWindows === 0, '過去7日の推定時間だけで超過を保存する');
const stored = fs.readFileSync(historyFile, 'utf8');
assert(stored.indexOf('TID-FICTION-A') !== -1, 'ローカル履歴には対象者IDを残す');
assert(stored.indexOf('Name Only') === -1 && stored.indexOf('Fiction Driver') === -1, '氏名では履歴を作らない');
const stamp = new Date('2026-10-20T00:00:00Z');
fs.utimesSync(path.join(dailyDir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx'), stamp, stamp);
fs.utimesSync(path.join(shiftDir, '10月DAシフト.xlsx'), stamp, stamp);
const again = runPair(dailyDir, shiftDir, historyFile, '2026-10-18');
assertPublic(again);
assert(again.historyCreated === 0 && again.historyDuplicate === true && again.historyRuns === 1, '同じ内容の再取得では履歴を増やさない');
assert(JSON.parse(fs.readFileSync(historyFile, 'utf8')).runs.length === 1, '履歴ファイルも1件のまま');

const dailyNext = path.join(base, 'daily-next');
fs.mkdirSync(dailyNext);
writeBook(dailyNext, 'Daily_AMZL_JP_Working_Hour_2026-10-18_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-A', week, 1, '2026-10-18'),
});
const byDaily = runPair(dailyNext, shiftDir, historyFile, '2026-10-18');
assertPublic(byDaily);
assert(byDaily.resolvedByDaily === 1 && byDaily.resolvedBySchedule === 0 && byDaily.resolvedByBoth === 0, 'デイリー更新だけを予測解消にする');
assert(byDaily.clearCount === 1 && byDaily.estimateCoveredWindows === 1 && byDaily.resolvedWithFuture === 0, '7日が推定時間に置き換わっても法的確定とはしない');

const shiftBase = path.join(base, 'shift-a');
const shiftNext = path.join(base, 'shift-b');
const dailyFuture = path.join(base, 'daily-future');
const historyShift = path.join(base, 'history-shift.json');
fs.mkdirSync(shiftBase);
fs.mkdirSync(shiftNext);
fs.mkdirSync(dailyFuture);
writeBook(dailyFuture, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-B', week, 1),
});
writeBook(shiftBase, '10月DAシフト.xlsx', { 'GDS': shiftSheet('TID-FICTION-B', week, week.map(function () { return '○'; })) });
writeBook(shiftNext, '10月DAシフト.xlsx', { 'GDS': shiftSheet('TID-FICTION-B', week, week.map(function () { return '休'; })) });
const planned = runPair(dailyFuture, shiftBase, historyShift, '2026-10-11');
assert(planned.exceedCount === 1 && planned.futureOpenWindows === 1, '基準日以降の予定を含む窓を残す');
const bySchedule = runPair(dailyFuture, shiftNext, historyShift, '2026-10-11');
assertPublic(bySchedule);
assert(bySchedule.resolvedBySchedule === 1 && bySchedule.resolvedByDaily === 0 && bySchedule.resolvedWithFuture === 1, '予定変更による予測解消を分ける');
assert(bySchedule.futureOpenWindows === 1 && bySchedule.confirmedActual === false, '未来日が残る窓を確定値にしない');

const bothDailyA = path.join(base, 'both-daily-a');
const bothDailyB = path.join(base, 'both-daily-b');
const bothShiftA = path.join(base, 'both-shift-a');
const bothShiftB = path.join(base, 'both-shift-b');
const historyBoth = path.join(base, 'history-both.json');
[bothDailyA, bothDailyB, bothShiftA, bothShiftB].forEach(function (dir) { fs.mkdirSync(dir); });
writeBook(bothDailyA, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-C', week.slice(0, 4), 10),
});
writeBook(bothDailyB, 'Daily_AMZL_JP_Working_Hour_2026-10-18_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-C', week.slice(0, 4), 1, '2026-10-18'),
});
writeBook(bothShiftA, '10月DAシフト.xlsx', {
  'GDS': shiftSheet('TID-FICTION-C', week, ['休', '休', '休', '休', '○', '○', '○']),
});
writeBook(bothShiftB, '10月DAシフト.xlsx', {
  'GDS': shiftSheet('TID-FICTION-C', week, week.map(function () { return '休'; })),
});
runPair(bothDailyA, bothShiftA, historyBoth, '2026-10-15');
const byBoth = runPair(bothDailyB, bothShiftB, historyBoth, '2026-10-15');
assertPublic(byBoth);
assert(byBoth.resolvedByBoth === 1 && byBoth.resolvedByDaily === 0 && byBoth.resolvedBySchedule === 0, '予定とデイリーの両方の変化を分ける');

const unknown = History.assess([{
  subjectId: 'TID-CAUSE',
  start: week[0],
  end: week[6],
  level: 'exceed',
  days: week.map(function (date) { return { date: date, hours: 10, origin: 'daily-estimate', future: false }; }),
}], [{
  subjectId: 'TID-CAUSE',
  start: week[0],
  end: week[6],
  level: 'within',
  future: false,
  days: week.map(function (date) { return { date: date, hours: 10, origin: 'daily-estimate', future: false }; }),
}]);
assert(unknown.resolvedCauseUnknown === 1 && unknown.resolvedByDaily === 0 && unknown.resolvedBySchedule === 0, '時間の出典が変わらない解消は原因判定不能');

const gapDailyA = path.join(base, 'gap-a');
const gapDailyB = path.join(base, 'gap-b');
const gapShiftA = path.join(base, 'gap-shift-a');
const gapShiftB = path.join(base, 'gap-shift-b');
const historyGap = path.join(base, 'history-gap.json');
[gapDailyA, gapDailyB, gapShiftA, gapShiftB].forEach(function (dir) { fs.mkdirSync(dir); });
writeBook(gapDailyA, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-D', week, 10),
});
writeBook(gapShiftA, '10月DAシフト.xlsx', { 'GDS': shiftSheet('TID-FICTION-D', week, week.map(function () { return '休'; })) });
const gapDays = week.filter(function (date) { return date !== '2026-10-14'; });
writeBook(gapDailyB, 'Daily_AMZL_JP_Working_Hour_2026-10-18_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-D', gapDays, 10, '2026-10-18'),
});
writeBook(gapShiftB, '10月DAシフト.xlsx', { 'GDS': shiftSheet('TID-FICTION-D', gapDays, gapDays.map(function () { return '休'; })) });
runPair(gapDailyA, gapShiftA, historyGap, '2026-10-18');
const gap = runPair(gapDailyB, gapShiftB, historyGap, '2026-10-18');
assertPublic(gap);
assert(gap.verifyUndetermined === 1 && gap.resolvedByDaily === 0 && gap.stillAlert === 0, '7日窓の欠けは検証不能');

const later = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
const holdDailyA = path.join(base, 'hold-a');
const holdDailyB = path.join(base, 'hold-b');
const holdShiftA = path.join(base, 'hold-shift-a');
const holdShiftB = path.join(base, 'hold-shift-b');
const historyHold = path.join(base, 'history-hold.json');
[holdDailyA, holdDailyB, holdShiftA, holdShiftB].forEach(function (dir) { fs.mkdirSync(dir); });
writeBook(holdDailyA, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-E', week, 10),
});
writeBook(holdShiftA, '10月DAシフト.xlsx', { 'GDS': shiftSheet('TID-FICTION-E', week, week.map(function () { return '休'; })) });
writeBook(holdDailyB, 'Daily_AMZL_JP_Working_Hour_2026-10-18_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-E', later, 8, '2026-10-18'),
});
writeBook(holdShiftB, '11月DAシフト.xlsx', {
  'GDS': shiftSheet('TID-FICTION-E', ['2026-10-11'].concat(later), ['○'].concat(later.map(function () { return '休'; }))),
});
runPair(holdDailyA, holdShiftA, historyHold, '2026-10-18');
const held = runPair(holdDailyB, holdShiftB, historyHold, '2026-10-19');
assertPublic(held);
assert(held.reusedArchiveDays >= 1 && held.resolvedByDaily === 1 && held.stillAlert === 0, '期間外の過去日は保存済みの推定時間で再判定する');

const bareDaily = path.join(base, 'bare-daily');
const bareShift = path.join(base, 'bare-shift');
const historyBare = path.join(base, 'history-bare.json');
fs.mkdirSync(bareDaily);
fs.mkdirSync(bareShift);
History.commit({
  fs: fs,
  path: path,
  file: historyBare,
  logicId: 'seed-logic',
  logicVersion: History.RULE_VERSION,
  referenceDate: '2026-10-18',
  dailyHash: 'seed-daily',
  shiftHash: 'seed-shift',
  dailyFile: 'seed.xlsx',
  shiftFile: 'seed-shift.xlsx',
  predictions: [{
    subjectId: 'TID-FICTION-F',
    start: '2026-10-11',
    end: '2026-10-17',
    predictedTotal: 70,
    level: 'exceed',
    future: false,
    days: week.map(function (date) { return { date: date, hours: 10, origin: 'daily-estimate', future: false }; }),
  }],
  observations: [],
});
writeBook(bareDaily, 'Daily_AMZL_JP_Working_Hour_2026-10-18_(FICTION).xlsx', {
  'Report5_Daily_Data': dailySheet('TID-FICTION-F', later, 8, '2026-10-18'),
});
writeBook(bareShift, '11月DAシフト.xlsx', {
  'GDS': shiftSheet('TID-FICTION-F', ['2026-10-11'].concat(later), ['○'].concat(later.map(function () { return '休'; }))),
});
const bare = runPair(bareDaily, bareShift, historyBare, '2026-10-19');
assertPublic(bare);
assert(bare.reusedArchiveDays === 0 && bare.verifyUndetermined === 1 && bare.resolvedByDaily === 0 && bare.resolvedBySchedule === 0 && bare.resolvedByBoth === 0, '保存がない期間外の日は0にも予定にもしない');

const recoverFile = path.join(base, 'recover.json');
const originalBody = JSON.stringify({ version: 1, runs: [{ fingerprint: 'keep' }], dailyArchive: {} });
fs.writeFileSync(recoverFile, originalBody);
const wrapped = Object.assign({}, fs, {
  renameSync: function (from, to) {
    if (String(from).endsWith('.tmp') && String(to) === recoverFile) throw new Error('replace-failed');
    return fs.renameSync(from, to);
  },
});
let failed = false;
try {
  History.commit({
    fs: wrapped,
    path: path,
    file: recoverFile,
    logicId: 'new-logic',
    referenceDate: '2026-10-18',
    dailyHash: 'new-daily',
    shiftHash: 'new-shift',
    predictions: [],
    observations: [],
  });
} catch (e) {
  failed = true;
}
assert(failed === false, '保存失敗を計算結果の例外にしない');
assert(fs.readFileSync(recoverFile, 'utf8') === originalBody, '置換に失敗しても直前の履歴を戻す');

const shown = Collector.createCollector().summarize({
  details: {
    dailyFile: 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx',
    shiftFile: '10月DAシフト.xlsx',
    driverCount: 1,
    exceedCount: 1,
    resolvedBySchedule: 1,
    futureOpenWindows: 1,
    estimateCoveredWindows: 0,
    stillAlert: 0,
    verifyUndetermined: 0,
  },
  counts: { success: 2, failure: 0 },
});
assert(shown.indexOf('予定変更1') !== -1 && shown.indexOf('未来日が残る窓1') !== -1, '画面は解消理由と未来日の件数を出す');
assert(shown.indexOf('実績確定') === -1 && shown.indexOf('TID-') === -1, '画面に確定表示とIDを出さない');
const normalized = Collector.createCollector().normalize({
  status: 200,
  body: { ok: true, fileSuccess: 2, fileFailure: 0, driverCount: 1, confirmedActual: true, transportId: 'TID-SECRET', driverName: 'Fiction Driver' },
});
assert(normalized.details.confirmedActual === false, '応答が確定値を主張しても画面は確定にしない');
assert(JSON.stringify(normalized).indexOf('TID-SECRET') === -1 && JSON.stringify(normalized).indexOf('Fiction Driver') === -1, 'Collector状態にIDと氏名を残さない');

const ignore = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.gitignore'), 'utf8');
assert(ignore.indexOf('local/') !== -1, 'ローカル履歴ディレクトリをGit管理から外す');

console.log('harvest-rolling60h-history.test.mjs: ALL TESTS PASSED');
