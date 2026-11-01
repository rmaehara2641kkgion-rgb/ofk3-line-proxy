import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Fleet = require('../inoichi-fleet-three-way.js');

const at = {
  amazon_input: '2026-10-21T00:00:00.000Z',
  amazon_schedule: '2026-10-21T00:05:00.000Z',
  internal_excel: '2026-10-21T00:10:00.000Z'
};

function row(source, date, cycle, vehicle, count, measure) {
  return {
    source: source,
    date: date,
    cycle: cycle,
    vehicle: vehicle,
    measure: measure || 'courses',
    count: count,
    fetchedAt: at[source]
  };
}

function trio(date, cycle, vehicle, counts, measure) {
  return ['amazon_input', 'amazon_schedule', 'internal_excel'].map(function (source, index) {
    return row(source, date, cycle, vehicle, counts[index], measure);
  });
}

function find(result, date, vehicle) {
  return result.rows.find(function (item) { return item.date === date && item.vehicle === vehicle; });
}

const matched = Fleet.compareThreeWay(trio('2026-10-21', 'CYCLE_1', '8B', [12, 12, 12]));
assert.equal(find(matched, '2026-10-21', '8B').status, 'match');
assert.equal(matched.summary.match, 1);

const oneOff = Fleet.compareThreeWay(trio('2026-10-21', 'CYCLE_1', '6.5B', [18, 17, 18]));
const oneOffRow = find(oneOff, '2026-10-21', '6.5B');
assert.equal(oneOffRow.status, 'mismatch');
assert.deepEqual(oneOffRow.counts, { amazon_input: 18, amazon_schedule: 17, internal_excel: 18 });
assert.equal(oneOffRow.fetchedAt.amazon_schedule, at.amazon_schedule);

const allOff = Fleet.compareThreeWay(trio('2026-10-21', 'CYCLE_2', '4.5B', [10, 11, 12]));
assert.equal(find(allOff, '2026-10-21', '4.5B').status, 'mismatch');

const missing = Fleet.compareThreeWay([
  row('amazon_input', '2026-10-21', 'CYCLE_1', '8B', 12),
  row('internal_excel', '2026-10-21', 'CYCLE_1', '8B', 12)
]);
const missingRow = find(missing, '2026-10-21', '8B');
assert.equal(missingRow.status, 'missing');
assert.deepEqual(missingRow.missingSources, ['amazon_schedule']);
assert.equal(missing.summary.match, 0);

const week = Fleet.compareThreeWay([].concat(
  trio('2026-10-14', 'CYCLE_1', '8B', [12, 12, 12]),
  trio('2026-10-21', 'CYCLE_1', '8B', [14, 14, 14])
));
assert.equal(find(week, '2026-10-14', '8B').status, 'match');
assert.equal(find(week, '2026-10-21', '8B').status, 'match');
assert.equal(find(week, '2026-10-21', '8B').counts.internal_excel, 14);

const bike = Fleet.compareThreeWay([].concat(
  trio('2026-10-21', 'CYCLE_1', 'BIKE_2H', [4, 4, 4], 'people'),
  trio('2026-10-21', 'CYCLE_1', 'BIKE_2H', [8, 8, 8], 'courses')
));
assert.equal(bike.rows.length, 2);
assert.equal(bike.measureSplits.length, 1);
assert.equal(bike.measureSplits[0].status, 'measure_mismatch');
assert.equal(Fleet.bikePeopleToCoursesNote(4).applied, false);
assert.equal(bike.rows.every(function (item) { return item.status === 'match'; }), true);

const aliases = Fleet.compareThreeWay([
  row('amazon_input', '2026/10/21', 'C1', '6B30S', 9),
  row('amazon_schedule', '2026-10-21', 'Cycle 1', '6.5B', 9),
  row('internal_excel', 46316, '1', '6.5', 9)
]);
assert.equal(aliases.rejected.length, 0);
assert.equal(aliases.rows[0].date, '2026-10-21');
assert.equal(aliases.rows[0].cycle, 'CYCLE_1');
assert.equal(aliases.rows[0].vehicle, '6.5B');
assert.equal(aliases.rows[0].status, 'match');

const duplicateSame = Fleet.compareThreeWay([].concat(
  trio('2026-10-21', 'CYCLE_1', '8B', [5, 5, 5]),
  [row('amazon_input', '2026-10-21', 'CYCLE_1', '8B', 5)]
));
assert.equal(find(duplicateSame, '2026-10-21', '8B').status, 'match');
assert.equal(find(duplicateSame, '2026-10-21', '8B').counts.amazon_input, 5);

const duplicateConflict = Fleet.compareThreeWay([].concat(
  trio('2026-10-21', 'CYCLE_1', '8B', [5, 5, 5]),
  [row('internal_excel', '2026-10-21', 'CYCLE_1', '8B', 6)]
));
assert.equal(find(duplicateConflict, '2026-10-21', '8B').status, 'source_conflict');
assert.deepEqual(find(duplicateConflict, '2026-10-21', '8B').counts.internal_excel, [5, 6]);

const listed = Fleet.listMismatches(oneOff);
assert.equal(listed.length, 1);
assert.equal(listed[0].status, 'mismatch');

const header = ['Node', 'Block', 'Cycle', 46316];
const parsed = Fleet.parseInputFileObservations([
  ['meta'],
  header,
  ['OFK3', 8, 'CYCLE_1', 12],
  ['OFK3', 2, 'CYCLE_2', '']
], at.internal_excel);
assert.equal(parsed.ok, true);
assert.equal(parsed.observations.length, 1);
assert.equal(parsed.observations[0].vehicle, '8B');
assert.equal(parsed.observations[0].measure, 'courses');
assert.equal(parsed.observations[0].count, 12);

const blankCompared = Fleet.compareThreeWay(parsed.observations.concat([
  row('amazon_input', '2026-10-21', 'CYCLE_1', '8B', 12),
  row('amazon_schedule', '2026-10-21', 'CYCLE_1', '8B', 12)
]));
assert.equal(find(blankCompared, '2026-10-21', '8B').status, 'match');
assert.equal(blankCompared.rows.some(function (item) { return item.vehicle === 'BIKE_2H'; }), false);
assert.equal(find(blankCompared, '2026-10-21', '8B').counts.internal_excel, 12);

const none = Fleet.compareThreeWay([]);
assert.equal(none.rows.length, 0);
assert.equal(none.summary.match, 0);
assert.equal(none.summary.missing, 0);
assert.equal(none.rejected.length, 0);

const separate = Fleet.compareThreeWay([].concat(
  trio('2026-10-21', 'CYCLE_1', '8B', [12, 12, 12]),
  trio('2026-10-21', 'CYCLE_2', '8B', [3, 3, 3]),
  trio('2026-10-21', 'CYCLE_1', '6.5B', [4, 4, 4])
));
assert.equal(separate.rows.length, 3);
assert.equal(separate.summary.match, 3);
assert.equal(find(separate, '2026-10-21', '8B').counts.amazon_input, 12);
assert.equal(separate.rows.filter(function (item) { return item.vehicle === '8B'; }).length, 2);

const invalid = Fleet.compareThreeWay([
  { source: 'amazon_input', date: '2026-10-21', cycle: 'CYCLE_1', vehicle: '8B', measure: 'courses', count: '12' },
  { source: 'amazon_schedule', date: '2026-10-21', cycle: 'CYCLE_1', vehicle: '8B', measure: 'courses', count: null },
  { source: 'internal_excel', date: '2026-10-21', cycle: 'CYCLE_1', vehicle: '8B', measure: 'courses', count: NaN },
  { source: 'amazon_input', date: '2026-10-21', cycle: 'CYCLE_1', vehicle: '8B', measure: 'courses', count: Infinity }
]);
assert.equal(invalid.rows.length, 0);
assert.equal(invalid.rejected.length, 4);
assert.equal(invalid.summary.match, 0);

const explicitZero = Fleet.compareThreeWay(trio('2026-10-21', 'CYCLE_1', '4.5B', [0, 0, 0]));
assert.equal(find(explicitZero, '2026-10-21', '4.5B').status, 'match');
assert.equal(find(explicitZero, '2026-10-21', '4.5B').counts.amazon_input, 0);
assert.equal(find(missing, '2026-10-21', '8B').counts.amazon_schedule, null);

const badFile = Fleet.parseInputFileObservations([['名前', '台数']], '');
assert.equal(badFile.ok, false);
assert.equal(badFile.observations.length, 0);
const textCount = Fleet.parseInputFileObservations([
  header,
  ['OFK3', 8, 'CYCLE_1', '不明']
], '');
assert.equal(textCount.ok, true);
assert.equal(textCount.observations.length, 0);

console.log('inoichi fleet three-way tests passed');
