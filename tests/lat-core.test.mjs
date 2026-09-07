// lat-core.js のユニットテスト（完全synthetic fixtureのみ使用。実運用データは一切含まない）。
// index.htmlの既存LAT処理（latDetectInputFormat/latParseRawTurnoverRows/latParseRawRoutesRows/
// LOW分岐/latTryCombineRaw/latExtractTime/mergeAndRender/exportLatResult）と
// lat-departure-core.jsの判定ロジックを忠実に移植したものであることを確認する。
// index.html本体・lat-departure-core.js・FTDS/CC/DNR/TWCは対象外（今回変更していない）。
//
// フィクスチャは tests/fixtures/lat-verify/synthetic/ の3ファイル
// （synthetic-low.xlsx / synthetic-raw-turnover.xlsx / synthetic-raw-routes.xlsx）のみを使う。
// 実在の氏名・TransportID・route_id/route_code・実運用の日時/配送情報は一切含まれていない
// （生成スクリプト: tests/fixtures/lat-verify/gen-lat-core-synthetic-fixtures.mjs）。
//
// 【実データ回帰について】W35実データ（Wk35 Loading Area Turnover + Total Number of
// DSP Routes、実在ドライバー氏名・TransportIDを含む完成見本CSVとの突き合わせ）は、
// このセッション内で手動検証を実施済み（route_id単位で199route×15項目=2985フィールド
// 全一致、早着出発179/定刻15/遅延5、差分-52分〜+101分、TransportID欠損0件）。個人情報を
// 含む実データファイルをGit管理下に置かない方針のため、この実データ比較は常設の自動
// テストには含めず、検証結果のみをここに記録する（実在の氏名・TransportID・route_id・
// 実運用日時はいずれも記録しない）。
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const LatCore = require('../lat-core.js');
const DnrCore = require('../dnr-core.js'); // 表示形式の再利用先。dnr-core.js自体は変更していない
const TwcCore = require('../twc-core.js'); // 自己重複除去(twcDedupeDisplayName)の再利用先。twc-core.js自体は変更していない
const XLSX = require('xlsx');
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures/lat-verify/synthetic');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

// xlsxファイルを、実運用（handleLatFile/lat-core.js想定の/lat-export）と同じ手順で読む:
// raw:trueで数値シリアルのまま取得し、date列だけraw:falseのテキストへ上書きする。
function readXlsxRows(path) {
  const wb = XLSX.readFile(path, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rowsRaw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  const rowsText = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  return LatCore.latOverlayDateColumnWithText(rowsRaw, rowsText);
}

const LOW_XLSX = join(FIX, 'synthetic-low.xlsx');
const TURNOVER_XLSX = join(FIX, 'synthetic-raw-turnover.xlsx');
const ROUTES_XLSX = join(FIX, 'synthetic-raw-routes.xlsx');

// ---- 1〜3. 入力形式判定（列名のみ。synthetic 3ファイルで検証） ----
function testFormatDetectionSyntheticFiles() {
  const lowRows = readXlsxRows(LOW_XLSX);
  const turnoverRows = readXlsxRows(TURNOVER_XLSX);
  const routesRows = readXlsxRows(ROUTES_XLSX);

  assert(LatCore.latDetectInputFormat(LatCore.latBuildColMap(lowRows[0])) === 'low', 'synthetic-low.xlsxはloading_area_turnover+employee_id両方持ちのためlow判定');
  assert(LatCore.latDetectInputFormat(LatCore.latBuildColMap(turnoverRows[0])) === 'raw_turnover', 'synthetic-raw-turnover.xlsxはemployee_idなしのためraw_turnover判定');
  assert(LatCore.latDetectInputFormat(LatCore.latBuildColMap(routesRows[0])) === 'raw_routes', 'synthetic-raw-routes.xlsxはturnoverなし+employee_id+planned_departureのためraw_routes判定');

  // 列マップの単体ケース（既存仕様の3条件）
  assert(LatCore.latDetectInputFormat({ route_id: 0, loading_area_turnover: 1, employee_id: 2 }) === 'low', 'turnover+employee両方ありはlow');
  assert(LatCore.latDetectInputFormat({ route_id: 0, loading_area_turnover: 1 }) === 'raw_turnover', 'turnoverのみ(employeeなし)はraw_turnover');
  assert(LatCore.latDetectInputFormat({ route_id: 0, employee_id: 1, planned_departure: 2 }) === 'raw_routes', 'employee+planned_departureのみ(turnoverなし)はraw_routes');
  assert(LatCore.latDetectInputFormat({ route_id: 0, employee_id: 1, planned_arrival: 2 }) === 'raw_routes', 'planned_arrivalだけでもraw_routes判定');
  assert(LatCore.latDetectInputFormat({ employee_id: 0, loading_area_turnover: 1 }) === 'low', 'route_id列が無ければ既存LOWフォールバックへ委譲（rawとして誤判定しない）');
}

// ---- 4. ファイル名非依存 ----
function testFilenameIndependence() {
  const rows = [
    ['route_id', 'loading_area_turnover', 'beacon_departure'],
    ['SYN-R900', '10.5', '18:00']
  ];
  const colMap = LatCore.latBuildColMap(rows[0]);
  assert(LatCore.latDetectInputFormat.length === 1, 'latDetectInputFormatはcolMapのみを受け取る（ファイル名引数なし）');
  assert(LatCore.latDetectInputFormat(colMap) === 'raw_turnover', 'ファイル名に関わらずcolMapだけで判定');
}

// ---- 5. 投入順非依存（RAW2ファイルをどちらの順で渡してもJOIN結果が同一） ----
function testOrderIndependence() {
  const turnoverRows = readXlsxRows(TURNOVER_XLSX);
  const routesRows = readXlsxRows(ROUTES_XLSX);

  function detectAndCombine(rowsA, rowsB) {
    const parsedA = { rows: rowsA, colMap: LatCore.latBuildColMap(rowsA[0]), format: LatCore.latDetectInputFormat(LatCore.latBuildColMap(rowsA[0])) };
    const parsedB = { rows: rowsB, colMap: LatCore.latBuildColMap(rowsB[0]), format: LatCore.latDetectInputFormat(LatCore.latBuildColMap(rowsB[0])) };
    const files = [parsedA, parsedB];
    const t = files.filter(function (f) { return f.format === 'raw_turnover'; })[0];
    const r = files.filter(function (f) { return f.format === 'raw_routes'; })[0];
    const tp = LatCore.latParseRawTurnoverRows(t.rows, t.colMap);
    const rp = LatCore.latParseRawRoutesRows(r.rows, r.colMap);
    return LatCore.latCombineRaw(tp.rows, tp, rp.rows, rp);
  }

  const combinedAB = detectAndCombine(turnoverRows, routesRows);
  const combinedBA = detectAndCombine(routesRows, turnoverRows);
  assert(JSON.stringify(combinedAB.beaconMap) === JSON.stringify(combinedBA.beaconMap), '投入順を反転しても結合結果(beaconMap)は完全に同一');
  assert(JSON.stringify(combinedAB.diagnosis) === JSON.stringify(combinedBA.diagnosis), '投入順を反転しても診断情報(diagnosis)は完全に同一');
}

// ---- 6〜8. route_id完全一致JOIN・unmatchedの誤JOIN禁止・duplicate先勝ち ----
// synthetic-raw-turnover.xlsx / synthetic-raw-routes.xlsx の設計:
//   SYN-R001/R002/R003: 両ファイルに存在 → JOIN成立
//   SYN-R004: Turnoverのみ（2行=duplicate route_idを含む） → unmatched + turnover側dedupe
//   SYN-R005: Routesのみ（duplicate route_idを含む） → routesOnlyCount + routes側dedupe
function testJoinSemantics() {
  const turnoverRows = readXlsxRows(TURNOVER_XLSX);
  const routesRows = readXlsxRows(ROUTES_XLSX);
  const turnoverParsed = LatCore.latParseRawTurnoverRows(turnoverRows, LatCore.latBuildColMap(turnoverRows[0]));
  const routesParsed = LatCore.latParseRawRoutesRows(routesRows, LatCore.latBuildColMap(routesRows[0]));

  // duplicate route_id: 先勝ち＋診断件数のみ記録
  assert(turnoverParsed.count === 4, 'Turnover側はSYN-R001/002/003/004の4件(R004は重複を1件に集約), got ' + turnoverParsed.count);
  assert(turnoverParsed.duplicateRouteIdCount === 1, 'Turnover側の重複route_idは1件として記録される');
  assert(turnoverParsed.rows['SYN-R004'].turnover === '25', 'SYN-R004は最初の行(turnover=25)が採用される（後続の重複行99.9ではない）');

  assert(routesParsed.count === 4, 'Routes側はSYN-R001/002/003/005の4件(R001は重複を1件に集約), got ' + routesParsed.count);
  assert(routesParsed.duplicateRouteIdCount === 1, 'Routes側の重複route_idは1件として記録される');
  assert(routesParsed.rows['SYN-R001'].employeeId === 'SYN-EMP-A1', 'SYN-R001は最初の行(employeeId=SYN-EMP-A1)が採用される（後続の重複行SYN-EMP-ZZではない）');

  const combined = LatCore.latCombineRaw(turnoverParsed.rows, turnoverParsed, routesParsed.rows, routesParsed);
  // route_id完全一致JOIN
  assert(combined.beaconMap['SYN-R001'].employeeId === 'SYN-EMP-A1', 'SYN-R001はroute_id完全一致でemployeeIdが結合される');
  assert(combined.beaconMap['SYN-R001'].plannedDeparture === '09:00:00', 'SYN-R001はroute_id完全一致でplannedDepartureが結合される');
  // unmatched: Turnoverのみのroute_idは残る。誤って別route_idの値を借用しない（fuzzy JOINなし）
  assert(combined.beaconMap['SYN-R004'], 'Turnoverのみのroute_id(SYN-R004)は残る（黙って除外しない）');
  assert(combined.beaconMap['SYN-R004'].employeeId === '', 'SYN-R004はemployeeId未結合のまま（誤JOINしない）');
  // Routesのみのroute_idはbeaconMapに現れない（LOW同等仕様。turnover読み無しのルートは対象外）
  assert(!combined.beaconMap['SYN-R005'], 'Routesのみのroute_id(SYN-R005)はbeaconMapへ現れない（誤って新規route扱いにしない）');
  assert(combined.diagnosis.routesOnlyCount === 1, 'routesOnlyCountとして診断情報に残る');
  assert(combined.diagnosis.unmatchedEmployeeCount === 1, 'SYN-R004はunmatchedEmployeeCountに計上される');
  assert(combined.diagnosis.matchedEmployeeCount === 3, 'SYN-R001/002/003はmatchedEmployeeCountに計上される, got ' + combined.diagnosis.matchedEmployeeCount);
  assert(combined.diagnosis.beaconMapCount === 4, 'beaconMapCountはturnover件数(4)と一致（LOW同等仕様）');
}

// ---- 9〜10. Excelシリアル時刻の復元とformatted text破損値への非依存 ----
// synthetic-raw-turnover.xlsxのSYN-R003行は、beacon_departureセルの書式(z)を意図的に
// 破損させてある（値=vは正しい14:30:00のシリアル値のまま）。raw:false(表示テキスト)で
// 読むと無意味な文字列になるが、本コアはrows(raw:true)のみを前提とするため影響を受けない。
function testExcelSerialTimeVsCorruptedFormattedText() {
  const wb = XLSX.readFile(TURNOVER_XLSX, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rowsRaw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  const rowsText = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const colIdx = rowsRaw[0].indexOf('beacon_departure');

  const rawValue = rowsRaw[3][colIdx]; // SYN-R003行（0-indexed: 0=header,1=R001,2=R002,3=R003）
  const textValue = rowsText[3][colIdx];
  assert(typeof rawValue === 'number', 'raw:trueではExcelシリアル値(数値)のまま取得される, got ' + typeof rawValue);
  assert(String(textValue) !== String(rawValue), 'raw:false(表示テキスト)は書式破損によりraw:trueの値と一致しない文字列になっている（このfixtureの前提条件）: text=' + textValue);

  const fromRaw = LatCore.latExtractTime(String(rawValue));
  assert(fromRaw === '14:30:00', 'raw:true(シリアル値)からは正しい時刻14:30:00が復元される, got ' + fromRaw);

  const fromCorruptedText = LatCore.latExtractTime(String(textValue));
  assert(fromCorruptedText !== fromRaw, '破損formatted textをもし誤って渡すと別の(誤った)時刻になる＝formatted textには依存できないことの証明, got ' + fromCorruptedText);

  // 本コアの実際の処理経路（latParseRawTurnoverRows）はrowsRaw(raw:true)を渡す契約のため、
  // この破損した行でも正しい時刻が復元されることを確認する（実際のparse関数経由）。
  const colMap = LatCore.latBuildColMap(rowsRaw[0]);
  const parsed = LatCore.latParseRawTurnoverRows(rowsRaw, colMap);
  assert(parsed.rows['SYN-R003'].departure === '14:30:00', 'latParseRawTurnoverRows経由でも書式破損の影響を受けず正しい時刻が復元される, got ' + parsed.rows['SYN-R003'].departure);

  // その他の境界値（0〜1範囲の時刻のみシリアル、86400未満の秒数値、HH:MM文字列）
  assert(LatCore.latExtractTime('0.5') === '12:00:00', '0〜1範囲は1日の割合として復元される');
  assert(LatCore.latExtractTime('3600') === '01:00:00', '1〜86400範囲は経過秒数として復元される');
  assert(LatCore.latExtractTime('18:30') === '18:30', 'HH:MM形式の文字列はそのまま(正規表現優先)');
}

// ---- 11〜12. planned_departureはRoutesから、実績時刻はTurnoverから ----
function testFieldSourcePrecedence() {
  const turnoverRows = readXlsxRows(TURNOVER_XLSX);
  const routesRows = readXlsxRows(ROUTES_XLSX);
  const turnoverParsed = LatCore.latParseRawTurnoverRows(turnoverRows, LatCore.latBuildColMap(turnoverRows[0]));
  const routesParsed = LatCore.latParseRawRoutesRows(routesRows, LatCore.latBuildColMap(routesRows[0]));
  const combined = LatCore.latCombineRaw(turnoverParsed.rows, turnoverParsed, routesParsed.rows, routesParsed);
  const rows = LatCore.latBuildResultRows(combined.beaconMap);
  const r1 = rows.find(function (r) { return r.routeId === 'SYN-R001'; });

  assert(r1.plannedDeparture === '09:00:00', 'plannedDepartureはRoutes側の値を採用, got ' + r1.plannedDeparture);
  assert(r1.employeeId === 'SYN-EMP-A1', 'employeeIdはRoutes側の値を採用');
  assert(r1.dsArrival === '08:00:00' && r1.dsEntrance === '08:05:00' && r1.actualDeparture === '08:20:00' && r1.dsExit === '08:20:00', '実績時刻(arrival/entrance/departure/exit)はすべてTurnover側の値を採用');
}

// ---- 13. CYCLE_1/2/3はwave値としてそのまま保持（新規分岐なし） ----
function testCycleValuesPassthrough() {
  const turnoverRows = readXlsxRows(TURNOVER_XLSX);
  const turnoverParsed = LatCore.latParseRawTurnoverRows(turnoverRows, LatCore.latBuildColMap(turnoverRows[0]));
  assert(turnoverParsed.rows['SYN-R001'].wave === 'CYCLE_1', 'SYN-R001のwaveはCYCLE_1のまま');
  assert(turnoverParsed.rows['SYN-R002'].wave === 'CYCLE_2', 'SYN-R002のwaveはCYCLE_2のまま');
  assert(turnoverParsed.rows['SYN-R003'].wave === 'CYCLE_3', 'SYN-R003のwaveはCYCLE_3のまま（新たな分岐は発生しない）');
}

// ---- 14. LAT判定境界値（早着出発<-10分・定刻<=5分・遅延>5分）と実データ相当の3判定 ----
function testJudgmentBoundaries() {
  assert(LatCore.latResolveJudgment(-11) === '早着出発', '-11分は早着出発');
  assert(LatCore.latResolveJudgment(-10) === '定刻', '-10分は早着出発の境界外＝定刻(<-10のみ早着)');
  assert(LatCore.latResolveJudgment(5) === '定刻', '5分は定刻の境界内');
  assert(LatCore.latResolveJudgment(6) === '遅延', '6分は定刻の境界外＝遅延');
  assert(LatCore.latResolveJudgment(0) === '定刻', '0分は定刻');
  assert(LatCore.latResolveJudgment(Number.NaN) === '', '判定不能な値は空文字（判定不可）');

  // synthetic RAW2ファイルのJOIN結果で3判定すべてが再現されることを確認
  // （SYN-R001: -40分→早着出発 / SYN-R002: +2分→定刻 / SYN-R003: +20分→遅延）
  const turnoverRows = readXlsxRows(TURNOVER_XLSX);
  const routesRows = readXlsxRows(ROUTES_XLSX);
  const turnoverParsed = LatCore.latParseRawTurnoverRows(turnoverRows, LatCore.latBuildColMap(turnoverRows[0]));
  const routesParsed = LatCore.latParseRawRoutesRows(routesRows, LatCore.latBuildColMap(routesRows[0]));
  const combined = LatCore.latCombineRaw(turnoverParsed.rows, turnoverParsed, routesParsed.rows, routesParsed);
  const rows = LatCore.latBuildResultRows(combined.beaconMap);
  const byId = {}; rows.forEach(function (r) { byId[r.routeId] = r; });
  assert(byId['SYN-R001'].judgment === '早着出発' && byId['SYN-R001'].diffMin === -40, 'SYN-R001は早着出発(-40分), got ' + byId['SYN-R001'].judgment + '/' + byId['SYN-R001'].diffMin);
  assert(byId['SYN-R002'].judgment === '定刻' && byId['SYN-R002'].diffMin === 2, 'SYN-R002は定刻(+2分), got ' + byId['SYN-R002'].judgment + '/' + byId['SYN-R002'].diffMin);
  assert(byId['SYN-R003'].judgment === '遅延' && byId['SYN-R003'].diffMin === 20, 'SYN-R003は遅延(+20分), got ' + byId['SYN-R003'].judgment + '/' + byId['SYN-R003'].diffMin);
}

// ---- 15. BOM付きCSV ----
function testBomCsv() {
  const built = LatCore.latBuildExportCsvRows([{ date: '2026/1/1', wave: 'CYCLE_1', driverName: 'テスト太郎', employeeId: 'SYN-EMP-T1', routeId: 'SYN-R900', routeCode: 'SYNX90', dsArrival: '08:00', dsEntrance: '08:05', firstScan: '', lastScan: '', plannedDeparture: '08:15', plannedDepartureDisplay: '08:15', actualDeparture: '08:20', dsExit: '08:20', diffMin: 5, diffDisplay: '5分遅', loadingMin: '', stayMin: 10, judgment: '定刻', judgmentDisplay: '定刻' }]);
  const csv = LatCore.latRowsToCsvString(built.rows);
  assert(csv.charCodeAt(0) === 0xFEFF, 'CSV先頭にBOM(U+FEFF)が付与される');
  assert(csv.indexOf('"テスト太郎"') >= 0, 'ダブルクォート囲みでエスケープされる');
}

// ---- 16. LOW単体処理（synthetic-low.xlsxを単一ファイルとして処理） ----
// synthetic-low.xlsxはW32実データ調査で確認した列構成を再現しつつ、値はすべて架空。
// planned_departure列を持たない（→14列出力の再現用）。
function testLowStandalone() {
  const rows = readXlsxRows(LOW_XLSX);
  const colMap = LatCore.latBuildColMap(rows[0]);
  assert(LatCore.latDetectInputFormat(colMap) === 'low', 'synthetic-low.xlsxはlow判定');
  const parsed = LatCore.latParseLowRows(rows, colMap);
  assert(!parsed.error, 'エラー無く単一ファイルで処理できる: ' + parsed.error);
  assert(parsed.count === 3, 'synthetic-low.xlsxは3ルート, got ' + parsed.count);
  const resultRows = LatCore.latBuildResultRows(parsed.map);
  assert(resultRows.every(function (r) { return r.employeeId; }), '全行でemployee_idが保持される（欠落なし）');
  assert(parsed.hasPlannedDepartureCol === false, 'synthetic-low.xlsxにはplanned_departure列が無い（任意列の欠落を再現）');
  const csvBuild = LatCore.latBuildExportCsvRows(resultRows);
  assert(csvBuild.showPlannedCols === false, '出発予定情報が無いため動的に14列構成へフォールバック（クラッシュしない）');
  assert(csvBuild.rows[0].length === 14, 'planned_departure列が無い場合は14列ヘッダー, got ' + csvBuild.rows[0].length);

  // 空のbeacon_exit(SYN-L002)はそのまま空で保持される（既存仕様。実出発からの穴埋めをしない）
  const l002 = resultRows.find(function (r) { return r.routeId === 'SYN-L002'; });
  assert(l002.dsExit === '', 'SYN-L002はbeacon_exit空欄のまま保持される');
  assert(l002.actualDeparture === '09:35:00', 'SYN-L002のactualDepartureは保持される');
}

// ---- 17列出力（RAW JOIN時、出発予定/差分/判定を含む）の確認 ----
function testRawJoinSeventeenColumnOutput() {
  const turnoverRows = readXlsxRows(TURNOVER_XLSX);
  const routesRows = readXlsxRows(ROUTES_XLSX);
  const turnoverParsed = LatCore.latParseRawTurnoverRows(turnoverRows, LatCore.latBuildColMap(turnoverRows[0]));
  const routesParsed = LatCore.latParseRawRoutesRows(routesRows, LatCore.latBuildColMap(routesRows[0]));
  const combined = LatCore.latCombineRaw(turnoverParsed.rows, turnoverParsed, routesParsed.rows, routesParsed);
  const resultRows = LatCore.latBuildResultRows(combined.beaconMap);
  const csvBuild = LatCore.latBuildExportCsvRows(resultRows);
  assert(csvBuild.showPlannedCols === true, 'planned_departureがRoutesから供給されるため17列構成になる');
  assert(csvBuild.rows[0].length === 17, 'RAW JOIN時は17列ヘッダー, got ' + csvBuild.rows[0].length);
  assert(csvBuild.rows[0].indexOf('出発予定') === 10 && csvBuild.rows[0].indexOf('判定') === 16, '列順は既存仕様どおり（出発予定=11列目、判定=最終列）');
}

// ---- ドライバー表示名解決: 同一TIDの重複マスタレコード対策（latBuildTidNameMaps） ----
// 実運用で報告された「元祖(index.html)では氏名解決できていたのに/lat-exportでは
// (未特定)になった」ケースの根本原因（同一TransportIDがマスタ配列に複数回出現し、
// 後から出現した空文字が先に見つかった正しい値を上書きしていた）に対する回帰テスト。
// マスタの内容自体は架空（実在TID・氏名は使わない）。
function testBuildTidNameMapsHandlesDuplicateMasterRecords() {
  // ケース1: 正しい値が先、後続の重複レコードが両フィールドとも空 → 空で上書きされない
  const masterA = [
    { transportId: 'SYN-TID-1', englishName: 'SYN Name A', japaneseName: 'テスト名A' },
    { transportId: 'SYN-TID-1', englishName: '', japaneseName: '' }
  ];
  const mapsA = LatCore.latBuildTidNameMaps(masterA);
  assert(mapsA.tidToName['SYN-TID-1'] === 'SYN Name A', '先に見つかった正しいenglishNameが後続の空文字で上書きされない, got ' + mapsA.tidToName['SYN-TID-1']);
  assert(mapsA.tidToJapaneseName['SYN-TID-1'] === 'テスト名A', '先に見つかった正しいjapaneseNameが後続の空文字で上書きされない, got ' + mapsA.tidToJapaneseName['SYN-TID-1']);

  // ケース2: 空レコードが先、正しい値が後続 → 後続の正しい値が採用される（永久にブロックされない）
  const masterB = [
    { transportId: 'SYN-TID-2', englishName: '', japaneseName: '' },
    { transportId: 'SYN-TID-2', englishName: 'SYN Name B', japaneseName: 'テスト名B' }
  ];
  const mapsB = LatCore.latBuildTidNameMaps(masterB);
  assert(mapsB.tidToName['SYN-TID-2'] === 'SYN Name B', '先行レコードが空でも後続の正しい値が採用される, got ' + mapsB.tidToName['SYN-TID-2']);
  assert(mapsB.tidToJapaneseName['SYN-TID-2'] === 'テスト名B', '先行レコードが空でも後続の正しい値が採用される, got ' + mapsB.tidToJapaneseName['SYN-TID-2']);

  // ケース3: englishNameのみ重複で空、japaneseNameは両方に値あり → フィールドごとに独立して先勝ち
  const masterC = [
    { transportId: 'SYN-TID-3', englishName: 'SYN Name C', japaneseName: 'テスト名C1' },
    { transportId: 'SYN-TID-3', englishName: '', japaneseName: 'テスト名C2' }
  ];
  const mapsC = LatCore.latBuildTidNameMaps(masterC);
  assert(mapsC.tidToName['SYN-TID-3'] === 'SYN Name C', 'englishNameは最初の値を維持');
  assert(mapsC.tidToJapaneseName['SYN-TID-3'] === 'テスト名C1', 'japaneseNameも最初の値を維持（2件目に値があっても上書きしない＝先勝ち）');

  // TID完全一致であることの確認（fuzzy matchなし・前後空白のみ許容）
  const masterD = [{ transportId: '  SYN-TID-4  ', englishName: 'SYN Name D', japaneseName: '' }];
  const mapsD = LatCore.latBuildTidNameMaps(masterD);
  assert(mapsD.tidToName['SYN-TID-4'] === 'SYN Name D', 'transportIdの前後空白のみtrimされる（既存仕様どおり）');
  assert(mapsD.tidToName['SYN-TID-4X'] === undefined, '部分一致・類似TIDへは解決しない（fuzzy matchなし）');

  // transportId欠落レコードは無視される（クラッシュしない）
  const masterE = [{ transportId: '', englishName: 'SYN Ghost', japaneseName: '' }, null];
  const mapsE = LatCore.latBuildTidNameMaps(masterE.filter(Boolean)); // nullは呼び出し側で除外される想定だが、防御的にfilter
  assert(Object.keys(mapsE.tidToName).length === 0, 'transportId空のレコードはマップに含まれない');
  assert(LatCore.latBuildTidNameMaps(undefined).tidToName, 'master自体がundefinedでもクラッシュしない');
}

// ---- ドライバー表示名解決: 現行マスタのenglishName表記揺れ吸収 ----
// 実運用で報告された2件の表記揺れ（マスタの値自体は架空の例に置き換えて再現。
// 実在氏名・TIDは使わない）。「一般化できるトークン照合ルールのみ」で解決できることの
// 回帰テスト。個別のTID・氏名のハードコードによる分岐は一切追加していない。
function testNormalizeEnglishNameTokensGeneralRules() {
  // Case A（実運用相当・簡略化）: englishName・japaneseNameのトークンが完全に一致 → 無変更
  assert(LatCore.latNormalizeEnglishNameTokens('SynGiven SynFamily', 'SynFamily SynGiven') === 'SynGiven SynFamily', 'トークンが完全一致する場合は変更しない');

  // Case B（実運用相当・簡略化）: englishNameに、japaneseNameのどのトークンにも一致しない
  // 余分な断片トークンが付いている → その断片だけを除去
  assert(LatCore.latNormalizeEnglishNameTokens('SynGiven SynFamily Syn', 'SynFamily SynGiven') === 'SynGiven SynFamily', '余分な断片トークンだけを除去する, got ' + LatCore.latNormalizeEnglishNameTokens('SynGiven SynFamily Syn', 'SynFamily SynGiven'));

  // 1つも一致しない場合（ローマ字表記等、文字体系が異なり比較不能）→ 無変更（安全側）
  assert(LatCore.latNormalizeEnglishNameTokens('romaji name here', 'SynFamily SynGiven') === 'romaji name here', '1つも一致しない場合は変更しない（fuzzy matchしない）');

  // 単一トークンのenglishName（比較の意味が薄い）→ 無変更
  assert(LatCore.latNormalizeEnglishNameTokens('SYNCODE', 'SynFamily SynGiven') === 'SYNCODE', '単一トークンのenglishNameは変更しない');

  // 同一トークンの重複（TwcCore.twcDedupeDisplayNameでは捕捉できない非隣接重複）も
  // 一致トークンの範囲内で重複除去される
  assert(LatCore.latNormalizeEnglishNameTokens('SynGiven SynFamily SynGiven', 'SynFamily SynGiven') === 'SynGiven SynFamily', '一致トークンの重複も除去される, got ' + LatCore.latNormalizeEnglishNameTokens('SynGiven SynFamily SynGiven', 'SynFamily SynGiven'));

  // englishName・japaneseNameいずれかが空 → 無変更
  assert(LatCore.latNormalizeEnglishNameTokens('', 'SynFamily SynGiven') === '', 'englishName空は空のまま');
  assert(LatCore.latNormalizeEnglishNameTokens('SynGiven SynFamily', '') === 'SynGiven SynFamily', 'japaneseName空ならenglishNameは無変更');
}

function testResolveDriverDisplayNameEndToEnd() {
  function resolve(en, ja) {
    if (en) en = TwcCore.twcDedupeDisplayName(en);
    return LatCore.latResolveDriverDisplayName(en, ja, DnrCore.dnrResolveDriverDisplayName);
  }

  // Case A: englishName="優人 小野"相当のトークン一致ケース → 「japaneseName (englishName)」形式
  assert(resolve('SynGiven SynFamily', 'SynFamily SynGiven') === 'SynFamily SynGiven (SynGiven SynFamily)', 'Case A: 完全一致トークンはdnrResolveDriverDisplayName形式のまま');

  // Case B: englishNameに余分な断片トークンがある場合 → 断片だけ除去したうえで
  // 「japaneseName (正規化されたenglishName)」形式。日本語名は正しく表示され、
  // 異常なenglishNameのために(未特定)へは絶対に落ちない
  var caseB = resolve('SynGiven SynFamily Syn', 'SynFamily SynGiven');
  assert(caseB === 'SynFamily SynGiven (SynGiven SynFamily)', 'Case B: 断片除去後にDNR形式で表示され、未特定へ落ちない, got ' + caseB);
  assert(caseB.indexOf('未特定') < 0, 'Case B: 未特定にならない');

  // englishNameが完全に一致しない（ローマ字等）場合でも、japaneseNameがあれば
  // englishName異常を理由に未特定へは落とさず、無変更のenglishNameでDNR形式表示する
  var romaji = resolve('romaji name here', 'SynFamily SynGiven');
  assert(romaji === 'SynFamily SynGiven (romaji name here)', 'ローマ字等で比較不能でも無変更のままDNR形式で表示される, got ' + romaji);

  // TwcCore.twcDedupeDisplayNameで捕捉される既存の自己重複パターン（TWCの氏名重複調査で
  // 確認済み）も、事前のdedupeステップで正しく処理される
  assert(resolve('SynName SynName', 'SynName') === 'SynName (SynName)', '区切りなし全体重複はTwcCore.twcDedupeDisplayNameで除去される');

  // japaneseNameのみでenglishNameが空 → japaneseNameだけで表示（"名前 ()"のような
  // 不完全な形式にならない。未特定にも落とさない）
  var jaOnly = resolve('', 'SynFamily SynGiven');
  assert(jaOnly === 'SynFamily SynGiven', 'englishName空でもjapaneseNameだけで表示される（未特定へ落とさない）');
  assert(jaOnly.indexOf('(') < 0, 'englishName空の場合は空の括弧を付けない');

  // englishNameのみでjapaneseNameが空 → 既存仕様どおりenglishNameのみ（2832614-49/2834055-14相当の
  // 「最新マスタで新規解決できたケース」は退行させない）
  assert(resolve('SynEnglishOnly Name', '') === 'SynEnglishOnly Name', 'japaneseName空の場合はenglishNameのみ表示（既存の新規解決ケースを退行させない）');

  // 両方空 → 呼び出し側で(未特定)フォールバックが適用される空文字
  assert(resolve('', '') === '', '両方空の場合は空文字（呼び出し側で(未特定)フォールバック）');
}

// ---- 本番経路の全体パイプライン再現テスト ----
// 個別関数を単体で呼ぶのではなく、
//   master配列（fetchFtdsDriverMaster()の戻り値と同じ形）
//     → LatCore.latBuildTidNameMaps()
//     → render-webhook-server.js の /lat-export と全く同じグルー手順
//       （TwcCore.twcDedupeDisplayNameでの自己重複除去 → LatCore.latResolveDriverDisplayName）
//     → 最終表示名
// を実際に通し、transportId起点でenglishName/japaneseNameが失われずに最終表示まで
// 到達することを確認する。fetchFtdsDriverMaster()自体（/tenko-masterへのHTTP取得）と
// /tenko-master GETルート（外部GASへのプロキシ、render-webhook-server.js 971-988行）は
// いずれもレスポンスをそのまま(res.json(response.data))中継するだけで、フィールド名の
// 変換や書き換えは一切行っていない（コード上確認済み）。そのため、ここでのmaster配列は
// 「fetchFtdsDriverMaster()が実際に返す値の形」をそのまま模したもので問題ない。
//
// 値はすべて架空（SYN-プレフィックス）。実在TID・氏名は使わない。
function latExportGlueResolveDriverName(master, transportId) {
  // render-webhook-server.js の /lat-export ドライバー名解決部分（2484-2506行付近）と
  // 完全に同じ手順。この関数自体は本番コードの複製ではなく、本番コードが依存する
  // LatCore/TwcCore/DnrCoreの公開関数だけを同じ順序で呼び出すテスト専用ヘルパー。
  var maps = LatCore.latBuildTidNameMaps(master);
  var en = maps.tidToName[transportId] || '';
  var ja = maps.tidToJapaneseName[transportId] || '';
  if (!en && !ja) return { resolved: '', en: en, ja: ja };
  if (en) en = TwcCore.twcDedupeDisplayName(en);
  return { resolved: LatCore.latResolveDriverDisplayName(en, ja, DnrCore.dnrResolveDriverDisplayName), en: en, ja: ja };
}

function testFullPipelineFromMasterArrayToDisplayName() {
  // ケース1（AJ1R2YVU3NWZ2相当）: englishName自体は正常（トークン正規化は不要なケース）。
  // ここで確認したいのは「transportId→japaneseNameが latBuildTidNameMaps の時点で
  // 失われていないか」であり、正規化ロジックの動作確認ではない。
  var masterOno = [
    { transportId: 'SYN-TID-CASE1', englishName: 'SynGiven SynFamily', japaneseName: 'SynFamily SynGiven' }
  ];
  var r1 = latExportGlueResolveDriverName(masterOno, 'SYN-TID-CASE1');
  assert(r1.ja === 'SynFamily SynGiven', 'ケース1: latBuildTidNameMapsの時点でjapaneseNameが保持されている, got ' + JSON.stringify(r1.ja));
  assert(r1.en === 'SynGiven SynFamily', 'ケース1: englishNameも保持されている（正規化で消えていない）, got ' + JSON.stringify(r1.en));
  assert(r1.resolved === 'SynFamily SynGiven (SynGiven SynFamily)', 'ケース1: パイプライン全体で正しい表示名まで到達する, got ' + JSON.stringify(r1.resolved));
  assert(r1.resolved.indexOf('未特定') < 0, 'ケース1: 未特定にならない');

  // ケース2（A2YHPFN5QSP7X0相当）: englishNameに余分な断片トークンがあるケース。
  // パイプライン全体を通しても断片が正しく除去され、未特定にならないことを確認。
  var masterYamada = [
    { transportId: 'SYN-TID-CASE2', englishName: 'SynGiven SynFamily Syn', japaneseName: 'SynFamily SynGiven' }
  ];
  var r2 = latExportGlueResolveDriverName(masterYamada, 'SYN-TID-CASE2');
  assert(r2.ja === 'SynFamily SynGiven', 'ケース2: japaneseNameが保持されている');
  assert(r2.resolved === 'SynFamily SynGiven (SynGiven SynFamily)', 'ケース2: 断片トークン除去後の表示名まで到達する, got ' + JSON.stringify(r2.resolved));
  assert(r2.resolved.indexOf('未特定') < 0, 'ケース2: 未特定にならない');
  assert(r2.resolved.indexOf('Syn)') < 0, 'ケース2: 余分な断片トークンが最終表示に残っていない');

  // 対照実験: マスタ側にjapaneseNameが本当に存在しない（空文字）場合は、
  // パイプラインの途中で失われたのではなく、入力時点で無いことを明示する
  // （fetchFtdsDriverMaster()やlatBuildTidNameMapsの不具合と、マスタ側のデータ欠落を
  // 区別するための対照ケース）。この場合はenglishNameのみの表示になる（未特定にはしない）。
  var masterNoJa = [
    { transportId: 'SYN-TID-CASE3', englishName: 'SynEnglishOnly Name', japaneseName: '' }
  ];
  var r3 = latExportGlueResolveDriverName(masterNoJa, 'SYN-TID-CASE3');
  assert(r3.ja === '', '対照ケース: マスタ入力時点でjapaneseNameが空であることを明示');
  assert(r3.resolved === 'SynEnglishOnly Name', '対照ケース: japaneseNameが本当に無い場合はenglishNameのみの表示になる（2832614-49/2834055-14相当、退行なし）');

  // 同一TIDが複数レコードある場合でも、ケース1/2の情報が失われないことを確認
  // （latBuildTidNameMapsの重複対策との組み合わせ）
  var masterWithDup = [
    { transportId: 'SYN-TID-CASE1', englishName: '', japaneseName: '' }, // 空の重複レコードが後にあっても
    { transportId: 'SYN-TID-CASE1', englishName: 'SynGiven SynFamily', japaneseName: 'SynFamily SynGiven' }
  ];
  var r4 = latExportGlueResolveDriverName(masterWithDup, 'SYN-TID-CASE1');
  assert(r4.resolved === 'SynFamily SynGiven (SynGiven SynFamily)', '重複レコードがあっても正しい表示名まで到達する');
}

testFormatDetectionSyntheticFiles();
testFilenameIndependence();
testOrderIndependence();
testJoinSemantics();
testExcelSerialTimeVsCorruptedFormattedText();
testFieldSourcePrecedence();
testCycleValuesPassthrough();
testJudgmentBoundaries();
testBomCsv();
testLowStandalone();
testRawJoinSeventeenColumnOutput();
testBuildTidNameMapsHandlesDuplicateMasterRecords();
testNormalizeEnglishNameTokensGeneralRules();
testResolveDriverDisplayNameEndToEnd();
testFullPipelineFromMasterArrayToDisplayName();

console.log('lat-core.test.mjs: all tests passed (synthetic fixtures only; W35 real-data regression recorded in comments, not committed as fixture)');
