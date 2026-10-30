// 月またぎ（10月→11月）シフト結合の回帰テスト。架空データのみ。
// 実Excel（最新10月/11月DAシフト.xlsx）の構造を再現:
//   - 各DSPシートは「前月の助走列（全員空白）＋当月」の日付見出しを持つ
//   - 10月シートの月末列(AO3相当)の見出しは数式ではなく定数 31（日付書式）
//   - 見出し直下に曜日行がある
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Rolling = require('../rolling60h-core.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

let checks = 0;
function assert(condition, message) {
  checks++;
  if (!condition) throw new Error('FAIL: ' + message);
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

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

/**
 * 実シフト表に近い形のシートを作り、xlsx に書き出して cellDates:true で読み戻した rows を返す。
 * @param {Array<string|object>} headers  日付('YYYY-MM-DD') または {constDay:31, weekday:'土'}
 * @param {Array<{name, tid, codes:{date:code}}>} drivers
 */
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
  // 定数日番号の見出しは実Excelと同じく「日付書式の数値」にする（cellDates で 1900-01-xx になる）
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

// ---- 架空データ ------------------------------------------------------------
const O = '○'; // 11h
const K = '休';
const octDates = range('2026-10-18', '2026-10-30');
const octLeadIn = range('2026-09-28', '2026-09-30');
const novLeadIn = range('2026-10-25', '2026-10-31');
const novDates = range('2026-11-01', '2026-11-30');

function codesFor(dates, code) {
  const o = {};
  dates.forEach((d) => { o[d] = code; });
  return o;
}

const octDrivers = [
  // T1: 10/26〜10/31 が○（66h）→ 10/26〜11/01 窓で超過
  { name: '運転手1', tid: 'T1', codes: Object.assign(codesFor(range('2026-10-26', '2026-10-31'), O), { '2026-10-20': 'C1' }) },
  // T2: 10/30・31 は明示的な「休」
  { name: '運転手2', tid: 'T2', codes: Object.assign(codesFor(range('2026-10-18', '2026-10-29'), 'B1'), { '2026-10-30': K, '2026-10-31': K }) },
  // T3: 10/30・31 は個人の空白（他の人は記号あり＝通常休み0h）
  { name: '運転手3', tid: 'T3', codes: codesFor(range('2026-10-18', '2026-10-29'), 'C3') },
  // T4: 10/25〜10/30 ○（66h）、10/31 は別シートと衝突（○ vs 休）
  { name: '運転手4', tid: 'T4', codes: Object.assign(codesFor(range('2026-10-25', '2026-10-30'), O), { '2026-10-31': O }) },
  // T5: 10/29 ○（別シートにも同じ○＝同一記号の重複）
  { name: '運転手5', tid: 'T5', codes: { '2026-10-29': O, '2026-10-31': 'B1' } },
  // T6: 10/28 は本シート空白、別シートで○（空白 vs 勤務記号 → 記号採用）
  { name: '運転手6', tid: 'T6', codes: { '2026-10-27': 'C1' } },
];
const octHeaders = octLeadIn.concat(octDates).concat([{ constDay: 31, weekday: '土', key: '2026-10-31' }]);
const octRows = sheetRows(octHeaders, octDrivers, '10月');

// 10月の別DSPシート（bike 等）: 同一ドライバーの重複・衝突を作る
const octBikeRows = sheetRows(range('2026-10-25', '2026-10-31'), [
  { name: '運転手4', tid: 'T4', codes: { '2026-10-31': K } },        // ○ vs 休 → 衝突
  { name: '運転手5', tid: 'T5', codes: { '2026-10-29': O, '2026-10-31': 'B2' } }, // 同一○ / B1 vs B2（同時間5h）
  { name: '運転手6', tid: 'T6', codes: { '2026-10-28': O } },        // 空白 vs ○
], '10月');

const novDrivers = [
  { name: '運転手1', tid: 'T1', codes: Object.assign({ '2026-11-01': K, '2026-11-02': O, '2026-11-30': 'C1' }) },
  { name: '運転手2', tid: 'T2', codes: { '2026-11-01': 'B1', '2026-11-02': '研修' } },
  { name: '運転手3', tid: 'T3', codes: { '2026-11-01': 'C3' } },
  { name: '運転手4', tid: 'T4', codes: { '2026-11-01': K } },
  { name: '運転手5', tid: 'T5', codes: { '2026-11-01': K } },
  { name: '運転手6', tid: 'T6', codes: { '2026-11-01': K } },
];
// 11月シート: 10/25〜10/31 の助走列は全員空白。11/30 の後ろに定数 31（12/1 とは不一致）を置く
const novHeaders = novLeadIn.concat(novDates).concat([{ constDay: 31, weekday: '火', key: '2026-12-01' }]);
const novRows = sheetRows(novHeaders, novDrivers, '11月');

const OCT = { label: '最新10月DAシフト.xlsx', sheetsData: { GDS: octRows, bike: octBikeRows } };
const NOV = { label: '最新11月DAシフト.xlsx', sheetsData: { GDS: novRows } };

function timeline(sources) {
  return Rolling.buildRosterTimelineFromSources(sources, {});
}
function seriesFor(built, tid, actual, ref) {
  const roster = built.rosterBlocksByDriver[tid] || {};
  const blended = Rolling.mergeActualAndRoster(actual || {}, roster, ref || '2026-10-31');
  return Rolling.buildContinuousDailySeries(blended, '2026-10-18', '2026-11-30');
}
function day(series, date) {
  return series.find((d) => d.date === date);
}
function win(windows, start) {
  return windows.find((w) => w.startDate === start);
}

const both = timeline([OCT, NOV]);

// ---- 0) 見出し復元と助走列除外 --------------------------------------------------
{
  const restored = both.warnings.filter((w) => w.type === 'header_date_restored');
  assert(restored.length === 1, '定数見出し31は10月シートの1列だけ復元される: ' + restored.length);
  assert(restored[0].date === '2026-10-31' && restored[0].file === OCT.label && restored[0].sheet === 'GDS', '復元先は 10月GDS の 10/31');
  assert(restored[0].cell && restored[0].rawHeader === 31 && restored[0].prevDate === '2026-10-30' && restored[0].weekday === '土', '復元列のセル・理由を記録');
  assert(!both.warnings.some((w) => w.type === 'header_date_restored' && w.file === NOV.label), '11/30 の後の定数31（12/1と不一致）は復元しない');
  const leadIn = both.warnings.filter((w) => w.type === 'lead_in_blank_date_column_excluded');
  assert(leadIn.filter((w) => w.file === NOV.label).length === 7, '11月シートの 10/25〜10/31 全員空白列は除外');
  assert(leadIn.filter((w) => w.file === OCT.label && w.sheet === 'GDS').length === 3, '10月シートの 9/28〜9/30 全員空白列は除外');

  // 曜日不一致なら復元しない
  const badWeekday = sheetRows(octDates.concat([{ constDay: 31, weekday: '日', key: '2026-10-31' }]), octDrivers, '10月');
  const p = Rolling.parseMonthlyRosterSheetRows(badWeekday, { restoreDayNumberHeaders: true });
  assert(!p.warnings.some((w) => w.type === 'header_date_restored') && p.meta.dateRange.max === '2026-10-30', '曜日が一致しない定数見出しは復元しない');
  // オプション無し（既存呼び出し）では従来どおり復元・除外しない
  const legacy = Rolling.parseMonthlyRosterSheetRows(octRows);
  assert(legacy.meta.dateRange.min === '2026-09-28' && legacy.meta.dateRange.max === '2026-10-30', '既存呼び出しの解析結果は変わらない');
  assert(!legacy.records.some((r) => 'cell' in r), '既存呼び出しのレコードに cell は付かない');
}

// ---- 1) 10/30・31 に勤務記号がある場合、正しく表示される --------------------------------
{
  const s = seriesFor(both, 'T1');
  ['2026-10-30', '2026-10-31'].forEach((d) => {
    const rec = day(s, d);
    assert(!rec.noData && rec.blocks.length === 1 && rec.blocks[0].code === 'MARU', 'T1 ' + d + ' は○');
    assert(Rolling.formatRollingBlockLabel(rec.blocks[0]) === '○ 予定', 'T1 ' + d + ' の表示は「○ 予定」');
    assert(rec.dailyTotalHours === 11, 'T1 ' + d + ' は11h');
  });
}

// ---- 2) 明示的な「休」は0時間 ----------------------------------------------------
{
  const s = seriesFor(both, 'T2');
  ['2026-10-30', '2026-10-31'].forEach((d) => {
    const rec = day(s, d);
    assert(!rec.noData && rec.blocks[0].code === 'KYU' && rec.dailyTotalHours === 0 && !rec.hasUnconfirmed, 'T2 ' + d + ' は休=0h');
  });
}

// ---- 3) 対象範囲内の個人の空白セルは0時間（通常休み） ------------------------------------
{
  const s = seriesFor(both, 'T3');
  ['2026-10-30', '2026-10-31'].forEach((d) => {
    const rec = day(s, d);
    assert(!rec.noData && rec.blocks.length === 0 && rec.dailyTotalHours === 0 && !rec.hasUnconfirmed, 'T3 ' + d + ' は空白=0h（欠落ではない）');
  });
}

// ---- 4) 日付データ欠落は「休」にならない（11月ファイルだけ読んだ場合） ------------------------
{
  const novOnly = timeline([NOV]);
  const s = seriesFor(novOnly, 'T1');
  ['2026-10-25', '2026-10-30', '2026-10-31'].forEach((d) => {
    const rec = day(s, d);
    assert(rec.noData === true && rec.blocks.length === 0, '11月のみ: ' + d + ' は欠落（noData）で休ではない');
  });
  const w = win(Rolling.computeRolling60h(s), '2026-10-26');
  assert(w.judgment === 'undetermined' && w.complete === false, '欠落日を含む窓は判定不能');
  // 旧経路（修正前）では同じ日が「休」0h として扱われていたことの確認（原因の固定化）
  const p = Rolling.parseMonthlyRosterSheetRows(novRows);
  const g = Rolling.groupRosterRecordsByDriver(p.records);
  assert(deepEqual(g.T1.blocksByDate['2026-10-30'], []), '旧経路では 10/30 が空=休扱いになっていた（再現）');
}

// ---- 5) 10/31→11/01 をまたぐ7日窓 -------------------------------------------------
{
  const s = seriesFor(both, 'T1');
  const ws = Rolling.computeRolling60h(s);
  const w1 = win(ws, '2026-10-26'); // 10/26〜11/01: ○×6 + 休 = 66h
  assert(w1.endDate === '2026-11-01' && w1.totalHours === 66 && w1.judgment === 'exceed', '10/26〜11/01 は66hで超過: ' + w1.totalHours);
  const w2 = win(ws, '2026-10-27'); // 10/27〜11/02: ○×5 + 休 + ○ = 66h
  assert(w2.endDate === '2026-11-02' && w2.totalHours === 66 && w2.judgment === 'exceed', '10/27〜11/02 は66h');
  const w3 = win(ws, '2026-10-28'); // 10/28〜11/03: ○×4 + 休 + ○ + 空白 = 55h
  assert(w3.endDate === '2026-11-03' && w3.totalHours === 55 && w3.judgment === 'within', '10/28〜11/03 は55h');
}

// ---- 6) 同じ日番号の別月データを混同しない（10/30 と 11/30） -------------------------------
{
  const s = seriesFor(both, 'T1');
  assert(day(s, '2026-10-30').blocks[0].code === 'MARU' && day(s, '2026-11-30').blocks[0].code === 'C1', '10/30=○ と 11/30=C1 を区別');
}

// ---- 7) 未定義記号は判定不能 ------------------------------------------------------
{
  const s = seriesFor(both, 'T2');
  const rec = day(s, '2026-11-02');
  assert(rec.hasUndefinedHours && rec.undefinedCodes[0] === '研修', '研修は時間未確定');
  const w = win(Rolling.computeRolling60h(s), '2026-10-27');
  assert(w.judgment === 'undetermined' && w.hasUndefinedHours, '研修を含む窓は判定不能（時間を推測しない）');
}

// ---- 8) 衝突（休 vs ○）は判定不能、既知分だけで超過なら knownOver を維持 ----------------------
{
  const c = both.conflicts.find((x) => x.driverKey === 'T4' && x.date === '2026-10-31');
  assert(c && c.resolution === 'undetermined', 'T4 10/31 は衝突（休 vs ○）');
  const labels = c.sources.map((x) => x.label + '!' + x.cell + '=' + x.rawCode).sort();
  assert(labels.length === 2 && labels[0] === OCT.label + '::GDS!S8=○' && labels[1] === OCT.label + '::bike!I5=休', '衝突の由来ファイル・シート・セルを追跡できる: ' + labels.join(' | '));
  const s = seriesFor(both, 'T4');
  const rec = day(s, '2026-10-31');
  assert(rec.blocks[0].conflict && rec.dailyTotalHours === 0 && rec.hasUnconfirmed, '衝突日は時間を加算せず未確定');
  assert(Rolling.formatRollingBlockLabel(rec.blocks[0]) === '衝突', '衝突日の表示は「衝突」（休と表示しない）');
  const w = win(Rolling.computeRolling60h(s), '2026-10-25'); // ○×6=66h + 衝突
  assert(w.judgment === 'undetermined' && w.knownOver === true && w.knownOverBy === 6, '既知分66hで knownOver を維持');
  // Amazon実績がある過去日は実績優先（既存ルール維持）
  const actual = { '2026-10-31': [{ code: 'AMAZON_ESTIMATE', rawCode: '(estimated_working_hour)', source: 'actual', hours: 9, defined: true }] };
  const s2 = seriesFor(both, 'T4', actual, '2026-11-01');
  assert(day(s2, '2026-10-31').actualHours === 9, '衝突日でも実績がある過去日は実績を採用');
}

// ---- 同一記号の重複・同時間の異記号・空白 vs 記号 ------------------------------------------
{
  const dupT5 = both.duplicates.filter((x) => x.driverKey === 'T5' && x.date === '2026-10-29');
  assert(dupT5.length === 1 && dupT5[0].kind === 'same' && dupT5[0].count === 2, '同一○の重複は件数のみ記録');
  assert(!both.conflicts.some((x) => x.driverKey === 'T5' && x.date === '2026-10-29'), '同一記号は衝突にしない');
  const sameHours = both.conflicts.find((x) => x.driverKey === 'T5' && x.date === '2026-10-31');
  assert(sameHours && sameHours.resolution === 'same_hours' && sameHours.resolvedHours === 5, 'B1 vs B2（5h同士）は衝突記録＋時間確定');
  assert(day(seriesFor(both, 'T5'), '2026-10-31').dailyTotalHours === 5, '同時間の異記号は5hで計算');
  const ov = both.blankOverrides.find((x) => x.driverKey === 'T6' && x.date === '2026-10-28');
  assert(ov && ov.kept[0].rawCode === O, '空白 vs ○ は○を採用し記録');
  assert(day(seriesFor(both, 'T6'), '2026-10-28').blocks[0].code === 'MARU', 'T6 10/28 は○');
}

// ---- 読込順に依存しない ---------------------------------------------------------
{
  const rev = timeline([NOV, OCT]);
  const swapped = timeline([{ label: OCT.label, sheetsData: { bike: octBikeRows, GDS: octRows } }, NOV]);
  [rev, swapped].forEach((t, i) => {
    assert(deepEqual(t.rosterBlocksByDriver, both.rosterBlocksByDriver), '読込順を変えてもタイムラインは同一 #' + i);
    assert(deepEqual(t.conflicts, both.conflicts) && deepEqual(t.duplicates, both.duplicates) && deepEqual(t.blankOverrides, both.blankOverrides), '読込順を変えても衝突・重複記録は同一 #' + i);
    ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].forEach((tid) => {
      assert(deepEqual(Rolling.computeRolling60h(seriesFor(t, tid)), Rolling.computeRolling60h(seriesFor(both, tid))), '読込順を変えても判定は同一 ' + tid + ' #' + i);
    });
  });
}

// ---- 9) 月またぎに関係しない10月中の計算結果は変わらない ----------------------------------
{
  // 旧経路（オプション無し解析＋後勝ちマージ）と新経路で、10/18〜10/24 開始の窓が一致すること
  function legacyTimeline(sources) {
    const contrib = {};
    sources.forEach((src) => Object.keys(src.sheetsData).forEach((sn) => {
      const g = Rolling.groupRosterRecordsByDriver(Rolling.parseMonthlyRosterSheetRows(src.sheetsData[sn]).records);
      Object.keys(g).forEach((k) => (contrib[k] = contrib[k] || []).push({ label: src.label + '::' + sn, blocksByDate: g[k].blocksByDate }));
    }));
    const out = {};
    Object.keys(contrib).forEach((k) => { out[k] = Rolling.mergeRosterBlocksByDateAcrossSources(contrib[k]).merged; });
    return { rosterBlocksByDriver: out };
  }
  const octOnlyGds = { label: OCT.label, sheetsData: { GDS: octRows } };
  const oldT = legacyTimeline([octOnlyGds]);
  const newT = timeline([octOnlyGds]);
  ['T1', 'T2', 'T3'].forEach((tid) => {
    const pick = (t) => Rolling.computeRolling60h(seriesFor(t, tid)).filter((w) => w.startDate >= '2026-10-18' && w.endDate <= '2026-10-30');
    const a = pick(oldT);
    const b = pick(newT);
    assert(a.length === 7 && deepEqual(a, b), '10月中（10/18〜10/30）の窓は修正前後で同一 ' + tid);
  });
}

// ---- 既存マージ関数は変更していない（後勝ち） ----------------------------------------------
{
  const m = Rolling.mergeRosterBlocksByDateAcrossSources([
    { label: 'a', blocksByDate: { '2026-10-30': Rolling.parseShiftCellToBlocks(O, 'roster').blocks } },
    { label: 'b', blocksByDate: { '2026-10-30': [] } },
  ]);
  assert(deepEqual(m.merged['2026-10-30'], []) && m.duplicates.length === 1, '既存 mergeRosterBlocksByDateAcrossSources の挙動は維持');
}

console.log('rolling60h-month-boundary.test.mjs: ALL TESTS PASSED (' + checks + ' checks)');
