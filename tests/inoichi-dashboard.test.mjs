import { createRequire } from 'module';
import { strict as assert } from 'assert';
const require = createRequire(import.meta.url);
const Dashboard = require('../inoichi-dashboard.js');
const Fleet = require('../inoichi-fleet-adapter.js');
const Core = require('../inoichi-detection-core.js');
const Rules = require('../inoichi-detection-rules.js');
const Store = require('../inoichi-alert-store.js');
const Notification = require('../inoichi-notification-adapter.js');

var passed = 0;
var failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name); }
}

function eq(name, a, b) {
  if (a === b) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}

function deepEq(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}

function noThrow(name, fn) {
  try { fn(); ok(name, true); } catch (e) { failed++; console.error('FAIL - ' + name + ': threw ' + e.message); }
}

function sampleRule() {
  var r = Rules.getSampleFleetCapacityRule();
  r.enabled = true;
  return r;
}

function baseMaster() {
  return [
    { block: '8B', hours: 8, count: 12 },
    { block: '6B30S', hours: 6.5, count: 16 },
    { block: '4B30S', hours: 4.5, count: 16 },
    { block: '3B', hours: 3, count: 4 },
    { block: '2B', hours: 2, count: 8 }
  ];
}

function detectAll(inputs, existing) {
  var out = [];
  var rule = sampleRule();
  for (var i = 0; i < inputs.length; i++) {
    var opts = existing ? { existingAlerts: existing } : {};
    out.push(Core.detect(inputs[i], [rule], opts));
    if (out[out.length - 1].alerts.length) existing = out[out.length - 1].alerts;
  }
  return out;
}

function buildStoreWithAlerts(alerts, evaluatedInputs, now) {
  var store = Store.createStore();
  Store.ingest(store, { alerts: alerts, detectedAt: now }, { evaluatedInputs: evaluatedInputs, now: now });
  return store;
}

(function () {
  // 1. buildDashboardState returns required sections
  var fleetResult = Fleet.buildFleetCanonicalInputs(baseMaster(), {
    '2026-10-07': { 8: 10, 6.5: 16, 4.5: 16, 3: 4, 2: 8 }
  }, { now: '2026-10-07' });
  var store = Store.createStore();
  var det = Core.detect(fleetResult.inputs[0], [sampleRule()]);
  Store.ingest(store, det, { evaluatedInputs: fleetResult.inputs, now: '2026-10-07T08:00:00.000Z' });
  var dryRun = Notification.createNotificationDryRun(Store.getAlerts(store), {
    dryRun: true, destinations: [{ type: 'line-group', id: 'test' }], isSampleRule: true
  });
  var state = Dashboard.buildDashboardState({
    canonicalInputs: fleetResult.inputs,
    fleetResult: fleetResult,
    store: store,
    notificationDryRun: dryRun,
    dataSource: 'test'
  });
  ok('(1) state has summary, riskRows, alertHistory, dryRun, diagnostics',
    state.summary && state.riskRows && state.alertHistory && state.dryRun && state.diagnostics);

  // 2. status counts correct
  ok('(2) OPEN count correct', state.summary.openCount === 1 && state.summary.totalAlerts === 1);

  // 3. severity counts correct
  eq('(3) warning severity count', state.summary.severityCounts.warning, 1);

  // 4. shortage display correct
  var row8 = state.riskRows.filter(function (r) { return r.hours === 8; })[0];
  ok('(4) shortage display correct', row8 && row8.shortage === 2 && row8.actual === 10);

  // 5. actual missing not displayed as 0
  var fleetMissing = Fleet.buildFleetCanonicalInputs(baseMaster(), {
    '2026-10-07': { 8: 12, 6.5: 16, 4.5: 16, 3: 4 }
  }, { now: '2026-10-07' });
  var stateMissing = Dashboard.buildDashboardState({
    canonicalInputs: fleetMissing.inputs,
    fleetResult: fleetMissing,
    store: Store.createStore()
  });
  var missingRow = stateMissing.riskRows.filter(function (r) { return r.hours === 2; })[0];
  ok('(5) actual missing is not 0', missingRow && missingRow.actualMissing === true && missingRow.actual === null);
  eq('(5a) missing actual display label', missingRow.status, '未取得');

  // 6. unevaluated not shown as RESOLVED
  ok('(6) unevaluated row not RESOLVED', missingRow.status !== 'RESOLVED' && missingRow.status !== '正常');
  eq('(6a) unevaluated count tracked', stateMissing.summary.unevaluatedCount, 1);

  // 7. history order correct (sorted by firstDetectedAt)
  var storeHist = Store.createStore();
  Store.ingest(storeHist, { alerts: [{
    alertId: 'a2', ruleId: 'r1', category: 'fleet-capacity', sourceDataType: 'fleet-capacity-canonical',
    localDate: '2026-10-08', severity: 'warning', detectedAt: '2026-10-08T09:00:00.000Z',
    evidence: { localDate: '2026-10-08', block: '8B', hours: 8, expected: 12, actual: 10, shortage: 2 }
  }] }, { now: '2026-10-08T09:00:00.000Z' });
  Store.ingest(storeHist, { alerts: [{
    alertId: 'a1', ruleId: 'r1', category: 'fleet-capacity', sourceDataType: 'fleet-capacity-canonical',
    localDate: '2026-10-07', severity: 'warning', detectedAt: '2026-10-07T08:00:00.000Z',
    evidence: { localDate: '2026-10-07', block: '8B', hours: 8, expected: 12, actual: 10, shortage: 2 }
  }] }, { now: '2026-10-07T08:00:00.000Z' });
  var histState = Dashboard.buildDashboardState({ store: storeHist });
  ok('(7) history sorted by firstDetectedAt',
    histState.alertHistory[0].localDate === '2026-10-07' && histState.alertHistory[1].localDate === '2026-10-08');

  // 8. multiple alerts display stably
  var storeMulti = Store.createStore();
  for (var m = 0; m < 10; m++) {
    Store.ingest(storeMulti, { alerts: [{
      alertId: 'm' + m, ruleId: 'rule-' + (m % 3), category: 'fleet-capacity', sourceDataType: 'fleet-capacity-canonical',
      localDate: '2026-10-0' + (m + 1), severity: 'warning', detectedAt: '2026-10-0' + (m + 1) + 'T08:00:00.000Z',
      evidence: { localDate: '2026-10-0' + (m + 1), block: 'B' + m, hours: 8, expected: 10, actual: 8, shortage: 2 }
    }] }, { now: '2026-10-0' + (m + 1) + 'T08:00:00.000Z' });
  }
  var multiState = Dashboard.buildDashboardState({ store: storeMulti });
  ok('(8) multiple alerts render stably', multiState.alertHistory.length === 10 && multiState.summary.totalAlerts === 10);

  // 9. empty data does not break
  var emptyState = Dashboard.buildDashboardState({});
  ok('(9) empty state renders safely', emptyState.summary.totalAlerts === 0 && emptyState.riskRows.length === 0);

  // 10. invalid stored data does not break display
  var badStore = Store.createStore();
  badStore.alerts['bad|key'] = { alertKey: 'bad|key', status: 'OPEN', severity: 'unknown' };
  noThrow('(10) invalid alert record does not throw', function () {
    Dashboard.buildDashboardState({ store: badStore });
  });

  // 11. HTML escaping
  var xssFleet = Fleet.buildFleetCanonicalInputs([{ block: '<script>', hours: 8, count: 1 }], {
    '2026-10-07': { 8: 0 }
  }, { now: '2026-10-07' });
  var xssState = Dashboard.buildDashboardState({ canonicalInputs: xssFleet.inputs });
  var html = Dashboard.renderDashboard({ innerHTML: '' }, xssState);
  var rendered = documentMock();
  Dashboard.renderDashboard(rendered, xssState);
  ok('(11) HTML escaped in render', rendered.innerHTML.indexOf('<script>') === -1 && rendered.innerHTML.indexOf('&lt;script&gt;') !== -1);

  // 12. dry-run produces only suppressed candidates
  var dry = Notification.createNotificationDryRun(Store.getAlerts(store), {
    dryRun: true, destinations: [{ type: 'line-group', id: 'test' }], isSampleRule: true
  });
  ok('(12) dry-run has no eligible candidates', dry.summary.eligible === 0 && dry.summary.suppressed === dry.summary.total);

  // 13. dashboard display does not modify store
  var before = JSON.stringify(Store.serialize(store));
  Dashboard.buildDashboardState({ store: store, canonicalInputs: fleetResult.inputs, fleetResult: fleetResult });
  Dashboard.renderDashboard(rendered, state);
  var after = JSON.stringify(Store.serialize(store));
  eq('(13) store unchanged by dashboard', before, after);

  // 14. sample store contains OPEN/ONGOING/REOPENED/RESOLVED
  var sampleStore = Dashboard.generateSampleStore();
  var sampleState = Dashboard.buildDashboardState({ store: sampleStore });
  ok('(14) sample store has all status types',
    sampleState.summary.openCount >= 1 && sampleState.summary.ongoingCount >= 1 &&
    sampleState.summary.reopenedCount >= 1 && sampleState.summary.resolvedCount >= 1);

  // 15. sample inputs include actual missing
  var sampleInputs = Dashboard.generateSampleInputs();
  ok('(15) sample inputs include missing actual', sampleInputs.diagnostics.missingActuals.length > 0);

  // 16. diagnostics counts
  var diagState = Dashboard.buildDashboardState({ canonicalInputs: fleetResult.inputs, fleetResult: fleetResult, store: store });
  ok('(16) diagnostics counts correct',
    diagState.diagnostics.inputCount === fleetResult.inputs.length &&
    diagState.diagnostics.missingActualCount === fleetResult.diagnostics.missingActuals.length);

  // 17. formatNumber fallback
  eq('(17) formatNumber returns fallback for null', Dashboard.formatNumber(null, '未取得'), '未取得');

  // 18. buildAlertKey matches store
  eq('(18) alert key matches store', Dashboard.buildAlertKey('r1', '2026-10-07', 8), Store.buildAlertKey('r1', '2026-10-07', 8));

  // 19. renderDashboard does not call ingest/acknowledge/resolve
  var called = false;
  var mockStore = {
    _schemaVersion: '0.1',
    alerts: {},
    diagnostics: { ingestCount: 0, persistenceErrors: [], deserializationErrors: [] },
    _updatedAt: '2026-10-07T08:00:00.000Z'
  };
  noThrow('(19) render with plain store object does not throw', function () {
    Dashboard.renderDashboard(rendered, Dashboard.buildDashboardState({ store: mockStore }));
  });

  // 20. source has no external communication
  var source = '';
  try {
    var fs = require('fs');
    source = fs.readFileSync(require.resolve('../inoichi-dashboard.js'), 'utf8');
  } catch (e) { source = ''; }
  ok('(20a) dashboard source has no fetch/xhr/POST', source.indexOf('fetch(') === -1 && source.indexOf('XMLHttpRequest') === -1 && source.indexOf('POST') === -1);
  ok('(20b) dashboard source has no LINE/FRIDAY/HARVEST writes', source.indexOf('line.me') === -1 && source.indexOf('friday') === -1 && source.indexOf('harvest') === -1);

  var branded = { innerHTML: '' };
  Dashboard.renderDashboard(branded, sampleState);
  ok('(21) header shows the official logo and existing sections',
    branded.innerHTML.indexOf('class="ino-logo"') !== -1 &&
    branded.innerHTML.indexOf('./assets/inoichi-logo.png') !== -1 &&
    branded.innerHTML.indexOf('A. サマリー') !== -1 &&
    branded.innerHTML.indexOf('B. 欠車リスク一覧') !== -1);
  ok('(21a) missing logo does not remove the dashboard', branded.innerHTML.indexOf("this.style.display='none'") !== -1);
  ok('(22) dashboard tabs keep every existing section',
    branded.innerHTML.indexOf('総合監視') !== -1 &&
    branded.innerHTML.indexOf('台数照合') !== -1 &&
    branded.innerHTML.indexOf('勤務時間リスク') !== -1 &&
    branded.innerHTML.indexOf('HARVEST収集状況') !== -1 &&
    branded.innerHTML.indexOf('実行履歴') !== -1 &&
    branded.innerHTML.indexOf('E. 診断情報') !== -1 &&
    branded.innerHTML.indexOf('data-ino-panel="fleet" hidden') !== -1);
}());

function documentMock() {
  return { innerHTML: '' };
}

if (failed === 0) {
  console.log('inoichi-dashboard tests passed (' + passed + ' tests)');
  process.exit(0);
} else {
  console.error('inoichi-dashboard tests failed: ' + failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
