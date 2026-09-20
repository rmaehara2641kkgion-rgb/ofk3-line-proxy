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
  assert(eighteen.totalRouteCount === 18, 'total from summaries 18, got ' + eighteen.totalRouteCount);
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

  var okReport = Core.formatFetchReport({
    summariesOk: true,
    totalRouteCount: 22,
    selectedRouteCount: 18,
    successCount: 18,
    failureCount: 0,
    saved: true
  });
  assert(okReport.indexOf('Cortex取得完了') >= 0, 'report title');
  assert(okReport.indexOf('全Route: 22') >= 0, 'report total routes');
  assert(okReport.indexOf('11時Route: 18') >= 0, 'report 11 hour routes');
  assert(okReport.indexOf('取得成功: 18') >= 0, 'report success');
  assert(okReport.indexOf('取得失敗: 0') >= 0, 'report fail 0');
  assert(okReport.indexOf('JSONを保存しました') >= 0, 'report saved');
  assert(okReport.indexOf('FAILED') < 0, 'no FAILED block on success');

  var failReport = Core.formatFetchReport({
    summariesOk: true,
    totalRouteCount: 22,
    selectedRouteCount: 18,
    successCount: 17,
    failureCount: 1,
    saved: true,
    failures: [{ routeCode: 'DCX37', routeId: 'R7', httpStatus: 401, error: 'UNAUTHORIZED' }]
  });
  assert(failReport.indexOf('取得成功: 17') >= 0 && failReport.indexOf('取得失敗: 1') >= 0, 'partial fail counts');
  assert(failReport.indexOf('FAILED') >= 0 && failReport.indexOf('DCX37') >= 0, 'FAILED route code');
  assert(failReport.indexOf('HTTP 401') >= 0 && failReport.indexOf('UNAUTHORIZED') >= 0, 'FAILED http status');

  var sum401 = Core.formatFetchReport({
    summariesOk: false,
    summariesStatus: 401,
    summariesError: 'UNAUTHORIZED',
    saved: true
  });
  assert(sum401.indexOf('route-summaries 取得失敗') >= 0, 'summaries fail title');
  assert(sum401.indexOf('HTTP 401') >= 0 && sum401.indexOf('UNAUTHORIZED') >= 0, 'summaries 401');
  assert(sum401.indexOf('セッション切れ・未ログイン') >= 0, '401 meaning');
  var sum403 = Core.formatFetchReport({
    summariesOk: false,
    summariesStatus: 403,
    summariesError: 'FORBIDDEN',
    saved: true
  });
  assert(sum403.indexOf('FORBIDDEN') >= 0 && sum403.indexOf('権限不足') >= 0, '403 meaning');

  var dcx47Url = '/operations/execution/api/route-details/2894472-47?historicalDay=false&routeId=2894472-47&serviceAreaId=4b1373ef-71d3-4239-98e1-4d7fafc93877';
  var summariesUrl = '/operations/execution/api/route-summaries?historicalDay=false&serviceAreaId=4b1373ef-71d3-4239-98e1-4d7fafc93877';
  assert(Core.isCortexApiCaptureUrl(dcx47Url), 'dcx47 route-details URL is captured');
  assert(Core.isCortexApiCaptureUrl(summariesUrl), 'route-summaries URL is captured');
  assert(Core.routeIdFromDetailsUrl(dcx47Url) === '2894472-47', 'routeId from details URL');
  assert(!Core.isCortexApiCaptureUrl('https://logistics.amazon.co.jp/operations/execution/routes'), 'non-API Cortex page is not captured');

  var capStore = Core.createCaptureStore();
  var secretHeaders = {
    Cookie: 'session=NOPE',
    Authorization: 'Bearer NOPE',
    'x-cortex-hmac-signature': 'NOPE-HMAC',
    'x-cortex-session': 'NOPE-SESSION',
    'x-cortex-timestamp': 'NOPE-TS'
  };
  Core.applyCapturedCortexResponse(capStore, {
    url: summariesUrl,
    status: 200,
    headers: secretHeaders,
    body: {
      rmsRouteSummaries: [{
        routeId: '2894472-47',
        routeCode: 'DCX47',
        plannedDepartureTime: Date.parse('2026-09-18T11:12:00+09:00')
      }],
      Cookie: 'NOPE-BODY',
      Authorization: 'NOPE-BODY',
      'x-cortex-hmac-signature': 'NOPE-BODY'
    }
  });
  Core.applyCapturedCortexResponse(capStore, {
    url: dcx47Url,
    status: 200,
    headers: secretHeaders,
    body: Object.assign({
      Cookie: 'NOPE-BODY',
      Authorization: 'NOPE-BODY',
      'x-cortex-hmac-signature': 'NOPE-BODY',
      'x-cortex-session': 'NOPE-BODY',
      'x-cortex-timestamp': 'NOPE-BODY'
    }, dcx47)
  });
  Core.applyCapturedCortexResponse(capStore, {
    url: dcx47Url,
    status: 200,
    headers: secretHeaders,
    body: dcx47
  });
  assert(Object.keys(capStore.detailsByRouteId).join(',') === '2894472-47', 'details deduped by routeId');
  var capBundle = Core.buildCaptureBundle(capStore, { localDate: '2026-09-18' });
  assert(capBundle.captureMode === 'spa-intercept', 'captureMode spa-intercept');
  assert(Array.isArray(capBundle.details) && Array.isArray(capBundle.failures), '{details,failures} shape');
  assert(capBundle.details.length === 1, 'captured 1 details body');
  assert(capBundle.summaries && capBundle.summaries.rmsRouteSummaries.length === 1, 'captured summaries');
  var dumped = JSON.stringify(capBundle);
  assert(dumped.indexOf('NOPE') < 0, 'secret header/body keys not saved');
  assert(dumped.indexOf('x-cortex-hmac-signature') < 0, 'hmac key not saved');
  assert(dumped.indexOf('x-cortex-session') < 0, 'session key not saved');
  assert(dumped.indexOf('x-cortex-timestamp') < 0, 'timestamp key not saved');
  var capExtract = Core.extractFromRouteDetails(capBundle.details[0]);
  assert(capExtract.stopCount === 12 && capExtract.packageCount === 13, 'captured DCX47 still 12/13');

  var Glue = require('../cortex-13-priority.js');
  var ingestedCap = Glue.ingestJsonText(JSON.stringify(capBundle), { refresh: true });
  assert(ingestedCap.ok, 'ingestJsonText reads captured bundle');
  assert(ingestedCap.stopCount === 12, 'captured ingest stops 12, got ' + ingestedCap.stopCount);
  assert(ingestedCap.packageCount === 13, 'captured ingest packages 13, got ' + ingestedCap.packageCount);
  assert(ingestedCap.selectedRouteCount === 1, 'captured summaries still use 11:00 selection');

  var nCounts = [17, 19];
  nCounts.forEach(function (n) {
    var rows = [];
    for (var i = 0; i < n; i++) {
      rows.push({
        routeId: 'R' + i,
        routeCode: 'DCX' + (30 + i),
        plannedDepartureTime: Date.parse('2026-09-18T11:12:00+09:00')
      });
    }
    rows.push({
      routeId: 'BIKE',
      routeCode: 'DCX99',
      plannedDepartureTime: Date.parse('2026-09-18T09:07:00+09:00')
    });
    var picked = Core.tourRoutesFromSummaries({ rmsRouteSummaries: rows });
    assert(picked.length === n, '11:00 count is dynamic ' + n + ', got ' + picked.length);
  });

  var tourStore = Core.createCaptureStore();
  Core.applyCapturedCortexResponse(tourStore, {
    url: summariesUrl,
    status: 200,
    headers: secretHeaders,
    body: {
      rmsRouteSummaries: [
        { routeId: 'R1', routeCode: 'DCX31', plannedDepartureTime: Date.parse('2026-09-18T11:12:00+09:00') },
        { routeId: 'R2', routeCode: 'DCX47', plannedDepartureTime: Date.parse('2026-09-18T11:07:00+09:00') },
        { routeId: 'R3', routeCode: 'DCX48', plannedDepartureTime: Date.parse('2026-09-18T11:20:00+09:00') },
        { routeId: 'R9', routeCode: 'DCX10', plannedDepartureTime: Date.parse('2026-09-18T09:07:00+09:00') }
      ]
    }
  });
  var tour = Core.armTour(tourStore, Core.createTourState({ timeoutMs: 50 }));
  assert(tour.routes.length === 3, 'tour targets 11:00 routes only, got ' + tour.routes.length);
  var p0 = Core.tourProgress(tourStore, tour);
  assert(p0.selectedCount === 3 && p0.detailsCount === 0 && p0.detailsTotal === 3, 'N-route progress 0/3');
  var first = Core.nextTourRoute(tourStore, tour);
  assert(first.routeCode === 'DCX31', 'first pending is DCX31');
  Core.applyCapturedCortexResponse(tourStore, {
    url: '/operations/execution/api/route-details/R1',
    status: 200,
    body: details([stop(1, Date.parse('2026-09-18T12:30:00+09:00'), [task({ domainMap: { scannableId: 'DAA' } })])], {
      rmsRouteDetails: {
        routeId: 'R1',
        routeCode: 'DCX31',
        localDate: [2026, 9, 18],
        plannedDepartureTime: Date.parse('2026-09-18T11:12:00+09:00'),
        stops: [stop(1, Date.parse('2026-09-18T12:30:00+09:00'), [task({ domainMap: { scannableId: 'DAA' } })])]
      }
    })
  });
  Core.applyCapturedCortexResponse(tourStore, {
    url: '/operations/execution/api/route-details/R1',
    status: 200,
    body: tourStore.detailsByRouteId.R1
  });
  assert(Object.keys(tourStore.detailsByRouteId).length === 1, 'duplicate details still 1 route');
  var p1 = Core.tourProgress(tourStore, tour);
  assert(p1.detailsCount === 1 && p1.successCount === 1, 'progress 1/3 after first capture');
  var second = Core.nextTourRoute(tourStore, tour);
  assert(second.routeCode === 'DCX47', 'second pending DCX47');
  Core.applyTourTimeout(tourStore, tour);
  assert(tourStore.failures.length === 1, 'timeout recorded');
  assert(tourStore.failures[0].routeId === 'R2', 'timeout keeps routeId');
  assert(tourStore.failures[0].routeCode === 'DCX47', 'timeout keeps routeCode');
  assert(tourStore.failures[0].error === Core.ERROR.TIMEOUT, 'timeout error code');
  assert(tourStore.failures[0].message.indexOf('捕捉') >= 0, 'timeout message');
  var failDump = JSON.stringify(tourStore.failures);
  assert(failDump.indexOf('Cookie') < 0 && failDump.indexOf('hmac') < 0, 'failures have no auth');
  var third = Core.nextTourRoute(tourStore, tour);
  assert(third && third.routeCode === 'DCX48', 'continues to next after timeout, got ' + (third && third.routeCode));
  Core.applyCapturedCortexResponse(tourStore, {
    url: '/operations/execution/api/route-details/R3',
    status: 200,
    body: details([stop(1, Date.parse('2026-09-18T12:40:00+09:00'), [task({ domainMap: { scannableId: 'DAC' } })])], {
      rmsRouteDetails: {
        routeId: 'R3',
        routeCode: 'DCX48',
        localDate: [2026, 9, 18],
        plannedDepartureTime: Date.parse('2026-09-18T11:20:00+09:00'),
        stops: [stop(1, Date.parse('2026-09-18T12:40:00+09:00'), [task({ domainMap: { scannableId: 'DAC' } })])]
      }
    })
  });
  var last = Core.nextTourRoute(tourStore, tour);
  assert(last == null && tour.status === 'done', 'tour completes remaining routes');
  var pDone = Core.tourProgress(tourStore, tour);
  assert(pDone.successCount === 2 && pDone.failureCount === 1, '2 success / 1 timeout');
  var tourBundle = Core.buildCaptureBundle(tourStore, { localDate: '2026-09-18' });
  assert(tourBundle.selectedRouteCount === 3, 'bundle selectedRouteCount from 11:00 routes');
  assert(tourBundle.details.length === 2 && tourBundle.failures.length === 1, 'bundle keeps successes and failure');

  Core.armTour(tourStore, tour);
  assert(Core.nextTourRoute(tourStore, tour) == null, 'rerun skips visited routeIds');
  Core.recordTourFailure(tourStore, { routeId: 'R2', routeCode: 'DCX47' }, {
    error: 'TIMEOUT',
    message: 'route-details が時間内に捕捉できませんでした（XHR未検出）'
  });
  assert(tourStore.failures.length === 1, 'same routeId failure is not stacked');

  assert(Core.routeCardSelector('2899328-44') === '.route-2899328-44', 'route card selector from routeId');
  assert(Core.classListHasRouteCard('css-1yz1a18 route-2899328-44 hover', '2899328-44'), 'exact route class token');
  assert(!Core.classListHasRouteCard('css-1yz1a18 route-2899328-440 hover', '2899328-44'), 'does not match longer route class');
  var innerPick = Core.pickRouteCardClickTarget([
    { tag: 'div', title: '', text: 'DCX44 extra' },
    { tag: 'p', title: 'DCX44', text: 'DCX44' },
    { tag: 'span', title: '', text: 'DCX44' }
  ], { routeId: '2899328-44', routeCode: 'DCX44' });
  assert(innerPick === 2, 'click target is titled route span, not the card div, got ' + innerPick);
  assert(Core.ROUTE_CARD_CLICK_EVENTS.join(',') === 'pointerdown,mousedown,pointerup,mouseup,click', 'bubbling click sequence only');

  var dirtyFailStore = Core.createCaptureStore();
  Core.recordTourFailure(dirtyFailStore, { routeId: 'Rx', routeCode: 'DCX1' }, {
    error: 'TIMEOUT',
    message: 'route-details が時間内に捕捉できませんでした',
    Cookie: 'NOPE',
    Authorization: 'NOPE',
    'x-cortex-hmac-signature': 'NOPE'
  });
  var dirtyFail = JSON.stringify(dirtyFailStore.failures);
  assert(dirtyFail.indexOf('NOPE') < 0, 'recordTourFailure sanitizes secrets');

  var pick = Core.pickRouteClickCandidate([
    { tag: 'span', text: 'DCX47', href: '', dataRouteId: '' },
    { tag: 'td', text: 'DCX47', href: '', dataRouteId: '' },
    { tag: 'a', text: 'DCX47', href: '/operations/execution/dv/routes/2894472-47', role: 'link' }
  ], { routeId: '2894472-47', routeCode: 'DCX47' });
  assert(pick === 2, 'click target is route link, not span/td');
  assert(Core.isLeafTextClickTarget({ tag: 'span', text: 'DCX47' }), 'span is not a click target');
  assert(Core.isClickableRouteControl({ tag: 'a', href: '/operations/execution/dv/routes/2894472-47' }), 'dv/routes link is clickable');
  var chainIdx = Core.resolveClickableAncestor([
    { tag: 'span', text: 'DCX25' },
    { tag: 'td', text: 'DCX25 driver' },
    { tag: 'a', href: '/operations/execution/dv/routes/2894472-25', role: 'link', text: 'DCX25' }
  ], { routeId: '2894472-25', routeCode: 'DCX25' });
  assert(chainIdx === 2, 'inner span resolves to ancestor route link, got ' + chainIdx);
  assert(Core.resolveClickableAncestor([
    { tag: 'span', text: 'DCX25' },
    { tag: 'td', text: 'DCX25' }
  ], { routeId: '2894472-25', routeCode: 'DCX25' }) === -1, 'span/td only chain is not clicked');
  var wrongLink = Core.pickRouteClickCandidate([
    { tag: 'a', href: '/operations/execution/dv/routes/OTHER', text: 'DCX99' },
    { tag: 'a', href: '/operations/execution/dv/routes/2894472-25', text: 'DCX25', role: 'link' }
  ], { routeId: '2894472-25', routeCode: 'DCX25' });
  assert(wrongLink === 1, 'href routeId selects the matching route link');
  assert(Core.textHasRouteCode('Route DCX47 assigned', 'DCX47'), 'token match DCX47');
  assert(!Core.textHasRouteCode('DCX470', 'DCX47'), 'DCX470 is not DCX47');

  var src = Glue.bookmarkletSource();
  assert(src.length < 800, 'tiny launcher, got ' + src.length);
  assert(src.indexOf('__OFK3_CORTEX_CAPTURE__') >= 0, 'tiny launcher starts injected runner');
  assert(src.indexOf('sumUrl') < 0 && src.indexOf('detUrl') < 0, 'launcher does not construct API URLs');
  assert(src.indexOf('fetch(') < 0, 'launcher does not fetch');
  assert(src.indexOf('credentials') < 0, 'launcher does not set credentials');
  assert(src.indexOf('document.cookie') < 0, 'launcher does not read cookies');
  assert(src.indexOf('x-cortex-hmac-signature') < 0 && src.indexOf('x-cortex-session') < 0 && src.indexOf('x-cortex-timestamp') < 0, 'launcher does not name Cortex auth headers');
  assert(src.indexOf('localStorage') < 0, 'launcher does not write localStorage');
  assert(src.indexOf('hour===11') < 0, 'launcher does not reimplement 11:00 filter');

  var runnerSrc = readFileSync(join(__dirname, '..', 'cortex-13-capture-runner.js'), 'utf8');
  var coreSrc = readFileSync(join(__dirname, '..', 'cortex-13-priority-core.js'), 'utf8');
  var bgSrc = readFileSync(join(__dirname, '..', 'cortex-capture-extension', 'background.js'), 'utf8');
  var glueSrc = readFileSync(join(__dirname, '..', 'cortex-13-priority.js'), 'utf8');
  function assertNoDirectFetch(text, name) {
    assert(!/fetch\s*\(\s*['"`][^'"`]*\/operations\/execution\/api\//.test(text), name + ' no Cortex API fetch URL');
    assert(text.indexOf('sumUrl') < 0 && text.indexOf('detUrl') < 0, name + ' no constructed API URLs');
    assert(text.indexOf('credentials:"include"') < 0 && text.indexOf("credentials:'include'") < 0, name + ' no credentials include');
    assert(text.indexOf('x-cortex-hmac-signature') < 0, name + ' no hmac header');
    assert(text.indexOf('document.cookie') < 0, name + ' no document.cookie');
    assert(text.indexOf('setRequestHeader') < 0, name + ' no HMAC setRequestHeader');
    assert(!/selectedRouteCount\s*[:=]\s*18/.test(text), name + ' no hardcoded selectedRouteCount 18');
    assert(!/\bfor\s*\([^)]*<\s*18\s*;/.test(text), name + ' no for i<18');
  }
  assertNoDirectFetch(runnerSrc, 'runner');
  assertNoDirectFetch(coreSrc, 'core');
  assertNoDirectFetch(glueSrc, 'glue');
  assertNoDirectFetch(bgSrc, 'extension background');
  assert(runnerSrc.indexOf('origFetch.apply') >= 0, 'runner wraps SPA fetch only');
  assert(runnerSrc.indexOf('findRouteCardByRouteId') >= 0, 'runner still finds .route-{routeId} card');
  assert(runnerSrc.indexOf('findInnerClickTarget') >= 0, 'runner clicks inner route title/span');
  assert(runnerSrc.indexOf('pointerover') < 0 && runnerSrc.indexOf('mouseover') < 0, 'runner does not add hover events');
  assert(runnerSrc.indexOf('typeof window') >= 0 && runnerSrc.indexOf('bubbles: true') >= 0, 'runner bubbles with window view');
  assert(runnerSrc.indexOf('clone().json()') >= 0 && runnerSrc.indexOf('responseText') >= 0, 'runner reads SPA body only');
  assert(runnerSrc.indexOf('getResponseHeader') < 0 && runnerSrc.indexOf('getAllResponseHeaders') < 0, 'runner does not read response headers');
  assert(coreSrc.indexOf('parts.hour === ELEVEN_HOUR') >= 0, '11:00 uses ELEVEN_HOUR');
  assert(runnerSrc.indexOf('selectElevenOClockRoutes') >= 0 || runnerSrc.indexOf('armTour') >= 0, 'runner uses core 11:00 selection');
  assert(readFileSync(join(__dirname, '..', 'cortex-capture-extension', 'cortex-13-priority-core.js'), 'utf8') === coreSrc, 'extension core matches');
  assert(readFileSync(join(__dirname, '..', 'cortex-capture-extension', 'cortex-13-capture-runner.js'), 'utf8') === runnerSrc, 'extension runner matches');

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
