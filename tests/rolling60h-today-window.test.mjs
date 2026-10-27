import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Run = require('../harvest-rolling60h-run.js');
const Rolling = require('../rolling60h-core.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const Dash = require('../duty-risk-dashboard.js');
const Snap = require('../duty-risk-snapshot.js');
const Board = require('../rolling60h-local-board.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

const REF = '2026-10-27';
const header = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];
const MARU = '○';
const KYU = '休';
const deps = { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf };

function datesBetween(start, end) {
  const out = [];
  for (let date = start; date <= end; date = Rolling.addDays(date, 1)) out.push(date);
  return out;
}

const dates = datesBetween('2026-10-01', '2026-10-30');

function shiftBook(people) {
  const head = ['社名', '名前', 'Transport ID'].concat(dates.map((iso) => {
    const p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }));
  const rows = people.map((person) => ['GDS', person.name, person.id].concat(dates.map((date) => (
    person.cells[date] != null ? person.cells[date] : KYU
  ))));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head].concat(rows)), 'GDS');
  return wb;
}

function dailyRows(entries) {
  return [header].concat(entries.map((entry) => [entry.id, entry.date, entry.hours, 'OFK3']));
}

function cells(overrides, fallback) {
  const map = {};
  dates.forEach((date) => { map[date] = fallback; });
  Object.keys(overrides).forEach((date) => { map[date] = overrides[date]; });
  return map;
}

function rangeFill(start, end, symbol) {
  const map = {};
  datesBetween(start, end).forEach((date) => { map[date] = symbol; });
  return map;
}

const pastCells = cells(rangeFill('2026-10-01', '2026-10-07', MARU), KYU);
const futureCells = cells(rangeFill('2026-10-24', '2026-10-30', MARU), KYU);
const todayOverCells = cells({ '2026-10-27': MARU }, KYU);
const exactCells = cells({ '2026-10-27': MARU }, KYU);
const actualCells = cells({ '2026-10-27': KYU }, KYU);
const knownCells = cells({
  '2026-10-26': '',
  '2026-10-27': MARU,
}, KYU);
const blankCells = cells({}, '');

const people = [
  { id: 'T-PAST', name: '架空 過去', cells: pastCells },
  { id: 'T-FUTURE', name: '架空 将来', cells: futureCells },
  { id: 'T-TODAY', name: '架空 当日', cells: todayOverCells },
  { id: 'T-EXACT', name: '架空 丁度', cells: exactCells },
  { id: 'T-ACTUAL', name: '架空 実績', cells: actualCells },
  { id: 'T-KNOWN', name: '架空 既知', cells: knownCells },
  { id: 'T-BLANK', name: '架空 空白', cells: blankCells },
];

const daily = []
  .concat([8, 8, 8, 8, 8, 10].map((hours, index) => ({ id: 'T-TODAY', date: datesBetween('2026-10-21', '2026-10-26')[index], hours })))
  .concat([8, 8, 8, 8, 8, 9].map((hours, index) => ({ id: 'T-EXACT', date: datesBetween('2026-10-21', '2026-10-26')[index], hours })))
  .concat([11, 11, 11, 11, 11, 11].map((hours, index) => ({ id: 'T-ACTUAL', date: datesBetween('2026-10-21', '2026-10-26')[index], hours })))
  .concat([11, 11, 11, 11, 11].map((hours, index) => ({ id: 'T-KNOWN', date: datesBetween('2026-10-21', '2026-10-25')[index], hours })))
  .concat([
    { id: 'T-NONE', date: '2026-10-24', hours: 5.799722222 },
    { id: 'T-NONE', date: '2026-10-26', hours: 2.712777778 },
  ]);

const rows = dailyRows(daily);
const executed = Run.capture({
  xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
  dailyRows: rows, dailyFileName: 'Daily_FICTION.xlsx',
  shiftBook: shiftBook(people), shiftFileName: 'shift_FICTION.xlsx',
  referenceDate: REF,
});
const names = {};
people.forEach((person) => { names[person.id] = person.name; });
const board = Board.buildBoard({
  executed, referenceDate: REF, generatedAt: '2026-10-27T01:00:00.000Z',
  files: { shift: { name: 'shift_FICTION.xlsx', ok: true }, daily: { name: 'Daily_FICTION.xlsx', ok: true } },
  names,
  actualDays: daily.map((entry) => ({ transportId: entry.id, date: entry.date, hours: entry.hours })),
}, deps);
const byId = Object.fromEntries(board.rows.map((row) => [row.transportId, row]));

assert.equal(board.counts.exceed, executed.summary.exceedCount, 'FRIDAYへ渡す超過人数はエンジンのまま');
assert.equal(board.counts.clear, executed.summary.clearCount);
assert.equal(board.counts.approach, executed.summary.approachCount);

const past = byId['T-PAST'];
assert.equal(past.forecast.hours < 60, true);
assert.equal(past.judgment, 'ok');
assert.equal(past.judgment === 'forecast-exceed', false, '過去だけの超過は今日の超過予測にしない');
assert.equal(Board.judgmentText(past).includes('超過予測'), false);
assert.equal(Board.judgmentText(past).includes('将来超過あり'), false);
assert.equal(past.status === 'exceed' || past.status === 'partial-exceed', true, 'エンジン区分は維持');
assert.ok(past.evidence.some((item) => item.period === 'past' && item.exceeds && item.end < REF));
past.evidence.filter((item) => item.exceeds).forEach((item) => {
  assert.equal(Board.clockText(item.overBy), Board.clockText(item.totalHours - 60));
});

const future = byId['T-FUTURE'];
assert.equal(future.forecast.hours < 60, true);
assert.equal(future.judgment, 'ok');
assert.equal(future.judgmentProvisional, true);
assert.equal(Board.judgmentText(future), '正常・暫定 / 将来超過あり +' + Board.clockText(future.futureExceed.overBy));
assert.equal(future.futureExceed.end > REF, true);
assert.ok(future.evidence.some((item) => item.period === 'future' && item.start === '2026-10-24' && item.end === '2026-10-30' && item.exceeds));
const shownFuture = future.evidence.find((item) => item.start === future.futureExceed.start && item.end === future.futureExceed.end);
assert.equal(shownFuture.totalHours, future.futureExceed.totalHours);
assert.equal(shownFuture.overBy, future.futureExceed.overBy);
const shownSum = shownFuture.days.reduce((sum, day) => sum + day.hours, 0);
assert.ok(Math.abs(shownSum - shownFuture.totalHours) < 0.02, '詳細の日別合計は窓の計算結果と一致');
assert.equal(future.judgmentRank, 1.5, '将来超過は今日の判定を上書きせず、一覧の上位に残す');

const today = byId['T-TODAY'];
assert.equal(today.forecast.hours, 61);
assert.equal(today.judgment, 'forecast-exceed');
assert.equal(Board.judgmentText(today).startsWith('超過予測'), true);
assert.equal(today.futureExceed, null);

const exact = byId['T-EXACT'];
assert.equal(exact.forecast.hours, 60);
assert.equal(exact.judgment, 'caution');
assert.equal(exact.judgment === 'forecast-exceed', false);

const actual = byId['T-ACTUAL'];
assert.equal(actual.past6.hours, 66);
assert.equal(actual.past6.kind, '実績');
assert.equal(actual.judgment, 'actual-exceed');
assert.equal(actual.judgmentLabel, '実績超過');

const known = byId['T-KNOWN'];
assert.equal(known.knownOver, true);
assert.equal(known.forecast.hours > 60, true);
assert.equal(known.judgment, 'forecast-exceed');
assert.equal(known.judgment === 'review', false, '既知時間だけで超えていれば要確認へ格下げしない');
assert.equal(known.gaps.some((gap) => gap.date === '2026-10-26'), false, '空白セルは欠損に戻さない');
assert.equal(known.days.find((day) => day.date === '2026-10-26').adopted, '休み');

const blank = byId['T-BLANK'];
assert.equal(blank.forecast.hours, 0);
assert.equal(blank.gaps.length, 0);
assert.ok(blank.days.every((day) => day.hours === 0 && day.adopted === '休み'));
assert.equal(blank.judgment, 'ok');

const unmatched = byId['T-NONE'];
assert.equal(unmatched.name, '');
assert.equal(Board.displayName(unmatched), '未照合DA（T-NONE）');
assert.equal(unmatched.judgment, 'review');
assert.equal(Board.judgmentText(unmatched), '要確認・暫定');
assert.equal(unmatched.recordedActuals.length, 2);
assert.equal(Board.clockText(unmatched.recordedActuals[0].hours), '05:48');
assert.equal(Board.clockText(unmatched.recordedActuals[1].hours), '02:43');
assert.ok(unmatched.unmatchedReason.includes('氏名'));
const namedAgain = Board.buildBoard({
  executed, referenceDate: REF, generatedAt: '2026-10-27T01:00:00.000Z',
  files: { shift: { name: 'shift_FICTION.xlsx', ok: true }, daily: { name: 'Daily_FICTION.xlsx', ok: true } },
  names: Object.assign({}, names, { 'T-NONE': '架空 照合後' }),
  actualDays: daily.map((entry) => ({ transportId: entry.id, date: entry.date, hours: entry.hours })),
}, deps);
const matched = namedAgain.rows.find((row) => row.transportId === 'T-NONE');
assert.equal(Board.displayName(matched), '架空 照合後');
assert.equal(matched.recordedActuals.length, 2, '氏名が付いても実績は残る');

const ui = fs.readFileSync(new URL('../rolling60h-board-ui.js', import.meta.url), 'utf8');
assert.ok(ui.includes('将来超過あり'));
assert.ok(ui.includes('未照合DA'));
assert.ok(ui.includes('照合不能'));
assert.ok(ui.includes('将来の超過'));
assert.ok(ui.includes('過去の超過'));
assert.ok(ui.includes('data-detail'));
assert.equal(ui.includes('氏名なし'), false);

const shiftPath = 'G:/マイドライブ/大坪逝く19ファイル/最新10月DAシフト.xlsx';
const dailyPath = 'G:/マイドライブ/マニフェスト/Daily_AMZL_JP_Working_Hour_2026-10-26_(GION).xlsx';
if (!fs.existsSync(shiftPath) || !fs.existsSync(dailyPath)) {
  console.log('rolling60h-today-window.test.mjs: real files absent, synthetic checks passed');
} else {
  const shiftWb = XLSX.readFile(shiftPath, { cellDates: true });
  const dailyWb = XLSX.readFile(dailyPath, { cellDates: true });
  const sheet = Rolling.pickReport5Sheet(dailyWb.SheetNames || []);
  const realDaily = XLSX.utils.sheet_to_json(dailyWb.Sheets[sheet], { header: 1, raw: true, defval: null });
  const parsedDaily = Rolling.parseAmazonDailyRows(realDaily, { stationFilter: 'OFK3', allowHeaderlessFallback: false });
  const realNames = {};
  (shiftWb.SheetNames || []).forEach((name) => {
    if (Run.ROSTER_SKIP[name] || name === 'Report5_Daily_Data') return;
    const parsed = Rolling.parseMonthlyRosterSheetRows(XLSX.utils.sheet_to_json(shiftWb.Sheets[name], { header: 1, raw: true, defval: null }));
    const grouped = Rolling.groupRosterRecordsByDriver(parsed.records || []);
    Object.keys(grouped).forEach((key) => {
      const meta = grouped[key].meta || {};
      if (!meta.transportId || key.indexOf('NAME:') === 0 || !meta.name || realNames[meta.transportId]) return;
      realNames[meta.transportId] = meta.name;
    });
  });
  const realExec = Run.capture({
    xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyRows: realDaily, dailyFileName: 'Daily_AMZL_JP_Working_Hour_2026-10-26_(GION).xlsx',
    shiftBook: shiftWb, shiftFileName: '最新10月DAシフト.xlsx',
    referenceDate: REF,
  });
  const realBoard = Board.buildBoard({
    executed: realExec, referenceDate: REF, generatedAt: '2026-10-27T01:00:00.000Z',
    files: { shift: { name: '最新10月DAシフト.xlsx', ok: true }, daily: { name: 'Daily_AMZL_JP_Working_Hour_2026-10-26_(GION).xlsx', ok: true } },
    names: realNames,
    actualDays: (parsedDaily.records || []).filter((rec) => rec.hoursOk !== false && typeof rec.hours === 'number').map((rec) => ({
      transportId: rec.transportId, date: rec.date, hours: rec.hours,
    })),
  }, deps);
  assert.equal(realBoard.counts.exceed, realExec.summary.exceedCount);
  function nameKey(value) {
    return String(value || '').trim().split(/[\s　]+/).filter(Boolean).sort().join('|');
  }
  const realByName = {};
  realBoard.rows.forEach((row) => { realByName[nameKey(row.name)] = row; });
  const expected = [
    ['山口|涼太', '57:58', '正常・暫定 / 将来超過あり +01:50'],
    ['伸哉|重松', '55:18', '正常・暫定'],
    ['中村|聖人', '51:18', '正常・暫定'],
    ['康明|永浦', '48:56', '正常・暫定'],
    ['平田|秀治', '46:07', '正常・暫定'],
    ['中村|史之', '45:37', '正常・暫定'],
    ['健士朗|脇山', '43:02', '正常・暫定'],
    ['田中|真也', '43:02', '正常・暫定'],
  ];
  expected.forEach((item) => {
    const row = realByName[item[0]];
    assert.ok(row, item[0]);
    assert.equal(Board.clockText(row.forecast.hours), item[1], item[0] + ' forecast');
    assert.equal(Board.judgmentText(row), item[2], item[0] + ' judgment');
    assert.equal(row.judgment === 'forecast-exceed', false);
  });
  const yamaguchi = realByName['山口|涼太'];
  assert.equal(yamaguchi.futureExceed.start, '2026-10-24');
  assert.equal(yamaguchi.futureExceed.end, '2026-10-30');
  assert.equal(Board.clockText(yamaguchi.futureExceed.totalHours), '61:50');
  assert.equal(Board.clockText(yamaguchi.futureExceed.overBy), '01:50');
  assert.ok(yamaguchi.evidence.some((item) => item.period === 'past' && item.exceeds), '過去の超過は詳細に残す');
  const futureEvidence = yamaguchi.evidence.find((item) => item.start === '2026-10-24' && item.end === '2026-10-30');
  assert.equal(Board.clockText(futureEvidence.totalHours), '61:50');
  assert.equal(Board.clockText(futureEvidence.overBy), '01:50');
  const fukagawa = realByName['愛斗|深川'];
  assert.equal(Board.clockText(fukagawa.past6.hours), '51:45');
  assert.equal(Board.clockText(fukagawa.forecast.hours), '56:15');
  assert.equal(Board.clockText(fukagawa.workable.hours), '08:15');
  assert.equal(Board.judgmentText(fukagawa), '正常・暫定');
  const rest = fukagawa.days.find((day) => day.date === '2026-10-23');
  assert.equal(rest.adopted, '休み');
  assert.equal(rest.hours, 0);
  assert.equal(fukagawa.futureExceed, null);
  assert.ok(fukagawa.evidence.some((item) => item.period === 'past' && item.exceeds), '深川さんの過去超過は履歴に残す');
  const orphan = realBoard.rows.find((row) => row.transportId === 'A68K4KDSUY8BF');
  assert.equal(Board.displayName(orphan), '未照合DA（A68K4KDSUY8BF）');
  assert.equal(orphan.recordedActuals.length, 2);
  assert.equal(orphan.recordedActuals[0].date, '2026-10-24');
  assert.equal(Board.clockText(orphan.recordedActuals[0].hours), '05:48');
  assert.equal(orphan.recordedActuals[1].date, '2026-10-26');
  assert.equal(Board.clockText(orphan.recordedActuals[1].hours), '02:43');
  console.log('rolling60h-today-window.test.mjs: real files checked');
}

console.log('rolling60h-today-window.test.mjs: ALL PASSED');
