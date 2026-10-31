// 10月・11月シフトの同時読込 / 空白=0時間 / 非ドライバー行 / 他局実績の回帰テスト。架空データのみ。
// 実データの構造を再現する:
//   - 11月ファイルは 10/25〜10/31 の「全員空白の助走列」を持つ（対象期間外。0時間にしない）
//   - 10月ファイルにだけ 10/25〜10/31 のシフトがある
//   - 氏名列に「必要台数」の集計行がある / Transport ID の無い実在ドライバーがいる
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Rolling = require('../rolling60h-core.js');
const Run = require('../harvest-rolling60h-run.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

let checks = 0;
function assert(condition, message) {
  checks++;
  if (!condition) throw new Error('FAIL: ' + message);
}
function eq(a, b, message) {
  assert(JSON.stringify(a) === JSON.stringify(b), message + ' (actual=' + JSON.stringify(a) + ' expected=' + JSON.stringify(b) + ')');
}

const REF = '2026-10-31';
const D = (iso) => { const p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
function dates(from, count) {
  const out = [];
  const p = from.split('-').map(Number);
  for (let i = 0; i < count; i++) out.push(new Date(Date.UTC(p[0], p[1] - 1, p[2] + i)).toISOString().slice(0, 10));
  return out;
}
const N = null;
const M = '○';
const H = '❽';
const R = '休';

// [名前, TransportID, 10/25..10/31]
const OCT = [
  ['EXC Fiction', 'T-EXC', [M, M, M, M, M, R, M]],               // 66h  超過
  ['NEAR Fiction', 'T-NEAR', [M, M, M, M, H, R, H]],            // 52 + 8 = 60h  ちょうど（超過ではない・接近）
  ['BLANK Fiction', 'T-BLANK', [H, H, N, H, H, R, H]],          // 空白は0h: 40h  正常
  ['UNK Fiction', 'T-UNK', [M, M, 'C2', M, M, R, M]],           // C2 は時間不明 → 判定不能
  ['ACT Fiction', 'T-ACT', [H, H, M, H, H, R, H]],              // 10/27 は実績3h（予定11hと二重加算しない）
  ['OTHER Fiction', 'T-OTHER', [H, H, R, H, H, R, H]],          // 他局(OFK9)の実績あり
  ['必要台数', '', [5, 5, 5, 5, 5, 5, 5]],                       // 集計行（ドライバーではない）
  ['NOID Fiction', '', [H, H, H, H, H, R, H]],                   // Transport ID 未登録の実在ドライバー
];
const NOV_ONLY = [['NEWCOMER Fiction', 'T-NEW', [N, N, N, N, N, N, N]]];

function sheetRows(rowsOct, includeLeadIn) {
  const lead = includeLeadIn ? dates('2026-10-25', 7) : [];
  const nov = includeLeadIn ? dates('2026-11-01', 14) : [];
  const header = ['社名', '名前', 'Transport ID'].concat(includeLeadIn ? lead.concat(nov).map(D) : dates('2026-10-25', 7).map(D));
  const rows = [header];
  rowsOct.forEach((r) => {
    const cells = includeLeadIn ? new Array(7).fill(N).concat([H, H, R, H, H, R, R, H, H, H, H, R, R, H].slice(0, 14)) : r[2];
    rows.push(['GDS', r[0], r[1]].concat(cells));
  });
  return rows;
}
function book(rows, sheetName) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), sheetName || 'GDS');
  return wb;
}
const octBook = () => book(sheetRows(OCT, false));
// 11月ファイル: 10/25〜10/31 は全員空白の助走列。11月分は記号あり。
const novBook = () => book(sheetRows(OCT.concat(NOV_ONLY), true));

const dailyRows = [['transporter_id', 'working_day', 'estimated_working_hour', 'station_code']]
  .concat([
    ['T-ACT', '2026-10-27', 3, 'OFK3'],
    ['T-OTHER', '2026-10-30', 11, 'OFK9'],
    ['T-OTHER', '2026-10-26', 8, 'OFK3'],
  ]);

function capture(books, extra) {
  return Run.capture(Object.assign({
    xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyRows, dailyFileName: 'Daily_FICTION.xlsx', shiftBooks: books, referenceDate: REF, historyFile: false,
  }, extra || {}));
}
const bookOf = (name, wb) => ({ name, workbook: wb });
function dayHours(executed, tid) {
  const pred = executed.predictions.find((p) => p.subjectId === tid && p.end === REF);
  return pred ? pred.days.map((d) => ({ date: d.date, hours: d.hours, origin: d.origin, rest: d.rest || null })) : null;
}
function driver(executed, tid) { return executed.drivers.find((d) => d.transportId === tid); }
function judge(executed, tid) {
  const w = driver(executed, tid).windows.find((x) => x.endDate === REF);
  return w ? w.judgment : 'no-window';
}

// ---- 1. 読込元の管理（前月を消さない / 同名は置き換え / 順序非依存） ----
{
  let list = [];
  let r = Rolling.upsertRosterSource(list, { label: '10月.xlsx', rangeMax: '2026-10-31' });
  list = r.list;
  r = Rolling.upsertRosterSource(list, { label: '11月.xlsx', rangeMax: '2026-11-30' });
  list = r.list;
  eq(list.map((s) => s.label), ['10月.xlsx', '11月.xlsx'], '10月の後に11月を追加しても10月は残る');
  r = Rolling.upsertRosterSource(list, { label: '10月.xlsx', rangeMax: '2026-10-31', v: 2 });
  eq(r.list.map((s) => s.label), ['10月.xlsx', '11月.xlsx'], '同名の再読込は置き換え（増えない）');
  assert(r.replaced === true && r.list[0].v === 2, '再読込した内容に置き換わる');
  list = r.list;
  r = Rolling.upsertRosterSource(list, { label: '12月.xlsx', rangeMax: '2026-12-31' }, 2);
  eq(r.list.map((s) => s.label), ['11月.xlsx', '12月.xlsx'], '上限超過時だけ最も古い月を外す');
  eq(r.evicted && r.evicted.label, '10月.xlsx', '外したファイルを返す');
  assert(list.length === 2, '元の配列は変更しない');
}

// ---- 2. 非ドライバー行 / Transport ID未登録の実在ドライバー ----
{
  assert(Rolling.isNonDriverRowName('必要台数') && Rolling.isNonDriverRowName(' 合 計 ') && Rolling.isNonDriverRowName('小計'), '集計行は非ドライバー');
  assert(!Rolling.isNonDriverRowName('NOID Fiction') && !Rolling.isNonDriverRowName('計画 太郎'), '実在ドライバーは非ドライバーにしない');
  const built = Rolling.buildRosterTimelineFromSources([{ label: '10月', sheetsData: { GDS: sheetRows(OCT, false) } }], {});
  const keys = Object.keys(built.driverMeta);
  assert(!keys.some((k) => /必要台数/.test(k)), '必要台数は判定対象に入らない');
  assert(keys.some((k) => k === 'NAME:NOID Fiction'), 'Transport ID未登録の実在ドライバーは除外しない');
}

// ---- 3. 10月のみ / 11月のみ / 10月+11月 ----
const oct = capture([bookOf('10月DAシフト.xlsx', octBook())]);
const nov = capture([bookOf('11月DAシフト.xlsx', novBook())]);
const both = capture([bookOf('10月DAシフト.xlsx', octBook()), bookOf('11月DAシフト.xlsx', novBook())]);

// 10月のみ: 10月分のシフトは全部読める
eq(judge(oct, 'T-EXC'), 'exceed', '10月のみ: 66hは超過');
eq(judge(oct, 'T-NEAR'), 'approach', '10月のみ: ちょうど60hは接近（超過ではない）');
eq(judge(oct, 'T-BLANK'), 'within', '10月のみ: 空白を0hとして40h');
assert(judge(oct, 'T-UNK') === 'undetermined', '10月のみ: C2は時間不明で判定不能（0hにしない）');

// 11月のみ: 10/25〜10/31 のシフトは無い。助走列(全員空白)を休み0hにしてはならない。
// → 基準日を終端とする7日窓が作れず、盤では判定不能(未取得)になる。「正常」にはならない。
{
  ['T-EXC', 'T-NEAR', 'T-BLANK', 'T-UNK', 'T-ACT', 'T-OTHER'].forEach((tid) => {
    eq(judge(nov, tid), 'no-window', '11月のみ: 基準日の7日窓を作らない: ' + tid);
    assert(dayHours(nov, tid) === null, '11月のみ: 10/25〜10/31の日別時間を作らない（0hにしない）: ' + tid);
  });
  const Dash = require('../duty-risk-dashboard.js');
  const Snap = require('../duty-risk-snapshot.js');
  const Board = require('../rolling60h-local-board.js');
  const board = Board.buildBoard({ executed: nov, referenceDate: REF, generatedAt: '2026-10-31T03:00:00.000Z', files: { shift: { ok: true }, daily: { ok: true } }, names: {} },
    { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf });
  const exc = board.rows.find((r) => r.transportId === 'T-EXC');
  assert(exc.windowJudgment === null && exc.dataClass === '判定不能' && exc.judgment === 'review', '11月のみ: 盤では判定不能・要確認（正常にしない）');
}

// 10月+11月: 10月のみと同じ判定になる（11月ファイルの空白助走列が10月分を消さない）
['T-EXC', 'T-NEAR', 'T-BLANK', 'T-UNK', 'T-ACT'].forEach((tid) => {
  eq(judge(both, tid), judge(oct, tid), '10月+11月 = 10月のみ: ' + tid);
});
eq(dayHours(both, 'T-EXC'), dayHours(oct, 'T-EXC'), '日別の採用時間も同一: T-EXC');

// ---- 4. 空白は休み(0h)、実績は二重加算しない ----
{
  const days = dayHours(both, 'T-BLANK');
  const blank = days.find((d) => d.date === '2026-10-27');
  assert(blank.hours === 0 && blank.rest === 'blank', '空白は0時間・休み扱い');
  const total = days.reduce((s, d) => s + d.hours, 0);
  assert(total === 40, '空白を0hとして合計40h');
  const act = dayHours(both, 'T-ACT').find((d) => d.date === '2026-10-27');
  assert(act.hours === 3 && act.origin === 'daily-estimate', '実績3hを採用（予定11hを足さない）');
  const actTotal = dayHours(both, 'T-ACT').reduce((s, d) => s + d.hours, 0);
  assert(actTotal === 8 * 5 + 3 - 0, '実績日は実績のみ: 8×5 + 3 = 43h');
}

// ---- 5. 不明記号は0時間にしない ----
{
  const unk = dayHours(both, 'T-UNK').find((d) => d.date === '2026-10-27');
  assert(unk.hours === null, 'C2の日は時間なし（0hにしない）');
}

// ---- 6. 順序逆転・同一ファイル再読込・重複 ----
{
  const reversed = capture([bookOf('11月DAシフト.xlsx', novBook()), bookOf('10月DAシフト.xlsx', octBook())]);
  const reloaded = capture([bookOf('10月DAシフト.xlsx', octBook()), bookOf('11月DAシフト.xlsx', novBook()), bookOf('10月DAシフト.xlsx', octBook())]);
  const copy = capture([bookOf('10月DAシフト.xlsx', octBook()), bookOf('10月DAシフト(コピー).xlsx', octBook()), bookOf('11月DAシフト.xlsx', novBook())]);
  const pick = (e) => JSON.stringify({ s: e.summary.exceedCount + '/' + e.summary.approachCount + '/' + e.summary.partialCount + '/' + e.summary.undeterminedCount + '/' + e.summary.clearCount, d: e.drivers.map((d) => [d.transportId, d.windows.map((w) => [w.endDate, w.totalHours, w.judgment])]).sort() });
  assert(pick(reversed) === pick(both), '読込順序を逆転しても同じ結果');
  assert(pick(reloaded) === pick(both), '同一ファイルを再読込しても同じ結果（重複計上しない）');
  assert(pick(copy) === pick(both), '同じ内容の別名ファイルでも二重加算しない');
}

// ---- 7. 同じ日付が複数ファイルにあるときの優先順位 ----
{
  const a = [['社名', '名前', 'Transport ID', D('2026-10-31')], ['GDS', 'P Fiction', 'T-P', H]];
  const b = [['社名', '名前', 'Transport ID', D('2026-10-31')], ['GDS', 'P Fiction', 'T-P', N]];
  const c = [['社名', '名前', 'Transport ID', D('2026-10-31')], ['GDS', 'P Fiction', 'T-P', M]];
  const mk = (...rowsList) => rowsList.map((rows, i) => ({ label: 'f' + i, sheetsData: { GDS: rows } }));
  const day = (built) => built.rosterBlocksByDriver['T-P']['2026-10-31'];
  const symbolOverBlank = Rolling.buildRosterTimelineFromSources(mk(a, b), {});
  const symbolOverBlank2 = Rolling.buildRosterTimelineFromSources(mk(b, a), {});
  assert(day(symbolOverBlank)[0].rawCode === H && day(symbolOverBlank2)[0].rawCode === H, '空白と勤務記号が重なれば勤務記号を採用（順序非依存）');
  const conflict = Rolling.buildRosterTimelineFromSources(mk(a, c), {});
  assert(day(conflict)[0].conflict === true && conflict.conflicts.length === 1, '記号が食い違う日は衝突（判定不能）');
}

// ---- 8. 非ドライバー行と未登録ドライバー（盤の集計） ----
{
  assert(both.summary.unmatchedCount === 1, '突合できない実在ドライバーは1名（必要台数は含まない）');
  assert(!both.drivers.some((d) => /必要台数/.test(d.transportId)), '必要台数は判定対象に入らない');
}

// ---- 9. 他局実績 ----
{
  const d = driver(both, 'T-OTHER');
  assert(d.otherStation && d.otherStation.dates.join() === '2026-10-30' && d.otherStation.stations.join() === 'OFK9', '他局実績の日付と局を保持');
  const days = dayHours(both, 'T-OTHER');
  const day30 = days.find((x) => x.date === '2026-10-30');
  assert(day30.hours === 0 && day30.origin === 'roster-plan', '他局の11時間をOFK3の時間へ合算しない（予定の休0hのまま）');
  assert(both.summary.otherStationCount === 1 && both.summary.partialOtherStationCount === 1, '他局実績ありは要確認（部分）として数える');
  const Snap = require('../duty-risk-snapshot.js');
  eq(Snap.dispositionOf(d), 'partial', '他局実績ありは「正常」にしない');
  eq(Snap.dispositionOf(Object.assign({}, d, { otherStation: null })), 'clear', '他局実績が無ければ従来どおり正常');
  assert(driver(both, 'T-BLANK').otherStation === null, '他局実績が無い人は付かない');
}

// ---- 10. 読み込み済みの月の表示 ----
{
  const built = Rolling.buildRosterTimelineFromSources([
    { label: '10月.xlsx', sheetsData: { GDS: sheetRows(OCT, false) } },
    { label: '11月.xlsx', sheetsData: { GDS: sheetRows(OCT.concat(NOV_ONLY), true) } },
  ], {});
  const months = Rolling.describeRosterMonths(built.sourceMonths);
  eq(months.map((m) => m.months.join()), ['2026-10', '2026-11'], '読み込み済みの月（空白だけの助走列は月に数えない）');
  eq(both.summary.shiftFiles, ['10月DAシフト.xlsx', '11月DAシフト.xlsx'], '集計結果に読み込んだファイルを残す');
  eq(both.summary.shiftMonths.map((m) => m.months.join()), ['2026-10', '2026-11'], '集計結果に読み込み済みの月を残す');
}

// ---- 11. 旧挙動のオプション（blankAsRest:false）では空白は未確定のまま ----
{
  const legacy = capture([bookOf('10月DAシフト.xlsx', octBook())], { blankAsRest: false });
  assert(judge(legacy, 'T-BLANK') === 'undetermined', 'blankAsRest:false では従来どおり未確定');
}


// ---- 12. 定期集計（ディレクトリ読込）: 最新ファイルに加えて前月ファイルも読む ----
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-month-'));
  const dailyDir = path.join(root, 'daily');
  const shiftDir = path.join(root, 'shift');
  fs.mkdirSync(dailyDir);
  fs.mkdirSync(shiftDir);
  const dwb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(dwb, XLSX.utils.aoa_to_sheet(dailyRows), 'Report5_Daily_Data');
  XLSX.writeFile(dwb, path.join(dailyDir, 'Daily_AMZL_JP_Working_Hour_2026-10-30_(FICTION).xlsx'));
  XLSX.writeFile(octBook(), path.join(shiftDir, '10月DAシフト.xlsx'));
  const novPath = path.join(shiftDir, '11月DAシフト.xlsx');
  XLSX.writeFile(novBook(), novPath);
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(novPath, later, later); // 11月が最新
  const entries = fs.readdirSync(shiftDir).map((name) => ({ name, mtimeMs: fs.statSync(path.join(shiftDir, name)).mtimeMs }));
  eq(Run.selectLatestShift(entries).name, '11月DAシフト.xlsx', '最新は11月');
  eq(Run.selectPreviousMonthShift(entries, '11月DAシフト.xlsx').name, '10月DAシフト.xlsx', '前月ファイルは10月');
  eq(Run.selectPreviousMonthShift(entries, '10月DAシフト.xlsx').reason, 'no-previous-month-file', '前月ファイルが無ければ理由を返す');
  eq(Run.selectPreviousMonthShift(entries, 'シフト最新.xlsx').reason, 'month-unknown', '月が名前から分からなければ探さない（推測しない）');
  eq(Run.selectPreviousMonthShift([{ name: '12月DAシフト.xlsx', mtimeMs: 1 }], '1月DAシフト.xlsx').name, '12月DAシフト.xlsx', '1月の前月は12月');
  const result = Run.capture({
    fs, path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyDir, shiftDir, historyFile: false, referenceDate: REF,
  });
  eq(result.summary.shiftFiles, ['10月DAシフト.xlsx', '11月DAシフト.xlsx'], '定期集計は前月+最新の2ファイルを読む');
  eq(result.summary.previousMonthShiftReason, 'ok', '前月ファイルの取得結果を残す');
  assert(result.drivers.find((d) => d.transportId === 'T-EXC').windows.some((w) => w.endDate === REF && w.judgment === 'exceed'), '定期集計でも10/31終端の窓を判定できる');
  fs.unlinkSync(path.join(shiftDir, '10月DAシフト.xlsx'));
  const only = Run.capture({ fs, path, xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun, dailyDir, shiftDir, historyFile: false, referenceDate: REF });
  eq(only.summary.previousMonthShiftReason, 'no-previous-month-file', '前月ファイルが無い場合は理由を残して最新だけで続行');
  assert(only.summary.undeterminedCount + only.summary.partialCount > 0, '前月が無ければ判定不能/部分欠損が残る（正常にしない）');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('rolling60h-multi-month.test.mjs: ALL PASSED (' + checks + ' checks)');
