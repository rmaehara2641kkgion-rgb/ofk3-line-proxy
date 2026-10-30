// 11時間接近の欠損理由表示。時間合計と判定区分はコアの戻り値と一致させる。
// 日付と記号は架空であり、本番の人数や実ブックは期待値にしない。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const Core = require('../rolling60h-core.js');
const View = require('../rolling60h-prefix-view.js');

function roster(code) {
  return Core.parseShiftCellToBlocks(code, 'roster').blocks;
}

function actual(hours) {
  return [{ code: 'ACT', rawCode: String(hours), source: 'actual', hours: hours, defined: true }];
}

function seriesFromMap(map, start, end) {
  return Core.buildContinuousDailySeries(map, start, end);
}

function assess(name, series, referenceDate, amazonLoaded) {
  const windows = Core.computeRolling60h(series, { limitHours: 60, warningHours: 60 });
  const prefix = Core.prefixHoursBeforeToday(series, referenceDate);
  const today = series.filter(function (day) { return day && day.date === referenceDate; })[0];
  const duty = Core.todayDutyFromBlocks(today && today.blocks);
  const margin = Core.approachByMargin(prefix, duty);
  const row = View.assessDriver(Core, {
    name: name,
    transportId: 'T-' + name,
    series: series,
    windows: windows,
    referenceDate: referenceDate,
    amazonLoaded: !!amazonLoaded,
  });
  assert.equal(row.prefixHours, prefix);
  assert.equal(row.margin, margin.notice);
  assert.equal(row.marginReason, margin.reason);
  const ending = windows.filter(function (item) { return item.endDate === referenceDate; })[0];
  if (ending) {
    assert.equal(row.windowJudgment, ending.judgment);
    assert.equal(row.windowHours, ending.totalHours);
  }
  return row;
}

const ref = '2026-10-31';
const eight = roster('8');
const rest = roster('休');
const filled = {};
['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].forEach(function (date) {
  filled[date] = eight;
});

const complete = assess('揃い', seriesFromMap(filled, '2026-10-25', '2026-10-31'), ref, false);
assert.equal(complete.prefixHours, 48);
assert.equal(complete.margin, 'none');
assert.equal(complete.gapReason, '');
assert.equal(complete.windowJudgment, 'within');

const missing30map = Object.assign({}, filled);
delete missing30map['2026-10-30'];
const missing30 = assess('三十欠', seriesFromMap(missing30map, '2026-10-25', '2026-10-31'), ref, false);
assert.equal(missing30.prefixHours, null);
assert.equal(missing30.margin, 'none');
assert.equal(missing30.marginReason, '当日を含まない6日累計が取得不可');
assert.equal(missing30.windowJudgment, 'undetermined');
assert.match(missing30.gapReason, /10月30日の勤務データが未読込のため、過去6日累計を計算できません/);
assert.match(missing30.gapReason, /その日のシフト表かAmazon実績を読み込んでください/);
assert.equal(missing30.gapReason.includes('10月25日'), false);
assert.equal(missing30.gapReason.includes('10月31日'), false);

const missingManyMap = Object.assign({}, filled);
delete missingManyMap['2026-10-28'];
delete missingManyMap['2026-10-30'];
const missingMany = assess('複数欠', seriesFromMap(missingManyMap, '2026-10-25', '2026-10-31'), ref, false);
assert.equal(missingMany.prefixHours, null);
assert.match(missingMany.gapReason, /10月28日・10月30日の勤務データが未読込/);
assert.equal(missingMany.gapReason.includes('10月27日'), false);

const withRest = Object.assign({}, filled, { '2026-10-30': rest });
const rested = assess('休み', seriesFromMap(withRest, '2026-10-25', '2026-10-31'), ref, false);
assert.equal(rested.prefixHours, 40);
assert.equal(rested.gapReason, '');
assert.equal(rested.windowJudgment, 'within');
const restDay = seriesFromMap(withRest, '2026-10-30', '2026-10-30')[0];
assert.equal(restDay.dailyTotalHours, 0);
assert.equal(restDay.noData, false);
assert.equal(restDay.hasUnconfirmed, false);

const blankMap = Object.assign({}, filled, {
  '2026-10-30': [{ code: 'BLANK', rawCode: '', source: 'roster', hours: null, defined: false, blank: true }],
});
const blank = assess('空白', seriesFromMap(blankMap, '2026-10-25', '2026-10-31'), ref, false);
assert.equal(blank.prefixHours, null);
assert.notEqual(blank.prefixHours, 0);
assert.match(blank.gapReason, /10月30日のシフトが未確定のため、過去6日累計を計算できません/);
assert.equal(blank.gapReason.includes('未読込'), false);

const unknownMap = Object.assign({}, filled, { '2026-10-27': roster('研修') });
const unknown = assess('記号', seriesFromMap(unknownMap, '2026-10-25', '2026-10-31'), ref, false);
assert.equal(unknown.prefixHours, null);
assert.match(unknown.gapReason, /10月27日に未定義の勤務記号があるため、過去6日累計を計算できません/);
assert.equal(unknown.gapReason.includes('未読込'), false);

const amazonMap = {};
['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].forEach(function (date) {
  amazonMap[date] = actual(8);
});
const amazonOnly = assess('実績のみ', seriesFromMap(amazonMap, '2026-10-23', '2026-10-29'), ref, true);
assert.equal(amazonOnly.prefixHours, null);
assert.match(amazonOnly.gapReason, /10月30日の勤務データが未読込/);
assert.equal(amazonOnly.basisText.includes('実績判定済み'), false);

const spanMap = {
  '2026-10-26': eight,
  '2026-10-27': eight,
  '2026-10-28': eight,
  '2026-10-29': eight,
  '2026-10-31': eight,
  '2026-11-01': eight,
};
const span = assess('月跨ぎ', seriesFromMap(spanMap, '2026-10-26', '2026-11-01'), '2026-11-01', false);
assert.equal(span.prefixHours, null);
assert.equal(span.prefixStart, '2026-10-26');
assert.equal(span.prefixEnd, '2026-10-31');
assert.match(span.gapReason, /10月30日の勤務データが未読込/);
assert.equal(span.gapReason.includes('10月31日'), false);
const kept = seriesFromMap(spanMap, '2026-10-31', '2026-10-31')[0];
assert.equal(kept.dailyTotalHours, 8);
assert.equal(kept.noData, false);

const novRefMap = Object.assign({}, filled);
delete novRefMap['2026-10-30'];
delete novRefMap['2026-10-31'];
novRefMap['2026-11-01'] = eight;
const novRef = assess('翌日', seriesFromMap(novRefMap, '2026-10-25', '2026-11-01'), '2026-11-01', false);
assert.equal(novRef.prefixStart, '2026-10-26');
assert.equal(novRef.prefixEnd, '2026-10-31');
assert.equal(novRef.prefixHours, null);
assert.match(novRef.gapReason, /10月30日・10月31日の勤務データが未読込/);

const conflictMap = Object.assign({}, filled, {
  '2026-10-29': [{ code: 'CONFLICT', rawCode: '○ / 休', source: 'roster', hours: null, defined: false, conflict: true }],
});
const conflict = assess('衝突', seriesFromMap(conflictMap, '2026-10-25', '2026-10-31'), ref, false);
assert.equal(conflict.prefixHours, null);
assert.match(conflict.gapReason, /10月29日の勤務データが衝突しているため/);

const html = View.renderHtml(View.summarize([missing30, complete], { referenceDate: ref, amazonLoaded: false }));
assert.match(html, /10月30日の勤務データが未読込のため、過去6日累計を計算できません/);
assert.equal(html.includes('揃い'), false);
assert.equal(html.includes('当日を含まない6日累計が取得不可'), false);
const printed = View.renderPrintHtml(View.summarize([missing30], { referenceDate: ref, amazonLoaded: false }));
assert.match(printed, /10月30日の勤務データが未読込/);

console.log('rolling60h prefix gap reason tests passed');
