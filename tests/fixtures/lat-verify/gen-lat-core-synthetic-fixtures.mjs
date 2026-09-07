/**
 * LAT CORE検証用の完全synthetic fixture生成（実運用データは一切含まない）。
 *
 * 実在の氏名・TransportID・route_id/route_code・実運用の日時/配送情報は一切使用しない。
 * 列構成（ヘッダー名）のみ実データ調査で確認した3形式（LOW/RAW Turnover/RAW Routes）を
 * 再現し、値はすべて架空のもの（SYN-プレフィックス、2026/1/1固定の架空日付）を使う。
 *
 * 生成物:
 *   synthetic/synthetic-low.xlsx          … LOW形式（loading_area_turnover+employee_id、
 *                                            planned_departure列なし＝14列出力の再現用）
 *   synthetic/synthetic-raw-turnover.xlsx … RAW Turnover形式（employee_idなし）
 *   synthetic/synthetic-raw-routes.xlsx   … RAW Routes形式（employee_id+planned_departureあり）
 *
 * RAW Turnover側のSYN-R003行は、実データ調査で確認した「Excelの数値書式が壊れており
 * raw:false(表示テキスト)で読むと時刻が無意味な文字列に化ける」現象を、実データを使わずに
 * 意図的なセル書式(z)の上書きによって再現する（値そのものは架空）。
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const outDir = path.resolve(import.meta.dirname, 'synthetic');
fs.mkdirSync(outDir, { recursive: true });

function d(h, m, s) { return new Date(2026, 0, 1, h, m, s || 0); }

// ===== RAW Turnover形式（loading_area_turnover あり・employee_id なし）=====
const turnoverHeader = ['date', 'delivery_station_code', 'provider_type', 'provider_company_code', 'wave', 'route_id', 'route_code', 'loading_area_turnover', 'beacon_departure', 'beacon_arrival', 'beacon_entrance', 'beacon_exit', 'beacon_firstpackagescan', 'beacon_lastpackagescan', 'country'];
const turnoverRows = [
  turnoverHeader,
  // SYN-R001: 早着出発ケース（実出発08:20 vs 予定09:00 → -40分）
  ['2026/1/1', 'SYNDS', 'DSP', 'SYNCO', 'CYCLE_1', 'SYN-R001', 'SYNX01', 15.0, d(8, 20), d(8, 0), d(8, 5), d(8, 20), '', '', 'JP'],
  // SYN-R002: 定刻ケース（実出発10:12 vs 予定10:10 → +2分）
  ['2026/1/1', 'SYNDS', 'DSP', 'SYNCO', 'CYCLE_2', 'SYN-R002', 'SYNX02', 8.0, d(10, 12), d(10, 0), d(10, 3), d(10, 12), '', '', 'JP'],
  // SYN-R003: 遅延ケース（実出発14:30 vs 予定14:10 → +20分）。beacon_departureのセル書式を
  // 後段で意図的に破損させ、formatted textに依存しないことの回帰対象にする。
  ['2026/1/1', 'SYNDS', 'DSP', 'SYNCO', 'CYCLE_3', 'SYN-R003', 'SYNX03', 12.0, d(14, 30), d(14, 0), d(14, 5), d(14, 30), '', '', 'JP'],
  // SYN-R004: Turnoverのみに存在するroute（Routes側に対応なし）→ unmatched route
  ['2026/1/1', 'SYNDS', 'DSP', 'SYNCO', 'CYCLE_1', 'SYN-R004', 'SYNX04', 25.0, d(9, 40), d(9, 20), d(9, 25), d(9, 40), '', '', 'JP'],
  // SYN-R004 重複行（duplicate route_id）: 後勝ちにならないことの回帰用（turnover値が異なる）
  ['2026/1/1', 'SYNDS', 'DSP', 'SYNCO', 'CYCLE_1', 'SYN-R004', 'SYNX04', 99.9, d(23, 0), d(22, 0), d(22, 5), d(23, 0), '', '', 'JP']
];

// ===== RAW Routes形式（employee_id・planned_departure/arrival あり・loading_area_turnover なし）=====
const routesHeader = ['date', 'delivery_station_code', 'delivery_station_country_code', 'service_type', 'wave', 'provider_type', 'provider_company_code', 'route_id', 'planned_arrival', 'planned_departure', 'route_actual_departure', 'route_start_time_source', 'on_time_departure', 'diff_plan_vs_actual_mins', 'beacon_entrance', 'employee_id', 'wave_duration', 'planned_service_type', 'country'];
const routesRows = [
  routesHeader,
  ['2026/1/1', 'SYNDS', 'JP', 'Standard Parcel', 'CYCLE_1', 'DSP', 'SYNCO', 'SYN-R001', d(7, 45), d(9, 0), d(8, 20), 'Beacon', 1, -40, d(8, 5), 'SYN-EMP-A1', 20, 'Standard Parcel', 'JP'],
  // SYN-R001 重複行（duplicate route_id）: employee_id/planned_departureとも後勝ちにならないことの回帰用
  ['2026/1/1', 'SYNDS', 'JP', 'Standard Parcel', 'CYCLE_1', 'DSP', 'SYNCO', 'SYN-R001', d(23, 0), d(23, 59), d(23, 59), 'Beacon', 0, 999, d(23, 0), 'SYN-EMP-ZZ', 20, 'Standard Parcel', 'JP'],
  ['2026/1/1', 'SYNDS', 'JP', 'Standard Parcel', 'CYCLE_2', 'DSP', 'SYNCO', 'SYN-R002', d(9, 45), d(10, 10), d(10, 12), 'Beacon', 1, 2, d(10, 3), 'SYN-EMP-A2', 20, 'Standard Parcel', 'JP'],
  ['2026/1/1', 'SYNDS', 'JP', 'Standard Parcel', 'CYCLE_3', 'DSP', 'SYNCO', 'SYN-R003', d(13, 45), d(14, 10), d(14, 30), 'Beacon', 0, 20, d(14, 5), 'SYN-EMP-A3', 20, 'Standard Parcel', 'JP'],
  // SYN-R005: Routesのみに存在するroute（Turnover側に対応なし）→ routesOnlyCount、beaconMapへは現れない
  ['2026/1/1', 'SYNDS', 'JP', 'Standard Parcel', 'CYCLE_1', 'DSP', 'SYNCO', 'SYN-R005', d(10, 45), d(11, 0), d(11, 5), 'Beacon', 1, 5, d(10, 55), 'SYN-EMP-A5', 20, 'Standard Parcel', 'JP']
];

// ===== LOW形式（loading_area_turnover + employee_id を単一ファイルで保持。
//       W32実データ調査で確認した列構成を再現: planned_departure列を持たない
//       （出発予定情報なし→14列出力へフォールバックする既存仕様の再現用）=====
const lowHeader = ['date', 'delivery_station_code', 'service_type', 'provider_type', 'provider_company_code', 'wave', 'route_id', 'route_code', 'loading_area_turnover', 'beacon_departure', 'beacon_arrival', 'beacon_entrance', 'beacon_exit', 'beacon_firstpackagescan', 'beacon_lastpackagescan', 'employee_id', 'country'];
const lowRows = [
  lowHeader,
  ['2026/1/1', 'SYNDS', 'Standard Parcel', 'DSP', 'SYNCO', 'CYCLE_1', 'SYN-L001', 'SYNY01', 18.0, d(8, 25), d(8, 0), d(8, 5), d(8, 25), d(8, 8), d(8, 20), 'SYN-EMP-L1', 'JP'],
  ['2026/1/1', 'SYNDS', 'Standard Parcel', 'DSP', 'SYNCO', 'CYCLE_2', 'SYN-L002', 'SYNY02', 30.0, d(9, 35), d(9, 0), d(9, 5), '', '', '', 'SYN-EMP-L2', 'JP'],
  ['2026/1/1', 'SYNDS', 'Standard Parcel', 'DSP', 'SYNCO', 'CYCLE_3', 'SYN-L003', 'SYNY03', 10.0, d(15, 10), d(15, 0), d(15, 2), d(15, 10), '', '', 'SYN-EMP-L3', 'JP']
];

function writeXlsx(rows, sheetName, filename) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const outPath = path.join(outDir, filename);
  XLSX.writeFile(wb, outPath);
  return outPath;
}

const turnoverPath = writeXlsx(turnoverRows, 'Turnover', 'synthetic-raw-turnover.xlsx');
const routesPath = writeXlsx(routesRows, 'Routes', 'synthetic-raw-routes.xlsx');
const lowPath = writeXlsx(lowRows, 'LOW', 'synthetic-low.xlsx');

// SYN-R003のbeacon_departureセルの書式(z)を意図的に破損させる（値=v は変更しない）。
// 実データ調査で確認した「Excelの書式設定が壊れておりraw:false(表示テキスト)で読むと
// 時刻が無意味な文字列に化ける」現象を、架空の値だけで純粋に再現するための処理。
(function corruptTurnoverFormatting() {
  const wb = XLSX.readFile(turnoverPath, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // ヘッダー行(0)の列順に基づき、SYN-R003行(4行目, 0-indexedで4)のbeacon_departure列(8列目)
  const headerRow = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })[0];
  const colIdx = headerRow.indexOf('beacon_departure');
  // シート内0-indexed行番号: r=0がヘッダー、r=1=SYN-R001、r=2=SYN-R002、r=3=SYN-R003
  const addr = XLSX.utils.encode_cell({ r: 3, c: colIdx });
  if (ws[addr]) {
    ws[addr].z = '0.0'; // 時刻用ではない書式に差し替え、raw:false(表示テキスト)を破損させる
    delete ws[addr].w; // 書式再計算を強制（キャッシュされた表示テキストを消す）
  }
  XLSX.writeFile(wb, turnoverPath);
})();

console.log('Generated:', turnoverPath);
console.log('Generated:', routesPath);
console.log('Generated:', lowPath);
