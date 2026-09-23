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

// ---------------- v2: Route -> Stop -> Package engine ----------------
// Fake driver models a Cortex Route detail: stops (collapsed/expanded), package cards, trDetails.
function fakeWorld(spec) {
  // spec.routes: { code: { openFails, backFails, stops: { seq: { expanded, expandFails, missing,
  //   labelCount, packages: [{ da, ref, clickable, tr: [[trId, bagName]], dup }] } } } }
  const log = { stopClicks: [], packageClicks: [], opened: [], back: 0, progress: [] };
  const trMap = {};
  let current = null;
  function stopOf(stop) { return current && current.stops[stop.stop]; }
  function daVisible(st, da) {
    return !!(st && st.expanded && st.packages.some((p) => p.da === da));
  }
  const driver = {
    openRoute(route, cb) {
      const r = spec.routes[route.routeCode];
      if (r.throwOnOpen) throw new Error('boom');
      if (r.hang) return; // never calls back -> watchdog
      if (r.openBlocked) { cb({ ok: false, blocked: true, detail: 'Route click: covered by div#popover' }); return; }
      if (r.openCode) { cb({ ok: false, code: r.openCode, detail: 'no detail page' }); return; }
      if (r.openFails) { cb({ ok: false, detail: 'Route詳細が開きませんでした' }); return; }
      current = r; log.opened.push(route.routeCode); cb({ ok: true });
    },
    ensureStop(stop, pending, onState, cb) {
      const st = stopOf(stop);
      if (st && pending.some((t) => daVisible(st, t.scannableId))) { cb({ ok: true, clicked: false }); return; }
      if (!st || st.missing) { cb({ ok: false, status: 'stop_not_found' }); return; }
      if ((st.labelCount || 1) > 1) { cb({ ok: false, status: 'stop_ambiguous' }); return; }
      onState('Stop #' + stop.stop + '展開中');
      log.stopClicks.push(stop.stop);
      if (st.expandFails) { cb({ ok: false, clicked: true, status: 'stop_expand_failed' }); return; }
      st.expanded = true;
      cb({ ok: true, clicked: true });
    },
    findPackage(target, stop, cb) {
      const st = stopOf(stop);
      const hits = st && st.expanded ? st.packages.filter((p) => p.da === target.scannableId) : [];
      const count = hits.reduce((n, p) => n + (p.dup ? 2 : 1), 0);
      if (!count) { cb({ ok: false, status: 'package_dom_not_found' }); return; }
      if (count > 1) { cb({ ok: false, status: 'dom_ambiguous' }); return; }
      if (hits[0].clickable === false) { cb({ ok: false, status: 'package_click_target_not_found' }); return; }
      cb({ ok: true, handle: hits[0] });
    },
    clickPackage(target, handle, cb) {
      log.packageClicks.push(handle.da);
      (handle.tr || []).forEach(([trId, bagName]) => {
        Core2.mergeTrDetailsMaps(trMap, { [trId]: { trId, bagName, bagScannableId: bagName ? 's' : null } });
      });
      cb({ ok: true });
    },
    waitTrDetails(target, cb) { cb(Core2.hasTrDetails(trMap, target.referenceId)); },
    restoreAfterPackage(target, cb) { cb({ ok: true }); },
    leaveStop(stop, cb) { cb({ ok: true }); },
    returnToList(cb) {
      log.back += 1;
      if (current && current.backFailsOnce) { current.backFailsOnce = false; cb({ ok: false, detail: 'flaky' }); return; }
      cb(current && current.backFails ? { ok: false, detail: 'list not shown' } : { ok: true });
    }
  };
  return { driver, trMap, log };
}

function routeTargets(spec) {
  const out = [];
  Object.keys(spec.routes).forEach((code) => {
    const stops = spec.routes[code].stops;
    Object.keys(stops).forEach((seq) => {
      stops[seq].packages.filter((p) => !p.noise).forEach((p) => {
        out.push({ routeId: 'R-' + code, routeCode: code, stop: Number(seq), scannableId: p.da, referenceId: p.ref });
      });
    });
  });
  return Core2.groupBagTargetsByRoute(out.sort((a, b) => a.routeCode.localeCompare(b.routeCode) || a.stop - b.stop));
}

function runEngine(spec, extra) {
  const w = fakeWorld(spec);
  const routes = routeTargets(spec);
  const all = [].concat(...routes.map((r) => r.targets));
  const run = Core2.createBagRun(all);
  let aborted = null;
  const timers = [];
  w.log.lines = [];
  Core2.runBagEngine(Object.assign({
    run, routes, driver: w.driver,
    getTrMap: () => w.trMap,
    onProgress: (p) => w.log.progress.push(Core2.formatBagProgress(p)),
    log: (line) => w.log.lines.push(line),
    // manual timers: the watchdog only fires when the test flushes them
    schedule: (fn) => { timers.push(fn); return timers.length - 1; },
    cancel: (id) => { timers[id] = null; },
    done: (a) => { aborted = a; }
  }, extra || {}));
  // flush watchdogs (each fire may start the next Route, which may schedule another)
  for (let k = 0; k < timers.length && aborted === null; k++) { const fn = timers[k]; if (fn) { timers[k] = null; fn(); } }
  const summary = Core2.summarizeBagRun(run, w.trMap);
  return { run, summary, aborted, log: w.log, trMap: w.trMap };
}

let Core2 = RootCore;
function v2Suite(label) {
  // 1. several 13:00 packages in one Stop -> one Stop click
  // 14. one Response with several trDetails -> no extra package click
  (function () {
    const r = runEngine({ routes: { DCX40: { stops: { 5: { packages: [
      { da: 'DA0000000001', ref: 'tr-a', tr: [['tr-a', 'JP_OB-AT-5597_NVY'], ['tr-b', null]] },
      { da: 'DA0000000002', ref: 'tr-b' },
      { da: 'DA0000000003', ref: 'tr-c', tr: [['tr-c', 'JP_OB-AM-1956_YLO']] }
    ] } } } } });
    assert(r.log.stopClicks.join(',') === '5', label + ' v2-1: one Stop click, got ' + r.log.stopClicks);
    assert(r.log.packageClicks.join(',') === 'DA0000000001,DA0000000003', label + ' v2-14: tr-b skipped');
    assert(r.summary.byReferenceId['tr-b'] === 'captured_null' && r.summary.counts.captured === 2, label + ' v2-14: statuses');
    assert(r.summary.clicks === 2 && r.summary.stopClicks === 1, label + ' v2-1: counters');
  })();

  // 2. Stop already expanded -> no Stop click
  (function () {
    const r = runEngine({ routes: { DCX40: { stops: { 16: { expanded: true, packages: [
      { da: 'DA0000000016', ref: 'tr-16', tr: [['tr-16', 'JP_OB-AT-0016_GRN']] }
    ] } } } } });
    assert(r.log.stopClicks.length === 0 && r.summary.counts.captured === 1, label + ' v2-2: no Stop re-click');
  })();

  // 3. "#1" never matches Stop 11 (and vice versa)
  (function () {
    assert(Core2.parseStopLabel('#1') === 1 && Core2.parseStopLabel('#11') === 11, label + ' v2-3: parse');
    assert(Core2.parseStopLabel('Stop 16') === 16 && Core2.parseStopLabel('Stop #16') === 16 &&
      Core2.parseStopLabel('ストップ 16') === 16, label + ' v2-3: formats');
    assert(Core2.parseStopLabel('16') === null && Core2.parseStopLabel('#1 東京都') === null &&
      Core2.parseStopLabel('565') === null && Core2.parseStopLabel('#1a') === null, label + ' v2-3: no loose match');
    const keys = Core2.matchStopLabelEntries([
      { text: '#11', key: 'a' }, { text: ' #1 ', key: 'b' }, { text: '1', key: 'c' }, { text: '#111', key: 'd' }
    ], 1);
    assert(keys.join(',') === 'b', label + ' v2-3: only exact #1, got ' + keys);
    assert(Core2.matchStopLabelEntries([{ text: '#1', key: 'x' }], 11).length === 0, label + ' v2-3: 11 != 1');
  })();

  // 4. DA found after Stop expand; 5. expand failure; 6. Stop missing; 7. no click target
  (function () {
    const r = runEngine({ routes: { DCX40: { stops: {
      3: { packages: [{ da: 'DA0000000030', ref: 'tr-30', tr: [['tr-30', 'JP_OB-AT-0030_RED']] }] },
      7: { expandFails: true, packages: [{ da: 'DA0000000070', ref: 'tr-70' }] },
      9: { missing: true, packages: [{ da: 'DA0000000090', ref: 'tr-90' }] },
      12: { packages: [{ da: 'DA0000000120', ref: 'tr-120', clickable: false }] },
      13: { labelCount: 2, packages: [{ da: 'DA0000000130', ref: 'tr-130' }] }
    } } } });
    const s = r.summary.byReferenceId;
    assert(s['tr-30'] === 'captured', label + ' v2-4: DA after expand');
    assert(s['tr-70'] === 'stop_expand_failed', label + ' v2-5: stop_expand_failed');
    assert(s['tr-90'] === 'stop_not_found', label + ' v2-6: stop_not_found');
    assert(s['tr-120'] === 'package_click_target_not_found', label + ' v2-7: click target missing');
    assert(s['tr-130'] === 'stop_ambiguous', label + ' v2: stop_ambiguous');
    assert(r.log.packageClicks.join(',') === 'DA0000000030', label + ' v2-7: nothing else clicked');
    assert(r.summary.stopClicks === 3, label + ' v2-5: failed expand click still counted');
  })();

  // 8 / 9. one Route failing -> route_aborted, next Route continues; list not restorable -> stop
  (function () {
    const r = runEngine({ routes: {
      DCX41: { openFails: true, stops: { 3: { packages: [{ da: 'DA0000000041', ref: 'tr-41' }] } } },
      DCX42: { stops: { 5: { packages: [{ da: 'DA0000000042', ref: 'tr-42', tr: [['tr-42', 'JP_OB-AT-0042_BLK']] }] } } }
    } });
    assert(r.summary.byReferenceId['tr-41'] === 'route_aborted', label + ' v2-8: route_aborted');
    assert(r.summary.byReferenceId['tr-42'] === 'captured', label + ' v2-9: next Route continued');
    assert(r.aborted === '', label + ' v2-9: whole phase not aborted');
    const rr = r.summary.routeResults;
    assert(rr[0].status === 'route_aborted' && rr[1].status === 'done', label + ' v2-8: routeResults');

    const r2 = runEngine({ routes: {
      DCX41: { backFails: true, stops: { 3: { packages: [{ da: 'DA0000000041', ref: 'tr-41', tr: [['tr-41', null]] }] } } },
      DCX42: { stops: { 5: { packages: [{ da: 'DA0000000042', ref: 'tr-42' }] } } }
    } });
    assert(/Route一覧へ戻れませんでした/.test(r2.aborted), label + ' v2-8: stops only when list is not restorable');
    assert(r2.summary.byReferenceId['tr-41'] === 'captured_null' && r2.summary.byReferenceId['tr-42'] === 'not_attempted',
      label + ' v2-8: later Route untouched');
  })();

  // 11 (engine): each package clicked at most once even when trDetails never arrives
  (function () {
    const r = runEngine({ routes: { DCX40: { stops: { 4: { packages: [
      { da: 'DA0000000401', ref: 'tr-401' }, { da: 'DA0000000402', ref: 'tr-402' }
    ] } } } } });
    assert(r.log.packageClicks.join(',') === 'DA0000000401,DA0000000402', label + ' v2: one click each');
    assert(r.summary.counts.timeout === 2, label + ' v2: timeouts recorded');
  })();

  // 15. progress shows Route / Stop / Package / state
  (function () {
    const r = runEngine({ routes: { DCX40: { stops: { 5: { packages: [
      { da: 'DA0000000001', ref: 'tr-a', tr: [['tr-a', 'JP_OB-AT-5597_NVY']] }
    ] } } } } });
    const all = r.log.progress.join('\n---\n');
    assert(/Route 1\/1 DCX40/.test(all) && /Stop 1\/1 \(#5\)/.test(all) && /Package 1\/1 DA0000000001/.test(all),
      label + ' v2-15: route/stop/package lines');
    ['Routeを開いています', 'Stop #5探索中', 'Stop #5展開中', 'DA0000000001探索中', '荷物番号クリック',
      'trDetails待機中', '状態: captured', 'Route一覧へ復帰中'].forEach((s) => {
      assert(all.indexOf(s) >= 0, label + ' v2-15: state ' + s);
    });
    assert(/Stop click 1/.test(Core2.formatBagSummary(r.summary)), label + ' v2-15: summary Stop click');
  })();

  // package card token + stopNeedsExpand
  (function () {
    assert(Core2.isPackageNumberText('DA0012405022') && !Core2.isPackageNumberText('250-7121269-8569466') &&
      !Core2.isPackageNumberText('565'), label + ' v2: package number token');
    assert(Core2.stopNeedsExpand([{ scannableId: 'DA1' }], {}) === true, label + ' v2: needs expand');
    assert(Core2.stopNeedsExpand([{ scannableId: 'DA1' }, { scannableId: 'DA2' }], { DA2: [{}] }) === false,
      label + ' v2: partially visible -> no click');
    const g = Core2.groupBagTargetsByStop([{ stop: 19 }, { stop: 5 }, { stop: 19 }]);
    assert(g.length === 2 && g[0].stop === 5 && g[1].targets.length === 2, label + ' v2: grouped by Stop');
  })();

  console.log('ok: bag v2 engine (' + label + ')');
}
v2Suite('root core');
Core2 = PhaseCore;
v2Suite('phase1-core');

// ---------------- v3: Route-level fault tolerance ----------------
function v3Suite(label) {
  // UI blocked on one Route -> recorded, next Route continues, nothing left not_attempted
  (function () {
    const r = runEngine({ routes: {
      DCX40: { stops: { 2: { packages: [{ da: 'DA0000000402', ref: 'tr-402', tr: [['tr-402', 'JP_OB-AT-0402_NVY']] }] } } },
      DCX41: { openBlocked: true, stops: { 3: { packages: [{ da: 'DA0000000411', ref: 'tr-411' }, { da: 'DA0000000412', ref: 'tr-412' }] } } },
      DCX42: { stops: { 5: { packages: [{ da: 'DA0000000425', ref: 'tr-425', tr: [['tr-425', null]] }] } } }
    } });
    const s = r.summary;
    assert(r.aborted === '', label + ' v3: not aborted');
    assert(s.byReferenceId['tr-411'] === 'ui_blocked' && s.byReferenceId['tr-412'] === 'ui_blocked', label + ' v3: ui_blocked recorded');
    assert(s.byReferenceId['tr-425'] === 'captured_null', label + ' v3: next Route processed');
    assert(s.counts.not_attempted === 0 && s.attempted === s.targetCount, label + ' v3: all classified');
    assert(s.groups.uiBlocked === 2 && s.groups.captured === 1 && s.groups.null === 1, label + ' v3: groups');
    assert(r.log.lines.some((l) => /^\[Bag\] DCX41 UI blocked .*-> continue$/.test(l)), label + ' v3: log line, got ' + r.log.lines.join(' | '));
    const text = Core2.formatBagSummary(s);
    ['対象 4', '試行済み 4', '未試行 0', 'captured 1', 'null 1', 'not found 0', 'ambiguous 0', 'click失敗 0',
      'timeout 0', 'UI blocked 2', '失敗Route: DCX41 UI blocked'].forEach((k) => {
      assert(text.indexOf(k) >= 0, label + ' v3: summary has ' + k + ' / ' + text);
    });
  })();

  // driver exception / hanging Route -> only that Route fails (watchdog), then continue
  (function () {
    const r = runEngine({ routes: {
      DCX40: { throwOnOpen: true, stops: { 1: { packages: [{ da: 'DA0000000401', ref: 'tr-401' }] } } },
      DCX41: { hang: true, stops: { 1: { packages: [{ da: 'DA0000000411', ref: 'tr-411' }] } } },
      DCX42: { stops: { 1: { packages: [{ da: 'DA0000000421', ref: 'tr-421', tr: [['tr-421', 'JP_OB-AT-0421_RED']] }] } } }
    } });
    assert(r.aborted === '', label + ' v3: exception/hang not fatal, got ' + r.aborted);
    assert(r.summary.byReferenceId['tr-401'] === 'route_aborted' && /exception: boom/.test(r.run.results['tr-401'].detail),
      label + ' v3: exception -> route_aborted');
    assert(r.summary.byReferenceId['tr-411'] === 'route_aborted' && /watchdog/.test(r.run.results['tr-411'].detail),
      label + ' v3: watchdog -> route_aborted');
    assert(r.summary.byReferenceId['tr-421'] === 'captured', label + ' v3: continued after both');
    assert(r.summary.counts.not_attempted === 0, label + ' v3: none left');
  })();

  // return to list: one flaky failure is retried; persistent failure is the only fatal case
  (function () {
    const r = runEngine({ routes: {
      DCX40: { backFailsOnce: true, stops: { 1: { packages: [{ da: 'DA0000000401', ref: 'tr-401', tr: [['tr-401', null]] }] } } },
      DCX41: { stops: { 1: { packages: [{ da: 'DA0000000411', ref: 'tr-411', tr: [['tr-411', null]] }] } } }
    } });
    assert(r.aborted === '' && r.summary.counts.not_attempted === 0, label + ' v3: flaky list return retried');
    const r2 = runEngine({ routes: {
      DCX40: { backFails: true, stops: { 1: { packages: [{ da: 'DA0000000401', ref: 'tr-401', tr: [['tr-401', null]] }] } } },
      DCX41: { stops: { 1: { packages: [{ da: 'DA0000000411', ref: 'tr-411' }] } } }
    } });
    assert(/Route一覧へ戻れませんでした（DCX40）/.test(r2.aborted), label + ' v3: fatal reason explicit');
    assert(r2.summary.attempted + r2.summary.counts.not_attempted === r2.summary.targetCount, label + ' v3: totals add up');
    assert(r2.log.lines.some((l) => /DCX40 .*-> abort/.test(l)), label + ' v3: fatal log');
  })();

  // 175 targets over 18 Routes with mixed failures: finishes, every target classified, no loop
  (function () {
    const routes = {};
    let n = 0;
    for (let ri = 0; ri < 18; ri++) {
      const code = 'DCX' + (40 + ri);
      const stops = {};
      for (let si = 1; si <= 10 && n < 175; si++) {
        const pkgs = [];
        for (let pi = 0; pi < 1 + (si % 2) && n < 175; pi++, n++) {
          const da = 'DA' + String(1000000000 + n);
          const kind = n % 7;
          pkgs.push({ da, ref: 'tr-' + n, clickable: kind !== 5,
            tr: kind === 0 ? [['tr-' + n, 'JP_OB-AT-' + n + '_NVY']] : kind === 1 ? [['tr-' + n, null]] : [] });
        }
        stops[si] = { packages: pkgs, expandFails: si === 9, missing: si === 10 };
      }
      routes[code] = { stops, openBlocked: code === 'DCX41', openFails: code === 'DCX50' };
    }
    const r = runEngine({ routes });
    const s = r.summary;
    assert(s.targetCount === 175, label + ' v3-175: target count ' + s.targetCount);
    assert(r.aborted === '', label + ' v3-175: finished');
    assert(s.counts.not_attempted === 0 && s.attempted === 175, label + ' v3-175: 未試行 0');
    const g = s.groups;
    const sum = g.captured + g.null + g.notFound + g.ambiguous + g.clickFailed + g.timeout + g.uiBlocked + g.otherError + g.notAttempted;
    assert(sum === 175, label + ' v3-175: groups add up to 175, got ' + sum);
    assert(g.uiBlocked > 0 && g.captured > 0 && g.null > 0 && g.timeout > 0, label + ' v3-175: mixed outcomes');
    const withTargets = Object.keys(routes).filter((c) => Object.keys(routes[c].stops).some((k) => routes[c].stops[k].packages.length)).length;
    assert(withTargets >= 11 && r.run.routeResults.length === withTargets, label + ' v3-175: every Route with targets visited once');
    assert(r.log.lines.filter((l) => /-> continue$/.test(l)).length === withTargets, label + ' v3-175: one continue log per Route');
    const clicked = new Set(r.log.packageClicks);
    assert(clicked.size === r.log.packageClicks.length, label + ' v3-175: no package clicked twice');
  })();

  console.log('ok: bag v3 route fault tolerance (' + label + ')');
}
Core2 = RootCore;
v3Suite('root core');
Core2 = PhaseCore;
v3Suite('phase1-core');

// ---------------- v3.1: explicit route_aborted reasons + Stop diagnostics ----------------
function v31Suite(label) {
  (function () {
    let clock = 0;
    const r = runEngine({ routes: {
      DCX43: { openCode: 'route_detail_not_detected', stops: { 1: { packages: [{ da: 'DA0000000431', ref: 'tr-431' }] } } },
      DCX44: { openFails: true, stops: { 1: { packages: [{ da: 'DA0000000441', ref: 'tr-441' }] } } },
      DCX45: { stops: { 1: { packages: [{ da: 'DA0000000451', ref: 'tr-451' }] }, 2: { packages: [{ da: 'DA0000000452', ref: 'tr-452' }] } } }
    } }, { now: () => (clock += 50000), routeBudgetMs: 90000 });
    const fatal = runEngine({ routes: {
      DCX46: { backFails: true, stops: { 1: { packages: [{ da: 'DA0000000461', ref: 'tr-461', tr: [['tr-461', null]] }] } } }
    } });
    const byCode = {};
    r.summary.routeResults.forEach((x) => { byCode[x.routeCode] = x; });
    assert(byCode.DCX43.reasonCode === 'route_detail_not_detected', label + ' v3.1: detail not detected code');
    assert(byCode.DCX44.reasonCode === 'route_open_failed', label + ' v3.1: default open code');
    assert(byCode.DCX45.reasonCode === 'route_budget_exceeded', label + ' v3.1: budget code, got ' + byCode.DCX45.reasonCode);
    assert(fatal.summary.routeResults[0].reasonCode === 'list_return_failed', label + ' v3.1: list return code');
    const text = Core2.formatBagSummary(r.summary);
    assert(/DCX43 route_aborted\(route_detail_not_detected\)/.test(text) && /DCX44 route_aborted\(route_open_failed\)/.test(text),
      label + ' v3.1: reasons in summary: ' + text);
    assert(r.log.lines.some((l) => /\[Bag\] DCX43 route_aborted\(route_detail_not_detected\).*-> continue/.test(l)), label + ' v3.1: reason in log');
    assert(r.summary.attempted + r.summary.counts.not_attempted === r.summary.targetCount, label + ' v3.1: totals');
  })();
  console.log('ok: bag v3.1 route reasons (' + label + ')');
}
Core2 = RootCore;
v31Suite('root core');
Core2 = PhaseCore;
v31Suite('phase1-core');

// v3.1 runner: split Stop labels, bounded Stop wait, route diagnostics JSON
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  assert(/for \(var d = 0; el && d < 3; d \+= 1, el = el\.parentElement\)/.test(bag), 'v3.1 label may span child elements (bounded ancestors)');
  assert(bag.indexOf('if (t.length > 20) break;') >= 0, 'v3.1 only short texts can be labels');
  assert(bag.indexOf('BAG_STOP_APPEAR_TIMEOUT_MS = 6000') >= 0 && bag.indexOf('BAG_STOP_APPEAR_TIMEOUT_MS, runId') >= 0,
    'v3.1 bounded condition wait for Stops');
  ['url: hrefNow()', 'title:', 'routeCode:', 'headings:', 'controls:', 'stopLabelCandidates:', 'targetStopProbes:',
    'routeDetailBasis:', 'iframes:', 'shadowHosts:', 'outline:'].forEach((k) => {
    assert(bag.indexOf(k) >= 0, 'v3.1 diagnostics field ' + k);
  });
  assert(bag.indexOf("'[text:' + t.length + ']'") >= 0, 'v3.1 long texts are not stored');
  assert(bag.indexOf('routeDiagnostics: bagRun.routeDiagnostics') >= 0, 'v3.1 diagnostics JSON includes route snapshots');
  assert(bag.indexOf("code: 'route_detail_not_detected'") >= 0 && bag.indexOf("code: 'route_card_not_found'") >= 0,
    'v3.1 runner reports route reason codes');
  assert(bag.indexOf('fetch(') < 0 && bag.indexOf('MutationObserver') < 0 && bag.indexOf('setInterval') < 0, 'v3.1 no requests/watchers');
  console.log('ok: v3.1 runner Stop detection + diagnostics');
})();

// ---------------- v3.2: real Cortex Stop markers <svg class="stop-K"><text>N</text></svg> ----------------
function v32Suite(C, label) {
  const K = C.STOP_MARKER_KIND;
  // 1. text labels unchanged
  assert(C.parseStopLabel('#16') === 16 && C.parseStopLabel('Stop 16') === 16 && C.parseStopLabel('ストップ 16') === 16,
    label + ' v3.2-1: text labels');
  // 2. split label (joined text of the ancestor) unchanged
  assert(C.parseStopLabel('Stop16') === 16 && C.parseStopLabel('# 16') === 16, label + ' v3.2-2: split label text');
  // 3. svg stop marker: class token stop-<digits>, visible digits = Stop number (class suffix ignored)
  assert(C.isStopMarkerSvgClass('stop-2') && C.isStopMarkerSvgClass('marker stop-15 active'), label + ' v3.2-3: marker class');
  assert(!C.isStopMarkerSvgClass('stop-icon') && !C.isStopMarkerSvgClass('nonstop-2') && !C.isStopMarkerSvgClass('stop-2a') &&
    !C.isStopMarkerSvgClass('stops-2') && !C.isStopMarkerSvgClass(''), label + ' v3.2-3: no loose class');
  assert(C.parseStopMarkerText('3') === 3 && C.parseStopMarkerText(' 16 ') === 16, label + ' v3.2-3: marker digits');
  assert(C.parseStopMarkerText('3a') === null && C.parseStopMarkerText('#3') === null && C.parseStopMarkerText('') === null,
    label + ' v3.2-3: marker digits only');
  // diagnostics 2026-09-24: stop-2 shows 3, stop-3 shows 4, stop-5 shows 6
  const markers = [{ text: '3', key: 's2', kind: K }, { text: '4', key: 's3', kind: K }, { text: '6', key: 's5', kind: K }];
  assert(C.matchStopLabelEntries(markers, 3).join() === 's2' && C.matchStopLabelEntries(markers, 4).join() === 's3' &&
    C.matchStopLabelEntries(markers, 6).join() === 's5', label + ' v3.2-3: visible number, not class suffix');
  assert(C.matchStopLabelEntries(markers, 2).length === 0 && C.matchStopLabelEntries(markers, 5).length === 0,
    label + ' v3.2-3: class suffix never used');
  // 4. plain numbers (span/p/div, Driver Aid, counts, Route numbers) are not Stop labels
  const plain = [{ text: '3', key: 'span3' }, { text: '565', key: 'aid' }, { text: '28', key: 'route' }, { text: '12', key: 'count' }];
  assert(C.matchStopLabelEntries(plain, 3).length === 0 && C.matchStopLabelEntries(plain, 565).length === 0 &&
    C.matchStopLabelEntries(plain, 28).length === 0, label + ' v3.2-4: plain numbers ignored');
  assert(C.matchStopLabelEntries(plain.concat(markers), 3).join() === 's2', label + ' v3.2-4: only the svg marker for 3');
  // 5. exact number: 1 vs 11
  const oneEleven = [{ text: '1', key: 'm1', kind: K }, { text: '11', key: 'm11', kind: K }, { text: '#11', key: 't11' }];
  assert(C.matchStopLabelEntries(oneEleven, 1).join() === 'm1', label + ' v3.2-5: 1 != 11');
  // priority: a text label wins over an svg marker for the same number
  assert(C.matchStopLabelEntries(oneEleven, 11).join() === 't11', label + ' v3.2: text label has priority');
  // two markers with the same number stay ambiguous (no guess)
  assert(C.matchStopLabelEntries([{ text: '7', key: 'a', kind: K }, { text: '7', key: 'b', kind: K }], 7).length === 2,
    label + ' v3.2: duplicate markers reported, not picked');
  console.log('ok: v3.2 svg Stop markers (' + label + ')');
}
v32Suite(RootCore, 'root core');
v32Suite(PhaseCore, 'phase1-core');

(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  assert(bag.indexOf("own.closest('svg')") >= 0 && bag.indexOf("Core.isStopMarkerSvgClass(svg.getAttribute && svg.getAttribute('class'))") >= 0,
    'v3.2 marker requires an enclosing svg with a stop-K class token');
  assert(bag.indexOf('Core.parseStopMarkerText(svg.textContent) == null') >= 0, 'v3.2 whole svg text must be digits');
  assert(/BAG_BUILD = 'Bag v3\.2/.test(bag), 'v3.2 build label');
  console.log('ok: v3.2 runner marker wiring');
})();

// v3.2-diag: Stop click evidence (hit-test relation, marker ancestry, state after click); decision unchanged
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  ["'same-stop-marker'", "'other-stop-marker:'", "'same-stop-block'", "'dialog'", 'centerStack', 'hitAncestors', 'svgRect',
    'plainNumberContext(stop.stop)', 'clickDiag.afterClick = stopClickState(das)', 'clickDiag.afterWait = stopClickState(das)',
    "'target_da_not_shown'", 'stopClickDiagnostics: bagRun.stopClickDiagnostics'].forEach((k) => {
    assert(bag.indexOf(k) >= 0, 'diag has ' + k);
  });
  // the hit-test decision itself is unchanged
  assert(bag.indexOf("if (hitAllowed(hit, cur.el, cur.container)) point = pts[i];") >= 0, 'hit-test decision unchanged');
  assert(/function hitAllowed\(hit, el, container\) \{\n    if \(!hit \|\| inPanel\(hit\)\) return false;\n    if \(hit === el \|\| el\.contains\(hit\)\) return true;\n    if \(container && \(hit === container \|\| container\.contains\(hit\)\)\) return true;/.test(bag),
    'hitAllowed unchanged');
  assert(bag.indexOf("BAG_BUILD = 'Bag v3.2-diag'") >= 0, 'diag build label');
  const manifest = JSON.parse(readFileSync(join(root, 'cortex-capture-extension', 'manifest.json'), 'utf8'));
  assert(manifest.version === '1.6.6.1', 'manifest 1.6.6.1');
  console.log('ok: v3.2-diag Stop click diagnostics');
})();

// v2 runner: Stop/Package driver lives only in the Bag block; tour untouched; no requests.
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  assert(bag.indexOf('BAG_ROUTE_OPEN_ATTEMPTS = 3') >= 0 && bag.indexOf('attempt < BAG_ROUTE_OPEN_ATTEMPTS') >= 0,
    'v3 bounded Route open retries');
  assert(bag.indexOf('blocked: !!res.covered') >= 0 && bag.indexOf('bagEngine.failRoute(') >= 0, 'v3 UI blocked + timer exceptions per Route');
  ['runBagEngine', 'findStopLabels', 'packageCardOf', 'packageClickTarget', 'elementFromPoint',
    'closeNewDialogs', 'formatBagProgress', 'Core.BAG_STATUS.STOP_EXPAND_FAILED'].forEach((s) => {
    assert(bag.indexOf(s) >= 0, 'v2 runner has ' + s);
  });
  const outside = runner.replace(bag, '');
  ['runBagEngine', 'findStopLabels', 'packageCardOf', 'ensureStop'].forEach((s) => {
    assert(outside.indexOf(s) < 0, 'v2 Bag code not outside the Bag block: ' + s);
  });
  assert(bag.indexOf('fetch(') < 0 && bag.indexOf('XMLHttpRequest') < 0 && bag.indexOf('setRequestHeader') < 0,
    'v2 no request creation');
  assert(bag.indexOf('MutationObserver') < 0 && bag.indexOf('setInterval') < 0, 'v2 no persistent watchers');
  assert(runner.indexOf("mk('Bag診断保存'") >= 0, 'v2 diagnostics download button');
  console.log('ok: v2 runner isolation');
})();
