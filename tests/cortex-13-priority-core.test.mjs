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
  // 10 Stops / 11 Packages was a hand-count miss. Do not treat it as expected.
  assert(!(real.stopCount === 10 && real.packageCount === 11), 'dcx47 must not regress to hand-count 10/11');

  // CSV fixture locks the same 12/13 rule against sanitized real-CSV columns (no PII).
  var csvText = readFileSync(join(__dirname, 'fixtures', 'cortex-13-priority', 'dcx47-csv-sanitized.csv'), 'utf8');
  var csvR = Core.extractFromCortexCsv(csvText);
  assert(csvR.ok, 'dcx47 csv parse ok');
  assert(csvR.stopCount === 12, 'dcx47 csv stops 12, got ' + csvR.stopCount + ' ' + JSON.stringify(csvR.stopNumbers));
  assert(csvR.packageCount === 13, 'dcx47 csv packages 13, got ' + csvR.packageCount);
  assert(csvR.stopNumbers.join(',') === '2,3,10,11,12,13,16,18,21,23,26,27', 'dcx47 csv stop list');
  assert(csvR.stopNumbers.join(',') === real.stopNumbers.join(','), 'csv stops match JSON fixture');
  assert(csvR.packageCount === real.packageCount, 'csv packages match JSON fixture');
  assert(csvR.stopNumbers.indexOf(2) >= 0 && csvR.stopNumbers.indexOf(3) >= 0, 'stops 2 and 3 stay included');
  assert(csvR.packages.filter(function (p) { return p.stop === 26; }).length === 2, 'csv stop26 has 2 target packages');
  assert(csvR.packages.every(function (p) { return p.stop !== 31; }), 'csv stop31 excluded');
  assert(csvR.packages.every(function (p) { return p.stop !== 33; }), 'csv stop33 plannedEnd 13:06 excluded');
  assert(csvR.lastStop === 27 && csvR.lastPlannedEndClock === '12:49:22', 'csv last stop 27 / 12:49:22');

  // 18 Route batch: one route-details failure keeps the other 17
  var eighteenDetails = [];
  var eighteenSummaries = [];
  for (var i = 0; i < 18; i++) {
    var code = 'DCX' + String(30 + i);
    eighteenSummaries.push({
      routeId: 'R' + i,
      routeCode: code,
      plannedDepartureTime: Date.parse('2026-09-18T11:12:00+09:00')
    });
    if (i === 7) {
      eighteenDetails.push({ notRouteDetails: true });
      continue;
    }
    eighteenDetails.push(details(
      [stop(1, Date.parse('2026-09-18T12:30:00+09:00'), [task({ domainMap: { scannableId: 'DA18' + i } })])],
      { rmsRouteDetails: {
        routeId: 'R' + i,
        routeCode: code,
        localDate: [2026, 9, 18],
        plannedDepartureTime: Date.parse('2026-09-18T11:12:00+09:00'),
        stops: [stop(1, Date.parse('2026-09-18T12:30:00+09:00'), [task({ domainMap: { scannableId: 'DA18' + i } })])]
      } }
    ));
  }
  var eighteen = Core.ingestBundle({
    selectedRouteCount: 18,
    summaries: { rmsRouteSummaries: eighteenSummaries },
    details: eighteenDetails
  });
  assert(eighteen.ok === true, '18-route bundle still ok after 1 failure');
  assert(eighteen.selectedRouteCount === 18, 'selected 18, got ' + eighteen.selectedRouteCount);
  assert(eighteen.successCount === 17, 'success 17, got ' + eighteen.successCount);
  assert(eighteen.failureCount === 1, 'failure 1, got ' + eighteen.failureCount);
  assert(eighteen.packageCount === 17, 'kept 17 packages, got ' + eighteen.packageCount);

  // bookmarklet-style: 17 details + 1 HTTP failure, remaining stays
  var oneHttpFail = Core.ingestBundle({
    selectedRouteCount: 18,
    details: eighteenDetails.filter(function (d) { return d && d.rmsRouteDetails; }),
    failures: [{ routeId: 'R7', routeCode: 'DCX37', error: 'UNAUTHORIZED', httpStatus: 401 }]
  });
  assert(oneHttpFail.ok && oneHttpFail.successCount === 17, 'HTTP fail on 1 route keeps 17');
  assert(oneHttpFail.failureCount === 1 && oneHttpFail.failures[0].error === Core.ERROR.UNAUTHORIZED, '401 labeled UNAUTHORIZED');
  assert(oneHttpFail.failures[0].message.indexOf('未ログイン') >= 0, '401 message is explicit');

  var unauth = Core.ingestBundle({ authError: 'UNAUTHORIZED', httpStatus: 401, details: [] });
  assert(unauth.ok === false && unauth.error === Core.ERROR.UNAUTHORIZED, 'summaries 401 is UNAUTHORIZED');
  assert(unauth.message.indexOf('未ログイン') >= 0, '401 UI message');
  var forbidden = Core.ingestBundle({ authError: 'FORBIDDEN', httpStatus: 403, details: [] });
  assert(forbidden.ok === false && forbidden.error === Core.ERROR.FORBIDDEN, 'summaries 403 is FORBIDDEN');
  assert(forbidden.message.indexOf('権限不足') >= 0, '403 UI message');
  assert(Core.describeHttpError(401).error === Core.ERROR.UNAUTHORIZED, 'describe 401');
  assert(Core.describeHttpError(403).error === Core.ERROR.FORBIDDEN, 'describe 403');
  assert(Core.classifyHttpError(401) === Core.ERROR.UNAUTHORIZED, 'classify 401');
  assert(Core.classifyHttpError(403) === Core.ERROR.FORBIDDEN, 'classify 403');

  var Glue = require('../cortex-13-priority.js');
  var src = Glue.bookmarkletSource();
  assert(src.indexOf('hour===11') >= 0, 'bookmarklet selects JST hour===11');
  assert(src.indexOf('route-summaries') >= 0 && src.indexOf('route-details') >= 0, 'bookmarklet hits both APIs');
  assert(src.indexOf('UNAUTHORIZED') >= 0 && src.indexOf('FORBIDDEN') >= 0, 'bookmarklet labels 401/403');
  assert(src.indexOf('credentials:"include"') >= 0, 'bookmarklet same-origin cookies only');
  assert(src.indexOf('document.cookie') < 0 && src.indexOf('Authorization') < 0, 'bookmarklet does not copy cookies/tokens');
  assert(src.indexOf('取得成功') >= 0 && src.indexOf('失敗') >= 0, 'bookmarklet reports success/fail counts');
  assert(src.indexOf('continue;') >= 0, 'bookmarklet continues after a failed route');

  var ingestedAuth = Glue.ingestJsonText(JSON.stringify({ authError: 'UNAUTHORIZED', httpStatus: 401, details: [] }), { refresh: true });
  assert(ingestedAuth.error === Core.ERROR.UNAUTHORIZED, 'glue surfaces 401');

  var eighteenFile = Core.ingestBundle(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'cortex-13-priority', 'eighteen-one-fail.json'), 'utf8')));
  assert(eighteenFile.selectedRouteCount === 18 && eighteenFile.successCount === 17 && eighteenFile.failureCount === 1, 'eighteen-one-fail.json fixture');
  var auth401File = Core.ingestBundle(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'cortex-13-priority', 'auth-401.json'), 'utf8')));
  assert(auth401File.error === Core.ERROR.UNAUTHORIZED, 'auth-401.json fixture');
  var auth403File = Core.ingestBundle(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'cortex-13-priority', 'auth-403.json'), 'utf8')));
  assert(auth403File.error === Core.ERROR.FORBIDDEN, 'auth-403.json fixture');

  console.log('cortex-13-priority-core.test.mjs OK');
}

run();
