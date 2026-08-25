import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Assign = require(path.join(root, 'src/assign.js'));
const Sample = require(path.join(root, 'src/sample-data.js'));
const Csv = require(path.join(root, 'src/csv.js'));

const sample = Sample.createSampleDataset();
assert.equal(sample.drivers.length, 24);
assert.equal(sample.schedule.length, 24);
assert.equal(sample.routes.length, 18);
assert.equal(sample.timeWindows.length, 43);
assert.equal(sample.summary.packages, 1428);
assert.equal(sample.summary.unassignedRoutes, 2);
assert.equal(sample.summary.workingDrivers, 23);

const first = Assign.runAutoAssign({
  drivers: sample.drivers,
  routes: sample.routes,
  experiences: sample.experiences,
  schedule: sample.schedule
});
const second = Assign.runAutoAssign({
  drivers: sample.drivers,
  routes: sample.routes,
  experiences: sample.experiences,
  schedule: sample.schedule
});

assert.deepEqual(first, second);
assert.ok(first.assignedCount >= 16);
assert.equal(first.assignments.length, 18);

const hakata = first.assignments.find(function (row) { return row.routeId === 'R-01'; });
assert.ok(hakata);
assert.equal(hakata.recommended.driverName, '山田 太郎');
assert.equal(hakata.recommended.confidence, '高');
assert.ok(hakata.recommended.reasons.some(function (r) { return r.indexOf('博多区経験 18日') >= 0; }));
assert.ok(hakata.recommended.reasons.some(function (r) { return r.indexOf('19.2個/h') >= 0; }));
assert.ok(hakata.recommended.reasons.some(function (r) { return r.indexOf('Van勤務') >= 0; }));

// Evidence: structured grounds for the recommendation (used by the assign-grid UI).
assert.ok(hakata.recommended.evidence);
assert.equal(hakata.recommended.evidence.area, '博多区');
assert.equal(hakata.recommended.evidence.areaVisits, 18);
assert.equal(hakata.recommended.evidence.areaLastDate, '2026-08-22');
assert.equal(hakata.recommended.evidence.capability, 19.2);
assert.equal(hakata.recommended.evidence.vehicleMatched, true);
assert.equal(hakata.recommended.evidence.workStart, '09:00');
assert.equal(hakata.recommended.evidence.workEnd, '20:00');

const bike = first.assignments.find(function (row) { return row.routeId === 'R-16'; });
assert.equal(bike.recommended.vehicle, 'Bike');

const south = first.assignments.find(function (row) { return row.routeId === 'R-04'; });
assert.equal(south.recommended.driverName, '前田 結衣');
assert.ok(south.recommended.reasons.some(function (r) { return r.indexOf('南区経験 14日') >= 0; }));

const jonan = first.assignments.find(function (row) { return row.routeId === 'R-06'; });
assert.equal(jonan.recommended.driverName, '小林 裕子');
assert.ok(jonan.recommended.reasons.some(function (r) { return r.indexOf('城南区経験 15日') >= 0; }));

const used = {};
first.assignments.forEach(function (row) {
  if (!row.recommended) return;
  assert.equal(used[row.recommended.driverId], undefined, 'driver reused');
  used[row.recommended.driverId] = row.routeId;
});

const offDuty = Assign.scoreCandidate(
  { id: 'D-1023', name: '近藤 心愛', vehicle: 'Van', capability: 14.1, status: '休憩' },
  sample.routes[0],
  sample.experiences
);
assert.equal(offDuty, null);

const csvDrivers = Csv.parseDrivers('name,driver_id,department,vehicle,capability,status,areas\n山田 太郎,D-1001,第一配送,Van,19.2,稼働,博多区|東区\n');
assert.equal(csvDrivers[0].id, 'D-1001');
assert.deepEqual(csvDrivers[0].areas, ['博多区', '東区']);

console.log('assign.test.mjs ok');
