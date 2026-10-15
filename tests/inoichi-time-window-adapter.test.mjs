import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './inoichi-fixtures.mjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const Core = require(join(root, 'inoichi-core.js'));
const Adapter = require(join(root, 'inoichi-time-window-adapter.js'));
const Detect = require(join(root, 'inoichi-detection-core.js'));
const Rules = require(join(root, 'inoichi-detection-rules.js'));

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
}
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok - ' + name); } catch (e) { console.error('  NOT OK - ' + name + '\n' + e.message); process.exitCode = 1; throw e; }
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function codes(out) { return out.issues.map(function (i) { return i.code; }); }
function levelOf(out, code) { const i = out.issues.filter(function (x) { return x.code === code; })[0]; return i ? i.level : null; }

// F.NOW = 01:00Z, entry.receivedAt = 00:30Z -> age exactly 30 min.
const NOW = F.NOW;
// dryRun resolves handoffRecords/harvestStates per dataType (same path as the real P0 flow).
function envOfInput(input, type) { return Core.dryRun(input, [type || 'timeWindow']).envelopes[0]; }
function envOf(overrides) { return envOfInput(F.makeInput(overrides)); }
function adapt(env, opts) { return Adapter.adaptTimeWindow(env, Object.assign({ now: NOW }, opts || {})); }

console.log('inoichi-time-window-adapter tests');

t('(1) normal data -> evaluable, no issues, fresh at the 30 min boundary, deliveryStatus not-available', () => {
  const env = envOf();
  eq(env.status, 'ok', 'precondition: P0 envelope ok');
  const out = adapt(env);
  eq([out.inputType, out.dataType, out.schemaVersion], ['time-window-canonical', 'timeWindow', '0.1'], 'header');
  eq([out.evaluable, out.issueCount, out.blockingCount, out.warningCount], [true, 0, 0, 0], 'no issues');
  eq([out.freshness.state, out.freshness.ageMinutes, out.freshness.thresholdMinutes], ['fresh', 30, 30], 'freshness');
  eq([out.localDate, out.dateCheck, out.harvestStatus, out.envelopeStatus, out.rowCount], [F.LOCAL_DATE, 'not-checked', 'ok', 'ok', 4], 'carry-over');
  eq(out.unknowns, { deliveryStatus: 'not-available' }, 'no delivery status guessed');
  eq(out.notEvaluableReasons, [], 'no reasons');
});

t('(2) within threshold -> fresh', () => {
  const out = adapt(envOf(), { now: '2026-10-03T00:45:00.000Z' });
  eq([out.freshness.state, out.freshness.ageMinutes, out.issueCount], ['fresh', 15, 0], 'fresh');
});

t('(3) over threshold -> refetch-recommended (warning, still evaluable, not lateness)', () => {
  const out = adapt(envOf(), { now: '2026-10-03T01:00:01.000Z' });
  eq(out.freshness.state, 'refetch-recommended', 'state');
  assert(out.freshness.ageMinutes > 30, 'age > 30');
  eq([out.evaluable, out.blockingCount, out.warningCount], [true, 0, 1], 'warning only');
  eq(codes(out), ['refetch-recommended'], 'code');
  assert(codes(out).every(function (c) { return !/late|delay|overdue/.test(c); }), 'no lateness wording');
});

t('(4) threshold is configurable; invalid threshold is blocking', () => {
  const env = envOf();
  eq(adapt(env, { freshnessThresholdMinutes: 10 }).freshness.state, 'refetch-recommended', '10 min threshold');
  eq(adapt(env, { freshnessThresholdMinutes: 60 }).freshness.state, 'fresh', '60 min threshold');
  eq(adapt(env, { freshnessThresholdMinutes: 60 }).freshness.thresholdMinutes, 60, 'threshold echoed');
  [0, -5, 'abc', NaN].forEach(function (bad) {
    const out = adapt(env, { freshnessThresholdMinutes: bad });
    eq([out.evaluable, levelOf(out, 'threshold-invalid')], [false, 'blocking'], 'invalid threshold ' + String(bad));
  });
});

t('(5) opts.now is required: missing/invalid -> blocking, never reads the clock', () => {
  const env = envOf();
  const a = Adapter.adaptTimeWindow(env, {});
  eq([a.evaluable, levelOf(a, 'now-missing'), a.freshness.state, a.now], [false, 'blocking', 'not-evaluated', null], 'missing');
  const b = Adapter.adaptTimeWindow(env, { now: 'not-a-date' });
  eq([b.evaluable, levelOf(b, 'now-invalid')], [false, 'blocking'], 'invalid');
  const c = Adapter.adaptTimeWindow(env);
  eq(levelOf(c, 'now-missing'), 'blocking', 'no opts at all');
  const d = Adapter.adaptTimeWindow(env, { now: function () { return NOW; } });
  eq(d.freshness.state, 'fresh', 'now as function');
});

t('(6) capturedAt missing -> freshness unknown (warning), not fresh and not an error', () => {
  const env = envOf({ entry: Object.assign(F.makeEntry(), { receivedAt: null }) });
  eq(env.capturedAt, null, 'precondition');
  const out = adapt(env);
  eq([out.freshness.state, out.freshness.ageMinutes, out.evaluable], ['unknown', null, true], 'unknown');
  eq(levelOf(out, 'captured-at-unknown'), 'warning', 'warning');
});

t('(7) capturedAt in the future / unparsable -> time anomaly (blocking)', () => {
  const env = envOf();
  const fut = adapt(env, { now: '2026-10-03T00:00:00.000Z' });
  eq([fut.freshness.state, fut.evaluable, levelOf(fut, 'captured-at-in-future'), fut.freshness.ageMinutes], ['anomaly', false, 'blocking', null], 'future');
  const bad = clone(env); bad.capturedAt = 'garbage';
  const inv = adapt(bad);
  eq([inv.freshness.state, inv.evaluable, levelOf(inv, 'captured-at-invalid')], ['anomaly', false, 'blocking'], 'invalid');
});

t('(8) localDate missing -> date unknown (warning without target, blocking with target); never guessed', () => {
  const env = envOf({ entry: Object.assign(F.makeEntry(), { localDate: '' }), handoffRecords: { timeWindow: F.makeHandoff('timeWindow', { payloadReference: null }) } });
  eq(env.localDate, null, 'precondition');
  const a = adapt(env);
  eq([a.dateCheck, a.localDate, levelOf(a, 'local-date-unknown'), a.evaluable], ['unknown', null, 'warning', true], 'no target');
  const b = adapt(env, { targetLocalDate: F.LOCAL_DATE });
  eq([b.dateCheck, levelOf(b, 'local-date-unknown'), b.evaluable], ['unknown', 'blocking', false], 'with target');
});

t('(9) localDate vs explicit target: match / mismatch; no target -> no date judgement', () => {
  const env = envOf();
  eq(adapt(env, { targetLocalDate: F.LOCAL_DATE }).dateCheck, 'match', 'match');
  const mm = adapt(env, { targetLocalDate: '2026-10-04' });
  eq([mm.dateCheck, mm.evaluable, levelOf(mm, 'local-date-mismatch')], ['mismatch', false, 'blocking'], 'mismatch');
  eq(adapt(env, { now: '2030-01-01T00:00:00.000Z' }).dateCheck, 'not-checked', 'far-future now alone does not judge the date');
  const badTarget = adapt(env, { targetLocalDate: '10/03/2026' });
  eq(levelOf(badTarget, 'target-date-invalid'), 'blocking', 'invalid target');
  const badDate = clone(env); badDate.localDate = '2026/10/03';
  eq(levelOf(adapt(badDate), 'local-date-invalid'), 'blocking', 'invalid localDate');
});

t('(10) HARVEST partial -> distinguished warning (evaluable); envelope partial reported separately', () => {
  const env = envOf({ harvestStates: { timeWindow: F.makeHarvestState('timeWindow', { status: 'partial' }), bag: F.makeHarvestState('bag') } });
  const out = adapt(env);
  eq(out.harvestStatus, 'partial', 'status carried');
  eq([levelOf(out, 'harvest-partial'), out.evaluable], ['warning', true], 'warning');
  const pk = F.makePackages(); pk[3].routeCode = '';
  const env2 = envOfInput(F.makeInput({ packages: pk }));
  eq(env2.status, 'partial', 'precondition: P0 partial');
  const out2 = adapt(env2);
  eq([levelOf(out2, 'envelope-partial'), out2.evaluable, out2.rejectedCount], ['warning', true, 1], 'row-level partial');
});

t('(11) HARVEST stale -> blocking, distinguished from ok/partial', () => {
  const env = envOf({ harvestStates: { timeWindow: F.makeHarvestState('timeWindow', { status: 'stale' }), bag: F.makeHarvestState('bag') } });
  const out = adapt(env);
  eq([levelOf(out, 'harvest-stale'), out.evaluable, out.harvestStatus], ['blocking', false, 'stale'], 'stale');
  assert(codes(out).indexOf('harvest-partial') < 0, 'not conflated with partial');
});

t('(12) HARVEST error / not-ready / unknown status handled safely when given', () => {
  function withStatus(s) {
    return adapt(envOf({ harvestStates: { timeWindow: F.makeHarvestState('timeWindow', { status: s }), bag: F.makeHarvestState('bag') } }));
  }
  eq([levelOf(withStatus('error'), 'harvest-error'), withStatus('error').evaluable], ['blocking', false], 'error');
  ['idle', 'awaiting-data', 'checking'].forEach(function (s) {
    eq([levelOf(withStatus(s), 'harvest-not-ready'), withStatus(s).evaluable], ['blocking', false], s);
  });
  eq(levelOf(withStatus('weird'), 'harvest-status-unrecognized'), 'warning', 'unrecognized');
  const noState = clone(envOf()); noState.sourceMetadata.harvestStatus = null;
  eq(levelOf(adapt(noState), 'harvest-status-unknown'), 'warning', 'null status');
});

t('(13) zero rows -> blocking (not-evaluable) but quality still diagnosed', () => {
  const env = envOfInput(F.makeInput({ packages: [] }));
  eq(env.status, 'rejected', 'precondition');
  const out = adapt(env);
  eq([out.evaluable, out.rowCount], [false, 0], 'not evaluable');
  assert(codes(out).indexOf('no-valid-rows') >= 0 && codes(out).indexOf('envelope-rejected') >= 0, 'reasons reported');
  assert(out.notEvaluableReasons.indexOf('payload-empty') >= 0, 'P0 rejection reason carried');
  eq(out.freshness.state, 'fresh', 'freshness still diagnosed when not evaluable');
});

t('(14) schemaVersion mismatch -> blocking', () => {
  const env = envOfInput(F.makeInput({ handoffRecords: { timeWindow: F.makeHandoff('timeWindow', { schemaVersion: '9.9' }), bag: F.makeHandoff('bag') } }));
  const out = adapt(env);
  eq([out.evaluable, levelOf(out, 'unsupported-schema-version')], [false, 'blocking'], 'handoff schema');
  const e2 = clone(envOf()); e2.schemaVersion = '2.0';
  eq(levelOf(adapt(e2), 'unsupported-envelope-schema'), 'blocking', 'envelope schema');
  const e3 = clone(envOf()); e3.sourceMetadata.handoffSchemaVersion = null;
  eq(levelOf(adapt(e3), 'handoff-schema-missing'), 'blocking', 'schema missing');
});

t('(15) source mismatch / wrong dataType / unconfirmed handoff -> blocking', () => {
  const env = envOfInput(F.makeInput({ handoffRecords: { timeWindow: F.makeHandoff('bag'), bag: F.makeHandoff('bag') } }));
  const out = adapt(env);
  eq([out.evaluable, levelOf(out, 'handoff-source-mismatch')], [false, 'blocking'], 'source mismatch');
  const bagEnv = envOfInput(F.makeInput(), 'bag');
  eq(levelOf(adapt(bagEnv), 'unsupported-data-type'), 'blocking', 'bag envelope refused');
  const unconf = envOfInput(F.makeInput({ handoffRecords: { timeWindow: F.makeHandoff('timeWindow', { harvestConfirmed: false }), bag: F.makeHandoff('bag') } }));
  eq(levelOf(adapt(unconf), 'handoff-not-confirmed'), 'blocking', 'unconfirmed');
});

t('(16) duplicate tracking keys -> warning, counted, not dropped', () => {
  const pk = F.makePackages(); pk.push(Object.assign({}, pk[0]));
  const env = envOfInput(F.makeInput({ packages: pk }));
  assert(env.diagnostics.duplicateKeyCount > 0, 'precondition: P0 counts duplicates');
  const out = adapt(env);
  eq([levelOf(out, 'duplicate-keys'), out.evaluable, out.rowCount], ['warning', true, 5], 'duplicate warning');
});

t('(17) malformed envelope never throws and is not evaluable', () => {
  [null, undefined, 42, 'x', [], {}].forEach(function (bad) {
    const out = adapt(bad);
    eq(out.evaluable, false, 'not evaluable: ' + JSON.stringify(bad));
    assert(out.issueCount > 0 && out.rowCount === 0, 'issues reported');
  });
  eq(levelOf(adapt(null), 'envelope-invalid'), 'blocking', 'envelope-invalid');
});

t('(18) blocking and warning are kept apart; counts are consistent', () => {
  const env = envOf({ harvestStates: { timeWindow: F.makeHarvestState('timeWindow', { status: 'partial' }), bag: F.makeHarvestState('bag') } });
  const out = adapt(env, { now: '2026-10-03T02:00:00.000Z', targetLocalDate: '2026-10-09' });
  eq(out.issueCount, out.blockingCount + out.warningCount, 'counts');
  eq(out.notEvaluableReasons, out.issues.filter(function (i) { return i.level === 'blocking'; }).map(function (i) { return i.code; }), 'reasons == blocking codes');
  eq([levelOf(out, 'harvest-partial'), levelOf(out, 'refetch-recommended'), levelOf(out, 'local-date-mismatch')], ['warning', 'warning', 'blocking'], 'levels');
  eq(new Set(codes(out)).size, codes(out).length, 'no duplicate codes');
});

t('(19) pure: envelope not mutated, same input -> same output, no side effects', () => {
  const env = envOf();
  const before = JSON.stringify(env);
  const a = adapt(env); const b = adapt(env);
  eq(JSON.stringify(env), before, 'envelope unchanged');
  eq(a, b, 'deterministic');
  const src = readFileSync(join(root, 'inoichi-time-window-adapter.js'), 'utf8');
  ['fetch(', 'XMLHttpRequest', 'require(', 'localStorage', 'sessionStorage', 'writeFile', 'Date.now', 'new Date()', 'setTimeout', 'setInterval', 'window.', 'document.', 'OFK3Cortex13', 'dispatchEvent'].forEach(function (needle) {
    assert(src.indexOf(needle) < 0, 'adapter source must not contain ' + needle);
  });
});

// ---------- rule + engine integration ----------
function rule() { const r = Rules.getTimeWindowDataFreshnessRule(); r.enabled = true; return r; }

t('(20) rule is defined, disabled by default, valid, and not in DEFAULT_RULES', () => {
  const r = Rules.getTimeWindowDataFreshnessRule();
  eq([r.ruleId, r.inputType, r.category, r.enabled], ['time-window-data-freshness-v1', 'time-window-canonical', 'data-quality', false], 'definition');
  eq(Detect.validateRule(r).ok, true, 'valid');
  eq(Rules.DEFAULT_RULES.length, 0, 'DEFAULT_RULES stays empty');
  eq(Rules.getSampleFleetCapacityRule().enabled, false, 'fleet sample still disabled');
  const disabled = Detect.detect(adapt(envOf(), { now: '2026-10-03T03:00:00.000Z' }), [r], { now: NOW });
  eq(disabled.alerts.length, 0, 'disabled rule never fires');
});

t('(21) healthy data -> no alert; warnings -> info alert; blocking -> warning alert', () => {
  const none = Detect.detect(adapt(envOf()), [rule()], { now: NOW });
  eq([none.alerts.length, none.diagnostics.errors.length], [0, 0], 'no alert');
  const warn = Detect.detect(adapt(envOf(), { now: '2026-10-03T02:00:00.000Z' }), [rule()], { now: NOW });
  eq([warn.alerts.length, warn.alerts[0].severity, warn.alerts[0].ruleId, warn.alerts[0].category], [1, 'info', 'time-window-data-freshness-v1', 'data-quality'], 'info');
  const block = Detect.detect(adapt(envOf(), { targetLocalDate: '2026-10-09' }), [rule()], { now: NOW });
  eq([block.alerts.length, block.alerts[0].severity], [1, 'warning'], 'warning');
  assert(block.alerts[0].summary.indexOf('配送遅延の判定ではありません') >= 0, 'summary states it is not lateness');
  eq(block.alerts[0].status, 'detected', 'detected');
});

t('(22) same condition re-detected -> deduplicated (no repeat alert); recovery -> resolved', () => {
  const stale = adapt(envOf(), { now: '2026-10-03T02:00:00.000Z' });
  const first = Detect.detect(stale, [rule()], { now: NOW });
  const again = Detect.detect(stale, [rule()], { now: NOW, existingAlerts: first.alerts });
  eq(again.alerts.length, 1, 'still one alert');
  eq(again.alerts[0].alertId, first.alerts[0].alertId, 'same alertId');
  eq(again.diagnostics.created, 0, 'nothing created');
  const healed = Detect.detect(adapt(envOf()), [rule()], { now: NOW, existingAlerts: again.alerts });
  eq(healed.alerts[0].status, 'resolved', 'resolved when quality recovers');
});

t('(23) compatibility: fleet rule and time-window rule ignore each other\'s input', () => {
  const fleetRule = Rules.getSampleFleetCapacityRule(); fleetRule.enabled = true;
  const twInput = adapt(envOf(), { now: '2026-10-03T02:00:00.000Z' });
  const r1 = Detect.detect(twInput, [fleetRule, rule()], { now: NOW });
  eq(r1.alerts.map(function (a) { return a.ruleId; }), ['time-window-data-freshness-v1'], 'only time-window rule fires on time-window input');
  eq(r1.diagnostics.errors.length, 0, 'no engine errors');
  const fleetInput = { inputType: 'fleet-capacity-canonical', localDate: '2026-10-07', block: '8B', hours: 8, expected: 22, actual: 20 };
  const r2 = Detect.detect(fleetInput, [fleetRule, rule()], { now: NOW });
  eq(r2.alerts.map(function (a) { return a.ruleId; }), ['fleet-capacity-shortage-v1'], 'only fleet rule fires on fleet input');
  eq(Detect.buildDeduplicationKey(rule(), twInput), 'time-window-data-freshness-v1|' + F.LOCAL_DATE + '|', 'dedup key scoped by rule+date');
});

t('(24) P0 envelope contract unchanged by the adapter work', () => {
  const env = envOf();
  eq(Object.keys(env).sort(), ['capturedAt', 'collectedAt', 'dataType', 'diagnostics', 'localDate', 'normalizedAt', 'payload', 'producer', 'schemaVersion', 'source', 'sourceDiagnostics', 'sourceMetadata', 'status'], 'envelope keys');
  eq(Core.SCHEMA_VERSION, '0.1', 'schema version');
  eq(Core.SUPPORTED_INPUT_SCHEMA_VERSIONS, ['0.1'], 'HARVEST handoff schema v0.1 only');
});

console.log('inoichi-time-window-adapter tests passed (' + passed + ' tests)');
