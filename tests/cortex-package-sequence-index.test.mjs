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
    domainMap: opts.domainMap || (opts.scannableId ? { scannableId: opts.scannableId } : {}),
    referenceId: opts.referenceId,
    addressId: opts.addressId
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

// --- Mirror of server sanitize (contract check + roundtrip simulation) ---
function sanitizeCortexPackageSequenceIndexRow(row) {
  row = row || {};
  var seq = row.sequenceNumber == null || row.sequenceNumber === '' ? null : Number(row.sequenceNumber);
  if (seq != null && !isFinite(seq)) seq = null;
  var trackingId = String(row.trackingId || '').trim();
  var routeCode = String(row.routeCode || '').trim();
  if (!routeCode || !trackingId || seq == null) return null;
  return {
    routeCode: routeCode,
    trackingId: trackingId,
    sequenceNumber: seq
  };
}

function storeRoundTrip(body) {
  var packages = Array.isArray(body.packages) ? body.packages : [];
  var routeStops = Array.isArray(body.routeStops) ? body.routeStops : [];
  var packageSequenceIndex = Array.isArray(body.packageSequenceIndex)
    ? body.packageSequenceIndex.map(sanitizeCortexPackageSequenceIndexRow).filter(function (r) { return !!r; })
    : [];
  var entry = {
    packages: packages,
    routeStops: routeStops,
    packageSequenceIndex: packageSequenceIndex,
    stopCount: packages.length ? 1 : 0,
    packageCount: packages.length
  };
  if (!Array.isArray(entry.packageSequenceIndex)) entry.packageSequenceIndex = [];
  return entry;
}

// 1. 1 Stop / 1 DROP_OFF → 1 index
(function () {
  var d = details('DCX01', [stop(4, [task({ scannableId: 'DA-A' })])]);
  var r = Core.extractPackageSequenceIndex(d);
  assert(r.ok && r.index.length === 1, '1/1 → 1 index');
  assert(r.index[0].routeCode === 'DCX01' && r.index[0].trackingId === 'DA-A' && r.index[0].sequenceNumber === 4, '1/1 fields');
  console.log('ok: 1 stop / 1 drop_off');
})();

// 2. 1 Stop / 3 DROP_OFF → same sequenceNumber × 3
(function () {
  var d = details('DCX02', [stop(12, [
    task({ scannableId: 'DA-A' }),
    task({ scannableId: 'DA-B' }),
    task({ scannableId: 'DA-C' })
  ])]);
  var r = Core.extractPackageSequenceIndex(d);
  assert(r.index.length === 3, '3 packages same stop');
  assert(r.index.every(function (x) { return x.sequenceNumber === 12; }), 'same sequenceNumber');
  assert(r.index.map(function (x) { return x.trackingId; }).join(',') === 'DA-A,DA-B,DA-C', 'three ids');
  console.log('ok: 1 stop / 3 drop_off');
})();

// 3. non DROP_OFF excluded
(function () {
  var d = details('DCX03', [stop(1, [
    task({ taskType: 'PICK_UP', scannableId: 'DA-P' }),
    task({ scannableId: 'DA-D' })
  ])]);
  var r = Core.extractPackageSequenceIndex(d);
  assert(r.index.length === 1 && r.index[0].trackingId === 'DA-D', 'non DROP_OFF skipped');
  console.log('ok: non DROP_OFF excluded');
})();

// 4. missing trackingId excluded
(function () {
  var d = details('DCX04', [stop(2, [
    task({ domainMap: {} }),
    task({ scannableId: 'DA-OK' })
  ])]);
  var r = Core.extractPackageSequenceIndex(d);
  assert(r.index.length === 1 && r.index[0].trackingId === 'DA-OK', 'missing trackingId skipped');
  assert(r.diagnostics.skippedMissingTrackingId === 1, 'diag missing tid');
  console.log('ok: missing trackingId excluded');
})();

// 5. missing sequenceNumber excluded
(function () {
  var d = details('DCX05', [
    { sequenceNumber: null, tasks: [task({ scannableId: 'DA-X' })] },
    stop(5, [task({ scannableId: 'DA-Y' })])
  ]);
  var r = Core.extractPackageSequenceIndex(d);
  assert(r.index.length === 1 && r.index[0].trackingId === 'DA-Y', 'missing seq skipped');
  assert(r.diagnostics.skippedMissingSequence === 1, 'diag missing seq');
  console.log('ok: missing sequenceNumber excluded');
})();

// 6+7. non-13:00 and no-window packages still indexed; priority packages unchanged
(function () {
  var win13 = Date.parse('2026-09-18T13:00:00+09:00') / 1000;
  var win22 = Date.parse('2026-09-18T22:00:00+09:00') / 1000;
  var winStart = Date.parse('2026-09-18T08:00:00+09:00') / 1000;
  var plannedOk = Date.parse('2026-09-18T12:00:00+09:00');
  var d = details('DCX06', [
    stop(1, [task({
      scannableId: 'DA-13',
      timeWindowed: true,
      windowStartTime: winStart,
      windowEndTime: win13
    })]),
    stop(2, [task({
      scannableId: 'DA-22',
      timeWindowed: true,
      windowStartTime: winStart,
      windowEndTime: win22
    })]),
    stop(3, [task({
      scannableId: 'DA-NONE',
      timeWindowed: false,
      windowStartTime: null,
      windowEndTime: null
    })])
  ]);
  // plannedEnd required for priority extract — set on stops
  d.rmsRouteDetails.stops.forEach(function (s) {
    s.plannedStartTime = plannedOk - 60000;
    s.plannedEndTime = plannedOk;
  });
  d.rmsRouteDetails.localDate = [2026, 9, 18];

  var idx = Core.extractPackageSequenceIndex(d);
  assert(idx.index.length === 3, 'all DROP_OFF in index incl non-13 and no-window');
  assert(idx.index.map(function (x) { return x.trackingId; }).join(',') === 'DA-13,DA-22,DA-NONE', 'ids order');

  var pri = Core.extractFromRouteDetails(d);
  // Only exact 13:00 window + plannedEnd <= 13:00 → DA-13 only (DA-NONE has no windowEnd → excluded from priority)
  assert(pri.packageCount === 1 && pri.packages[0].trackingId === 'DA-13', 'priority still only 13:00 package');
  console.log('ok: index includes non-priority; packages unchanged');
})();

// 8+9. ingest keeps packages / routeStops semantics; adds index
(function () {
  var win13 = Date.parse('2026-09-18T13:00:00+09:00') / 1000;
  var win15 = Date.parse('2026-09-18T15:00:00+09:00') / 1000;
  var winStart = Date.parse('2026-09-18T08:00:00+09:00') / 1000;
  function seqStop(seq, windowEnd, tid) {
    return {
      sequenceNumber: seq,
      plannedStartTime: Date.parse('2026-09-18T11:00:00+09:00'),
      plannedEndTime: Date.parse('2026-09-18T12:00:00+09:00'),
      tasks: [task({
        scannableId: tid,
        windowStartTime: winStart,
        windowEndTime: windowEnd
      })]
    };
  }
  var d = details('DCX_TEST', [
    seqStop(1, win15, 'DA1'),
    seqStop(2, win13, 'DA2'),
    seqStop(3, win15, 'DA3')
  ]);
  var ingested = Core.ingestBundle({ details: [d] });
  assert(ingested.packageCount === 1, 'ingest packages still 1 (13:00 only)');
  assert(ingested.packages[0].trackingId === 'DA2', 'ingest package id');
  assert(ingested.routeStops.length === 3, 'ingest routeStops still 3');
  assert(ingested.packageSequenceIndex.length === 3, 'ingest index has all 3');
  assert(ingested.packageSequenceDiagnostics.indexCount === 3, 'diag indexCount');
  assert(ingested.packageSequenceDiagnostics.byRoute.DCX_TEST === 3, 'diag byRoute');
  assert(ingested.packageSequenceRouteCount === 1, 'route count');
  console.log('ok: ingest packages/routeStops unchanged + index');
})();

// 10. server-style POST→GET roundtrip keeps index
(function () {
  var index = [
    { routeCode: 'DCX10', trackingId: 'DA1', sequenceNumber: 4 },
    { routeCode: 'DCX10', trackingId: 'DA2', sequenceNumber: 12 }
  ];
  var entry = storeRoundTrip({
    packages: [{ routeCode: 'DCX10', stop: 4, trackingId: 'DA1' }],
    routeStops: [{ routeCode: 'DCX10', sequenceNumber: 4 }],
    packageSequenceIndex: index
  });
  assert(entry.packageSequenceIndex.length === 2, 'roundtrip keeps 2');
  assert(entry.packageSequenceIndex[1].sequenceNumber === 12, 'roundtrip seq');
  console.log('ok: store roundtrip');
})();

// 11. missing packageSequenceIndex on old payload → []
(function () {
  var entry = storeRoundTrip({
    packages: [{ routeCode: 'DCX11', stop: 1, trackingId: 'DA1' }],
    routeStops: []
  });
  assert(Array.isArray(entry.packageSequenceIndex) && entry.packageSequenceIndex.length === 0, 'old payload → []');
  console.log('ok: old payload without index');
})();

// 12. same trackingId different sequenceNumbers → both kept + conflict diagnostic
(function () {
  var d = details('DCX12', [
    stop(4, [task({ scannableId: 'DA-DUP' })]),
    stop(9, [task({ scannableId: 'DA-DUP' })])
  ]);
  var r = Core.extractPackageSequenceIndex(d);
  assert(r.index.length === 2, 'conflict keeps both rows');
  assert(r.index[0].sequenceNumber === 4 && r.index[1].sequenceNumber === 9, 'both sequences');
  assert(r.diagnostics.duplicateTrackingIdConflicts.length === 1, 'conflict recorded');
  assert(r.diagnostics.duplicateTrackingIdConflicts[0].trackingId === 'DA-DUP', 'conflict tid');
  assert(r.diagnostics.duplicateTrackingIdConflicts[0].sequenceNumbers.join(',') === '4,9', 'conflict seqs');
  console.log('ok: duplicate trackingId conflict');
})();

// Source contracts
(function () {
  var coreSrc = readFileSync(join(root, 'cortex-13-priority-core.js'), 'utf8');
  var serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');
  var runnerSrc = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
  var uiSrc = readFileSync(join(root, 'ofk3-cortex-priority-ui.js'), 'utf8');
  assert(coreSrc.indexOf('function extractPackageSequenceIndex') >= 0, 'core has extractPackageSequenceIndex');
  assert(coreSrc.indexOf('function isExact1300Clock') >= 0, '13:00 helpers remain');
  assert(serverSrc.indexOf('packageSequenceIndex') >= 0, 'server stores index');
  assert(serverSrc.indexOf('sanitizeCortexPackageSequenceIndexRow') >= 0, 'server sanitizes index');
  assert(runnerSrc.indexOf('packageSequenceIndex: packageSequenceIndex') >= 0, 'extension sends index');
  assert(uiSrc.indexOf('getPackageSequenceIndex') >= 0, 'UI exposes getter');
  assert(readFileSync(join(root, 'cortex-capture-extension', 'cortex-13-priority-core.js'), 'utf8') === coreSrc, 'extension core copy matches');
  console.log('ok: source contracts');
})();

console.log('ok cortex-package-sequence-index');
