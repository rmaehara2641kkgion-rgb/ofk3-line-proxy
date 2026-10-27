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
    { name: '架空 接近', company: '架空運送', disposition: 'exceed', basis: 'forecast', startDate: '2026-10-24', endDate: '2026-10-30', windowLabel: '2026-10-24 〜 2026-10-30', totalHours: 66, overBy: 6, actualHours: 55, rosterHours: 11, preTodayHours: 48.2, todayWindowHours: 59.2 },
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
assert.equal(view.confirmed, 0);
const closeRow = view.ranking.find((row) => row.transportId === 'TID-CLOSE');
assert.equal(view.ranking[0].transportId, 'TID-OVER');
assert.equal(closeRow.adminLabel, '本日要注意');
assert.equal(closeRow.dataClass, '予定込み予測');
assert.equal(closeRow.forecastKind, '予測');
assert.equal(closeRow.name, '架空 接近');
assert.equal(closeRow.company, '架空運送');
assert.equal(dash.hourText(closeRow.remaining), '0時間48分');
assert.equal(dash.marginText(closeRow.marginAfterPlan), '残り48分');
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
assert.equal(view.future[0].company, '架空運送');
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
  assert.equal(yama.company, 'LINGｓ');
  assert.equal(fuka.company, 'JHS');
  assert.equal(yama.forecastOver, false);
  const savedPrint = dash.printHtml(saved, '', '2026-10-28T00:00:00.000Z');
  const yamaPrint = rowSlice(savedPrint, yama.transportId);
  const fukaPrint = rowSlice(savedPrint, fuka.transportId);
  const gapPrint = rowSlice(savedPrint, saved.gaps[0].transportId);
  assert.match(yamaPrint, /LINGｓ/);
  assert.match(yamaPrint, /残り16分/);
  assert.match(yamaPrint, /59時間44分/);
  assert.equal(yamaPrint.includes('59.73'), false);
  assert.equal(yamaPrint.includes(dash.statusOf(yama).text), true);
  assert.match(fukaPrint, /JHS/);
  assert.match(fukaPrint, /残り3時間17分/);
  assert.equal(fukaPrint.includes('56.71'), false);
  assert.match(gapPrint, /算出不可/);
  assert.match(gapPrint, /判定不能/);
  assert.match(gapPrint, /JHS/);
  assert.equal(gapPrint.includes('0時間00分'), false);
  assert.equal(saved.attention[0].transportId, yama.transportId);
  assert.equal(fuka.pastKind, '実績');
  assert.equal(fuka.dataClass, '予定込み予測');
  assert.equal(fuka.adminLabel, '本日監視');
  assert.ok(Math.abs(fuka.pastActual - 45.71) < 0.02);
  assert.equal(fuka.todayPlan, 11);
  assert.ok(Math.abs(fuka.forecast - 56.71) < 0.02);
  assert.ok(Math.abs(fuka.marginAfterPlan - 3.29) < 0.02);
  assert.equal(dash.marginText(fuka.marginAfterPlan), '残り3時間17分');
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

const Format = require('../duty-hours-format.js');
assert.equal(Format.remainingText(13), '残り13時間00分');
assert.equal(Format.remainingText(7.03), '残り7時間02分');
assert.equal(Format.remainingText(0.49), '残り29分');
assert.equal(Format.durationText(51.51), '51時間31分');
assert.equal(Format.durationText(15.09), '15時間05分');

const under = dash.statusOf({
  pastActual: 47, pastKind: '実績', todayPlan: 11, forecast: 58, dataClass: '予定込み予測',
  forecastOver: false, marginAfterPlan: 2, remaining: 2, adminLabel: '本日監視', hasDuty: true,
  seriesComplete: true, gaps: [],
});
assert.equal(under.label, '本日監視');
assert.equal(under.text, '残り2時間00分');
assert.equal(under.tone === 'actual', false);

const predicted = dash.statusOf({
  pastActual: 51.51, pastKind: '実績', todayPlan: 11, forecast: 62.51, dataClass: '予定込み予測',
  forecastOver: true, marginAfterPlan: -2.51, adminLabel: '本日要注意', seriesComplete: true, gaps: [],
});
assert.equal(predicted.label, '超過見込み');
assert.equal(predicted.text, '超過見込み 2時間31分');
assert.match(predicted.hint, /過去6日の実績は60時間以下/);

const already = dash.statusOf({
  pastActual: 61, pastKind: '実績', todayPlan: 11, forecast: 72, dataClass: '予定込み予測',
  forecastOver: true, marginAfterPlan: -12, adminLabel: '', seriesComplete: true, gaps: [],
});
assert.equal(already.label, '実績超過');
assert.equal(already.text, '実績超過 1時間00分');

const gapRow = dash.statusOf({
  dataClass: '判定不能', seriesComplete: false, pastActual: null, forecast: null,
  gaps: [{ date: '2026-10-15', reason: '実績未取得' }],
});
assert.equal(gapRow.label, '判定不能');
assert.match(gapRow.hint, /実績未取得/);
assert.match(gapRow.hint, /欠損は0時間にしていません/);

const shown = dash.renderHtml({
  ok: true, windowStart: '2026-10-15', referenceDate: '2026-10-21', checkedAt: '2026-10-21T02:00:00.000Z',
  confirmed: 0, watchNow: 0, watchSoon: 1, actualComplete: 0, planForecast: 1, attention: [],
  ranking: [{
    transportId: 'TID-47', name: '架空 四七', pastActual: 47, pastKind: '実績', todayPlan: 11,
    forecast: 58, forecastKind: '予測', dataClass: '予定込み予測', remaining: 2, workable: 13,
    marginAfterPlan: 2, hasDuty: true, adminLabel: '本日監視', forecastOver: false, gaps: [],
    seriesComplete: true, days: [],
  }],
  future: [], gaps: [],
}, '');
assert.match(shown, /架空 四七/);
assert.match(shown, /残り2時間00分/);
assert.match(shown, /本日監視/);
assert.match(shown, /印刷／PDF保存/);
assert.equal(shown.includes('data-duty-print="1"'), true);
assert.equal(shown.includes('data-duty-sort="name"'), true);
assert.doesNotMatch(shown.slice(shown.indexOf('架空 四七'), shown.indexOf('架空 四七') + 500), /実績超過/);

function rowSlice(html, token) {
  const at = html.indexOf(token);
  assert.ok(at >= 0, token);
  const start = html.lastIndexOf('<tr>', at);
  return html.slice(start < 0 ? at : start, html.indexOf('</tr>', at));
}

const rankingIds = view.ranking.map((row) => row.transportId).join(',');
const printed = dash.printHtml(view, '', '2026-10-28T00:00:00.000Z');
assert.equal(view.ranking.map((row) => row.transportId).join(','), rankingIds);
assert.match(printed, /<meta charset="utf-8">/);
assert.match(printed, /@page\{size:A4 landscape;margin:6mm;\}/);
assert.match(printed, /thead\{display:table-header-group;\}/);
assert.match(printed, /page-break-inside:avoid/);
assert.match(printed, /break-inside:avoid/);
assert.match(printed, /table-layout:fixed/);
assert.match(printed, /class="no-print"/);
assert.match(printed, /window\.print\(\)/);
assert.match(printed, /出力日時 2026-10-28 09:00:00/);
assert.match(printed, /対象日 2026-10-15 〜 2026-10-21/);
assert.match(printed, /判定基準日時 2026-10-21 11:00:00/);
assert.match(printed, /絞り込み なし。並び順 残りが少ない順。/);
const closeStatus = dash.statusOf(closeRow);
const closeSlice = rowSlice(printed, 'TID-CLOSE');
assert.match(closeSlice, /架空 接近/);
assert.match(closeSlice, /架空運送/);
assert.match(closeSlice, /59時間12分 予測/);
assert.match(closeSlice, /予定込み予測・暫定（予定を含む）/);
assert.match(closeSlice, /● 本日要注意/);
assert.equal(closeSlice.includes(closeStatus.text), true);
assert.equal(closeSlice.includes('59.2'), false);
assert.equal(closeSlice.includes('48.2'), false);
assert.equal(closeSlice.includes('0時間00分'), false);
const gapSlice = rowSlice(printed, 'TID-GAP');
assert.match(gapSlice, /算出不可/);
assert.match(gapSlice, /判定不能/);
assert.match(gapSlice, /実績未取得/);
assert.match(gapSlice, /不明/);
assert.equal(gapSlice.includes('0時間00分'), false);
assert.equal(gapSlice.includes('未取得'), true);
const roomSlice = rowSlice(printed, 'TID-ROOM');
assert.match(roomSlice, /架空 範囲/);
assert.match(roomSlice, /未取得/);
assert.equal(roomSlice.includes('架空運送'), false);
const filtered = dash.printHtml(view, '架空 接近', '2026-10-28T00:00:00.000Z');
assert.equal(filtered.includes('TID-CLOSE'), true);
assert.equal(filtered.includes('TID-ROOM'), false);
assert.match(filtered, /絞り込み 架空 接近。並び順 残りが少ない順。/);
assert.equal(view.ranking.map((row) => row.transportId).join(','), rankingIds);

function plainRow(partial) {
  return Object.assign({
    transportId: 'T', name: '名', company: undefined, pastActual: 40, pastKind: '実績', todayPlan: 8,
    forecast: 48, forecastKind: '予測', dataClass: '予定込み予測', remaining: 12, workable: 20,
    marginAfterPlan: 12, hasDuty: true, adminLabel: '', forecastOver: false, gaps: [], seriesComplete: true, days: [],
  }, partial);
}
const yamada = plainRow({ transportId: 'TID-B', name: 'かきく', marginAfterPlan: 2, remaining: 2, adminLabel: '本日監視', company: 'GDS' });
const aoki = plainRow({ transportId: 'TID-A', name: 'あいう', marginAfterPlan: 10, remaining: 10, company: undefined });
const blankName = plainRow({ transportId: 'TID-NONAME', name: '', company: '秘密会社', marginAfterPlan: 9, remaining: 9 });
const listView = {
  ok: true, windowStart: '2026-10-15', referenceDate: '2026-10-21', checkedAt: '2026-10-21T02:00:00.000Z',
  confirmed: 0, watchNow: 1, watchSoon: 0, sortMode: 'remaining',
  ranking: [yamada, aoki, blankName], future: [], gaps: [{
    transportId: 'TID-NONE', name: '', company: undefined, dataClass: '判定不能', seriesComplete: false,
    forecast: null, pastActual: null, remaining: null, marginAfterPlan: null, gaps: [{ date: '2026-10-15', reason: '実績未取得' }],
  }],
};
const remainOrder = dash.printHtml(listView, '', '2026-10-28T00:00:00.000Z');
assert.ok(remainOrder.indexOf('かきく') < remainOrder.indexOf('あいう'));
assert.equal(remainOrder.includes(dash.statusOf(yamada).text), true);
assert.equal(remainOrder.includes(dash.statusOf(aoki).text), true);
assert.match(rowSlice(remainOrder, 'TID-B'), /GDS/);
assert.match(rowSlice(remainOrder, 'TID-B'), /◆ 本日監視/);
assert.match(rowSlice(remainOrder, 'TID-A'), /未取得/);
assert.match(rowSlice(remainOrder, 'TID-NONAME'), /不明/);
assert.equal(rowSlice(remainOrder, 'TID-NONAME').includes('秘密会社'), false);
const nameOrder = dash.printHtml(Object.assign({}, listView, { sortMode: 'name' }), '', '2026-10-28T00:00:00.000Z');
assert.ok(nameOrder.indexOf('あいう') < nameOrder.indexOf('かきく'));
assert.match(nameOrder, /並び順 氏名順/);
const nameSlice = rowSlice(nameOrder, 'TID-A');
assert.equal(nameSlice.includes('48時間00分'), true);
assert.equal(nameSlice.includes('48.0'), false);
const noneSlice = rowSlice(remainOrder, 'TID-NONE');
assert.match(noneSlice, /算出不可/);
assert.match(noneSlice, /？ 判定不能/);
assert.equal(noneSlice.includes('0時間00分'), false);
assert.equal(noneSlice.includes('0時間'), true);
const onlyAoki = dash.printHtml(listView, 'あいう', '2026-10-28T00:00:00.000Z');
assert.equal(onlyAoki.includes('TID-A'), true);
assert.equal(onlyAoki.includes('TID-B'), false);
assert.equal(onlyAoki.includes('かきく'), false);
const unavailable = dash.printHtml({ ok: false, reason: '保存履歴とスナップショットの取得日時が一致しません' }, '', '2026-10-28T00:00:00.000Z');
assert.match(unavailable, /保存データを表示できません/);
assert.equal(unavailable.includes('0時間00分'), false);
assert.equal(unavailable.includes('<table>'), false);

const conflictWindow = windowFor('TID-CO', dates, [3, 3, 3, 3, 3, 3, 3], pureOrigins);
const missingWindow = windowFor('TID-NC', dates, [4, 4, 4, 4, 4, 4, 4], pureOrigins);
const companyHistory = { runs: [{ referenceDate: '2026-10-21', predictedAt: '2026-10-21T03:00:00.000Z', predictions: [conflictWindow, missingWindow] }] };
const companySnap = {
  checkedAt: '2026-10-21T03:00:00.000Z',
  basisCounts: {},
  alerts: [
    { name: '架空 衝突', company: '甲社', disposition: 'clear', basis: 'actual', startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 21, preTodayHours: 18, todayWindowHours: 21 },
    { name: '架空 衝突', company: '乙社', disposition: 'clear', basis: 'actual', startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 21, preTodayHours: 18, todayWindowHours: 21 },
    { name: '架空 無所属', disposition: 'clear', basis: 'actual', startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 28, preTodayHours: 24, todayWindowHours: 28 },
  ],
};
const companyView = dash.buildView(companySnap, companyHistory);
const conflictRow = companyView.ranking.find((row) => row.transportId === 'TID-CO');
const missingCompany = companyView.ranking.find((row) => row.transportId === 'TID-NC');
assert.equal(conflictRow.name, '架空 衝突');
assert.equal(conflictRow.company, '');
assert.equal(conflictRow.forecast, 21);
assert.equal(missingCompany.name, '架空 無所属');
assert.equal(missingCompany.company, undefined);
assert.equal(missingCompany.forecast, 28);
const companyHtml = dash.printHtml(companyView, '', '2026-10-28T00:00:00.000Z');
const conflictSlice = rowSlice(companyHtml, 'TID-CO');
assert.match(conflictSlice, /不明/);
assert.equal(conflictSlice.includes('甲社'), false);
assert.equal(conflictSlice.includes('乙社'), false);
assert.match(conflictSlice, /21時間00分/);
const missingSlice = rowSlice(companyHtml, 'TID-NC');
assert.match(missingSlice, /未取得/);
assert.match(missingSlice, /28時間00分/);
assert.equal(missingSlice.includes('28.0'), false);

const source = fs.readFileSync(new URL('../duty-risk-dashboard.js', import.meta.url), 'utf8');
assert.equal(source.includes('prefix6'), false);
assert.equal(source.includes('computeRolling'), false);
assert.equal(source.includes('rolling60h-core'), false);

console.log('duty-risk-dashboard.test.mjs: ALL PASSED');
