import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dash = require('../duty-risk-dashboard.js');

function day(date, hours, origin) {
  return { date: date, hours: hours, origin: origin, future: origin === 'roster-plan' };
}

function windowFor(id, dates, hours, origins, level) {
  const days = dates.map((date, index) => day(date, hours[index], origins[index]));
  const total = days.every((item) => typeof item.hours === 'number') ? days.reduce((sum, item) => sum + item.hours, 0) : null;
  return { subjectId: id, start: dates[0], end: dates[6], predictedTotal: total, level: level || 'within', days: days };
}

const dates = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
const actual = ['daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'roster-plan'];
const close = windowFor('TID-CLOSE', dates, [8, 8, 8, 8, 8, 8.2, 11], actual);
const watch = windowFor('TID-WATCH', dates, [8, 8, 8, 8, 8, 6, 11], actual);
const room = windowFor('TID-ROOM', dates, [5, 5, 5, 5, 5, 5, 11], actual);
const off = windowFor('TID-OFF', dates, [10, 10, 10, 10, 10, 9.2, 0], actual);
const mixedOrigins = ['daily-estimate', 'daily-estimate', 'daily-estimate', 'roster-plan', 'daily-estimate', 'daily-estimate', 'roster-plan'];
const mixed = windowFor('TID-MIX', dates, [8, 8, 8, 0, 8, 8, 11], mixedOrigins);
const pureOrigins = ['daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate'];
const pure = windowFor('TID-PURE', dates, [4, 4, 4, 4, 4, 4, 4], pureOrigins);
const gap = windowFor('TID-GAP', dates, [null, 7, 0, 10, 10, 0, 8], ['missing', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'roster-plan'], 'undetermined');
const edge = windowFor('TID-EDGE', dates, [8, 8, 8, 8, 8, 4, 11], actual);
const edgeIn = windowFor('TID-EDGE-IN', dates, [8, 8, 8, 8, 8, 4.2, 11], actual);
const over = windowFor('TID-OVER', dates, [10, 10, 10, 10, 10, 10, 11], actual);
const twinA = windowFor('TID-SAME-A', dates, [1, 1, 1, 1, 1, 1, 1], pureOrigins);
const twinB = windowFor('TID-SAME-B', dates, [2, 2, 2, 2, 2, 2, 2], pureOrigins);
const zeroActual = windowFor('TID-ZERO-ACT', dates, [0, 8, 8, 8, 8, 8, 8], pureOrigins);
const futureDates = ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const future = windowFor('TID-FUTURE', futureDates, [11, 11, 11, 11, 11, 11, 0], actual, 'exceed');

const history = {
  runs: [{
    referenceDate: '2026-10-21',
    predictedAt: '2026-10-21T02:00:00.000Z',
    predictions: [close, watch, room, off, mixed, pure, gap, edge, edgeIn, over, twinA, twinB, zeroActual, future],
  }],
};
const snapshot = {
  checkedAt: '2026-10-21T02:00:00.000Z',
  basisCounts: { actualExceed: 0, forecastExceed: 1, planExceed: 2 },
  alerts: [
    { name: '架空 接近', disposition: 'exceed', basis: 'forecast', startDate: '2026-10-24', endDate: '2026-10-30', windowLabel: '2026-10-24 〜 2026-10-30', totalHours: 66, overBy: 6, actualHours: 55, rosterHours: 11, preTodayHours: 48.2, todayWindowHours: 59.2 },
    { name: '架空 範囲', disposition: 'clear', basis: 'actual', startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 41, preTodayHours: 30, todayWindowHours: 41 },
    { name: '架空 同姓', disposition: 'clear', basis: 'actual', startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 7, preTodayHours: 6, todayWindowHours: 7 },
    { name: '架空 同姓', disposition: 'clear', basis: 'actual', startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 14, preTodayHours: 12, todayWindowHours: 14 },
  ],
};

const view = dash.buildView(snapshot, history);
assert.equal(view.ok, true);
assert.equal(view.confirmed, 0);
assert.equal(view.watchNow, 2);
assert.equal(view.watchSoon, 2);
assert.equal(view.attention.length, 4);
assert.equal(view.attention[0].transportId, 'TID-OVER');
assert.equal(view.attention[0].forecastOver, true);
assert.equal(dash.marginText(view.attention[0].marginAfterPlan), '超過見込み 11時間00分');
assert.equal(dash.statusOf(view.attention[0]).label, '超過見込み');
assert.equal(view.attention[0].pastActual > 60, false);
assert.equal(view.confirmed, 0);
const closeRow = view.ranking.find((row) => row.transportId === 'TID-CLOSE');
assert.equal(view.ranking[0].transportId, 'TID-OVER');
assert.equal(closeRow.adminLabel, '本日要注意');
assert.equal(closeRow.dataClass, '予定込み予測');
assert.equal(closeRow.forecastKind, '予測');
assert.equal(closeRow.name, '架空 接近');
assert.equal(dash.hourText(closeRow.remaining), '0時間48分');
assert.equal(dash.marginText(closeRow.marginAfterPlan), '残り48分');
assert.equal(dash.statusOf(closeRow).label, '本日要注意');
assert.equal(view.ranking.find((row) => row.transportId === 'TID-WATCH').adminLabel, '本日監視');
assert.equal(view.ranking.find((row) => row.transportId === 'TID-ROOM').adminLabel, '');
assert.equal(view.ranking.find((row) => row.transportId === 'TID-OFF').adminLabel, '');
const mix = view.ranking.find((row) => row.transportId === 'TID-MIX');
assert.equal(mix.dataClass, '予定込み予測');
assert.equal(mix.pastKind, '予定込み');
assert.equal(mix.forecastKind, '予測');
assert.equal(view.gaps.some((row) => row.transportId === 'TID-MIX'), false);
const confirmedRow = view.ranking.find((row) => row.transportId === 'TID-PURE');
assert.equal(confirmedRow.dataClass, '実績確定');
assert.equal(confirmedRow.forecastKind, '実績');
assert.equal(confirmedRow.marginAfterPlan, null);
assert.equal(view.gaps.length, 1);
assert.equal(view.gaps[0].transportId, 'TID-GAP');
assert.equal(view.gaps[0].forecast, null);
assert.equal(view.gaps[0].pastActual, null);
assert.equal(view.gaps[0].gaps[0].reason, '実績未取得');
assert.equal(view.ranking.find((row) => row.transportId === 'TID-EDGE').adminLabel, '');
assert.equal(view.ranking.find((row) => row.transportId === 'TID-EDGE-IN').adminLabel, '本日監視');
const overRow = view.ranking.find((row) => row.transportId === 'TID-OVER');
assert.equal(overRow.dataClass, '予定込み予測');
assert.equal(overRow.forecastOver, true);
assert.notEqual(overRow.dataClass, '実績確定');
const sameName = view.ranking.filter((row) => row.name === '架空 同姓');
assert.equal(sameName.length, 2);
assert.notEqual(sameName[0].transportId, sameName[1].transportId);
const mixDays = dash.dayBreakdown(mix);
assert.equal(mixDays[3].actual, '未取得');
assert.equal(mixDays[3].plan, '0時間00分');
assert.equal(mixDays[3].adopted, '予定');
const zeroDays = dash.dayBreakdown(view.ranking.find((row) => row.transportId === 'TID-ZERO-ACT'));
assert.equal(zeroDays[0].actual, '0時間00分');
assert.equal(zeroDays[0].plan, '—');
assert.equal(zeroDays[0].adopted, '実績');
assert.equal(view.future.length, 1);
assert.equal(view.future[0].transportId, 'TID-FUTURE');
assert.equal(view.future[0].endDate > '2026-10-21', true);
assert.equal(view.ranking.some((row) => row.transportId === 'TID-FUTURE'), false);

const blank = dash.buildView({ checkedAt: 'missing' }, history);
assert.equal(blank.ok, false);

const snapPath = 'local/inoichi-rolling-snapshot.json';
const histPath = 'local/rolling60h-history.json';
if (fs.existsSync(snapPath) && fs.existsSync(histPath)) {
  const saved = dash.buildView(JSON.parse(fs.readFileSync(snapPath, 'utf8')), JSON.parse(fs.readFileSync(histPath, 'utf8')));
  assert.equal(saved.ok, true);
  assert.equal(saved.confirmed, 0);
  assert.equal(saved.future.length, 11);
  assert.equal(saved.gaps.length, 1);
  assert.equal(saved.gaps[0].transportId, 'A10WFPVIOF6MK1');
  assert.equal(saved.gaps[0].dataClass, '判定不能');
  assert.equal(saved.gaps[0].name.indexOf('松村') >= 0, true);
  assert.equal(saved.ranking.length, 90);
  const yama = saved.ranking.find((row) => row.transportId === 'A1MZ3KFI8IWHLU');
  const fuka = saved.ranking.find((row) => row.transportId === 'A23LQG8NT14DIW');
  assert.equal(yama.name.indexOf('山口') >= 0, true);
  assert.equal(yama.dataClass, '予定込み予測');
  assert.equal(yama.forecastKind, '予測');
  assert.equal(yama.adminLabel, '本日要注意');
  assert.ok(Math.abs(yama.pastActual - 48.73) < 0.02);
  assert.equal(yama.todayPlan, 11);
  assert.ok(Math.abs(yama.forecast - 59.731666666666676) < 0.02);
  assert.ok(Math.abs(yama.marginAfterPlan - 0.268333333333324) < 0.02);
  assert.equal(dash.marginText(yama.marginAfterPlan), '残り16分');
  assert.equal(yama.forecastOver, false);
  assert.equal(saved.attention[0].transportId, yama.transportId);
  assert.equal(fuka.pastKind, '実績');
  assert.equal(fuka.dataClass, '予定込み予測');
  assert.equal(fuka.adminLabel, '本日監視');
  assert.ok(Math.abs(fuka.pastActual - 45.71) < 0.02);
  assert.equal(fuka.todayPlan, 11);
  assert.ok(Math.abs(fuka.forecast - 56.71) < 0.02);
  assert.ok(Math.abs(fuka.marginAfterPlan - 3.29) < 0.02);
  assert.equal(dash.marginText(fuka.marginAfterPlan), '残り3時間17分');
  assert.equal(dash.statusOf(fuka).label, '本日監視');
  const matsuDay = saved.gaps[0].days.find((day) => day.date === '2026-10-15');
  assert.equal(matsuDay.hours, null);
  assert.equal(saved.gaps[0].gaps.some((gap) => gap.date === '2026-10-15'), true);
  assert.equal(saved.actualComplete + saved.planForecast + saved.gaps.length, saved.ranking.length + saved.gaps.length);
  assert.equal(saved.ranking.some((row) => row.dataClass === '予定込み予測' && row.forecastKind === '実績'), false);
  saved.gaps.forEach((row) => {
    assert.equal(row.forecast, null);
    assert.equal(row.pastActual, null);
  });
  saved.ranking.forEach((row) => {
    assert.equal(typeof row.forecast, 'number');
    assert.equal(row.gaps.length, 0);
    if (row.dataClass === '予定込み予測') assert.notEqual(row.forecastKind, '実績');
    if (row.adminLabel === '本日要注意') assert.equal(row.marginAfterPlan < 1 && row.todayPlan > 0, true);
    if (row.adminLabel === '本日監視') assert.equal(row.marginAfterPlan >= 1 && row.marginAfterPlan < 5 && row.todayPlan > 0, true);
  });
  saved.future.forEach((row) => assert.equal(row.endDate > saved.referenceDate, true));
}

const source = fs.readFileSync(new URL('../duty-risk-dashboard.js', import.meta.url), 'utf8');
assert.equal(source.includes('prefix6'), false);
assert.equal(source.includes('computeRolling'), false);
assert.equal(source.includes('rolling60h-core'), false);

console.log('duty-risk-dashboard.test.mjs: ALL PASSED');
