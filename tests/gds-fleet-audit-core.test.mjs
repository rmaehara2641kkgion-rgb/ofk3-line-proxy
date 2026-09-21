import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Core = require('../gds-fleet-audit-core.js');
const XLSX = require('xlsx');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures', 'gds-fleet-audit');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

// ===== 1) Real-data end-to-end: reproduce the 2026-09-13 Pair discrepancy =====
// Fixtures are real production data (GDS Weekly Report CSV as-is; InputFile trimmed
// to OFK3 rows + a narrow date window, values unchanged) — not synthetic guesses.
(function () {
  const csvText = readFileSync(join(fixturesDir, 'GDS_Weekly_Report-2026-09-13.csv'), 'utf8');
  const cortex = Core.parseCortexWeeklyCsv(csvText);
  assert(cortex.ok, 'real Cortex CSV parses OK: ' + cortex.error);
  assert(cortex.meta.ofk3Rows === 56, 'all 56 real CSV rows are OFK3 (station column already OFK3-only in this export); got ' + cortex.meta.ofk3Rows);
  assert(cortex.meta.dates.join(',') === '2026-09-13,2026-09-14,2026-09-15,2026-09-16,2026-09-17,2026-09-18,2026-09-19', 'real CSV covers 2026-09-13..19; got ' + cortex.meta.dates.join(','));

  const wb = XLSX.readFile(join(fixturesDir, 'dsp1.0_inputfile_gds_trimmed.xlsx'));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['InputFile'], { header: 1, defval: '' });
  const input = Core.parseInputFileRows(rows);
  assert(input.ok, 'real InputFile parses OK: ' + input.error);
  assert(input.meta.ofk3Rows === 14, 'real InputFile has 14 OFK3 rows; got ' + input.meta.ofk3Rows);
  assert(input.meta.headerRowIndex === 3, 'header row auto-detected at row 3 (dynamic detection, not hardcoded); got ' + input.meta.headerRowIndex);
  assert(input.meta.warnings.length === 1 && input.meta.warnings[0].indexOf('Block=4.5') >= 0, 'duplicate Block=4.5/B-S=4B30S row flagged as a warning (real data quirk), got ' + JSON.stringify(input.meta.warnings));

  const cmp = Core.compareGdsFleet(cortex, input);
  assert(cmp.summary.total === 7, 'audited date count = Weekly Report\'s own date coverage (7 days); got ' + cmp.summary.total);
  assert(cmp.summary.alert === 1, 'exactly 1 day has a real discrepancy (2026-09-13 Pair); got ' + cmp.summary.alert);
  assert(cmp.summary.ok === 6, '6 days are genuinely normal; got ' + cmp.summary.ok);
  assert(cmp.summary.unknown === 0, 'no missing-data days inside the Weekly Report\'s own range; got ' + cmp.summary.unknown);

  const sep13 = cmp.days.filter(function (d) { return d.date === '2026-09-13'; })[0];
  assert(sep13, '2026-09-13 present in results');
  assert(sep13.dayStatus === 'alert', '2026-09-13 day status is alert; got ' + sep13.dayStatus);
  assert(sep13.categories.pair.status === 'alert', 'Pair flagged; got ' + sep13.categories.pair.status);
  assert(sep13.categories.pair.cortex === 17, 'Cortex Pair = 17 (4.5B=17 Standard16+Nursery1, 6.5B=17 Standard16+Nursery1, internally consistent); got ' + sep13.categories.pair.cortex);
  assert(sep13.categories.pair.input === 18, 'Input Pair = 18 (registered 4.5B=18, 6.5B=18); got ' + sep13.categories.pair.input);
  assert(sep13.categories.pair.diff === 1, 'diff = Input(18) - Cortex(17) = +1 -> 🚨 Input +1台; got ' + sep13.categories.pair.diff);
  assert(sep13.categories.bike2h.status === 'ok' && sep13.categories.bike2h.cortex === 8 && sep13.categories.bike2h.input === 8, 'Bike 2h normal on 2026-09-13');
  assert(sep13.categories.bike3h.status === 'ok' && sep13.categories.bike3h.cortex === 8 && sep13.categories.bike3h.input === 8, 'Bike 3h normal on 2026-09-13 (DA Onboarding at the same 3h duration correctly excluded from Bike)');
  assert(sep13.categories.eightB.status === 'ok' && sep13.categories.eightB.cortex === 12 && sep13.categories.eightB.input === 12, '8B normal on 2026-09-13 (Standard 9 + Nursery L3 1 + Nursery L1 2 = 12)');

  var sep14 = cmp.days.filter(function (d) { return d.date === '2026-09-14'; })[0];
  assert(sep14.dayStatus === 'ok', '2026-09-14 is a genuinely normal day in the real data; got ' + sep14.dayStatus);

  var sep17 = cmp.days.filter(function (d) { return d.date === '2026-09-17'; })[0];
  assert(sep17.dayStatus === 'ok', '2026-09-17 stays normal even though Cortex has a "DA Onboarding" row at the same 3h duration as Bike (must not be miscounted as Bike); got ' + sep17.dayStatus);

  // 2026-09-12 note: the task text originally assumed both 9/12 and 9/13 would show
  // "Input +1". The real GDS Weekly Report CSV provided for this task only covers
  // 2026-09-13..19 (confirmed above) — 9/12 is simply outside the Weekly Report's own
  // date coverage, so per spec ("Weekly Reportに含まれる各日付について比較") it is not
  // an audited date at all (not even shown as 判定不可) — it must not appear in results.
  var sep12 = cmp.days.filter(function (d) { return d.date === '2026-09-12'; })[0];
  assert(!sep12, '2026-09-12 is outside the real Weekly Report\'s date range, so it must not appear as an audited day');

  console.log('ok: real-data end-to-end (2026-09-13 Pair +1 reproduced, other real days verified)');
})();

// ===== 2) Pair internal inconsistency must never be silently resolved =====
(function () {
  const csv = '﻿日付,ステーション,プロバイダーショートコード,サービスタイプ,計画された時間,計画された合計距離,合計距離手当,計画された距離単位,AMZL遅延キャンセル,Provider late cancel,クイックカバー,承諾済み,完了したルート\n' +
    '2026-09-20,Fukuoka (OFK3) - Amazon.com,GDS,Standard Parcel,4時間30分,100,100,キロメートル,該当なし,該当なし,該当なし,該当なし,17\n' +
    '2026-09-20,Fukuoka (OFK3) - Amazon.com,GDS,Standard Parcel,6時間30分,100,100,キロメートル,該当なし,該当なし,該当なし,該当なし,18\n';
  const cortex = Core.parseCortexWeeklyCsv(csv);
  assert(cortex.ok, 'synthetic minimal CSV parses');
  assert(cortex.byDate['2026-09-20'].pair45 === 17 && cortex.byDate['2026-09-20'].pair65 === 18, 'raw 4.5B/6.5B captured as-is (17 vs 18)');

  const input = { ok: true, byDate: { '2026-09-20': { eightB: 0, pair45: 17, pair65: 17, bike2h: 0, bike3h: 0 } } };
  const cmp = Core.compareGdsFleet(cortex, input);
  var day = cmp.days[0];
  assert(day.categories.pair.status === 'inconsistent', 'Cortex 4.5B(17) != 6.5B(18) must be flagged inconsistent, never averaged/guessed; got ' + day.categories.pair.status);
  assert(day.categories.pair.cortex === null, 'inconsistent Pair must not expose a fabricated single Cortex value');
  assert(day.dayStatus === 'alert', 'a day with Pair inconsistency counts as needing attention (alert), not silently ok');
  console.log('ok: Cortex Pair 4.5B/6.5B internal inconsistency is never silently resolved');
})();

// ===== 3) Missing data must never be treated as 0===0 "normal" =====
(function () {
  const csv = '﻿日付,ステーション,プロバイダーショートコード,サービスタイプ,計画された時間,計画された合計距離,合計距離手当,計画された距離単位,AMZL遅延キャンセル,Provider late cancel,クイックカバー,承諾済み,完了したルート\n' +
    '2026-09-21,Fukuoka (OFK3) - Amazon.com,GDS,Standard Parcel,8時間,100,100,キロメートル,該当なし,該当なし,該当なし,該当なし,12\n';
  const cortex = Core.parseCortexWeeklyCsv(csv);
  // InputFile has no column at all for this date (e.g. file predates it) -> byDate has no entry
  const input = { ok: true, byDate: {} };
  const cmp = Core.compareGdsFleet(cortex, input);
  var day = cmp.days[0];
  assert(day.categories.eightB.status === 'unknown', '8B must be "unknown" (判定不可), never a fabricated 0-vs-0 match; got ' + day.categories.eightB.status);
  assert(day.categories.eightB.input === null, 'missing input must surface as null, not 0');
  assert(day.categories.pair.status === 'unknown', 'Pair also unknown when Input side is entirely missing');
  assert(day.dayStatus === 'unknown', 'day-level status reflects missing data, distinct from both ok and alert; got ' + day.dayStatus);
  console.log('ok: missing InputFile data never collapses into a false 0=0 match');
})();

// ===== 4) Nursery all-levels summing (8B / Pair) =====
(function () {
  const csv = '﻿日付,ステーション,プロバイダーショートコード,サービスタイプ,計画された時間,計画された合計距離,合計距離手当,計画された距離単位,AMZL遅延キャンセル,Provider late cancel,クイックカバー,承諾済み,完了したルート\n' +
    '2026-09-22,Fukuoka (OFK3) - Amazon.com,GDS,Standard Parcel,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,11\n' +
    '2026-09-22,Fukuoka (OFK3) - Amazon.com,GDS,Nursery Route Level 1,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,1\n' +
    '2026-09-22,Fukuoka (OFK3) - Amazon.com,GDS,Nursery Route Level 2,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,1\n' +
    '2026-09-22,Fukuoka (OFK3) - Amazon.com,GDS,Nursery Route Level 3,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,1\n';
  const cortex = Core.parseCortexWeeklyCsv(csv);
  assert(cortex.byDate['2026-09-22'].eightB === 14, 'Standard(11) + Nursery L1(1) + L2(1) + L3(1) = 14; got ' + cortex.byDate['2026-09-22'].eightB);
  console.log('ok: Nursery all-Level summation for 8B');
})();

// ===== 5) Bike Cycle_1 + Cycle_2 summation on the InputFile side =====
(function () {
  const rows = [
    ['note'], ['note2'], ['*'],
    ['DSP', 'NodeP', 'Node', 'DS Name', 'Type', 'Memo', 'ServiceType', 'Cycle', 'Block', 'B/S', 46280],
    ['GDS', 'DFK2', 'OFK3', '', 'Biker', '', 'Biker (Rear Cargo - Large)', 'CYCLE_1', 2, '2B', 3],
    ['GDS', 'DFK2', 'OFK3', '', 'Biker', '', 'Biker (Rear Cargo - Large)', 'CYCLE_2', 2, '2B', 5],
    ['GDS', 'DFK2', 'OFK3', '', 'Biker', '', 'Biker (Rear Cargo - Large)', 'CYCLE_1', 3, '3B', 4],
    ['GDS', 'DFK2', 'OFK3', '', 'Biker', '', 'Biker (Rear Cargo - Large)', 'CYCLE_2', 3, '3B', 4],
    ['GDS', 'OTHR', 'DCJ1', '', 'Biker', '', 'Biker (Rear Cargo - Large)', 'CYCLE_1', 2, '2B', 99] // non-OFK3, must be ignored
  ];
  var result = Core.parseInputFileRows(rows);
  assert(result.ok, 'synthetic Bike-only sheet parses: ' + result.error);
  var d = result.byDate[Core.excelSerialToIsoDate(46280)];
  assert(d.bike2h === 8, 'Bike 2h = CYCLE_1(3) + CYCLE_2(5) = 8, non-OFK3 row(99) excluded; got ' + d.bike2h);
  assert(d.bike3h === 8, 'Bike 3h = CYCLE_1(4) + CYCLE_2(4) = 8; got ' + d.bike3h);
  assert(result.meta.ofk3Rows === 4, 'exactly 4 OFK3 rows counted, the DCJ1 row excluded; got ' + result.meta.ofk3Rows);
  console.log('ok: Bike Cycle_1+Cycle_2 InputFile summation, non-OFK3 station excluded');
})();

// ===== 6) OFK3-only extraction on the Cortex CSV side =====
(function () {
  const csv = '﻿日付,ステーション,プロバイダーショートコード,サービスタイプ,計画された時間,計画された合計距離,合計距離手当,計画された距離単位,AMZL遅延キャンセル,Provider late cancel,クイックカバー,承諾済み,完了したルート\n' +
    '2026-09-23,Fukuoka (OFK3) - Amazon.com,GDS,Standard Parcel,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,5\n' +
    '2026-09-23,Osaka (OSK1) - Amazon.com,GDS,Standard Parcel,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,99\n';
  const cortex = Core.parseCortexWeeklyCsv(csv);
  assert(cortex.meta.ofk3Rows === 1, 'only the OFK3 station row counted, OSK1 excluded; got ' + cortex.meta.ofk3Rows);
  assert(cortex.byDate['2026-09-23'].eightB === 5, 'OSK1\'s 99 must not leak into OFK3 totals; got ' + cortex.byDate['2026-09-23'].eightB);
  console.log('ok: non-OFK3 stations excluded from Cortex CSV aggregation');
})();

// ===== 7) Date normalization: Excel serial -> ISO without off-by-one =====
(function () {
  // Cross-checked against the real InputFile header (verified earlier against the actual file).
  assert(Core.excelSerialToIsoDate(45658) === '2025-01-01', 'known real header serial 45658 -> 2025-01-01; got ' + Core.excelSerialToIsoDate(45658));
  assert(Core.excelSerialToIsoDate(46354) === '2026-11-28', 'known real header serial 46354 -> 2026-11-28; got ' + Core.excelSerialToIsoDate(46354));
  assert(Core.normalizeDateLoose('2026-09-13') === '2026-09-13', 'already-ISO date passes through unchanged');
  assert(Core.normalizeDateLoose('2026/9/3') === '2026-09-03', 'slash-separated single-digit date normalized with zero-padding');
  console.log('ok: date normalization (Excel serial + loose text) matches verified real values, no off-by-one');
})();

// ===== 8) Duplicate row detection surfaces a warning without breaking legitimate multi-row sums =====
(function () {
  const line = '2026-09-24,Fukuoka (OFK3) - Amazon.com,GDS,Standard Parcel,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,3';
  const csv = '﻿日付,ステーション,プロバイダーショートコード,サービスタイプ,計画された時間,計画された合計距離,合計距離手当,計画された距離単位,AMZL遅延キャンセル,Provider late cancel,クイックカバー,承諾済み,完了したルート\n' +
    line + '\n' + line + '\n' +
    '2026-09-24,Fukuoka (OFK3) - Amazon.com,GDS,Nursery Route Level 1,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,2\n';
  const cortex = Core.parseCortexWeeklyCsv(csv);
  assert(cortex.meta.warnings.length === 1, 'exact full-row duplicate flagged once; got ' + JSON.stringify(cortex.meta.warnings));
  assert(cortex.byDate['2026-09-24'].eightB === 8, 'legitimate distinct rows (Standard x2 + Nursery) still sum normally: 3+3+2=8; got ' + cortex.byDate['2026-09-24'].eightB);
  console.log('ok: exact duplicate CSV rows are flagged but do not block normal multi-row summation');
})();

// ===== 9) Missing/empty inputs never throw =====
(function () {
  var r1 = Core.parseCortexWeeklyCsv('');
  assert(r1.ok === false && Array.isArray(r1.meta.warnings), 'empty CSV -> ok:false, not a throw');
  var r2 = Core.parseInputFileRows([]);
  assert(r2.ok === false, 'empty rows -> ok:false, not a throw');
  var r3 = Core.parseInputFileRows([['unrelated', 'sheet']]);
  assert(r3.ok === false, 'a sheet without Node/Block/B-S headers -> ok:false, not a throw (used to skip non-matching sheets)');
  console.log('ok: malformed/empty inputs degrade gracefully, no throw');
})();

console.log('ok gds-fleet-audit-core');
