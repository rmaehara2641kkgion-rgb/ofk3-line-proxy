import { createRequire } from 'module';
import { strict as assert } from 'assert';
const require = createRequire(import.meta.url);
const Notification = require('../inoichi-notification-adapter.js');
const Store = require('../inoichi-alert-store.js');

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

function baseOpts(overrides) {
  return Object.assign({
    dryRun: true,
    destinations: [{ type: 'line-group', id: 'test-group-1' }],
    isSampleRule: false,
    persistenceFailed: false
  }, overrides || {});
}

function getOpenAlert() {
  var store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] }, { now: '2026-10-07T10:00:00.000Z' });
  return Store.getAlerts(store)[0];
}

function getOngoingAlert() {
  var store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] }, { now: '2026-10-07T10:00:00.000Z' });
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a2' })] }, { now: '2026-10-07T11:00:00.000Z' });
  return Store.getAlerts(store)[0];
}

function getResolvedAlert() {
  var store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] }, { now: '2026-10-07T10:00:00.000Z' });
  var key = Store.getAlerts(store)[0].alertKey;
  Store.ingest(store, { alerts: [] }, { evaluatedKeys: [key], now: '2026-10-07T11:00:00.000Z' });
  return Store.getAlerts(store)[0];
}

function getReopenedAlert() {
  var store = Store.createStore();
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a1' })] }, { now: '2026-10-07T10:00:00.000Z' });
  var key = Store.getAlerts(store)[0].alertKey;
  Store.ingest(store, { alerts: [] }, { evaluatedKeys: [key], now: '2026-10-07T11:00:00.000Z' });
  Store.ingest(store, { alerts: [detAlert({ alertId: 'a2' })] }, { now: '2026-10-07T12:00:00.000Z' });
  return Store.getAlerts(store)[0];
}

(function () {
  // 1. OPEN候補生成
  var open = getOpenAlert();
  var candidates = Notification.buildNotificationCandidates([open], baseOpts());
  ok('(1) OPEN candidate generated', candidates.length === 1 && candidates[0].alertStatus === 'OPEN');
  eq('(1a) OPEN notification type', candidates[0].notificationType, 'fleet-shortage');
  ok('(1b) OPEN candidate has title and message', candidates[0].title !== '' && candidates[0].message.indexOf('2026-10-07') !== -1);
  ok('(1c) OPEN candidate has deduplication key', candidates[0].deduplicationKey.indexOf('OPEN') !== -1);

  // 2. REOPENED候補生成
  var reopened = getReopenedAlert();
  candidates = Notification.buildNotificationCandidates([reopened], baseOpts());
  ok('(2) REOPENED candidate generated', candidates.length === 1 && candidates[0].alertStatus === 'REOPENED');
  ok('(2a) REOPENED deduplication key differs from OPEN', candidates[0].deduplicationKey.indexOf('REOPENED') !== -1);

  // 3. ONGOING再通知抑止
  var ongoing = getOngoingAlert();
  candidates = Notification.buildNotificationCandidates([ongoing], baseOpts());
  ok('(3) ONGOING candidate is suppressed', candidates.length === 1 && candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'ongoing');

  // 4. RESOLVEDデフォルト抑止
  var resolved = getResolvedAlert();
  candidates = Notification.buildNotificationCandidates([resolved], baseOpts());
  ok('(4) RESOLVED candidate is suppressed', candidates.length === 1 && candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'resolved');

  // 5. 同一イベント重複防止
  open = getOpenAlert();
  var c1 = Notification.buildNotificationCandidates([open], baseOpts())[0];
  var c2 = Notification.buildNotificationCandidates([open], baseOpts())[0];
  eq('(5) same OPEN event produces identical deduplication key', c1.deduplicationKey, c2.deduplicationKey);

  // 6. 異なる再発イベントの識別
  open = getOpenAlert();
  reopened = getReopenedAlert();
  var openKey = Notification.buildNotificationCandidates([open], baseOpts())[0].deduplicationKey;
  var reopenedKey = Notification.buildNotificationCandidates([reopened], baseOpts())[0].deduplicationKey;
  ok('(6) OPEN and REOPENED events have different deduplication keys', openKey !== reopenedKey);

  // 7. severity不明時の抑止
  var badSev = getOpenAlert();
  badSev.severity = 'unknown';
  candidates = Notification.buildNotificationCandidates([badSev], baseOpts());
  ok('(7) unknown severity is suppressed', candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'missing-data');

  // 8. 通知先未設定時の抑止
  candidates = Notification.buildNotificationCandidates([getOpenAlert()], baseOpts({ destinations: [] }));
  ok('(8) empty destinations is suppressed', candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'missing-destinations');

  // 9. サンプルルールの抑止
  var sampleAlert = getOpenAlert();
  sampleAlert.ruleId = 'sample-fleet-capacity-shortage-v1';
  candidates = Notification.buildNotificationCandidates([sampleAlert], baseOpts());
  ok('(9) sample rule by ruleId is suppressed', candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'sample-rule');

  var normalAlert = getOpenAlert();
  candidates = Notification.buildNotificationCandidates([normalAlert], baseOpts({ isSampleRule: true }));
  ok('(9a) sample rule by opt is suppressed', candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'sample-rule');

  // 10. 不完全データの抑止
  var incomplete = getOpenAlert();
  incomplete.latestEvidence = { localDate: '2026-10-07', hours: 8, block: '8B', expected: 12 };
  candidates = Notification.buildNotificationCandidates([incomplete], baseOpts());
  ok('(10) incomplete evidence is suppressed', candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'missing-data');

  // 11. 保存復元後の識別子安定性
  var mem = Store.createMemoryStorage();
  var s1 = Store.createStore(mem);
  Store.ingest(s1, { alerts: [detAlert({ alertId: 'persist' })] }, { now: '2026-10-07T10:00:00.000Z' });
  var s2 = Store.createStore(mem);
  var before = Notification.buildNotificationCandidates(Store.getAlerts(s1), baseOpts())[0].deduplicationKey;
  var after = Notification.buildNotificationCandidates(Store.getAlerts(s2), baseOpts())[0].deduplicationKey;
  eq('(11) deduplication key stable after persistence restore', before, after);

  // 12. 外部通信ゼロ
  var source = '';
  try {
    var fs = require('fs');
    source = fs.readFileSync(require.resolve('../inoichi-notification-adapter.js'), 'utf8');
  } catch (e) { source = ''; }
  ok('(12a) no fetch/xhr/POST', source.indexOf('fetch(') === -1 && source.indexOf('XMLHttpRequest') === -1 && source.indexOf('POST') === -1);
  ok('(12b) no LINE/FRIDAY/HARVEST writes', source.indexOf('line.me') === -1 && source.indexOf('friday') === -1 && source.indexOf('harvest') === -1);

  // 13. 認証情報がプレビューに含まれない
  var secret = 'secret-line-token-abc123';
  var previewCandidate = Notification.buildNotificationCandidates([getOpenAlert()], baseOpts({ destinations: [{ type: 'line', token: secret }] }))[0];
  var preview = Notification.buildNotificationPreview(previewCandidate);
  ok('(13) preview does not contain destination secret', preview.indexOf(secret) === -1);

  // 14. dry-run統合出力
  var dryRun = Notification.createNotificationDryRun([getOpenAlert(), getOngoingAlert()], baseOpts());
  ok('(14) dry-run returns candidates and summary', dryRun.dryRun === true && dryRun.candidates.length === 2 && dryRun.summary.total === 2);
  ok('(14a) dry-run summary counts suppressed', dryRun.summary.suppressed === 2 && dryRun.previews.length === 2);

  // 15. dryRun=false も抑止
  candidates = Notification.buildNotificationCandidates([getOpenAlert()], baseOpts({ dryRun: false }));
  ok('(15) non-dry-run execution is suppressed', candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'not-dry-run');

  // 16. 保存失敗時の抑止
  candidates = Notification.buildNotificationCandidates([getOpenAlert()], baseOpts({ persistenceFailed: true }));
  ok('(16) persistence failure is suppressed', candidates[0].eligibility === 'suppressed' && candidates[0].suppressionReason === 'persistence-failed');

  // 17. evaluateNotificationPolicy API
  var policy = Notification.evaluateNotificationPolicy({ alertStatus: 'ONGOING' }, baseOpts());
  ok('(17) evaluateNotificationPolicy returns suppression for ONGOING', policy.eligibility === 'suppressed' && policy.suppressionReason === 'ongoing');
}());

if (failed === 0) {
  console.log('inoichi-notification-adapter tests passed (' + passed + ' tests)');
  process.exit(0);
} else {
  console.error('inoichi-notification-adapter tests failed: ' + failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
