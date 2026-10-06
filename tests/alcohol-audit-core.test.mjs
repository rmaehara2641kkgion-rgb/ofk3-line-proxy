import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
require('../rolling60h-core.js');
const Summary = require('../run-summary-core.js');
const Alcohol = require('../alcohol-audit-core.js');
const XLSX = require('xlsx');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}
function eq(actual, expected, message) {
  assert(actual === expected, message + ' (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')');
}

function rec(company, name, days) {
  return {
    sheet: 's', row: 1, company, rawName: name, name: Summary.normalizeDisplayName(name), nameKey: Summary.nameKey(name),
    transportId: '', countColumnValue: null,
    cells: Object.keys(days).map((d) => ({ date: '2026-09-' + d, value: days[d] })),
  };
}

// 検知器CSVと同じ列構成（区分列なし）
function csvRows(lines) {
  return [[' ID', '氏名', '数値', '判定', '日時', '測定場所', '免許期限', '未測定理由']].concat(
    lines.map((l) => [l[0], l[1], l[2], l[3], l[4], '福重XPT', '100日', ''])
  );
}

function testSynthetic() {
  const summary = Summary.summarizeShiftRecords(
    [
      rec('JHS', '平田 秀治', { '01': '○', '02': '❽', '03': 'bike', '04': '○', '05': '○', '06': '○', '07': '休' }),
      rec('GDS', '辻　安香音', { '01': 'bike' }),
    ],
    { month: '2026-09' }
  );
  const before = summary.totals.total;
  const p = Alcohol.parseAlcoholRows(csvRows([
    ['1', '平田　秀治', '0.000', 'A', '2026/09/01 10:10:00'], // ○: 出発前
    ['1', '平田秀治', '0.000', 'A', '2026/09/01 21:00:00'], //     帰着後 → OK
    ['1', '平田 秀治', '0.000', 'A', '2026/09/02 14:00:00'], // ❽: 1回のみ・開始14:40の範囲内 → 出発前のみ → 軽微
    ['1', '平田 秀治', '0.000', 'A', '2026/09/03 17:00:00'], // bike: 1回のみ・開始9:00の範囲外 → 帰着後のみ → 重大
    ['1', '平田 秀治', '0.150', 'E', '2026/09/04 10:00:00'], // ○: E判定 → 重大
    ['1', '平田 秀治', '0.000', 'A', '2026/09/04 21:00:00'],
    ['1', '平田 秀治', '----', '中断', '2026/09/05 10:00:00'], // ○: 中断のみ → 未測定
    // 9/6 測定なし → 未測定
    ['1', '平田 秀治', '0.000', 'A', '2026/09/07 10:00:00'], // 休の日 → シフト外
    ['2', '田中安香音', '0.000', 'A', '2026/09/01 08:30:00'], // 名前対応で 辻 安香音 に紐付け
    ['2', '田中安香音', '0.000', 'A', '2026/09/01 18:00:00'],
    ['777', 'flex', '0.000', 'A', '2026/09/01 08:00:00'], // 共用ID → 照合対象外
    ['9', '未登録 太郎', '0.000', 'A', '2026/09/01 08:00:00'],
  ]));
  assert(p.ok, 'ヘッダー検出（先頭空白付き " ID" 列も可）');
  eq(p.meta.hasTimingColumn, false, '区分列なし');
  eq(p.records[0].time, '10:10:00', '時刻の取得');
  const aliases = Alcohol.parseAliasRows([['CSV表記', 'シフト表表記', '備考'], ['田中安香音', '辻　安香音', '同一人物']]);
  const au = Alcohol.auditAlcohol(summary, p.records, { aliases });
  const r = {};
  au.days.forEach((d) => (r[d.name + '|' + d.date] = d));
  eq(r['平田 秀治|2026-09-01'].result, 'OK', '最初=出発前・最後=帰着後');
  eq(r['平田 秀治|2026-09-02'].result, '軽微', '1回のみ・開始時刻付近 → 出発前');
  eq(r['平田 秀治|2026-09-03'].result, '重大', '1回のみ・開始時刻から離れる → 帰着後のみ');
  eq(r['平田 秀治|2026-09-03'].note, '出発前未測定', '備考');
  eq(r['平田 秀治|2026-09-04'].result, '重大', 'A以外判定');
  eq(r['平田 秀治|2026-09-05'].result, '未測定', '中断は有効な測定に含めない');
  eq(r['平田 秀治|2026-09-05'].note, '中断1回', '中断回数');
  eq(r['平田 秀治|2026-09-06'].result, '未測定', '測定なし');
  eq(r['平田 秀治|2026-09-07'].result, 'シフト外', '休の日の測定');
  eq(r['辻 安香音|2026-09-01'].result, 'OK', '名前対応で紐付け');
  eq(au.sharedRecords.length, 1, '共用IDは照合対象外');
  assert(au.unmatchedNames['未登録 太郎'], 'シフト表に無い氏名');
  eq(summary.totals.total, before, 'アルコール照合でシフト数は変わらない');
  assert(Alcohol.buildAlcoholAoa(au).length > 8, 'Excel出力AOA');

  // 区分列がある形式
  const p2 = Alcohol.parseAlcoholRows([['測定日時', '氏名', '測定区分', '判定'], ['2026/09/01 12:00', '平田秀治', '乗務前', 'A'], ['2026/09/01 13:00', '平田秀治', '乗務後', 'A']]);
  eq(p2.meta.hasTimingColumn, true, '区分列あり');
  const au2 = Alcohol.auditAlcohol(summary, p2.records);
  eq(au2.days.find((d) => d.date === '2026-09-01').result, 'OK', '区分列を優先');

  // Shift_JIS CSV のデコード
  const sjis = Buffer.from([0x8e, 0x81, 0x96, 0xbc]); // 「氏名」
  eq(Alcohol.decodeCsvBytes(sjis), '氏名', 'Shift_JIS判定');
  eq(Alcohol.decodeCsvBytes(Buffer.from('﻿氏名', 'utf-8')), '氏名', 'UTF-8(BOM)');
}

// 実データ: 検知器CSV（2026年9月）× 完成版「日付別」のシフト → 完成版の照合結果と 1人×1日 で完全一致すること
function testRealData() {
  const dir = path.join(__dirname, 'fixtures', 'run-summary', 'private');
  const csvFile = process.env.ALCOHOL_CSV || path.join(dir, 'alcohol-2026-09.csv');
  const expectedFile = process.env.RUN_SUMMARY_EXPECTED_XLSX || path.join(dir, 'expected-2026-09.xlsx');
  if (!fs.existsSync(csvFile) || !fs.existsSync(expectedFile)) {
    console.log('SKIP: アルコール実データ照合（CSV または完成版Excelが未配置）');
    return;
  }
  const text = Alcohol.decodeCsvBytes(fs.readFileSync(csvFile));
  const cwb = XLSX.read(text, { type: 'string', raw: true });
  const rows = XLSX.utils.sheet_to_json(cwb.Sheets[cwb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  const parsed = Alcohol.parseAlcoholRows(rows);
  assert(parsed.ok, '実CSVのヘッダー検出');
  eq(parsed.warnings.length, 0, '実CSVの日時がすべて解析できる');
  eq(parsed.records.length, rows.length - 1, '実CSVの全行を取得');

  const ewb = XLSX.read(fs.readFileSync(expectedFile), { type: 'buffer' });
  const sheet = (sn) => XLSX.utils.sheet_to_json(ewb.Sheets[sn], { header: 1, raw: true, defval: '' });
  const ser = (n) => new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10);
  const daily = sheet('日付別').slice(1);
  const summary = Summary.summarizeShiftRecords(
    daily.map((r, i) => ({ sheet: '日付別', row: i + 2, company: Summary.normalizeDisplayName(r[1]), rawName: String(r[2]), name: Summary.normalizeDisplayName(r[2]), nameKey: Summary.nameKey(r[2]), transportId: '', countColumnValue: null, cells: [{ date: ser(r[0]), value: r[3] }] })),
    { month: '2026-09' }
  );
  const au = Alcohol.auditAlcohol(summary, parsed.records, { aliases: Alcohol.parseAliasRows(sheet('名前対応')) });
  eq(Object.keys(au.unmatchedNames).length, 0, '名前対応適用後、シフト表に無い氏名なし');

  const act = {};
  au.days.forEach((d) => (act[Summary.nameKey(d.name) + '|' + d.date] = [d.result, (d.before || {}).time || '', (d.after || {}).time || '', d.count, d.note].join(' ; ')));
  const diffs = [];
  daily.forEach((r) => {
    const k = Summary.nameKey(r[2]) + '|' + ser(r[0]);
    const e = [r[11], r[4], r[7], r[10], r[12]].join(' ; ');
    if (act[k] !== e) diffs.push(r[1] + ' | ' + r[2] + ' | ' + ser(r[0]) + ' | got ' + act[k] + ' | expected ' + e);
    delete act[k];
  });
  Object.keys(act).forEach((k) => diffs.push(k + ' | 完成版に無い行 ' + act[k]));
  assert(diffs.length === 0, 'アルコール照合が完成版と不一致\n  ' + diffs.join('\n  '));
  const c = au.counts;
  console.log('OK: アルコール実CSV ' + parsed.records.length + '件 → 完成版「日付別」' + daily.length + '人日と完全一致（OK ' + c.OK + ' / 軽微 ' + c['軽微'] + ' / 重大 ' + c['重大'] + ' / 未測定 ' + c['未測定'] + ' / シフト外 ' + c['シフト外'] + '）');
}

testSynthetic();
testRealData();
console.log('alcohol-audit-core tests passed');
