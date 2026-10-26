import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Adapter = require('../inoichi-fleet-source-adapter.js');

const scheduleRows = [
  ['アソシエイト名', '配達担当者ID'],
  ['架空氏名', 'TID-FIXTURE']
];
const schedule = Adapter.inspectAmazonScheduleRows(scheduleRows);
assert.equal(schedule.usable, false);
assert.equal(schedule.observations.length, 0);
assert.match(schedule.reason, /台数にしません/);

const unknownSchedule = Adapter.inspectAmazonScheduleRows([['日付', 'コース', '台数'], ['2026-10-21', '1', 12]]);
assert.equal(unknownSchedule.usable, false);
assert.match(unknownSchedule.reason, /未確認/);
assert.equal(unknownSchedule.observations.length, 0);

const master = Adapter.inspectFleetMaster();
assert.equal(master.usable, false);

const header = ['Node', 'Block', 'Cycle', 46316];
const collected = Adapter.collect({
  fleetMaster: [{ block: '8B', count: 99 }],
  internalExcelRows: [['meta'], header, ['OFK3', 8, 'CYCLE_1', 12], ['OFK3', 2, 'CYCLE_1', '']],
  amazonScheduleRows: scheduleRows,
  amazonInputRows: [['確定台数', 12]],
  fetchedAt: { internal_excel: '2026-10-21T01:00:00.000Z' }
});
assert.equal(collected.acquisitionComplete, false);
assert.equal(collected.rows.length, 1);
assert.equal(collected.rows[0].status, 'missing');
assert.deepEqual(collected.rows[0].missingSources.sort(), ['amazon_input', 'amazon_schedule']);
assert.equal(collected.rows[0].counts.internal_excel, 12);
assert.equal(collected.rows[0].counts.amazon_input, null);
assert.equal(collected.rows[0].counts.amazon_schedule, null);
assert.ok(collected.blockedSources.some(function (item) { return item.source === 'amazon_schedule'; }));
assert.ok(collected.blockedSources.some(function (item) { return item.source === 'amazon_input'; }));
assert.ok(collected.blockedSources.some(function (item) { return item.reason.indexOf('固定台数マスタ') >= 0; }));
assert.equal(collected.rows.some(function (item) { return item.vehicle === 'BIKE_2H'; }), false);

const supplied = Adapter.collect({
  amazonScheduleObservations: [{
    date: '2026-10-21', cycle: 'CYCLE_1', vehicle: '8B', measure: 'courses', count: 9
  }],
  amazonInputObservations: [{
    date: '2026-10-21', cycle: 'CYCLE_1', vehicle: '8B', measure: 'courses', count: 9
  }],
  internalExcelRows: [['meta'], header, ['OFK3', 8, 'CYCLE_1', 9]],
  fetchedAt: {
    amazon_schedule: '2026-10-21T01:02:00.000Z',
    amazon_input: '2026-10-21T01:03:00.000Z',
    internal_excel: '2026-10-21T01:04:00.000Z'
  }
});
assert.equal(supplied.acquisitionComplete, false);
assert.equal(supplied.rows[0].status, 'match');
assert.equal(supplied.rows[0].counts.amazon_schedule, 9);

console.log('inoichi fleet source adapter tests passed');
