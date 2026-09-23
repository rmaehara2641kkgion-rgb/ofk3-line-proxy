import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

// 2026-09-18 13:00 JST = 04:00Z
const W_END_1300 = Date.UTC(2026, 8, 18, 4, 0, 0) / 1000;
const W_START_1000 = Date.UTC(2026, 8, 18, 1, 0, 0) / 1000;
const W_END_1400 = Date.UTC(2026, 8, 18, 5, 0, 0) / 1000;
const PLANNED_1200 = Date.UTC(2026, 8, 18, 3, 0, 0);
const PLANNED_1330 = Date.UTC(2026, 8, 18, 4, 30, 0);

function task(opts) {
  return {
    taskType: opts.taskType || 'DROP_OFF',
    promiseType: 'STANDARD',
    timeWindowed: true,
    windowStartTime: W_START_1000,
    windowEndTime: opts.windowEndTime || W_END_1300,
    domainMap: opts.scannableId ? { scannableId: opts.scannableId } : {},
    referenceId: opts.referenceId,
    driverAssistText: opts.driverAssistText
  };
}

function stop(seq, tasks, plannedEnd) {
  return {
    sequenceNumber: seq,
    plannedStartTime: PLANNED_1200 - 60000,
    plannedEndTime: plannedEnd || PLANNED_1200,
    tasks: tasks
  };
}

function details(routeCode, stops) {
  return {
    rmsRouteDetails: {
      routeId: 'R-' + routeCode,
      routeCode: routeCode,
      localDate: [2026, 9, 18],
      plannedDepartureTime: Date.UTC(2026, 8, 18, 2, 0, 0),
      stops: stops
    },
    transporters: [{ firstName: 'Taro', lastName: 'Yamada' }],
    addresses: []
  };
}

function fixture() {
  return details('DCX40', [
    stop(3, [
      task({ scannableId: 'DA0000000001', referenceId: 'tr-a', driverAssistText: '101' }),
      task({ scannableId: 'DA0000000002', referenceId: 'tr-b', driverAssistText: '102' }),
      task({ scannableId: 'DA0000000009', referenceId: 'tr-late', windowEndTime: W_END_1400 })
    ]),
    stop(7, [task({ referenceId: 'tr-noscan', driverAssistText: '103' })]),
    stop(9, [task({ scannableId: 'DA0000000003', referenceId: 'tr-c' })], PLANNED_1330),
    stop(11, [task({ scannableId: 'DA0000000004', referenceId: 'tr-d' })]),
    stop(12, [task({ scannableId: 'DA0000000005', taskType: 'PICK_UP', referenceId: 'tr-pick' })])
  ]);
}

const BAG = 'JP_OB-AT-5597_NVY';

function suite(Core, label) {
  // 1. only 13:00 priority packages become targets (same set as extractFromRouteDetails)
  (function () {
    var d = fixture();
    var sel = Core.selectBagTargets([d], {});
    var refs = sel.targets.map(function (t) { return t.referenceId; });
    assert(refs.join(',') === 'tr-a,tr-b,tr-d', label + ' 1: targets ' + refs.join(','));
    var prio = Core.extractFromRouteDetails(d).packages.map(function (p) { return p.stop; });
    assert(sel.priorityCount === prio.length, label + ' 1: same 13:00 rule as extractFromRouteDetails');
    assert(sel.targets[0].scannableId === 'DA0000000001' && sel.targets[0].stop === 3 &&
      sel.targets[0].routeCode === 'DCX40', label + ' 1: target shape');
  })();

  // 2. already captured referenceId is excluded (0 clicks)
  (function () {
    var sel = Core.selectBagTargets([fixture()], { 'tr-a': { trId: 'tr-a', bagName: null } });
    assert(sel.targets.every(function (t) { return t.referenceId !== 'tr-a'; }), label + ' 2: captured excluded');
    assert(sel.skipped.alreadyCaptured === 1, label + ' 2: counted');
  })();

  // 3. no domainMap.scannableId -> not a DOM target (no trackingIdOf/referenceId fallback)
  (function () {
    var sel = Core.selectBagTargets([fixture()], {});
    assert(sel.targets.every(function (t) { return t.referenceId !== 'tr-noscan'; }), label + ' 3: excluded');
    assert(sel.skipped.missingScannableId === 1, label + ' 3: counted');
  })();

  // 4. DOM exact match only
  (function () {
    var m = Core.indexExactDomTextMatches([
      { text: ' DA0000000001 \n', key: 0 },
      { text: 'DA00000000012', key: 1 },
      { text: 'xDA0000000001', key: 2 },
      { text: 'DA0000000001 / 101', key: 3 },
      { text: 'DA0000000002', key: 4 }
    ], ['DA0000000001', 'DA0000000003']);
    assert(m.DA0000000001.length === 1 && m.DA0000000001[0] === 0, label + ' 4: exact only');
    assert(!m.DA0000000002 && !m.DA0000000003, label + ' 4: unwanted/absent not indexed');
    assert(Core.domMatchStatus(m.DA0000000001) === 'unique', label + ' 4: unique');
    assert(Core.domMatchStatus(m.DA0000000003) === 'none', label + ' 4: none');
  })();

  // 5. two exact matches -> ambiguous
  (function () {
    var m = Core.indexExactDomTextMatches([
      { text: 'DA0000000001', key: 'x' },
      { text: 'DA0000000001', key: 'y' }
    ], ['DA0000000001']);
    assert(Core.domMatchStatus(m.DA0000000001) === 'ambiguous', label + ' 5: ambiguous');
  })();

  // 6 / 7. captured vs captured_null (null is a final state, not a retry)
  (function () {
    var store = Core.createCaptureStore();
    Core.applyCapturedCortexResponse(store, {
      url: 'https://x/operations/execution/api/tasks/trDetails', status: 200,
      body: { trDetails: [
        { trId: 'tr-a', bagName: BAG, bagScannableId: 'scan-a' },
        { trId: 'tr-b', bagName: null, bagScannableId: null }
      ] }
    });
    assert(Core.capturedBagStatus(store.trDetailsByTrId, 'tr-a') === 'captured', label + ' 6: captured');
    assert(Core.capturedBagStatus(store.trDetailsByTrId, 'tr-b') === 'captured_null', label + ' 7: captured_null');
    assert(Core.capturedBagStatus(store.trDetailsByTrId, 'tr-d') === null, label + ' 7: not fetched');
    var run = Core.createBagRun(Core.selectBagTargets([fixture()], {}).targets);
    var pend = Core.pendingBagTargets(run, run.targets, store.trDetailsByTrId).map(function (t) { return t.referenceId; });
    assert(pend.join(',') === 'tr-d', label + ' 7: captured_null not retried');
    var s = Core.summarizeBagRun(run, store.trDetailsByTrId);
    assert(s.counts.captured === 1 && s.counts.captured_null === 1 && s.counts.not_attempted === 1, label + ' 6/7: counts');
    var ingested = Core.ingestBundle(Core.buildCaptureBundle(Object.assign(store, {
      detailsByRouteId: { 'R-DCX40': fixture() }
    })));
    var byRef = {};
    ingested.packageAssistIndex.forEach(function (r) { byRef[r.referenceId] = r; });
    assert(byRef['tr-a'].bagStatus === 'captured' && byRef['tr-a'].bagSource === 'trDetails' &&
      byRef['tr-a'].bagDisplay === 'Navy 5597', label + ' 6: index captured');
    assert(byRef['tr-b'].bagStatus === 'captured_null' && byRef['tr-b'].bagName == null, label + ' 7: index null');
    assert(byRef['tr-d'].bagStatus === 'not_attempted' && byRef['tr-d'].bagSource == null, label + ' 7: index untouched');
  })();

  // 8. bag -> later null keeps the bag
  (function () {
    var map = {};
    Core.mergeTrDetailsMaps(map, { 'tr-a': { trId: 'tr-a', bagName: BAG, bagScannableId: 'scan-a' } });
    Core.mergeTrDetailsMaps(map, { 'tr-a': { trId: 'tr-a', bagName: null, bagScannableId: null } });
    assert(map['tr-a'].bagName === BAG && map['tr-a'].bagScannableId === 'scan-a', label + ' 8: bag kept');
    assert(map['tr-a'].nullSeenAfterCapture === true, label + ' 8: diagnostic flag');
    var store = Core.createCaptureStore();
    var url = 'https://x/operations/execution/api/tasks/trDetails';
    Core.applyCapturedCortexResponse(store, { url: url, status: 200, body: { trDetails: [{ trId: 'tr-a', bagName: BAG }] } });
    Core.applyCapturedCortexResponse(store, { url: url, status: 200, body: { trDetails: [{ trId: 'tr-a', bagName: null }] } });
    assert(store.trDetailsByTrId['tr-a'].bagName === BAG, label + ' 8: interceptor path keeps bag');
    var ing = Core.ingestBundle({ details: [fixture()], trDetails: [
      { trId: 'tr-a', bagName: BAG }, { trId: 'tr-a', bagName: null }
    ] });
    var row = ing.packageAssistIndex.filter(function (r) { return r.referenceId === 'tr-a'; })[0];
    assert(row.bagName === BAG, label + ' 8: ingest keeps bag');
  })();

  // 9. null -> later bag upgrades
  (function () {
    var map = {};
    Core.mergeTrDetailsMaps(map, { 'tr-a': { trId: 'tr-a', bagName: null } });
    Core.mergeTrDetailsMaps(map, { 'tr-a': { trId: 'tr-a', bagName: BAG, bagScannableId: 's' } });
    assert(map['tr-a'].bagName === BAG && !map['tr-a'].nullSeenAfterCapture, label + ' 9: upgraded');
  })();

  // 10. one Response with several trDetails -> next package needs no click
  (function () {
    var store = Core.createCaptureStore();
    var run = Core.createBagRun(Core.selectBagTargets([fixture()], {}).targets);
    Core.markBagAttempted(run, 'tr-a');
    Core.applyCapturedCortexResponse(store, {
      url: 'https://x/operations/execution/api/tasks/trDetails', status: 200,
      body: { trDetails: [{ trId: 'tr-a', bagName: BAG }, { trId: 'tr-b', bagName: 'JP_OB-AT-1111_RED' }] }
    });
    var pend = Core.pendingBagTargets(run, run.targets, store.trDetailsByTrId).map(function (t) { return t.referenceId; });
    assert(pend.join(',') === 'tr-d', label + ' 10: tr-b skipped without click');
  })();

  // 11. attempted package is never clicked again in the same run (timeout/click_failed too)
  (function () {
    var run = Core.createBagRun(Core.selectBagTargets([fixture()], {}).targets);
    Core.recordBagResult(run, 'tr-a', Core.BAG_STATUS.TIMEOUT, '');
    Core.recordBagResult(run, 'tr-b', Core.BAG_STATUS.CLICK_FAILED, '');
    var pend = Core.pendingBagTargets(run, run.targets, {}).map(function (t) { return t.referenceId; });
    assert(pend.join(',') === 'tr-d', label + ' 11: attempted excluded');
    assert(Core.bagTargetAttempted(run, 'tr-a') && !Core.bagTargetAttempted(run, 'tr-d'), label + ' 11: attempted set');
    var s = Core.summarizeBagRun(run, {});
    assert(s.counts.timeout === 1 && s.counts.click_failed === 1 && s.counts.not_attempted === 1, label + ' 11: counts');
    // a later multi-row Response still upgrades a timed-out target
    var s2 = Core.summarizeBagRun(run, { 'tr-a': { trId: 'tr-a', bagName: BAG } });
    assert(s2.byReferenceId['tr-a'] === 'captured', label + ' 11: captured wins over timeout');
    assert(/captured 1/.test(Core.formatBagSummary(s2)) && /timeout 0/.test(Core.formatBagSummary(s2)), label + ' 11: summary text');
  })();

  // 12 / 13. Bag phase timeout/failure keeps normal results and never adds failures
  (function () {
    var store = Core.createCaptureStore();
    store.summaries = { rmsRouteSummaries: [] };
    store.detailsByRouteId = { 'R-DCX40': fixture() };
    var before = Core.ingestBundle(Core.buildCaptureBundle(store));
    var snap = Core.snapshotNormalCapture(store);
    var run = Core.createBagRun(Core.selectBagTargets([fixture()], {}).targets);
    // During the phase Cortex re-fetches: one failing, one altered route-details.
    Core.applyCapturedCortexResponse(store, {
      url: 'https://x/operations/execution/api/route-details/R-DCX40', status: 500, body: {}
    });
    var altered = fixture();
    altered.rmsRouteDetails.stops = [];
    Core.applyCapturedCortexResponse(store, {
      url: 'https://x/operations/execution/api/route-details/R-DCX40', status: 200, body: altered
    });
    Core.recordBagResult(run, 'tr-a', Core.BAG_STATUS.TIMEOUT, '');
    Core.recordBagResult(run, 'tr-b', Core.BAG_STATUS.DOM_NOT_FOUND, '');
    assert(store.failures.length === 1, label + ' 13: precondition failure captured during phase');
    Core.restoreNormalCapture(store, snap);
    var sum = Core.summarizeBagRun(run, store.trDetailsByTrId);
    store.bagStatusByReferenceId = sum.byReferenceId;
    var after = Core.ingestBundle(Core.buildCaptureBundle(store));
    assert(store.failures.length === 0 && after.failureCount === 0, label + ' 13: no failures added');
    assert(JSON.stringify(after.packages) === JSON.stringify(before.packages), label + ' 12: packages kept');
    assert(JSON.stringify(after.routeStops) === JSON.stringify(before.routeStops), label + ' 12: routeStops kept');
    assert(JSON.stringify(after.packageSequenceIndex) === JSON.stringify(before.packageSequenceIndex), label + ' 12: sequence kept');
    assert(after.successCount === before.successCount && after.ok, label + ' 12: success kept');
    var byRef = {};
    after.packageAssistIndex.forEach(function (r) { byRef[r.referenceId] = r; });
    assert(byRef['tr-a'].bagStatus === 'timeout' && byRef['tr-b'].bagStatus === 'dom_not_found', label + ' 12: statuses in index');
    assert(byRef['tr-a'].driverAid === '101', label + ' 12: Driver Aid kept');
  })();

  // 14. packageAssistIndex backward compatible (old fields intact, old bundle without statuses)
  (function () {
    var ing = Core.ingestBundle({ details: [fixture()], trDetails: [{ trId: 'tr-a', bagName: 'JP_OB-AM-1956_YLO', bagScannableId: 's' }] });
    var row = ing.packageAssistIndex.filter(function (r) { return r.referenceId === 'tr-a'; })[0];
    ['routeCode', 'trackingId', 'referenceId', 'driverAid', 'bagName', 'bagScannableId',
      'bagColorCode', 'bagColor', 'bagNumber', 'bagDisplay'].forEach(function (k) {
      assert(Object.prototype.hasOwnProperty.call(row, k), label + ' 14: field ' + k);
    });
    assert(row.bagDisplay === '黄色 1956' && row.bagColorCode === 'YLO' && row.bagNumber === '1956', label + ' 14: parser unchanged');
    var unknown = Core.parseBagName('JP_OB-AT-5597_XYZ');
    assert(unknown.bagColor == null && unknown.bagNumber === '5597', label + ' 14: unknown color not translated');
    var bundle = Core.buildCaptureBundle(Core.createCaptureStore());
    assert(!Object.prototype.hasOwnProperty.call(bundle, 'bagStatusByReferenceId'), label + ' 14: bundle unchanged without bag run');
  })();

  console.log('ok: bag enrichment core (' + label + ')');
}

const RootCore = require('../cortex-13-priority-core.js');
suite(RootCore, 'root core');
delete globalThis.Cortex13PriorityCore;
const PhaseCore = require('../cortex-capture-extension/phase1-core.js');
assert(PhaseCore !== RootCore, 'phase1-core loaded separately');
suite(PhaseCore, 'phase1-core');

// Runner: separate phase, native click only, tour untouched.
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  function body(name) {
    const start = runner.indexOf('  function ' + name + '(');
    assert(start >= 0, 'runner has ' + name);
    const end = runner.indexOf('\n  }\n', start);
    return runner.slice(start, end);
  }
  ['runNextRoute', 'waitForCurrentRoute', 'restoreRouteListThenContinue', 'finishCurrentAndContinue',
    'clickRoute', 'beginPoc', 'visibleTargetRoute'].forEach(function (name) {
    assert(!/bag/i.test(body(name)), 'tour function ' + name + ' has no Bag logic');
  });
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  assert(bag.length > 1000, 'bag block present');
  assert(bag.indexOf('requestCdpClick(') >= 0 && bag.indexOf('scrollIntoView') >= 0 &&
    bag.indexOf('viewportClickPoint') >= 0 && bag.indexOf('requestAnimationFrame') >= 0, 'bag uses existing CDP click path');
  assert(bag.indexOf('fetch(') < 0 && bag.indexOf('XMLHttpRequest') < 0, 'bag does not create requests');
  assert(bag.indexOf('MutationObserver') < 0 && bag.indexOf('setInterval') < 0, 'bag has no persistent watchers');
  assert(bag.indexOf('failures.push') < 0, 'bag never records failures');
  assert(bag.indexOf('hasTrDetails(store.trDetailsByTrId, target.referenceId)') >= 0, 'bag waits on trId presence, not bagName');
  assert(bag.indexOf('restoreNormalCapture') >= 0 && bag.indexOf('snapshotNormalCapture') >= 0, 'bag freezes normal results');
  assert(bag.indexOf('trackingIdOf') < 0, 'bag DOM match does not use trackingIdOf');
  assert((runner.match(/setInterval\(/g) || []).length === 1, 'no new setInterval');
  assert(runner.indexOf("mk('Bag取得'") >= 0, 'panel has Bag取得 button');
  assert(runner.indexOf('startBagPhase();') >= 0 && !/function beginPoc[\s\S]{0,4000}startBagPhase/.test(runner.slice(runner.indexOf('function beginPoc'), runner.indexOf('function start()'))), 'bag not auto-started by the tour');
  const all = runner + readFileSync(join(root, 'cortex-capture-extension', 'phase1-core.js'), 'utf8');
  assert(!/fetch\s*\(\s*['"`][^'"`]*trDetails/.test(all), 'no direct trDetails fetch');
  assert(all.indexOf('document.cookie') < 0 && all.indexOf('setRequestHeader') < 0, 'no auth reuse');
  console.log('ok: runner bag phase isolated from tour');
})();
