import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Run = require('../harvest-rolling60h-run.js');
const Rolling = require('../rolling60h-core.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const Dash = require('../duty-risk-dashboard.js');
const Snap = require('../duty-risk-snapshot.js');
const Board = require('../rolling60h-local-board.js');
const Format = require('../duty-hours-format.js');
const Dispatch = require('../rolling60h-dispatch.js').bindCore(Rolling);
const XLSX = require('../node_modules/xlsx/xlsx.js');

// 2026-10-21 は水曜。窓の開始は6日前であり、日曜始まりの週ではない。
const days = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
const REF = '2026-10-21';
const header = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];
const MARU = '○';
const HACHI = '❽';

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

const rows = [
  ['GDS', '架空 基準', 'T-ANCHOR'].concat(Array(7).fill(MARU)),
  ['GDS', '架空 上限', 'T-BOUND'].concat([MARU, MARU, MARU, MARU, HACHI, '', MARU]),
  ['GDS', '架空 丁度', 'T-EXACT60'].concat(Array(7).fill(MARU)),
  ['GDS', '架空 重複', 'T-ONCE'].concat(Array(7).fill(MARU)),
  ['GDS', '架空 欠損', 'T-OPEN'].concat([MARU, '', MARU, MARU, MARU, MARU, MARU]),
];
const dailyRows = [header]
  .concat(daily('T-ANCHOR', [1, 1, 1, 1, 1, 1]))
  .concat(daily('T-BOUND', [11, 11, 11, 11, 8, null]))
  .concat(daily('T-EXACT60', [8, 8, 8, 8, 8, 9]))
  .concat(daily('T-ONCE', [8, 8, 8, 8, 8, 8]))
  .concat(daily('T-OPEN', [8, null, 8, 8, 8, 8]));

const executed = Run.capture({
  xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyRows, dailyFileName: 'Daily_FICTION.xlsx',
  shiftBook: shiftBook(rows), shiftFileName: 'shift_FICTION.xlsx',
  referenceDate: REF,
});
const board = Board.buildBoard({
  executed, referenceDate: REF, generatedAt: '2026-10-21T01:00:00.000Z',
  files: { shift: { name: 'shift_FICTION.xlsx', ok: true }, daily: { name: 'Daily_FICTION.xlsx', ok: true } },
  names: {
    'T-ANCHOR': '架空 基準',
    'T-BOUND': '架空 上限',
    'T-EXACT60': '架空 丁度',
    'T-ONCE': '架空 重複',
    'T-OPEN': '架空 欠損',
  },
}, { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf });
const byId = Object.fromEntries(board.rows.map((row) => [row.transportId, row]));

assert.equal(new Date(Date.UTC(2026, 9, 21)).getUTCDay(), 3, '基準日は水曜');
assert.equal(board.windowStart, '2026-10-15');
assert.notEqual(board.windowStart, '2026-10-18', '日曜始まりの固定週にしない');

const bound = byId['T-BOUND'];
assert.equal(bound.name, '架空 上限');
assert.notEqual(bound.name, byId['T-ONCE'].name);
assert.equal(bound.todayPlan, 11);
assert.equal(bound.past6.hours, 52);
assert.equal(bound.forecast.hours, 63);
assert.equal(bound.workable.hours, 8);
assert.equal(bound.knownOver, false, '空白は確定した休み(0h)。未確定ではないので knownOver は使わず、合計63hで超過予測');
assert.equal(bound.judgment, 'forecast-exceed');
assert.equal(bound.judgmentLabel, '超過予測');
assert.equal(bound.judgmentProvisional, false);
assert.equal(bound.judgment === 'ok', false);
assert.equal(bound.days[5].hours, 0);
assert.equal(bound.days[5].adopted, '休み');
assert.equal(bound.gaps.some((gap) => gap.date === '2026-10-20'), false);
assert.equal(Format.clockText(bound.past6.hours), '52:00');
assert.equal(Format.clockText(bound.forecast.hours), '63:00');
assert.equal(Format.clockText(bound.workable.hours), '08:00');
assert.equal(Format.clockText(bound.marginAfterPlan.hours), '-03:00');
assert.equal(Board.sortRows(board.rows, 'risk')[0].transportId, 'T-BOUND');

const exact = byId['T-EXACT60'];
assert.equal(exact.past6.hours, 49);
assert.equal(exact.todayPlan, 11);
assert.equal(exact.forecast.hours, 60);
assert.equal(exact.judgment, 'caution');
assert.equal(exact.judgment === 'forecast-exceed', false, '60時間ちょうどは超過にしない');
assert.equal(exact.status, 'approach');

const once = byId['T-ONCE'];
assert.equal(once.name, '架空 重複');
assert.equal(once.forecast.hours, 59, '同じ日の実績と予定を足さない');
assert.equal(once.past6.hours, 48);
const oncePred = executed.predictions.find((item) => item.subjectId === 'T-ONCE' && item.end === REF);
assert.equal(oncePred.days[0].hours, 8);
assert.equal(oncePred.days[0].origin, 'daily-estimate');

const open = byId['T-OPEN'];
assert.equal(open.judgment, 'ok');
assert.equal(open.judgmentLabel, '正常');
assert.equal(open.status === 'clear', true, '空白は確定した休み(0h)なのでエンジンも正常（旧: 未確定で非正常）');
assert.equal(open.forecast.hours, 51);
assert.equal(open.past6.hours, 40);
assert.equal(open.gaps.length, 0, '空白セルは欠損にしない');

function blocksFor(hoursList, blankAt) {
  const byDate = {};
  hoursList.forEach((hours, index) => {
    const date = days[index];
    if (index === blankAt) {
      byDate[date] = [{ code: 'BLANK', source: 'roster', hours: null, defined: false, blank: true }];
    } else if (typeof hours === 'number') {
      byDate[date] = [{ code: 'AMAZON_ESTIMATE', source: 'actual', hours: hours, defined: true }];
    }
  });
  byDate[days[6]] = Rolling.parseShiftCellToBlocks(MARU, 'roster').blocks;
  return byDate;
}
const knownSeries = Rolling.buildContinuousDailySeries(blocksFor([11, 11, 11, 11, 8, null], 5), days[0], days[6]);
const knownWindow = Rolling.computeRolling60h(knownSeries, { limitHours: 60, warningHours: 60 })[0];
assert.equal(knownWindow.judgment, 'undetermined');
assert.equal(knownWindow.over, false);
assert.equal(knownWindow.knownOver, true);
assert.equal(knownWindow.totalHours, 63);
assert.equal(knownWindow.knownOverBy, 3);

const gridBlocks = blocksFor([11, 11, 11, 11, 8, null], 5);
gridBlocks[days[5]] = [];
const gridWindow = Rolling.computeRolling60h(
  Rolling.buildContinuousDailySeries(gridBlocks, days[0], days[6]),
  { limitHours: 60, warningHours: 60 }
)[0];
assert.equal(gridWindow.judgment, 'exceed');
assert.equal(gridWindow.over, true);
assert.equal(gridWindow.totalHours, 63);
assert.equal(gridWindow.overBy, 3);

assert.equal(Format.clockText(8.25), '08:15');
assert.equal(Format.clockText(51 + 44 / 60), '51:44');
assert.equal(Format.clockText(62 + 44 / 60), '62:44');
assert.equal(Format.clockText(13 + 1 / 60), '13:01');
assert.equal(Format.clockText(null), '要確認');
['08:15', '51:44', '62:44', '13:01'].forEach((text) => {
  assert.equal(text.includes('.'), false);
  assert.equal(text.includes('\n'), false);
});

const ui = fs.readFileSync(new URL('../rolling60h-board-ui.js', import.meta.url), 'utf8');
assert.equal(ui.includes('算出不可'), false);
assert.ok(ui.includes('white-space:nowrap'));
assert.ok(ui.includes('clockText') || ui.includes('function clock'));
assert.ok(ui.includes('実績累計') && ui.includes('予定込み予測') && ui.includes('残り許容') && ui.includes('超過予測'));
assert.ok(ui.includes('data-detail'));
assert.ok(ui.includes('rolling-dispatch-host') === false);
assert.ok(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').includes('rolling-dispatch-host'));

function dayBlocks(date, hours, source) {
  return { [date]: [{ code: source === 'actual' ? 'AMAZON_ESTIMATE' : 'MARU', source: source, hours: hours, defined: true }] };
}
const today = '2026-10-21';
const tomorrow = '2026-10-22';
const actualMap = {};
const rosterMap = {};
for (let i = 0; i < 8; i += 1) {
  const date = Rolling.addDays('2026-10-15', i);
  Object.assign(actualMap, dayBlocks(date, 8, 'actual'));
  Object.assign(rosterMap, dayBlocks(date, 11, 'roster'));
}
const dispatch = Dispatch.assess({
  today: today,
  drivers: [{ transportId: 'T-DISPATCH', name: '架空 配車', actualBlocksByDate: actualMap, rosterBlocksByDate: rosterMap }],
});
assert.equal(dispatch.ok, true);
assert.equal(dispatch.drivers[0].today.status, 'within');
assert.equal(dispatch.drivers[0].name, '架空 配車');
const shortened = Dispatch.assess({
  today: today,
  drivers: [{
    transportId: 'T-DISPATCH',
    name: '架空 配車',
    actualBlocksByDate: actualMap,
    rosterBlocksByDate: rosterMap,
    todayHoursOverride: 20,
  }],
});
assert.equal(shortened.drivers[0].simulationStatus, 'applied');
assert.equal(shortened.drivers[0].simulatedTomorrow.status, 'exceed');
assert.equal(tomorrow, Rolling.addDays(today, 1));

console.log('rolling60h-forecast-miss.test.mjs: ALL PASSED');
