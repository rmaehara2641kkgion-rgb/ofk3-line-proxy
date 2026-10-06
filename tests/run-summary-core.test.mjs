import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
require('../rolling60h-core.js');
const AssignSupportCore = require('../assign-support-core.js');
const Core = require('../run-summary-core.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}
function eq(actual, expected, message) {
  assert(actual === expected, message + ' (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')');
}

// ---------------------------------------------------------------------------
// 合成シフト表（「メイン」シート相当: 行3=ヘッダー、行4=曜日、行5〜=データ）
// ---------------------------------------------------------------------------
function buildMainRows(drivers, days) {
  const header = ['社名', '名前', '回数'];
  for (let d = 1; d <= days; d++) header.push(d);
  header.push('ローマ字名', 'Transport ID');
  const rows = [['2026年9月 DAシフト表'], [], header, ['', '', ''].concat(Array(days).fill('月'))];
  drivers.forEach((dr) => {
    const row = [dr.company || '', dr.name, dr.count === undefined ? '' : dr.count];
    for (let d = 1; d <= days; d++) row.push(dr.cells[d] === undefined ? '' : dr.cells[d]);
    row.push(dr.roman || '', dr.tid || '');
    rows.push(row);
  });
  return rows;
}

function counts(o) {
  return Object.assign({ MARU: 0, HACHI: 0, BIKE: 0, B1: 0, B2: 0, C1: 0, C3: 0 }, o);
}

function testClassify() {
  const c = Core.classifyShiftCell;
  eq(c('○').code, 'MARU', '○');
  eq(c('〇').code, 'MARU', '〇');
  eq(c('◯').code, 'MARU', '◯');
  eq(c('❽').code, 'HACHI', '❽');
  eq(c('⑧').code, 'HACHI', '⑧');
  eq(c('bike').code, 'BIKE', 'bike');
  eq(c('Bike').code, 'BIKE', 'Bike');
  eq(c('BIKE').code, 'BIKE', 'BIKE');
  eq(c('B1').code, 'B1', 'B1');
  eq(c('ｂ１').code, 'B1', '全角ｂ１');
  eq(c('b2').code, 'B2', 'b2');
  eq(c('C1').code, 'C1', 'C1');
  eq(c('c3').code, 'C3', 'c3');
  assert(c('C1').code !== c('C3').code, 'C1とC3は統合しない');
  eq(c('休').category, 'NON_WORKING', '休は非稼働');
  eq(c('公休').category, 'NON_WORKING', '公休は非稼働');
  eq(c('').category, 'BLANK', '空欄');
  eq(c(null).category, 'BLANK', 'null');
  eq(c('  ').category, 'BLANK', '空白のみ');
  eq(c(0).category, 'BLANK', '数式結果の0は空欄（実データ「メイン」シート）');
  eq(c('0').category, 'BLANK', '文字列の0も空欄');
  eq(c('C2').category, 'OTHER', 'C2は集計対象外（既知）');
  eq(c('唐津').category, 'OTHER', '唐津は集計対象外');
  eq(c('嘉').category, 'OTHER', '嘉は集計対象外');
  // 正式な集計ルール: 研修→○ / 研C1→C1 / C319・C320→C3（全角・小文字も同じ）
  eq(c('研修').code, 'MARU', '研修→○');
  eq(c('研修').category, 'TARGET', '研修は集計対象');
  eq(c('研C1').code, 'C1', '研C1→C1');
  eq(c('研Ｃ１').code, 'C1', '全角 研Ｃ１→C1');
  eq(c('C319').code, 'C3', 'C319→C3');
  eq(c('C320').code, 'C3', 'C320→C3');
  eq(c('ｃ３２０').code, 'C3', '全角小文字 ｃ３２０→C3');
  eq(c('C321').category, 'UNKNOWN_SHIFT', '定義外の C3xx は推測しない');
  eq(c('研C3').category, 'UNKNOWN_SHIFT', '定義外の 研xx は推測しない');
  eq(c('C319').convertedFrom, 'C319', '読み替え元を保持');
  eq(c('Z9').category, 'UNKNOWN_SHIFT', '未知コード');
  eq(c('C1+C3').category, 'UNKNOWN_SHIFT', '複合表記は推測で分割しない');
}

function testSummary() {
  const rows = buildMainRows(
    [
      // 所属は結合セル想定（先頭行のみ値あり）
      { company: 'JHS', name: '平田 太郎', count: 4, tid: 'A1', cells: { 1: '○', 2: '❽', 3: '休', 4: 'C1', 5: 'C3' } },
      { company: '', name: '中村　次郎', count: 3, tid: 'A2', cells: { 1: 'bike', 2: 'Bike', 3: 'b1', 6: '' } },
      // 同一人物の空白表記揺れ（重複行）→ 二重計上しない
      { company: '', name: ' 中村 次郎 ', tid: 'A2', cells: { 2: 'Bike', 7: 'B2' } },
      { company: '', name: '必要台数', cells: { 1: 5, 2: 5 } },
      { company: 'GDS', name: '佐藤  花子', count: 99, cells: { 1: '〇', 2: 'X?', 10: '研修', 11: 'C2', 12: '研Ｃ１', 13: 'C319', 14: 'c320', 15: '唐津', 16: '嘉' } },
      { company: '', name: '休み 太郎', cells: { 1: '休', 2: '休' } },
      // 同姓同名だが所属が違う → 統合しない
      { company: 'AE物流', name: '平田太郎', cells: { 3: '○' } },
      // 同所属・同名だが TID が違う → 統合しない
      { company: 'AE物流', name: '山田 一', tid: 'T1', cells: { 1: '○' } },
      { company: '', name: '山田一', tid: 'T2', cells: { 1: '○' } },
    ],
    30
  );

  const res = Core.summarizeShiftWorkbook({ メイン: rows, GDS: rows }, ['メイン', 'GDS'], {
    month: '2026-09',
    isNonDriverRow: AssignSupportCore.isShiftNonDriverRow,
  });
  eq(res.sheetsUsed.length, 1, 'メインシートのみ使用（DSP別シートと二重計上しない）');

  const aff = {};
  res.affiliations.forEach((a) => (aff[a.company] = a));
  eq(res.affiliations.map((a) => a.company).join(','), 'AE物流,GDS,JHS', '所属の並び順');

  // JHS
  eq(aff.JHS.total, 8, 'JHS合計（平田5 + 中村: bike,bike,b1,b2 → 2日のBike重複は1回）');
  const hirata = aff.JHS.drivers.find((d) => d.nameKey === '平田太郎');
  const nakamura = aff.JHS.drivers.find((d) => d.nameKey === '中村次郎');
  assert(hirata && nakamura, 'JHSドライバー');
  eq(JSON.stringify(hirata.counts), JSON.stringify(counts({ MARU: 1, HACHI: 1, C1: 1, C3: 1 })), '平田の内訳');
  eq(hirata.total, 4, '平田: 休はカウントしない');
  eq(JSON.stringify(nakamura.counts), JSON.stringify(counts({ BIKE: 2, B1: 1, B2: 1 })), '中村の内訳（表記揺れ統合・同日重複除外）');
  eq(nakamura.name, '中村 次郎', '表示名は空白正規化');
  eq(aff.JHS.headcount, 2, 'JHS構成人数（必要台数行は除外）');
  assert(res.warnings.some((w) => w.type === 'MERGED_DUPLICATE_ROWS' && w.name === '中村 次郎'), '重複行統合の警告');
  assert(res.warnings.some((w) => w.type === 'DUPLICATE_SHIFT_SAME_DAY'), '同日重複の警告');

  // GDS
  eq(aff.GDS.total, 5, 'GDS: 〇・研修・研C1・C319・C320 を集計（C2・唐津・嘉は除外）');
  eq(JSON.stringify(aff.GDS.counts), JSON.stringify(counts({ MARU: 2, C1: 1, C3: 2 })), 'GDS内訳（読み替え後）');
  eq(res.convertedCodes.length, 4, '読み替え実績4件');
  eq(res.convertedCodes.map((x) => x.raw + '@' + x.sheet + '!' + x.cell + '→' + x.code).join(','),
    '研修@メイン!M9→MARU,研Ｃ１@メイン!O9→C1,C319@メイン!P9→C3,c320@メイン!Q9→C3', '読み替えのセル位置');
  eq(aff.GDS.headcount, 1, 'GDS構成人数（全日休の人は数えない）');
  eq(aff.GDS.zeroShiftDrivers.length, 1, '全日休の人は zeroShiftDrivers');
  eq(res.unknownShifts.length, 1, 'UNKNOWN_SHIFT 1件');
  eq(res.unknownShifts[0].raw, 'X?', 'UNKNOWN_SHIFT の値');
  eq(res.unknownShifts[0].date, '2026-09-02', 'UNKNOWN_SHIFT の日付');
  eq(res.unknownShifts[0].cell, 'E9', 'UNKNOWN_SHIFT のセル位置');
  eq(res.otherCodes['研修'], undefined, '研修は対象外コードではない');
  eq(res.otherCodes['唐津'], 1, '唐津は対象外として件数表示');
  eq(res.otherCodes['嘉'], 1, '嘉は対象外として件数表示');
  eq(res.otherCodes.C2, 1, 'C2は対象外として件数表示');
  assert(res.warnings.some((w) => w.type === 'COUNT_COLUMN_MISMATCH' && w.sheetCount === 99), '回数列との不一致を検知');

  // AE物流: 平田太郎(別所属) 1 + 山田(T1) 1 + 山田(T2) 1
  eq(aff['AE物流'].total, 3, 'AE物流合計');
  eq(aff['AE物流'].headcount, 3, '同名別所属・同名別TIDは別人');
  assert(res.warnings.some((w) => w.type === 'SAME_NAME_MULTIPLE_COMPANIES'), '同名別所属の警告');
  assert(res.warnings.some((w) => w.type === 'SAME_NAME_DIFFERENT_TID'), '同名別TIDの警告');

  eq(res.totals.total, 16, '全社合計');
  eq(res.totals.headcount, 6, '全社構成人数');
  let sum = 0;
  Object.keys(res.totals.counts).forEach((k) => (sum += res.totals.counts[k]));
  eq(sum, res.totals.total, '合計シフト = 各コース合計');

  // 対象月外（月指定と異なる）
  const resOther = Core.summarizeShiftWorkbook({ メイン: rows }, ['メイン'], { month: '2026-10' });
  assert(resOther.warnings.some((w) => w.type === 'SHEET_MONTH_DIFFERS_FROM_SELECTED'), '年月不一致の警告');
  eq(resOther.totals.total, 0, '対象月外は集計しない');

  // Excel AOA
  const aoa = Core.buildSummaryAoa(res);
  const hdr = aoa.find((r) => r[0] === '所属' && r[1] === '合計シフト');
  eq(hdr.join(','), '所属,合計シフト,○,❽,bike,b1,b2,C1,C3,構成人数', 'サマリーヘッダー');
  const totalRow = aoa.find((r) => r[0] === '全社合計');
  eq(totalRow[1], 16, '全社合計行');
  assert(aoa.some((r) => r[0] === 'JHS 合計' && r[2] === 8), '所属ブロック合計行');
  assert(aoa.some((r) => r[0] === '所属' && r[1] === 'ドライバー名'), '内訳ヘッダー');
  return res;
}

function testSerialHeaderWithTrailingDayNumber() {
  // 実データ「メイン」: 見出しは 9/1〜9/30 のExcel日付（シリアル値）＋末尾に数値「31」、空欄セルは 0
  const header = ['社　名', '名　前', '回数'];
  for (let i = 0; i < 30; i++) header.push(46266 + i);
  header.push(31, 'Roman character', 'Transport ID');
  const row = ['GDS', '砥綿　剛平', 1];
  for (let i = 0; i < 30; i++) row.push(i === 14 ? '○' : 0);
  row.push('○', 'x', 'T');
  const res = Core.summarizeShiftWorkbook({ メイン: [[46266], [], header, ['', '', '', '火'], row] }, ['メイン'], { month: '2026-09' });
  eq(res.sheetsUsed[0].dateRange.max, '2026-09-30', '存在しない 9/31 列を作らない');
  eq(res.totals.total, 1, '末尾「31」列の値は集計しない');
  eq(res.unknownShifts.length, 0, '0 は UNKNOWN_SHIFT にしない');
  assert(res.warnings.some((w) => w.type === 'DAY_ONLY_HEADER_IGNORED'), '日番号だけの見出しを無視した警告');
  assert(!res.warnings.some((w) => w.type === 'COUNT_COLUMN_MISMATCH'), '回数列は○の回数として照合');
}

function testDateHeaderAndDuplicateColumns() {
  // Date型ヘッダー + 同じ日付が「時間計算列(数値)」と「記号列」の2系統あるケース
  const d1 = new Date(2026, 8, 1);
  const d2 = new Date(2026, 8, 2);
  const dates = [];
  for (let i = 1; i <= 8; i++) dates.push(new Date(2026, 8, i));
  const header = ['社名', '名前'].concat(dates).concat(dates);
  const row = ['LINGｓ', '鈴木 三郎'].concat([11, 8, 0, 0, 0, 0, 0, 0]).concat(['○', '❽', '', '', '', '', '', '']);
  const res = Core.summarizeShiftWorkbook({ LINGｓ: [header, row] }, ['LINGｓ'], { month: '2026-09' });
  eq(res.totals.total, 2, '記号列を採用（数値列は使わない）');
  eq(res.affiliations[0].company, 'LINGｓ', '所属表記は原体のまま');
  assert(d1 && d2, 'dates');

  // xlsxファイル経由（日付ヘッダーはExcelシリアル値として読まれる）でも同じ結果になる
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, row], { cellDates: false }), 'LINGｓ');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const back = XLSX.read(buf, { type: 'buffer' });
  const rows2 = XLSX.utils.sheet_to_json(back.Sheets['LINGｓ'], { header: 1, raw: true, defval: '' });
  assert(typeof rows2[0][2] === 'number', 'ヘッダーはシリアル値');
  const res2 = Core.summarizeShiftWorkbook({ LINGｓ: rows2 }, ['LINGｓ'], { month: '2026-09' });
  eq(res2.totals.total, 2, 'xlsx経由でも同じ集計');
  eq(res2.dateRange.min, '2026-09-01', 'シリアル値→日付の変換（タイムゾーンずれなし）');
}

// ---------------------------------------------------------------------------
// 実データ回帰（2026年9月）。個人情報を含むため原体はリポジトリに含めない。
//   RUN_SUMMARY_SHIFT_XLSX=<シフト表>   （既定: tests/fixtures/run-summary/private/shift-2026-09.xlsx）
//   RUN_SUMMARY_EXPECTED_XLSX=<完成版Excel>（既定: tests/fixtures/run-summary/private/expected-2026-09.xlsx）
// ---------------------------------------------------------------------------
const EXPECTED_2026_09 = {
  AE物流: [108, 72, 11, 20, 0, 0, 1, 4, 5],
  AGENTLINE: [57, 55, 0, 0, 0, 0, 0, 2, 4],
  GDS: [278, 112, 78, 45, 29, 10, 2, 2, 21],
  JHS: [474, 192, 226, 20, 9, 20, 1, 6, 32],
  LINGｓ: [96, 66, 25, 0, 0, 0, 2, 3, 7],
  ファンタジスタ: [55, 29, 26, 0, 0, 0, 0, 0, 3],
  全社合計: [1068, 526, 366, 85, 38, 30, 6, 17, 72],
};

function rowOf(total, c, headcount) {
  return [total, c.MARU, c.HACHI, c.BIKE, c.B1, c.B2, c.C1, c.C3, headcount];
}

function readWorkbook(XLSX, file) {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const sheets = {};
  wb.SheetNames.forEach((sn) => (sheets[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' })));
  return { sheets, order: wb.SheetNames };
}

// 完成版Excelの「所属別運行集計」シートからドライバー別内訳（所属|氏名キー → 合計,○,❽,bike,b1,b2,C1,C3）を抽出
function readExpectedDrivers(exp) {
  const rows = exp.sheets['所属別運行集計'];
  assert(rows, '完成版Excelに「所属別運行集計」シートがない');
  const out = {};
  let inBlock = false;
  rows.forEach((r) => {
    const a = String(r[0] || '').trim();
    const b = String(r[1] || '').trim();
    if (a === '所属' && (b === 'ドライバー' || b === 'ドライバー名')) {
      inBlock = true;
      return;
    }
    if (!inBlock || !a || !b || /合計$/.test(a)) return;
    out[a + '|' + Core.nameKey(b)] = r.slice(2, 10).map(Number).join(',');
  });
  return out;
}

function compareDrivers(res, expectedDrivers, label) {
  const actualDrivers = {};
  res.affiliations.forEach((a) => a.drivers.forEach((d) => {
    actualDrivers[a.company + '|' + d.nameKey] = rowOf(d.total, d.counts, 0).slice(0, 8).join(',');
  }));
  const ddiffs = [];
  Object.keys(expectedDrivers).forEach((k) => {
    if (actualDrivers[k] !== expectedDrivers[k]) ddiffs.push(k + ': got ' + actualDrivers[k] + ' / expected ' + expectedDrivers[k]);
  });
  Object.keys(actualDrivers).forEach((k) => {
    if (!expectedDrivers[k]) ddiffs.push(k + ': 完成版に無いドライバー ' + actualDrivers[k]);
  });
  assert(ddiffs.length === 0, label + ': ドライバー別集計が完成版Excelと不一致\n  ' + ddiffs.join('\n  '));
}

function compareAffiliations(res, label) {
  const actual = {};
  res.affiliations.forEach((a) => (actual[a.company] = rowOf(a.total, a.counts, a.headcount)));
  actual['全社合計'] = rowOf(res.totals.total, res.totals.counts, res.totals.headcount);
  const diffs = [];
  Object.keys(EXPECTED_2026_09).forEach((k) => {
    const got = actual[k] ? actual[k].join(',') : '(なし)';
    if (got !== EXPECTED_2026_09[k].join(',')) diffs.push(k + ': got ' + got + ' / expected ' + EXPECTED_2026_09[k].join(','));
  });
  Object.keys(actual).forEach((k) => {
    if (!EXPECTED_2026_09[k]) diffs.push(k + ': 期待値に無い所属 ' + actual[k].join(','));
  });
  assert(diffs.length === 0, label + ': 所属別集計が期待値と不一致\n  ' + diffs.join('\n  '));
}

/**
 * 完成版Excelの「日付別」シート（1人×1日のシフト明細。シフト表原体から作成されたもの）を
 * 集計ロジックに通し、集計定義（構成人数・重複行統合・所属表記・並び）が完成版と一致することを確認する。
 * ※シフト表原体のパース（列検出・記号判定）の検証ではない（それは testRealData で行う）。
 */
function testGoldenDailyBreakdown() {
  const dir = path.join(__dirname, 'fixtures', 'run-summary', 'private');
  const expectedFile = process.env.RUN_SUMMARY_EXPECTED_XLSX || path.join(dir, 'expected-2026-09.xlsx');
  if (!fs.existsSync(expectedFile)) {
    console.log('SKIP: 完成版「日付別」明細による集計定義の検証（完成版Excelが未配置: ' + expectedFile + '）');
    return;
  }
  const XLSX = require('xlsx');
  const exp = readWorkbook(XLSX, expectedFile);
  const daily = exp.sheets['日付別'];
  assert(daily && daily.length > 1, '完成版Excelに「日付別」シートがない');
  const ser = (n) => new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10);
  const records = daily.slice(1).map((r, i) => ({
    sheet: '日付別', row: i + 2, company: Core.normalizeDisplayName(r[1]), rawName: String(r[2]),
    name: Core.normalizeDisplayName(r[2]), nameKey: Core.nameKey(r[2]), transportId: '', countColumnValue: null,
    cells: [{ date: typeof r[0] === 'number' ? ser(r[0]) : String(r[0]), value: r[3] }],
  }));
  const res = Core.summarizeShiftRecords(records, { month: '2026-09' });
  eq(res.unknownShifts.length, 0, '日付別: UNKNOWN_SHIFTなし');
  compareAffiliations(res, '日付別');
  compareDrivers(res, readExpectedDrivers(exp), '日付別');
  console.log('OK: 完成版「日付別」明細 → 全社1068・7コード・6所属・構成人数72・ドライバー' + Object.keys(readExpectedDrivers(exp)).length + '名が完全一致');
}

/**
 * 原体と完成版「日付別」を 1人×1日 で突き合わせ、差異を
 * 所属 / ドライバー / 日付 / 原体の値 / 風神の判定値 / 正解値 で列挙する（差異原因の追跡用）。
 */
function traceDailyDiffs(res, exp) {
  const ser = (n) => new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10);
  const golden = {};
  (exp.sheets['日付別'] || []).slice(1).forEach((r) => {
    const code = String(r[3]);
    if (code === '（休）') return;
    golden[Core.nameKey(r[2]) + '|' + (typeof r[0] === 'number' ? ser(r[0]) : r[0])] = { company: String(r[1]), code };
  });
  const labelOf = {};
  Core.TARGET_CODES.forEach((c) => (labelOf[c.key] = c.label));
  const ours = {};
  res.persons.forEach((p) => {
    p.records.forEach((rec) => rec.cells.forEach((cell) => {
      if (!cell.date.startsWith('2026-09')) return;
      const cls = Core.classifyShiftCell(cell.value);
      if (cls.category === 'BLANK') return;
      const k = p.nameKey + '|' + cell.date;
      ours[k] = ours[k] || { company: p.company, name: p.name, raws: [], codes: [] };
      ours[k].raws.push(String(cell.value) + '@' + rec.sheet + '!' + rec.row);
      ours[k].codes.push(cls.category === 'TARGET' ? labelOf[cls.code] : cls.category + (cls.category === 'OTHER' ? ':' + cls.code : ''));
    }));
  });
  const out = [];
  new Set([...Object.keys(golden), ...Object.keys(ours)]).forEach((k) => {
    const g = golden[k];
    const o = ours[k];
    const oursCode = o ? o.codes.filter((c) => Core.TARGET_CODES.some((t) => t.label === c)).join('+') : '';
    const gCode = g ? g.code : '';
    if (oursCode === gCode && (!g || !o || g.company === o.company)) return;
    const [nk, date] = k.split('|');
    out.push([(o && o.company) || (g && g.company), (o && o.name) || nk, date, o ? o.raws.join(' / ') : '(空欄/行なし)', o ? o.codes.join('+') : '(なし)', gCode || '(なし)'].join(' | '));
  });
  return out.sort();
}

function testRealData() {
  const dir = path.join(__dirname, 'fixtures', 'run-summary', 'private');
  const shiftFile = process.env.RUN_SUMMARY_SHIFT_XLSX || path.join(dir, 'shift-2026-09.xlsx');
  const expectedFile = process.env.RUN_SUMMARY_EXPECTED_XLSX || path.join(dir, 'expected-2026-09.xlsx');
  if (!fs.existsSync(shiftFile)) {
    console.log('SKIP: 2026年9月 シフト表原体の回帰（シフト表原体が未配置: ' + shiftFile + '）');
    return;
  }
  const XLSX = require('xlsx');
  const wb = readWorkbook(XLSX, shiftFile);
  const res = Core.summarizeShiftWorkbook(wb.sheets, wb.order, { month: '2026-09', isNonDriverRow: AssignSupportCore.isShiftNonDriverRow });
  console.log('INFO: 使用シート ' + res.sheetsUsed.map((m) => m.sheet + '（氏名列' + m.nameCol + '・社名列' + m.companyCol + '・日付行' + (m.dateRowIdx + 1) + '・' + m.dateRange.min + '〜' + m.dateRange.max + '）').join(',') +
    ' / UNKNOWN_SHIFT ' + res.unknownShifts.length + '件 / 対象外コード ' + JSON.stringify(res.otherCodes));
  res.unknownShifts.slice(0, 50).forEach((u) => console.log('  UNKNOWN_SHIFT: ' + [u.company, u.name, u.date, u.raw, u.sheet + '!' + u.cell].join(' | ')));
  // 読み替え（研修→○ / 研C1→C1 / C319・C320→C3）を原体のセル位置つきで列挙し、完成版「日付別」の同じ人・同じ日と照合する
  const labelOf = {};
  Core.TARGET_CODES.forEach((c) => (labelOf[c.key] = c.label));
  const byRaw = {};
  res.convertedCodes.forEach((x) => (byRaw[x.raw] = (byRaw[x.raw] || 0) + 1));
  console.log('INFO: 読み替え ' + res.convertedCodes.length + '件 ' + JSON.stringify(byRaw));
  let goldenDaily = null;
  if (fs.existsSync(expectedFile)) {
    const ser = (n) => new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10);
    goldenDaily = {};
    (readWorkbook(XLSX, expectedFile).sheets['日付別'] || []).slice(1).forEach((r) => (goldenDaily[Core.nameKey(r[2]) + '|' + ser(r[0])] = String(r[3])));
  }
  const convMismatch = [];
  res.convertedCodes.forEach((x) => {
    const g = goldenDaily ? goldenDaily[Core.nameKey(x.name) + '|' + x.date] : undefined;
    console.log('  読み替え: ' + [x.company, x.name, x.date, x.sheet + '!' + x.cell, '「' + x.raw + '」→' + labelOf[x.code], '完成版=' + (g === undefined ? '(未照合)' : g)].join(' | '));
    if (goldenDaily && g !== labelOf[x.code]) convMismatch.push(x.name + ' ' + x.date + ' ' + x.sheet + '!' + x.cell + ' ' + x.raw);
  });
  if (fs.existsSync(expectedFile)) {
    const diffs = traceDailyDiffs(res, readWorkbook(XLSX, expectedFile));
    if (diffs.length) {
      console.log('差異明細（所属 | ドライバー | 日付 | 原体の値@シート!行 | 風神の判定値 | 正解値）: ' + diffs.length + '件');
      diffs.forEach((d) => console.log('  ' + d));
    }
  }
  assert(convMismatch.length === 0, '読み替え結果が完成版と不一致: ' + convMismatch.join(' / '));
  compareAffiliations(res, '原体');
  console.log('OK: 2026年9月 原体 → 所属別集計・全社合計が期待値と一致（1068）');
  if (!fs.existsSync(expectedFile)) {
    console.log('SKIP: ドライバー別内訳の照合（完成版Excelが未配置: ' + expectedFile + '）');
    return;
  }
  const expectedDrivers = readExpectedDrivers(readWorkbook(XLSX, expectedFile));
  compareDrivers(res, expectedDrivers, '原体');
  console.log('OK: 原体 → ドライバー別集計が完成版Excelと一致（' + Object.keys(expectedDrivers).length + '名）');
}

testClassify();
testSummary();
testDateHeaderAndDuplicateColumns();
testSerialHeaderWithTrailingDayNumber();
testGoldenDailyBreakdown();
testRealData();
console.log('run-summary-core tests passed');
