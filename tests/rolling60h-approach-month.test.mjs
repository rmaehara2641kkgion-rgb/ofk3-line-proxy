// 月跨ぎの厳格マージを維持したまま、11時間接近判定を同じ系列で確認する。架空データのみ。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const Rolling = require('../rolling60h-core.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

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
    d = Rolling.addDays(d, 1);
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
      const v = d.codes[key];
      row.push(v === undefined ? null : v);
    });
    row.push(d.tid);
    aoa.push(row);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  headers.forEach((h, i) => {
    if (typeof h !== 'string') {
      const addr = XLSX.utils.encode_cell({ r: 2, c: 2 + i });
      ws[addr] = { t: 'n', v: h.constDay, z: 'd' };
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellDates: true });
  return XLSX.utils.sheet_to_json(back.Sheets.S, { header: 1, raw: true });
}

function codes(pairs) {
  const out = {};
  pairs.forEach((pair) => { out[pair[0]] = pair[1]; });
  return out;
}

const octDates = range('2026-10-25', '2026-10-30');
const octHeaders = octDates.concat([{ constDay: 31, weekday: '土', key: '2026-10-31' }]);
const octDrivers = [
  {
    name: '接近太郎',
    tid: 'APP',
    codes: codes([
      ['2026-10-25', 'bike'],
      ['2026-10-26', '8'],
      ['2026-10-27', '8'],
      ['2026-10-28', '8'],
      ['2026-10-29', '8'],
      ['2026-10-30', '8'],
      ['2026-10-31', '8'],
    ]),
  },
  {
    name: '境界外',
    tid: 'LOW',
    codes: codes([
      ['2026-10-25', '8'],
      ['2026-10-26', '8'],
      ['2026-10-27', '8'],
      ['2026-10-28', '8'],
      ['2026-10-29', '8'],
      ['2026-10-30', '8'],
      ['2026-10-31', '8'],
    ]),
  },
  {
    name: '不明時間',
    tid: 'UNK',
    codes: codes([
      ['2026-10-25', '8'],
      ['2026-10-26', '8'],
      ['2026-10-27', '8'],
      ['2026-10-28', '8'],
      ['2026-10-29', '8'],
      ['2026-10-30', '研修'],
      ['2026-10-31', '8'],
    ]),
  },
];
const novLeadIn = range('2026-10-25', '2026-10-31');
const novDates = range('2026-11-01', '2026-11-08');
const novDrivers = [
  { name: '接近太郎', tid: 'APP', codes: { '2026-11-01': '休' } },
  { name: '境界外', tid: 'LOW', codes: { '2026-11-01': '休' } },
  { name: '不明時間', tid: 'UNK', codes: { '2026-11-01': '休' } },
];
const OCT = { label: '最新10月DAシフト.xlsx', sheetsData: { GDS: sheetRows(octHeaders, octDrivers, '10月') } };
const NOV = { label: '最新11月DAシフト.xlsx', sheetsData: { GDS: sheetRows(novLeadIn.concat(novDates), novDrivers, '11月') } };

function judge(built, tid, referenceDate) {
  const roster = built.rosterBlocksByDriver[tid] || {};
  const series = Rolling.buildContinuousDailySeries(
    Rolling.mergeActualAndRoster({}, roster, referenceDate),
    '2026-10-25',
    '2026-11-01'
  );
  const windows = Rolling.computeRolling60h(series, { limitHours: 60, warningHours: 60 });
  const day = series.find((item) => item.date === referenceDate);
  const prefix = Rolling.prefixHoursBeforeToday(series, referenceDate);
  const duty = Rolling.todayDutyFromBlocks(day && day.blocks);
  return {
    roster: roster,
    series: series,
    windows: windows,
    prefix: prefix,
    duty: duty,
    notice: Rolling.approachByMargin(prefix, duty),
    window: windows.find((item) => item.startDate === '2026-10-25' && item.endDate === '2026-10-31'),
  };
}

const forward = Rolling.buildRosterTimelineFromSources([OCT, NOV], {});
const reverse = Rolling.buildRosterTimelineFromSources([NOV, OCT], {});

const leadIn = forward.warnings.filter((w) => w.type === 'lead_in_blank_date_column_excluded' && w.file === NOV.label);
assert.equal(leadIn.length, 7);
assert.ok(leadIn.some((w) => w.date === '2026-10-30'));
assert.ok(leadIn.some((w) => w.date === '2026-10-31'));
const restored = forward.warnings.filter((w) => w.type === 'header_date_restored');
assert.equal(restored.length, 1);
assert.equal(restored[0].date, '2026-10-31');
assert.equal(restored[0].rawHeader, 31);

const app = judge(forward, 'APP', '2026-10-31');
const appReverse = judge(reverse, 'APP', '2026-10-31');
assert.equal(app.prefix, 50);
assert.equal(app.duty, 'work');
assert.equal(app.notice.notice, 'approach');
assert.ok(app.window);
assert.equal(app.window.complete, true);
assert.equal(app.window.totalHours, 58);
assert.equal(app.window.judgment, 'within');
assert.equal(app.window.over, false);
assert.deepEqual(app.roster['2026-10-31'].map((b) => [b.code, b.hours]), [['HACHI', 8]]);
assert.deepEqual(app.roster, appReverse.roster);
assert.equal(appReverse.prefix, 50);
assert.equal(appReverse.notice.notice, 'approach');
assert.equal(appReverse.window.totalHours, 58);
assert.equal(appReverse.window.judgment, 'within');

const low = judge(forward, 'LOW', '2026-10-31');
assert.equal(low.prefix, 48);
assert.equal(low.notice.notice, 'none');
assert.equal(low.notice.reason, '警戒幅の外');
assert.equal(low.window.totalHours, 56);
assert.equal(low.window.judgment, 'within');

const unk = judge(forward, 'UNK', '2026-10-31');
const unkDay = unk.series.find((item) => item.date === '2026-10-30');
assert.equal(unkDay.hasUndefinedHours, true);
assert.equal(unk.prefix, null);
assert.notEqual(unk.prefix, 0);
assert.equal(unk.notice.notice, 'none');
assert.equal(unk.notice.reason, '当日を含まない6日累計が取得不可');
assert.equal(unk.window.judgment, 'undetermined');
assert.equal(unk.window.over, false);
assert.equal(unk.window.warning, false);
const unkReverse = judge(reverse, 'UNK', '2026-10-31');
assert.equal(unkReverse.prefix, null);
assert.equal(unkReverse.window.judgment, 'undetermined');
assert.deepEqual(
  forward.rosterBlocksByDriver,
  reverse.rosterBlocksByDriver
);

console.log('rolling60h approach month-boundary tests passed');
