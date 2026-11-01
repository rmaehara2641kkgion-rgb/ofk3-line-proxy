import { createRequire } from 'module';
import { strict as assert } from 'assert';
const require = createRequire(import.meta.url);
const Store = require('../inoichi-alert-store.js');
const Core = require('../inoichi-detection-core.js');
const Rules = require('../inoichi-detection-rules.js');
const Adapter = require('../inoichi-fleet-adapter.js');

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

function detAlert(opts) {
  var o = opts || {};
  var localDate = o.hasOwnProperty('localDate') ? o.localDate : '2026-10-07';
  var hours = o.hasOwnProperty('hours') ? o.hours : 8;
  var block = o.hasOwnProperty('block') ? o.block : '8B';
  var expected = o.hasOwnProperty('expected') ? o.expected : 12;
  var actual = o.hasOwnProperty('actual') ? o.actual : 10;
  var shortage = o.hasOwnProperty('shortage') ? o.shortage : (expected - actual);
  return {
    alertId: o.alertId || 'alert-' + Math.random().toString(36).slice(2),
    ruleId: o.ruleId || 'fleet-capacity-shortage-v1',
    category: o.category || 'fleet-capacity',
    sourceDataType: o.sourceDataType || 'fleet-capacity-canonical',
    localDate: localDate,
    severity: o.severity || 'warning',
    detectedAt: o.detectedAt || '2026-10-07T10:00:00.000Z',
    evidence: {
      localDate: localDate,
      block: block,
      hours: hours,
      expected: expected,
      actual: actual,
      shortage: shortage
    }
  };
}

(function () {
  // 1. 新規OPEN
  var store = Store.createStore();
  var res = Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  ok('(1) new alert -> OPEN', res.created.length === 1 && res.created[0].status === 'OPEN');

  // 2. 継続ONGOING
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  var res2 = Store.ingest(store, { alerts: [detAlert({ alertId: 'a2' })] });
  ok('(2) redetected -> ONGOING', res2.updated.length === 1 && res2.updated[0].status === 'ONGOING' && res2.updated[0].occurrenceCount === 2);

  // 3. 解消RESOLVED
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  var key = Store.getAlerts(store)[0].alertKey;
  var res3 = Store.ingest(store, { alerts: [] }, { evaluatedKeys: [key] });
  ok('(3) cleared -> RESOLVED', res3.resolved.length === 1 && res3.resolved[0].status === 'RESOLVED' && res3.resolved[0].resolvedAt !== null);

  // 4. 再発REOPENED
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  key = Store.getAlerts(store)[0].alertKey;
  Store.ingest(store, { alerts: [] }, { evaluatedKeys: [key] });
  var res4 = Store.ingest(store, { alerts: [detAlert({ alertId: 'a2' })] });
  ok('(4) re-occurrence after resolved -> REOPENED', res4.updated.length === 1 && res4.updated[0].status === 'REOPENED' && res4.updated[0].reopenedAt !== null);

  // 5. 同一入力の再処理による重複防止
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a2' })] });
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a3' })] });
  var alerts = Store.getAlerts(store);
  ok('(5) same input reprocessing -> single alert, bounded history', alerts.length === 1 && alerts[0].occurrenceCount === 3 && alerts[0].transitionHistory.length <= 2);

  // 6. severity変更
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ severity: 'warning', alertId: 'a1' })] });
  key = Store.getAlerts(store)[0].alertKey;
  Store.ingest(store, { alerts: [detAlert({ severity: 'critical', alertId: 'a2' })] });
  var sevAlert = Store.getAlert(store, key);
  ok('(6) severity change updates record', sevAlert.severity === 'critical');

  // 7. 不足台数変更
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ shortage: 2, actual: 10, alertId: 'a1' })] });
  key = Store.getAlerts(store)[0].alertKey;
  Store.ingest(store, { alerts: [detAlert({ shortage: 5, actual: 7, alertId: 'a2' })] });
  var evAlert = Store.getAlert(store, key);
  ok('(7) shortage change updates evidence', evAlert.latestEvidence.shortage === 5 && evAlert.latestEvidence.actual === 7);

  // 8. 別日・別ルール・別拠点の分離
  store = Store.createStore();
  Store.ingest(store, { alerts: [
    detAlert({ ruleId: 'rule-a', localDate: '2026-10-07', hours: 8, alertId: 'x1' }),
    detAlert({ ruleId: 'rule-b', localDate: '2026-10-07', hours: 8, alertId: 'x2' }),
    detAlert({ ruleId: 'rule-a', localDate: '2026-10-08', hours: 8, alertId: 'x3' }),
    detAlert({ ruleId: 'rule-a', localDate: '2026-10-07', hours: 6.5, alertId: 'x4' })
  ]});
  ok('(8) separated by date/rule/hours', Store.getAlerts(store).length === 4);

  // 9. 同じhoursのblock合算との整合
  store = Store.createStore();
  Store.ingest(store, { alerts: [
    detAlert({ block: '8B', hours: 8, alertId: 'b1' }),
    detAlert({ block: '8B-A', hours: 8, alertId: 'b2' })
  ]});
  var blockAlerts = Store.getAlerts(store);
  ok('(9) same hours different block -> single record keyed by hours', blockAlerts.length === 1 && blockAlerts[0].hours === 8);

  // 10. actual未取得時の解消禁止
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ ruleId: 'r1', hours: 8, alertId: 'a1' })] });
  key = Store.getAlerts(store)[0].alertKey;
  Store.ingest(store, { alerts: [detAlert({ ruleId: 'r1', hours: 6.5, alertId: 'a2' })] }, {
    evaluatedInputs: [
      { localDate: '2026-10-07', hours: 6.5, actual: 12 },
      { localDate: '2026-10-07', hours: 8, actual: undefined }
    ]
  });
  var missingActualAlert = Store.getAlert(store, key);
  ok('(10) missing actual prevents auto-resolve', missingActualAlert.status === 'OPEN');

  // 11. 評価範囲外の解消禁止
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  key = Store.getAlerts(store)[0].alertKey;
  Store.ingest(store, { alerts: [] }, { evaluatedKeys: ['other-rule|2026-10-07|8'] });
  var outOfScopeAlert = Store.getAlert(store, key);
  ok('(11) out-of-scope prevents auto-resolve', outOfScopeAlert.status === 'OPEN');

  // 12. 不正データによる誤更新防止
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'first' })] });
  var before = Store.getAlerts(store).length;
  noThrow('(12a) malformed detectionOutput does not throw', function () {
    Store.ingest(store, null);
  });
  var res12 = Store.ingest(store, { alerts: [null, 'bad', detAlert({ hours: 6.5, alertId: 'second' })] });
  ok('(12b) malformed alerts skipped, valid alert created', Store.getAlerts(store).length === before + 1 && res12.created.length === 1);

  // 13. 保存データの復元
  var mem = Store.createMemoryStorage();
  var s1 = Store.createStore(mem);
  Store.ingest(s1, { alerts: [detAlert({ alertId: 'persist' })] });
  var s2 = Store.createStore(mem);
  ok('(13) persistence restore', Store.getAlerts(s2).length === 1);

  // 14. 破損JSON
  var corrupt = Store.deserialize('not json');
  ok('(14) corrupted JSON -> safe failure', !corrupt.ok && corrupt.diagnostics.reason === 'parse-error');

  // 15. スキーマ不一致
  var mismatch = Store.deserialize(JSON.stringify({ _schemaVersion: '9.9', alerts: {} }));
  ok('(15) schema mismatch detected', !mismatch.ok && mismatch.diagnostics.reason === 'schema-mismatch');

  // 16. 保存容量超過
  var quotaAdapter = {
    load: function () { return null; },
    save: function () { return { ok: false, error: 'quota-exceeded', message: 'disk full' }; }
  };
  store = Store.createStore(quotaAdapter);
  Store.ingest(store, { alerts: [detAlert({ alertId: 'q1' })] });
  ok('(16) quota exceeded recorded in diagnostics', store.diagnostics.persistenceErrors.length === 1 && store.diagnostics.persistenceErrors[0].error === 'quota-exceeded');

  // 17. acknowledge API
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  key = Store.getAlerts(store)[0].alertKey;
  var ack = Store.acknowledge(store, key, { now: '2026-10-07T11:00:00.000Z' });
  ok('(17) acknowledge sets acknowledgedAt', ack.ok && ack.alert.acknowledgedAt === '2026-10-07T11:00:00.000Z');

  // 18. manual resolve API
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  key = Store.getAlerts(store)[0].alertKey;
  var manual = Store.resolve(store, key, { now: '2026-10-07T12:00:00.000Z' });
  ok('(18) manual resolve -> RESOLVED', manual.ok && manual.alert.status === 'RESOLVED' && manual.alert.resolvedAt === '2026-10-07T12:00:00.000Z');

  // 19. getAlerts filter
  store = Store.createStore();
  Store.ingest(store, { alerts: [
    detAlert({ ruleId: 'rule-a', localDate: '2026-10-07', hours: 8, severity: 'warning', alertId: 'f1' }),
    detAlert({ ruleId: 'rule-b', localDate: '2026-10-07', hours: 8, severity: 'critical', alertId: 'f2' })
  ]});
  var filtered = Store.getAlerts(store, { ruleId: 'rule-b' });
  ok('(19) getAlerts filter by ruleId', filtered.length === 1 && filtered[0].ruleId === 'rule-b');

  // 20. localStorage adapter basic interface
  var lsAdapter = Store.createLocalStorageAdapter('inoichi-test', { _schemaVersion: Store.SCHEMA_VERSION, alerts: {}, diagnostics: {} });
  noThrow('(20a) localStorage adapter load does not throw', function () { lsAdapter.load(); });
  var lsSave = lsAdapter.save({ _schemaVersion: Store.SCHEMA_VERSION, alerts: {}, diagnostics: {} });
  ok('(20b) localStorage adapter save returns ok in Node', lsSave.ok);

  // 21. Fleet Adapter + Detection Core + Alert Store 接続
  var master = [{ block: '8B', hours: 8, count: 12 }];
  var dateMap = { '2026-10-07': { 8: 10 } };
  var adapterRes = Adapter.buildFleetCanonicalInputs(master, dateMap, { now: '2026-10-07' });
  var rule = Rules.getSampleFleetCapacityRule();
  rule.enabled = true;
  var det = Core.detect(adapterRes.inputs[0], [rule]);
  store = Store.createStore();
  Store.ingest(store, det, { evaluatedInputs: adapterRes.inputs });
  ok('(21) adapter -> detection -> alert store integration', Store.getAlerts(store).length === 1 && Store.getAlerts(store)[0].ruleId === 'fleet-capacity-shortage-v1');

  // 22. serialize/deserialize roundtrip
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'round' })] });
  var json = Store.serialize(store);
  var restored = Store.deserialize(json);
  ok('(22) serialize/deserialize roundtrip', restored.ok && restored.state && Object.keys(restored.state.alerts).length === 1);

  // 23. REOPENED -> ONGOING 継続
  store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] });
  key = Store.getAlerts(store)[0].alertKey;
  Store.ingest(store, { alerts: [] }, { evaluatedKeys: [key] });
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a2' })] });
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a3' })] });
  var reopenedAlert = Store.getAlert(store, key);
  ok('(23) reopened -> ongoing continues', reopenedAlert.status === 'ONGOING' && reopenedAlert.occurrenceCount === 3);

  // 24. 禁止：通知・外部通信・UI接続がない
  var source = '';
  try {
    var fs = require('fs');
    source = fs.readFileSync(require.resolve('../inoichi-alert-store.js'), 'utf8');
  } catch (e) { source = ''; }
  ok('(24) no fetch/xhr/POST', source.indexOf('fetch(') === -1 && source.indexOf('XMLHttpRequest') === -1);
  ok('(25) no LINE/FRIDAY/HARVEST writes', source.indexOf('line.me') === -1 && source.indexOf('friday') === -1 && source.indexOf('harvest') === -1);
}());

if (failed === 0) {
  console.log('inoichi-alert-store tests passed (' + passed + ' tests)');
  process.exit(0);
} else {
  console.error('inoichi-alert-store tests failed: ' + failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
