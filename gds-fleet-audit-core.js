/**
 * OFK3 GDS台数自動照合 Phase 1 — 判定・集計処理コア（DOM非依存の純粋関数のみ）
 *
 * 目的: Cortex GDS Weekly Report CSV（正データ）と Amazon dsp1.0_inputfile_gds
 * XLSM（InputFileに登録済みの台数）を突き合わせ、日別に Bike 2h / Bike 3h /
 * Pair(4.5B+6.5B) / 8B の差異を検出する。
 *
 * 重要原則:
 *  - Cortex当日実績を正とする。固定の「正常台数」をハードコードしない
 *    （本ファイルには 8/12, 18 等の期待値は一切登場しない。実際に出現した
 *    サービスタイプ名・列名のみを構造的な識別子として使用する）。
 *  - データが取得できない場合は 0 と混同せず null（判定不可）を返す。
 *
 * 列構造は実データで検証済み（推測ではない）:
 *
 * 1) Cortex GDS Weekly Report CSV の実ヘッダー
 *    （提供実データ GDS_Weekly_Report-2026-09-13.csv より）:
 *    日付,ステーション,プロバイダーショートコード,サービスタイプ,計画された時間,
 *    計画された合計距離,合計距離手当,計画された距離単位,AMZL遅延キャンセル,
 *    Provider late cancel,クイックカバー,承諾済み,完了したルート
 *    - 日付: "YYYY-MM-DD"
 *    - ステーション: "Fukuoka (OFK3) - Amazon.com" のように "OFK3" を含む
 *    - サービスタイプ: "Standard Parcel" / "Nursery Route Level 1/2/3" /
 *      "Biker (Rear Cargo - Large)" / "DA Onboarding" 等
 *    - 計画された時間: "8時間" / "4時間30分" / "6時間30分" / "3時間" / "2時間"
 *    - 完了したルート: 台数（整数）
 *
 * 2) dsp1.0_inputfile_gds_*.xlsm の実シート構造
 *    （提供実データ dsp1.0_inputfile_gds_20260919_1440_1.xlsm より）:
 *    "InputFile" シート、Row0-2はメタ情報・曜日ラベル、Row3がヘッダー行:
 *    ["DSP","NodeP","Node","DS Name","Type","Memo","ServiceType","Cycle","Block","B/S", <日付シリアル値...>]
 *    - Node列: OFK3行は厳密に "OFK3"（56拠点中の1つ。他は"CPR1","DCJ1"等）
 *    - Block列: 数値の時間数（8, 6.5, 5.5, 4.5, 6, 5, 7, 4, 3, 2 等）。
 *      OFK3の実データでは 8B=Block8, 6.5B=Block6.5, 4.5B=Block4.5,
 *      Bike3h=Block3, Bike2h=Block2 のみ値が入っており、他Blockは空欄。
 *    - Cycle列: "CYCLE_1"/"CYCLE_2"/"CYCLE_3" 等。Bikeは2h/3hそれぞれ
 *      CYCLE_1行とCYCLE_2行に分かれて登録されている
 *      （例: Block=2の行がCycle=CYCLE_1とCYCLE_2の2行存在し、合算が2h実車台数）。
 *      B/S列の値でも同じ区分ができるため、本コアはBlock数値でカテゴリ分けし、
 *      同一Blockの複数Cycle行は自動的に合算される。
 *    - 日付列: ヘッダー行のセルがExcelシリアル値（1900年系、40000〜60000程度）
 *      になっている列を動的に検出する（列位置を固定しない）。
 */
(function (global) {
  'use strict';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Excel(1900年系)シリアル値 → 'YYYY-MM-DD'。UTC演算のみで行い、
  // ローカルタイムゾーンによる前日/翌日ズレを避ける。
  function excelSerialToIsoDate(serial) {
    var n = Number(serial);
    if (!isFinite(n)) return null;
    var utcDays = Math.floor(n - 25569);
    var d = new Date(utcDays * 86400 * 1000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function isLikelyExcelDateSerial(v) {
    var n = Number(v);
    return typeof v === 'number' && isFinite(n) && n >= 40000 && n <= 60000;
  }

  // "8時間" → 8 / "4時間30分" → 4.5 / "6時間30分" → 6.5。
  // 「時間」を含まない値は時間指定ではないためnullを返す（推測でparseFloatしない）。
  function parseJaDurationHours(text) {
    var s = String(text == null ? '' : text).trim();
    var m = s.match(/^(\d+)\s*時間(?:\s*(\d+)\s*分)?$/);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = m[2] ? parseInt(m[2], 10) : 0;
    if (!isFinite(h)) return null;
    return h + min / 60;
  }

  // "2026-09-13" 等 → 'YYYY-MM-DD'。区切り文字違いに寛容な正規表現ベース抽出。
  function normalizeDateLoose(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!m) return null;
    return m[1] + '-' + pad2(parseInt(m[2], 10)) + '-' + pad2(parseInt(m[3], 10));
  }

  // RFC4180相当のシンプルなCSV1行パーサ（ダブルクォート・カンマ対応）。
  function parseCsvLine(line) {
    var result = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line.charAt(i + 1) === '"') { current += '"'; i++; }
          else { inQuotes = false; }
        } else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { result.push(current); current = ''; }
        else { current += ch; }
      }
    }
    result.push(current);
    return result;
  }

  function splitCsvLines(text) {
    var s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  }

  var CORTEX_REQUIRED_COLS = ['日付', 'ステーション', 'サービスタイプ', '計画された時間', '完了したルート'];

  function isOfk3Station(stationVal) {
    return String(stationVal || '').toUpperCase().indexOf('OFK3') >= 0;
  }

  // サービスタイプ→カテゴリ分類。
  //  parcel: 8B/Pairの合算対象（"Standard Parcel" 完全一致 or "Nursery" を含む=全Level）
  //  biker : Bikeの合算対象（"Biker (Rear Cargo - Large)" 完全一致。
  //          "DA Onboarding" 等の非デリバリー枠はBikeに含めない —
  //          InputFile側のBiker行のServiceTypeも "Biker (Rear Cargo - Large)" のみで
  //          あることを実データで確認済みのため、対称な定義とする）
  //  other : 上記以外（8B/Pair/Bikeいずれの対象にもしない）
  function classifyCortexServiceType(svc) {
    var s = String(svc == null ? '' : svc).trim();
    if (s === 'Standard Parcel') return 'parcel';
    if (s.toUpperCase().indexOf('NURSERY') >= 0) return 'parcel';
    if (s === 'Biker (Rear Cargo - Large)') return 'biker';
    return 'other';
  }

  function emptyDateBucket() {
    return { eightB: 0, pair45: 0, pair65: 0, bike2h: 0, bike3h: 0, otherServiceTypes: {} };
  }

  /**
   * Cortex GDS Weekly Report CSVをパースする。
   * @param {string} csvText
   * @returns {{ok:boolean, error:(string|null), byDate:Object, meta:Object}}
   */
  function parseCortexWeeklyCsv(csvText) {
    var lines = splitCsvLines(csvText).filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) {
      return { ok: false, error: 'CSVにデータ行がありません', byDate: {}, meta: { totalRows: 0, ofk3Rows: 0, dates: [], warnings: [] } };
    }
    var header = parseCsvLine(lines[0]).map(function (h) { return h.trim(); });
    var idx = {};
    header.forEach(function (h, i) { idx[h] = i; });
    var missing = CORTEX_REQUIRED_COLS.filter(function (c) { return !(c in idx); });
    if (missing.length) {
      return {
        ok: false,
        error: 'GDS Weekly Reportの想定ヘッダーが見つかりません（不足列: ' + missing.join(', ') + '）',
        byDate: {},
        meta: { totalRows: 0, ofk3Rows: 0, dates: [], warnings: [], header: header }
      };
    }

    var byDate = {};
    var ofk3Rows = 0;
    var warnings = [];
    var seenRowKeys = {};
    for (var i = 1; i < lines.length; i++) {
      var cols = parseCsvLine(lines[i]);
      var station = cols[idx['ステーション']];
      if (!isOfk3Station(station)) continue;
      ofk3Rows++;

      var date = normalizeDateLoose(cols[idx['日付']]);
      var svc = cols[idx['サービスタイプ']];
      var hours = parseJaDurationHours(cols[idx['計画された時間']]);
      var count = parseInt(cols[idx['完了したルート']], 10);
      if (!isFinite(count)) count = 0;
      if (!date || hours == null) continue;

      var rowKey = lines[i];
      if (seenRowKeys[rowKey]) {
        warnings.push('CSV完全重複行を検出（' + date + ' / ' + svc + ' / ' + hours + 'h）: ' + lines[i]);
      } else {
        seenRowKeys[rowKey] = true;
      }

      if (!byDate[date]) byDate[date] = emptyDateBucket();
      var bucket = byDate[date];
      var category = classifyCortexServiceType(svc);
      if (category === 'parcel') {
        if (hours === 8) bucket.eightB += count;
        else if (hours === 4.5) bucket.pair45 += count;
        else if (hours === 6.5) bucket.pair65 += count;
      } else if (category === 'biker') {
        if (hours === 2) bucket.bike2h += count;
        else if (hours === 3) bucket.bike3h += count;
      }
      if (category === 'other') {
        bucket.otherServiceTypes[svc] = (bucket.otherServiceTypes[svc] || 0) + count;
      }
    }

    return {
      ok: true,
      error: null,
      byDate: byDate,
      meta: {
        totalRows: lines.length - 1,
        ofk3Rows: ofk3Rows,
        dates: Object.keys(byDate).sort(),
        warnings: warnings,
        header: header
      }
    };
  }

  var INPUT_REQUIRED_COLS = ['Node', 'Block', 'B/S'];

  // ヘッダー行を先頭10行以内から動的検出（twc-core.jsのtwcFindHeaderRowと同じ考え方:
  // 必要列名が揃った行をヘッダーとみなす。シート名・行番号は固定しない）。
  function findInputFileHeaderRow(rows) {
    for (var r = 0; r < Math.min(rows.length, 10); r++) {
      var row = rows[r] || [];
      var norm = row.map(function (c) { return String(c == null ? '' : c).trim(); });
      var hasAll = INPUT_REQUIRED_COLS.every(function (col) { return norm.indexOf(col) >= 0; });
      if (hasAll) return r;
    }
    return -1;
  }

  function mapInputFileColumns(headerRow) {
    var map = {};
    for (var c = 0; c < headerRow.length; c++) {
      var key = String(headerRow[c] == null ? '' : headerRow[c]).trim();
      if (key && !(key in map)) map[key] = c;
    }
    return map;
  }

  function findInputFileDateColumns(headerRow) {
    var cols = [];
    for (var c = 0; c < headerRow.length; c++) {
      if (isLikelyExcelDateSerial(headerRow[c])) {
        cols.push({ col: c, date: excelSerialToIsoDate(headerRow[c]) });
      }
    }
    return cols;
  }

  /**
   * dsp1.0_inputfile_gds_*.xlsm の1シート分（XLSX.utils.sheet_to_json(ws,{header:1,defval:''})
   * で得られる2次元配列）をパースする。ブラウザ側でシートを選ぶ際は、
   * 各シートに対して本関数を試し、ok:trueを返した最初のシートを採用する
   * （シート名 "InputFile" を前提にしない）。
   * @param {Array<Array>} rows
   * @returns {{ok:boolean, error:(string|null), byDate:Object, meta:Object}}
   */
  function parseInputFileRows(rows) {
    if (!Array.isArray(rows) || !rows.length) {
      return { ok: false, error: 'シートが空です', byDate: {}, meta: { headerRowIndex: -1, ofk3Rows: 0, warnings: [] } };
    }
    var headerRowIndex = findInputFileHeaderRow(rows);
    if (headerRowIndex < 0) {
      return { ok: false, error: 'InputFileの想定ヘッダー行（Node/Block/B-S列）が見つかりません', byDate: {}, meta: { headerRowIndex: -1, ofk3Rows: 0, warnings: [] } };
    }
    var headerRow = rows[headerRowIndex];
    var colMap = mapInputFileColumns(headerRow);
    var colNode = colMap['Node'];
    var colBlock = colMap['Block'];
    var colBS = colMap['B/S'];
    var colCycle = colMap['Cycle'];
    var dateCols = findInputFileDateColumns(headerRow);

    if (!dateCols.length) {
      return { ok: false, error: 'InputFileに日付列（Excelシリアル値）が見つかりません', byDate: {}, meta: { headerRowIndex: headerRowIndex, ofk3Rows: 0, warnings: [] } };
    }

    var byDate = {};
    dateCols.forEach(function (dc) { byDate[dc.date] = emptyDateBucket(); });

    var ofk3Rows = 0;
    var warnings = [];
    var seenKeys = {};
    for (var r = headerRowIndex + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row.length) continue;
      var nodeVal = String(row[colNode] == null ? '' : row[colNode]).trim().toUpperCase();
      if (nodeVal !== 'OFK3') continue;
      ofk3Rows++;

      var blockVal = Number(row[colBlock]);
      if (!isFinite(blockVal) || blockVal <= 0) continue;

      var dupKey = nodeVal + '|' + (colCycle != null ? row[colCycle] : '') + '|' + blockVal + '|' + (colBS != null ? row[colBS] : '');
      if (seenKeys[dupKey]) {
        warnings.push('InputFile重複キー行を検出（Node=' + nodeVal + ' Block=' + blockVal + ' B/S=' + (colBS != null ? row[colBS] : '') + '）: row ' + r);
      } else {
        seenKeys[dupKey] = true;
      }

      var category = null;
      if (blockVal === 8) category = 'eightB';
      else if (blockVal === 4.5) category = 'pair45';
      else if (blockVal === 6.5) category = 'pair65';
      else if (blockVal === 2) category = 'bike2h';
      else if (blockVal === 3) category = 'bike3h';
      if (!category) continue; // 今回の4指標（Bike2h/3h, Pair, 8B）の対象外Blockは無視

      dateCols.forEach(function (dc) {
        var cell = row[dc.col];
        var n = (cell === '' || cell == null) ? 0 : Number(cell);
        if (!isFinite(n)) n = 0;
        byDate[dc.date][category] += n;
      });
    }

    return {
      ok: true,
      error: null,
      byDate: byDate,
      meta: {
        headerRowIndex: headerRowIndex,
        ofk3Rows: ofk3Rows,
        dates: Object.keys(byDate).sort(),
        warnings: warnings,
        columns: colMap
      }
    };
  }

  // Pairの内部整合性チェック（4.5B算出値 === 6.5B算出値の時のみ確定値を返す）。
  function resolvePair(v45, v65) {
    if (v45 == null || v65 == null) return { value: null, consistent: null };
    if (v45 === v65) return { value: v45, consistent: true };
    return { value: null, consistent: false };
  }

  function buildCategoryResult(cortexVal, inputVal) {
    if (cortexVal == null || inputVal == null) {
      return { status: 'unknown', cortex: cortexVal == null ? null : cortexVal, input: inputVal == null ? null : inputVal, diff: null };
    }
    var diff = inputVal - cortexVal;
    return { status: diff === 0 ? 'ok' : 'alert', cortex: cortexVal, input: inputVal, diff: diff };
  }

  function buildPairResult(cortexBucket, inputBucket) {
    var cortexPair = cortexBucket ? resolvePair(cortexBucket.pair45, cortexBucket.pair65) : { value: null, consistent: null };
    var inputPair = inputBucket ? resolvePair(inputBucket.pair45, inputBucket.pair65) : { value: null, consistent: null };
    var detail = {
      cortex45: cortexBucket ? cortexBucket.pair45 : null,
      cortex65: cortexBucket ? cortexBucket.pair65 : null,
      cortexConsistent: cortexPair.consistent,
      input45: inputBucket ? inputBucket.pair45 : null,
      input65: inputBucket ? inputBucket.pair65 : null,
      inputConsistent: inputPair.consistent
    };
    if (cortexPair.consistent === false || inputPair.consistent === false) {
      return Object.assign({ status: 'inconsistent', cortex: cortexPair.value, input: inputPair.value, diff: null }, detail);
    }
    return Object.assign(buildCategoryResult(cortexPair.value, inputPair.value), detail);
  }

  /**
   * Cortex実績とInputFile登録値を日別に比較する。
   * 監査対象日は「Weekly Reportに含まれる日付」（cortexResult.byDateのキー）。
   * @param {ReturnType<parseCortexWeeklyCsv>} cortexResult
   * @param {ReturnType<parseInputFileRows>} inputResult
   */
  function compareGdsFleet(cortexResult, inputResult) {
    var dates = Object.keys((cortexResult && cortexResult.byDate) || {}).sort();
    var days = dates.map(function (date) {
      var cortexBucket = cortexResult.byDate[date];
      var inputBucket = inputResult && inputResult.ok ? inputResult.byDate[date] : null;

      var categories = {
        bike2h: buildCategoryResult(cortexBucket.bike2h, inputBucket ? inputBucket.bike2h : null),
        bike3h: buildCategoryResult(cortexBucket.bike3h, inputBucket ? inputBucket.bike3h : null),
        eightB: buildCategoryResult(cortexBucket.eightB, inputBucket ? inputBucket.eightB : null),
        pair: buildPairResult(cortexBucket, inputBucket)
      };

      var keys = Object.keys(categories);
      var hasAlert = keys.some(function (k) { return categories[k].status === 'alert' || categories[k].status === 'inconsistent'; });
      var hasUnknown = keys.some(function (k) { return categories[k].status === 'unknown'; });
      var dayStatus = hasAlert ? 'alert' : (hasUnknown ? 'unknown' : 'ok');

      return { date: date, categories: categories, dayStatus: dayStatus };
    });

    var summary = { total: days.length, ok: 0, alert: 0, unknown: 0 };
    days.forEach(function (d) {
      if (d.dayStatus === 'ok') summary.ok++;
      else if (d.dayStatus === 'alert') summary.alert++;
      else summary.unknown++;
    });

    return {
      days: days,
      summary: summary,
      rangeLabel: dates.length ? (dates[0] + ' 〜 ' + dates[dates.length - 1]) : ''
    };
  }

  var GdsFleetAuditCore = {
    excelSerialToIsoDate: excelSerialToIsoDate,
    isLikelyExcelDateSerial: isLikelyExcelDateSerial,
    parseJaDurationHours: parseJaDurationHours,
    normalizeDateLoose: normalizeDateLoose,
    parseCsvLine: parseCsvLine,
    classifyCortexServiceType: classifyCortexServiceType,
    parseCortexWeeklyCsv: parseCortexWeeklyCsv,
    findInputFileHeaderRow: findInputFileHeaderRow,
    parseInputFileRows: parseInputFileRows,
    compareGdsFleet: compareGdsFleet
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GdsFleetAuditCore;
  }
  if (typeof global !== 'undefined') {
    global.GdsFleetAuditCore = GdsFleetAuditCore;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
