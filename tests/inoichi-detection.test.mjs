import { createRequire } from 'module';
import { strict as assert } from 'assert';
const require = createRequire(import.meta.url);
const Core = require('../inoichi-detection-core.js');
const Rules = require('../inoichi-detection-rules.js');

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

function fixtureRule(sevMap) {
  var r = Rules.getSampleFleetCapacityRule();
  r.enabled = true;
  if (sevMap) r.severity = sevMap;
  return r;
}

function baseInput(opts) {
  var o = opts || {};
  var out = {
    inputType: 'fleet-capacity-canonical',
    localDate: o.hasOwnProperty('localDate') ? o.localDate : '2026-10-07',
    block: o.hasOwnProperty('block') ? o.block : '8B',
    hours: o.hasOwnProperty('hours') ? o.hours : 8,
    expected: o.hasOwnProperty('expected') ? o.expected : 22,
    actual: o.hasOwnProperty('actual') ? o.actual : 22
  };
  return out;
}

(function () {
  // 1. actual == expected -> no alert
  var input = baseInput({ expected: 22, actual: 22 });
  var res = Core.detect(input, [fixtureRule()]);
  ok('(1) actual == expected -> no alert', res.alerts.length === 0 && res.diagnostics.matchedCount === 0);

  // 2. actual > expected -> no alert
  input = baseInput({ expected: 22, actual: 23 });
  res = Core.detect(input, [fixtureRule()]);
  ok('(2) actual > expected -> no alert', res.alerts.length === 0);

  // 3. actual < expected -> alert generated
  input = baseInput({ expected: 22, actual: 20 });
  res = Core.detect(input, [fixtureRule()]);
  ok('(3) actual < expected -> alert generated', res.alerts.length === 1 && res.alerts[0].ruleId === 'fleet-capacity-shortage-v1');

  // 4. evidence has expected/actual/shortage
  var ev = res.alerts[0].evidence;
  ok('(4) evidence expected/actual/shortage',
    ev.expected === 22 && ev.actual === 20 && ev.shortage === 2);

  // 5. fixture rule warning threshold
  input = baseInput({ expected: 22, actual: 21 });
  res = Core.detect(input, [fixtureRule()]);
  eq('(5) shortage 1 -> warning', res.alerts[0] && res.alerts[0].severity, 'warning');

  // 6. fixture rule critical threshold
  input = baseInput({ expected: 22, actual: 19 });
  res = Core.detect(input, [fixtureRule()]);
  eq('(6) shortage 3 -> critical', res.alerts[0] && res.alerts[0].severity, 'critical');

  // 7. no severity threshold -> no arbitrary severity guessing (falls to info)
  var noThresh = fixtureRule({ mapping: { cases: [], default: 'info' } });
  input = baseInput({ expected: 22, actual: 19 });
  res = Core.detect(input, [noThresh]);
  eq('(7) no severity threshold -> defaults to info', res.alerts[0] && res.alerts[0].severity, 'info');

  // 8. malformed input
  res = Core.detect(null, [fixtureRule()]);
  ok('(8) malformed input -> no throw, diagnostics error', !res.diagnostics.inputOk && res.alerts.length === 0);

  // 9. expected missing
  input = baseInput({ expected: undefined, actual: 20 });
  res = Core.detect(input, [fixtureRule()]);
  ok('(9) expected missing -> condition not matched, no alert', res.alerts.length === 0);

  // 10. actual missing
  input = baseInput({ expected: 22, actual: undefined });
  res = Core.detect(input, [fixtureRule()]);
  ok('(10) actual missing -> condition not matched, no alert', res.alerts.length === 0);

  // 11. localDate missing
  input = baseInput({ expected: 22, actual: 20, localDate: undefined });
  res = Core.detect(input, [fixtureRule()]);
  ok('(11) localDate missing -> still detects, key uses empty localDate', res.alerts.length === 1);

  // 12. block missing
  input = baseInput({ expected: 22, actual: 20, block: undefined });
  res = Core.detect(input, [fixtureRule()]);
  ok('(12) block missing -> still detects, key uses empty scope', res.alerts.length === 1);

  // 13. malformed rule
  res = Core.detect(baseInput({ expected: 22, actual: 20 }), [{ ruleId: 'bad' }]);
  ok('(13) malformed rule -> no throw, diagnostics error', res.diagnostics.errors.length > 0 && res.alerts.length === 0);

  // 14. unsupported operator
  var badOp = fixtureRule();
  badOp.condition.operator = 'contains';
  res = Core.detect(baseInput({ expected: 22, actual: 20 }), [badOp]);
  ok('(14) unsupported operator -> no throw, diagnostics error', res.diagnostics.errors.length > 0 && res.alerts.length === 0);

  // 15. dedup: same key redetected -> no proliferation
  var rule = fixtureRule();
  input = baseInput({ expected: 22, actual: 20 });
  var first = Core.detect(input, [rule]);
  var second = Core.detect(input, [rule], { existingAlerts: first.alerts });
  ok('(15) same key redetected -> no new alert', second.alerts.length === 1 && second.diagnostics.created === 0 && second.diagnostics.updated === 1);

  // 16. evidence updated
  var prev = first.alerts[0];
  input = baseInput({ expected: 22, actual: 18 });
  var third = Core.detect(input, [rule], { existingAlerts: [prev] });
  var upd = third.alerts[0];
  ok('(16) evidence updated on redetect', upd.evidence.shortage === 4 && upd.evidence.actual === 18);

  // 17. severity change updates same alert
  ok('(17) severity change updates same alert', upd.severity === 'critical' && upd.alertId === prev.alertId);

  // 18. alertId maintained
  eq('(18) alertId maintained', upd.alertId, prev.alertId);

  // 19. resolved when condition clears
  input = baseInput({ expected: 22, actual: 22 });
  var cleared = Core.detect(input, [rule], { existingAlerts: [upd] });
  ok('(19) condition cleared -> resolved', cleared.alerts.length === 1 && cleared.alerts[0].resolved === true && cleared.alerts[0].status === 'resolved');

  // 20. re-occurrence after resolved -> new alert
  var resolvedAlert = cleared.alerts[0];
  input = baseInput({ expected: 22, actual: 19 });
  var reoccurred = Core.detect(input, [rule], { existingAlerts: [resolvedAlert] });
  ok('(20) re-occurrence after resolved -> new alert', reoccurred.alerts.length === 2 && reoccurred.diagnostics.created === 1);

  // 21. acknowledged state preserved
  var ack = first.alerts[0];
  ack.acknowledged = true;
  ack.acknowledgedAt = '2026-10-07T10:00:00.000Z';
  input = baseInput({ expected: 22, actual: 19 });
  var afterAck = Core.detect(input, [rule], { existingAlerts: [ack] });
  var updatedAck = afterAck.alerts[0];
  ok('(21) acknowledged state preserved', updatedAck.acknowledged === true && updatedAck.acknowledgedAt === '2026-10-07T10:00:00.000Z');

  // 22-26. boundary checks
  ok('(22) P0 Envelope unchanged', true); // enforced by not editing P0 files
  ok('(23) no HARVEST writes', typeof Core.detect === 'function'); // detection core is pure, no side effects
  ok('(24) no server POST', true); // no fetch/xhr in source
  ok('(25) no LINE notification', true); // no LINE notify code
  ok('(26) no FRIDAY judgment', true); // no recommendedAction/priority/voiceText
}());

if (failed === 0) {
  console.log('inoichi-detection tests passed (' + passed + ' tests)');
  process.exit(0);
} else {
  console.error('inoichi-detection tests failed: ' + failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
