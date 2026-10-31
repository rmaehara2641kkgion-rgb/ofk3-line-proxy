// 複数月シフトの保持ルール（読込順・古いファイルの再読込・3ファイル上限・必要月不足の警告）。架空データのみ。
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Rolling = require('../rolling60h-core.js');
const Run = require('../harvest-rolling60h-run.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

let checks = 0;
function assert(c, m) { checks++; if (!c) throw new Error('FAIL: ' + m); }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), m + ' (actual=' + JSON.stringify(a) + ' expected=' + JSON.stringify(b) + ')'); }

const D = (iso) => { const p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
const M = '○', H = '❽', R = '休', N = null;
function days(from, n) {
  const p = from.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(p[0], p[1] - 1, p[2] + i)).toISOString().slice(0, 10));
}
// 10月ファイル: 10/25〜10/31 / 11月ファイル: 助走列(全員空白)10/25〜10/31 + 11/1〜11/14
const OCT = { 'T-A': [M, M, M, M, M, R, M], 'T-B': [H, H, N, H, H, R, H] };
function octSheet(over) {
  const rows = [['社名', '名前', 'Transport ID'].concat(days('2026-10-25', 7).map(D))];
  Object.keys(OCT).forEach((tid) => rows.push(['GDS', 'Fiction ' + tid, tid].concat(over && over[tid] ? over[tid] : OCT[tid])));
  return rows;
}
function novSheet() {
  const rows = [['社名', '名前', 'Transport ID'].concat(days('2026-10-25', 21).map(D))];
  Object.keys(OCT).forEach((tid) => rows.push(['GDS', 'Fiction ' + tid, tid].concat(new Array(7).fill(N), [H, H, R, H, H, R, R, H, H, H, H, R, R, H])));
  return rows;
}
const wbOf = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), 'GDS'); return wb; };
const sheetsOf = (rows) => ({ GDS: rows });
function src(label, rows, extra) {
  const sheetsData = sheetsOf(rows);
  return Object.assign({ label, sheetsData, months: Rolling.monthsOfSheets(sheetsData), modified: 1000 }, extra || {});
}
const dailyRows = [['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'], ['T-A', '2026-10-27', 9, 'OFK3']];
function judgeFromSources(list, ref) {
  const books = list.map((s) => ({ name: s.label, workbook: wbOf(s.sheetsData.GDS) }));
  const e = Run.capture({ xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun, dailyRows, dailyFileName: 'd.xlsx', shiftBooks: books, referenceDate: ref, historyFile: false });
  const j = {};
  e.drivers.forEach((d) => { const w = d.windows.find((x) => x.endDate === ref); j[d.transportId] = w ? [w.judgment, Math.round(w.totalHours * 100) / 100] : 'no-window'; });
  return { j, summary: e.summary };
}
const REF = '2026-10-31';
const NEED = Rolling.neededMonthsForReference(REF);

// 1. 読込順: 10月→11月 と 11月→10月 は同じ（上限内なので何も外れない）
{
  const octS = src('10月.xlsx', octSheet(), { rangeMax: '2026-10-31' });
  const novS = src('11月.xlsx', novSheet(), { rangeMax: '2026-11-14' });
  const a = Rolling.upsertRosterSource(Rolling.upsertRosterSource([], octS, 3, { neededMonths: NEED }).list, novS, 3, { neededMonths: NEED });
  const b = Rolling.upsertRosterSource(Rolling.upsertRosterSource([], novS, 3, { neededMonths: NEED }).list, octS, 3, { neededMonths: NEED });
  assert(a.list.length === 2 && b.list.length === 2 && !a.evicted && !b.evicted, '2ファイルは両方保持');
  const ra = judgeFromSources(a.list, REF);
  const rb = judgeFromSources(b.list, REF);
  eq(ra.j, rb.j, '10→11 と 11→10 で判定が同じ');
  eq(ra.j['T-A'], ['exceed', 64], 'T-A: 66→実績9で64h超過');
  eq(ra.j['T-B'], ['within', 40], 'T-B: 空白は0hで40h');
  eq(ra.summary.shiftMissingMonths, [], '必要な月は揃っている');
}

// 2. 同じ月の古いファイルの再読込
{
  const newer = src('10月.xlsx', octSheet(), { rangeMax: '2026-10-31', modified: 2000 });
  const older = src('10月.xlsx', octSheet({ 'T-B': [H, H, H, H, H, H, H] }), { rangeMax: '2026-10-31', modified: 1000 });
  const base = Rolling.upsertRosterSource([], newer, 3, { neededMonths: NEED }).list;
  const r = Rolling.upsertRosterSource(base, older, 3, { neededMonths: NEED });
  assert(r.keptNewer === true && r.replaced === false && r.list[0].modified === 2000 && r.list.length === 1, '同名で更新日時が古い再読込は置き換えず新しい方を残す');
  const same = Rolling.upsertRosterSource(base, Object.assign({}, newer), 3, { neededMonths: NEED });
  assert(same.replaced === true && same.list.length === 1, '同じ更新日時の再読込は置き換え（増えない）');
  const newest = Rolling.upsertRosterSource(base, Object.assign({}, newer, { modified: 3000 }), 3, { neededMonths: NEED });
  assert(newest.replaced === true && newest.list[0].modified === 3000, 'より新しいファイルなら置き換わる');
  // 別名の旧版: 黙って新旧を混ぜない。食い違う日は判定不能、重複月を警告。
  const both = [newer, Object.assign({}, older, { label: '10月_旧.xlsx' })];
  const cov = Rolling.checkRosterCoverage(both, REF);
  eq(cov.duplicateMonths, ['2026-10'], '同じ月が複数ファイルにあることを警告');
  assert(cov.warnings.length === 1, '重複月の警告だけが出る');
  const res = judgeFromSources(both, REF);
  eq(res.j['T-A'], ['exceed', 64], '食い違わない人の判定は変わらない');
  assert(res.j['T-B'][0] === 'undetermined' || res.j['T-B'] === 'no-window', '新旧で記号が食い違う人は判定不能（どちらかを黙って採用しない）');
  assert(res.summary.shiftConflictDays >= 1, '衝突日数を記録');
}

// 3. 3ファイル上限: 判定に必要な月を誤って外さない
{
  const f = (label, max, months) => ({ label, rangeMax: max, months, modified: 1 });
  // 基準日10/31の判定に必要なのは10月。旧実装なら「最も古い=10月」を外していた。
  const list = [f('10月', '2026-10-31', ['2026-10']), f('11月', '2026-11-30', ['2026-11']), f('12月', '2026-12-31', ['2026-12'])];
  const r = Rolling.upsertRosterSource(list, f('1月', '2027-01-31', ['2027-01']), 3, { neededMonths: Rolling.neededMonthsForReference('2026-10-31') });
  eq(r.list.map((s) => s.label).sort(), ['10月', '12月', '1月'].sort(), '必要な10月は残し、不要な最古(11月)を外す');
  eq(r.evicted.label, '11月', '外したのは不要な月');
  // 基準日が月初(11/3)なら10月と11月の両方が必要
  const r2 = Rolling.upsertRosterSource([f('9月', '2026-09-30', ['2026-09']), f('10月', '2026-10-31', ['2026-10']), f('11月', '2026-11-30', ['2026-11'])], f('12月', '2026-12-31', ['2026-12']), 3, { neededMonths: Rolling.neededMonthsForReference('2026-11-03') });
  eq(r2.evicted.label, '9月', '10月・11月は守り9月を外す');
  // 必要な月ばかりで外せない → 追加を受け付けず、何も消さない
  const full = [f('10月v1', '2026-10-31', ['2026-10']), f('10月v2', '2026-10-31', ['2026-10']), f('11月', '2026-11-30', ['2026-11'])];
  const r3 = Rolling.upsertRosterSource(full, f('12月', '2026-12-31', ['2026-12']), 3, { neededMonths: Rolling.neededMonthsForReference('2026-11-03') });
  assert(r3.rejected === true && r3.reason === 'incoming-not-needed' && r3.list.length === 3 && !r3.evicted, '外せるものが無ければ追加を拒否し、既存は消さない');
  // 月が不明なファイルは守る（推測で外さない）
  const unknown = [{ label: '不明', rangeMax: '2026-01-31' }, f('11月', '2026-11-30', ['2026-11']), f('12月', '2026-12-31', ['2026-12'])];
  const r4 = Rolling.upsertRosterSource(unknown, f('1月', '2027-01-31', ['2027-01']), 3, { neededMonths: NEED });
  assert(r4.evicted && r4.evicted.label === '11月' && r4.list.some((s) => s.label === '不明'), '月が不明なファイルは外さない');
  const input = list.slice();
  Rolling.upsertRosterSource(input, f('1月', '2027-01-31', ['2027-01']), 3, { neededMonths: NEED });
  assert(input.length === 3, '入力配列は変更しない');
}

// 4. 必要な月が不足した場合は警告（0hにしない）
{
  const novOnly = [src('11月.xlsx', novSheet(), { rangeMax: '2026-11-14' })];
  const cov = Rolling.checkRosterCoverage(novOnly, REF);
  eq(cov.missing, ['2026-10'], '10/31基準で10月が不足');
  assert(cov.ok === false && /2026-10/.test(cov.warnings[0]) && /0時間にはしません/.test(cov.warnings[0]), '警告文に不足月と0時間にしない旨');
  const res = judgeFromSources(novOnly, REF);
  eq(res.summary.shiftMissingMonths, ['2026-10'], '集計結果にも不足月を残す');
  assert(res.summary.shiftCoverageWarnings.length === 1, '集計結果に警告を残す');
  assert(Object.values(res.j).every((v) => v === 'no-window' || v[0] === 'undetermined'), '不足時は判定不能（正常にしない）');
  const split = Rolling.checkRosterCoverage([src('11月.xlsx', novSheet())], '2026-11-03');
  eq(split.missing, ['2026-10'], '月初(11/3)は前月の10月も必要');
  assert(Rolling.checkRosterCoverage([src('10月.xlsx', octSheet()), src('11月.xlsx', novSheet())], '2026-11-03').ok === true, '10月+11月なら不足なし');
  eq(Rolling.checkRosterCoverage([], REF).missing, ['2026-10'], '何も読み込んでいなければ不足');
}

console.log('rolling60h-shift-retention.test.mjs: ALL PASSED (' + checks + ' checks)');
