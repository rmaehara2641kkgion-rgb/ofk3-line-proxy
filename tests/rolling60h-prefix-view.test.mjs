// 画面に出す11時間接近。人数は架空の並びであり、実ブックの件数は期待値にしない。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const Core = require('../rolling60h-core.js');
const View = require('../rolling60h-prefix-view.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

function block(hours, source) {
  return { code: hours > 0 ? 'HACHI' : 'KYU', hours: hours, defined: true, source: source || 'roster' };
}

function seriesFrom(start, hoursList, patch) {
  return hoursList.map(function (hours, index) {
    const date = Core.addDays(start, index);
    const extra = patch && patch[date] ? patch[date] : null;
    if (extra) return Object.assign({ date: date, blocks: [] }, extra);
    return {
      date: date,
      dailyTotalHours: hours,
      hasUndefinedHours: false,
      hasUnconfirmed: false,
      noData: false,
      blocks: [block(hours, 'roster')],
    };
  });
}

function assessed(name, hoursList, patch) {
  const series = seriesFrom('2026-10-25', hoursList, patch);
  const windows = Core.computeRolling60h(series, { limitHours: 60, warningHours: 60 });
  return View.assessDriver(Core, {
    name: name,
    transportId: 'T-' + name,
    series: series,
    windows: windows,
    referenceDate: '2026-10-31',
    amazonLoaded: false,
  });
}

const marginPeople = [];
for (let i = 1; i <= 6; i++) marginPeople.push(assessed('接近' + i, [10, 8, 8, 8, 8, 8, 8]));
const windowPeople = [];
for (let i = 1; i <= 3; i++) windowPeople.push(assessed('窓接近' + i, [8, 8, 8, 8, 8, 8, 12]));
const exceed = assessed('超過太郎', [11, 11, 11, 11, 11, 11, 11]);
const unknown = assessed('不明花子', [8, 8, 8, 8, 8, 8, 8], {
  '2026-10-27': {
    dailyTotalHours: 0,
    hasUndefinedHours: true,
    hasUnconfirmed: false,
    noData: false,
    blocks: [{ code: '研修', hours: null, defined: false, source: 'roster' }],
  },
});

marginPeople.forEach(function (row) {
  assert.equal(row.margin, 'approach');
  assert.equal(row.prefixHours, 50);
  assert.equal(row.windowJudgment, 'within');
});
windowPeople.forEach(function (row) {
  assert.equal(row.margin, 'none');
  assert.equal(row.prefixHours, 48);
  assert.equal(row.windowJudgment, 'approach');
  assert.equal(row.windowHours, 60);
});
assert.equal(exceed.margin, 'none');
assert.equal(exceed.windowJudgment, 'exceed');
assert.equal(unknown.prefixHours, null);
assert.equal(unknown.windowJudgment, 'undetermined');
assert.equal(unknown.margin, 'none');
assert.notEqual(unknown.prefixHours, 0);

const summary = View.summarize(marginPeople.concat(windowPeople, [exceed, unknown]), {
  referenceDate: '2026-10-31',
  amazonLoaded: false,
});
assert.equal(summary.marginApproach.length, 6);
assert.equal(summary.windowApproach.length, 3);
assert.equal(summary.windowExceed.length, 1);
assert.equal(summary.undetermined.length, 1);
const marginNames = summary.marginApproach.map(function (row) { return row.name; });
const windowNames = summary.windowApproach.map(function (row) { return row.name; });
windowNames.forEach(function (name) { assert.equal(marginNames.indexOf(name), -1); });
marginNames.forEach(function (name) { assert.equal(windowNames.indexOf(name), -1); });

const html = View.renderHtml(summary);
assert.match(html, /基準日 2026-10-31/);
assert.match(html, /11時間接近の対象期間は 2026-10-25〜2026-10-30/);
assert.match(html, /基準日で終わる7日窓は 2026-10-25〜2026-10-31/);
assert.match(html, /シフト予定に基づく判定です/);
assert.equal(html.includes('実績判定済み'), false);
const beforeWindow = html.split('7日窓の接近')[0];
assert.equal(beforeWindow.includes('窓接近1'), false);
assert.match(html, /窓接近1/);
assert.match(html, /超過太郎/);
assert.match(html, /不明花子/);
assert.match(html, /取得不可/);
const unknownAt = html.indexOf('不明花子');
assert.equal(html.slice(unknownAt, unknownAt + 40).includes('0時間'), false);

const estimated = View.assessDriver(Core, {
  name: '推定',
  transportId: 'T-EST',
  series: seriesFrom('2026-10-25', [8, 8, 8, 8, 8, 8, 8]).map(function (day) {
    day.blocks = [block(day.dailyTotalHours, 'actual')];
    return day;
  }),
  windows: [],
  referenceDate: '2026-10-31',
  amazonLoaded: true,
});
assert.match(estimated.basisText, /推定稼働時間/);
assert.equal(estimated.basisText.includes('実績判定済み'), false);

const WD = ['日', '月', '火', '水', '木', '金', '土'];
function ymdToDate(ymd) {
  const p = ymd.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}
function range(from, to) {
  const out = [];
  let d = from;
  while (true) {
    out.push(d);
    if (d === to) break;
    d = Core.addDays(d, 1);
  }
  return out;
}
function sheetRows(headers, drivers, monthLabel) {
  const head = ['社名', '名前'];
  const weekdayRow = [null, null];
  headers.forEach((h) => {
    if (typeof h === 'string') {
      head.push(ymdToDate(h));
      weekdayRow.push(WD[ymdToDate(h).getDay()]);
    } else {
      head.push(h.constDay);
      weekdayRow.push(h.weekday);
    }
  });
  head.push('Transport ID');
  const aoa = [[monthLabel], ['week'], head, weekdayRow];
  drivers.forEach((d) => {
    const row = ['GION', d.name];
    headers.forEach((h) => {
      const key = typeof h === 'string' ? h : h.key;
      row.push(d.codes[key] == null ? null : d.codes[key]);
    });
    row.push(d.tid);
    aoa.push(row);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  headers.forEach((h, i) => {
    if (typeof h !== 'string') {
      ws[XLSX.utils.encode_cell({ r: 2, c: 2 + i })] = { t: 'n', v: h.constDay, z: 'd' };
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellDates: true });
  return XLSX.utils.sheet_to_json(back.Sheets.S, { header: 1, raw: true });
}
const octHeaders = range('2026-10-26', '2026-10-30').concat([{ constDay: 31, weekday: '土', key: '2026-10-31' }]);
const octCodes = { '2026-10-26': 'bike', '2026-10-27': '8', '2026-10-28': '8', '2026-10-29': '8', '2026-10-30': '8', '2026-10-31': '8' };
const novHeaders = range('2026-10-25', '2026-10-31').concat(range('2026-11-01', '2026-11-08'));
const OCT = { label: '10月', sheetsData: { GDS: sheetRows(octHeaders, [{ name: '月跨ぎ', tid: 'SPAN', codes: octCodes }], '10月') } };
const NOV = { label: '11月', sheetsData: { GDS: sheetRows(novHeaders, [{ name: '月跨ぎ', tid: 'SPAN', codes: { '2026-11-01': '8' } }], '11月') } };
const forward = Core.buildRosterTimelineFromSources([OCT, NOV], {});
const reverse = Core.buildRosterTimelineFromSources([NOV, OCT], {});
function spanAssess(built) {
  const roster = built.rosterBlocksByDriver.SPAN;
  const series = Core.buildContinuousDailySeries(Core.mergeActualAndRoster({}, roster, '2026-11-01'), '2026-10-26', '2026-11-01');
  const windows = Core.computeRolling60h(series, { limitHours: 60, warningHours: 60 });
  return View.assessDriver(Core, {
    name: '月跨ぎ',
    transportId: 'SPAN',
    series: series,
    windows: windows,
    referenceDate: '2026-11-01',
    amazonLoaded: false,
  });
}
const span = spanAssess(forward);
const spanBack = spanAssess(reverse);
assert.equal(span.prefixHours, 50);
assert.equal(span.margin, 'approach');
assert.equal(span.windowStart, '2026-10-26');
assert.equal(span.windowEnd, '2026-11-01');
assert.equal(span.windowJudgment, 'within');
assert.equal(span.prefixHours, spanBack.prefixHours);
assert.equal(span.margin, spanBack.margin);
const day1031 = Core.buildContinuousDailySeries(forward.rosterBlocksByDriver.SPAN, '2026-10-31', '2026-10-31')[0];
assert.equal(day1031.dailyTotalHours, 8);
assert.equal(day1031.hasUndefinedHours, false);
const spanHtml = View.renderHtml(View.summarize([span], { referenceDate: '2026-11-01', amazonLoaded: false }));
assert.match(spanHtml, /基準日 2026-11-01/);
assert.match(spanHtml, /2026-10-26〜2026-10-31/);
assert.match(spanHtml, /シフト予定に基づく判定です/);
assert.equal(spanHtml.includes('実績判定済み'), false);

const ui = fs.readFileSync(new URL('../rolling60h-ui.js', import.meta.url), 'utf8');
assert.equal(ui.includes('buildRosterTimelineFromSources'), true);
assert.equal(ui.includes('RollingPrefixView.assessDriver'), true);
const board = fs.readFileSync(new URL('../rolling60h-board-ui.js', import.meta.url), 'utf8');
assert.equal(board.includes('prefixApproachPrintHtml'), true);
assert.equal(board.includes('算出不可'), false);
const dashboard = fs.readFileSync(new URL('../duty-risk-dashboard.js', import.meta.url), 'utf8');
assert.equal(dashboard.includes('prefix6'), false);
assert.equal(dashboard.includes('computeRolling'), false);
const printed = View.renderPrintHtml(summary);
assert.match(printed, /11時間接近（7日窓の接近とは別）/);
assert.match(printed, /7日窓の接近 3人/);
assert.match(printed, /7日窓の超過 1人/);
assert.equal(printed.includes('実績判定済み'), false);

console.log('rolling60h prefix view tests passed');
