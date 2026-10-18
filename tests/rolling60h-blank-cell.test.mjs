import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Rolling = require('../rolling60h-core.js');
const Run = require('../harvest-rolling60h-run.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

const days = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];

function header() {
  return ['社名', '名前', 'Transport ID'].concat(days.map(function (iso) {
    const parts = iso.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }));
}

function writeBook(dir, name, sheets) {
  const wb = XLSX.utils.book_new();
  Object.keys(sheets).forEach(function (sheetName) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets[sheetName]), sheetName);
  });
  XLSX.writeFile(wb, path.join(dir, name));
}

function run(root, marks, historyFile) {
  const dailyDir = path.join(root, 'daily');
  const shiftDir = path.join(root, 'shift-' + Math.random().toString(16).slice(2));
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.mkdirSync(shiftDir);
  const rows = [['transporter_id', 'working_day', 'estimated_working_hour', 'station_code']];
  days.forEach(function (date) { rows.push(['TID-FICTION-BLANK', date, 1, 'OFK3']); });
  writeBook(dailyDir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', { Report5_Daily_Data: rows });
  writeBook(shiftDir, '10月DAシフト.xlsx', {
    GDS: [header(), ['GDS', 'Fiction Driver', 'TID-FICTION-BLANK'].concat(marks)],
  });
  return Run.run({
    fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyDir: dailyDir, shiftDir: shiftDir, historyFile: historyFile, referenceDate: '2026-10-18',
  });
}

const blank = Rolling.parseShiftCellToBlocks('', 'roster');
const rest = Rolling.parseShiftCellToBlocks('休', 'roster');
assert(blank.blocks.length === 0, '空白セルは勤務ブロックを作らない');
assert(rest.blocks.length === 1 && rest.blocks[0].code === 'KYU' && rest.blocks[0].hours === 0 && rest.blocks[0].defined === true, '休は0時間の明示記号');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-cell-'));
const hiddenHistory = path.join(root, 'hidden.json');
const hidden = run(root, ['○', '○', '○', '○', '○', null, null], hiddenHistory);
assert(hidden.clearCount === 1 && hidden.exceedCount === 0 && hidden.sent === false, '空白2日を0時間にすると5日×11時間は正常になる');
assert(JSON.stringify(hidden).indexOf('TID-FICTION') === -1, '応答にIDを出さない');
const revealed = run(root, ['○', '○', '○', '○', '○', '○', '○'], hiddenHistory);
assert(revealed.exceedCount === 1, '同じ2日が○なら77時間で超過');
assert(revealed.resolvedBySchedule === 0 && revealed.stillAlert === 0 && revealed.verifyUndetermined === 0, '正常だった空白からの記号入力は予定変更として照合されない');

const resolveHistory = path.join(root, 'resolve.json');
run(root, ['○', '○', '○', '○', '○', '○', null], resolveHistory);
const stored = JSON.parse(fs.readFileSync(resolveHistory, 'utf8'));
const origins = {};
stored.runs[0].predictions.forEach(function (item) {
  item.days.forEach(function (day) {
    origins[day.origin + ':' + day.hours] = (origins[day.origin + ':' + day.hours] || 0) + 1;
  });
});
assert(origins['roster-plan:11'] === 6 && origins['daily-estimate:0'] === 1, '空白は休ではなく推定0時間として履歴に残る');
const resolved = run(root, ['○', '○', '○', '○', '休', '休', '休'], resolveHistory);
assert(resolved.clearCount === 1 && resolved.verifyUndetermined === 1 && resolved.resolvedBySchedule === 0, '空白を含む超過が下がっても予定変更にならず検証不能になる');

console.log('rolling60h-blank-cell.test.mjs: ALL TESTS PASSED');
