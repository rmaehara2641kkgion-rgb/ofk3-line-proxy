import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Run = require('../harvest-rolling60h-run.js');
const Rolling = require('../rolling60h-core.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const Dash = require('../duty-risk-dashboard.js');
const Snap = require('../duty-risk-snapshot.js');
const Board = require('../rolling60h-local-board.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

const days = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
const REF = '2026-10-21';
const header = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];
const MARU = '○';
const KYU = '休';

function shiftBook(rows) {
  const head = ['社名', '名前', 'Transport ID'].concat(days.map((iso) => {
    const p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head].concat(rows)), 'GDS');
  return wb;
}

function daily(tid, hours) {
  return hours.map((h, i) => (h == null ? null : [tid, days[i], h, 'OFK3'])).filter(Boolean);
}

function row(id, cells) {
  return ['GDS', id, id].concat(cells);
}

const shiftRows = [
  row('T-BLANK', Array(7).fill('')),
  row('T-KYU', Array(7).fill(KYU)),
  row('T-MIX', [KYU, '', MARU, MARU, MARU, MARU, MARU]),
  row('T-SYMBOL', [MARU, 'C2', MARU, MARU, MARU, MARU, MARU]),
  row('T-OVER', [MARU, MARU, MARU, MARU, '❽', '', MARU]),
  row('T-EXACT', [MARU, MARU, MARU, MARU, MARU, KYU, MARU]),
  row('T-ACTUAL', ['', '', '', '', '', '', '']),
  row('T-ANCHOR', Array(7).fill(MARU)),
];
const dailyRows = [header]
  .concat(daily('T-MIX', [null, null, 8, 8, 8, 8]))
  .concat(daily('T-SYMBOL', [8, null, 8, 8, 8, 8]))
  .concat(daily('T-OVER', [11, 11, 11, 11, 8, null]))
  .concat(daily('T-EXACT', [10, 10, 10, 10, 9, null]))
  .concat(daily('T-ACTUAL', [8, 8, 8, 8, 8, 8]))
  .concat(daily('T-MISSING', [8, 8, 8]));

const executed = Run.capture({
  xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyRows, dailyFileName: 'Daily_FICTION.xlsx',
  shiftBook: shiftBook(shiftRows), shiftFileName: 'shift_FICTION.xlsx',
  referenceDate: REF,
});
const before = JSON.parse(JSON.stringify(executed.predictions.filter((item) => item.end === REF).map((item) => ({
  id: item.subjectId,
  total: item.predictedTotal,
  level: item.level,
  origins: item.days.map((day) => day.origin),
}))));
const board = Board.buildBoard({
  executed, referenceDate: REF, generatedAt: '2026-10-21T01:00:00.000Z',
  files: { shift: { name: 'shift_FICTION.xlsx', ok: true }, daily: { name: 'Daily_FICTION.xlsx', ok: true } },
  names: {},
}, { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf });
const byId = Object.fromEntries(board.rows.map((item) => [item.transportId, item]));
const after = executed.predictions.filter((item) => item.end === REF).map((item) => ({
  id: item.subjectId,
  total: item.predictedTotal,
  level: item.level,
  origins: item.days.map((day) => day.origin),
}));

assert.deepEqual(after, before, '一覧の休み解釈はエンジンの予測を書き換えない');
assert.equal(executed.summary.exceedCount + executed.summary.approachCount + executed.summary.partialCount + executed.summary.undeterminedCount + executed.summary.clearCount, executed.summary.driverCount);
assert.equal(board.counts.exceed, executed.summary.exceedCount);
assert.equal(board.counts.clear, executed.summary.clearCount, 'FRIDAYへ渡す人数区分はエンジンのまま');

const blank = byId['T-BLANK'];
assert.equal(blank.judgment, 'ok');
assert.equal(blank.forecast.hours, 0);
assert.equal(blank.past6.hours, 0);
assert.equal(blank.workable.hours, 60);
assert.equal(blank.gaps.length, 0);
assert.ok(blank.days.every((day) => day.hours === 0 && day.adopted === '休み'));
assert.equal(blank.status, 'clear', '空白は確定した休み(0h)。エンジンも欠損にしない（旧: 未確定で非正常）');

const kyu = byId['T-KYU'];
assert.equal(kyu.judgment, 'ok');
assert.equal(kyu.forecast.hours, 0);
assert.equal(kyu.gaps.length, 0);
assert.ok(kyu.days.every((day) => day.hours === 0));

const mix = byId['T-MIX'];
assert.equal(mix.past6.hours, 32);
assert.equal(mix.todayPlan, 11);
assert.equal(mix.forecast.hours, 43);
assert.equal(mix.workable.hours, 28);
assert.equal(mix.judgment, 'ok');
assert.equal(mix.gaps.length, 0);
assert.equal(mix.days[0].hours, 0);
assert.equal(mix.days[1].adopted, '休み');
assert.equal(mix.days[2].adopted, '実績（Amazon推定）');

const symbol = byId['T-SYMBOL'];
assert.equal(symbol.judgment, 'review');
assert.equal(symbol.judgmentLabel, '要確認');
assert.equal(symbol.forecast.hours, null);
assert.ok(symbol.gaps.some((gap) => gap.date === '2026-10-16'));

const over = byId['T-OVER'];
assert.equal(over.past6.hours, 52);
assert.equal(over.forecast.hours, 63);
assert.equal(over.workable.hours, 8);
assert.equal(over.judgment, 'forecast-exceed');
assert.equal(over.days[5].hours, 0);
assert.equal(over.gaps.length, 0);

const exact = byId['T-EXACT'];
assert.equal(exact.past6.hours, 49);
assert.equal(exact.todayPlan, 11);
assert.equal(exact.forecast.hours, 60);
assert.equal(exact.judgment, 'caution');
assert.equal(exact.judgment === 'forecast-exceed', false);
assert.equal(exact.days[5].hours, 0);
assert.equal(exact.gaps.length, 0);

const actual = byId['T-ACTUAL'];
assert.equal(actual.past6.hours, 48);
assert.equal(actual.days[0].hours, 8);
assert.equal(actual.days[0].adopted, '実績（Amazon推定）');
assert.equal(actual.judgment, 'ok');

const missing = byId['T-MISSING'];
assert.equal(missing.judgment, 'review');
assert.equal(missing.judgmentLabel, '要確認');
assert.equal(missing.forecast.hours, null);
assert.ok(missing.gaps.some((gap) => gap.reason.indexOf('7日窓') >= 0));

const blankBlocks = {};
days.forEach((date, index) => {
  blankBlocks[date] = index === 5
    ? [{ code: 'BLANK', source: 'roster', hours: null, defined: false, blank: true }]
    : [{ code: 'AMAZON_ESTIMATE', source: 'actual', hours: index === 4 ? 8 : 11, defined: true }];
});
blankBlocks[days[6]] = Rolling.parseShiftCellToBlocks(MARU, 'roster').blocks;
const engineWindow = Rolling.computeRolling60h(
  Rolling.buildContinuousDailySeries(blankBlocks, days[0], days[6]),
  { limitHours: 60, warningHours: 60 }
)[0];
assert.equal(engineWindow.judgment, 'undetermined');
assert.equal(engineWindow.over, false);
assert.equal(engineWindow.knownOver, true);
assert.equal(engineWindow.totalHours, 63);

console.log('rolling60h-rest-not-missing.test.mjs: ALL PASSED');
