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

assert.equal(Ops.STATUS_THRESHOLDS.onTimeBand, 0.05);
assert.equal(Ops.STATUS_THRESHOLDS.slightDelay, 0.15);
assert.equal(Ops.classifyStatus(1, 0.5, { complete: true }).id, 'done');
assert.equal(Ops.classifyStatus(0.50, 0.52, {}).id, 'ok');
assert.equal(Ops.classifyStatus(0.40, 0.50, {}).id, 'warn');
assert.equal(Ops.classifyStatus(0.30, 0.50, {}).id, 'late');
assert.equal(Ops.classifyStatus(0, 0, { notStarted: true }).id, 'idle');
assert.equal(Ops.formatRemain(135), 'あと 2時間15分');

const board = Ops.buildDriverBoard(first, '16:00');
const statusCount = { ok: 0, warn: 0, late: 0, done: 0, idle: 0 };
board.forEach(function (row) {
  statusCount[row.status.id] = (statusCount[row.status.id] || 0) + 1;
  assert.notEqual(row.packagesTotal, row.stopsTotal);
  assert.ok(row.neighborhood);
});
assert.ok(statusCount.ok >= 1, '正常が1名以上');
assert.ok(statusCount.warn >= 1, 'やや遅れ気味が1名以上');
assert.ok(statusCount.late >= 1, '遅延が1名以上');
assert.ok(statusCount.done >= 1, '完了が1名以上');

const yamadaBoard = board.find(function (row) { return row.driverId === 'D-1001'; });
assert.ok(yamadaBoard);
assert.equal(yamadaBoard.neighborhood, '鳥飼');
assert.equal(yamadaBoard.status.id, 'ok');
assert.equal(yamadaBoard.packagesTotal, 80);
assert.equal(yamadaBoard.stopsTotal, 64);
assert.match(yamadaBoard.remainLabel, /あと/);

const r07 = first.routes.find(function (row) { return row.id === 'R-07'; });
const pins07 = Ops.buildRoutePins(r07, first.timeWindows, Sample.AREA_COORDS);
const route01 = first.routes.find(function (row) { return row.id === 'R-01'; });
const pins01 = Ops.buildRoutePins(route01, first.timeWindows, Sample.AREA_COORDS);
const pins01b = Ops.buildRoutePins(route01, first.timeWindows, Sample.AREA_COORDS);
assert.deepEqual(pins01, pins01b);
assert.ok(pins07.every(function (pin) { return pin.routeId === 'R-07'; }));
assert.ok(pins01.every(function (pin) { return pin.routeId === 'R-01'; }));
assert.notEqual(pins07[0].lat + ',' + pins07[0].lng, pins01[0].lat + ',' + pins01[0].lng);

first.routes.forEach(function (route) {
  const pins = Ops.buildRoutePins(route, first.timeWindows, Sample.AREA_COORDS);
  const summary = Ops.summarizePins(pins);
  assert.equal(summary.total, route.stops);
  assert.ok(summary.total >= 60 && summary.total <= 70, route.id + ' pin count');
  const timedWindows = first.timeWindows.filter(function (tw) { return tw.routeId === route.id; });
  assert.equal(summary.timed, timedWindows.length);
  assert.ok(summary.timed <= 8, route.id + ' timed pins should be a minority');
  assert.ok(summary.timed * 4 < summary.total, route.id + ' timed pins should not dominate');
  pins.forEach(function (pin) {
    assert.equal(typeof pin.lat, 'number');
    assert.equal(typeof pin.lng, 'number');
    assert.match(pin.address || pin.label, /デモ|サンプル|架空/);
    const style = Ops.pinStyle(pin);
    if (pin.window) {
      assert.equal(style.kind, 'timed');
      assert.ok(style.color !== Ops.PIN_COLORS.regular);
    } else {
      assert.equal(style.kind, 'regular');
      assert.equal(style.color, '#6b7280');
    }
  });
});

const yamadaPins = Ops.buildRoutePins(route01, first.timeWindows, Sample.AREA_COORDS);
const yamadaSummary = Ops.summarizePins(yamadaPins);
assert.equal(yamadaSummary.total, 64);
assert.equal(yamadaSummary.timed, 6);
assert.equal(yamadaSummary.regular, 58);
assert.equal(Ops.pinStyle({ window: '10:00〜12:00' }).color, '#2b6cb0');
assert.equal(Ops.pinStyle({ window: '14:00〜16:00' }).color, '#2f9e44');
assert.equal(Ops.pinStyle({ window: '16:00〜18:00' }).color, '#e67700');
assert.equal(Ops.pinStyle({ window: '18:00〜20:00' }).color, '#c92a2a');
assert.equal(Ops.PIN_COLORS.regular, '#6b7280');

const timedYamada = yamadaPins.find(function (pin) { return !!pin.window; });
const regularYamada = yamadaPins.find(function (pin) { return !pin.window; });
assert.ok(timedYamada && regularYamada);
assert.deepEqual(Ops.describeStop(regularYamada).windowLabel, '時間指定なし');
assert.equal(Ops.describeStop(regularYamada).kindLabel, '通常配送');
assert.match(Ops.describeStop(regularYamada).address, /デモ|サンプル|架空/);
assert.equal(Ops.describeStop(timedYamada).kindLabel, '時間指定');
assert.match(Ops.describeStop(timedYamada).windowLabel, /\d{2}:\d{2}〜\d{2}:\d{2}/);
assert.equal(Ops.describeStop(yamadaPins[11]).seq, 12);
assert.equal(Ops.nextStopIndex(null, 64), 0);
assert.equal(Ops.nextStopIndex(11, 64), 12);
assert.equal(Ops.nextStopIndex(63, 64), 63);
assert.equal(Ops.prevStopIndex(null), null);
assert.equal(Ops.prevStopIndex(0), 0);
assert.equal(Ops.prevStopIndex(11), 10);
assert.equal(Ops.canPrevStop(null), false);
assert.equal(Ops.canPrevStop(0), false);
assert.equal(Ops.canPrevStop(1), true);
assert.equal(Ops.canNextStop(null, 64), true);
assert.equal(Ops.canNextStop(0, 64), true);
assert.equal(Ops.canNextStop(63, 64), false);

const suzukiBoard = board.find(function (row) { return row.driverId === 'D-1003'; });
assert.equal(suzukiBoard.status.id, 'late');
assert.ok(suzukiBoard.predictedReturn);
assert.match(suzukiBoard.delayLabel, /予定より/);

const itoBoard = board.find(function (row) { return row.driverId === 'D-1007'; });
assert.equal(itoBoard.status.id, 'done');
assert.equal(itoBoard.packagesDone, itoBoard.packagesTotal);
assert.equal(itoBoard.remainLabel, '配送完了');

console.log('ops.test.mjs ok');
