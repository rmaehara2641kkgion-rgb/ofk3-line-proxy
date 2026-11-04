// The reference date the rolling run actually used is handed to INO-1 (separate from checkedAt).
// Fictional data only.
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
const View = require('../inoichi-rolling-view.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

const MARU = '○';
const KYU = '休';
const header = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];
const dates = [];
for (let d = '2026-10-01'; d <= '2026-10-30'; d = Rolling.addDays(d, 1)) dates.push(d);
const fill = (a, b, v) => Object.fromEntries(dates.filter((d) => d >= a && d <= b).map((d) => [d, v]));
const people = [
  { id: 'R-PAST', name: '架空 過去', cells: fill('2026-10-01', '2026-10-07', MARU) },
  { id: 'R-FUTURE', name: '架空 将来', cells: fill('2026-10-24', '2026-10-30', MARU) },
  { id: 'R-LOW', name: '架空 低', cells: fill('2026-10-22', '2026-10-23', MARU) },
];
function book() {
  const head = ['社名', '名前', 'Transport ID'].concat(dates.map((iso) => {
    const p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }));
  const rows = people.map((p) => ['GDS', p.name, p.id].concat(dates.map((d) => (p.cells[d] != null ? p.cells[d] : KYU))));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head].concat(rows)), 'GDS');
  return wb;
}
function capture(extra) {
  return Run.capture(Object.assign({
    xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyRows: [header, ['R-LOW', '2026-10-20', 8, 'OFK3']], dailyFileName: 'Daily_FICTION.xlsx',
    shiftBook: book(), shiftFileName: 'shift_FICTION.xlsx',
  }, extra));
}
const jstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const deps = { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf };

// 1. normal same-day run: the date the run used (today in JST), distinct from checkedAt
const before = jstToday();
const today = capture({});
const after = jstToday();
assert.ok(today.referenceDate === before || today.referenceDate === after);
assert.match(today.referenceDate, /^\d{4}-\d{2}-\d{2}$/);
assert.equal('referenceDate' in today.summary, false, 'summary shape is unchanged (backward compatible)');

// 2. a past reference date given by hand is returned as is, and checkedAt stays the execution time
const past = capture({ referenceDate: '2026-10-20' });
assert.equal(past.referenceDate, '2026-10-20');
assert.notEqual(String(past.summary.checkedAt).slice(0, 10), past.referenceDate);

// 3. crossing midnight: the run keeps the date it started with even though checkedAt is on a later date
const midnight = capture({ referenceDate: '2026-10-26' });
midnight.summary.checkedAt = '2026-10-26T15:05:00.000Z'; // 2026-10-27 00:05 JST
const snapMid = Snap.buildSnapshot(midnight, null);
assert.equal(snapMid.horizon.referenceDate, '2026-10-26');
assert.equal(snapMid.horizon.referenceDateSource, 'run');
assert.equal(snapMid.horizon.windowEnd, '2026-10-26');

// 4. missing / malformed reference: unknown, never guessed
assert.equal(Run.capture({}).referenceDate, null);
assert.equal(capture({ referenceDate: 'not-a-date' }).referenceDate, null);
assert.equal(capture({ referenceDate: '2026-02-30' }).referenceDate, null);
const unknown = capture({ referenceDate: '2026-02-30' });
const snapUnknown = Snap.buildSnapshot(unknown, null);
assert.equal(snapUnknown.horizon.unavailable, true);
assert.equal(snapUnknown.horizon.referenceDate, null);
assert.equal(snapUnknown.referenceDate, null);
snapUnknown.alerts.forEach((row) => {
  assert.equal(row.disposition, 'undetermined', 'no current judgment without a reference date');
  assert.notEqual(row.statusLabel.indexOf('基準日不明'), -1);
});
assert.ok(!snapUnknown.alerts.some((r) => r.disposition === 'exceed' || r.disposition === 'approach' || r.disposition === 'future-exceed'));
// an old caller that passes no reference date at all behaves the same
const legacyCaptured = { summary: unknown.summary, drivers: unknown.drivers, predictions: unknown.predictions };
assert.equal(Snap.buildSnapshot(legacyCaptured, null).horizon.unavailable, true);
// checkedAt alone never becomes the reference
assert.equal(View.build({ summary: { ok: true, fileSuccess: 2, fileFailure: 0, checkedAt: '2026-10-27T01:00:00.000Z' }, drivers: [], predictions: [] }).horizon.referenceDate, null);

// 5. FRIDAY counts and OFK3 board untouched by handing the date over
const REF = '2026-10-27';
const run = capture({ referenceDate: REF });
const snap = Snap.buildSnapshot(run, null);
['driverCount', 'clearCount', 'exceedCount', 'approachCount', 'partialCount', 'undeterminedCount'].forEach((k) => {
  assert.equal(snap.counts[k], run.summary[k], k);
  assert.equal(snapUnknown.counts[k], unknown.summary[k], k + ' (unknown reference)');
});
const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
const board = Board.buildBoard({ executed: run, referenceDate: REF, generatedAt: '2026-10-27T01:00:00.000Z', files: { shift: { name: 's', ok: true }, daily: { name: 'd', ok: true } }, names, actualDays: [] }, deps);
assert.equal(board.counts.exceed, run.summary.exceedCount);
assert.equal(board.counts.clear, run.summary.clearCount);

// 6. past / current / future with the handed-over date, matching the OFK3 board
const rowOf = Object.fromEntries(snap.alerts.map((a) => [a.transportId, a]));
const ofk = Object.fromEntries(board.rows.map((r) => [r.transportId, r]));
assert.equal(ofk['R-PAST'].judgment, 'ok');
assert.equal(rowOf['R-PAST'], undefined);
assert.ok(snap.horizon.pastExceeds.some((x) => x.transportId === 'R-PAST'));
assert.equal(ofk['R-FUTURE'].judgment, 'ok');
assert.equal(rowOf['R-FUTURE'].disposition, 'future-exceed');
assert.equal(ofk['R-LOW'].judgment, 'ok');
assert.equal(rowOf['R-LOW'], undefined);
// the same people seen from an earlier date: the future shifts into/out of "current" consistently
const early = capture({ referenceDate: '2026-10-07' });
const snapEarly = Snap.buildSnapshot(early, null);
const earlyRows = Object.fromEntries(snapEarly.alerts.map((a) => [a.transportId, a]));
assert.equal(snapEarly.horizon.referenceDate, '2026-10-07');
assert.equal(earlyRows['R-PAST'].period, 'current');
assert.equal(earlyRows['R-PAST'].judgmentCode, 'forecast-exceed');
assert.equal(earlyRows['R-FUTURE'].period, 'future');

console.log('harvest-reference-date.test.mjs: ALL PASSED');
