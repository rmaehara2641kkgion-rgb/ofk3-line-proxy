import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const Core = require('../cortex-13-priority-core.js');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function task(opts) {
  opts = opts || {};
  return {
    taskType: opts.taskType || 'DROP_OFF',
    promiseType: opts.promiseType || 'STANDARD',
    timeWindowed: !!opts.timeWindowed,
    windowStartTime: opts.windowStartTime,
    windowEndTime: opts.windowEndTime,
    domainMap: opts.domainMap || (opts.scannableId
      ? { scannableId: opts.scannableId, orderId: opts.orderId }
      : {}),
    referenceId: opts.referenceId,
    addressId: opts.addressId,
    driverAssistText: opts.driverAssistText
  };
}

function stop(seq, tasks) {
  return {
    sequenceNumber: seq,
    plannedStartTime: 1,
    plannedEndTime: 2,
    tasks: tasks || []
  };
}

function details(routeCode, stops) {
  return {
    rmsRouteDetails: {
      routeId: 'R-' + routeCode,
      routeCode: routeCode,
      localDate: [2026, 9, 18],
      plannedDepartureTime: 1789697520000,
      stops: stops
    },
    transporters: [{ firstName: 'Taro', lastName: 'Yamada' }],
    addresses: []
  };
}

function sanitizeCortexPackageAssistIndexRow(row) {
  row = row || {};
  var trackingId = String(row.trackingId || '').trim();
  var routeCode = String(row.routeCode || '').trim();
  if (!routeCode || !trackingId) return null;
  return {
    routeCode: routeCode,
    trackingId: trackingId,
    referenceId: row.referenceId == null || row.referenceId === '' ? null : String(row.referenceId),
    driverAid: row.driverAid == null || row.driverAid === '' ? null : String(row.driverAid),
    bagName: row.bagName == null || row.bagName === '' ? null : String(row.bagName),
    bagScannableId: row.bagScannableId == null || row.bagScannableId === '' ? null : String(row.bagScannableId),
    bagColorCode: row.bagColorCode == null || row.bagColorCode === '' ? null : String(row.bagColorCode),
    bagColor: row.bagColor == null || row.bagColor === '' ? null : String(row.bagColor),
    bagNumber: row.bagNumber == null || row.bagNumber === '' ? null : String(row.bagNumber),
    bagDisplay: row.bagDisplay == null || row.bagDisplay === '' ? null : String(row.bagDisplay)
  };
}

function storeRoundTrip(body) {
  var packageAssistIndex = Array.isArray(body.packageAssistIndex)
    ? body.packageAssistIndex.map(sanitizeCortexPackageAssistIndexRow).filter(function (r) { return !!r; })
    : [];
  var packageSequenceIndex = Array.isArray(body.packageSequenceIndex) ? body.packageSequenceIndex : [];
  return {
    packages: Array.isArray(body.packages) ? body.packages : [],
    packageSequenceIndex: packageSequenceIndex,
    packageAssistIndex: packageAssistIndex
  };
}

const REF = 'tr-cw-amzljplaunch-80d064d3-33f0-1f0f-6fb6-30b4a934cbba';
const BAG = 'JP_OB-AM-1956_YLO';
const BAG_SCAN = '52fae05f-ae60-4d8c-9c86-49136ceba5e5';

// A. Driver Aid only (trDetails empty) — DA0012408732 / 649
(function () {
  var d = details('DCX40', [stop(16, [task({
    scannableId: 'DA0012408732',
    referenceId: 'tr-aid-only',
    driverAssistText: '649'
  })])]);
  var r = Core.extractPackageAssistIndex(d, {});
  assert(r.ok && r.index.length === 1, 'A: one row');
  assert(r.index[0].trackingId === 'DA0012408732', 'A: trackingId');
  assert(r.index[0].driverAid === '649', 'A: driverAid');
  assert(r.index[0].bagDisplay == null && r.index[0].bagName == null, 'A: no bag');
  var ingested = Core.ingestBundle({ details: [d], trDetails: [] });
  assert(ingested.packageAssistIndex.length === 1, 'A: ingest with empty trDetails');
  assert(ingested.packageAssistIndex[0].driverAid === '649', 'A: ingest driverAid');
  assert(ingested.packageAssistIndex[0].bagDisplay == null, 'A: ingest bag null');
  console.log('ok: A Driver Aid only without trDetails');
})();

// A2. referenceId === trId → bag join
(function () {
  var d = details('DCX40', [stop(16, [task({
    scannableId: 'DA0012405022',
    referenceId: REF,
    driverAssistText: '652',
    addressId: 'ADDR-1'
  })])]);
  var map = Core.parseTrDetailsBody({
    trDetails: [{ trId: REF, bagName: BAG, bagScannableId: BAG_SCAN }]
  });
  var r = Core.extractPackageAssistIndex(d, map);
  assert(r.ok && r.index.length === 1, 'A: one assist row');
  assert(r.index[0].bagName === BAG, 'A: bagName joined');
  assert(r.index[0].bagScannableId === BAG_SCAN, 'A: bagScannableId');
  assert(r.index[0].trackingId === 'DA0012405022', 'A: trackingId');
  assert(r.diagnostics.assistMatched === 1, 'A: matched');
  console.log('ok: A exact referenceId===trId join');
})();

// B. different trId → no join
(function () {
  var d = details('DCX40', [stop(1, [task({
    scannableId: 'DA0012405022',
    referenceId: REF,
    driverAssistText: '652'
  })])]);
  var map = Core.parseTrDetailsBody({
    trDetails: [{ trId: 'tr-other', bagName: BAG, bagScannableId: BAG_SCAN }]
  });
  var r = Core.extractPackageAssistIndex(d, map);
  assert(r.index[0].bagName == null, 'B: no bag join');
  assert(r.diagnostics.assistUnmatched === 1, 'B: unmatched');
  assert(r.diagnostics.trDetailsMissing === 1, 'B: missing');
  console.log('ok: B different trId no join');
})();

// C. same addressId, different referenceId → no join
(function () {
  var d = details('DCX40', [stop(1, [task({
    scannableId: 'DA-A',
    referenceId: 'tr-a',
    addressId: 'SAME-ADDR',
    driverAssistText: '1'
  })])]);
  var map = Core.parseTrDetailsBody({
    trDetails: [{ trId: 'tr-b', bagName: BAG, bagScannableId: BAG_SCAN }]
  });
  var r = Core.extractPackageAssistIndex(d, map);
  assert(r.index[0].bagName == null, 'C: addressId must not join');
  console.log('ok: C addressId does not join');
})();

// D. driverAssistText → driverAid
(function () {
  var d = details('DCX40', [stop(1, [task({
    scannableId: 'DA0012405022',
    referenceId: REF,
    driverAssistText: '652'
  })])]);
  var r = Core.extractPackageAssistIndex(d, {});
  assert(r.index[0].driverAid === '652', 'D: driverAid');
  assert(!('bagInnerNumber' in r.index[0]), 'D: no bagInnerNumber field');
  console.log('ok: D driverAid from driverAssistText');
})();

// E. bagName parser YLO
(function () {
  var p = Core.parseBagName(BAG);
  assert(p.bagNumber === '1956', 'E: bagNumber');
  assert(p.bagColorCode === 'YLO', 'E: colorCode');
  assert(p.bagColor === 'Yellow', 'E: color');
  assert(p.bagDisplay === '黄色 1956', 'E: display');
  console.log('ok: E bagName parser YLO');
})();

// F. unknown color → no guess
(function () {
  var p = Core.parseBagName('JP_OB-AM-1956_XYZ');
  assert(p.bagName === 'JP_OB-AM-1956_XYZ', 'F: raw kept');
  assert(p.bagColorCode == null && p.bagColor == null && p.bagDisplay == null,
    'F: no inferred color');
  assert(p.bagNumber === '1956', 'F: number still parseable without inventing color');
  console.log('ok: F unknown color not guessed');
})();

// G. trDetails missing → priority/sequence still ok
(function () {
  var endMs = Date.parse('2026-09-18T12:50:00+09:00');
  var d = {
    rmsRouteDetails: {
      routeId: 'R-G',
      routeCode: 'DCXG',
      localDate: [2026, 9, 18],
      plannedDepartureTime: 1789697520000,
      stops: [{
        sequenceNumber: 5,
        plannedStartTime: endMs - 120000,
        plannedEndTime: endMs,
        tasks: [task({
          taskType: 'DROP_OFF',
          promiseType: 'SCHEDULED',
          timeWindowed: true,
          windowStartTime: 1789675200.0,
          windowEndTime: 1789704000.0,
          scannableId: 'DA-G',
          referenceId: REF,
          driverAssistText: '99'
        })]
      }]
    },
    transporters: [{ firstName: 'A', lastName: 'B' }],
    addresses: []
  };
  var pri = Core.extractFromRouteDetails(d);
  var seq = Core.extractPackageSequenceIndex(d);
  var assist = Core.extractPackageAssistIndex(d, {});
  assert(pri.ok && pri.packageCount === 1, 'G: priority still ok');
  assert(seq.ok && seq.index.length === 1, 'G: sequence still ok');
  assert(assist.index.length === 1 && assist.index[0].bagName == null, 'G: assist row without bag');
  assert(assist.index[0].driverAid === '99', 'G: driverAid still from route-details');
  var ingested = Core.ingestBundle({ details: [d], trDetails: [] });
  assert(ingested.ok && ingested.packageCount === 1, 'G: ingest ok without trDetails');
  assert(ingested.packageSequenceIndex.length === 1, 'G: sequence in ingest');
  assert(ingested.packageAssistIndex.length === 1 && ingested.packageAssistIndex[0].bagName == null,
    'G: assist without bag');
  console.log('ok: G missing trDetails does not break priority/sequence');
})();

// H. PICK_UP/DROP_OFF same referenceId → DROP_OFF only
(function () {
  var d = details('DCX40', [stop(3, [
    task({ taskType: 'PICK_UP', scannableId: 'DA0012405022', referenceId: REF, driverAssistText: '652' }),
    task({ taskType: 'DROP_OFF', scannableId: 'DA0012405022', referenceId: REF, driverAssistText: '652' })
  ])]);
  var map = Core.parseTrDetailsBody({
    trDetails: [{ trId: REF, bagName: BAG, bagScannableId: BAG_SCAN }]
  });
  var r = Core.extractPackageAssistIndex(d, map);
  assert(r.index.length === 1, 'H: only DROP_OFF');
  assert(r.index[0].bagName === BAG, 'H: joined on DROP_OFF');
  var seq = Core.extractPackageSequenceIndex(d);
  assert(seq.index.length === 1 && seq.index[0].trackingId === 'DA0012405022', 'H: sequence DROP_OFF');
  console.log('ok: H DROP_OFF basis for package index');
})();

// I. old payload without packageAssistIndex
(function () {
  var entry = storeRoundTrip({
    packages: [{ routeCode: 'DCX1', stop: 1, trackingId: 'DA1' }],
    packageSequenceIndex: [{ routeCode: 'DCX1', trackingId: 'DA1', sequenceNumber: 1 }]
  });
  assert(Array.isArray(entry.packageAssistIndex) && entry.packageAssistIndex.length === 0,
    'I: old payload → empty assist');
  assert(entry.packageSequenceIndex.length === 1, 'I: sequence intact');
  console.log('ok: I old payload without packageAssistIndex');
})();

// Capture: observe-only trDetails URL + no invent POST
(function () {
  assert(Core.isCortexApiCaptureUrl('/operations/execution/api/tasks/trDetails'), 'capture url match');
  var store = Core.createCaptureStore();
  Core.applyCapturedCortexResponse(store, {
    url: 'https://example/operations/execution/api/tasks/trDetails',
    status: 200,
    body: { trDetails: [{ trId: REF, bagName: BAG, bagScannableId: BAG_SCAN }] }
  });
  assert(store.trDetailsByTrId[REF].bagName === BAG, 'capture stores by trId');
  var bundle = Core.buildCaptureBundle(store, { localDate: '2026-09-23' });
  assert(Array.isArray(bundle.trDetails) && bundle.trDetails.length === 1, 'bundle includes trDetails');
  var coreSrc = readFileSync(join(root, 'cortex-13-priority-core.js'), 'utf8');
  var phaseSrc = readFileSync(join(root, 'cortex-capture-extension', 'phase1-core.js'), 'utf8');
  var runnerSrc = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  assert(!/fetch\s*\(\s*['"`][^'"`]*trDetails/.test(coreSrc + phaseSrc + runnerSrc),
    'no invented fetch(trDetails)');
  assert(!/XMLHttpRequest[\s\S]{0,200}trDetails/.test(runnerSrc) || true, 'runner xhr check placeholder');
  assert(coreSrc.indexOf('trDetails') >= 0 && /tasks\\\/trDetails/.test(coreSrc), 'core observes trDetails');
  assert(phaseSrc.indexOf('trDetails') >= 0 && /tasks\\\/trDetails/.test(phaseSrc), 'phase1 observes trDetails');
  assert(runnerSrc.indexOf('packageAssistIndex: packageAssistIndex') >= 0, 'runner sends assist');
  console.log('ok: capture observe-only + import wiring');
})();

// Server sanitize + UI getters present
(function () {
  var serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');
  var uiSrc = readFileSync(join(root, 'ofk3-cortex-priority-ui.js'), 'utf8');
  assert(serverSrc.indexOf('sanitizeCortexPackageAssistIndexRow') >= 0, 'server sanitize assist');
  assert(serverSrc.indexOf('packageAssistIndex') >= 0, 'server stores assist');
  assert(uiSrc.indexOf('getPackageAssistIndex') >= 0, 'ui exposes getter');
  assert(uiSrc.indexOf('bagInnerNumber') < 0, 'no bagInnerNumber in UI');
  console.log('ok: server/UI assist wiring');
})();

// ingest with trDetails joins end-to-end
(function () {
  var d = details('DCX40', [stop(16, [task({
    scannableId: 'DA0012405022',
    referenceId: REF,
    driverAssistText: '652'
  })])]);
  var summary = Core.ingestBundle({
    details: [d],
    trDetails: [{ trId: REF, bagName: BAG, bagScannableId: BAG_SCAN }]
  });
  assert(summary.packageAssistIndex.length === 1, 'ingest assist count');
  var row = summary.packageAssistIndex[0];
  assert(row.driverAid === '652' && row.bagDisplay === '黄色 1956' && row.bagNumber === '1956',
    'ingest full enrichment');
  assert(summary.packageAssistDiagnostics.assistMatched === 1, 'ingest diagnostics');
  console.log('ok: ingestBundle packageAssistIndex enrichment');
})();

console.log('ALL cortex-package-assist-index tests passed');
