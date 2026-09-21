import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Core = require('../gds-fleet-audit-core.js');
const XLSX = require('xlsx');
const coreSrc = readFileSync(new URL('../gds-fleet-audit-core.js', import.meta.url), 'utf8');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures', 'gds-fleet-audit');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

// ===== Static assertions: Phase 1.1 removed the "Pair" composite category and its
// internal-consistency check entirely (not just hidden in the UI) =====
assert(coreSrc.indexOf('pair45') < 0 && coreSrc.indexOf('pair65') < 0, 'old pair45/pair65 keys must be fully renamed, not left as dead code');
assert(coreSrc.indexOf('resolvePair') < 0 && coreSrc.indexOf('buildPairResult') < 0, 'Pair internal-consistency resolution functions must be removed, not just unused');
assert(coreSrc.indexOf("'inconsistent'") < 0, 'the "inconsistent" status must no longer be producible anywhere in the core');
assert(coreSrc.indexOf('block6_5') >= 0 && coreSrc.indexOf('block4_5') >= 0, '6.5B and 4.5B are independent keys');

// ===== 1) Real-data end-to-end: reproduce the 2026-09-13 discrepancy at Block granularity =====
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
  assert(cmp.summary.alert === 1, 'exactly 1 day has a real discrepancy (2026-09-13); got ' + cmp.summary.alert);
  assert(cmp.summary.ok === 6, '6 days are genuinely normal; got ' + cmp.summary.ok);
  assert(cmp.summary.unknown === 0, 'no missing-data days inside the Weekly Report\'s own range; got ' + cmp.summary.unknown);

  const sep13 = cmp.days.filter(function (d) { return d.date === '2026-09-13'; })[0];
  assert(sep13, '2026-09-13 present in results');
  assert(sep13.dayStatus === 'alert', '2026-09-13 day status is alert; got ' + sep13.dayStatus);

  // Real-data finding (Phase 1.1): decomposing the old "Pair 17/18" result shows that on
  // 2026-09-13 BOTH 6.5B and 4.5B are independently short by 1 versus InputFile — not just
  // one of them. This is the actual confirmed breakdown, not copied from the old Pair value.
  assert(sep13.categories.block6_5.status === 'alert', '6.5B independently flagged; got ' + sep13.categories.block6_5.status);
  assert(sep13.categories.block6_5.cortex === 17, 'Cortex 6.5B = 17 (Nursery L3 1 + Standard 16); got ' + sep13.categories.block6_5.cortex);
  assert(sep13.categories.block6_5.input === 18, 'Input 6.5B = 18 (registered); got ' + sep13.categories.block6_5.input);
  assert(sep13.categories.block6_5.diff === 1, '6.5B diff = Input(18) - Cortex(17) = +1; got ' + sep13.categories.block6_5.diff);

  assert(sep13.categories.block4_5.status === 'alert', '4.5B independently flagged; got ' + sep13.categories.block4_5.status);
  assert(sep13.categories.block4_5.cortex === 17, 'Cortex 4.5B = 17 (Nursery L3 1 + Standard 16); got ' + sep13.categories.block4_5.cortex);
  assert(sep13.categories.block4_5.input === 18, 'Input 4.5B = 18 (registered); got ' + sep13.categories.block4_5.input);
  assert(sep13.categories.block4_5.diff === 1, '4.5B diff = Input(18) - Cortex(17) = +1; got ' + sep13.categories.block4_5.diff);

  assert(sep13.categories.bike2h.status === 'ok' && sep13.categories.bike2h.cortex === 8 && sep13.categories.bike2h.input === 8, 'Bike 2h normal on 2026-09-13');
  assert(sep13.categories.bike3h.status === 'ok' && sep13.categories.bike3h.cortex === 8 && sep13.categories.bike3h.input === 8, 'Bike 3h normal on 2026-09-13 (DA Onboarding at the same 3h duration correctly excluded from Bike)');
  assert(sep13.categories.eightB.status === 'ok' && sep13.categories.eightB.cortex === 12 && sep13.categories.eightB.input === 12, '8B normal on 2026-09-13 (Standard 9 + Nursery L3 1 + Nursery L1 2 = 12)');

  var sep14 = cmp.days.filter(function (d) { return d.date === '2026-09-14'; })[0];
  assert(sep14.dayStatus === 'ok', '2026-09-14 is a genuinely normal day in the real data; got ' + sep14.dayStatus);
  assert(sep14.categories.block6_5.cortex === 18 && sep14.categories.block4_5.cortex === 18, '2026-09-14: Cortex 6.5B and 4.5B both 18 (independently computed, happen to be equal here, which is fine but not required)');

  var sep17 = cmp.days.filter(function (d) { return d.date === '2026-09-17'; })[0];
  assert(sep17.dayStatus === 'ok', '2026-09-17 stays normal even though Cortex has a "DA Onboarding" row at the same 3h duration as Bike (must not be miscounted as Bike); got ' + sep17.dayStatus);

  // 2026-09-12 note: the original task text assumed both 9/12 and 9/13 would show a
  // discrepancy. The real GDS Weekly Report CSV provided only covers 2026-09-13..19
  // (confirmed above) — 9/12 is outside the Weekly Report's own date coverage, so per
  // spec ("Weekly Reportに含まれる各日付について比較") it is not an audited date at all.
  var sep12 = cmp.days.filter(function (d) { return d.date === '2026-09-12'; })[0];
  assert(!sep12, '2026-09-12 is outside the real Weekly Report\'s date range, so it must not appear as an audited day');

  console.log('ok: real-data end-to-end (2026-09-13 decomposed: BOTH 6.5B and 4.5B independently +1, confirmed from real data)');
})();

// ===== 2) 欠車 (short-crewed) case: 6.5B and 4.5B legitimately differ and must be judged
// independently — this is never flagged as an internal inconsistency, and the two
// categories must never be netted/cancelled against each other =====
(function () {
  const cortex = {
    ok: true,
    byDate: {
      '2026-09-20': { eightB: 0, block6_5: 17, block4_5: 16, bike2h: 0, bike3h: 0, bikeByCycle: {}, otherServiceTypes: {} }
    }
  };
  const input = {
    ok: true,
    byDate: {
      '2026-09-20': { eightB: 0, block6_5: 17, block4_5: 17, bike2h: 0, bike3h: 0, bikeByCycle: {} }
    }
  };
  const cmp = Core.compareGdsFleet(cortex, input);
  var day = cmp.days[0];
  assert(day.categories.block6_5.status === 'ok' && day.categories.block6_5.diff === 0, '6.5B: Cortex 17 / Input 17 -> ok; got ' + JSON.stringify(day.categories.block6_5));
  assert(day.categories.block4_5.status === 'alert' && day.categories.block4_5.diff === 1, '4.5B: Cortex 16 / Input 17 -> alert +1; got ' + JSON.stringify(day.categories.block4_5));
  assert(day.categories.block6_5.status !== 'inconsistent' && day.categories.block4_5.status !== 'inconsistent', 'Cortex 6.5B(17) != 4.5B(16) must NEVER be treated as an internal inconsistency — this is a legitimate 欠車 (short-crew) scenario, not a Cortex data problem');
  assert(day.dayStatus === 'alert', 'overall day status is alert because 4.5B alone differs; got ' + day.dayStatus);
  console.log('ok: 欠車 case - 6.5B and 4.5B judged fully independently, no cancellation, no fabricated "inconsistent" status');
})();

// ===== 3) Missing data must never be treated as 0===0 "normal", for every independent category =====
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
  assert(day.categories.block6_5.status === 'unknown' && day.categories.block4_5.status === 'unknown', '6.5B and 4.5B independently unknown when Input side is entirely missing');
  assert(day.dayStatus === 'unknown', 'day-level status reflects missing data, distinct from both ok and alert; got ' + day.dayStatus);
  console.log('ok: missing InputFile data never collapses into a false 0=0 match, for every independent category');
})();

// ===== 4) Nursery all-levels summing (8B / 6.5B / 4.5B) =====
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

// ===== 5) InputFile Bike: aggregate stays Cycle_1+Cycle_2 summed (used for the actual
// audit, since Cortex cannot be split by Cycle — see test 7), but per-Cycle detail is
// retained in bikeByCycle and never lost =====
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
  assert(d.bike2h === 8, 'Bike 2h aggregate = CYCLE_1(3) + CYCLE_2(5) = 8, non-OFK3 row(99) excluded; got ' + d.bike2h);
  assert(d.bike3h === 8, 'Bike 3h aggregate = CYCLE_1(4) + CYCLE_2(4) = 8; got ' + d.bike3h);
  assert(result.meta.ofk3Rows === 4, 'exactly 4 OFK3 rows counted, the DCJ1 row excluded; got ' + result.meta.ofk3Rows);

  // Phase 1.1: per-Cycle detail must survive, not be summed away silently.
  assert(d.bikeByCycle['CYCLE_1'].bike2h === 3, 'CYCLE_1 2B retained independently = 3; got ' + d.bikeByCycle['CYCLE_1'].bike2h);
  assert(d.bikeByCycle['CYCLE_2'].bike2h === 5, 'CYCLE_2 2B retained independently = 5; got ' + d.bikeByCycle['CYCLE_2'].bike2h);
  assert(d.bikeByCycle['CYCLE_1'].bike3h === 4, 'CYCLE_1 3B retained independently = 4; got ' + d.bikeByCycle['CYCLE_1'].bike3h);
  assert(d.bikeByCycle['CYCLE_2'].bike3h === 4, 'CYCLE_2 3B retained independently = 4; got ' + d.bikeByCycle['CYCLE_2'].bike3h);
  assert(JSON.stringify(d.bikeByCycle).indexOf('99') < 0, 'non-OFK3 row (count=99) never contributes to bikeByCycle either');
  console.log('ok: InputFile Bike retains per-Cycle detail (bikeByCycle) alongside the aggregate, nothing silently summed away');
})();

// ===== 6) Real InputFile: confirm the same per-Cycle retention against the real fixture =====
(function () {
  const wb = XLSX.readFile(join(fixturesDir, 'dsp1.0_inputfile_gds_trimmed.xlsx'));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['InputFile'], { header: 1, defval: '' });
  const input = Core.parseInputFileRows(rows);
  var d = input.byDate['2026-09-13'];
  assert(d.bikeByCycle['CYCLE_1'] && d.bikeByCycle['CYCLE_2'], 'real InputFile OFK3 Bike rows split into CYCLE_1/CYCLE_2 as expected; got ' + JSON.stringify(Object.keys(d.bikeByCycle)));
  assert(d.bikeByCycle['CYCLE_1'].bike2h + d.bikeByCycle['CYCLE_2'].bike2h === d.bike2h, 'per-Cycle Bike 2h sums back to the aggregate exactly');
  assert(d.bikeByCycle['CYCLE_1'].bike3h + d.bikeByCycle['CYCLE_2'].bike3h === d.bike3h, 'per-Cycle Bike 3h sums back to the aggregate exactly');
  console.log('ok: real InputFile Bike Cycle retention verified (CYCLE_1=' + JSON.stringify(d.bikeByCycle['CYCLE_1']) + ', CYCLE_2=' + JSON.stringify(d.bikeByCycle['CYCLE_2']) + ')');
})();

// ===== 7) Cortex-side Bike Cycle identification: confirmed NOT possible from the real
// GDS Weekly Report CSV — no Cycle/Wave/Sort Zone/Start Time/Delivery Window column exists.
// This test locks in that finding (so a future edit can't silently start guessing a split)
// and confirms the core does not fabricate one. =====
(function () {
  const csvText = readFileSync(join(fixturesDir, 'GDS_Weekly_Report-2026-09-13.csv'), 'utf8');
  const header = csvText.replace(/^﻿/, '').split(/\r?\n/)[0].split(',');
  var cycleLike = header.filter(function (h) {
    var u = h.toUpperCase();
    return u.indexOf('CYCLE') >= 0 || u.indexOf('WAVE') >= 0 || u.indexOf('SORT ZONE') >= 0 || u.indexOf('START TIME') >= 0 || u.indexOf('DELIVERY WINDOW') >= 0;
  });
  assert(cycleLike.length === 0, 'confirmed: the real Cortex GDS Weekly Report CSV header has no Cycle-identifying column (checked: ' + header.join(' | ') + ')');

  // sanity: the parseCortexWeeklyCsv function body itself must never reference a
  // Cycle column, since the source data has none to reference.
  var fnStart = coreSrc.indexOf('function parseCortexWeeklyCsv');
  var fnEnd = coreSrc.indexOf('\n  var INPUT_REQUIRED_COLS', fnStart);
  var fnBody = coreSrc.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
  assert(fnBody.indexOf('Cycle') < 0, 'parseCortexWeeklyCsv must not reference a Cortex-side Cycle column that does not exist in the real data');

  // The Cortex parser result object itself must carry no per-Cycle Bike breakdown.
  const cortex = Core.parseCortexWeeklyCsv(csvText);
  assert(cortex.byDate['2026-09-13'].bikeByCycle && Object.keys(cortex.byDate['2026-09-13'].bikeByCycle).length === 0, 'Cortex-side bikeByCycle stays empty (never fabricated) because the source data cannot support it; got ' + JSON.stringify(cortex.byDate['2026-09-13'].bikeByCycle));
  console.log('ok: Cortex Weekly Report cannot identify Bike Cycle (real header checked); core never fabricates a Cortex-side Cycle split — Bike audit stays at the 2h/3h aggregate, the maximum safely verifiable granularity');
})();

// ===== 8) OFK3-only extraction on the Cortex CSV side =====
(function () {
  const csv = '﻿日付,ステーション,プロバイダーショートコード,サービスタイプ,計画された時間,計画された合計距離,合計距離手当,計画された距離単位,AMZL遅延キャンセル,Provider late cancel,クイックカバー,承諾済み,完了したルート\n' +
    '2026-09-23,Fukuoka (OFK3) - Amazon.com,GDS,Standard Parcel,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,5\n' +
    '2026-09-23,Osaka (OSK1) - Amazon.com,GDS,Standard Parcel,8時間,1,1,キロメートル,該当なし,該当なし,該当なし,該当なし,99\n';
  const cortex = Core.parseCortexWeeklyCsv(csv);
  assert(cortex.meta.ofk3Rows === 1, 'only the OFK3 station row counted, OSK1 excluded; got ' + cortex.meta.ofk3Rows);
  assert(cortex.byDate['2026-09-23'].eightB === 5, 'OSK1\'s 99 must not leak into OFK3 totals; got ' + cortex.byDate['2026-09-23'].eightB);
  console.log('ok: non-OFK3 stations excluded from Cortex CSV aggregation');
})();

// ===== 9) Date normalization: Excel serial -> ISO without off-by-one =====
(function () {
  // Cross-checked against the real InputFile header (verified earlier against the actual file).
  assert(Core.excelSerialToIsoDate(45658) === '2025-01-01', 'known real header serial 45658 -> 2025-01-01; got ' + Core.excelSerialToIsoDate(45658));
  assert(Core.excelSerialToIsoDate(46354) === '2026-11-28', 'known real header serial 46354 -> 2026-11-28; got ' + Core.excelSerialToIsoDate(46354));
  assert(Core.normalizeDateLoose('2026-09-13') === '2026-09-13', 'already-ISO date passes through unchanged');
  assert(Core.normalizeDateLoose('2026/9/3') === '2026-09-03', 'slash-separated single-digit date normalized with zero-padding');
  console.log('ok: date normalization (Excel serial + loose text) matches verified real values, no off-by-one');
})();

// ===== 10) Duplicate row detection surfaces a warning without breaking legitimate multi-row sums =====
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

// ===== 11) Missing/empty inputs never throw =====
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
