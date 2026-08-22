import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const LDC = require('../lat-departure-core.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCase(label, planned, actual, dspDiff, expectedDiff, expectedJudgment) {
  var diff = LDC.latResolveDiffMin(dspDiff, actual, planned);
  var judgment = LDC.latResolveJudgment(diff);
  assert(diff === expectedDiff, label + ' diff: expected ' + expectedDiff + ', got ' + diff);
  assert(judgment === expectedJudgment, label + ' judgment: expected ' + expectedJudgment + ', got ' + judgment);
}

function runTests() {
  // Test 1: 09:00 → 08:45 = -15 → 早着出発
  runCase('Test1', '09:00', '08:45', null, -15, '早着出発');
  assert(LDC.latFormatDepDiffText(-15) === '15分早', 'Test1 diff text');

  // Test 2: 09:00 → 08:55 = -5 → 定刻
  runCase('Test2', '09:00', '08:55', null, -5, '定刻');
  assert(LDC.latFormatDepDiffText(-5) === '5分早', 'Test2 diff text');

  // Test 3: 09:00 → 09:00 = 0 → 定刻
  runCase('Test3', '09:00', '09:00', null, 0, '定刻');
  assert(LDC.latFormatDepDiffText(0) === '定刻', 'Test3 diff text');

  // Test 4: 09:00 → 09:05 = +5 → 定刻
  runCase('Test4', '09:00', '09:05', null, 5, '定刻');
  assert(LDC.latFormatDepDiffText(5) === '5分遅', 'Test4 diff text');

  // Test 5: 09:00 → 09:08 = +8 → 遅延
  runCase('Test5', '09:00', '09:08', null, 8, '遅延');
  assert(LDC.latFormatDepDiffText(8) === '8分遅', 'Test5 diff text');

  // Test 6: DSP "-" → 時刻差分フォールバック
  runCase('Test6', '09:00', '08:55', '-', -5, '定刻');

  // Test 7: DSP NaN → フォールバック、NaNを判定へ渡さない
  var t7 = LDC.latResolveDiffMin('N/A', '09:08', '09:00');
  assert(t7 === 8, 'Test7 diff from times');
  assert(LDC.latResolveJudgment(Number.NaN) === '', 'Test7 NaN judgment empty');
  assert(LDC.latParseDiffMins('N/A') === null, 'Test7 parse N/A');

  // Test 8: DSP有効差分優先
  runCase('Test8', '09:00', '09:00', '-8', -8, '定刻');

  // Test 9: 予定なし → 判定しない
  var t9 = LDC.latResolveDiffMin(null, '09:00', '');
  assert(t9 === null, 'Test9 no planned');
  assert(LDC.latResolveJudgment(t9) === '', 'Test9 no judgment');

  // Test 10: 実績なし → 判定しない
  var t10 = LDC.latResolveDiffMin(null, '', '09:00');
  assert(t10 === null, 'Test10 no actual');
  assert(LDC.latResolveJudgment(t10) === '', 'Test10 no judgment');

  // X軸ラベル（表示のみ）
  assert(LDC.latAxisLabelStep(240) === 30, 'axis step 30min for 4h range');
  assert(LDC.latAxisLabelStep(800) === 60, 'axis step 60min for long range');

  // LOW-only: no planned_departure column → judgment blocked
  var pdLow = LDC.latResolvePlannedDepartureFromLow({ wave: 'CYCLE_3', departure: '18:31:02' });
  assert(pdLow.plannedDeparture === '', 'LOW without planned_departure col');
  assert(pdLow.unavailableReason === '予定時刻未設定', 'LOW unavailable reason');
  assert(LDC.latResolveJudgment(LDC.latResolveDiffMin(null, '18:31:02', pdLow.plannedDeparture)) === '', 'no judgment without planned source');

  console.log('lat-departure-judgment.test.mjs: all 10 tests passed');
}

runTests();
