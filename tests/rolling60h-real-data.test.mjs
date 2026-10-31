// 実データ比較テスト（10月31日基準）。実Excelは個人情報を含むためリポジトリに置かない。
// 環境変数でファイルを指定したときだけ実行する（未指定なら SKIPPED を表示して成功扱い）。
//   OFK3_REAL_SHIFT_OCT=/path/10月DAシフト.xlsx OFK3_REAL_SHIFT_NOV=/path/11月DAシフト.xlsx
//   OFK3_REAL_DAILY=/path/Daily_AMZL_...xlsx OFK3_REAL_FOCUS=氏名1,氏名2,氏名3  [OFK3_REAL_REF=2026-10-31]
// 比較: 10月のみ / 11月のみ / 10月+11月 / 同一ファイル再読込 / 読込順序の逆転
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const Rolling = require('../rolling60h-core.js');
const Run = require('../harvest-rolling60h-run.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

const env = process.env;
if (!env.OFK3_REAL_SHIFT_OCT || !env.OFK3_REAL_SHIFT_NOV || !env.OFK3_REAL_DAILY) {
  console.log('rolling60h-real-data.test.mjs: SKIPPED (OFK3_REAL_SHIFT_OCT / OFK3_REAL_SHIFT_NOV / OFK3_REAL_DAILY が未指定)');
  process.exit(0);
}
let checks = 0;
function assert(c, m) { checks++; if (!c) throw new Error('FAIL: ' + m); }

const REF = env.OFK3_REAL_REF || '2026-10-31';
const read = (f) => XLSX.read(fs.readFileSync(f), { type: 'buffer', cellDates: true });
const oct = { name: 'oct.xlsx', workbook: read(env.OFK3_REAL_SHIFT_OCT) };
const nov = { name: 'nov.xlsx', workbook: read(env.OFK3_REAL_SHIFT_NOV) };
const daily = read(env.OFK3_REAL_DAILY);
const dailyRows = XLSX.utils.sheet_to_json(daily.Sheets.Report5_Daily_Data, { header: 1, raw: true });
const hdr = dailyRows[0];
const col = (n) => hdr.indexOf(n);

function cap(books) {
  return Run.capture({ xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun, dailyRows, dailyFileName: 'daily.xlsx', shiftBooks: books, referenceDate: REF, historyFile: false });
}
const scen = {
  '10月のみ': cap([oct]),
  '11月のみ': cap([nov]),
  '10月+11月': cap([oct, nov]),
  '再読込(10,11,10)': cap([oct, nov, oct]),
  '逆順(11,10)': cap([nov, oct]),
};
const sig = (e) => JSON.stringify(e.drivers.map((d) => [d.transportId, d.windows.map((w) => [w.endDate, Math.round(w.totalHours * 1e6), w.judgment])]).sort());
console.log('\n基準日', REF);
console.log('シナリオ|対象|超過|接近|部分|判定不能|正常|他局実績あり|空白=休(人日)');
Object.keys(scen).forEach((k) => {
  const s = scen[k].summary;
  console.log([k, s.driverCount, s.exceedCount, s.approachCount, s.partialCount, s.undeterminedCount, s.clearCount, s.otherStationCount, s.blankRestPersonDays].join('|'));
});
assert(sig(scen['再読込(10,11,10)']) === sig(scen['10月+11月']), '同一ファイルを再読込しても同じ結果');
assert(sig(scen['逆順(11,10)']) === sig(scen['10月+11月']), '読込順序を逆転しても同じ結果');
assert(scen['10月+11月'].summary.undeterminedCount < scen['11月のみ'].summary.undeterminedCount, '10月を足すと判定不能が減る（減ること自体は成功条件にしない）');

// 重点対象: 日別の採用時間 = Amazon(OFK3)実績があれば実績、なければシフト予定（空白は0h）。二重加算なし。
const focus = (env.OFK3_REAL_FOCUS || '').split(',').map((x) => x.trim()).filter(Boolean);
const Dash = require('../duty-risk-dashboard.js');
const Snap = require('../duty-risk-snapshot.js');
const Board = require('../rolling60h-local-board.js');
const both = scen['10月+11月'];
const names = {};
['oct', 'nov'].forEach(() => {});
const built = Rolling.buildRosterTimelineFromSources([{ label: 'o', sheetsData: toSheets(oct.workbook) }, { label: 'n', sheetsData: toSheets(nov.workbook) }], {});
function toSheets(wb) {
  const skip = Run.ROSTER_SKIP;
  const out = {};
  wb.SheetNames.forEach((sn) => { if (!skip[sn]) out[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null }); });
  return out;
}
Object.keys(built.driverMeta).forEach((k) => { const m = built.driverMeta[k]; if (m.transportId) names[m.transportId] = m.name; });
const board = Board.buildBoard({ executed: both, referenceDate: REF, generatedAt: new Date().toISOString(), files: { shift: { ok: true }, daily: { ok: true } }, names }, { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf });
focus.forEach((n) => {
  const tid = Object.keys(names).find((t) => String(names[t]).replace(/[\s　]+/g, '') === n.replace(/[\s　]+/g, ''));
  console.log('\n## ' + n + (tid ? '' : '（シフト表に行なし → 未確認）'));
  if (!tid) return;
  const row = board.rows.find((r) => r.transportId === tid);
  const pred = both.predictions.find((p) => p.subjectId === tid && p.end === REF);
  console.log('日付|シフト記号|予定時間|Amazon実績(OFK3)|採用時間|データ状態');
  const roster = built.rosterBlocksByDriver[tid] || {};
  const days = pred ? pred.days : [];
  for (let i = 0; i < 7; i++) {
    const date = Rolling.addDaysIso(Rolling.addDaysIso(REF, -6), i);
    const rb = roster[date];
    const sym = rb === undefined ? '未確認' : (rb.length ? rb.map((b) => b.rawCode).join('+') : '(空白)');
    const planned = rb === undefined ? '未確認' : (rb.length ? (rb.every((b) => b.defined) ? rb.reduce((s, b) => s + b.hours, 0) : '不明') : 0);
    const acts = dailyRows.slice(1).filter((r) => r[col('transporter_id')] === tid && String(r[col('working_day')]).slice(0, 10) === date && String(r[col('station_code')]).toUpperCase() === 'OFK3');
    const actual = acts.length ? acts.reduce((s, r) => s + r[col('estimated_working_hour')], 0) : null;
    const d = days.find((x) => x.date === date);
    const adopted = d && typeof d.hours === 'number' ? d.hours : null;
    const state = !d ? '未読込' : (d.origin === 'daily-estimate' ? '実績' : d.rest === 'blank' ? '休み(空白)' : d.origin === 'roster-plan' ? '予定' : d.origin);
    console.log([date, sym, planned, actual === null ? 'なし' : actual.toFixed(2), adopted === null ? '未確認' : adopted.toFixed(2), state].join('|'));
    // 検証: 実績があれば実績、なければ予定時間。未確認は0にしない。
    if (actual !== null) assert(adopted !== null && Math.abs(adopted - actual) < 1e-6, date + ' は実績を採用（二重加算なし）');
    else if (typeof planned === 'number') assert(adopted === planned, date + ' は予定時間（空白は0h）');
    else assert(adopted === null, date + ' は未確認のまま（0hにしない）');
  }
  console.log('判定:', row ? row.judgmentLabel + (row.otherStation ? '・' + row.otherStation.label : '') : '(盤に無し)', '/ 7日窓', pred ? pred.level : 'なし', Math.round(pred ? pred.predictedTotal * 100 : 0) / 100 + 'h', '/ 前6日', row && row.past6.hours != null ? row.past6.hours.toFixed(2) : '未確認');
});
console.log('\nrolling60h-real-data.test.mjs: ALL PASSED (' + checks + ' checks)');
