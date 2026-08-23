import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Sample = require(path.join(root, 'src/sample-data.js'));
const Assign = require(path.join(root, 'src/assign.js'));
const Ops = require(path.join(root, 'src/ops.js'));

const first = Sample.createSampleDataset();
const second = Sample.createSampleDataset();
const opsA = Ops.estimate(first);
const opsB = Ops.estimate(second);

assert.equal(first.drivers.length, 24);
assert.deepEqual(opsA, opsB);
assert.equal(opsA.progress, 68);
assert.equal(opsA.completedPackages, 972);
assert.equal(opsA.packages, 1428);
assert.equal(opsA.estimatedFinish, '19:15');
assert.equal(opsA.now, '16:00');

const yamada = first.drivers.find(function (d) { return d.id === 'D-1001'; });
assert.ok(yamada);
assert.equal(yamada.capability, 19.2);
assert.equal(yamada.abilityPerHour, 19.2);
assert.equal(yamada.packagesTotal, 18420);
assert.equal(yamada.completionRate, 99.1);
assert.equal(yamada.misdeliveryRate, 0.08);
assert.equal(yamada.lineConnected, true);
assert.equal(yamada.department, '第一配送');
assert.equal(yamada.packagesToday, 80);
assert.equal(yamada.lastRunDate, '2026-08-22');

const hakataExp = yamada.areaExperience.find(function (row) { return row.area === '博多区'; });
assert.ok(hakataExp);
assert.equal(hakataExp.days, 18);
assert.equal(hakataExp.lastDate, '2026-08-22');
assert.equal(yamada.areaExperience[0].days, first.experiences.find(function (row) {
  return row.driverId === 'D-1001' && row.area === '博多区';
}).days);

const assign = Assign.runAutoAssign({
  drivers: first.drivers,
  routes: first.routes,
  experiences: first.experiences
});
const hakata = assign.assignments.find(function (row) { return row.routeId === 'R-01'; });
assert.equal(hakata.recommended.driverName, '山田 太郎');
assert.equal(hakata.recommended.capability, yamada.capability);
assert.equal(hakata.recommended.experienceDays, hakataExp.days);

first.drivers.forEach(function (driver) {
  assert.equal(driver.abilityPerHour, driver.capability);
  assert.ok(driver.completionRate >= 97 && driver.completionRate <= 100);
  assert.ok(driver.misdeliveryRate >= 0 && driver.misdeliveryRate <= 0.5);
  var fromTable = first.experiences.filter(function (row) { return row.driverId === driver.id; });
  assert.equal(driver.areaExperience.length, fromTable.length);
  fromTable.forEach(function (row, i) {
    assert.equal(driver.areaExperience[i].area, row.area);
    assert.equal(driver.areaExperience[i].days, row.days);
  });
});

const r01 = opsA.routes.find(function (row) { return row.routeId === 'R-01'; });
assert.equal(r01.driverName, '山田 太郎');
assert.equal(r01.capability, 19.2);

console.log('ops.test.mjs ok');
