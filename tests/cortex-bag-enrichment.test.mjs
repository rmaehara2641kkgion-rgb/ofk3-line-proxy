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
      (st.onOpenTr || []).forEach(([trId, bagName]) => {
        Core2.mergeTrDetailsMaps(trMap, { [trId]: { trId, bagName, bagScannableId: bagName ? 's' : null } });
      });
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
    leaveStop(stop, cb) {
      const st = stopOf(stop);
      log.leaves = (log.leaves || []).concat(stop.stop);
      if (st && st.leave === 'leftOpen') { cb({ ok: true, leftOpen: true, detail: 'aria-expanded=true' }); return; }
      if (st && st.leave === 'fail') { cb({ ok: false, detail: 'Route detail lost' }); return; }
      cb({ ok: true });
    },
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
        const status = stops[seq].status;
        out.push({ routeId: 'R-' + code, routeCode: code, stop: Number(seq), scannableId: p.da, referenceId: p.ref,
          stopStatus: status || null, stopPriority: status ? (Core2.isCompleteStopStatus(status) ? 1 : 0) : undefined });
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
  assert(/BAG_BUILD = 'Bag v3\.[2-9]/.test(bag), 'v3.x build label');
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
  // (build label / manifest version are checked by the v3.3 block)
  console.log('ok: v3.2-diag Stop click diagnostics');
})();

// ---------------- v3.3: click the Stop list button, never the Mapbox markers ----------------
function v33Suite(C, label) {
  const L = C.STOP_LIST_KIND, K = C.STOP_MARKER_KIND;
  // Stop number of a stops-list-item header: span "N" < p "N" < div "N" only
  assert(C.stopListRowNumber([{ text: '5', chain: ['5', '5'] }]) === 5, label + ' v3.3: row number');
  assert(C.stopListRowNumber([{ text: '11', chain: ['11', '11'] }, { text: '2', chain: ['2/2', '2/2 配達'] }]) === 11,
    label + ' v3.3: package count "2/2" is not the Stop number');
  assert(C.stopListRowNumber([{ text: '998', chain: ['998', '/998'] }]) === null, label + ' v3.3: Driver Aid ignored');
  assert(C.stopListRowNumber([{ text: '5', chain: ['5', '5'] }, { text: '7', chain: ['7', '7'] }]) === null,
    label + ' v3.3: two candidates in one row -> no guess');
  assert(C.stopListRowNumber([{ text: '5a', chain: ['5a', '5a'] }, { text: '', chain: [] }]) === null, label + ' v3.3: digits only');
  // Stop 1 vs 11 and priority list > text > marker; markers excluded on the click path
  const entries = [
    { text: '1', key: 'row1', kind: L }, { text: '11', key: 'row11', kind: L },
    { text: '1', key: 'map1', kind: K }, { text: '11', key: 'map11', kind: K }, { text: '#1', key: 'txt1' }
  ];
  assert(C.matchStopLabelEntries(entries, 1).join() === 'row1', label + ' v3.3: list row wins, 1 != 11');
  assert(C.matchStopLabelEntries(entries, 11).join() === 'row11', label + ' v3.3: 11 row');
  assert(C.matchStopLabelEntries([{ text: '4', key: 'map4', kind: K }], 4, { excludeMarkers: true }).length === 0,
    label + ' v3.3: Mapbox marker never a click target');
  assert(C.matchStopLabelEntries([{ text: '#4', key: 't4' }, { text: '4', key: 'm4', kind: K }], 4, { excludeMarkers: true }).join() === 't4',
    label + ' v3.3: text label still usable');
  // summary bar / general numbers are not Stop list rows (plain entries never parse as bare digits)
  assert(C.matchStopLabelEntries([{ text: '3', key: 'summary' }], 3, { excludeMarkers: true }).length === 0, label + ' v3.3: summary number ignored');
  console.log('ok: v3.3 Stop list rows (' + label + ')');
}
v33Suite(RootCore, 'root core');
v33Suite(PhaseCore, 'phase1-core');

(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  assert(bag.indexOf("var MAPBOX_SELECTOR = '.mapboxgl-map, .mapboxgl-marker, .mapboxgl-canvas-container';") >= 0, 'v3.3 Mapbox selector');
  assert(bag.indexOf("base.querySelectorAll('div.stops-list-item')") >= 0, 'v3.3 rows are div.stops-list-item');
  assert(bag.indexOf("el.closest('[role=\"button\"][aria-expanded]')") >= 0, 'v3.3 number must sit inside the row header button');
  assert(bag.indexOf('{ excludeMarkers: true }') >= 0, 'v3.3 markers excluded from click candidates');
  assert(bag.indexOf("if (inMapbox(el)) continue;") >= 0 && bag.indexOf('!inMapbox(r)') >= 0, 'v3.3 nothing inside Mapbox is a label');
  assert(bag.indexOf('clickListButton(function () {') >= 0 && bag.indexOf("if (rel === 'self' || rel === 'child') chosen = p;") >= 0,
    'v3.3/v3.5 clicks the row button only at points inside it (self / non-interactive child)');
  // v3.7: the aria-expanded / target DA checks moved into Core.stopOpenSignal (still the first two signals).
  assert(bag.indexOf("ariaExpanded: t ? t.button.getAttribute('aria-expanded') === 'true' : false") >= 0 &&
    bag.indexOf('Core.stopOpenSignal(observation())') >= 0, 'v3.3 aria-expanded recorded and used for expansion');
  assert(bag.indexOf('ariaExpandedBefore') >= 0 && bag.indexOf('ariaExpandedAfter') >= 0 && bag.indexOf('rowElementsAfter') >= 0, 'v3.3 list diagnostics');
  assert(bag.indexOf("if (hitAllowed(hit, cur.el, cur.container)) point = pts[i];") >= 0, 'v3.3 hit-test safety kept');
  // (build label / manifest version are checked by the v3.4 block)
  console.log('ok: v3.3 runner Stop list click wiring');
})();

// ---------------- v3.4: close the opened Stop row; undo history only when an entry was added ----------------
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  const leave = bag.slice(bag.indexOf('      leaveStop: function (stop, cb) {'), bag.indexOf('      returnToList: function (cb) {'));
  assert(leave.indexOf('ctx.openedListTarget') >= 0 && leave.indexOf('clickListButton(currentTarget') >= 0,
    'v3.4/v3.5 leaveStop clicks the row button re-read from the current DOM');
  assert(leave.indexOf("t.button.getAttribute('aria-expanded') === 'false'") >= 0, 'v3.4 close confirmed by aria-expanded=false');
  assert(leave.indexOf('historyBackTo(') < 0 && leave.indexOf('restoreHistory(ctx.stopHref, ctx.stopHistoryLen') >= 0,
    'v3.4 no blind history.back on leave');
  ['ariaExpandedBeforeLeave', 'ariaExpandedAfterLeave', 'urlBefore', 'urlAfter', 'selectedStopIdBefore', 'selectedStopIdAfter',
    'targetDaVisibleBefore', 'targetDaVisibleAfter', 'leaveMethod'].forEach((k) => assert(leave.indexOf(k) >= 0, 'v3.4 leave diag ' + k));
  const restore = bag.slice(bag.indexOf('  function restoreHistory('), bag.indexOf('  function selectedStopIdOf('));
  assert(restore.indexOf('if (historyLength() > beforeLen)') >= 0 && restore.indexOf("method: 'url_replaced'") >= 0,
    'v3.4 history.back only when the click pushed an entry');
  assert(bag.indexOf('restoreHistory(ctx.packageHref, ctx.packageHistoryLen') >= 0, 'v3.4 package restore uses the same rule');
  assert(bag.indexOf('captureSource: Core.classifyCaptureSource({') >= 0 && bag.indexOf('stopStatus: st ? st.status || null') >= 0,
    'v3.4/v3.5 per-target capture source + stop status');
  assert(bag.indexOf('stopLeaveDiagnostics: bagRun.stopLeaveDiagnostics') >= 0 && bag.indexOf('targetDiagnostics: targetDiagnostics()') >= 0, 'v3.4 diag JSON');
  // Stop list click path from v3.3 unchanged
  assert(bag.indexOf('clickListButton(function () {') >= 0 && bag.indexOf('{ excludeMarkers: true }') >= 0,
    'v3.4 keeps the v3.3 Stop list click');
  assert(bag.indexOf("if (hitAllowed(hit, cur.el, cur.container)) point = pts[i];") >= 0, 'v3.4 hit-test safety kept');
  // (build label / manifest version are checked by the v3.5 block)
  console.log('ok: v3.4 Stop leave + history rules');
})();

// v3.4 engine: several Stops in one Route are opened and left one after another (fake driver)
(function () {
  Core2 = RootCore;
  const r = runEngine({ routes: { DCX30: { stops: {
    3: { packages: [{ da: 'DA0000000303', ref: 'tr-303', tr: [['tr-303', 'JP_OB-AT-0303_NVY']] }] },
    6: { packages: [{ da: 'DA0000000306', ref: 'tr-306', tr: [['tr-306', null]] }] },
    11: { packages: [{ da: 'DA0000000311', ref: 'tr-311', tr: [['tr-311', 'JP_OB-AT-0311_RED']] }] }
  } } } });
  assert(r.log.stopClicks.join(',') === '3,6,11', 'v3.4 Stops 3 -> 6 -> 11 in one Route');
  assert(r.summary.counts.route_aborted === 0 && r.summary.counts.not_attempted === 0, 'v3.4 no route_aborted / 未試行');
  assert(r.summary.counts.captured === 2 && r.summary.counts.captured_null === 1 && r.summary.clicks === 3, 'v3.4 package clicks + captured');
  console.log('ok: v3.4 engine multi-Stop Route');
})();

// ---------------- v3.5: recoverable Stop close failures, incomplete Stops first, capture source ----------------
function v35Suite(label) {
  // recoverable leave failure -> that Stop recorded, next Stops still processed; incomplete Stops first
  (function () {
    const r = runEngine({ routes: { DCX29: { stops: {
      2: { status: 'COMPLETE', leave: 'leftOpen', packages: [{ da: 'DA0000002902', ref: 'tr-2902' }], onOpenTr: [['tr-2902', null]] },
      7: { status: 'COMPLETE', packages: [{ da: 'DA0000002907', ref: 'tr-2907' }], onOpenTr: [['tr-2907', null]] },
      15: { status: 'NOT_STARTED', leave: 'leftOpen', packages: [{ da: 'DA0000002915', ref: 'tr-2915' }, { da: 'DA0000002916', ref: 'tr-2916' }],
        onOpenTr: [['tr-2915', 'JP_OB-AT-2915_NVY'], ['tr-2916', 'JP_OB-AT-2916_RED']] },
      20: { status: 'IN_PROGRESS', packages: [{ da: 'DA0000002920', ref: 'tr-2920', tr: [['tr-2920', 'JP_OB-AT-2920_YLO']] }] }
    } } } });
    assert(r.log.stopClicks.join(',') === '15,20,2,7', label + ' v3.5: incomplete Stops (15,20) first, got ' + r.log.stopClicks);
    assert(r.summary.counts.route_aborted === 0 && r.summary.counts.not_attempted === 0, label + ' v3.5: no route_aborted / 未試行');
    assert(r.summary.byReferenceId['tr-2915'] === 'captured' && r.summary.byReferenceId['tr-2916'] === 'captured',
      label + ' v3.5: Stop open alone captured both packages of the incomplete Stop');
    assert(r.summary.byReferenceId['tr-2920'] === 'captured' && r.summary.clicks === 1, label + ' v3.5: one real package click');
    assert(r.run.clickedRefs['tr-2920'] && !r.run.clickedRefs['tr-2915'], label + ' v3.5: clickedRefs only for real clicks');
    assert(r.summary.byReferenceId['tr-2902'] === 'captured_null' && r.summary.byReferenceId['tr-2907'] === 'captured_null',
      label + ' v3.5: completed Stops stay captured_null');
    const rr = r.summary.routeResults[0];
    assert(rr.status === 'done' && rr.leaveFailures.map((x) => x.stop).join(',') === '15,2', label + ' v3.5: leave failures recorded, Route done');
    assert(/Stop閉じ失敗（Route継続） 2/.test(Core2.formatBagSummary(r.summary)), label + ' v3.5: summary shows left-open Stops');
    assert(r.log.lines.some((l) => /Stop #15 could not be closed .*-> Route detail OK, continue/.test(l)), label + ' v3.5: leave log');
  })();

  // unrecoverable leave failure -> route_aborted (stop_leave_failed), next Route continues
  (function () {
    const r = runEngine({ routes: {
      DCX44: { stops: {
        4: { leave: 'fail', packages: [{ da: 'DA0000004404', ref: 'tr-4404', tr: [['tr-4404', null]] }] },
        9: { packages: [{ da: 'DA0000004409', ref: 'tr-4409' }] }
      } },
      DCX46: { stops: { 2: { packages: [{ da: 'DA0000004602', ref: 'tr-4602', tr: [['tr-4602', 'JP_OB-AT-4602_NVY']] }] } } }
    } });
    const byCode = {};
    r.summary.routeResults.forEach((x) => { byCode[x.routeCode] = x; });
    assert(byCode.DCX44.status === 'route_aborted' && byCode.DCX44.reasonCode === 'stop_leave_failed', label + ' v3.5: unrecoverable -> route_aborted');
    assert(r.summary.byReferenceId['tr-4409'] === 'route_aborted' && r.summary.byReferenceId['tr-4602'] === 'captured',
      label + ' v3.5: next Route still processed');
  })();

  // route time extension: only on request, capped, and pushes the watchdog
  (function () {
    const w = fakeWorld({ routes: { DCX45: { stops: { 1: { packages: [{ da: 'DA0000004501', ref: 'tr-4501', tr: [['tr-4501', null]] }] } } } } });
    const routes = routeTargets({ routes: { DCX45: { stops: { 1: { packages: [{ da: 'DA0000004501', ref: 'tr-4501' }] } } } } });
    const granted = [];
    // extendRoute is called asynchronously by the runner (after waits), so the handle exists by then.
    const run2 = Core2.createBagRun([].concat(...routes.map((x) => x.targets)));
    let h2 = null;
    const drv2 = Object.assign({}, w.driver, {
      openRoute(route, cb) { setImmediate(() => { granted.length = 0; granted.push(h2.extendRoute(30000), h2.extendRoute(40000), h2.extendRoute(5000)); w.driver.openRoute(route, cb); }); }
    });
    h2 = Core2.runBagEngine({ run: run2, routes, driver: drv2, getTrMap: () => ({}), routeExtensionCapMs: 60000,
      schedule: () => 1, cancel: () => {}, done: () => {
        assert(granted.join(',') === '30000,30000,0', label + ' v3.5: extension capped at 60 s, got ' + granted);
        assert(run2.routeResults[0].extendedMs === 60000, label + ' v3.5: extendedMs recorded');
        console.log('ok: v3.5 route extension cap (' + label + ')');
      } });
  })();

  // capture source classification (diagnostics)
  (function () {
    const C = Core2;
    assert(C.classifyCaptureSource({ hasTr: false }) === null, label + ' cs: none');
    assert(C.classifyCaptureSource({ hasTr: true, clicked: true, priorFailureStatus: 'timeout' }) === 'package_click', label + ' cs: real click');
    assert(C.classifyCaptureSource({ hasTr: true, preexisting: true }) === 'preexisting', label + ' cs: preexisting');
    assert(C.classifyCaptureSource({ hasTr: true, priorFailureStatus: 'package_click_target_not_found' }) === 'after_failed_package_lookup',
      label + ' cs: after failed lookup');
    assert(C.classifyCaptureSource({ hasTr: true }) === 'cortex_stop_open', label + ' cs: Stop open');
    assert(C.isCompleteStopStatus('COMPLETE') && !C.isCompleteStopStatus('NOT_STARTED') && !C.isCompleteStopStatus(null), label + ' cs: status');
  })();
  console.log('ok: v3.5 engine (' + label + ')');
}
Core2 = RootCore;
v35Suite('root core');
Core2 = PhaseCore;
v35Suite('phase1-core');

(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  const leave = bag.slice(bag.indexOf('      leaveStop: function (stop, cb) {'), bag.indexOf('      returnToList: function (cb) {'));
  assert(leave.indexOf('var t = freshListTarget(stop.stop);') >= 0, 'v3.5 close re-reads the row from the current DOM');
  assert(leave.indexOf('BAG_STOP_CLOSE_TIMEOUT_MS') >= 0 && /if \(n === 0\) \{ retry\(ad\); return; \}/.test(leave), 'v3.5 one retry only');
  assert(leave.indexOf('var usable = routeDetailUsable();') >= 0 && leave.indexOf("thenHistory('left_open'") >= 0, 'v3.5 continue only when Route detail usable');
  ['routeCode', 'stop: stop.stop', 'ariaExpandedBeforeLeave', 'ariaExpandedAfterLeave', 'selectedStopIdBefore', 'selectedStopIdAfter',
    'urlBefore', 'urlAfter', 'buttonConnected', 'retryCount', 'leaveMethod', 'leaveResult', 'elapsedMs'].forEach((k) => {
    assert(leave.indexOf(k) >= 0, 'v3.5 leave diag ' + k);
  });
  const click = bag.slice(bag.indexOf('  function clickListButton('), bag.indexOf('  function pageBrief()'));
  assert(click.indexOf("if (rel === 'self' || rel === 'child') chosen = p;") >= 0, 'v3.5 clicks only self / non-interactive child');
  assert(click.indexOf('diag.buttonRect') >= 0 && click.indexOf('diag.clicked') >= 0 && click.indexOf("interactive: rel === 'interactive_child'") >= 0,
    'v3.5 click diag: rect, point, elementFromPoint, interactive child');
  assert(bag.indexOf("if (!routeRetried && routeListShown(ctx) && findRouteCardByRouteId(route.routeId))") >= 0, 'v3.5 Route retry only by exact routeId');
  assert(bag.indexOf('clickRec.routeDetailsObserved') >= 0 && bag.indexOf('clickRec.domChanged') >= 0 && bag.indexOf('cardAria') >= 0, 'v3.5 Route click diag');
  assert(bag.indexOf('clickDiag.extendedWait = true;') >= 0 && bag.indexOf('selectedStopIdAfter') >= 0, 'v3.5 Stop open diag + conditional wait');
  assert(bag.indexOf('actualPackageClick: clicked') >= 0 && bag.indexOf('priorFailureDetail') >= 0, 'v3.5 target diag');
  assert(bag.indexOf("'package_click' : 'without_package_click'") < 0, 'v3.5 old misleading captureSource removed');
  assert(bag.indexOf('BAG_STOP_OPEN_TR_WAIT_MS = 3000') >= 0 && bag.indexOf('clickDiag.cortexTrDetails') >= 0,
    'v3.6 bounded 3 s wait for Cortex own trDetails after a Stop opens');
  assert(bag.indexOf("BAG_BUILD = 'Bag v3.8'") >= 0, 'v3.8 build label');
  const manifest = JSON.parse(readFileSync(join(root, 'cortex-capture-extension', 'manifest.json'), 'utf8'));
  assert(manifest.version === '1.6.13', 'manifest 1.6.13');
  console.log('ok: v3.5 runner wiring');
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

// ---------------- Unfinished Bag Test v1 (diagnostic mode, Stop open only) ----------------
function ubtDetails(code, stops) {
  return {
    rmsRouteDetails: {
      routeId: 'R-' + code, routeCode: code,
      stops: stops.map((st) => ({
        sequenceNumber: st.seq, status: st.status,
        tasks: st.pk.map(([da, ref]) => ({ taskType: 'DROP_OFF', referenceId: ref, domainMap: { scannableId: da } }))
      }))
    }
  };
}

// Same override as the runner: Stop open only, the package path can never click.
function ubtRun(C, detailsList, world, preTr) {
  const sel = C.selectUnfinishedBagTargets(detailsList, preTr || {}, { maxRoutes: 3, maxStops: 5, maxPackages: 20 });
  const w = fakeWorld(world);
  Object.assign(w.trMap, preTr || {});
  const routes = C.groupBagTargetsByRoute(sel.targets);
  const run = C.createBagRun(sel.targets);
  let violations = 0;
  let finished = null;
  const driver = Object.assign({}, w.driver, {
    findPackage(target, stop, cb) { cb({ ok: false, status: 'no_trdetails_after_stop_open', detail: 'no trDetails' }); },
    clickPackage(target, handle, cb) { violations += 1; cb({ ok: false, detail: 'disabled' }); }
  });
  C.runBagEngine({ run, routes, driver, getTrMap: () => w.trMap, schedule: () => 1, cancel: () => {}, done: (a) => { finished = a; } });
  const res = C.summarizeUnfinishedBagTest({
    targets: sel.targets, trMap: w.trMap, results: run.results, clickedRefs: run.clickedRefs || {},
    preexisting: {}, trSeenAt: {}, stopDiags: {}, selection: sel, selectedDay: '2026-09-24',
    responses: [{ path: '/operations/execution/api/tasks/trDetails', status: 200, topKeys: ['trDetails'], rowKeys: ['trId', 'bagName'],
      bagLikeFields: { bagName: [null] }, trIds: ['tr-null'] }],
    packageClicks: (run.clicks || 0) + violations, aborted: finished || ''
  });
  return { sel, res, log: w.log, violations, run, finished };
}

function ubtSuite(label) {
  const C = Core2;
  // 1. NOT_STARTED + 2. IN_PROGRESS + 3. three packages in one Stop + 4. null bag + 5. no trDetails + 7. COMPLETE excluded
  (function () {
    const details = [
      ubtDetails('DCX10', [
        { seq: 1, status: 'COMPLETE', pk: [['DA1', 'tr-done']] },
        { seq: 2, status: 'NOT_STARTED', pk: [['DA2', 'tr-2a'], ['DA3', 'tr-2b'], ['DA4', 'tr-2c']] },
        { seq: 3, status: 'IN_PROGRESS', pk: [['DA5', 'tr-null']] },
        { seq: 4, status: 'NOT_STARTED', pk: [['DA6', 'tr-none']] }
      ])
    ];
    const world = { routes: { DCX10: { stops: {
      1: { packages: [{ da: 'DA1', ref: 'tr-done' }] },
      2: { packages: [{ da: 'DA2', ref: 'tr-2a' }, { da: 'DA3', ref: 'tr-2b' }, { da: 'DA4', ref: 'tr-2c' }],
        onOpenTr: [['tr-2a', 'JP_OB-AT-0001_NVY'], ['tr-2b', 'JP_OB-AT-0001_NVY'], ['tr-2c', 'JP_OB-AM-0002_YLO']] },
      3: { packages: [{ da: 'DA5', ref: 'tr-null' }], onOpenTr: [['tr-null', null]] },
      4: { packages: [{ da: 'DA6', ref: 'tr-none' }] }
    } } } };
    const r = ubtRun(C, details, world);
    assert(r.sel.completeStopsSkipped === 1 && r.sel.unfinishedStopsFound === 3, label + ' ubt-7: COMPLETE excluded');
    assert(r.sel.targets.every((t) => t.referenceId !== 'tr-done'), label + ' ubt-7: no COMPLETE target');
    assert(r.log.stopClicks.indexOf(1) < 0, label + ' ubt-7: COMPLETE Stop never opened');
    const s2 = r.res.stops.find((s) => s.stopNumber === 2);
    assert(s2.stopStatus === 'NOT_STARTED' && s2.packagesExpected === 3 && s2.trDetailsReceivedCount === 3 &&
      s2.bagNonNullCount === 3 && s2.bagNullCount === 0 && s2.referenceIds.length === 3 &&
      s2.bagNames.join(',') === 'JP_OB-AT-0001_NVY,JP_OB-AT-0001_NVY,JP_OB-AM-0002_YLO', label + ' ubt-1/3: NOT_STARTED 3 packages aggregated');
    const p2 = r.res.packages.find((p) => p.referenceId === 'tr-2a');
    assert(p2.captureSource === 'cortex_stop_open' && p2.actualPackageClick === false && p2.receivedAfterStopOpen === true &&
      p2.trDetailsReceived === true && p2.status === 'captured' && p2.scannableId === 'DA2' && p2.stopStatus === 'NOT_STARTED',
    label + ' ubt-1: package record');
    const s3 = r.res.stops.find((s) => s.stopNumber === 3);
    assert(s3.stopStatus === 'IN_PROGRESS' && s3.bagNullCount === 1 && s3.status === 'bag_null', label + ' ubt-2/4: IN_PROGRESS null');
    const pn = r.res.packages.find((p) => p.referenceId === 'tr-null');
    assert(pn.status === 'captured_null' && pn.nullDiagnostics.length === 1 && pn.nullDiagnostics[0].rowKeys.indexOf('bagName') >= 0,
      label + ' ubt-4: null diagnostics');
    const p4 = r.res.packages.find((p) => p.referenceId === 'tr-none');
    assert(p4.status === 'no_trdetails_after_stop_open' && !p4.trDetailsReceived, label + ' ubt-5: no trDetails');
    assert(r.res.stops.find((s) => s.stopNumber === 4).status === 'no_trdetails_after_stop_open', label + ' ubt-5: stop status');
    assert(r.res.stopOpenOnlyBagConfirmed === true && r.res.testStatus === 'confirmed' &&
      r.res.confirmed[0].confirmedRouteCode === 'DCX10' && r.res.confirmed[0].confirmedBagName, label + ' ubt: confirmed fields');
    assert(r.res.packageClicks === 0 && r.violations === 0 && r.log.packageClicks.length === 0, label + ' ubt-10: package click 0');
    assert(r.res.bagCaptured === 3 && r.res.bagNull === 1 && r.res.noTrDetails === 1 && r.res.unfinishedStopsTested === 3,
      label + ' ubt: counts');
    const text = C.formatUnfinishedBagTest(r.res);
    assert(text.indexOf('未完了Bagテスト') === 0 && text.indexOf('Unfinished Bag Test v1') >= 0 && text.indexOf('Bag取得完了') < 0,
      label + ' ubt: own summary text');
  })();

  // 6. zero unfinished Stops
  (function () {
    const r = ubtRun(C, [ubtDetails('DCX20', [{ seq: 1, status: 'COMPLETE', pk: [['DA1', 'tr-1']] }])], { routes: {} });
    assert(r.sel.targets.length === 0 && r.res.testStatus === 'no_unfinished_stops' && !r.res.stopOpenOnlyBagConfirmed,
      label + ' ubt-6: no_unfinished_stops');
    assert(C.formatUnfinishedBagTest(r.res).indexOf('未完了Stop 0 — Bag検証未実施') >= 0, label + ' ubt-6: UI text');
  })();

  // 8. a Stop open failure continues with the next unfinished Stop
  (function () {
    const details = [ubtDetails('DCX30', [
      { seq: 1, status: 'NOT_STARTED', pk: [['DA1', 'tr-f1'], ['DA2', 'tr-f2']] },
      { seq: 2, status: 'NOT_STARTED', pk: [['DA3', 'tr-ok']] }
    ])];
    const world = { routes: { DCX30: { stops: {
      1: { expandFails: true, packages: [{ da: 'DA1', ref: 'tr-f1' }, { da: 'DA2', ref: 'tr-f2' }] },
      2: { packages: [{ da: 'DA3', ref: 'tr-ok' }], onOpenTr: [['tr-ok', 'JP_OB-AT-0003_RED']] }
    } } } };
    const r = ubtRun(C, details, world);
    assert(r.log.stopClicks.join(',') === '1,2', label + ' ubt-8: next Stop tried, got ' + r.log.stopClicks);
    assert(r.res.packages.find((p) => p.referenceId === 'tr-f1').status === 'stop_expand_failed', label + ' ubt-8: failure recorded');
    assert(r.res.packages.find((p) => p.referenceId === 'tr-ok').status === 'captured' && r.res.packageClicks === 0, label + ' ubt-8: continued');
  })();

  // caps: 3 routes / 5 stops / 20 packages
  (function () {
    const many = [];
    for (let i = 1; i <= 5; i++) {
      many.push(ubtDetails('DCX5' + i, [1, 2, 3, 4].map((seq) => ({ seq, status: 'NOT_STARTED',
        pk: [0, 1, 2].map((k) => ['DA' + i + seq + k, 'tr-' + i + '-' + seq + '-' + k]) }))));
    }
    const sel = C.selectUnfinishedBagTargets(many, {}, { maxRoutes: 3, maxStops: 5, maxPackages: 20 });
    const routes = new Set(sel.targets.map((t) => t.routeCode));
    const stops = new Set(sel.targets.map((t) => t.routeCode + '#' + t.stop));
    assert(routes.size <= 3 && stops.size <= 5 && sel.targets.length <= 20 && sel.targets.length > 0, label + ' ubt: caps');
    assert(C.selectUnfinishedBagTargets(many, {}).limits.maxPackages === 20, label + ' ubt: default caps');
  })();
  console.log('ok: Unfinished Bag Test v1 (' + label + ')');
}
Core2 = RootCore;
ubtSuite('root core');
Core2 = PhaseCore;
ubtSuite('phase1-core');

// 9/10. runner wiring: separate button; normal Bag v3.5 unchanged; the test driver cannot click packages.
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  assert(runner.indexOf("mk('未完了Bagテスト'") >= 0 && runner.indexOf("mk('Bag取得'") >= 0, 'ubt: separate button');
  assert(runner.indexOf("BAG_BUILD = 'Bag v3.8'") >= 0 && runner.indexOf("UNFINISHED_BAG_TEST_VERSION") >= 0, 'ubt: Bag v3.8 + test v1');
  const t = runner.slice(runner.indexOf('  function startUnfinishedBagTest()'), runner.indexOf('  function stopBagPhase()'));
  const findPkg = t.slice(t.indexOf('findPackage: function'), t.indexOf('clickPackage: function'));
  assert(findPkg.indexOf("status: 'no_trdetails_after_stop_open'") >= 0 && findPkg.indexOf('safeCdpClick') < 0 &&
    findPkg.indexOf('base.') < 0, 'ubt-10: findPackage never reaches the package DOM');
  const clickPkg = t.slice(t.indexOf('clickPackage: function'), t.indexOf('setBagStatus(', t.indexOf('clickPackage: function')));
  assert(clickPkg.indexOf('packageClickViolations') >= 0 && clickPkg.indexOf('Cdp') < 0 && clickPkg.indexOf('base.') < 0,
    'ubt-10: clickPackage disabled');
  assert(t.indexOf('UNFINISHED_TEST_TR_WAIT_MS') >= 0 && runner.indexOf('UNFINISHED_TEST_TR_WAIT_MS = 3000') >= 0, 'ubt: 3 s wait');
  const start = runner.slice(runner.indexOf('  function startBagPhase()'), runner.indexOf('  function onReady('));
  assert(start.indexOf('unfinished') < 0 && start.indexOf('driver: createBagDriver(ctx, runId)') >= 0, 'ubt-9: startBagPhase unchanged');
  assert(runner.indexOf('unfinishedBagTest: lastUnfinishedTest') >= 0, 'ubt: diagnostics JSON block');
  assert(t.indexOf('fetch(') < 0 && t.indexOf('XMLHttpRequest') < 0, 'ubt: no request creation');
  console.log('ok: Unfinished Bag Test v1 runner wiring');
})();

// ---------------- Bag v3.6: Stop open is the first capture path ----------------
function v36Details(code, stops) {
  return details(code, stops.map((st) => Object.assign(stop(st.seq, st.pk.map(([da, ref]) => task({ scannableId: da, referenceId: ref }))),
    { status: st.status })));
}
function v36Run(C, detailsList, world, override) {
  const sel = C.selectBagTargets(detailsList, {});
  const w = fakeWorld(world);
  const routes = C.groupBagTargetsByRoute(sel.targets);
  const run = C.createBagRun(sel.targets);
  let aborted = null;
  const driver = Object.assign({}, w.driver, override ? override(w) : {});
  C.runBagEngine({ run, routes, driver, getTrMap: () => w.trMap, schedule: () => 1, cancel: () => {}, done: (a) => { aborted = a; } });
  return { sel, run, log: w.log, aborted, trMap: w.trMap, summary: C.summarizeBagRun(run, w.trMap) };
}
function v36Suite(label) {
  const C = Core2;
  // 1/2/3/4/7/13: status categories, order, Stop-open capture, null never falls back, click 0
  (function () {
    const d = [v36Details('DCX60', [
      { seq: 1, status: 'COMPLETE', pk: [['DA0000006001', 'tr-601']] },
      { seq: 2, status: 'ARRIVED', pk: [['DA0000006002', 'tr-602']] },
      { seq: 3, status: 'IN_PROGRESS', pk: [['DA0000006003', 'tr-603']] },
      { seq: 4, status: 'NOT_STARTED', pk: [['DA0000006004', 'tr-604']] }
    ])];
    const world = { routes: { DCX60: { stops: {
      1: { packages: [{ da: 'DA0000006001', ref: 'tr-601', tr: [['tr-601', 'SHOULD_NOT_CLICK']] }], onOpenTr: [['tr-601', null]] },
      2: { packages: [{ da: 'DA0000006002', ref: 'tr-602' }], onOpenTr: [['tr-602', 'JP_OB-AT-0602_RED']] },
      3: { packages: [{ da: 'DA0000006003', ref: 'tr-603' }], onOpenTr: [['tr-603', 'JP_OB-AT-0603_NVY']] },
      4: { packages: [{ da: 'DA0000006004', ref: 'tr-604' }], onOpenTr: [['tr-604', 'JP_OB-AT-0604_YLO']] }
    } } } };
    const r = v36Run(C, d, world);
    assert(r.sel.targets.length === 4, label + ' v3.6-14: COMPLETE stays a 13:00 target');
    assert(r.log.stopClicks.join(',') === '4,3,2,1', label + ' v3.6-13: NOT_STARTED, IN_PROGRESS, other, COMPLETE, got ' + r.log.stopClicks);
    const b = r.summary.byReferenceId;
    assert(b['tr-604'] === 'captured' && b['tr-603'] === 'captured' && b['tr-602'] === 'captured', label + ' v3.6-1/2: captured by Stop open');
    assert(b['tr-601'] === 'captured_null', label + ' v3.6-3: COMPLETE null');
    assert(r.log.packageClicks.length === 0 && r.summary.clicks === 0, label + ' v3.6-4/7: package click 0, null not retried');
    const so = r.summary.stopOpen;
    assert(so.stopOpenBagCaptured === 3 && so.stopOpenBagNull === 1 && so.stopOpenNoTrDetails === 0 && so.stopOpenTrDetailsReceived === 4 &&
      so.capturedByStopOpen === 3 && so.capturedByPackageClick === 0 && so.packageFallbackTargets === 0 && so.actualPackageClicks === 0,
    label + ' v3.6: stopOpen summary ' + JSON.stringify(so));
    assert(r.summary.byStopStatus.COMPLETE.captured_null === 1 && r.summary.byStopStatus.NOT_STARTED.captured === 1 &&
      r.summary.byStopStatus.OTHER.captured === 1 && r.summary.byStopStatus.IN_PROGRESS.captured === 1, label + ' v3.6: byStopStatus');
    assert(C.stopStatusCategory('complete') === 'COMPLETE' && C.stopStatusCategory('') === 'UNKNOWN' && C.stopStatusPriority('NOT_STARTED') === 0 &&
      C.stopStatusPriority('IN_PROGRESS') === 1 && C.stopStatusPriority('ARRIVED') === 2 && C.stopStatusPriority('COMPLETE') === 3, label + ' v3.6: categories');
    const text = C.formatBagSummary(r.summary);
    assert(text.indexOf('Stop-open取得 3 / Stop-open null 1 / trDetailsなし 0') >= 0 && text.indexOf('package fallback 0 / package click 0') >= 0 &&
      text.indexOf('click 0 / Stop click 4') >= 0 && text.indexOf('Bag取得完了') === 0, label + ' v3.6: panel text');
  })();

  // 5/6/8: one Stop, 3 packages, one open; only the package without trDetails falls back
  (function () {
    const d = [v36Details('DCX61', [{ seq: 15, status: 'NOT_STARTED', pk: [['DA0000006101', 'tr-a'], ['DA0000006102', 'tr-b'], ['DA0000006103', 'tr-c']] }])];
    const all = { routes: { DCX61: { stops: { 15: {
      packages: [{ da: 'DA0000006101', ref: 'tr-a' }, { da: 'DA0000006102', ref: 'tr-b' }, { da: 'DA0000006103', ref: 'tr-c' }],
      onOpenTr: [['tr-a', 'BAG_A'], ['tr-b', 'BAG_A'], ['tr-c', 'BAG_B']] } } } } };
    const r1 = v36Run(C, d, all);
    assert(r1.log.stopClicks.join(',') === '15' && r1.summary.counts.captured === 3 && r1.summary.clicks === 0 && r1.log.packageClicks.length === 0,
      label + ' v3.6-5: one Stop click, 3 captured, 0 package click');
    const part = { routes: { DCX61: { stops: { 15: {
      packages: [{ da: 'DA0000006101', ref: 'tr-a' }, { da: 'DA0000006102', ref: 'tr-b' }, { da: 'DA0000006103', ref: 'tr-c', tr: [['tr-c', 'BAG_B']] }],
      onOpenTr: [['tr-a', 'BAG_A'], ['tr-b', null]] } } } } };
    const r2 = v36Run(C, d, part);
    assert(r2.log.stopClicks.length === 1 && r2.log.packageClicks.join(',') === 'DA0000006103', label + ' v3.6-6/8: only no-trDetails package clicked');
    const so = r2.summary.stopOpen;
    assert(so.stopOpenBagCaptured === 1 && so.stopOpenBagNull === 1 && so.stopOpenNoTrDetails === 1 && so.packageFallbackTargets === 1 &&
      so.packageFallbackAttempted === 1 && so.actualPackageClicks === 1 && so.capturedByPackageClick === 1 && so.capturedByStopOpen === 1,
    label + ' v3.6-6: fallback stats ' + JSON.stringify(so));
    assert(r2.summary.byReferenceId['tr-b'] === 'captured_null' && r2.summary.byReferenceId['tr-c'] === 'captured', label + ' v3.6-7: null kept, fallback captured');
    assert(r2.run.clickedRefs['tr-c'] && !r2.run.clickedRefs['tr-a'] && !r2.run.clickedRefs['tr-b'], label + ' v3.6: actualPackageClick only for tr-c');
  })();

  // 9: click counted only when really dispatched
  (function () {
    const d = [v36Details('DCX62', [{ seq: 1, status: 'NOT_STARTED', pk: [['DA0000006201', 'tr-x']] }, { seq: 2, status: 'NOT_STARTED', pk: [['DA0000006202', 'tr-y']] }])];
    const world = { routes: { DCX62: { stops: { 1: { packages: [{ da: 'DA0000006201', ref: 'tr-x' }] }, 2: { packages: [{ da: 'DA0000006202', ref: 'tr-y' }] } } } } };
    const r = v36Run(C, d, world, () => ({
      clickPackage(target, handle, cb) {
        if (target.referenceId === 'tr-x') cb({ ok: false, detail: 'element lost' }); // nothing dispatched
        else cb({ ok: false, clicked: true, detail: 'CDP error' }); // dispatched, then failed
      }
    }));
    assert(r.summary.clicks === 1 && r.run.clickedRefs['tr-y'] && !r.run.clickedRefs['tr-x'], label + ' v3.6-9: clicks ' + r.summary.clicks);
    assert(r.summary.byReferenceId['tr-x'] === 'click_failed' && r.summary.stopOpen.packageFallbackTargets === 2, label + ' v3.6-9: statuses');
  })();

  // 10/11/12: Stop close outcomes (the retry-once itself lives in the runner, asserted in wiring)
  (function () {
    const d = [v36Details('DCX63', [
      { seq: 1, status: 'NOT_STARTED', pk: [['DA0000006301', 'tr-1']] },
      { seq: 2, status: 'NOT_STARTED', pk: [['DA0000006302', 'tr-2']] },
      { seq: 3, status: 'NOT_STARTED', pk: [['DA0000006303', 'tr-3']] }
    ])];
    const world = (leave1, leave2) => ({ routes: { DCX63: { stops: {
      1: { leave: leave1, packages: [{ da: 'DA0000006301', ref: 'tr-1' }], onOpenTr: [['tr-1', 'B1']] },
      2: { leave: leave2, packages: [{ da: 'DA0000006302', ref: 'tr-2' }], onOpenTr: [['tr-2', 'B2']] },
      3: { packages: [{ da: 'DA0000006303', ref: 'tr-3' }], onOpenTr: [['tr-3', 'B3']] }
    } } } });
    const ok = v36Run(C, d, world('leftOpen'));
    assert(ok.log.stopClicks.join(',') === '1,2,3' && ok.summary.counts.captured === 3 && ok.run.routeResults[0].status === 'done' &&
      ok.run.routeResults[0].leaveFailures.length === 1, label + ' v3.6-10/11: recoverable close failure -> next Stop');
    const bad = v36Run(C, d, world(undefined, 'fail'));
    assert(bad.log.stopClicks.join(',') === '1,2' && bad.run.routeResults[0].reasonCode === 'stop_leave_failed' &&
      bad.summary.byReferenceId['tr-1'] === 'captured' && bad.summary.byReferenceId['tr-3'] === 'route_aborted', label + ' v3.6-12: unrecoverable -> Route abort');
  })();
  console.log('ok: Bag v3.6 Stop-open first (' + label + ')');
}
Core2 = RootCore;
v36Suite('root core');
Core2 = PhaseCore;
v36Suite('phase1-core');

// 14: the 13:00 target set does not depend on Stop status
(function () {
  [RootCore, PhaseCore].forEach((C, k) => {
    const base = fixture();
    const withStatus = fixture();
    withStatus.rmsRouteDetails.stops.forEach((st, i) => { st.status = ['COMPLETE', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'ARRIVED'][i]; });
    const a = C.selectBagTargets([base], {}).targets.map((t) => t.referenceId).sort().join(',');
    const b = C.selectBagTargets([withStatus], {}).targets.map((t) => t.referenceId).sort().join(',');
    assert(a === b && a === 'tr-a,tr-b,tr-d', 'v3.6-14: same 13:00 targets (' + k + '): ' + a + ' / ' + b);
  });
  console.log('ok: v3.6 13:00 target set unchanged');
})();

// runner wiring v3.6: close retry kept, null never falls back, click only when dispatched, state separation
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  const leave = bag.slice(bag.indexOf('      leaveStop: function (stop, cb) {'), bag.indexOf('      returnToList: function (cb) {'));
  assert(/if \(n === 0\) \{ retry\(ad\); return; \}/.test(leave) && leave.indexOf('var usable = routeDetailUsable();') >= 0, 'v3.6-10: v3.5 close retry kept');
  assert(bag.indexOf("waitCortexTr('present', cb)") >= 0 && bag.indexOf("waitCortexTr('already_open', cb)") >= 0, 'v3.6: already-open Stops wait too');
  assert(bag.indexOf('clicked: !!res.dispatched') >= 0 && bag.indexOf('dispatched: true') >= 0, 'v3.6-9: dispatch reported');
  ['stopStatusCategory', 'trDetailsReceived', 'receivedAfterStopOpen', 'elapsedAfterStopOpenMs', 'stopOpenResult', 'packageFallback'].forEach((k) => {
    assert(bag.indexOf(k) >= 0, 'v3.6 target diag ' + k);
  });
  const fin = bag.slice(bag.indexOf('  function finishUnfinishedTest('), bag.indexOf('  function startUnfinishedBagTest('));
  assert(fin.indexOf('bagStatusByReferenceId') < 0 && fin.indexOf('bagRun = unfinishedTest.previousBagRun;') >= 0, 'v3.6-18: test never mixes into the normal Bag state');
  console.log('ok: v3.6 runner wiring');
})();

// ---------------- Bag v3.7: Stop-open retry v2 + Stop-level diagnostics ----------------
// Fake Stop list row for Core.runStopOpenAttempts: every resolve() re-renders the row (new button
// object, the old one disconnected), like Cortex re-rendering the list.
function fakeStopDom(C, spec) {
  spec = spec || {};
  const state = { aria: false, sel: spec.selBefore == null ? null : spec.selBefore, da: false, pkg: false };
  const trMap = spec.trMap || {};
  const pending = spec.pending || [{ referenceId: 'tr-1', scannableId: 'DA0000007001' }];
  const baseline = {};
  pending.forEach((t) => { if (C.hasTrDetails(trMap, t.referenceId)) baseline[t.referenceId] = true; });
  const log = { resolves: [], clicks: [], clickedIds: [], buttons: [] };
  let gen = 0;
  function obs() {
    return {
      ariaExpanded: state.aria, targetDaVisible: state.da,
      targetTrDetailsReceived: C.targetTrDetailsArrived(trMap, pending, baseline).length,
      selectedStopIdBefore: spec.selBefore == null ? null : spec.selBefore, selectedStopIdAfter: state.sel, targetPackageDom: state.pkg
    };
  }
  function open(kind) {
    if (kind === 'aria') state.aria = true;
    else if (kind === 'da') state.da = true;
    else if (kind === 'selected') state.sel = 'stop-xyz';
    else if (kind === 'package') state.pkg = true;
    else if (kind === 'tr') C.mergeTrDetailsMaps(trMap, { [pending[0].referenceId]: { trId: pending[0].referenceId, bagName: 'BAG_T', bagScannableId: 's' } });
    else if (kind === 'unrelated') C.mergeTrDetailsMaps(trMap, { 'tr-other-stop': { trId: 'tr-other-stop', bagName: 'BAG_X', bagScannableId: 's' } });
  }
  const o = {
    maxAttempts: spec.maxAttempts,
    resolve(n, strategy, cb) {
      log.resolves.push(strategy);
      log.buttons.forEach((b) => { b.connected = false; });
      if ((spec.missingOn || []).indexOf(n) >= 0) { cb(null, { candidateCount: 0 }); return; }
      const btn = { id: ++gen, connected: true };
      log.buttons.push(btn);
      if ((spec.staleOn || []).indexOf(n) >= 0) btn.connected = false;
      cb(btn, { candidateCount: 1 });
    },
    click(n, target, rec, cb) {
      assert(target.connected !== false, 'v3.7: never clicks a disconnected button');
      log.clicks.push(n);
      log.clickedIds.push(target.id);
      if (spec.covered) { cb({ ok: false, covered: true, detail: 'covered by div#popover' }); return; }
      if (spec.opensOn === n) open(spec.signal || 'aria');
      if (spec.lateAfter === n) spec.lateOpen = true;
      cb({ ok: true });
    },
    observe(n, rec, cb) {
      const s = C.stopOpenSignal(obs());
      if (!s && spec.lateOpen) { spec.lateOpen = false; open(spec.signal || 'aria'); }
      cb(s);
    },
    isOpen() { return C.stopOpenSignal(obs()); }
  };
  let final = null;
  o.done = (f) => { final = f; };
  C.runStopOpenAttempts(o);
  return { final, log, trMap };
}

function retryWorld(spec) {
  const w = fakeWorld(spec);
  const C = Core2;
  w.log.ensureCalls = [];
  const cur = () => w.current;
  const base = w.driver;
  const openRoute = base.openRoute;
  w.driver.openRoute = function (route, cb) {
    openRoute(route, (res) => { if (res.ok) w.current = spec.routes[route.routeCode]; cb(res); });
  };
  w.driver.ensureStop = function (stop, pending, onState, cb) {
    w.log.ensureCalls.push(stop.stop);
    const st = cur().stops[stop.stop];
    if (st.expanded) { cb({ ok: true, clicked: false, stopDiag: { openResult: 'already_open', clickAttempts: [] } }); return; }
    const baseline = {};
    pending.forEach((t) => { if (C.hasTrDetails(w.trMap, t.referenceId)) baseline[t.referenceId] = true; });
    function sig() {
      return C.stopOpenSignal({
        ariaExpanded: !!st.expanded,
        targetTrDetailsReceived: C.targetTrDetailsArrived(w.trMap, pending, baseline).length
      });
    }
    C.runStopOpenAttempts({
      resolve: (n, strategy, done) => done({ connected: true }, { candidateCount: 1 }),
      click: (n, target, rec, done) => {
        if (st.covered) { done({ ok: false, covered: true, detail: 'covered by div#popover' }); return; }
        w.log.stopClicks.push(stop.stop);
        if (st.opensOn === n) {
          if (!st.trOnly) st.expanded = true;
          (st.onOpenTr || []).forEach(([trId, bagName]) => {
            C.mergeTrDetailsMaps(w.trMap, { [trId]: { trId, bagName, bagScannableId: bagName ? 's' : null } });
          });
        }
        done({ ok: true });
      },
      observe: (n, rec, done) => done(sig()),
      isOpen: sig,
      done: (f) => {
        const stopDiag = { openResult: f.opened ? 'opened' : 'stop_expand_failed', clickAttempts: f.attempts,
          openedBy: f.openedBy, openedAttempt: f.openedAttempt };
        if (f.blocked) { cb({ ok: false, blocked: true, status: 'stop_expand_failed', detail: f.detail, clicked: false, stopDiag }); return; }
        if (f.opened) { cb({ ok: true, clicked: f.clickCount > 0, clickCount: f.clickCount, stopDiag }); return; }
        cb({ ok: false, clicked: f.clickCount > 0, clickCount: f.clickCount, status: 'stop_expand_failed', detail: f.detail, stopDiag });
      }
    });
  };
  return w;
}

function v37Run(C, detailsList, spec) {
  const sel = C.selectBagTargets(detailsList, {});
  const w = retryWorld(spec);
  const routes = C.groupBagTargetsByRoute(sel.targets);
  const run = C.createBagRun(sel.targets);
  let aborted = null;
  const findCalls = [];
  const findPackage = w.driver.findPackage;
  w.driver.findPackage = (t, stop, cb) => { findCalls.push(t.referenceId); findPackage(t, stop, cb); };
  C.runBagEngine({ run, routes, driver: w.driver, getTrMap: () => w.trMap, schedule: () => 1, cancel: () => {}, done: (a) => { aborted = a; } });
  const summary = C.summarizeBagRun(run, w.trMap);
  return { sel, run, log: w.log, aborted, trMap: w.trMap, summary, findCalls,
    stops: C.buildStopProcessingDiagnostics(run, w.trMap) };
}

function v37Suite(label) {
  const C = Core2;
  assert(C.STOP_OPEN_MAX_ATTEMPTS === 3 && C.STOP_OPEN_STRATEGIES.join(',') === 'initial,row_refind,route_refind', label + ' v3.7: 1 + 2 retries');

  // 1. first open succeeds
  (function () {
    const r = fakeStopDom(C, { opensOn: 1 });
    assert(r.final.opened && r.final.openedAttempt === 1 && r.final.openedBy === 'aria_expanded' && r.log.clicks.join(',') === '1',
      label + ' v3.7-1: first open ' + JSON.stringify(r.final));
  })();
  // 2. fail -> retry1 (row re-find) succeeds
  (function () {
    const r = fakeStopDom(C, { opensOn: 2 });
    assert(r.final.opened && r.final.openedAttempt === 2 && r.log.clicks.join(',') === '1,2' &&
      r.log.resolves.join(',') === 'initial,row_refind' && r.final.attempts[0].result === 'not_opened',
    label + ' v3.7-2: retry1 success ' + JSON.stringify(r.final));
  })();
  // 3. retry1 fails -> retry2 (Route re-find) succeeds
  (function () {
    const r = fakeStopDom(C, { opensOn: 3, signal: 'da' });
    assert(r.final.opened && r.final.openedAttempt === 3 && r.final.openedBy === 'target_da' &&
      r.log.resolves.join(',') === 'initial,row_refind,route_refind' && r.log.clicks.length === 3, label + ' v3.7-3: retry2 success');
  })();
  // 4. all three fail -> stop_expand_failed; never more than 3 clicks even if asked for more
  (function () {
    const r = fakeStopDom(C, { opensOn: 0, maxAttempts: 10 });
    assert(!r.final.opened && !r.final.blocked && r.final.attempts.length === 3 && r.final.clickCount === 3 && r.log.clicks.length === 3,
      label + ' v3.7-4: 3 attempts max ' + JSON.stringify(r.final));
    const one = fakeStopDom(C, { opensOn: 0, maxAttempts: 1 });
    assert(one.log.clicks.length === 1 && !one.final.opened, label + ' v3.7: maxAttempts 1 (package-fallback reopen) = v3.6 single click');
  })();
  // 5/6. each attempt re-finds the button; a stale element is never clicked
  (function () {
    const r = fakeStopDom(C, { opensOn: 0 });
    const ids = r.log.clickedIds;
    assert(r.log.resolves.length === 3 && new Set(ids).size === 3, label + ' v3.7-5: fresh element per attempt ' + ids);
    const s = fakeStopDom(C, { opensOn: 3, staleOn: [2] });
    assert(s.log.clicks.join(',') === '1,3' && s.final.attempts[1].result === 'stale_element' && s.final.attempts[1].clicked === false &&
      s.final.opened && s.final.openedAttempt === 3, label + ' v3.7-6: stale button skipped ' + JSON.stringify(s.final.attempts));
    const m = fakeStopDom(C, { opensOn: 3, missingOn: [2] });
    assert(m.final.attempts[1].result === 'button_not_found' && m.final.opened, label + ' v3.7: missing row on retry1 -> retry2');
  })();
  // 7. selectedStopId change proves the open
  (function () {
    const r = fakeStopDom(C, { opensOn: 1, signal: 'selected', selBefore: null });
    assert(r.final.opened && r.final.openedBy === 'selected_stop_id', label + ' v3.7-7: selectedStopId ' + JSON.stringify(r.final));
    assert(C.stopOpenSignal({ selectedStopIdBefore: 'a', selectedStopIdAfter: 'a' }) === '' &&
      C.stopOpenSignal({ selectedStopIdBefore: 'a', selectedStopIdAfter: null }) === '' &&
      C.stopOpenSignal({ selectedStopIdBefore: 'a', selectedStopIdAfter: 'b' }) === 'selected_stop_id', label + ' v3.7-7: only a new non-empty id');
    assert(C.stopOpenSignal({ ariaExpanded: 'false' }) === '' && C.stopOpenSignal({}) === '', label + ' v3.7: no signal');
  })();
  // 8. this Stop's target trDetails proves the open
  (function () {
    const r = fakeStopDom(C, { opensOn: 1, signal: 'tr' });
    assert(r.final.opened && r.final.openedBy === 'target_tr_details' && r.log.clicks.length === 1, label + ' v3.7-8: target trDetails');
    const pkg = fakeStopDom(C, { opensOn: 2, signal: 'package' });
    assert(pkg.final.opened && pkg.final.openedBy === 'target_package_dom', label + ' v3.7: row package DOM');
  })();
  // 9. unrelated trDetails (another referenceId, or a row that was already there) never proves the open
  (function () {
    const r = fakeStopDom(C, { opensOn: 1, signal: 'unrelated' });
    assert(!r.final.opened && r.log.clicks.length === 3, label + ' v3.7-9: unrelated trDetails ignored');
    const pre = {};
    C.mergeTrDetailsMaps(pre, { 'tr-1': { trId: 'tr-1', bagName: null, bagScannableId: null } });
    const p = fakeStopDom(C, { opensOn: 0, trMap: pre });
    assert(!p.final.opened, label + ' v3.7-9: trDetails present before the open is not proof');
    const t = [{ referenceId: 'tr-a' }, { referenceId: 'tr-b' }];
    const m = { 'tr-a': { bagName: 'X' }, 'tr-z': { bagName: 'Y' } };
    assert(C.targetTrDetailsArrived(m, t, {}).join(',') === 'tr-a' && C.targetTrDetailsArrived(m, t, { 'tr-a': true }).length === 0,
      label + ' v3.7-9: targetTrDetailsArrived');
  })();
  // late open: visible only after the observe window -> no second click (would collapse the row)
  (function () {
    const r = fakeStopDom(C, { opensOn: 0, lateAfter: 1 });
    assert(r.final.opened && r.final.lateDetected && r.final.openedAttempt === 1 && r.log.clicks.length === 1,
      label + ' v3.7: late open detected before retry, no extra click ' + JSON.stringify(r.final));
  })();
  // 19. covered -> blocked, no retry (v3.6 ui_blocked kept)
  (function () {
    const r = fakeStopDom(C, { covered: true });
    assert(r.final.blocked && !r.final.opened && r.final.attempts.length === 1 && r.final.clickCount === 0, label + ' v3.7-19: covered -> no retry');
  })();

  // 10/11. one Stop, 3 packages: ensureStop once, opened on retry1, all 3 captured, 0 package click
  (function () {
    const d = [v36Details('DCX70', [{ seq: 15, status: 'NOT_STARTED', pk: [['DA0000007101', 'tr-a'], ['DA0000007102', 'tr-b'], ['DA0000007103', 'tr-c']] }])];
    const spec = { routes: { DCX70: { stops: { 15: { opensOn: 2,
      packages: [{ da: 'DA0000007101', ref: 'tr-a' }, { da: 'DA0000007102', ref: 'tr-b' }, { da: 'DA0000007103', ref: 'tr-c' }],
      onOpenTr: [['tr-a', 'BAG_A'], ['tr-b', 'BAG_A'], ['tr-c', 'BAG_B']] } } } } };
    const r = v37Run(C, d, spec);
    assert(r.log.ensureCalls.join(',') === '15' && r.log.stopClicks.join(',') === '15,15', label + ' v3.7-10: one Stop open (1 retry) ' + r.log.stopClicks);
    assert(r.summary.counts.captured === 3 && r.summary.clicks === 0 && r.log.packageClicks.length === 0 && r.findCalls.length === 0,
      label + ' v3.7-11: 3 captured by one open');
    const so = r.summary.stopOpen;
    assert(so.uniqueTargetStops === 1 && so.successfulStopOpens === 1 && so.failedStopOpens === 0 && so.stopOpenRetry1 === 1 &&
      so.stopOpenRetry1Success === 1 && so.stopOpenRetry2 === 0 && so.trDetailsReceivedAfterRetry === 3 && so.bagCapturedAfterRetry === 3 &&
      so.stopOpenBagCaptured === 3 && so.capturedByStopOpen === 3, label + ' v3.7: summary ' + JSON.stringify(so));
    assert(r.summary.stopClicks === 2, label + ' v3.7: Stop click counts every dispatched click');
    const rec = r.stops[0];
    assert(rec.routeCode === 'DCX70' && rec.stopNumber === 15 && rec.targetCount === 3 && rec.targetReferenceIds.join(',') === 'tr-a,tr-b,tr-c' &&
      rec.clickAttemptCount === 2 && rec.clickAttempts.length === 2 && rec.openResult === 'opened' && rec.openedAttempt === 2 &&
      rec.closeResult === 'closed' && rec.trDetailsReceivedCount === 3 && rec.bagCapturedCount === 3 && rec.noTrDetailsCount === 0 &&
      rec.stopStatus === 'NOT_STARTED' && typeof rec.elapsedMs === 'number', label + ' v3.7-12: stopProcessingDiagnostics ' + JSON.stringify(rec));
    const text = C.formatBagSummary(r.summary);
    assert(text.indexOf('Stop成功 1/1 / retry救済 1') >= 0 && text.indexOf('Stop-open取得 3 / Stop-open null 0 / trDetailsなし 0') >= 0 &&
      text.indexOf('package fallback 0 / package click 0') >= 0, label + ' v3.7: panel ' + text);
  })();

  // 12/13/14. null -> captured_null without fallback; trDetails-less only -> fallback; failed Stop -> no fallback
  (function () {
    const d = [v36Details('DCX71', [
      { seq: 1, status: 'NOT_STARTED', pk: [['DA0000007201', 'tr-null'], ['DA0000007202', 'tr-none']] },
      { seq: 2, status: 'NOT_STARTED', pk: [['DA0000007203', 'tr-f1'], ['DA0000007204', 'tr-f2'], ['DA0000007205', 'tr-f3']] },
      { seq: 3, status: 'NOT_STARTED', pk: [['DA0000007206', 'tr-g1'], ['DA0000007207', 'tr-g2']] }
    ])];
    const spec = { routes: { DCX71: { stops: {
      1: { opensOn: 1, packages: [{ da: 'DA0000007201', ref: 'tr-null' }, { da: 'DA0000007202', ref: 'tr-none', tr: [['tr-none', 'BAG_PK']] }],
        onOpenTr: [['tr-null', null]] },
      2: { opensOn: 0, packages: [{ da: 'DA0000007203', ref: 'tr-f1' }, { da: 'DA0000007204', ref: 'tr-f2' }, { da: 'DA0000007205', ref: 'tr-f3' }] },
      3: { opensOn: 0, packages: [{ da: 'DA0000007206', ref: 'tr-g1' }, { da: 'DA0000007207', ref: 'tr-g2' }] }
    } } } };
    const r = v37Run(C, d, spec);
    const b = r.summary.byReferenceId;
    assert(b['tr-null'] === 'captured_null' && r.findCalls.indexOf('tr-null') < 0, label + ' v3.7-12/13: null kept, no fallback');
    assert(r.findCalls.join(',') === 'tr-none' && r.log.packageClicks.join(',') === 'DA0000007202' && b['tr-none'] === 'captured',
      label + ' v3.7-14: only the trDetails-less package falls back ' + r.findCalls);
    assert(['tr-f1', 'tr-f2', 'tr-f3', 'tr-g1', 'tr-g2'].every((ref) => b[ref] === 'stop_expand_failed'), label + ' v3.7: failed Stops');
    assert(r.log.ensureCalls.join(',') === '1,2,3' && r.log.stopClicks.filter((s) => s === 2).length === 3 &&
      r.log.stopClicks.filter((s) => s === 3).length === 3, label + ' v3.7: a failed Stop is tried 3 times once, not per package ' + r.log.stopClicks);
    const so = r.summary.stopOpen;
    assert(so.stopExpandFailedPackages === 5 && so.stopExpandFailedStops === 2 && so.failedStopOpens === 2 && so.successfulStopOpens === 1 &&
      so.stopOpenRetry1 === 2 && so.stopOpenRetry2 === 2 && so.stopOpenRetry1Success === 0 && so.stopOpenRetry2Success === 0,
    label + ' v3.7: Stop-level failure counts ' + JSON.stringify(so));
    assert(C.formatBagSummary(r.summary).indexOf('Stop展開失敗 5 package / 2 Stop') >= 0 &&
      C.formatBagSummary(r.summary).indexOf('Stop成功 1/3 / retry救済 0') >= 0, label + ' v3.7: package / Stop split in panel');
    assert(r.run.routeResults[0].status === 'done' && r.summary.counts.route_aborted === 0, label + ' v3.7-18: failed Stops never abort the Route');
    const failed = r.stops.filter((s) => s.openResult === 'stop_expand_failed');
    assert(failed.length === 2 && failed[0].clickAttemptCount === 3 && failed[0].closeResult === '' && failed[0].failureReason,
      label + ' v3.7: failed Stop record ' + JSON.stringify(failed[0]));
    // 15. actual click evidence per fallback target
    const fb = r.run.fallbackDiagnostics['tr-none'];
    assert(fb && fb.packageDomFound === true && fb.clickTargetFound === true && fb.actualClickAttempted === true && fb.result === 'captured' &&
      Object.keys(r.run.fallbackDiagnostics).length === 1, label + ' v3.7-15: fallback diagnostics ' + JSON.stringify(fb));
  })();

  // 8 (engine). trDetails without any DOM change counts as opened; captured by Stop open
  (function () {
    const d = [v36Details('DCX72', [{ seq: 4, status: 'NOT_STARTED', pk: [['DA0000007301', 'tr-t']] }])];
    const spec = { routes: { DCX72: { stops: { 4: { opensOn: 1, trOnly: true, packages: [{ da: 'DA0000007301', ref: 'tr-t' }], onOpenTr: [['tr-t', 'BAG_T']] } } } } };
    const r = v37Run(C, d, spec);
    assert(r.summary.byReferenceId['tr-t'] === 'captured' && r.stops[0].openedBy === 'target_tr_details' && r.log.stopClicks.length === 1 &&
      r.summary.stopOpen.capturedByStopOpen === 1, label + ' v3.7-8: trDetails-proven open ' + JSON.stringify(r.stops[0]));
  })();

  // 19 (engine). covered Stop row -> UI blocked Route, no retry click
  (function () {
    const d = [v36Details('DCX73', [{ seq: 1, status: 'NOT_STARTED', pk: [['DA0000007401', 'tr-u']] }])];
    const r = v37Run(C, d, { routes: { DCX73: { stops: { 1: { covered: true, packages: [{ da: 'DA0000007401', ref: 'tr-u' }] } } } } });
    assert(r.run.routeResults[0].status === 'ui_blocked' && r.log.stopClicks.length === 0 && r.summary.byReferenceId['tr-u'] === 'ui_blocked',
      label + ' v3.7-19: UI blocked kept');
  })();

  // fallback lookup classification
  (function () {
    const p = C.packageLookupFallbackPatch;
    assert(p({ ok: false, status: 'package_dom_not_found', candidateCount: 0 }).failureReason === 'package_dom_not_found' &&
      p({ ok: false, status: 'package_click_target_not_found', candidateCount: 1 }).packageDomFound === true &&
      p({ ok: false, status: 'package_click_target_not_found' }).clickTargetFound === false &&
      p({ ok: false, status: 'dom_ambiguous', candidateCount: 2 }).failureReason === 'package_ambiguous' &&
      p({ ok: true, candidateCount: 1 }).clickTargetFound === true, label + ' v3.7: fallback classification');
  })();

  // null diagnostics: row shape only, raw null kept, no inference
  (function () {
    const s = C.trDetailsRowShape({ trId: 'tr-1', bagName: null, bagScannableId: null, address: 'x', tote: 'T1' });
    assert(s.hasBagName && s.bagNameRaw === null && s.keys.join(',') === 'trId,bagName,bagScannableId,address,tote' &&
      Object.keys(s.bagFields).join(',') === 'bagName,bagScannableId,tote' && s.bagFields.address === undefined, label + ' v3.7: row shape ' + JSON.stringify(s));
    assert(C.trDetailsRowShape({ trId: 'tr-2' }).bagNameRaw === 'missing' && C.trDetailsRowShape(null) === null, label + ' v3.7: missing bagName field');
  })();
  console.log('ok: Bag v3.7 Stop-open retry v2 (' + label + ')');
}
Core2 = RootCore;
v37Suite('root core');
Core2 = PhaseCore;
v37Suite('phase1-core');

// 20. 13:00 target count unchanged on the real sanitized Route (v3.7 did not touch selection)
(function () {
  const real = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'cortex-13-priority', 'dcx47-sanitized.json'), 'utf8'));
  [RootCore, PhaseCore].forEach((C) => {
    const sel = C.selectBagTargets([real], {});
    assert(sel.priorityCount === 13 && sel.priorityCount === C.extractFromRouteDetails(real).packages.length, 'v3.7-20: 13:00 packages 13 (as v3.6)');
  });
  console.log('ok: v3.7 13:00 target set unchanged');
})();

// runner wiring v3.7
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  const ensure = bag.slice(bag.indexOf('      ensureStop: function (stop, pending, onState, cb, openOpts) {'), bag.indexOf('      findPackage: function (target, stop, cb) {'));
  assert(ensure.indexOf('Core.runStopOpenAttempts({') >= 0 && ensure.indexOf('Core.STOP_OPEN_MAX_ATTEMPTS') >= 0, 'v3.7: retry via Core');
  // 5/6: every attempt re-reads the DOM (row button / whole Route); the click resolver re-finds when disconnected
  assert(ensure.indexOf("if (strategy === 'row_refind') {") >= 0 && ensure.indexOf('stopListRowInfo(row)') >= 0 &&
    ensure.indexOf("row.querySelectorAll('[role=\"button\"][aria-expanded]')") >= 0, 'v3.7-5: retry1 re-reads the same row');
  assert(ensure.indexOf('scrollSearch(function () {\n              var labels = findStopLabels(stop.stop);') >= 0, 'v3.7-5: retry2 re-searches the Route');
  assert(ensure.indexOf('if (chosen && chosen.button.isConnected) return adopt(chosen);') >= 0 && ensure.indexOf('connected: t1.button.isConnected') >= 0,
    'v3.7-6: stale element never reused');
  // 16: Mapbox markers never clicked: labels via findStopLabels (excludeMarkers) / stopListTargetOf only
  assert(ensure.indexOf('STOP_MARKER_KIND') < 0 && ensure.indexOf('svg') < 0 && ensure.indexOf('mapbox') < 0 &&
    bag.indexOf("return Core.matchStopLabelEntries(entries, seq, { excludeMarkers: true })") >= 0 &&
    bag.indexOf('if (!row || inMapbox(row)) return null;') >= 0, 'v3.7-16: Mapbox excluded');
  assert(ensure.indexOf('usedLabels') >= 0 && bag.indexOf('function clickListButton(getTarget, runId, done, diag, skipLabels, preferLater)') >= 0,
    'v3.7: retry prefers a different safe point');
  assert(ensure.indexOf("if (rel === 'self' || rel === 'child') chosen = p;") < 0 && bag.indexOf("if (rel === 'self' || rel === 'child') chosen = p;") >= 0,
    'v3.7-19: safe hit-test shared, unchanged');
  // package-fallback reopen stays a single v3.6 click
  assert(bag.indexOf('driver.searchPackage(target, cb);\n          }, { maxAttempts: 1, noExtendedWait: true });') >= 0, 'v3.7: fallback reopen single click');
  ['stopProcessingDiagnostics', 'packageFallbackDiagnostics', 'bagNullDiagnostics', 'recordBagTrRows', 'BAG_STOP_CLICK_FAIL_DIAG_MAX'].forEach((k) => {
    assert(bag.indexOf(k) >= 0 || runner.indexOf(k) >= 0, 'v3.7 diag ' + k);
  });
  // v3.6 Stop-open capture path intact: trDetails wait after an open, then the engine records stop_open
  // (v3.8: the wait moved into waitStopTrDetails; normal 3 s still ctx.stopOpenTrWaitMs || BAG_STOP_OPEN_TR_WAIT_MS)
  assert(ensure.indexOf('waitStopTrDetails(ctx, runId, pending, openStarted, noExtraWait, function (tw) {') >= 0 && ensure.indexOf("waitCortexTr('already_open', cb)") >= 0 &&
    bag.indexOf('normalMs: ctx.stopOpenTrWaitMs || BAG_STOP_OPEN_TR_WAIT_MS,') >= 0, 'v3.7: v3.6 Cortex trDetails wait kept');
  // 21: UBT v1 still reads the same click-diag keys
  const fin = bag.slice(bag.indexOf('  function finishUnfinishedTest('), bag.indexOf('  function startUnfinishedBagTest('));
  ['d.result', 'd.expandedBy', 'd.stopList.ariaExpandedAfter', 'd.stopList.selectedStopIdAfter', 'd.cortexTrDetails', 'd.clicked'].forEach((k) => {
    assert(fin.indexOf(k) >= 0, 'v3.7-21: UBT reads ' + k);
  });
  ['clickDiag.result', 'clickDiag.expandedBy', 'clickDiag.stopList.ariaExpandedAfter', 'clickDiag.stopList.selectedStopIdAfter', 'clickDiag.cortexTrDetails', 'clickDiag.clicked'].forEach((k) => {
    assert(ensure.indexOf(k) >= 0, 'v3.7-21: ensureStop still writes ' + k);
  });
  console.log('ok: v3.7 runner wiring');
})();

// ---------------- Bag v3.8: normal 3 s + extended 3 s trDetails wait ----------------
// Fake clock: wait() polls every 150 ms like waitBag; trDetails rows arrive at fixed times.
function trClock(C, events) {
  let t = 0;
  const trMap = {};
  const arrival = {};
  const evs = (events || []).map((e) => Object.assign({}, e));
  function apply() {
    evs.forEach((e) => {
      if (e.done || e.at > t) return;
      e.done = true;
      C.mergeTrDetailsMaps(trMap, { [e.ref]: { trId: e.ref, bagName: e.bag || null, bagScannableId: e.bag ? 's' : null } });
      arrival[e.ref] = e.at;
    });
  }
  return {
    trMap,
    now: () => t,
    advance: (ms) => { t += ms; apply(); },
    receivedAtOf: (ref) => (arrival[ref] == null ? null : arrival[ref]),
    wait(check, ms, cb) {
      const end = t + ms;
      apply();
      while (!check() && t < end) { t = Math.min(end, t + 150); apply(); }
      cb(check());
    }
  };
}

function trWaitDirect(C, pending, events, opts) {
  const clk = trClock(C, events);
  const baseline = {};
  (opts && opts.pre || []).forEach((ref) => {
    C.mergeTrDetailsMaps(clk.trMap, { [ref]: { trId: ref, bagName: 'PRE', bagScannableId: 's' } });
    baseline[ref] = true;
  });
  let res = null;
  C.runTargetTrWait({
    pending, trMap: () => clk.trMap, baseline, startedAt: clk.now(), now: clk.now, receivedAtOf: clk.receivedAtOf,
    normalMs: 3000, extendedMs: opts && opts.extendedMs != null ? opts.extendedMs : 3000, wait: clk.wait, done: (r) => { res = r; }
  });
  return { res, clk };
}

// Engine run where every Stop opens on the first click and then uses Core.runTargetTrWait.
function v38Run(C, detailsList, eventsByStop, extra) {
  const sel = C.selectBagTargets(detailsList, {});
  const routes = C.groupBagTargetsByRoute(sel.targets);
  const run = C.createBagRun(sel.targets);
  const log = { ensure: [], stopClicks: 0, find: [], clicks: [] };
  let clk = trClock(C, []);
  const trMap = {};
  (extra && extra.pre || []).forEach(([ref, bag]) => C.mergeTrDetailsMaps(trMap, { [ref]: { trId: ref, bagName: bag, bagScannableId: 's' } }));
  const driver = {
    openRoute: (route, cb) => cb({ ok: true }),
    ensureStop(stop, pending, onState, cb) {
      log.ensure.push(stop.stop);
      log.stopClicks += 1;
      clk = trClock(C, eventsByStop[stop.stop] || []);
      Object.keys(trMap).forEach((k) => { clk.trMap[k] = trMap[k]; });
      const baseline = {};
      pending.forEach((t) => { if (C.hasTrDetails(clk.trMap, t.referenceId)) baseline[t.referenceId] = true; });
      C.runTargetTrWait({
        pending, trMap: () => clk.trMap, baseline, startedAt: clk.now(), now: clk.now, receivedAtOf: clk.receivedAtOf,
        normalMs: 3000, extendedMs: 3000, wait: clk.wait,
        done: (r) => {
          C.recordTrWait(run, r);
          Object.keys(clk.trMap).forEach((k) => { trMap[k] = clk.trMap[k]; });
          log.waited = (log.waited || []).concat(r.waitedMs);
          cb({ ok: true, clicked: true, clickCount: 1, stopDiag: { openResult: 'opened', openedAttempt: 1, clickAttempts: [{ attempt: 1, clicked: true }] } });
        }
      });
    },
    findPackage(t, stop, cb) { log.find.push(t.referenceId); cb({ ok: false, status: 'package_dom_not_found', candidateCount: 0 }); },
    clickPackage(t, h, cb) { log.clicks.push(t.referenceId); cb({ ok: true }); },
    waitTrDetails: (t, cb) => cb(false),
    restoreAfterPackage: (t, cb) => cb({ ok: true }),
    leaveStop: (stop, cb) => cb({ ok: true }),
    returnToList: (cb) => cb({ ok: true })
  };
  C.runBagEngine({ run, routes, driver, getTrMap: () => trMap, schedule: () => 1, cancel: () => {}, done: () => {} });
  return { run, log, trMap, summary: C.summarizeBagRun(run, trMap) };
}

function v38Suite(label) {
  const C = Core2;
  assert(C.TR_WAIT_NORMAL_MS === 3000 && C.TR_WAIT_EXTENDED_MS === 3000, label + ' v3.8: 3 s + 3 s');
  const one = (seq, ref, da) => [v36Details('DCX80', [{ seq, status: 'NOT_STARTED', pk: [[da, ref]] }])];

  // A. arrives at 1 s -> normal, captured, no extended wait, wait ends right away
  (function () {
    const d = trWaitDirect(C, [{ referenceId: 'tr-a' }], [{ at: 1000, ref: 'tr-a', bag: 'BAG_A' }]);
    const r = d.res.records['tr-a'];
    assert(r.waitPhase === 'normal' && !r.delayedRescue && r.trDetailsLatencyMs === 1000 && !d.res.extendedUsed && d.res.allArrived &&
      d.res.waitedMs < 1200, label + ' v3.8-A: ' + JSON.stringify(d.res));
    const e = v38Run(C, one(1, 'tr-a', 'DA0000008001'), { 1: [{ at: 1000, ref: 'tr-a', bag: 'BAG_A' }] });
    assert(e.summary.byReferenceId['tr-a'] === 'captured' && e.log.find.length === 0 && e.summary.stopOpen.trWaitNormalReceived === 1 &&
      e.summary.stopOpen.trWaitExtendedRescued === 0, label + ' v3.8-A engine');
  })();

  // B. arrives at 4.5 s -> extended, delayedRescue, captured, no package fallback
  (function () {
    const e = v38Run(C, one(2, 'tr-b', 'DA0000008002'), { 2: [{ at: 4500, ref: 'tr-b', bag: 'BAG_B' }] });
    const r = e.run.trWait['tr-b'];
    assert(r.waitPhase === 'extended' && r.delayedRescue === true && r.trDetailsLatencyMs === 4500 && r.targetTrDetailsReceivedAt === 4500,
      label + ' v3.8-B record ' + JSON.stringify(r));
    assert(e.summary.byReferenceId['tr-b'] === 'captured' && e.log.find.length === 0 && e.log.clicks.length === 0 &&
      e.summary.stopOpen.stopOpenBagCaptured === 1 && e.summary.stopOpen.trWaitExtendedRescued === 1 && e.summary.stopOpen.trWaitExtendedCaptured === 1 &&
      e.log.waited[0] < 4700, label + ' v3.8-B: rescued by the extended wait, ends on arrival');
  })();

  // C. arrives at 5 s with bagName null -> captured_null, no fallback
  (function () {
    const e = v38Run(C, one(3, 'tr-c', 'DA0000008003'), { 3: [{ at: 5000, ref: 'tr-c', bag: null }] });
    assert(e.summary.byReferenceId['tr-c'] === 'captured_null' && e.log.find.length === 0 && e.run.trWait['tr-c'].delayedRescue === true &&
      e.summary.stopOpen.stopOpenBagNull === 1 && e.summary.stopOpen.trWaitExtendedNull === 1, label + ' v3.8-C: null kept, no fallback');
  })();

  // D. nothing after 6 s -> package fallback
  (function () {
    const e = v38Run(C, one(4, 'tr-d', 'DA0000008004'), {});
    const r = e.run.trWait['tr-d'];
    assert(r.noTrDetailsAfterWait && r.targetTrDetailsReceivedAt === null && r.trDetailsLatencyMs === null && r.waitPhase === 'extended' &&
      !r.delayedRescue && e.log.waited[0] === 6000, label + ' v3.8-D record ' + JSON.stringify(r));
    assert(e.log.find.join(',') === 'tr-d' && e.summary.byReferenceId['tr-d'] === 'package_dom_not_found' &&
      e.summary.stopOpen.stopOpenNoTrDetails === 1 && e.summary.stopOpen.trWaitNoTrDetailsAfterExtended === 1, label + ' v3.8-D: fallback after 6 s only');
  })();

  // E. one Stop, 3 targets arriving at 0.5 / 2 / 4 s -> one open, 2 normal + 1 extended
  (function () {
    const d = [v36Details('DCX81', [{ seq: 7, status: 'NOT_STARTED', pk: [['DA0000008101', 'tr-e1'], ['DA0000008102', 'tr-e2'], ['DA0000008103', 'tr-e3']] }])];
    const e = v38Run(C, d, { 7: [{ at: 500, ref: 'tr-e1', bag: 'B1' }, { at: 2000, ref: 'tr-e2', bag: 'B1' }, { at: 4000, ref: 'tr-e3', bag: null }] });
    assert(e.log.ensure.join(',') === '7' && e.log.stopClicks === 1 && e.log.find.length === 0, label + ' v3.8-E: one open for 3 targets');
    const w = e.run.trWait;
    assert(w['tr-e1'].waitPhase === 'normal' && w['tr-e2'].waitPhase === 'normal' && w['tr-e3'].delayedRescue &&
      e.summary.counts.captured === 2 && e.summary.counts.captured_null === 1 && e.log.waited[0] < 4200, label + ' v3.8-E ' + JSON.stringify(w));
  })();

  // F. unrelated referenceId arriving never ends the wait nor counts as the target
  (function () {
    const d = trWaitDirect(C, [{ referenceId: 'tr-f' }], [{ at: 500, ref: 'tr-other', bag: 'X' }]);
    assert(!d.res.allArrived && d.res.records['tr-f'].noTrDetailsAfterWait && d.res.waitedMs === 6000 && !d.res.records['tr-other'],
      label + ' v3.8-F: unrelated trDetails ignored ' + JSON.stringify(d.res));
  })();

  // G. preexisting trDetails is not a Stop-open arrival
  (function () {
    const d = trWaitDirect(C, [{ referenceId: 'tr-g' }, { referenceId: 'tr-g2' }], [{ at: 800, ref: 'tr-g2', bag: 'B' }], { pre: ['tr-g'] });
    assert(d.res.records['tr-g'].waitPhase === 'preexisting' && d.res.records['tr-g'].delayedRescue === false &&
      d.res.records['tr-g'].trDetailsLatencyMs === null && d.res.records['tr-g2'].waitPhase === 'normal', label + ' v3.8-G ' + JSON.stringify(d.res.records));
    const s = C.summarizeTrWait({ targets: [{ referenceId: 'tr-g' }, { referenceId: 'tr-g2' }], trWait: d.res.records }, d.clk.trMap);
    assert(s.trWaitNormalReceived === 1 && s.trWaitExtendedRescued === 0, label + ' v3.8-G: preexisting not counted');
    // Unfinished Bag Test v1: extendedMs 0 keeps the single 3 s wait
    const u = trWaitDirect(C, [{ referenceId: 'tr-u' }], [{ at: 4500, ref: 'tr-u', bag: 'B' }], { extendedMs: 0 });
    assert(!u.res.extendedUsed && u.res.waitedMs === 3000 && u.res.records['tr-u'].noTrDetailsAfterWait, label + ' v3.8: UBT v1 single wait');
  })();

  // panel line + mixed day
  (function () {
    const d = [v36Details('DCX82', [
      { seq: 1, status: 'NOT_STARTED', pk: [['DA0000008201', 'tr-p1']] },
      { seq: 2, status: 'NOT_STARTED', pk: [['DA0000008202', 'tr-p2']] },
      { seq: 3, status: 'NOT_STARTED', pk: [['DA0000008203', 'tr-p3']] }
    ])];
    const e = v38Run(C, d, { 1: [{ at: 300, ref: 'tr-p1', bag: 'B' }], 2: [{ at: 3600, ref: 'tr-p2', bag: 'B' }] });
    const text = C.formatBagSummary(e.summary);
    assert(text.indexOf('通常待機取得 1 / 追加待機救済 1 (Bag 1 / null 0) / 6秒待機後trDetailsなし 1') >= 0 &&
      text.indexOf('Stop-open取得 2 / Stop-open null 0 / trDetailsなし 1') >= 0 && text.indexOf('package fallback 1 / package click 0') >= 0,
    label + ' v3.8: panel ' + text);
  })();
  console.log('ok: Bag v3.8 trDetails wait (' + label + ')');
}
Core2 = RootCore;
v38Suite('root core');
Core2 = PhaseCore;
v38Suite('phase1-core');

// H + runner wiring v3.8: Stop retry untouched, both wait paths use the two-phase wait, UBT keeps 3 s
(function () {
  const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  const bag = runner.slice(runner.indexOf('// ---- Bag enrichment phase ----'), runner.indexOf('  function onReady('));
  assert(bag.indexOf("BAG_STOP_OPEN_TR_EXTRA_MS = 3000") >= 0 && bag.indexOf("extendedMs: ctx.stopOpenTrWaitMs || noExtra ? 0 : BAG_STOP_OPEN_TR_EXTRA_MS") >= 0 && bag.indexOf("{ maxAttempts: 1, noExtendedWait: true }") >= 0 && bag.indexOf("routeExtensionCapMs: BAG_ROUTE_EXTENSION_CAP_MS") >= 0,
    'v3.8: extra 3 s, UBT keeps its single wait');
  assert((bag.match(/waitStopTrDetails\(ctx, runId, pending, (started|openStarted), noExtraWait, function \(tw\)/g) || []).length === 2, 'v3.8: both Stop-open wait paths');
  assert(bag.indexOf('shape.receivedAtMs = Date.parse(at);') >= 0, 'v3.8: arrival time from the trDetails hook');
  ['stopOpenedAt', 'targetTrDetailsReceivedAt', 'trDetailsLatencyMs', 'waitPhase', 'delayedRescue', 'finalStatus'].forEach((k) => {
    assert(bag.indexOf(k + ':') >= 0, 'v3.8 target diag ' + k);
  });
  const ensure = bag.slice(bag.indexOf('      ensureStop: function (stop, pending, onState, cb, openOpts) {'), bag.indexOf('      findPackage: function (target, stop, cb) {'));
  assert(ensure.indexOf('Core.runStopOpenAttempts({') >= 0 && ensure.indexOf("if (strategy === 'row_refind') {") >= 0, 'v3.8-H: v3.7 retry kept');
  console.log('ok: v3.8 runner wiring');
})();
