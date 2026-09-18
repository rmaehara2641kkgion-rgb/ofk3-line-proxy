import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Core = require('../cortex-13-priority-core.js');
const __dirname = dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function task(overrides) {
  return Object.assign({
    taskType: 'DROP_OFF',
    promiseType: 'SCHEDULED',
    timeWindowed: true,
    windowStartTime: 1789675200.0,
    windowEndTime: 1789704000.0,
    domainMap: { scannableId: 'DA00000001' }
  }, overrides);
}

function details(stops, extra) {
  return Object.assign({
    rmsRouteDetails: {
      routeId: 'R1',
      routeCode: 'DCX99',
      localDate: [2026, 9, 18],
      plannedDepartureTime: 1789697520000,
      stops: stops
    },
    transporters: [{ firstName: 'A', lastName: 'B' }]
  }, extra || {});
}

function stop(seq, plannedEndMs, tasks, plannedStartMs) {
  return {
    sequenceNumber: seq,
    plannedStartTime: plannedStartMs == null ? plannedEndMs - 120000 : plannedStartMs,
    plannedEndTime: plannedEndMs,
    tasks: tasks
  };
}

function run() {
  // epoch units: HAR plannedEnd is ms, windowEnd is seconds-float
  assert(Core.epochToMs(1789703362000) === 1789703362000, 'ms passthrough');
  assert(Core.epochToMs(1789704000.0) === 1789704000000, 'seconds float -> ms');
  assert(Core.formatTokyoClock(1789704000000) === '13:00:00', 'windowEnd seconds is 13:00 JST');
  assert(Core.formatTokyoClock(1789703362000) === '12:49:22', 'stop27 plannedEnd 12:49:22 JST');

  // 1. plannedEnd 12:59:59 + window 13:00 → 対象
  var t1 = Core.extractFromRouteDetails(details([
    stop(1, Date.parse('2026-09-18T12:59:59+09:00'), [task({ domainMap: { scannableId: 'DA1' } })])
  ]));
  assert(t1.ok && t1.packageCount === 1 && t1.stopCount === 1, 'case1 12:59:59 included, got ' + t1.packageCount);

  // 2. plannedEnd 13:00:00 + window 13:00 → 対象
  var t2 = Core.extractFromRouteDetails(details([
    stop(1, Date.parse('2026-09-18T13:00:00+09:00'), [task({ domainMap: { scannableId: 'DA2' } })])
  ]));
  assert(t2.ok && t2.packageCount === 1, 'case2 13:00:00 included');

  // 3. plannedEnd 13:00:01 + window 13:00 → 対象外
  var t3 = Core.extractFromRouteDetails(details([
    stop(1, Date.parse('2026-09-18T13:00:01+09:00'), [task({ domainMap: { scannableId: 'DA3' } })])
  ]));
  assert(t3.ok && t3.packageCount === 0, 'case3 13:00:01 excluded, got ' + t3.packageCount);

  // 3b. 13:00:00.001 → 対象外
  var t3b = Core.extractFromRouteDetails(details([
    stop(1, Date.parse('2026-09-18T13:00:00+09:00') + 1, [task({ domainMap: { scannableId: 'DA3b' } })])
  ]));
  assert(t3b.packageCount === 0, 'case3b 13:00:00.001 excluded');

  // 4. plannedEnd 12:30 + window 14:00 → 対象外
  var t4 = Core.extractFromRouteDetails(details([
    stop(1, Date.parse('2026-09-18T12:30:00+09:00'), [task({
      windowStartTime: Date.parse('2026-09-18T08:00:00+09:00') / 1000,
      windowEndTime: Date.parse('2026-09-18T14:00:00+09:00') / 1000,
      domainMap: { scannableId: 'DA4' }
    })])
  ]));
  assert(t4.packageCount === 0, 'case4 14:00 window excluded');

  // timezone: 04:00 UTC == 13:00 JST must be treated as 13:00, not UTC hour 4
  var utc4 = Date.parse('2026-09-18T04:00:00Z');
  assert(Core.formatTokyoClock(utc4) === '13:00:00', 'UTC 04:00 is JST 13:00');
  assert(Core.isExact1300Clock(utc4) === true, 'UTC 04:00 counts as 13:00 JST window end');
  var utc13 = Date.parse('2026-09-18T13:00:00Z');
  assert(Core.isExact1300Clock(utc13) === false, 'UTC 13:00 is 22:00 JST, not a 13:00 window');

  // 5. multi-package stop: unique stops vs packages
  var t5 = Core.extractFromRouteDetails(details([
    stop(26, Date.parse('2026-09-18T12:46:29+09:00'), [
      task({ promiseType: 'STANDARD', timeWindowed: false, windowEndTime: Date.parse('2026-09-18T21:30:00+09:00') / 1000, domainMap: { scannableId: 'DA2601' } }),
      task({ domainMap: { scannableId: 'DA2602' } }),
      task({ domainMap: { scannableId: 'DA2603' } })
    ])
  ]));
  assert(t5.stopCount === 1, 'case5 unique stop 1, got ' + t5.stopCount);
  assert(t5.packageCount === 2, 'case5 packages 2, got ' + t5.packageCount);

  // 6. plannedEnd missing → not included
  var t6 = Core.extractFromRouteDetails(details([
    { sequenceNumber: 9, plannedStartTime: Date.parse('2026-09-18T12:00:00+09:00'), plannedEndTime: null, tasks: [task({ domainMap: { scannableId: 'DA9' } })] }
  ]));
  assert(t6.packageCount === 0, 'case6 missing plannedEnd not included');
  assert(t6.missingPlannedEndStops.indexOf(9) >= 0, 'case6 recorded missing stop');

  // PICK_UP must not count even with 13:00 window
  var pickup = Core.extractFromRouteDetails(details([
    stop(1, Date.parse('2026-09-18T11:12:00+09:00'), [task({ taskType: 'PICK_UP', domainMap: { scannableId: 'DAPICK' } })])
  ]));
  assert(pickup.packageCount === 0, 'PICK_UP excluded');

  // yesterday 13:00 window on today's route → excluded
  var yday = Core.extractFromRouteDetails(details([
    stop(8, Date.parse('2026-09-18T12:00:00+09:00'), [task({
      windowStartTime: Date.parse('2026-09-17T05:00:00+09:00') / 1000,
      windowEndTime: Date.parse('2026-09-17T13:00:00+09:00') / 1000,
      domainMap: { scannableId: 'DAYDAY' }
    })])
  ]));
  assert(yday.packageCount === 0, 'previous-day 13:00 window excluded');

  // 7. one route-details failure keeps the other
  var bundle = Core.ingestBundle({
    details: [
      details([stop(1, Date.parse('2026-09-18T12:59:59+09:00'), [task({ domainMap: { scannableId: 'DAOK' } })])]),
      { notRouteDetails: true }
    ]
  });
  assert(bundle.ok === true, 'case7 bundle still ok');
  assert(bundle.packageCount === 1, 'case7 kept successful route');
  assert(bundle.failures.length === 1, 'case7 recorded 1 failure');
  assert(bundle.failures[0].error === Core.ERROR.MISSING_DETAILS, 'case7 failure type');

  // schema change: empty object
  var bad = Core.extractFromRouteDetails({});
  assert(bad.ok === false && bad.error === Core.ERROR.MISSING_DETAILS, 'schema missing details is not silent 0');

  // 11:00 selection uses plannedDepartureTime hour, not route number
  var sel = Core.selectElevenOClockRoutes({
    rmsRouteSummaries: [
      { routeId: 'a', routeCode: 'DCX31', plannedDepartureTime: Date.parse('2026-09-18T09:07:00+09:00') },
      { routeId: 'b', routeCode: 'DCX47', plannedDepartureTime: Date.parse('2026-09-18T11:12:00+09:00') },
      { routeId: 'c', routeCode: 'DCX30', plannedDepartureTime: Date.parse('2026-09-18T11:07:00+09:00') }
    ]
  });
  assert(sel.ok, '11:00 select ok');
  assert(sel.routes.map(function (r) { return r.routeCode; }).join(',') === 'DCX47,DCX30', '11:00 hour selected, got ' + sel.routes.map(function (r) { return r.routeCode; }));

  var noDep = Core.selectElevenOClockRoutes({
    rmsRouteSummaries: [
      { routeId: 'a', routeCode: 'DCX1' },
      { routeId: 'b', routeCode: 'DCX2' }
    ]
  });
  assert(noDep.ok === false && noDep.error === Core.ERROR.SCHEMA, 'all missing plannedDepartureTime is schema error, not route-number fallback');

  // 8. DCX47 sanitized HAR fixture
  var dcx47 = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'cortex-13-priority', 'dcx47-sanitized.json'), 'utf8'));
  var real = Core.extractFromRouteDetails(dcx47);
  assert(real.ok, 'dcx47 parse ok');
  assert(real.stopCount === 12, 'dcx47 stops 12 by written rule (incl 2,3), got ' + real.stopCount + ' ' + JSON.stringify(real.stopNumbers));
  assert(real.packageCount === 13, 'dcx47 packages 13 by written rule, got ' + real.packageCount);
  assert(real.stopNumbers.join(',') === '2,3,10,11,12,13,16,18,21,23,26,27', 'dcx47 stop list');
  var stop26 = real.packages.filter(function (p) { return p.stop === 26; });
  assert(stop26.length === 2, 'stop26 has 2 target packages, not 3');
  assert(real.packages.every(function (p) { return p.stop !== 31; }), 'stop31 13:00:50 excluded');
  assert(real.packages.every(function (p) { return p.stop !== 33; }), 'stop33 window 13:00 but plannedEnd 13:06 excluded');
  assert(real.lastStop === 27 && real.lastPlannedEndClock === '12:49:22', 'last target stop 27 / 12:49:22');

  // user-listed 10/11 is the subset after dropping stops 2 and 3
  var userList = real.stopNumbers.filter(function (s) { return s !== 2 && s !== 3; });
  assert(userList.join(',') === '10,11,12,13,16,18,21,23,26,27', 'user 10-stop list is subset excluding 2,3');
  var userPkgs = real.packages.filter(function (p) { return p.stop !== 2 && p.stop !== 3; });
  assert(userPkgs.length === 11, 'user 11 packages is subset excluding 2,3');

  console.log('cortex-13-priority-core.test.mjs OK');
}

run();
