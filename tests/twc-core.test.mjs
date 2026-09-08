// twc-core.js のユニットテスト。
// 対象は今回のW35実データ比較で見つかった3点の差分修正（超過時間の1分ズレ／
// ドライバー名の自己重複表示／既存の判定・抽出ロジックの回帰）。
// index.html本体・dnr-core.js・FTDS/CC/DNRの各APIは対象外（変更していない）。
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const TwcCore = require('../twc-core.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

var HEADER = ['transporter_id', 'time_window', 'planned_enter_time', 'actual_attempt_time', 'scannable_id', 'failure_bridge'];

function row(tid, windowText, plannedEnter, actualAttempt, scannableId, failureBridge) {
  return [tid, windowText, plannedEnter || '', actualAttempt, scannableId || '', failureBridge || ''];
}

// ---- twcFindHeaderRow / twcMapColumns / twcProcessRows: 基本の抽出ロジック（既存仕様） ----
function testHeaderAndBasicExtraction() {
  var rows = [
    ['メモ行'], // ノイズ行（10行以内はスキャン対象）
    HEADER,
    row('T1', 'DW 05:00:00-13:00:00', '', new Date(2026, 7, 28, 13, 10, 0)), // 13:00超過 → 10分違反
    row('T2', 'DW 05:00:00-13:00:00', '', new Date(2026, 7, 28, 12, 59, 0)), // 時間指定内 → 違反ではない
    row('T3', 'DW 05:00:00-13:00:00', '', new Date(2026, 7, 28, 13, 0, 0)),  // ちょうど0分 → 除外
    ['', '', '', ''] // 空行はスキップ
  ];
  var result = TwcCore.twcProcessRows(rows);
  assert(!result.error, 'header found, no error: ' + JSON.stringify(result));
  assert(result.totalRows === 3, '有効行3件（T1/T2/T3、超過有無に関わらず数える）, got ' + result.totalRows);
  assert(result.violations.length === 1, '違反は正の超過のみ1件（T1）, got ' + result.violations.length);
  assert(result.violations[0].transportId === 'T1', '違反はT1のみ');
  assert(result.violations[0].overageMin === 10, 'T1の超過は10分, got ' + result.violations[0].overageMin);

  var noHeader = TwcCore.twcProcessRows([['a', 'b'], ['1', '2']]);
  assert(noHeader.error === 'header_not_found', '必須4列が無ければheader_not_found');

  var noValidRows = TwcCore.twcProcessRows([HEADER, ['', '', '', '']]);
  assert(noValidRows.error === 'no_valid_rows', '有効行が無ければno_valid_rows');
}

// ---- 修正1: 最大超過時間の1分ズレ（Math.round→Math.floorへの最小修正） ----
function testOverageMinuteBoundary() {
  var windowEnd = new Date(2026, 7, 28, 13, 0, 0); // DW ...-13:00:00

  function overageFor(actual) {
    var rows = [HEADER, row('T1', 'DW 05:00:00-13:00:00', '', actual)];
    var result = TwcCore.twcProcessRows(rows);
    assert(!result.error, 'no error for ' + actual);
    return result.violations.length ? result.violations[0].overageMin : 0;
  }

  // 実データ比較で見つかったケース: 70分30秒の超過は切り捨てで70分（1時間10分）。
  // 四捨五入(Math.round)のままだと71分（1時間11分）に繰り上がってしまい、
  // 既存正常出力（W35_時間指定違反_分析）の表示とズレていた。
  var a1 = new Date(windowEnd.getTime() + (70 * 60 + 30) * 1000);
  assert(overageFor(a1) === 70, '70分30秒の超過はfloorで70分, got ' + overageFor(a1));
  assert(TwcCore.twcFormatOverage(overageFor(a1)) === '1時間10分', '表示は1時間10分, got ' + TwcCore.twcFormatOverage(overageFor(a1)));

  // 70分59秒でも70分（境界値: 71分に切り上がらない）
  var a2 = new Date(windowEnd.getTime() + (70 * 60 + 59) * 1000);
  assert(overageFor(a2) === 70, '70分59秒もfloorで70分, got ' + overageFor(a2));

  // ちょうど71分00秒は71分（floorでも変わらない境界値）
  var a3 = new Date(windowEnd.getTime() + 71 * 60 * 1000);
  assert(overageFor(a3) === 71, 'ちょうど71分は71分, got ' + overageFor(a3));

  // ちょうど60分00秒は60分（最重点/要確認の閾値ちょうど）
  var a4 = new Date(windowEnd.getTime() + 60 * 60 * 1000);
  assert(overageFor(a4) === 60, 'ちょうど60分は60分, got ' + overageFor(a4));

  // 59分59秒は59分（60分未満・切り捨てで繰り上がらない）
  var a5 = new Date(windowEnd.getTime() + (59 * 60 + 59) * 1000);
  assert(overageFor(a5) === 59, '59分59秒は59分, got ' + overageFor(a5));

  // 1分00秒ちょうどは1分（違反として採用される最小の切りの良い値）
  var a6 = new Date(windowEnd.getTime() + 60 * 1000);
  assert(overageFor(a6) === 1, 'ちょうど1分は1分, got ' + overageFor(a6));

  // 超過1〜59秒（1分未満）はfloorで0分となり除外される（既存仕様: 超過0分は違反ではない）。
  // 注: 四捨五入(Math.round)だった旧実装では30〜59秒が繰り上がって1分の違反として
  // 採用されていたが、切り捨てへの変更により60秒未満は一律に除外される側へ寄る。
  // 今回比較したW35実データの57件一致には影響していないが、既知の副作用として記録する。
  var a7 = new Date(windowEnd.getTime() + 59 * 1000);
  assert(overageFor(a7) === 0, '59秒の超過はfloorで0分（除外）, got ' + overageFor(a7));

  // マイナス超過・ちょうど0分は引き続き除外
  var negative = new Date(windowEnd.getTime() - 60 * 1000);
  assert(overageFor(negative) === 0, 'マイナス超過は除外（overageMin未算出扱い）, got ' + overageFor(negative));
  var zero = new Date(windowEnd.getTime());
  assert(overageFor(zero) === 0, 'ちょうど0分は除外, got ' + overageFor(zero));
}

// ---- 修正2-B: ドライバー名の自己重複除去（表示バグ） ----
function testDedupeDisplayName() {
  assert(TwcCore.twcDedupeDisplayName('晴樹 藤永晴樹 藤永') === '晴樹 藤永', '区切りなし全体重複を除去, got ' + TwcCore.twcDedupeDisplayName('晴樹 藤永晴樹 藤永'));
  assert(TwcCore.twcDedupeDisplayName('健士朗 脇山 脇山') === '健士朗 脇山', '末尾語の重複を除去, got ' + TwcCore.twcDedupeDisplayName('健士朗 脇山 脇山'));
  // 正常な名前（• 会社名サフィックス含む）は変更しない
  assert(TwcCore.twcDedupeDisplayName('和希 西川 • OHRE') === '和希 西川 • OHRE', '正常な名前は無変更');
  assert(TwcCore.twcDedupeDisplayName('幸育 城間 • OFK6') === '幸育 城間 • OFK6', '正常な名前は無変更（別例）');
  assert(TwcCore.twcDedupeDisplayName('OHRE') === 'OHRE', '単語1つのみは無変更');
  assert(TwcCore.twcDedupeDisplayName('') === '', '空文字は空文字のまま');
  assert(TwcCore.twcDedupeDisplayName(null) === '', 'null/undefinedはクラッシュせず空文字');
  // 偶然文字数が偶数でも前後半が異なれば変更しない（誤って一般の名前を壊さないこと）
  assert(TwcCore.twcDedupeDisplayName('山田太郎') === '山田太郎', '前後半が異なる偶数長の名前は無変更');
}

// ---- 修正2-A: 未登録TID（不明表示）はgroupTwcByDriverの既存フォールバックのまま ----
function testUnknownTidGrouping() {
  var violations = [
    { driverName: '', transportId: 'A27Y129APFA6VZ', date: new Date(2026, 7, 28), overageMin: 15, actualAttempt: new Date(2026, 7, 28, 13, 15) },
    { driverName: '', transportId: 'A25XYTLVVS80FY', date: new Date(2026, 7, 28), overageMin: 20, actualAttempt: new Date(2026, 7, 28, 13, 20) }
  ];
  var stats = TwcCore.twcGroupByDriver(violations);
  var keys = stats.map(function (s) { return s.driverName; });
  // TransportIDの完全一致ルールを維持: マスタに無いTIDは「不明 (TID)」のまま、
  // 別TIDへ誤集約されない（fuzzy matchなし）ことを確認
  assert(keys.indexOf('不明 (A27Y129APFA6VZ)') >= 0, 'A27Y129APFA6VZは不明表示のまま, got ' + keys.join(','));
  assert(keys.indexOf('不明 (A25XYTLVVS80FY)') >= 0, 'A25XYTLVVS80FYは不明表示のまま, got ' + keys.join(','));
  assert(stats.length === 2, '別TIDは別々に保持される（誤集約されない）, got ' + stats.length);
}

// ---- groupTwcByDriver: 集計・順位付け（既存ロジック、無変更の回帰確認） ----
function testGroupByDriverRankingRegression() {
  var violations = [
    { driverName: 'A', transportId: 'T1', date: new Date(2026, 7, 25), overageMin: 10, actualAttempt: new Date(2026, 7, 25, 10, 0) },
    { driverName: 'A', transportId: 'T1', date: new Date(2026, 7, 26), overageMin: 90, actualAttempt: new Date(2026, 7, 26, 10, 0) },
    { driverName: 'B', transportId: 'T2', date: new Date(2026, 7, 25), overageMin: 100, actualAttempt: new Date(2026, 7, 25, 11, 0) }
  ];
  var stats = TwcCore.twcGroupByDriver(violations);
  assert(stats[0].driverName === 'A', 'Aが件数2件で1位（件数優先）, got ' + stats[0].driverName);
  assert(stats[0].count === 2 && stats[0].maxOverageMin === 90, 'Aの件数2/最大超過90分');
  assert(stats[1].driverName === 'B', 'Bは件数1件で2位');
  assert(TwcCore.twcMultiDayCount(stats[0].dates) === 2, 'Aは2日にまたがる');
}

// ---- classifyTwcJudgment: 既存3閾値の境界値（無変更・回帰確認） ----
function testClassifyJudgmentBoundaries() {
  assert(TwcCore.twcClassifyJudgment(6, 60) === '最重点', '件数6かつ最大60分→最重点');
  assert(TwcCore.twcClassifyJudgment(5, 60) === '要確認', '件数5(6未満)は最重点にならない→要確認');
  assert(TwcCore.twcClassifyJudgment(6, 59) === '要確認', '最大59分(60未満)は最重点にならないが件数6で要確認');
  assert(TwcCore.twcClassifyJudgment(3, 0) === '要確認', '件数3以上は要確認');
  assert(TwcCore.twcClassifyJudgment(2, 59) === '経過確認', '件数2・最大59分は経過確認');
  assert(TwcCore.twcClassifyJudgment(0, 60) === '要確認', '最大60分以上は件数に関わらず要確認');
}

// ---- twcResolveSheet3Name: シート名のサニタイズ（既存仕様・回帰確認） ----
function testResolveSheet3Name() {
  assert(TwcCore.twcResolveSheet3Name('高徳 太郎') === '高徳_重点確認', 'スペース区切りの最初のトークンのみ使用');
  assert(TwcCore.twcResolveSheet3Name('a/b\\c*d?e[f]g') === 'a_b_c_d_e_f_g_重点確認', '禁止文字はアンダースコアへ置換');
  var long = TwcCore.twcResolveSheet3Name('あ'.repeat(30));
  assert(long === 'あ'.repeat(20) + '_重点確認', '20文字で切り詰め, got ' + long);
}

// ---- 修正3（3シート目「重点確認」の抽出条件）: 現行コード仕様を正として確定。
// 既存index.html（exportTwcResult、初回導入コミット29eeb8cから無変更）およびtwc-core.jsの
// twcBuildTopDriverSheetRowsは、いずれも1位ドライバーのrecordsを絞り込みなく全件出力する
// ロジックしか実装されておらず、「8件中3件だけ掲載」という抽出条件はgit履歴全体を確認しても
// コード上に存在しない（該当コミットは29eeb8cのみで、導入時から一貫してtop.records全件を
// 出力している）。W35既存Excelの「8件中3件」はこのコードから再現できない値であり、
// 推測で「上位3件」「60分以上」等の新規フィルタを作ることを明示的に禁止されているため、
// 現行仕様（1位ドライバーの全違反レコードをそのまま出力）を正として維持する。
// 8件のドライバーなら8件とも出力されることを明示的に確認する。
function testTopDriverSheetKeepsAllRecords() {
  var eightRecordStats = TwcCore.twcGroupByDriver([
    { driverName: '高徳', transportId: 'T9', date: new Date(2026, 7, 28), overageMin: 10, actualAttempt: new Date(2026, 7, 28, 13, 15), plannedEnter: new Date(2026, 7, 28, 13, 0) },
    { driverName: '高徳', transportId: 'T9', date: new Date(2026, 7, 28), overageMin: 15, actualAttempt: new Date(2026, 7, 28, 13, 20), plannedEnter: new Date(2026, 7, 28, 13, 0) },
    { driverName: '高徳', transportId: 'T9', date: new Date(2026, 7, 28), overageMin: 33, actualAttempt: new Date(2026, 7, 28, 13, 33), plannedEnter: new Date(2026, 7, 28, 13, 0) },
    { driverName: '高徳', transportId: 'T9', date: new Date(2026, 7, 28), overageMin: 5,  actualAttempt: new Date(2026, 7, 28, 13, 40), plannedEnter: null },
    { driverName: '高徳', transportId: 'T9', date: new Date(2026, 7, 28), overageMin: 8,  actualAttempt: new Date(2026, 7, 28, 13, 45), plannedEnter: null },
    { driverName: '高徳', transportId: 'T9', date: new Date(2026, 7, 28), overageMin: 70, actualAttempt: new Date(2026, 7, 28, 14, 20), plannedEnter: null },
    { driverName: '高徳', transportId: 'T9', date: new Date(2026, 7, 28), overageMin: 2,  actualAttempt: new Date(2026, 7, 28, 14, 30), plannedEnter: null },
    { driverName: '高徳', transportId: 'T9', date: new Date(2026, 7, 28), overageMin: 12, actualAttempt: new Date(2026, 7, 28, 14, 45), plannedEnter: null }
  ]);
  assert(eightRecordStats[0].count === 8, '高徳は違反8件, got ' + eightRecordStats[0].count);
  var sheet = TwcCore.twcBuildTopDriverSheetRows(eightRecordStats, 8);
  var dataRowCount = sheet.rows.length - 2 /* タイトル行+ヘッダ行 */ - 3 /* 空行+判定行+確認候補行 */;
  assert(dataRowCount === 8, '8件中3件に絞り込むような新規フィルタは実装しない。8件は8件とも出力される, got ' + dataRowCount);
  assert(sheet.sheetName === '高徳_重点確認', 'シート名は1位ドライバー名から生成');
  assert(TwcCore.twcBuildTopDriverSheetRows([], 0) === null, 'ドライバーが居なければnull');
}

// ---- 新規: 「全体データ」シート（既存3シートの前に追加）の行生成 ----
// 既存3シート（時間指定_サマリー/DA別_詳細/重点確認）の内容・列構成には一切触れない、
// 追加専用の関数であることを確認する。
function testBuildAllDataSheetRows() {
  var violations = [
    { driverName: 'B太郎', transportId: 'T2', date: new Date(2026, 7, 28), timeWindow: 'DW 05:00:00-13:00:00', plannedEnter: new Date(2026, 7, 28, 12, 50), actualAttempt: new Date(2026, 7, 28, 14, 0), overageMin: 60, failureBridge: 'CUSTOMER_UNAVAILABLE' },
    { driverName: 'A次郎', transportId: 'T1', date: new Date(2026, 7, 28), timeWindow: 'DW 05:00:00-13:00:00', plannedEnter: null, actualAttempt: new Date(2026, 7, 28, 13, 10), overageMin: 10, failureBridge: '' }
  ];
  var rows = TwcCore.twcBuildAllDataSheetRows(violations, function (r) { return 'JA:' + r; });
  assert(rows[0].length === 9, 'ヘッダーは9列, got ' + rows[0].length);
  assert(rows.length === 3, 'ヘッダー1行+違反2行=3行, got ' + rows.length);
  // 実際の配達試行の昇順（A次郎13:10 → B太郎14:00）
  assert(rows[1][1] === 'A次郎', '1件目は実際の配達試行が早いA次郎, got ' + rows[1][1]);
  assert(rows[1][4] === '-', '計画上の入場が無ければ"-", got ' + rows[1][4]);
  assert(rows[2][1] === 'B太郎', '2件目はB太郎, got ' + rows[2][1]);
  assert(rows[2][4] === '12:50', '計画上の入場はtwcFormatTimeで整形される, got ' + rows[2][4]);
  assert(rows[2][8].indexOf('JA:CUSTOMER_UNAVAILABLE') >= 0, 'translateFnコールバックで備考のfailure_bridgeが翻訳される, got ' + rows[2][8]);
  assert(rows[1][8] === '時間指定超過', 'failure_bridgeが無ければ括弧書きは付かない, got ' + rows[1][8]);

  var emptyRows = TwcCore.twcBuildAllDataSheetRows([]);
  assert(emptyRows.length === 1, 'データ0件でもヘッダー行だけは返す, got ' + emptyRows.length);

  assert(TwcCore.TWC_SHEET_STYLE.allData.sheetName === '全体データ', 'シート名は全体データ');
}

testHeaderAndBasicExtraction();
testOverageMinuteBoundary();
testDedupeDisplayName();
testUnknownTidGrouping();
testGroupByDriverRankingRegression();
testClassifyJudgmentBoundaries();
testResolveSheet3Name();
testTopDriverSheetKeepsAllRecords();
testBuildAllDataSheetRows();

console.log('twc-core.test.mjs: all tests passed');
