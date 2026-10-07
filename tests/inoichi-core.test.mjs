import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './inoichi-fixtures.mjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const Core = require(join(__dirname, '..', 'inoichi-core.js'));

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
}
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok - ' + name); } catch (e) { console.error('  NOT OK - ' + name + '\n' + e.message); process.exitCode = 1; throw e; }
}
function byType(res, type) { return res.envelopes.filter(function (e) { return e.dataType === type; })[0]; }
function reasonCodes(env) { return env.diagnostics.rejectionReasons.map(function (r) { return r.code; }); }
function full(r) { return Object.assign({ referenceId: null, driverAid: null, bagName: null, bagScannableId: null, bagColorCode: null, bagColor: null, bagNumber: null, bagDisplay: null, bagStatus: null, bagSource: null }, r); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

console.log('inoichi-core tests');

// ===== Normal =====
t('(1) timeWindow normal data -> ok, all canonical fields kept, sequence joined by exact match', () => {
  const res = Core.dryRun(F.makeInput(), ['timeWindow']);
  const e = res.envelopes[0];
  eq([e.schemaVersion, e.producer, e.source, e.dataType, e.status], ['0.1', 'inoichi', 'harvest', 'timeWindow', 'ok'], 'envelope header');
  eq([e.localDate, e.capturedAt, e.collectedAt, e.normalizedAt], [F.LOCAL_DATE, '2026-10-03T00:30:00.000Z', '2026-10-03T00:40:00.000Z', F.NOW], 'times');
  assert(e.payload.rows.length === 4, '4 rows');
  const r0 = e.payload.rows[0];
  const src = F.makePackages()[0];
  Object.keys(src).forEach(function (k) { assert(r0[k] === src[k], 'field kept: ' + k); });
  assert(r0.sequenceNumber === 7, 'sequenceNumber joined');
  assert(!('sequenceNumber' in e.payload.rows[3]), 'unjoined row has no sequenceNumber');
  eq(e.diagnostics.join, { sequenceJoined: 3, sequenceUnjoined: 1, sequenceAmbiguous: 0 }, 'sequence join diag');
  eq([e.diagnostics.inputCount, e.diagnostics.normalizedCount, e.diagnostics.partialCount, e.diagnostics.rejectedCount], [4, 4, 0, 0], 'counts');
  assert(!('windowStartTime' in r0) && !('timeWindowed' in r0), 'no supplemented fields');
});

t('(2) bag normal data -> ok, 12 fields kept, stop from exact-match JOIN only', () => {
  const res = Core.dryRun(F.makeInput(), ['bag']);
  const e = res.envelopes[0];
  assert(e.status === 'ok', 'ok');
  const r0 = e.payload.rows[0];
  ['routeCode', 'trackingId', 'referenceId', 'driverAid', 'bagName', 'bagScannableId', 'bagColorCode', 'bagColor', 'bagNumber', 'bagDisplay', 'bagStatus', 'bagSource'].forEach(function (k) {
    assert(r0[k] === F.makeAssistIndex()[0][k], 'bag field kept: ' + k);
  });
  assert(r0.stop === 3 && r0.stopSource === 'packages', 'stop joined from packages');
  assert(e.payload.rows[3].stop === null && e.payload.rows[3].stopSource === null, 'unjoinable stop stays null');
  assert(e.payload.rows[4].stop === null, 'no guess JOIN for unknown trackingId');
  eq(e.diagnostics.join, { stopFromPackages: 3, stopFromSequence: 0, stopUnjoined: 2, stopAmbiguous: 0, stopConflicts: 3 }, 'stop join diag');
});

t('(3) timeWindow + bag mixed -> separate Envelopes and summary', () => {
  const res = Core.dryRun(F.makeInput());
  eq(res.envelopes.map(function (e) { return e.dataType; }), ['timeWindow', 'bag'], 'two envelopes');
  eq(res.summary.statusCounts, { ok: 2, partial: 0, rejected: 0 }, 'status counts');
  eq(res.summary.byDataType.timeWindow.inputCount, 4, 'tw input');
  eq(res.summary.byDataType.bag.inputCount, 5, 'bag input');
  eq(res.summary.ofk3Handoff, { dryRun: true, written: false, readyDataTypes: ['timeWindow', 'bag'], ready: true }, 'handoff ready, nothing written');
  assert(res.dryRun === true, 'dryRun flag');
  eq(Object.keys(res.stages), ['harvestInput', 'validation', 'normalization', 'canonicalPayload', 'ofk3HandoffReady'], 'stages');
  eq(res.stages.harvestInput.handoffReceived, ['timeWindow', 'bag'], 'handoff received');
});

t('(4) multiple routes are kept and not mixed', () => {
  const res = Core.dryRun(F.makeInput());
  const tw = byType(res, 'timeWindow');
  eq(tw.payload.rows.map(function (r) { return r.routeCode; }), ['DCX47', 'DCX47', 'DCX12', 'DCX12'], 'tw routes');
  const bag = byType(res, 'bag');
  eq(bag.payload.rows.map(function (r) { return r.routeCode; }), ['DCX47', 'DCX47', 'DCX12', 'DCX12', 'DCX12'], 'bag routes');
  // same trackingId under different Route must not JOIN
  const input = F.makeInput({
    packages: [{ routeCode: 'DCX47', routeId: 'a', stop: 5, driverName: '', trackingId: 'SAME', plannedEndTime: null, plannedEndClock: '', windowLabel: '', address: '', latitude: null, longitude: null }],
    packageSequenceIndex: [], 
    packageAssistIndex: [{ routeCode: 'DCX12', trackingId: 'SAME', bagStatus: 'captured' }]
  });
  const b = byType(Core.dryRun(input), 'bag');
  assert(b.payload.rows[0].stop === null, 'different Route does not JOIN');
});

// ===== Abnormal =====
t('(5) payload missing -> rejected payload-missing (and payload-empty for empty)', () => {
  const res = Core.dryRun(F.makeInput({ packages: null, packageAssistIndex: undefined }));
  eq(res.envelopes.map(function (e) { return e.status; }), ['rejected', 'rejected'], 'both rejected');
  assert(reasonCodes(res.envelopes[0]).indexOf('payload-missing') >= 0, 'tw payload-missing');
  assert(reasonCodes(res.envelopes[1]).indexOf('payload-missing') >= 0, 'bag payload-missing');
  assert(res.summary.ofk3Handoff.ready === false, 'not ready');
  const empty = byType(Core.dryRun(F.makeInput({ packages: [] })), 'timeWindow');
  assert(empty.status === 'rejected' && reasonCodes(empty).indexOf('payload-empty') >= 0, 'payload-empty');
});

t('(6) routeCode / trackingId missing -> row rejected, others normalized (partial)', () => {
  const pk = F.makePackages();
  pk[1].routeCode = '';
  delete pk[2].trackingId;
  const e = byType(Core.dryRun(F.makeInput({ packages: pk })), 'timeWindow');
  assert(e.status === 'partial', 'partial');
  eq([e.diagnostics.inputCount, e.diagnostics.normalizedCount, e.diagnostics.rejectedCount], [4, 2, 2], 'counts');
  assert(reasonCodes(e).indexOf('missing-routeCode') >= 0 && reasonCodes(e).indexOf('missing-trackingId') >= 0, 'reasons');
  eq(e.diagnostics.rejectedRows.map(function (r) { return r.index; }), [1, 2], 'rejected indices');
  const allBad = byType(Core.dryRun(F.makeInput({ packages: [{ routeCode: '', trackingId: 'x' }] })), 'timeWindow');
  assert(allBad.status === 'rejected' && reasonCodes(allBad).indexOf('no-valid-rows') >= 0, 'all rows invalid -> rejected');
});

t('(7) invalid dataType -> rejected, no throw', () => {
  ['foo', '', null, undefined, 5, {}, 'TIMEWINDOW'].forEach(function (dt) {
    const e = Core.transform(dt, F.makeInput());
    assert(e.status === 'rejected', 'rejected for ' + String(dt));
    assert(reasonCodes(e).indexOf('unsupported-data-type') >= 0, 'reason for ' + String(dt));
    eq(e.payload.rows, [], 'no payload');
  });
});

t('(8) unsupported schemaVersion -> rejected', () => {
  const inp = F.makeInput();
  inp.handoffRecords.timeWindow = F.makeHandoff('timeWindow', { schemaVersion: '9.9' });
  inp.handoffRecords.bag = F.makeHandoff('bag', { schemaVersion: 1 });
  const res = Core.dryRun(inp);
  eq(res.envelopes.map(function (e) { return e.status; }), ['rejected', 'rejected'], 'both rejected');
  assert(reasonCodes(res.envelopes[0]).indexOf('unsupported-schema-version') >= 0, 'reason');
  assert(res.envelopes[0].sourceMetadata.handoffSchemaVersion === '9.9', 'unsupported version kept as original info');
  const direct = Core.transform('bag', Object.assign(F.makeInput(), { schemaVersion: '2.0' }));
  assert(direct.status === 'rejected', 'input schemaVersion unsupported');
  const unconfirmed = Core.transform('bag', Object.assign(F.makeInput(), { handoffRecord: F.makeHandoff('bag', { harvestConfirmed: false }) }));
  assert(reasonCodes(unconfirmed).indexOf('handoff-not-confirmed') >= 0, 'unconfirmed handoff rejected');
  const mismatch = Core.transform('bag', Object.assign(F.makeInput(), { handoffRecord: F.makeHandoff('timeWindow') }));
  assert(reasonCodes(mismatch).indexOf('handoff-source-mismatch') >= 0, 'source mismatch rejected');
});

t('(9) captured_null is success; not_attempted distinguished; failures preserved; 14 states not collapsed', () => {
  const all = ['captured', 'captured_null', 'not_attempted', 'dom_not_found', 'dom_ambiguous', 'click_failed', 'timeout', 'stop_not_found',
    'stop_ambiguous', 'stop_expand_failed', 'package_dom_not_found', 'package_click_target_not_found', 'route_aborted', 'ui_blocked'];
  assert(all.length === 14, '14 statuses');
  const rows = all.map(function (s, i) { return full({ routeCode: 'DCX47', trackingId: 'T' + i, bagStatus: s, bagSource: s === 'not_attempted' ? null : 'trDetails' }); });
  const e = byType(Core.dryRun(F.makeInput({ packageAssistIndex: rows })), 'bag');
  assert(e.status === 'ok', 'failure states do not make the Envelope partial');
  eq(e.payload.rows.map(function (r) { return r.bagStatus; }), all, 'bagStatus preserved as-is');
  const cls = {}; e.payload.rows.forEach(function (r) { cls[r.bagStatus] = r.bagStatusClass; });
  assert(cls.captured === 'success' && cls.captured_null === 'success', 'captured/captured_null success');
  assert(cls.not_attempted === 'not-attempted', 'not_attempted distinct');
  all.slice(3).forEach(function (s) { assert(cls[s] === 'failure', s + ' failure'); });
  eq(e.diagnostics.bagClassCounts, { success: 2, 'not-attempted': 1, failure: 11 }, 'class counts');
  Object.keys(e.diagnostics.bagStatusCounts).forEach(function (k) { assert(e.diagnostics.bagStatusCounts[k] === 1, 'per-status count ' + k); });
  const cn = byType(Core.dryRun(F.makeInput()), 'bag').payload.rows[1];
  assert(cn.bagStatus === 'captured_null' && cn.bagName === null && cn.bagStatusClass === 'success', 'captured_null row normal, bagName null kept');
});

t('(9b) legacy bagStatus:null stays legacy (not converted)', () => {
  const rows = [full({ routeCode: 'DCX47', trackingId: 'L1', bagName: 'OLD', bagDisplay: 'OLD', bagStatus: null, bagSource: null }),
    full({ routeCode: 'DCX47', trackingId: 'L2', bagStatus: 'captured', bagSource: 'trDetails' })];
  const e = byType(Core.dryRun(F.makeInput({ packageAssistIndex: rows })), 'bag');
  assert(e.status === 'ok', 'legacy row is not an error');
  const r = e.payload.rows[0];
  assert(r.bagStatus === null && r.bagStatusClass === 'legacy' && r.bagName === 'OLD', 'legacy kept as null/legacy');
  eq([e.diagnostics.legacyBagStatusCount, e.diagnostics.bagStatusNullDistinguishable], [1, false], 'legacy diag');
  assert(e.diagnostics.bagStatusCounts['(null)'] === 1, 'null counted separately');
  // unknown status string: not guessed, flagged partial, value preserved
  const u = byType(Core.dryRun(F.makeInput({ packageAssistIndex: [full({ routeCode: 'A', trackingId: 'B', bagStatus: 'weird' })] })), 'bag');
  assert(u.status === 'partial' && u.payload.rows[0].bagStatus === 'weird' && u.payload.rows[0].bagStatusClass === 'unknown', 'unknown status flagged, kept');
});

t('(10) HARVEST diagnostics / handoff metadata preserved as original info', () => {
  const inp = F.makeInput();
  inp.harvestStates.bag = F.makeHarvestState('bag', { status: 'partial', counts: { success: 3, failure: 2, total: 5 }, errors: [{ code: 'x', message: 'm', count: 2 }] });
  const e = byType(Core.dryRun(inp), 'bag');
  assert(e.status === 'ok', 'INOICHI status independent from harvest partial');
  const m = e.sourceMetadata;
  eq([m.harvestCollectorId, m.harvestStatus, m.harvestConfirmed, m.handoffSchemaVersion, m.entrySource],
    ['bag', 'partial', true, '0.1', 'cortex-capture-extension'], 'metadata');
  eq(m.harvestCounts, { success: 3, failure: 2, total: 5 }, 'harvest counts');
  eq(m.harvestErrors, [{ code: 'x', message: 'm', count: 2 }], 'harvest errors');
  eq(m.payloadReference, F.makeHandoff('bag').payloadReference, 'payloadReference kept');
});

t('(10b) getter source diagnostics kept whole (byRoute etc.), unmodified, not mixed with INOICHI diagnostics', () => {
  const inp = F.makeInput();
  const assistBefore = clone(inp.packageAssistDiagnostics);
  const seqBefore = clone(inp.packageSequenceDiagnostics);
  const res = Core.dryRun(inp);
  const bag = byType(res, 'bag');
  const tw = byType(res, 'timeWindow');
  eq(bag.sourceDiagnostics.packageAssistDiagnostics, assistBefore, 'assist diagnostics identical');
  eq(bag.sourceDiagnostics.packageSequenceDiagnostics, seqBefore, 'sequence diagnostics identical');
  eq(tw.sourceDiagnostics.packageSequenceDiagnostics, seqBefore, 'tw sequence diagnostics identical');
  eq(bag.sourceDiagnostics.packageAssistDiagnostics.byRoute, assistBefore.byRoute, 'byRoute kept');
  eq(bag.sourceDiagnostics.packageSequenceRouteCount, 2, 'sequenceRouteCount kept');
  eq(inp.packageAssistDiagnostics, assistBefore, 'input not mutated (assist diag)');
  eq(inp.packageSequenceDiagnostics, seqBefore, 'input not mutated (seq diag)');
  eq(inp.packages, F.makePackages(), 'input packages not mutated');
  eq(inp.packageAssistIndex, F.makeAssistIndex(), 'input assist not mutated');
  assert(!('byRoute' in bag.diagnostics), 'INOICHI diagnostics does not overwrite source');
  assert(bag.sourceDiagnostics.packageAssistDiagnostics !== inp.packageAssistDiagnostics, 'cloned, not shared reference');
  // missing source diagnostics: recorded
  const noDiag = byType(Core.dryRun(F.makeInput({ packageAssistDiagnostics: null, packageSequenceDiagnostics: null })), 'bag');
  assert(noDiag.sourceDiagnostics.packageAssistDiagnostics === null, 'null kept as null');
  assert(noDiag.diagnostics.missingInputs.indexOf('packageAssistDiagnostics') >= 0, 'missing recorded');
});

t('(11) some good / some bad rows -> partial (missing field, invalid type, non-object row)', () => {
  const pk = F.makePackages();
  delete pk[0].address;
  pk[1].stop = 'three';
  pk.push(null);
  pk.push('junk');
  const e = byType(Core.dryRun(F.makeInput({ packages: pk })), 'timeWindow');
  assert(e.status === 'partial', 'partial');
  eq([e.diagnostics.inputCount, e.diagnostics.normalizedCount, e.diagnostics.partialCount, e.diagnostics.rejectedCount], [6, 4, 2, 2], 'counts');
  assert(e.payload.rows[0].address === '', 'absent string -> empty (recorded)');
  assert(e.payload.rows[1].stop === 'three', 'invalid value not coerced');
  eq(e.diagnostics.missingFields, [{ field: 'address', count: 1 }], 'missingFields');
  eq(e.diagnostics.invalidFields, [{ field: 'stop', count: 1 }], 'invalidFields');
  assert(reasonCodes(e).indexOf('row-not-object') >= 0, 'row-not-object');
});

t('(12) empty / malformed input never throws and is rejected', () => {
  const inputs = [undefined, null, {}, [], 'str', 42, true, { packages: 'x', packageAssistIndex: {} }, { packages: [[]], packageAssistIndex: [1, 2] }];
  inputs.forEach(function (inp) {
    const r = Core.dryRun(inp);
    assert(r.envelopes.length === 2, 'two envelopes for ' + JSON.stringify(inp));
    r.envelopes.forEach(function (e) { assert(e.status === 'rejected', 'rejected for ' + JSON.stringify(inp)); assert(e.schemaVersion === '0.1' && e.producer === 'inoichi', 'shape intact'); });
    assert(r.summary.ofk3Handoff.ready === false, 'not ready');
    Core.transform('timeWindow', inp); Core.transform('bag', inp);
  });
  assert(reasonCodes(Core.transform('bag', null)).indexOf('input-not-object') >= 0, 'input-not-object');
  const weird = { packages: [{ routeCode: 'A', trackingId: 'B', stop: { x: 1 }, latitude: NaN }], now: 12345, entry: 'oops', handoffRecord: 'bad' };
  assert(Core.transform('timeWindow', weird).status === 'rejected', 'bad handoffRecord type rejected');
  const nowFn = Core.transform('timeWindow', Object.assign(F.makeInput(), { now: function () { throw new Error('boom'); } }));
  assert(typeof nowFn.normalizedAt === 'string', 'throwing now() falls back');
});

// ===== Additional =====
t('capturedAt / localDate absence recorded in diagnostics, not guessed', () => {
  const e = byType(Core.dryRun(F.makeInput({ entry: null, harvestStates: {}, handoffRecords: {} }), ['timeWindow']), 'timeWindow');
  assert(e.capturedAt === null && e.collectedAt === null, 'null');
  assert(e.localDate === null, 'localDate null without entry/payloadReference');
  assert(e.diagnostics.notes.indexOf('capturedAt-unavailable') >= 0, 'note');
  assert(e.diagnostics.missingInputs.indexOf('entry') >= 0 && e.diagnostics.missingInputs.indexOf('handoffRecord') >= 0, 'missing inputs');
  assert(e.status === 'ok', 'rows themselves fine');
});

t('bag stop: packageSequenceIndex fallback, package priority on conflict, ambiguity -> null', () => {
  const pk = [
    { routeCode: 'R', routeId: '', stop: null, driverName: '', trackingId: 'A', plannedEndTime: null, plannedEndClock: '', windowLabel: '', address: '', latitude: null, longitude: null },
    { routeCode: 'R', routeId: '', stop: 2, driverName: '', trackingId: 'B', plannedEndTime: null, plannedEndClock: '', windowLabel: '', address: '', latitude: null, longitude: null },
    { routeCode: 'R', routeId: '', stop: 5, driverName: '', trackingId: 'C', plannedEndTime: null, plannedEndClock: '', windowLabel: '', address: '', latitude: null, longitude: null },
    { routeCode: 'R', routeId: '', stop: 6, driverName: '', trackingId: 'C', plannedEndTime: null, plannedEndClock: '', windowLabel: '', address: '', latitude: null, longitude: null }
  ];
  const seq = [{ routeCode: 'R', trackingId: 'A', sequenceNumber: 11 }, { routeCode: 'R', trackingId: 'B', sequenceNumber: 99 }];
  const assist = ['A', 'B', 'C'].map(function (id) { return full({ routeCode: 'R', trackingId: id, bagStatus: 'captured' }); });
  const e = byType(Core.dryRun(F.makeInput({ packages: pk, packageSequenceIndex: seq, packageAssistIndex: assist })), 'bag');
  eq(e.payload.rows.map(function (r) { return [r.stop, r.stopSource]; }), [[11, 'packageSequenceIndex'], [2, 'packages'], [null, null]], 'stop resolution');
  eq(e.diagnostics.join, { stopFromPackages: 1, stopFromSequence: 1, stopUnjoined: 0, stopAmbiguous: 1, stopConflicts: 1 }, 'join diag');
});

t('duplicate keys are kept and counted (no dedupe/no judgement)', () => {
  const pk = F.makePackages(); pk.push(clone(pk[0]));
  const e = byType(Core.dryRun(F.makeInput({ packages: pk })), 'timeWindow');
  assert(e.payload.rows.length === 5 && e.diagnostics.duplicateKeyCount === 1, 'kept + counted');
});

t('readInput reads via getters, survives throwing / missing getters', () => {
  const inp = F.makeInput();
  const api = F.makeFakeApi(inp);
  const hub = {
    getState: function (id) { return F.makeHarvestState(id); },
    getLastHandoff: function (id) { return F.makeHandoff(id); }
  };
  const got = Core.readInput(api, { hub: hub, now: F.NOW });
  assert(got.packages.length === 4 && got.packageAssistIndex.length === 5 && got.getterErrors.length === 0, 'read ok');
  const res = Core.dryRun(got);
  eq(res.summary.statusCounts, { ok: 2, partial: 0, rejected: 0 }, 'end-to-end ok');
  assert(byType(res, 'bag').sourceMetadata.harvestConfirmed === true, 'hub handoff applied');
  // event-recorded handoff wins over hub
  const got2 = Core.readInput(api, { hub: hub, handoffRecords: { bag: F.makeHandoff('bag', { confirmedAt: 'EVENT' }) } });
  assert(got2.handoffRecords.bag.confirmedAt === 'EVENT', 'event handoff preferred');

  const bad = { getEntry: function () { throw new Error('x'); }, getPackages: function () { throw new Error('y'); } };
  const g3 = Core.readInput(bad, {});
  assert(g3.getterErrors.length >= 2 && g3.entry === null && g3.packages === null, 'getter exceptions captured');
  const r3 = Core.dryRun(g3);
  assert(r3.envelopes.every(function (e) { return e.status === 'rejected'; }), 'rejected, no throw');
  assert(byType(r3, 'timeWindow').diagnostics.getterErrors.length >= 2, 'getterErrors in diagnostics');
  const g4 = Core.readInput(null, null);
  assert(g4.getterErrors[0].message === 'api-missing', 'api missing noted');
  assert(Core.dryRun(g4).envelopes.length === 2, 'no throw without api');
  const g5 = Core.readInput(api, { hub: { getState: function () { throw new Error('h'); }, getLastHandoff: function () { throw new Error('h'); } } });
  assert(g5.handoffRecords.bag === null && g5.harvestStates.bag === null, 'throwing hub tolerated');
});

t('Envelope key set is the fixed canonical schema', () => {
  const e = byType(Core.dryRun(F.makeInput()), 'bag');
  eq(Object.keys(e), ['schemaVersion', 'producer', 'source', 'dataType', 'localDate', 'capturedAt', 'collectedAt', 'normalizedAt', 'status', 'sourceMetadata', 'payload', 'sourceDiagnostics', 'diagnostics'], 'keys');
  eq(Object.keys(e.sourceMetadata), ['entrySource', 'harvestCollectorId', 'harvestStatus', 'harvestCounts', 'harvestErrors', 'handoffSchemaVersion', 'harvestConfirmed', 'handoffConfirmedAt', 'payloadReference'], 'sourceMetadata keys');
  assert(Core.SCHEMA_VERSION === '0.1' && typeof Core.SCHEMA_VERSION === 'string', 'string schemaVersion');
  assert(Core.HANDOFF_EVENT === 'harvest:handoff', 'event name');
  assert(Core.classifyBagStatus(undefined) === 'unknown' && Core.classifyBagStatus(null) === 'legacy', 'classify');
});

t('no business judgement fields in output', () => {
  const s = JSON.stringify(Core.dryRun(F.makeInput()));
  ['risk', 'danger', 'late', 'warning', 'recommend', 'fix', 'severity', 'score'].forEach(function (w) {
    assert(!new RegExp('"' + w + '[A-Za-z]*"', 'i').test(s), 'no key like ' + w);
  });
});

console.log('inoichi-core tests passed (' + passed + ' tests)');
