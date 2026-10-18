import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Harvest = require('../harvest-daily-manifest.js');
const Rolling = require('../rolling60h-core.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

const header = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];

function dailyRows(tid, hoursByDate) {
  return [header].concat(Object.keys(hoursByDate).map(function (date) {
    return [tid, date, hoursByDate[date], 'OFK3'];
  }));
}

function writeBook(dir, name, sheets) {
  const wb = XLSX.utils.book_new();
  Object.keys(sheets).forEach(function (sheetName) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets[sheetName]), sheetName);
  });
  XLSX.writeFile(wb, path.join(dir, name));
}

const deps = { fs: fs, path: path, xlsx: XLSX, rolling: Rolling };

assert(Harvest.selectLatestDailyName(['notes.txt']).reason === 'no-daily-file', 'デイリー以外は選ばない');
const ambiguous = Harvest.selectLatestDailyName([
  'Daily_AMZL_JP_Working_Hour_2026-10-17_(A).xlsx',
  'Daily_AMZL_JP_Working_Hour_2026-10-17_(B).xlsx',
]);
assert(ambiguous.reason === 'ambiguous-latest' && ambiguous.judgment === 'undetermined', '同じ日付が2件なら判定不能');
const latest = Harvest.selectLatestDailyName([
  'Daily_AMZL_JP_Working_Hour_2026-10-16_(A).xlsx',
  'Daily_AMZL_JP_Working_Hour_2026-10-17_(A).xlsx',
]);
assert(latest.ok && latest.date === '2026-10-17', 'ファイル名の日付が新しい方を選ぶ');

const missing = Harvest.loadFromDirectory(path.join(os.tmpdir(), 'harvest-missing-' + Date.now()), deps);
assert(missing.reason === 'source-unavailable' && missing.judgment === 'undetermined', 'フォルダが無いときは判定不能');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-daily-'));
const hours = {};
['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'].forEach(function (date) {
  hours[date] = 10;
});
writeBook(dir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  '貼付': [['legacy']],
  'Report5_Daily_Data': dailyRows('TID-FICTION-1', hours),
});
writeBook(dir, 'Daily_AMZL_JP_Working_Hour_2026-10-16_(FICTION).xlsx', {
  'Report5_Daily_Data': dailyRows('TID-OLD', { '2026-10-10': 1 }),
});

const loaded = Harvest.loadAndEvaluate(dir, deps);
assert(loaded.ok && loaded.file.indexOf('2026-10-17') !== -1, '最新のマニフェストファイルを読む');
assert(loaded.sheet === 'Report5_Daily_Data', 'Report5を読む');
assert(loaded.pasteIgnored === true, '貼付があってもReport5を正とする');
assert(loaded.hoursKind === 'estimated_working_hour', '時間の種類は推定のまま');
assert(loaded.drivers.length === 1 && loaded.drivers[0].transportId === 'TID-FICTION-1', '架空IDだけを対象にする');
assert(loaded.drivers[0].windows.length === 1, '揃った7日は1窓');
assert(loaded.drivers[0].windows[0].judgment === 'exceed', '10h×7は超過');
assert(loaded.drivers[0].windows[0].totalHours === 70, '推定時間の合計は70');

const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-short-'));
writeBook(shortDir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', {
  '貼付': dailyRows('TID-FICTION-2', hours),
});
const pasteOnly = Harvest.loadFromDirectory(shortDir, deps);
assert(pasteOnly.ok === false && pasteOnly.reason === 'report5-missing' && pasteOnly.pasteIgnored === true, '貼付だけのブックは正式データにしない');

const gapRows = dailyRows('TID-FICTION-3', {
  '2026-10-12': 10,
  '2026-10-13': 10,
  '2026-10-14': 10,
  '2026-10-15': 10,
  '2026-10-16': 10,
  '2026-10-17': 10,
});
const gap = Harvest.evaluateRows(gapRows, Rolling);
assert(gap.drivers[0].windows.length === 0 && gap.drivers[0].judgment === 'undetermined', '6日しか無い期間は判定不能');

const conflictRows = [header,
  ['TID-FICTION-4', '2026-10-11', 10, 'OFK3'],
  ['TID-FICTION-4', '2026-10-11', 12, 'OFK3'],
  ['TID-FICTION-4', '2026-10-12', 10, 'OFK3'],
  ['TID-FICTION-4', '2026-10-13', 10, 'OFK3'],
  ['TID-FICTION-4', '2026-10-14', 10, 'OFK3'],
  ['TID-FICTION-4', '2026-10-15', 10, 'OFK3'],
  ['TID-FICTION-4', '2026-10-16', 10, 'OFK3'],
  ['TID-FICTION-4', '2026-10-17', 10, 'OFK3'],
];
const conflict = Harvest.evaluateRows(conflictRows, Rolling);
assert(conflict.drivers[0].windows[0].judgment === 'undetermined', '同じ日の推定時間が食い違う窓は判定不能');
assert(conflict.drivers[0].windows[0].over === false, '食い違いを合算して超過にしない');

console.log('harvest-daily-manifest.test.mjs: ALL TESTS PASSED');
