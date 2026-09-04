import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const RollingCore = require('../rolling60h-core.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}
function assertClose(actual, expected, message, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  assert(Math.abs(actual - expected) < eps, message + ' (got ' + actual + ', expected ' + expected + ')');
}

function daySeries(map, start, end) {
  return RollingCore.buildContinuousDailySeries(map, start, end);
}

function runTests() {
  // =========================================================================
  // 1. 勤務記号→時間変換（正式値）
  // =========================================================================
  assertClose(RollingCore.getBlockHours('MARU').hours, 11.0, '○=11.0h');
  assertClose(RollingCore.getBlockHours('HACHI').hours, 8.0, '❽=8.0h');
  assertClose(RollingCore.getBlockHours('BIKE').hours, 10.0, 'bike=10.0h');
  assertClose(RollingCore.getBlockHours('B1').hours, 5.0, 'b1=5.0h');
  assertClose(RollingCore.getBlockHours('B2').hours, 5.0, 'b2=5.0h');
  assertClose(RollingCore.getBlockHours('C1').hours, 6.5, 'C1=6.5h（高橋さんExcelの5.5hは不採用）');
  assertClose(RollingCore.getBlockHours('C3').hours, 4.5, 'C3=4.5h');

  // 「休」は正式に「勤務なし=0h・defined:true」として扱う（未定義記号ではない）
  var kyu = RollingCore.getBlockHours(RollingCore.normalizeRollingShiftCode('休'));
  assertClose(kyu.hours, 0, '休=0h');
  assert(kyu.defined === true, '休はdefined:trueとして扱われるべき（未定義記号ではない）');

  // 異体字の正規化（○の異体字は全てMARUに統一）
  assert(RollingCore.normalizeRollingShiftCode('○') === 'MARU', 'U+25CB -> MARU');
  assert(RollingCore.normalizeRollingShiftCode('〇') === 'MARU', 'U+3007 -> MARU');
  assert(RollingCore.normalizeRollingShiftCode('◯') === 'MARU', 'U+25EF -> MARU');
  assert(RollingCore.normalizeRollingShiftCode('C1') === 'C1', 'C1 -> C1');
  assert(RollingCore.normalizeRollingShiftCode('ｃ１') === 'C1', '全角ｃ１ -> C1');

  // 未定義記号: C2/嘉/研修/唐津は引き続きSHIFT_HOUR_TABLEに存在しない（推測で時間を設定しない）
  ['C2', '嘉', '研修', '唐津'].forEach(function (code) {
    var norm = RollingCore.normalizeRollingShiftCode(code);
    var h = RollingCore.getBlockHours(norm);
    assert(h.defined === false, code + ' は未定義として扱われるべき');
    assert(h.hours === null, code + ' の時間はnull（0を代入しない）');
  });

  // =========================================================================
  // 2. blocksパーサ
  // =========================================================================
  var p1 = RollingCore.parseShiftCellToBlocks('C1', 'roster');
  assert(p1.blocks.length === 1, 'C1単独 -> 1ブロック');
  assertClose(p1.blocks[0].hours, 6.5, 'C1単独ブロックの時間');
  assert(p1.warnings.length === 0, 'C1は既知記号なので警告なし');

  var p2 = RollingCore.parseShiftCellToBlocks('C3', 'roster');
  assertClose(p2.blocks[0].hours, 4.5, 'C3単独ブロックの時間');

  var pUndef = RollingCore.parseShiftCellToBlocks('嘉', 'roster');
  assert(pUndef.blocks[0].defined === false, '嘉は未定義ブロック');
  assert(pUndef.warnings.length === 1 && pUndef.warnings[0].type === 'undefined_code', '嘉は未定義警告を出す');

  var pEmpty = RollingCore.parseShiftCellToBlocks('', 'roster');
  assert(pEmpty.blocks.length === 0, '空セルはブロック0件');

  // 1日複数blocks（C1+C3を同日2ブロックとして手動構成 = 運用フロー通り）
  var dayRec = RollingCore.buildDayRecord('2026-09-14', [
    RollingCore.parseShiftCellToBlocks('C1', 'roster').blocks[0],
    RollingCore.parseShiftCellToBlocks('C3', 'roster').blocks[0],
  ]);
  assertClose(dayRec.dailyTotalHours, 11.0, 'C1+C3 = 11.0h（休憩1hは含まれない）');
  assert(dayRec.blocks.length === 2, '1日に2ブロック保持されている（1日1記号に固定していない）');

  // =========================================================================
  // 3. Rolling 7 Days 判定（しきい値: 59h / 60hちょうど / 60.1h）
  // =========================================================================
  function flatBlocks(hours, source) {
    // テスト用: 「その日の合計がhoursになる単一ブロック」を作る簡易ヘルパー
    // （実際のパーサ経由ではなく、Rolling計算コア単体の境界値テストのため）
    return [{ code: 'TEST', rawCode: 'TEST', source: source || 'roster', hours: hours, defined: true }];
  }

  // 7日間合計 59h ちょうど
  var m59 = {};
  ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'].forEach(function (d, i) {
    m59[d] = flatBlocks([9, 10, 10, 10, 10, 10, 0][i]); // 9+10*5+0=59
  });
  var s59 = daySeries(m59, '2026-09-01', '2026-09-07');
  var r59 = RollingCore.computeRolling60h(s59);
  assert(r59.length === 1, '7日ちょうどのseriesは1ウィンドウのみ');
  assertClose(r59[0].totalHours, 59, '合計59h');
  assert(r59[0].over === false, '59hは超過ではない');

  // 7日間合計 60h ちょうど（超過ではない: "60hを超えたら"超過）
  var m60 = {};
  ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'].forEach(function (d, i) {
    m60[d] = flatBlocks([10, 10, 10, 10, 10, 10, 0][i]); // =60
  });
  var r60 = RollingCore.computeRolling60h(daySeries(m60, '2026-09-01', '2026-09-07'));
  assertClose(r60[0].totalHours, 60, '合計60hちょうど');
  assert(r60[0].over === false, '60hちょうどは超過ではない（>60のみ超過）');

  // 7日間合計 60.1h（超過）
  var m601 = {};
  ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'].forEach(function (d, i) {
    m601[d] = flatBlocks([10, 10, 10, 10, 10, 10, 0.1][i]);
  });
  var r601 = RollingCore.computeRolling60h(daySeries(m601, '2026-09-01', '2026-09-07'));
  assertClose(r601[0].totalHours, 60.1, '合計60.1h');
  assert(r601[0].over === true, '60.1hは超過');
  assertClose(r601[0].overBy, 0.1, '超過分は0.1h');

  // 警戒ライン（既定=60と同値なので無効、59を指定した場合のみ機能）
  var r60Warn = RollingCore.computeRolling60h(daySeries(m60, '2026-09-01', '2026-09-07'), { warningHours: 59 });
  assert(r60Warn[0].over === false && r60Warn[0].warning === true, '60hちょうどは超過ではないが、警戒ライン59h以上なのでwarning=true');
  var r59Warn = RollingCore.computeRolling60h(daySeries(m59, '2026-09-01', '2026-09-07'), { warningHours: 59 });
  assert(r59Warn[0].warning === true, '59hは警戒ライン59h以上でwarning=true');

  // =========================================================================
  // 4. 任意の連続7日間スライド（固定週を使わない）＋ 月またぎ
  // =========================================================================
  // 8/29〜9/4 の8日間: 8/29〜9/4のうち、8/30〜9/5の窓が最大になるよう設計
  var mSlide = {};
  var slideVals = { '2026-08-29': 5, '2026-08-30': 10, '2026-08-31': 10, '2026-09-01': 10, '2026-09-02': 10, '2026-09-03': 10, '2026-09-04': 11, '2026-09-05': 0 };
  Object.keys(slideVals).forEach(function (d) {
    mSlide[d] = flatBlocks(slideVals[d]);
  });
  var sSlide = daySeries(mSlide, '2026-08-29', '2026-09-05');
  var rSlide = RollingCore.computeRolling60h(sSlide);
  // 8日分 -> 2ウィンドウ（8/29-9/4, 8/30-9/5）
  assert(rSlide.length === 2, '8暦日 -> 7日ウィンドウは2つ（1日ずつスライド、固定週を使わない）');
  assertClose(rSlide[0].totalHours, 5 + 10 + 10 + 10 + 10 + 10 + 11, '8/29〜9/4合計（月またぎ含む）');
  assert(rSlide[0].over === true, '8/29〜9/4は超過（66h）');
  assertClose(rSlide[1].totalHours, 10 + 10 + 10 + 10 + 10 + 11 + 0, '8/30〜9/5合計（月またぎ含む）');
  assert(rSlide[0].startDate === '2026-08-29' && rSlide[0].endDate === '2026-09-04', '1つ目のウィンドウは8/29〜9/4');
  assert(rSlide[1].startDate === '2026-08-30' && rSlide[1].endDate === '2026-09-05', '2つ目のウィンドウは8/30〜9/5（前月末日を含む月またぎ）');

  // =========================================================================
  // 5. データ欠損（noData）
  // =========================================================================
  var mGap = { '2026-09-01': flatBlocks(10) }; // 9/2〜9/7はデータなし
  var sGap = daySeries(mGap, '2026-09-01', '2026-09-07');
  assert(sGap[1].noData === true, '9/2はデータ欠損としてnoData=trueになる');
  var rGap = RollingCore.computeRolling60h(sGap);
  assertClose(rGap[0].totalHours, 10, '欠損日は0hとして扱われる（合計には10hのみ計上）');
  assert(rGap[0].noDataDates.length === 6, '欠損日6日分がnoDataDatesとして検知される');

  // =========================================================================
  // 6. 未定義勤務記号がRolling対象データに含まれる場合の検知
  // =========================================================================
  var mUndef = {};
  ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'].forEach(function (d) {
    mUndef[d] = flatBlocks(10);
  });
  // 9/3に未定義記号（嘉）を追加
  mUndef['2026-09-03'] = RollingCore.parseShiftCellToBlocks('嘉', 'roster').blocks;
  var sUndef = daySeries(mUndef, '2026-09-01', '2026-09-07');
  var rUndef = RollingCore.computeRolling60h(sUndef);
  assert(rUndef[0].hasUndefinedHours === true, '未定義記号を含むウィンドウはhasUndefinedHours=trueで検知される');
  assert(rUndef[0].undefinedDates.indexOf('2026-09-03') !== -1, '未定義記号の発生日が特定できる');
  assertClose(rUndef[0].totalHours, 10 * 6, '未定義記号の日は合計に0として計上され、黙って握りつぶされない（かつ検知フラグは立つ）');

  // =========================================================================
  // 7. roster_only 超過 と actual_progress 超過の判別
  // =========================================================================
  // ケースA: シフト予定だけで既に60h超過 (roster_only)
  var rosterOnlyBlocks = {};
  ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'].forEach(function (d) {
    rosterOnlyBlocks[d] = RollingCore.parseShiftCellToBlocks('○', 'roster').blocks; // 11h*7=77h
  });
  var rosterSeriesA = daySeries(rosterOnlyBlocks, '2026-09-14', '2026-09-20');
  // 実績が予定と全く同じ場合（過去日を実績化しても数値は変わらないケース）
  var blendedSeriesA = daySeries(rosterOnlyBlocks, '2026-09-14', '2026-09-20');
  var riskA = RollingCore.computeRollingRisk(rosterSeriesA, blendedSeriesA);
  assert(riskA[0].over === true, 'ケースA: 超過している');
  assert(riskA[0].riskType === 'roster_only', 'ケースA: 予定だけで超過 -> roster_only');

  // ケースB: 予定は60h以内だったが、実績が予定より伸びて60h超過 (actual_progress)
  var rosterPlanB = {};
  ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'].forEach(function (d, i) {
    // 予定: bike(10h)を6日 + 休1日 = 60h (超過なし)
    rosterPlanB[d] = i < 6 ? RollingCore.parseShiftCellToBlocks('bike', 'roster').blocks : [];
  });
  var rosterOnlySeriesB = daySeries(rosterPlanB, '2026-09-14', '2026-09-20');
  assert(RollingCore.computeRolling60h(rosterOnlySeriesB)[0].over === false, '前提: 予定のみなら60hちょうどで超過ではない');

  // 実績: 過去3日分（9/14-9/16）は予定より稼働が伸びた（実際は○=11hだった）
  var blendedPlanB = {};
  ['2026-09-14', '2026-09-15', '2026-09-16'].forEach(function (d) {
    blendedPlanB[d] = [{ code: 'AMAZON_ACTUAL', rawCode: '(実績)', source: 'actual', hours: 11, defined: true }]; // 予定bike10h -> 実績11h
  });
  ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'].forEach(function (d, i) {
    blendedPlanB[d] = i < 3 ? RollingCore.parseShiftCellToBlocks('bike', 'roster').blocks : [];
  });
  var blendedSeriesB = daySeries(blendedPlanB, '2026-09-14', '2026-09-20');
  var riskB = RollingCore.computeRollingRisk(rosterOnlySeriesB, blendedSeriesB);
  assertClose(riskB[0].totalHours, 11 * 3 + 10 * 3 + 0, 'ケースB: 実績+予定合成の合計');
  assert(riskB[0].over === true, 'ケースB: 実績反映後は超過している');
  assert(riskB[0].rosterOnlyOver === false, 'ケースB: 予定のみでは超過していなかった');
  assert(riskB[0].riskType === 'actual_progress', 'ケースB: 実績進捗による超過 -> actual_progress');

  // =========================================================================
  // 8. 実績＋予定の合成（過去=実績優先／未来=予定優先）
  // =========================================================================
  var actualMap = { '2026-09-01': RollingCore.parseShiftCellToBlocks('C1', 'roster').blocks.map(function (b) { return Object.assign({}, b, { source: 'actual' }); }) };
  var rosterMap = {
    '2026-09-01': RollingCore.parseShiftCellToBlocks('○', 'roster').blocks, // 過去日だが予定側にも存在。実績優先されるべき
    '2026-09-05': RollingCore.parseShiftCellToBlocks('bike', 'roster').blocks, // 未来日は予定を使う
  };
  var merged = RollingCore.mergeActualAndRoster(actualMap, rosterMap, '2026-09-03');
  assertClose(RollingCore.buildDayRecord('2026-09-01', merged['2026-09-01']).dailyTotalHours, 6.5, '過去日(9/1)は実績(C1=6.5h)が優先される（予定○11hではない）');
  assertClose(RollingCore.buildDayRecord('2026-09-05', merged['2026-09-05']).dailyTotalHours, 10, '未来日(9/5)は予定(bike=10h)が使われる');

  // =========================================================================
  // 9. Transport ID一致 / 氏名フォールバック / 複数実績行の加算
  // =========================================================================
  var rosterRows = [
    ['社名', '名前', 'Transport ID', new Date(2026, 8, 1), new Date(2026, 8, 2)],
    ['GDS', '砥綿　剛平', 'TID-AAA', '○', 'bike'],
    ['GDS', '氏名のみドライバー', '', 'C1', ''],
  ];
  var rosterParsed = RollingCore.parseMonthlyRosterSheetRows(rosterRows);
  assert(rosterParsed.meta.tidCol !== -1, 'Transport ID列が検出できる');
  var groupedRoster = RollingCore.groupRosterRecordsByDriver(rosterParsed.records);
  assert(groupedRoster['TID-AAA'], 'Transport IDをキーとしてグルーピングされる');
  assert(groupedRoster['NAME:氏名のみドライバー'], 'Transport IDが無い場合は氏名キーにフォールバックする');
  assertClose(RollingCore.buildDayRecord('x', groupedRoster['TID-AAA'].blocksByDate['2026-09-01']).dailyTotalHours, 11, 'TID-AAAの9/1は○=11h');
  assertClose(RollingCore.buildDayRecord('x', groupedRoster['TID-AAA'].blocksByDate['2026-09-02']).dailyTotalHours, 10, 'TID-AAAの9/2はbike=10h');

  // 同一Transport ID・同一日の複数実績行（Amazon実績が1日に複数行あるケース）
  var amazonRows = [
    ['year', 'month', 'week', 'period', 'snapshot_date', 'working_day', 'station_code', 'nodes', 'dsp', 'transporter_id', 'email', 'provider_id', 'start', 'end', 'estimated_working_hour'],
    [2026, 9, 36, 'p', 'x', '2026-09-01', 'OFK3', 'OFK3', 'GION', 'TID-AAA', 'a@b.com', 'prov', 's', 'e', 4],
    [2026, 9, 36, 'p', 'x', '2026-09-01', 'OFK3', 'OFK3', 'GION', 'TID-AAA', 'a@b.com', 'prov', 's', 'e', 2.5],
  ];
  var amazonParsed = RollingCore.parseAmazonDailyRows(amazonRows);
  assert(amazonParsed.records.length === 2, '同一TID・同一日でも2行とも保持される（上書きしない）');
  var groupedActual = RollingCore.groupActualRecordsByTransportId(amazonParsed.records);
  assert(groupedActual['TID-AAA']['2026-09-01'].length === 2, '同一日に2ブロックとして保持される');
  assertClose(RollingCore.buildDayRecord('x', groupedActual['TID-AAA']['2026-09-01']).dailyTotalHours, 6.5, '2行の実績が加算される(4+2.5=6.5)');

  // station_codeフィルタ（既定OFK3）
  var amazonRowsOtherStation = [
    amazonRows[0],
    [2026, 9, 36, 'p', 'x', '2026-09-01', 'OFK9', 'OFK9', 'GION', 'TID-BBB', 'a@b.com', 'prov', 's', 'e', 4],
  ];
  var amazonParsedFiltered = RollingCore.parseAmazonDailyRows(amazonRowsOtherStation);
  assert(amazonParsedFiltered.records.length === 0, '既定ではOFK3以外のstation_codeは除外される');
  var amazonParsedUnfiltered = RollingCore.parseAmazonDailyRows(amazonRowsOtherStation, { stationFilter: null });
  assert(amazonParsedUnfiltered.records.length === 1, 'stationFilter:nullで全件取得できる');

  // =========================================================================
  // 10. 高橋さんExcelの「1日ずつスライドする7日合計」方式との整合性
  //     （CH=SUM(D:J), CI=SUM(E:K), ... の実装パターンをC1を使わずに再現し、一致を確認）
  // =========================================================================
  var takahashiStyleCodes = { // C1を含まないケース（高橋さんExcelのC1=5.5h誤りの影響を受けない範囲）
    '2026-08-25': 'bike', '2026-08-26': '○', '2026-08-27': '休', '2026-08-28': '❽',
    '2026-08-29': 'b1', '2026-08-30': 'b2', '2026-08-31': 'C3', '2026-09-01': 'bike',
  };
  var expectedHours = { bike: 10, '○': 11, '休': 0, '❽': 8, b1: 5, b2: 5, C3: 4.5 };
  var takahashiMap = {};
  Object.keys(takahashiStyleCodes).forEach(function (d) {
    // 休も含めてパーサを一律に通す（休は正式に0h・defined:trueとして扱われるため特別扱い不要）
    takahashiMap[d] = RollingCore.parseShiftCellToBlocks(takahashiStyleCodes[d], 'roster').blocks;
  });
  var takahashiSeries = daySeries(takahashiMap, '2026-08-25', '2026-09-01');
  var takahashiResults = RollingCore.computeRolling60h(takahashiSeries);
  // CH相当 = SUM(8/25:8/31), CI相当 = SUM(8/26:9/1) と同じ考え方
  var manualCH = expectedHours['bike'] + expectedHours['○'] + expectedHours['休'] + expectedHours['❽'] + expectedHours['b1'] + expectedHours['b2'] + expectedHours['C3'];
  var manualCI = expectedHours['○'] + expectedHours['休'] + expectedHours['❽'] + expectedHours['b1'] + expectedHours['b2'] + expectedHours['C3'] + expectedHours['bike'];
  assertClose(takahashiResults[0].totalHours, manualCH, '高橋さんExcel方式(CH=SUM(D:J)相当)と一致（C1を含まないケース）');
  assertClose(takahashiResults[1].totalHours, manualCI, '高橋さんExcel方式(CI=SUM(E:K)相当)と一致（C1を含まないケース）');
  // 休(0h)を含む2つのウィンドウとも、未定義警告が一切発生しないことを確認
  assert(takahashiResults[0].hasUndefinedHours === false, '休を含むウィンドウ(CH相当)で未定義警告が発生しない');
  assert(takahashiResults[0].undefinedDates.length === 0, '休を含むウィンドウ(CH相当)のundefinedDatesは空');
  assert(takahashiResults[1].hasUndefinedHours === false, '休を含むウィンドウ(CI相当)で未定義警告が発生しない');
  assert(takahashiResults[1].undefinedDates.length === 0, '休を含むウィンドウ(CI相当)のundefinedDatesは空');

  // 休を含む7日間Rollingの正常計算（休=0hとして合計に反映され、未定義扱いにならない）
  var kyuWeekMap = {};
  ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'].forEach(function (d, i) {
    // bikeを6日 + 休1日
    kyuWeekMap[d] = RollingCore.parseShiftCellToBlocks(i < 6 ? 'bike' : '休', 'roster').blocks;
  });
  var kyuWeekResult = RollingCore.computeRolling60h(daySeries(kyuWeekMap, '2026-09-01', '2026-09-07'));
  assertClose(kyuWeekResult[0].totalHours, 10 * 6 + 0, '休を含む7日間の合計はbike×6+休(0h)=60h');
  assert(kyuWeekResult[0].over === false, '休を含む7日間(60hちょうど)は超過ではない');
  assert(kyuWeekResult[0].hasUndefinedHours === false, '休を含んでいても未定義警告は発生しない');
  assert(kyuWeekResult[0].undefinedDates.length === 0, '休を含んでいてもundefinedDatesは空のまま');
  var kyuDayBlock = RollingCore.parseShiftCellToBlocks('休', 'roster');
  assert(kyuDayBlock.warnings.length === 0, '休のパース結果自体にも未定義警告が付与されない');
  assert(kyuDayBlock.blocks[0].defined === true && kyuDayBlock.blocks[0].hours === 0, '休のブロックはdefined:true・hours:0');

  // C1を含むケース: 高橋さんExcelの5.5hではなく正式値6.5hで計算されることを確認
  var withC1Map = {};
  ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'].forEach(function (d, i) {
    withC1Map[d] = i === 0 ? RollingCore.parseShiftCellToBlocks('C1', 'roster').blocks : [];
  });
  var withC1Series = daySeries(withC1Map, '2026-09-01', '2026-09-07');
  var withC1Result = RollingCore.computeRolling60h(withC1Series);
  assertClose(withC1Result[0].totalHours, 6.5, 'C1を含むウィンドウは正式値6.5hで計算される（高橋さんExcelの5.5hは使用しない）');
  assert(Math.abs(withC1Result[0].totalHours - 5.5) > 1e-9, '高橋さんExcelの誤った5.5hが紛れ込んでいないことを確認');

  // =========================================================================
  // 11. シミュレーション用 override（非破壊）
  // =========================================================================
  var baseSeries = daySeries(
    {
      '2026-09-14': RollingCore.parseShiftCellToBlocks('○', 'roster').blocks,
      '2026-09-15': RollingCore.parseShiftCellToBlocks('○', 'roster').blocks,
      '2026-09-16': RollingCore.parseShiftCellToBlocks('○', 'roster').blocks,
      '2026-09-17': RollingCore.parseShiftCellToBlocks('○', 'roster').blocks,
      '2026-09-18': RollingCore.parseShiftCellToBlocks('○', 'roster').blocks,
      '2026-09-19': RollingCore.parseShiftCellToBlocks('○', 'roster').blocks,
      '2026-09-20': RollingCore.parseShiftCellToBlocks('○', 'roster').blocks,
    },
    '2026-09-14',
    '2026-09-20'
  );
  var beforeOverride = RollingCore.computeRolling60h(baseSeries);
  assertClose(beforeOverride[0].totalHours, 77, '変更前: ○×7 = 77h');
  var afterOverride = RollingCore.computeRolling60h(baseSeries, { overrides: { '2026-09-20': 'C1' } });
  assertClose(afterOverride[0].totalHours, 11 * 6 + 6.5, '9/20を○→C1へ仮変更した場合の再計算結果');
  // 元のseriesが破壊されていないことを確認（非破壊）
  assertClose(RollingCore.buildDayRecord('2026-09-20', baseSeries[6].blocks).dailyTotalHours, 11, 'overrideは元のseriesを破壊しない');

  console.log('rolling60h-core.test.mjs: ALL TESTS PASSED (' + 'checks executed' + ')');
}

runTests();
