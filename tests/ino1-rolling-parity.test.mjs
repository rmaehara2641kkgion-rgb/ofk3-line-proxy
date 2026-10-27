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

const REF = '2026-10-27';
const header = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];
const MARU = '○';
const KYU = '休';
const deps = { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf };

function datesBetween(start, end) {
  const out = [];
  for (let date = start; date <= end; date = Rolling.addDays(date, 1)) out.push(date);
  return out;
}


const View = require('../inoichi-rolling-view.js');

// Parity audit: INO-1 view/snapshot (inoichi-rolling-view.js + duty-risk-snapshot.js) vs the OFK3 list board
// (rolling60h-local-board.js) on the SAME engine output. All people are fictional.
// Divergences are reported, not failed, unless INO1_PARITY_STRICT=1.
const dates = datesBetween('2026-10-01', '2026-10-30');

function shiftBook(people) {
  const head = ['社名', '名前', 'Transport ID'].concat(dates.map((iso) => {
    const p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }));
  const rows = people.map((person) => ['GDS', person.name, person.id].concat(dates.map((date) => (
    person.cells[date] != null ? person.cells[date] : KYU
  ))));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head].concat(rows)), 'GDS');
  return wb;
}
const cellsOf = (overrides) => Object.assign({}, ...dates.map((d) => ({ [d]: KYU })), overrides);
const fill = (start, end, symbol) => Object.fromEntries(datesBetween(start, end).map((d) => [d, symbol]));
const actualRun = (id, start, hoursList) => hoursList.map((hours, i) => ({ id, date: Rolling.addDays(start, i), hours }));

const people = [
  { id: 'P-LOW', name: '架空 低', cells: cellsOf({ '2026-10-22': MARU, '2026-10-23': MARU }) },
  { id: 'P-TODAY', name: '架空 当日超過', cells: cellsOf({ '2026-10-27': MARU }) },
  { id: 'P-EXACT', name: '架空 丁度', cells: cellsOf({ '2026-10-27': MARU }) },
  { id: 'P-PAST', name: '架空 過去', cells: cellsOf(fill('2026-10-01', '2026-10-07', MARU)) },
  { id: 'P-FUTURE', name: '架空 将来', cells: cellsOf(fill('2026-10-24', '2026-10-30', MARU)) },
  { id: 'P-SAMEDAY', name: '架空 同日', cells: cellsOf({ '2026-10-25': MARU }) },
  { id: 'P-REST', name: '架空 休', cells: cellsOf({}) },
  { id: 'P-BLANK', name: '架空 空白', cells: cellsOf(fill('2026-10-01', '2026-10-30', '')) },
  { id: 'P-ACTUALOVER', name: '架空 実績超過', cells: cellsOf({}) },
  { id: 'P-49', name: '架空 四十九', cells: cellsOf({ '2026-10-27': '❽' }) },
  { id: 'P-GAP', name: '架空 時間不明', cells: cellsOf({ '2026-10-26': 'C2', '2026-10-27': MARU }) },
  { id: 'P-KNOWN', name: '架空 既知超過', cells: cellsOf({ '2026-10-26': '', '2026-10-27': MARU }) },
];
const daily = [].concat(
  actualRun('P-TODAY', '2026-10-21', [8, 8, 8, 8, 8, 10]),
  actualRun('P-EXACT', '2026-10-21', [8, 8, 8, 8, 8, 9]),
  actualRun('P-SAMEDAY', '2026-10-25', [8]),
  actualRun('P-ACTUALOVER', '2026-10-21', [11, 11, 11, 11, 11, 11]),
  actualRun('P-49', '2026-10-21', [8, 8, 8, 8, 8, 9]),
  actualRun('P-GAP', '2026-10-21', [11, 11, 11, 11, 11]),
  actualRun('P-KNOWN', '2026-10-21', [11, 11, 11, 11, 11]),
  actualRun('P-NOSHIFT', '2026-10-24', [5, 5, 5]),
);

const executed = Run.capture({
  xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyRows: [header].concat(daily.map((e) => [e.id, e.date, e.hours, 'OFK3'])), dailyFileName: 'Daily_FICTION.xlsx',
  shiftBook: shiftBook(people), shiftFileName: 'shift_FICTION.xlsx', referenceDate: REF,
});
const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
const board = Board.buildBoard({
  executed, referenceDate: REF, generatedAt: '2026-10-27T01:00:00.000Z',
  files: { shift: { name: 's', ok: true }, daily: { name: 'd', ok: true } }, names,
  actualDays: daily.map((e) => ({ transportId: e.id, date: e.date, hours: e.hours })),
}, deps);
// capture() does not expose the run's reference date, so the snapshot is built both ways
const snap = Snap.buildSnapshot(Object.assign({}, executed, { stats: { referenceDate: REF } }), null);
const snapFallback = Snap.buildSnapshot(executed, null);
const ofk = Object.fromEntries(board.rows.map((r) => [r.transportId, r]));
const ino = Object.fromEntries(snap.alerts.map((a) => [a.transportId, a]));
const windowEnding = (id, end) => executed.drivers.find((d) => d.transportId === id).windows.find((w) => w.endDate === end);

// ---- must agree (hard assertions) ----------------------------------------------------------
// 1 below 60 / 7 rest: no alert in INO-1, OFK3 ok
['P-LOW', 'P-REST'].forEach((id) => {
  assert.equal(ino[id], undefined, id + ': INO-1 raises nothing');
  assert.equal(ofk[id].judgment, 'ok');
});
// 2 over 60 today
assert.equal(windowEnding('P-TODAY', REF).totalHours, 61);
assert.equal(ino['P-TODAY'].disposition, 'exceed');
assert.equal(ofk['P-TODAY'].judgment, 'forecast-exceed');
// 3 exactly 60:00 is attention, not exceed, in engine, INO-1 and OFK3
assert.equal(windowEnding('P-EXACT', REF).judgment, 'approach');
assert.equal(ino['P-EXACT'].disposition, 'approach');
assert.equal(ofk['P-EXACT'].judgment, 'caution');
// 6 same day actual + plan: actual wins on a past day
assert.equal(windowEnding('P-SAMEDAY', REF).totalHours, 8);
// 10 actual-only over 60 (past 6 days already 66)
assert.equal(ino['P-ACTUALOVER'].disposition, 'exceed');
assert.equal(ofk['P-ACTUALOVER'].judgment, 'actual-exceed');
// 9 no shift data: neither side calls it normal
assert.equal(ino['P-NOSHIFT'].disposition, 'undetermined');
assert.notEqual(ofk['P-NOSHIFT'].judgment, 'ok');
// 11 49h: the documented "49h with duty today" approach rule is NOT computed anywhere
assert.equal(windowEnding('P-49', REF).totalHours, 57);
assert.equal(ino['P-49'], undefined, '49:00+ with duty today produces no INO-1 approach');
assert.equal(snap.approachRule, '', 'approachRule is never populated');
assert.equal(/49/.test(snap.approachNote), false, 'no 49h text is published');
// 13 FRIDAY-bound counts are the engine counts
['exceedCount', 'approachCount', 'partialCount', 'undeterminedCount', 'clearCount', 'driverCount'].forEach((k) => {
  assert.equal(snap.counts[k], executed.summary[k], k);
});
// communication / collection failure is never reported as normal
const failed = View.build({ summary: { ok: false, fileSuccess: 0, fileFailure: 2 }, drivers: [], predictions: [] });
assert.equal(failed.usable, false);
Object.values(failed.counts).forEach((v) => assert.equal(v, null));
assert.deepEqual(failed.alerts, []);
const stale = View.build({ summary: Object.assign({}, executed.summary, { expired: true }), drivers: [], predictions: [] });
assert.equal(stale.usable, false);
assert.equal(stale.counts.clearCount, null);

// ---- INO-1 now agrees with OFK3 on the current judgment, and separates past / future ---------
const MAP = { 'actual-exceed': 'exceed', 'forecast-exceed': 'exceed', caution: 'approach', review: 'undetermined' };
people.concat([{ id: 'P-NOSHIFT' }]).forEach(({ id }) => {
  const o = ofk[id].judgment;
  const row = ino[id];
  if (o === 'ok') {
    assert.ok(!row || row.period === 'future', id + ': normal today never shows a current row');
  } else {
    assert.ok(row && row.period === 'current', id + ': current row exists');
    assert.equal(row.disposition, MAP[o], id);
    assert.equal(row.judgmentCode, o, id + ' judgment code equals OFK3');
    assert.equal(row.provisional, ofk[id].judgmentProvisional, id + ' provisional flag');
  }
});
// 4 past-only exceed is history only
assert.equal(ino['P-PAST'], undefined);
assert.ok(snap.horizon.pastExceeds.some((x) => x.transportId === 'P-PAST' && x.endDate < REF && x.overByText === '17:00'));
// 5 future-only exceed is an independent warning while today stays normal
assert.equal(ofk['P-FUTURE'].judgment, 'ok');
assert.equal(ino['P-FUTURE'].disposition, 'future-exceed');
assert.equal(ino['P-FUTURE'].period, 'future');
assert.equal(ino['P-FUTURE'].statusLabel, '将来超過あり');
assert.equal(ino['P-FUTURE'].futureExceed.overByText, Board.clockText(ofk['P-FUTURE'].futureExceed.overBy));
assert.equal(ino['P-FUTURE'].futureExceed.endDate, ofk['P-FUTURE'].futureExceed.end);
// 8 blank in a valid shift range is a confirmed rest
assert.equal(ino['P-BLANK'], undefined);
// known over despite a gap is never normal
assert.equal(ino['P-KNOWN'].disposition, 'exceed');
assert.equal(ino['P-KNOWN'].provisional, false, 'blank is a confirmed rest, as in the OFK3 list');
// unknown-hours symbol stays 要確認 and is never shown as normal
assert.equal(ino['P-GAP'].disposition, 'undetermined');
assert.equal(ofk['P-GAP'].judgment, 'review');
// actual vs forecast labels, HH:MM
assert.equal(ino['P-ACTUALOVER'].statusLabel, '実績超過');
assert.equal(ino['P-ACTUALOVER'].basisLabel, '実績超過');
assert.ok(ino['P-TODAY'].statusLabel.startsWith('超過予測'));
assert.equal(ino['P-TODAY'].totalHoursText, '61:00');
assert.equal(ino['P-TODAY'].overByText, '01:00');
assert.equal(ino['P-TODAY'].totalHoursText, Board.clockText(ofk['P-TODAY'].forecast.hours));
// snapshot metadata
assert.equal(snap.horizon.referenceDate, REF);
assert.equal(snap.referenceDate, REF);
assert.equal(snap.horizon.windowStart, '2026-10-21');
assert.equal(snap.horizon.windowEnd, REF);
assert.equal(snap.horizon.updatedAt, executed.summary.checkedAt);
assert.equal(snap.horizon.referenceDateSource, 'run');
assert.equal(snapFallback.horizon.referenceDateSource, 'checkedAt-jst');
assert.equal(snapFallback.horizon.referenceDate, Date.parse(executed.summary.checkedAt) !== NaN ? new Date(Date.parse(executed.summary.checkedAt) + 9 * 3600000).toISOString().slice(0, 10) : '');
// reference date falls back to the JST date of checkedAt, never to nothing
const fb = View.build({ summary: Object.assign({}, executed.summary, { checkedAt: '2026-10-26T16:30:00.000Z' }), drivers: [], predictions: [] });
assert.equal(fb.horizon.referenceDate, '2026-10-27');
assert.equal(fb.horizon.referenceDateSource, 'checkedAt-jst');
// the engine is untouched: same windows with or without the display layer
assert.equal(windowEnding('P-TODAY', REF).judgment, 'exceed');

// without any reference date the view keeps its previous behaviour (no horizon block, no silent guess)
const legacy = View.build({ summary: Object.assign({}, executed.summary, { checkedAt: null }), drivers: executed.drivers.map((d) => Object.assign({}, d, { disposition: Snap.dispositionOf(d) })), predictions: executed.predictions });
assert.equal(legacy.horizon, null);
assert.equal(legacy.referenceDate, null);
// FRIDAY counts: identical with and without the display layer
['driverCount', 'clearCount', 'exceedCount', 'approachCount', 'partialCount', 'undeterminedCount'].forEach((k) => assert.equal(legacy.counts[k], snap.counts[k], k));

console.log('INO-1 vs OFK3 parity: no divergence (strict)');
console.log('ino1-rolling-parity.test.mjs: ALL PASSED');
