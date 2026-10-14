// DNR 日時表示のテスト。
// 調査結果: Amazon DNR 元データの delivery_date_jst / reporting_date は「YYYY-MM-DD 00:00:00」の日付のみで、
// 時刻情報を持たない。00:00 を時刻として表示せず「時刻不明」とし、時刻がある値はJSTで「YYYY/MM/DD HH」と表示する。
// 元の値（内部データ）・DNR分類・理由変換・所属振り分けは変更しない。
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../dnr-core.js');
const XLSX = require('xlsx');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function assert(c, m) { if (!c) throw new Error('FAIL: ' + m); }

// ---- 1. 表示変換 ----
function testFormat() {
  const f = D.dnrFormatOccurrence;
  assert(f('2026-10-04 00:00:00') === '2026/10/04 時刻不明', '00:00:00 は時刻不明（00:00を表示しない）');
  assert(f('2026-10-04') === '2026/10/04 時刻不明', '日付のみは時刻不明');
  assert(f('2026/10/04 0:00') === '2026/10/04 時刻不明', '0:00 も時刻不明');
  assert(f('2026-10-04 14:35:10') === '2026/10/04 14', '時刻あり → YYYY/MM/DD HH');
  assert(f('2026/10/04 9:05') === '2026/10/04 09', '1桁の時を0埋め');
  assert(f('2026-10-04T05:00:00+09:00') === '2026/10/04 05', 'JSTオフセット付き');
  assert(f('2026-10-04T06:00:00Z') === '2026/10/04 15', 'UTC(Z)はJSTへ換算(+9h)');
  assert(f('2026-10-04T20:00:00Z') === '2026/10/05 05', 'UTCからJSTで日付が繰り上がる');
  assert(f('2026-10-04T15:30:00Z') === '2026/10/05 00', 'JSTで翌日00:30は時刻あり（00:00ちょうどではない）');
  assert(f(46299) === '2026/10/04 時刻不明' && f(46299.5) === '2026/10/04 12', 'Excelシリアル値（小数部=時刻）');
  assert(f(new Date(Date.UTC(2026, 9, 4, 6, 0, 0))) === '2026/10/04 15', 'DateオブジェクトはJSTへ換算');
  assert(f('') === '' && f(null) === '' && f(undefined) === '', '空値は空');
  assert(f('abc') === 'abc' && f(' 不明 ') === '不明', '解釈できない値は原文のまま');
  // 冪等（出力を再取込しても同じ表示）
  ['2026-10-04 00:00:00', '2026-10-04 14:35:10'].forEach(v => { const o = f(v); assert(f(o) === o, '冪等: ' + v); });
  assert(D.DNR_TIME_UNKNOWN_LABEL === '時刻不明', 'ラベル定数');
  assert(D.dnrSerialToDateTimeString(46299.6) === '2026-10-04 14:24:00' && D.dnrSerialToDateTimeString('x') === null, 'シリアル→日時文字列');
}

// ---- 2. 抽出・出力（API/Excel共通の dnrBuildExportRows） ----
const HEADER = ['week', 'delivery_station_code', 'bucket', 'sub_bucket', 'provider_company_name', 'transporter_id', 'tracking_id', 'shipment_reason',
  'delivery_date_jst', 'reporting_date', 'state', 'scan_gps_latitude', 'scan_gps_longitude', 'conceded_units', 'dnr_cost_jpy'];
function row(date, report, reason) {
  return [41, 'OFK3', 'Driver - Controllable', 'Missing/Wrong Delivery Box Number', 'GDS', 'A32XYARSSYACE7', 'DA0001', reason || 'DELIVERED_TO_DELIVERY_BOX', date, report, '福岡県', 33.58, 130.36, 3, 3393];
}

function testExport() {
  const json = [HEADER, row('2026-10-04 00:00:00', '2026-10-06 00:00:00'), row('2026-10-05 14:35:10', '2026-10-06 00:00:00', 'CUSTOMER_UNAVAILABLE')];
  const colMap = D.dnrMapHeaderColumns(json[0]);
  const recs = D.dnrExtractRows(json, 0, colMap);
  assert(recs[0].delivery_date_jst === '2026-10-04 00:00:00' && recs[1].delivery_date_jst === '2026-10-05 14:35:10', '内部データは元の値を保持');
  const out = D.dnrBuildExportRows(recs, { DELIVERED_TO_DELIVERY_BOX: '宅配ボックス投函', CUSTOMER_UNAVAILABLE: '不在' });
  const di = out[0].indexOf('配達日');
  assert(di === 1, '配達日列の位置は従来どおり');
  assert(out[1][di] === '2026/10/04 時刻不明' && out[2][di] === '2026/10/05 14', '配達日: 日付のみは時刻不明・時刻ありはHH');
  assert(!JSON.stringify(out).includes('00:00'), '出力に 00:00 を含まない');
  // 他の列（DNR理由の変換・分類・金額など）は従来どおり
  assert(out[1].slice(2).join('|') === ['OFK3', 'GDS', 'A32XYARSSYACE7', 'DA0001', '宅配ボックス投函', 'Driver - Controllable', 'Missing/Wrong Delivery Box Number', '福岡県', '', '', '33.58', '130.36', '3', '3393'].join('|'), '他列は従来どおり: ' + out[1].slice(2));
  assert(out[0].join() === 'ドライバー,配達日,DS,DSP名,TransportID,TrackingID,DNR理由,分類,詳細分類,都道府県,郵便番号,住所,緯度,経度,個数,金額(円)', '列構成は従来どおり（列の追加なし）');
  // reporting_date は保持・表示対象外（従来どおり）。配達日と混同しない
  assert(out[0].indexOf('reporting_date') < 0, 'DNR報告日を配達日列に混ぜない');
}

// ---- 3. index.html: 画面・Excel（buildDnrAoa）・取込の時刻復元 ----
function extractFn(name) {
  const st = html.indexOf('    function ' + name + '(');
  if (st < 0) throw new Error('function not found: ' + name);
  let i = html.indexOf('{', st), depth = 0;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
  return html.slice(st, i + 1);
}
function extractVar(name) {
  const st = html.indexOf('    var ' + name + ' = ');
  const end = html.indexOf('];', st);
  const end2 = html.indexOf('};', st);
  const e = name === 'DNR_COL_LABELS' || name === 'REASON_JA' ? end2 : end;
  return html.slice(st, e + 2);
}

function testUi() {
  const sb = { DnrCore: D, console, escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') };
  vm.createContext(sb);
  vm.runInContext([extractVar('DNR_KEEP_COLS'), extractVar('DNR_COL_LABELS'), extractVar('REASON_JA'),
    extractFn('dnrDisplayDateTime'), extractFn('translateReason'), extractFn('buildDnrAoa')].join('\n'), sb);
  const recs = [
    { driverName: 'A', delivery_date_jst: '2026-10-04 00:00:00', shipment_reason: 'CUSTOMER_UNAVAILABLE', sub_bucket: 'No_Item', bucket: 'Driver', transporter_id: 'T1' },
    { driverName: 'B', delivery_date_jst: '2026-10-05 14:35:10', shipment_reason: 'NOT_ATTEMPT', sub_bucket: '', bucket: '', transporter_id: 'T2' }
  ];
  const aoa = sb.buildDnrAoa(recs);
  const di = aoa[0].indexOf('配達日');
  assert(aoa[1][di] === '2026/10/04 時刻不明' && aoa[2][di] === '2026/10/05 14', 'アプリのExcel出力(buildDnrAoa)の配達日: ' + aoa[1][di] + ' / ' + aoa[2][di]);
  assert(aoa[1][aoa[0].indexOf('DNR理由')] === '不在' && aoa[2][aoa[0].indexOf('DNR理由')] === '配達未試行', 'DNR理由の翻訳は従来どおり');
  assert(recs[0].delivery_date_jst === '2026-10-04 00:00:00', '内部レコードは変更されない');
  assert(sb.dnrDisplayDateTime('2026-10-04 00:00:00') === '2026/10/04 時刻不明', '画面表示ヘルパー');
  // 表示箇所（明細・地図ポップアップ・LINE通知）がすべて整形を経由し、生値を直接表示していない
  const render = extractFn('renderDnrResults') + extractFn('renderDnrMap') + extractFn('dnrShowSingleMap') + extractFn('dnrSendSingleLine');
  assert(!/\+ [a-z]\.delivery_date_jst \+/.test(render.replace(/dnrDisplayDateTime\([a-z]\.delivery_date_jst\)/g, '')), '画面・ポップアップ・LINEは生の delivery_date_jst を直接表示しない');
  assert((render.match(/dnrDisplayDateTime\(/g) || []).length >= 4, '4か所で整形を使用');
  // 取込: Excelの日時（数値）セルは時刻付きで復元（raw:false 整形で時刻が落ちるのを防ぐ）
  const imp = extractFn('handleDnrFile');
  assert(imp.indexOf('dnrSerialToDateTimeString') >= 0 && imp.indexOf("dcell.t === 'n'") >= 0, '数値の日時セルは時刻付きで復元');
  assert(html.indexOf('<script src="/dnr-core.js') >= 0, 'dnr-core.js を読み込む');
}

// ---- 4. 実ファイル相当: 日付のみ(00:00:00)のAmazon形式xlsx → 取込 → 出力で 00:00 が出ない ----
function testXlsxRoundTrip() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, row('2026-10-04 00:00:00', '2026-10-06 00:00:00'), row('2026-10-08 00:00:00', '2026-10-10 00:00:00')]), 'DNR');
  const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const json = XLSX.utils.sheet_to_json(back.Sheets.DNR, { header: 1, raw: false });
  const recs = D.dnrExtractRows(json, 0, D.dnrMapHeaderColumns(json[0]));
  const out = D.dnrBuildExportRows(recs, {});
  assert(out.slice(1).every(r => /^\d{4}\/\d\d\/\d\d 時刻不明$/.test(r[1])), '日付のみデータは全件「時刻不明」: ' + out.slice(1).map(r => r[1]));
  // 日時セル（数値）が入っていても時刻を保持できる
  const ws = XLSX.utils.aoa_to_sheet([HEADER, row(46299.6, '', 'X')]);
  ws[XLSX.utils.encode_cell({ r: 1, c: 8 })].z = 'yyyy-mm-dd';  // 表示形式は日付のみ（整形すると時刻が落ちる）
  const w2 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w2, ws, 'DNR');
  const b2 = XLSX.read(XLSX.write(w2, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const s2 = b2.Sheets.DNR;
  const formatted = XLSX.utils.sheet_to_json(s2, { header: 1, raw: false })[1][8];
  assert(!/:/.test(formatted), '前提: raw:false の整形値は時刻を含まない（' + formatted + '）');
  const cell = s2[XLSX.utils.encode_cell({ r: 1, c: 8 })];
  assert(D.dnrFormatOccurrence(D.dnrSerialToDateTimeString(cell.v)) === '2026/10/04 14', '生のセル値から復元すれば時刻を保持');
}

const tests = [testFormat, testExport, testUi, testXlsxRoundTrip];
for (const t of tests) { t(); console.log('PASS ' + t.name); }
console.log('dnr-datetime tests passed (' + tests.length + ')');
