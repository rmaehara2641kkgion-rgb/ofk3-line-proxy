import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Rolling = require('../rolling60h-core.js');
const Run = require('../harvest-rolling60h-run.js');
const History = require('../harvest-rolling60h-history.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

// 架空データのみ。10-25 の列は全員空白（有効期間外候補）。
const days = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];

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

const N = null;
const M = '○';
const R = '休';
const H = '❽';

function scenario(overrides) {
  const marks = {
    'TID-FICTION-EXC': [M, M, M, M, M, M, M, N],
    'TID-FICTION-REST': [R, R, R, R, R, R, R, N],
    'TID-FICTION-OK55': [M, M, M, M, M, R, R, N],
    'TID-FICTION-B55': [M, M, M, M, M, N, N, N],
    'TID-FICTION-C66': [M, M, M, M, M, M, N, N],
    'TID-FICTION-REST6': [R, R, R, R, R, R, N, N],
    'TID-FICTION-DAILYFIX': [M, M, M, M, R, R, N, N],
    'TID-FICTION-X': [M, M, M, M, M, M, M, N],
    'TID-FICTION-APP60': [M, M, M, M, H, H, R, N],
  };
  Object.keys(overrides || {}).forEach(function (tid) { marks[tid] = overrides[tid]; });
  return marks;
}

function run(root, tag, marks, historyFile) {
  const dailyDir = path.join(root, 'daily');
  const shiftDir = path.join(root, 'shift-' + tag);
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.mkdirSync(shiftDir);
  // デイリーは空白のシフト日にだけ有効な時間を持つ（DAILYFIX は 10-24 に20h、X は期間外候補の 10-25 に5h）。
  const rows = [['transporter_id', 'working_day', 'estimated_working_hour', 'station_code']];
  rows.push(['TID-FICTION-DAILYFIX', '2026-10-24', 20, 'OFK3']);
  rows.push(['TID-FICTION-X', '2026-10-25', 5, 'OFK3']);
  writeBook(dailyDir, 'Daily_AMZL_JP_Working_Hour_2026-10-17_(FICTION).xlsx', { Report5_Daily_Data: rows });
  const sheet = [header()];
  Object.keys(marks).forEach(function (tid, index) {
    sheet.push(['GDS', 'Fiction Driver ' + index, tid].concat(marks[tid]));
  });
  writeBook(shiftDir, '10月DAシフト.xlsx', { GDS: sheet });
  return Run.run({
    fs: fs, path: path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyDir: dailyDir, shiftDir: shiftDir, historyFile: historyFile, referenceDate: '2026-10-18',
  });
}

function exclusive(summary) {
  return summary.clearCount + summary.exceedCount + summary.approachCount + summary.partialCount + summary.undeterminedCount === summary.driverCount;
}

// 1. 空白と休の区別（パーサ層）
const blank = Rolling.parseShiftCellToBlocks('', 'roster');
const rest = Rolling.parseShiftCellToBlocks('休', 'roster');
assert(blank.blocks.length === 0, '空白セルは勤務ブロックを作らない');
assert(rest.blocks.length === 1 && rest.blocks[0].code === 'KYU' && rest.blocks[0].hours === 0 && rest.blocks[0].defined === true, '休は0時間の明示記号');

// 2. 日付列の判定（コア層）
const resolved = Rolling.resolveRosterBlanks({
  a: { '2026-10-01': [{ code: 'MARU', hours: 11, defined: true, source: 'roster' }], '2026-10-02': [] },
  b: { '2026-10-01': [], '2026-10-02': [] },
});
assert(resolved.outsideDates.join() === '2026-10-02' && resolved.mixedDates.join() === '2026-10-01', '全員空白の列は期間外候補、記号が混在する列は未確定');
assert(resolved.byTid.a['2026-10-02'] === undefined && resolved.byTid.b['2026-10-02'] === undefined, '期間外候補の日は0hのレコードにしない');
assert(resolved.byTid.b['2026-10-01'][0].blank === true && resolved.byTid.b['2026-10-01'][0].hours === null, '混在列の空白は未確定ブロック');

// 3. 7日窓: 未確定を含む窓は正常にしない。確定分だけで60h超なら危険情報を保持
const confirmed = [M, M, M, M, M, M].map(function (code) { return Rolling.parseShiftCellToBlocks(code, 'roster').blocks; });
const pending = { 'x': 1 };
const blanks = Rolling.resolveRosterBlanks({ a: { d7: [] }, b: { d7: [{ code: 'MARU', hours: 11, defined: true, source: 'roster' }] } }).byTid.a.d7;
function series(sevenBlocks) {
  const byDate = {};
  sevenBlocks.forEach(function (blocks, i) { byDate[Rolling.addDays('2026-10-01', i)] = blocks; });
  return Rolling.buildContinuousDailySeries(byDate, '2026-10-01', '2026-10-07');
}
const known55 = Rolling.computeRolling60h(series(confirmed.slice(0, 5).concat([blanks, blanks])), { limitHours: 60, warningHours: 60 })[0];
assert(known55.judgment === 'undetermined' && known55.over === false && known55.knownOver === false && known55.totalHours === 55, '確定55hと未確定2日は正常にも超過にもしない');
const known66 = Rolling.computeRolling60h(series(confirmed.concat([blanks])), { limitHours: 60, warningHours: 60 })[0];
assert(known66.judgment === 'undetermined' && known66.over === false, '未確定を含む窓の判定は未確定のまま');
assert(known66.knownOver === true && known66.knownOverBy === 6 && known66.unconfirmedDates.length === 1, '確定66hは危険内訳(超過6h・未確定日)として保持');
void pending;

// 4. 有効なデイリー時間はシフトの空白より優先（日付が未来でも）
const merged = Rolling.mergeActualAndRoster(
  { '2026-10-24': [{ code: 'AMAZON_ESTIMATE', source: 'actual', hours: 20, defined: true }] },
  { '2026-10-24': blanks, '2026-10-26': blanks },
  '2026-10-18'
);
assert(merged['2026-10-24'][0].source === 'actual' && merged['2026-10-26'][0].blank === true, '空白はデイリーがある日だけデイリーに置き換わる');
const symbolWins = Rolling.mergeActualAndRoster(
  { '2026-10-24': [{ code: 'AMAZON_ESTIMATE', source: 'actual', hours: 20, defined: true }] },
  { '2026-10-24': [{ code: 'KYU', source: 'roster', hours: 0, defined: true }] },
  '2026-10-18'
);
assert(symbolWins['2026-10-24'][0].code === 'KYU', '勤務記号がある未来日は従来どおり予定優先');

// 5. 一括実行: 分類・排他性・人数合計
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-cell-'));
const historyFile = path.join(root, 'history.json');
const first = run(root, 'a', scenario(), historyFile);
assert(first.driverCount === 9, '対象者数は変わらない');
assert(first.exceedCount === 3, '超過: 77h / デイリー優先で64h / 期間外候補日の過去デイリー込み');
assert(first.approachCount === 1 && first.clearCount === 2, '接近60hと正常(休のみ・55h確定)');
assert(first.partialCount === 1 && first.partialKnownOverCount === 1, '確定66hは部分欠損の危険内訳');
assert(first.undeterminedCount === 2, '空白を含む確定55h・休6日は完全判定不能');
assert(exclusive(first), '5分類は排他で人数合計が対象者数と一致する');
assert(first.blankUnconfirmedPersonDays === 5, '混在列の空白(人日)を未確定として数える');
assert(first.outsidePeriodDateCount === 1 && first.outsidePeriodKeptByDailyDays === 1, '全員空白の列は期間外候補。過去デイリーのある日は除外しない');
assert(first.knownOverWindows === 1, '危険内訳の窓数');
assert(first.logicVersion === 'rolling60h-predict-3' && first.sent === false && first.channel === 'dry-run', '計算バージョンを更新し、dry-runのまま');
assert(JSON.stringify(first).indexOf('TID-') === -1, '応答にIDを出さない');

// 6. 履歴: 旧版の履歴を削除せず、新バージョンを追加して区別する
const stored1 = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
assert(stored1.runs.length === 1 && stored1.runs[0].logicVersion === 'rolling60h-predict-3', '新版の履歴として保存');
const legacy = { fingerprint: 'legacy-fp', logicId: 'legacy', logicVersion: 'rolling60h-predict-2', referenceDate: '2026-10-17', predictedAt: '2026-10-17T00:00:00.000Z', sources: {}, predictions: [] };
const legacyFile = path.join(root, 'legacy-history.json');
fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, runs: [legacy], dailyArchive: { 'TID-FICTION-EXC\t2026-10-01': { hours: 3, dailyHash: 'h', snapshotDate: '', conflict: false } } }));
const withLegacy = run(root, 'legacy', scenario(), legacyFile);
const stored2 = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
assert(stored2.runs.length === 2 && JSON.stringify(stored2.runs[0]) === JSON.stringify(legacy), '旧版の履歴は削除・改変しない');
assert(stored2.runs[1].logicVersion === 'rolling60h-predict-3' && stored2.dailyArchive['TID-FICTION-EXC\t2026-10-01'].hours === 3, '新版を追記し、日次アーカイブも残す');
assert(withLegacy.historyRuns === 2 && withLegacy.blankFilledWindows === 0 && withLegacy.stillAlert === 0, '旧版(空白=0h)の履歴とは比較しない');
const prior = stored1.runs[0].predictions.filter(function (p) { return p.subjectId === 'TID-FICTION-C66'; })[0];
assert(prior.knownOver === true && prior.knownOverBy === 6 && prior.unconfirmedDates.join() === '2026-10-24', '履歴に危険内訳を保持');
assert(JSON.stringify(stored1.runs[0].predictions).indexOf('"origin":"roster-unconfirmed"') !== -1, '空白は休(roster-plan 0h)ではなく未確定として履歴に残る');

// 7. 空白→勤務記号を予定変更として追跡。正常→超過も追跡
const filled = run(root, 'b', scenario({
  'TID-FICTION-B55': [M, M, M, M, M, M, M, N],
  'TID-FICTION-REST': [M, M, M, M, M, M, M, N],
}), historyFile);
assert(filled.blankFilledWindows >= 1 && filled.blankFilledPersons >= 1 && filled.blankFilledToAlertWindows >= 1, '空白から勤務記号への変化を予定変更として検出');
assert(filled.normalToExceedWindows === 1 && filled.normalToExceedBySchedule === 1 && filled.normalToExceedByDaily === 0, '正常から超過への変化を予定変更として追跡');
assert(filled.exceedCount === 5 && exclusive(filled), '変更後も5分類は排他');
assert(JSON.parse(fs.readFileSync(historyFile, 'utf8')).runs.length === 2, '履歴は追記される');

// 8. ドライラン: 未確定窓は通知候補にせず、危険内訳だけを別に返す
const drivers = [{ transportId: 'TID-FICTION-C66', windows: [known66] }];
const dry = DryRun.fromDrivers(drivers);
assert(dry.sent === false && dry.alerts.length === 0, '未確定窓は通知候補にしない');
assert(dry.undetermined[0].reason === 'unconfirmed-blank' && dry.dangerBreakdown.length === 1 && dry.dangerBreakdown[0].knownOverBy === 6, '危険内訳を別枠で返す');

console.log('rolling60h-blank-cell.test.mjs: ALL TESTS PASSED');
