// OFK3 duty-risk tab: the future-exceed helper warning must survive INO-1's period split.
// Fictional data. EXPECTED_MAIN_ROW is the row the pre-PR main produced for the same input (captured on main 3cb0e1f).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Run = require('../harvest-rolling60h-run.js');
const Rolling = require('../rolling60h-core.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const Dash = require('../duty-risk-dashboard.js');
const Snap = require('../duty-risk-snapshot.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

const REF = '2026-10-27';
const MARU = '○';
const dates = [];
for (let d = '2026-10-01'; d <= '2026-10-30'; d = Rolling.addDays(d, 1)) dates.push(d);
const fill = (a, b, v) => Object.fromEntries(dates.filter((d) => d >= a && d <= b).map((d) => [d, v]));
const people = [
  { id: 'F-PAST', cells: fill('2026-10-01', '2026-10-07', MARU) },
  { id: 'F-CURRENT', cells: { '2026-10-27': MARU } },
  { id: 'F-FUTURE', cells: fill('2026-10-24', '2026-10-30', MARU) },
  { id: 'F-BOTH', cells: Object.assign(fill('2026-10-01', '2026-10-07', MARU), fill('2026-10-24', '2026-10-30', MARU)) },
  { id: 'F-ACTUAL', cells: {} },
  { id: 'F-EXACT', cells: { '2026-10-27': MARU } },
  { id: 'F-CURFUT', cells: Object.assign({ '2026-10-27': MARU }, fill('2026-10-28', '2026-10-30', MARU)) },
];
const run = (id, start, list) => list.map((hours, i) => ['F-' + id, Rolling.addDays(start, i), hours, 'OFK3']);
const daily = [['transporter_id', 'working_day', 'estimated_working_hour', 'station_code']].concat(
  run('CURRENT', '2026-10-21', [8, 8, 8, 8, 8, 10]),
  run('ACTUAL', '2026-10-21', [11, 11, 11, 11, 11, 11]),
  run('EXACT', '2026-10-21', [8, 8, 8, 8, 8, 9]),
  run('CURFUT', '2026-10-21', [8, 8, 8, 8, 8, 10]),
);
function book() {
  const head = ['社名', '名前', 'Transport ID'].concat(dates.map((iso) => {
    const p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }));
  const rows = people.map((p) => ['GDS', '架空 ' + p.id, p.id].concat(dates.map((d) => (p.cells[d] != null ? p.cells[d] : '休'))));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head].concat(rows)), 'GDS');
  return wb;
}
function view(referenceDate, mutate) {
  const cap = Run.capture({ xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun, dailyRows: daily, dailyFileName: 'd.xlsx', shiftBook: book(), shiftFileName: 's.xlsx', referenceDate });
  const snap = JSON.parse(JSON.stringify(Snap.buildSnapshot(cap, null)));
  if (mutate) mutate(snap);
  const hist = { runs: [{ predictedAt: cap.summary.checkedAt, referenceDate: referenceDate || REF, predictions: cap.predictions }] };
  return { snap, view: Dash.buildView(snap, hist, null), cap };
}
const futureOf = (v, id) => v.view.future.filter((r) => r.transportId === id);

const base = view(REF);
assert.equal(base.view.ok, true);

// the audited case: a future-only 77:00 window must give exactly the row main produced
const EXPECTED_MAIN_ROW = {
  name: '氏名未照合', transportId: 'F-FUTURE', transportNote: '', windowLabel: '2026-10-24 〜 2026-10-30',
  startDate: '2026-10-24', endDate: '2026-10-30', totalHours: 77, overBy: 17, actualHours: 0, rosterHours: 77,
};
assert.deepEqual(futureOf(base, 'F-FUTURE'), [EXPECTED_MAIN_ROW]);

// past-only, current exceed, actual exceed, exactly 60:00 produce no future warning
['F-PAST', 'F-CURRENT', 'F-ACTUAL', 'F-EXACT'].forEach((id) => assert.deepEqual(futureOf(base, id), [], id));
// past + future: only the future window is warned, once
const both = futureOf(base, 'F-BOTH');
assert.equal(both.length, 1);
assert.equal(both[0].startDate, '2026-10-24');
assert.equal(both[0].totalHours, 77);
// current exceed that also has a later exceeding window: the later one is still warned, once, with the engine's numbers
const curfut = futureOf(base, 'F-CURFUT');
assert.equal(curfut.length, 1);
assert.equal(curfut[0].endDate > REF, true);
const engineWin = base.cap.drivers.find((d) => d.transportId === 'F-CURFUT').windows
  .filter((w) => w.endDate > REF && w.judgment === 'exceed').sort((a, b) => (b.totalHours - a.totalHours) || (a.endDate < b.endDate ? -1 : 1))[0];
assert.equal(curfut[0].totalHours, engineWin.totalHours);
assert.equal(curfut[0].endDate, engineWin.endDate);

// the helper list is the same set of people as before the split: a legacy-shaped alert yields the identical row
const legacyShaped = view(REF, (snap) => {
  snap.alerts.forEach((a) => { if (a.disposition === 'future-exceed') { a.disposition = 'exceed'; a.basis = 'forecast'; } });
});
assert.deepEqual(futureOf(legacyShaped, 'F-FUTURE'), [EXPECTED_MAIN_ROW]);

// no double counting: legacy + new + nested forms of the same person/window collapse to one row
const dup = view(REF, (snap) => {
  const f = snap.alerts.find((a) => a.transportId === 'F-FUTURE');
  snap.alerts.push(Object.assign({}, f, { disposition: 'exceed', basis: 'forecast' }));
  snap.alerts.push(Object.assign({}, f));
  const c = snap.alerts.find((a) => a.transportId === 'F-CURFUT');
  snap.alerts.push(Object.assign({}, c)); // the same current row twice
});
assert.equal(futureOf(dup, 'F-FUTURE').length, 1);
assert.equal(futureOf(dup, 'F-CURFUT').length, 1);
assert.equal(dup.view.future.length, base.view.future.length);

// unknown reference date: INO-1 rows say 基準日不明 and no future warning is invented
const unknown = Snap.buildSnapshot(Run.capture({ xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun, dailyRows: daily, dailyFileName: 'd.xlsx', shiftBook: book(), shiftFileName: 's.xlsx', referenceDate: '2026-02-30' }), null);
assert.equal(unknown.horizon.unavailable, true);
assert.ok(unknown.alerts.every((a) => a.disposition === 'undetermined' && a.statusLabel.includes('基準日不明')));
assert.equal(Dash.buildView(JSON.parse(JSON.stringify(unknown)), { runs: [] }, null).ok, false, 'no matching run => the tab reports it, never a normal state');

// FRIDAY counts are the engine counts in every variant
['driverCount', 'clearCount', 'exceedCount', 'approachCount', 'partialCount', 'undeterminedCount'].forEach((k) => {
  assert.equal(base.snap.counts[k], base.cap.summary[k], k);
});

console.log('duty-risk-future-rows.test.mjs: ALL PASSED');
