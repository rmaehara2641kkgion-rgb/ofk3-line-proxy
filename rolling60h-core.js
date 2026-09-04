/**
 * OFK3 Rolling 60h — 純粋ロジック（UI非依存・XLSX非依存）
 *
 * 目的:
 *   「任意の連続7暦日」を1日ずつスライドしながら合計稼働時間を判定する
 *   Rolling 60h監視機能の計算コア。既存の WH60（固定・日曜始まり週）や
 *   点呼/シフト照合/経営計算のロジックとは完全に独立しており、それらの
 *   グローバル変数・関数（SHIFT_MASTER, EXEC_RATE_TABLE, normalizeShiftCode,
 *   normalizeExecCourseType, processShiftMaster, tenkoSchedule,
 *   shiftMasterData 等）には一切依存せず、変更もしない。
 *
 * 責務分離（重要）:
 *   Excelセル文字列
 *     → parseShiftCellToBlocks()      … 記号1件を「勤務ブロック」に変換
 *     → buildDayRecord()              … 1日分のブロック集計（未定義記号の検知含む）
 *     → buildContinuousDailySeries()  … 日付の抜けを埋めた連続系列に整形
 *     → computeRolling60h()           … 7日スライド合計・超過/警戒判定（純粋関数）
 *     → computeRollingRisk()          … roster_only / actual_progress の判定
 *
 *   Excelの「行の並び・列の位置」に関する知識（月間シフト表・Amazon実績表の
 *   読み方）は parseMonthlyRosterSheetRows() / parseAmazonDailyRows() に閉じ込め、
 *   Rolling計算コア（computeRolling60h 等）はそれらの出力形式にのみ依存する。
 *   将来「C1+C3」のような複合表記が実データで確認された場合も、
 *   修正対象は parseShiftCellToBlocks() のみで済むように設計している
 *   （現時点ではそのような表記の証跡が実データに無いため実装していない。
 *   コード内にTODOとして明記する）。
 *
 * 未確定事項（推測で値を割り当てていないもの）:
 *   - C2 のブロック時間
 *   - 嘉（嘉麻応援）のブロック時間
 *   - 研修・唐津 等のブロック時間
 *   これらは SHIFT_HOUR_TABLE に存在しないため、自動的に
 *   defined:false / hours:null として検知され、Rolling合計には0として
 *   加算されるが、hasUndefinedHours / undefinedCodes で必ず可視化される。
 *   「黙って0h」にはしない。
 *
 * 「休」の扱い（確定済み）:
 *   休 は正式に「勤務なし＝0時間・defined:true」として SHIFT_HOUR_TABLE に
 *   含めている（既存 processShiftMaster が休を「シフト無し」として扱う
 *   既存コードの慣習とも整合する）。休を含む日・ウィンドウは
 *   hasUndefinedHours / undefinedCodes / 未定義勤務記号警告の対象にはならない。
 */
(function (global) {
  'use strict';

  // ===========================================================================
  // 1. Rolling専用データモデル / 勤務記号マスタ
  // ===========================================================================

  /**
   * 正式な勤務時間マスタ（Rolling専用・既存EXEC_RATE_TABLE等とは独立）。
   * キーは normalizeRollingShiftCode() が返す正規化コード。
   *
   * 確定値（ユーザー指示による正式値。高橋さんExcelのC1=5.5hは採用しない）:
   *   ○(MARU)=11.0h, ❽(HACHI)=8.0h, bike=10.0h, b1=5.0h, b2=5.0h,
   *   C1=6.5h, C3=4.5h, 休(KYU)=0h
   *   （運用上 C1→休憩1h→C3 の流れがあり、休憩1hは稼働時間に非算入。
   *    C1とC3が同日の別ブロックとして記録されれば、自動的に合計11.0hになる）
   *
   *   休(KYU)=0h は「勤務なし」を表す正式値であり、C2・嘉・研修・唐津等の
   *   「時間が未確定なため推測しない」記号とは扱いが異なる（defined:trueとなり、
   *   hasUndefinedHours / undefinedCodes / 未定義勤務記号警告の対象にはならない）。
   */
  var SHIFT_HOUR_TABLE = Object.freeze({
    MARU: 11.0,
    HACHI: 8.0,
    BIKE: 10.0,
    B1: 5.0,
    B2: 5.0,
    C1: 6.5,
    C3: 4.5,
    KYU: 0,
  });

  // 表示用ラベル（UI側で使用。正規化コード→表示文字）
  var SHIFT_CODE_DISPLAY_LABEL = Object.freeze({
    MARU: '○',
    HACHI: '❽',
    BIKE: 'bike',
    B1: 'b1',
    B2: 'b2',
    C1: 'C1',
    C3: 'C3',
    KYU: '休',
  });

  /**
   * 全角英数字を半角に変換する（既存 normalizeExecCourseType 等と同種の処理だが、
   * Rolling専用として独立実装。既存関数は呼び出さない＝既存挙動に影響しない）。
   */
  function toHalfWidthAlnum(s) {
    return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });
  }

  /**
   * 勤務記号をRolling計算用の正規化コードへ変換する。
   * ○の異体字（U+25CB, U+25EF, U+3007, 全角Ｏ, 半角O/o）は全て 'MARU' に統一する。
   * 変換できない記号は「そのままの文字列（trimのみ）」を返す
   * （＝ SHIFT_HOUR_TABLE に存在しない＝未定義として検知される）。
   */
  function normalizeRollingShiftCode(raw) {
    if (raw === null || raw === undefined) return '';
    var s = String(raw).trim();
    if (!s) return '';
    s = toHalfWidthAlnum(s);

    if (/^[○◯〇Oo]$/.test(s)) return 'MARU';
    if (s === '❽' || s === '⑧' || s === '8') return 'HACHI';
    if (s === '休') return 'KYU'; // 勤務なし=0h（確定値。未定義扱いにはしない）

    var upper = s.toUpperCase();
    if (upper === 'BIKE' || upper === 'BIKER' || s === 'バイク' || s === 'ﾊﾞｲｸ') return 'BIKE';
    if (upper === 'B1') return 'B1';
    if (upper === 'B2') return 'B2';
    if (upper === 'C1') return 'C1';
    if (upper === 'C2') return 'C2'; // 時間は未定義（SHIFT_HOUR_TABLEに存在しない＝要確認）
    if (upper === 'C3') return 'C3';

    // 嘉・研修・唐津 等は正規化せずそのまま返す（未確定のため推測しない）
    return s;
  }

  /**
   * 正規化コードからブロック時間を引く。
   * @return {{hours: number|null, defined: boolean}}
   *   defined:false の場合、hoursは必ずnull（0を代入しない＝黙って0h扱いにしない）。
   */
  function getBlockHours(normalizedCode) {
    if (Object.prototype.hasOwnProperty.call(SHIFT_HOUR_TABLE, normalizedCode)) {
      return { hours: SHIFT_HOUR_TABLE[normalizedCode], defined: true };
    }
    return { hours: null, defined: false };
  }

  // ===========================================================================
  // 2. blocksパーサ（Excelセル1件 → 勤務ブロック配列）
  // ===========================================================================

  /**
   * Excelセル1件（勤務記号文字列）を「勤務ブロック配列」に変換する。
   *
   * 現時点の実データ（高橋さんExcel GDS等シート）では、1つの日付セルには
   * 単一の勤務記号のみが入っている（"C1+C3" 等の複合表記は確認されていない）。
   * そのため現バージョンは「1セル=1ブロック」として扱う。
   *
   * TODO（拡張ポイント）: 将来「C1+C3」「C1/C3」「C1・C3」等の複合表記が
   * 実データで確認された場合は、このセル内区切り文字の判定・分割処理を
   * "ここに" 追加すること。Rolling計算コア（computeRolling60h等）や
   * 呼び出し側のデータモデルは変更不要（既に blocks は配列前提）。
   * 現時点では区切り文字の存在が未確認のため、推測での分割実装はしない。
   *
   * @param {*} cellValue 生のセル値
   * @param {'actual'|'roster'} source
   * @return {{blocks: Array, warnings: Array}}
   */
  function parseShiftCellToBlocks(cellValue, source) {
    var raw = cellValue === null || cellValue === undefined ? '' : String(cellValue).trim();
    if (!raw) return { blocks: [], warnings: [] };

    var normalized = normalizeRollingShiftCode(raw);
    var h = getBlockHours(normalized);
    var block = {
      code: normalized,
      rawCode: raw,
      source: source || 'unknown',
      hours: h.hours,
      defined: h.defined,
    };
    var warnings = [];
    if (!h.defined) {
      warnings.push({ type: 'undefined_code', code: normalized, rawCode: raw, source: source || 'unknown' });
    }
    return { blocks: [block], warnings: warnings };
  }

  /**
   * 1日分のブロック配列から日次レコードを構築する。
   * dailyTotalHours 等は blocks から算出する派生値（一次データはblocks）。
   */
  function buildDayRecord(date, blocks) {
    blocks = blocks || [];
    var dailyTotalHours = 0;
    var actualHours = 0;
    var rosterHours = 0;
    var hasUndefinedHours = false;
    var undefinedCodes = [];

    blocks.forEach(function (b) {
      if (b.defined && typeof b.hours === 'number' && !isNaN(b.hours)) {
        dailyTotalHours += b.hours;
        if (b.source === 'actual') actualHours += b.hours;
        else if (b.source === 'roster') rosterHours += b.hours;
      } else {
        hasUndefinedHours = true;
        undefinedCodes.push(b.rawCode || b.code || '(不明)');
      }
    });

    return {
      date: date,
      blocks: blocks,
      dailyTotalHours: dailyTotalHours,
      actualHours: actualHours,
      rosterHours: rosterHours,
      hasUndefinedHours: hasUndefinedHours,
      undefinedCodes: undefinedCodes,
      noData: false,
    };
  }

  // ===========================================================================
  // 3. 日付ユーティリティ
  // ===========================================================================

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatDateYMD(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /**
   * 既存 wh60ParseDate（index.html:15067）と同じ許容形式を扱う独立実装。
   * 日付文字列 / Excelシリアル値 / JS Dateオブジェクトのいずれも受け付ける。
   * 既存関数は再利用しない（Rolling機能を既存コードから独立させるため）。
   */
  function parseExcelDateFlexible(val) {
    if (val === null || val === undefined || val === '') return null;
    if (val instanceof Date && !isNaN(val.getTime())) {
      return formatDateYMD(val);
    }
    var str = String(val).trim();
    if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(str)) {
      var parts = str.split(/[-\/T\s]/);
      var y = parseInt(parts[0], 10),
        m = parseInt(parts[1], 10),
        d = parseInt(parts[2], 10);
      if (y && m && d) return formatDateYMD(new Date(y, m - 1, d));
    }
    var num = parseFloat(str);
    // 既存 wh60ParseDate と同じ許容範囲（2009年〜2064年相当）に合わせる
    if (!isNaN(num) && num > 40000 && num < 60000) {
      var dd = new Date((num - 25569) * 86400000);
      return formatDateYMD(dd);
    }
    return null;
  }

  function addDays(dateStr, n) {
    var parts = dateStr.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + n);
    return formatDateYMD(d);
  }

  function isValidDateCell(v) {
    if (v instanceof Date && !isNaN(v.getTime())) {
      return v.getFullYear() >= 2000 && v.getFullYear() <= 2100;
    }
    // 文字列/シリアル値も日付ヘッダーとして許容する
    var parsed = parseExcelDateFlexible(v);
    if (!parsed) return false;
    var y = parseInt(parsed.slice(0, 4), 10);
    return y >= 2000 && y <= 2100;
  }

  // ===========================================================================
  // 4. 連続日付系列の構築（月またぎ・欠損日対応）
  // ===========================================================================

  /**
   * driverの {date: blocks[]} マップから、startDate〜endDate（両端含む）の
   * 「抜けのない」日次レコード配列を構築する。
   * データが存在しない日は noData:true のゼロレコードとして埋める
   * （＝「実際に0hだった」のか「データが無いだけ」なのかを区別する）。
   */
  function buildContinuousDailySeries(blocksByDate, startDate, endDate) {
    var series = [];
    var cursor = startDate;
    var guard = 0;
    while (true) {
      var blocks = blocksByDate[cursor];
      if (blocks !== undefined) {
        series.push(buildDayRecord(cursor, blocks));
      } else {
        var rec = buildDayRecord(cursor, []);
        rec.noData = true;
        series.push(rec);
      }
      if (cursor === endDate) break;
      cursor = addDays(cursor, 1);
      guard++;
      if (guard > 3660) break; // 安全弁（10年分超で強制終了。無限ループ防止）
    }
    return series;
  }

  // ===========================================================================
  // 5. 実績＋予定の合成（過去=実績優先／未来=予定優先）
  // ===========================================================================

  /**
   * 過去=実績優先、未来=予定優先の合成タイムラインを構築する。
   * ブロック単位で source を保持しているため、将来的に同一日内で
   * 実績ブロック＋未確定予定ブロックが混在する構造にも自然に拡張できる
   * （本関数のロジックを変えずに、呼び出し側で日別blocksを混在させて渡せばよい）。
   *
   * @param {Object} actualBlocksByDate  {date: blocks[]}  Amazon実績由来
   * @param {Object} rosterBlocksByDate  {date: blocks[]}  OFK3シフト予定由来
   * @param {string} referenceDate       'YYYY-MM-DD'（この日を境に過去/未来を判定。当日は「未来」側=予定優先）
   * @return {Object} {date: blocks[]} マージ済み
   */
  function mergeActualAndRoster(actualBlocksByDate, rosterBlocksByDate, referenceDate) {
    var merged = {};
    var allDates = {};
    Object.keys(actualBlocksByDate || {}).forEach(function (d) {
      allDates[d] = true;
    });
    Object.keys(rosterBlocksByDate || {}).forEach(function (d) {
      allDates[d] = true;
    });

    Object.keys(allDates).forEach(function (date) {
      var hasActual = Object.prototype.hasOwnProperty.call(actualBlocksByDate || {}, date);
      var hasRoster = Object.prototype.hasOwnProperty.call(rosterBlocksByDate || {}, date);
      var isPast = date < referenceDate;

      if (isPast) {
        merged[date] = hasActual ? actualBlocksByDate[date] : hasRoster ? rosterBlocksByDate[date] : [];
      } else {
        merged[date] = hasRoster ? rosterBlocksByDate[date] : hasActual ? actualBlocksByDate[date] : [];
      }
    });
    return merged;
  }

  // ===========================================================================
  // 6. Rolling 7 Days 純粋計算関数
  // ===========================================================================

  /**
   * 連続日次系列（buildContinuousDailySeriesの出力）に対し、
   * 「任意の連続7暦日」を1日ずつスライドしながら合計・超過判定を行う。
   * 固定週（日曜始まり等）の概念は一切使わない。
   *
   * 6連勤/7連勤を独自に違反扱いするロジックは実装していない
   * （over/warningはあくまで合計稼働時間のみで判定する）。
   *
   * @param {Array} series buildContinuousDailySeries() の出力
   * @param {Object} [options]
   * @param {number} [options.limitHours=60.0]   正式な超過しきい値（これを超えたら超過。ちょうどは超過ではない）
   * @param {number} [options.warningHours]       警戒ライン（既定=limitHoursと同値＝実質無効。59.0等を指定すると
   *                                               「超過ではないが警戒ライン以上」を検知できる）
   * @param {Object} [options.overrides]          { 'YYYY-MM-DD': blocks[] | string } 非破壊の一時上書き（シミュレーション用）
   * @return {Array} 各7日間ウィンドウの判定結果
   */
  function computeRolling60h(series, options) {
    options = options || {};
    var limitHours = options.limitHours != null ? options.limitHours : 60.0;
    var warningHours = options.warningHours != null ? options.warningHours : limitHours;
    var overrides = options.overrides || {};

    var effective = series.map(function (day) {
      if (!Object.prototype.hasOwnProperty.call(overrides, day.date)) return day;
      var overrideVal = overrides[day.date];
      var blocks;
      if (typeof overrideVal === 'string') {
        // シュガー: 単一勤務記号文字列を渡した場合は roster ブロックとして扱う
        blocks = parseShiftCellToBlocks(overrideVal, 'roster').blocks;
      } else if (Array.isArray(overrideVal)) {
        blocks = overrideVal;
      } else {
        blocks = [];
      }
      return buildDayRecord(day.date, blocks);
    });

    var results = [];
    for (var i = 0; i + 6 < effective.length; i++) {
      var windowDays = effective.slice(i, i + 7);
      var total = 0,
        actualHours = 0,
        rosterHours = 0;
      var undefinedDates = [];
      var noDataDates = [];
      windowDays.forEach(function (d) {
        total += d.dailyTotalHours;
        actualHours += d.actualHours;
        rosterHours += d.rosterHours;
        if (d.hasUndefinedHours) undefinedDates.push(d.date);
        if (d.noData) noDataDates.push(d.date);
      });
      var over = total > limitHours;
      var warning = !over && total >= warningHours;
      results.push({
        startDate: windowDays[0].date,
        endDate: windowDays[6].date,
        totalHours: total,
        actualHours: actualHours,
        rosterHours: rosterHours,
        limitHours: limitHours,
        warningHours: warningHours,
        over: over,
        overBy: over ? total - limitHours : 0,
        warning: warning,
        undefinedDates: undefinedDates,
        noDataDates: noDataDates,
        hasUndefinedHours: undefinedDates.length > 0,
      });
    }
    return results;
  }

  /**
   * roster_only / actual_progress の2種のリスクを判別するため、
   * 「全期間を予定値のみで計算した仮想Rolling」と
   * 「実績＋予定を合成したRolling」の両方を計算し比較する。
   *
   * rosterOnlySeries と blendedSeries は同じ日付範囲・同じ長さの
   * 連続系列であることを前提とする（呼び出し側で揃えること）。
   *
   * @return {Array} blended側の結果に riskType 等を付加した配列
   *   riskType: null | 'roster_only' | 'actual_progress'
   *     roster_only     … 予定だけで計算しても超過していた（①）
   *     actual_progress … 予定だけなら60h以内だったが、実績反映後は超過（②）
   */
  function computeRollingRisk(rosterOnlySeries, blendedSeries, options) {
    var rosterOnlyResults = computeRolling60h(rosterOnlySeries, options);
    var blendedResults = computeRolling60h(blendedSeries, options);

    return blendedResults.map(function (blended, idx) {
      var rosterOnly = rosterOnlyResults[idx];
      var riskType = null;
      if (blended.over) {
        riskType = rosterOnly && rosterOnly.over ? 'roster_only' : 'actual_progress';
      }
      var out = {};
      for (var k in blended) out[k] = blended[k];
      out.riskType = riskType;
      out.rosterOnlyTotalHours = rosterOnly ? rosterOnly.totalHours : null;
      out.rosterOnlyOver = rosterOnly ? rosterOnly.over : null;
      return out;
    });
  }

  // ===========================================================================
  // 7. 行レベルパーサ（Excel由来の2次元配列 rows: XLSX.utils.sheet_to_json(ws,{header:1}) 相当）
  //    ※ここに書くのは「rows配列からrecordsへの変換」のみ。ファイル読込(FileReader)・
  //      XLSX.read呼び出し・DOM描画はUI層（rolling60h-ui.js）の責務。
  // ===========================================================================

  /**
   * Amazon Daily Working Hour（Report5_Daily_Data / 貼付 シート相当）の
   * rows配列を実績レコード配列へ変換する。
   * 既存 wh60LoadWHFile（index.html:14962〜）と同じ列定義を踏襲するが、
   * 「今週分のみ」フィルタは行わない（Rolling用に全期間保持するため）。
   * 既存関数・既存グローバル変数（wh60Data等）は一切参照/変更しない。
   */
  function parseAmazonDailyRows(rows, options) {
    options = options || {};
    // 既定は既存WH60と同じ station_code === 'OFK3' 絞り込み。
    // null/'' を渡すと絞り込みなし（要確認事項：対象DSP範囲は§13未確定）。
    var stationFilter = options.stationFilter === undefined ? 'OFK3' : options.stationFilter;

    if (!rows || rows.length < 2) {
      return { records: [], warnings: [{ type: 'empty_sheet' }] };
    }

    var hdr = rows[0];
    var col = { tid: -1, day: -1, hour: -1, dsp: -1, station: -1, start: -1, end: -1 };
    for (var c = 0; c < hdr.length; c++) {
      var h = String(hdr[c] || '').toLowerCase().trim();
      if (h === 'transporter_id' || h === 'トランスポーターid') col.tid = c;
      else if (h === 'working_day' || h === '稼働日') col.day = c;
      else if (h === 'estimated_working_hour' || h === '稼働時間') col.hour = c;
      else if (h === 'dsp') col.dsp = c;
      else if (h === 'station_code' || h === 'ステーションコード') col.station = c;
      else if (h === 'estimated_start_time' || h === '開始時刻') col.start = c;
      else if (h === 'estimated_end_time' || h === '終了時刻') col.end = c;
    }
    // 「貼付」シート等、ヘッダー名が無い/一致しない場合のフォールバック
    // （既存 wh60LoadWHFile と同一の列位置想定: J=transporter_id, F=working_day, O=hours, I=dsp, G=station）
    if (col.tid === -1) {
      col.tid = 9;
      col.day = 5;
      col.hour = 14;
      col.dsp = 8;
      col.start = 12;
      col.end = 13;
      col.station = 6;
    }
    if (col.tid === -1 || col.day === -1 || col.hour === -1) {
      return { records: [], warnings: [{ type: 'missing_columns', detail: col }] };
    }

    var records = [];
    var warnings = [];
    var seen = {}; // 重複行の検知用（同一tid+date+hour+startの完全一致行は多重集計の疑いを警告）

    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row) continue;
      var tid = String(row[col.tid] || '').trim();
      if (!tid) continue;
      var dateStr = parseExcelDateFlexible(row[col.day]);
      if (!dateStr) {
        warnings.push({ type: 'unparseable_date', rowIndex: r, raw: row[col.day] });
        continue;
      }
      var station = col.station >= 0 ? String(row[col.station] || '').trim().toUpperCase() : '';
      if (stationFilter && station && station !== stationFilter) continue;

      var hours = parseFloat(row[col.hour]);
      if (isNaN(hours)) hours = 0;

      records.push({
        transportId: tid,
        date: dateStr,
        dsp: col.dsp >= 0 ? String(row[col.dsp] || '').trim() : '',
        hours: hours,
        startTime: col.start >= 0 ? row[col.start] : null,
        endTime: col.end >= 0 ? row[col.end] : null,
      });
    }
    return { records: records, warnings: warnings };
  }

  /**
   * 月間シフト表（高橋さんExcelの「メイン」または各DSPシート等）の rows配列を
   * ロースターレコード配列へ変換する。
   *
   * 既存 processShiftMaster（index.html:9339〜）とは別の新規実装であり、
   * 「本日列だけ」ではなく「日付ヘッダーとして認識できる列を全て」読み取る。
   * 既存 processShiftMaster / shiftMasterData には一切手を入れない。
   *
   * 列位置をハードコードせず、ヘッダー文字列・セル型から動的に検出する
   * （高橋さんExcelは月によって列位置がずれる構造のため）。
   *   - 日付ヘッダー行: Dateセル（またはExcel日付形式）が最も多い行を採用
   *   - 氏名列: ヘッダーに「名前」/"Name" を含む列（無ければ既定でB列=index1）
   *   - 会社列: ヘッダーに「社名」/"Affiliation" を含む列（無ければ既定でA列=index0）
   *   - Transport ID列: ヘッダーに "Transport ID" を含む列（見つからなければ
   *     警告を出し、氏名のみで扱う＝§13未確認事項「メインシートのID位置」に対応）
   *   - 同一日付が複数列に重複する場合（高橋さんExcelは「時間計算列」と
   *     「生の記号入力列」が同じ日付見出しで2系統存在する）、サンプル値が
   *     数値でない列（＝記号が入っている列）を優先的に採用する。
   */
  function parseMonthlyRosterSheetRows(rows, options) {
    options = options || {};
    var maxHeaderScanRows = Math.min(rows ? rows.length : 0, 6);
    var warnings = [];

    if (!rows || rows.length === 0) {
      return { records: [], warnings: [{ type: 'empty_sheet' }], meta: {} };
    }

    // 1) 日付ヘッダー行の自動検出
    var headerRowIdx = -1;
    var bestCount = 0;
    for (var r = 0; r < maxHeaderScanRows; r++) {
      var row = rows[r] || [];
      var count = 0;
      for (var c = 0; c < row.length; c++) {
        if (isValidDateCell(row[c])) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        headerRowIdx = r;
      }
    }
    if (headerRowIdx === -1 || bestCount === 0) {
      return { records: [], warnings: [{ type: 'no_date_header_row_found' }], meta: {} };
    }
    var headerRow = rows[headerRowIdx];

    // 2) 氏名/会社/TransportID列の検出（ヘッダー行以前の行も走査：高橋さんExcelは
    //    「社名」「名前」等のラベルが日付ヘッダー行と同じ行にあるため）
    var nameCol = -1,
      companyCol = -1,
      tidCol = -1;
    for (var hr = 0; hr <= headerRowIdx; hr++) {
      var hrow = rows[hr] || [];
      for (var cc = 0; cc < hrow.length; cc++) {
        var label = String(hrow[cc] || '').replace(/[\s　]/g, '');
        if (nameCol === -1 && (label === '名前' || /^name$/i.test(label))) nameCol = cc;
        if (companyCol === -1 && (label === '社名' || /^affiliation$/i.test(label))) companyCol = cc;
        if (tidCol === -1 && /transportid/i.test(label)) tidCol = cc;
      }
    }
    if (nameCol === -1) {
      nameCol = 1; // フォールバック（高橋さんExcelの多くのDSPシートはB列=名前）
      warnings.push({ type: 'name_column_fallback_used', col: nameCol });
    }
    if (companyCol === -1) {
      companyCol = 0; // フォールバック（A列=社名）
    }
    if (tidCol === -1) {
      warnings.push({ type: 'transport_id_column_not_found' });
    }

    // 3) 日付列のグルーピング（同一日付が複数列に存在し得る）
    var dataStartRow = headerRowIdx + 1;
    var dateGroups = {}; // 'YYYY-MM-DD' -> [colIndex,...]
    for (var c2 = 0; c2 < headerRow.length; c2++) {
      if (isValidDateCell(headerRow[c2])) {
        var key = parseExcelDateFlexible(headerRow[c2]);
        if (!key) continue;
        (dateGroups[key] = dateGroups[key] || []).push(c2);
      }
    }

    // 4) 重複日付列から「記号が入っている列」を選ぶ（サンプリングで非数値率が高い方を採用）
    var sampleRows = rows.slice(dataStartRow, Math.min(rows.length, dataStartRow + 30));
    var codeColByDate = {};
    Object.keys(dateGroups).forEach(function (dateKey) {
      var cols = dateGroups[dateKey];
      if (cols.length === 1) {
        codeColByDate[dateKey] = cols[0];
        return;
      }
      var best = cols[0];
      var bestScore = -1;
      cols.forEach(function (col) {
        var stringish = 0,
          total = 0;
        sampleRows.forEach(function (row) {
          var v = row ? row[col] : undefined;
          if (v === undefined || v === null || v === '') return;
          total++;
          if (typeof v !== 'number') stringish++;
        });
        var score = total > 0 ? stringish / total : -1;
        if (score > bestScore) {
          bestScore = score;
          best = col;
        }
      });
      codeColByDate[dateKey] = best;
      warnings.push({ type: 'duplicate_date_column_resolved', date: dateKey, chosenCol: best, candidateCols: cols });
    });

    // 5) データ行を走査してレコード化
    var records = [];
    for (var r3 = dataStartRow; r3 < rows.length; r3++) {
      var drow = rows[r3];
      if (!drow) continue;
      var name = String(drow[nameCol] || '').trim();
      if (!name) continue;
      if (typeof options.isNonDriverRow === 'function' && options.isNonDriverRow(name)) continue;

      var company = companyCol >= 0 ? String(drow[companyCol] || '').trim() : '';
      var transportId = tidCol >= 0 ? String(drow[tidCol] || '').trim() : '';

      Object.keys(codeColByDate).forEach(function (dateKey) {
        var col = codeColByDate[dateKey];
        var cellVal = drow[col];
        if (cellVal === undefined || cellVal === null || cellVal === '') return;
        records.push({
          name: name,
          company: company,
          transportId: transportId,
          date: dateKey,
          rawCode: cellVal,
        });
      });
    }

    return {
      records: records,
      warnings: warnings,
      meta: {
        headerRowIdx: headerRowIdx,
        nameCol: nameCol,
        companyCol: companyCol,
        tidCol: tidCol,
        dateCount: Object.keys(dateGroups).length,
      },
    };
  }

  // ===========================================================================
  // 8. 統合ヘルパー（roster/actual raw records → driverごとの blocksByDate）
  // ===========================================================================

  /**
   * parseMonthlyRosterSheetRows() の records（1行=1日1記号）を
   * driverKey別・日付別の blocks[] へグルーピングする。
   * driverKeyは Transport ID優先、無ければ氏名（'NAME:'プレフィックス）。
   */
  function groupRosterRecordsByDriver(rosterRecords) {
    var byDriver = {}; // driverKey -> { meta, blocksByDate }
    (rosterRecords || []).forEach(function (rec) {
      var key = rec.transportId ? rec.transportId : 'NAME:' + rec.name;
      if (!byDriver[key]) {
        byDriver[key] = {
          meta: { name: rec.name, company: rec.company, transportId: rec.transportId || '' },
          blocksByDate: {},
        };
      }
      var parsed = parseShiftCellToBlocks(rec.rawCode, 'roster');
      var d = byDriver[key].blocksByDate;
      d[rec.date] = (d[rec.date] || []).concat(parsed.blocks);
    });
    return byDriver;
  }

  /**
   * parseAmazonDailyRows() の records（1行=1稼働）を
   * transportId別・日付別の blocks[] へグルーピングする。
   * 同一Transport ID・同一日に複数行ある場合は「複数ブロック」として加算する
   * （上書きしない＝§13テストケース「同一Transport ID・同一日の複数実績行」対応）。
   */
  function groupActualRecordsByTransportId(actualRecords) {
    var byTid = {};
    (actualRecords || []).forEach(function (rec) {
      if (!rec.transportId) return;
      if (!byTid[rec.transportId]) byTid[rec.transportId] = {};
      var d = byTid[rec.transportId];
      d[rec.date] = d[rec.date] || [];
      d[rec.date].push({
        code: 'AMAZON_ACTUAL',
        rawCode: '(Amazon実績)',
        source: 'actual',
        hours: rec.hours,
        defined: true,
      });
    });
    return byTid;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  var RollingCore = {
    // 定数
    SHIFT_HOUR_TABLE: SHIFT_HOUR_TABLE,
    SHIFT_CODE_DISPLAY_LABEL: SHIFT_CODE_DISPLAY_LABEL,

    // 記号正規化・時間変換
    normalizeRollingShiftCode: normalizeRollingShiftCode,
    getBlockHours: getBlockHours,

    // パーサ
    parseShiftCellToBlocks: parseShiftCellToBlocks,
    buildDayRecord: buildDayRecord,

    // 日付ユーティリティ
    formatDateYMD: formatDateYMD,
    parseExcelDateFlexible: parseExcelDateFlexible,
    addDays: addDays,
    isValidDateCell: isValidDateCell,

    // 系列構築・合成
    buildContinuousDailySeries: buildContinuousDailySeries,
    mergeActualAndRoster: mergeActualAndRoster,

    // Rolling計算コア
    computeRolling60h: computeRolling60h,
    computeRollingRisk: computeRollingRisk,

    // 行レベルパーサ
    parseAmazonDailyRows: parseAmazonDailyRows,
    parseMonthlyRosterSheetRows: parseMonthlyRosterSheetRows,

    // 統合ヘルパー
    groupRosterRecordsByDriver: groupRosterRecordsByDriver,
    groupActualRecordsByTransportId: groupActualRecordsByTransportId,
  };

  global.RollingCore = RollingCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RollingCore;
  }
})(typeof window !== 'undefined' ? window : global);
