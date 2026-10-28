import { createRequire } from 'module';
import { strict as assert } from 'assert';
const require = createRequire(import.meta.url);
const Adapter = require('../inoichi-fleet-adapter.js');
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

function deepEq(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}

function noThrow(name, fn) {
  try { fn(); ok(name, true); } catch (e) { failed++; console.error('FAIL - ' + name + ': threw ' + e.message); }
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

function baseDateMap() {
  return {
    '2026-10-07': { 8: 12, 6.5: 16, 4.5: 16, 3: 4, 2: 8 }
  };
}

function detectRule() {
  var r = Rules.getSampleFleetCapacityRule();
  r.enabled = true;
  return r;
}

(function () {
  // 1. 正常master + dateMap
  var res = Adapter.buildFleetCanonicalInputs(baseMaster(), baseDateMap(), { now: '2026-10-07' });
  ok('(1) normal master + dateMap -> 5 canonical inputs', res.inputs.length === 5);

  // 2. expected/actual一致
  var input = res.inputs.filter(function (i) { return i.hours === 8; })[0];
  ok('(2) expected/actual match for 8B', input.expected === 12 && input.actual === 12);

  // 3. shortage入力
  var shortageMap = { '2026-10-07': { 8: 10, 6.5: 16, 4.5: 16, 3: 4, 2: 8 } };
  res = Adapter.buildFleetCanonicalInputs(baseMaster(), shortageMap, { now: '2026-10-07' });
  var short8 = res.inputs.filter(function (i) { return i.hours === 8; })[0];
  ok('(3) shortage input -> actual < expected', short8.expected === 12 && short8.actual === 10);

  // 4. surplus入力
  var surplusMap = { '2026-10-07': { 8: 15, 6.5: 16, 4.5: 16, 3: 4, 2: 8 } };
  res = Adapter.buildFleetCanonicalInputs(baseMaster(), surplusMap, { now: '2026-10-07' });
  var surp8 = res.inputs.filter(function (i) { return i.hours === 8; })[0];
  ok('(4) surplus input -> actual > expected', surp8.expected === 12 && surp8.actual === 15);

  // 5. 複数日
  var multiDateMap = {
    '2026-10-06': { 8: 12, 6.5: 16 },
    '2026-10-07': { 8: 12, 6.5: 16, 4.5: 16, 3: 4, 2: 8 }
  };
  res = Adapter.buildFleetCanonicalInputs(baseMaster(), multiDateMap, { now: '2026-10-07' });
  var dates = res.inputs.map(function (i) { return i.localDate; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  ok('(5) multiple dates -> both included', dates.length === 2 && res.inputs.length === 10);

  // 6. 複数block
  var multiBlockMaster = [
    { block: '8B', hours: 8, count: 6 },
    { block: '8B-A', hours: 8, count: 6 }
  ];
  res = Adapter.buildFleetCanonicalInputs(multiBlockMaster, { '2026-10-07': { 8: 12 } }, { now: '2026-10-07' });
  ok('(6) multiple blocks same hours -> count summed, first block kept', res.inputs.length === 1 && res.inputs[0].expected === 12 && res.inputs[0].block === '8B');

  // 7. fleetMasterなし
  res = Adapter.buildFleetCanonicalInputs(undefined, baseDateMap(), { now: '2026-10-07' });
  ok('(7) missing master -> no canonical inputs, no throw', res.inputs.length === 0 && res.diagnostics.inputMasterCount === 0);

  // 8. dateMapなし
  res = Adapter.buildFleetCanonicalInputs(baseMaster(), undefined, { now: '2026-10-07' });
  ok('(8) missing dateMap -> no canonical inputs, no throw', res.inputs.length === 0 && res.diagnostics.inputDateCount === 0);

  // 9. 対象日なし (dateMap has dates outside filter window)
  res = Adapter.buildFleetCanonicalInputs(baseMaster(), { '2026-01-01': { 8: 12 } }, { now: '2026-10-07' });
  ok('(9) no target dates -> no canonical inputs', res.inputs.length === 0 && res.diagnostics.inputDateCount === 1);

  // 10. actual missing
  var missingActualMap = { '2026-10-07': { 8: 12, 6.5: 16, 4.5: 16, 3: 4 } };
  res = Adapter.buildFleetCanonicalInputs(baseMaster(), missingActualMap, { now: '2026-10-07' });
  var missing2 = res.inputs.filter(function (i) { return i.hours === 2; })[0];
  ok('(10) actual missing -> actual is undefined, not 0', missing2 !== undefined && missing2.actual === undefined);

  // 11. actual = 0 explicit
  var zeroActualMap = { '2026-10-07': { 8: 0 } };
  res = Adapter.buildFleetCanonicalInputs([{ block: '8B', hours: 8, count: 12 }], zeroActualMap, { now: '2026-10-07' });
  ok('(11) actual = 0 explicit -> actual is 0', res.inputs[0].actual === 0 && res.inputs[0].expected === 12);

  // 12. count invalid
  res = Adapter.buildFleetCanonicalInputs([{ block: '8B', hours: 8, count: NaN }], baseDateMap(), { now: '2026-10-07' });
  ok('(12) invalid count -> skipped', res.diagnostics.invalidEntries.length > 0 && res.diagnostics.skippedCount > 0);

  // 13. negative count
  res = Adapter.buildFleetCanonicalInputs([{ block: '8B', hours: 8, count: -1 }], baseDateMap(), { now: '2026-10-07' });
  ok('(13) negative count -> skipped', res.diagnostics.invalidEntries.length > 0 && res.diagnostics.skippedCount > 0);

  // 14. duplicate master
  var dupMaster = [
    { block: '8B', hours: 8, count: 6 },
    { block: '8B-X', hours: 8, count: 6 }
  ];
  res = Adapter.buildFleetCanonicalInputs(dupMaster, { '2026-10-07': { 8: 12 } }, { now: '2026-10-07' });
  ok('(14) duplicate master hours -> summed, recorded in diagnostics', res.inputs[0].expected === 12 && res.diagnostics.duplicates.length === 1);

  // 15. duplicate actual
  var dupActualMap = { '2026-10-07': { 8: 6 } };
  res = Adapter.buildFleetCanonicalInputs([{ block: '8B', hours: 8, count: 12 }], dupActualMap, { now: '2026-10-07' });
  ok('(15) single actual entry -> no duplicate diagnostic for normal case', res.diagnostics.duplicates.length === 0 && res.inputs[0].actual === 6);

  // 16. unknown block
  res = Adapter.buildFleetCanonicalInputs([{ block: '8B', hours: 8, count: 12 }], { '2026-10-07': { 6.5: 16 } }, { now: '2026-10-07' });
  var unknownRow = res.inputs.filter(function (i) { return i.hours === 6.5; })[0];
  ok('(16) unknown block hours -> block is "-"', unknownRow !== undefined && unknownRow.block === '-' && unknownRow.expected === 0);

  // 17. malformed input
  res = Adapter.buildFleetCanonicalInputs('bad', null, { now: '2026-10-07' });
  ok('(17) malformed input -> no throw, invalid entries recorded', res.inputs.length === 0 && res.diagnostics.invalidEntries.length > 0);

  // 18. no throw
  noThrow('(18) no throw on any bad input', function () {
    Adapter.buildFleetCanonicalInputs();
    Adapter.buildFleetCanonicalInputs(null, null);
    Adapter.buildFleetCanonicalInputs([], {});
    Adapter.buildFleetCanonicalInputs([{}], { 'x': 'y' });
  });

  // 19. diagnostics保持
  res = Adapter.buildFleetCanonicalInputs(baseMaster(), baseDateMap(), { now: '2026-10-07' });
  ok('(19) diagnostics kept', typeof res.diagnostics === 'object' && res.diagnostics.canonicalCount === 5);

  // 20. canonical schema確認
  var schemaOk = res.inputs.every(function (i) {
    return i.inputType === 'fleet-capacity-canonical' &&
      typeof i.localDate === 'string' &&
      typeof i.block === 'string' &&
      typeof i.hours === 'number' &&
      typeof i.expected === 'number' &&
      (i.actual === undefined || i.actual === null || typeof i.actual === 'number');
  });
  ok('(20) canonical schema confirmed', schemaOk);

  // 21. 既存fleet comparisonとのexpected一致
  var comparison = Adapter.getComparisonView(res.inputs);
  var oct7 = comparison.dates.filter(function (d) { return d.date === '2026-10-07'; })[0];
  var row8 = oct7.rows.filter(function (r) { return r.hours === 8; })[0];
  eq('(21) comparison expected matches existing fleet comparison', row8.expected, 12);

  // 22. 既存fleet comparisonとのactual一致
  eq('(22) comparison actual matches existing fleet comparison', row8.actual, 12);

  // 23. Adapter -> detect() 正常接続
  var det = Core.detect(res.inputs[0], [detectRule()]);
  ok('(23) adapter -> detect() connects', det.alerts.length === 0 && det.diagnostics.inputOk === true);

  // 24. 不足時Alert生成
  var shortageInputs = Adapter.buildFleetCanonicalInputs(baseMaster(), shortageMap, { now: '2026-10-07' }).inputs;
  var shortInput = shortageInputs.filter(function (i) { return i.hours === 8; })[0];
  det = Core.detect(shortInput, [detectRule()]);
  ok('(24) shortage generates alert', det.alerts.length === 1 && det.alerts[0].ruleId === 'fleet-capacity-shortage-v1');

  // 25. 充足時Alertなし
  var fullInputs = Adapter.buildFleetCanonicalInputs(baseMaster(), baseDateMap(), { now: '2026-10-07' }).inputs;
  var fullInput = fullInputs.filter(function (i) { return i.hours === 8; })[0];
  det = Core.detect(fullInput, [detectRule()]);
  ok('(25) full capacity -> no alert', det.alerts.length === 0);

  // 26. missing actualから誤Alertを生成しない
  var missingInputs = Adapter.buildFleetCanonicalInputs(baseMaster(), missingActualMap, { now: '2026-10-07' }).inputs;
  var missingInput = missingInputs.filter(function (i) { return i.hours === 2; })[0];
  det = Core.detect(missingInput, [detectRule()]);
  ok('(26) missing actual does not generate false alert', det.alerts.length === 0);
}());

if (failed === 0) {
  console.log('inoichi-fleet-adapter tests passed (' + passed + ' tests)');
  process.exit(0);
} else {
  console.error('inoichi-fleet-adapter tests failed: ' + failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
