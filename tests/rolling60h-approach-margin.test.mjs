// 11時間接近判定。元の未コミットテストから、core と既存 view だけで完結する部分。
// harvest 実行系とダッシュボードは月跨ぎ土台と別系統のため、ここには含めない。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const Core = require('../rolling60h-core.js');
const View = require('../inoichi-rolling-view.js');

function day(date, hours) {
  return { date: date, dailyTotalHours: hours, actualHours: hours, rosterHours: 0, hasUndefinedHours: false, noData: false, blocks: [] };
}

function seriesFrom(start, hoursList) {
  return hoursList.map(function (hours, index) {
    return day(Core.addDays(start, index), hours);
  });
}

assert.equal(Core.APPROACH_MARGIN_HOURS, 11);
assert.equal(Core.APPROACH_RULE, 'prefix6-margin11');

// 2026-10-01 は基準日の7日前。当日を含む窓には入らない。
const hours = [9, 8, 8, 8, 8, 8, 8, 5];
const series = seriesFrom('2026-10-01', hours);
const windows = Core.computeRolling60h(series, { limitHours: 60, warningHours: 60 });
const prefix = Core.prefixHoursBeforeToday(series, '2026-10-08');
const yesterdayWindow = Core.priorWindowTotal(windows, '2026-10-08');
const todayWindow = windows.filter(function (window) { return window.endDate === '2026-10-08'; })[0];
assert.equal(prefix, 48);
assert.equal(yesterdayWindow, 57);
assert.notEqual(prefix, yesterdayWindow);
assert.equal(todayWindow.startDate, '2026-10-02');
assert.equal(todayWindow.endDate, '2026-10-08');
assert.equal(todayWindow.totalHours, 53);
assert.equal(prefix + 5, todayWindow.totalHours);
assert.equal(todayWindow.judgment === 'exceed', false);

assert.equal(Core.approachByMargin(48 + 59 / 60, 'work').notice, 'none');
assert.equal(Core.approachByMargin(49, 'work').notice, 'approach');
assert.equal(Core.approachByMargin(58.5, 'work').notice, 'approach');
assert.equal(Core.approachByMargin(60, 'work').notice, 'approach');
assert.equal(Core.approachByMargin(58.5, 'off').notice, 'excluded');
assert.equal(Core.approachByMargin(58.5, 'unknown').notice, 'unconfirmed');
assert.equal(Core.approachByMargin(60.01, 'work').notice, 'none');
assert.equal(Core.approachByMargin(null, 'work').notice, 'none');
assert.equal(Core.approachByMargin(null, 'work').reason, '当日を含まない6日累計が取得不可');

assert.equal(Core.todayDutyFromBlocks([{ code: 'KYU', hours: 0, defined: true }]), 'off');
assert.equal(Core.todayDutyFromBlocks([{ code: 'C1', hours: 6.5, defined: true }]), 'work');
assert.equal(Core.todayDutyFromBlocks([{ code: '', hours: null, defined: false }]), 'unknown');
assert.equal(Core.todayDutyFromBlocks([]), 'unknown');

const undefinedSeries = seriesFrom('2026-10-02', [8, 8, 8, 8, 8, 8]);
undefinedSeries[2].hasUndefinedHours = true;
undefinedSeries[2].dailyTotalHours = 0;
assert.equal(Core.prefixHoursBeforeToday(undefinedSeries, '2026-10-08'), null);

const unconfirmedSeries = seriesFrom('2026-10-02', [8, 8, 8, 8, 8, 8]);
unconfirmedSeries[2].hasUnconfirmed = true;
unconfirmedSeries[2].dailyTotalHours = 0;
assert.equal(Core.prefixHoursBeforeToday(unconfirmedSeries, '2026-10-08'), null);

const forecastSeries = seriesFrom('2026-10-12', [9, 9, 9, 9, 9, 10, 8]);
const forecastWindows = Core.computeRolling60h(forecastSeries, { limitHours: 60, warningHours: 60 });
const forecastPrefix = Core.prefixHoursBeforeToday(forecastSeries, '2026-10-18');
assert.equal(forecastPrefix, 55);
assert.equal(forecastWindows[0].totalHours, 63);
assert.equal(forecastWindows[0].judgment, 'exceed');
assert.equal(Core.approachByMargin(forecastPrefix, 'work').notice, 'approach');

assert.equal(View.gapText(58.5, 'approach'), '1時間30分');
assert.equal(View.hourMinuteText(null), '取得不可');

console.log('rolling60h approach margin tests passed');
