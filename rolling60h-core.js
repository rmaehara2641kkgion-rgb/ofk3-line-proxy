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
 *   defined:false / hours:null として検知される。その日を含む7日窓は
 *   judgment:'undetermined'（判定不能）になり、超過・接近にはしない。
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
    var hasUnconfirmed = false;

    blocks.forEach(function (b) {
      if (b.conflict) {
        // 複数シート間で勤務記号が衝突し、時間が一意に決まらない日。時間は加算せず未確定扱い
        // （確定分だけで60hを超える場合は既存の knownOver で危険情報を残す）。
        hasUnconfirmed = true;
      } else if (b.blank) {
        // 勤務記号が混在する日付列の空白セル。休(0h)とは断定せず、時間は加算しない。
        hasUnconfirmed = true;
      } else if (b.defined && typeof b.hours === 'number' && !isNaN(b.hours)) {
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
      hasUnconfirmed: hasUnconfirmed,
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

  // ---------------------------------------------------------------------------
  // 月またぎ安全化ヘルパー（parseMonthlyRosterSheetRows の opt-in オプション用）
  // ---------------------------------------------------------------------------

  /** 0始まり列番号 → Excel列記号（0→A, 40→AO） */
  function columnLetter(col) {
    var n = col + 1;
    var s = '';
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  var JP_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  function weekdayOfYMD(ymd) {
    var p = ymd.split('-').map(Number);
    return JP_WEEKDAYS[new Date(p[0], p[1] - 1, p[2]).getDay()];
  }

  /**
   * 見出しセルが「日番号だけの定数」（31 / "31" / "31日" / cellDates で 1900-01-xx になった値）なら
   * その日番号(1〜31)を返す。それ以外は null。
   */
  function dayNumberFromHeaderCell(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = null;
    if (v instanceof Date && !isNaN(v.getTime())) {
      var y = v.getFullYear();
      if (y !== 1899 && y !== 1900) return null;
      // シリアル値に戻す（SheetJS の 1900年系: 1899-12-30 起点）
      var serial = Math.round((Date.UTC(y, v.getMonth(), v.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
      n = serial;
    } else if (typeof v === 'number') {
      n = v;
    } else {
      var m = String(v).trim().match(/^(\d{1,2})日?$/);
      if (m) n = parseInt(m[1], 10);
    }
    if (n === null || !isFinite(n) || Math.floor(n) !== n || n < 1 || n > 31) return null;
    return n;
  }

  /**
   * 定数日番号の見出しを日付として復元できるか判定する。すべて一致した時だけ復元する:
   *   ① 前列が有効な日付 prevDate
   *   ② prevDate+1日 の「日」が見出しの日番号と一致
   *   ③ prevDate と同じ年月（月の連続性。11/30 の次の「31」等は不一致で復元しない）
   *   ④ 見出し直下の曜日行で、前列が prevDate の曜日・当列が復元日付の曜日と一致
   */
  function restoreDayNumberHeader(headerCell, prevDate, weekdayRow, col) {
    var dayNumber = dayNumberFromHeaderCell(headerCell);
    if (dayNumber === null || !prevDate) return null;
    var next = addDays(prevDate, 1);
    if (parseInt(next.slice(8, 10), 10) !== dayNumber) return null;
    if (next.slice(0, 7) !== prevDate.slice(0, 7)) return null;
    if (!weekdayRow) return null;
    var wdPrev = String(weekdayRow[col - 1] == null ? '' : weekdayRow[col - 1]).trim();
    var wdCur = String(weekdayRow[col] == null ? '' : weekdayRow[col]).trim();
    if (wdPrev !== weekdayOfYMD(prevDate) || wdCur !== weekdayOfYMD(next)) return null;
    return { date: next, dayNumber: dayNumber, weekday: wdCur };
  }

  /**
   * シートの対象月（日付列が最も多い YYYY-MM。同数首位が複数なら判定しない）以外の日付列のうち、
   * ドライバー行が全員空白の列を返す。
   */
  function findLeadInBlankDateKeys(rows, dataStartRow, nameCol, codeColByDate, isNonDriverRow) {
    var monthCount = {};
    Object.keys(codeColByDate).forEach(function (k) {
      var ym = k.slice(0, 7);
      monthCount[ym] = (monthCount[ym] || 0) + 1;
    });
    var targetMonth = null;
    var best = 0;
    var tie = false;
    Object.keys(monthCount).forEach(function (ym) {
      if (monthCount[ym] > best) { best = monthCount[ym]; targetMonth = ym; tie = false; }
      else if (monthCount[ym] === best) tie = true;
    });
    if (!targetMonth || tie) return { targetMonth: null, excluded: [] };

    var driverRows = [];
    for (var r = dataStartRow; r < rows.length; r++) {
      var row = rows[r];
      if (!row) continue;
      var name = String(row[nameCol] || '').trim();
      if (!name) continue;
      if (typeof isNonDriverRow === 'function' && isNonDriverRow(name)) continue;
      driverRows.push(row);
    }
    if (driverRows.length === 0) return { targetMonth: targetMonth, excluded: [] };

    var excluded = Object.keys(codeColByDate).filter(function (k) {
      if (k.slice(0, 7) === targetMonth) return false;
      var col = codeColByDate[k];
      return driverRows.every(function (row) {
        var v = row[col];
        return v === undefined || v === null || String(v).trim() === '';
      });
    }).sort();
    return { targetMonth: targetMonth, excluded: excluded };
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

  function isBlankPlaceholder(blocks) {
    return !!blocks && blocks.length > 0 && blocks.every(function (b) { return b && b.blank; });
  }

  function hasValidHours(blocks) {
    return !!blocks && blocks.length > 0 && blocks.every(function (b) {
      return b && !b.blank && b.defined !== false && typeof b.hours === 'number' && !isNaN(b.hours);
    });
  }

  /**
   * 空白セルの意味を日付列単位で決める（HARVEST一括実行用。UIの読込経路は変えない）。
   *   - 「休」は明示的な0h（ここでは触らない）。
   *   - 勤務記号が1人でも入っている日付列の空白 → 未入力・未確定（blank ブロック。0hにしない）。
   *   - 全員が空白の日付列 → シフト表の有効期間外候補（その日のレコード自体を作らない）。
   *     過去デイリー側の記録は別マップなので、ここでは除外されない。
   *
   * @param {Object} rosterByTid  { tid: { date: blocks[] } }（空白は blocks=[]）
   * @param {Object} [options]
   * @param {Object} [options.extraSymbolDates] { date: true } 突合できない行など、記号が入っている日付の追加証拠
   * @return {{byTid:Object, outsideDates:Array, mixedDates:Array, unconfirmedPersonDays:number, outsidePersonDays:number}}
   */
  function resolveRosterBlanks(rosterByTid, options) {
    options = options || {};
    var symbolDates = {};
    var seenDates = {};
    Object.keys(options.extraSymbolDates || {}).forEach(function (d) { symbolDates[d] = true; seenDates[d] = true; });
    Object.keys(rosterByTid || {}).forEach(function (tid) {
      var byDate = rosterByTid[tid] || {};
      Object.keys(byDate).forEach(function (date) {
        seenDates[date] = true;
        if ((byDate[date] || []).length > 0) symbolDates[date] = true;
      });
    });
    var outsideDates = [];
    var mixedDates = [];
    Object.keys(seenDates).sort().forEach(function (date) {
      if (symbolDates[date]) mixedDates.push(date);
      else outsideDates.push(date);
    });
    var outsideSet = {};
    outsideDates.forEach(function (d) { outsideSet[d] = true; });
    var unconfirmedPersonDays = 0;
    var outsidePersonDays = 0;
    var out = {};
    Object.keys(rosterByTid || {}).forEach(function (tid) {
      var byDate = rosterByTid[tid] || {};
      var next = {};
      Object.keys(byDate).forEach(function (date) {
        var blocks = byDate[date] || [];
        if (blocks.length > 0) {
          next[date] = blocks;
        } else if (outsideSet[date]) {
          outsidePersonDays++;
        } else {
          unconfirmedPersonDays++;
          next[date] = [{ code: 'BLANK', rawCode: '', source: 'roster', hours: null, defined: false, blank: true }];
        }
      });
      out[tid] = next;
    });
    return {
      byTid: out,
      outsideDates: outsideDates,
      mixedDates: mixedDates,
      unconfirmedPersonDays: unconfirmedPersonDays,
      outsidePersonDays: outsidePersonDays,
    };
  }

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

      // シフトが未確定の空白なら、有効な時間を持つデイリー実績を日付に関わらず優先する。
      if (hasActual && hasRoster && isBlankPlaceholder(rosterBlocksByDate[date]) && hasValidHours(actualBlocksByDate[date])) {
        merged[date] = actualBlocksByDate[date];
        return;
      }

      if (isPast) {
        merged[date] = hasActual ? actualBlocksByDate[date] : hasRoster ? rosterBlocksByDate[date] : [];
      } else {
        merged[date] = hasRoster ? rosterBlocksByDate[date] : hasActual ? actualBlocksByDate[date] : [];
      }
    });
    return merged;
  }

  /**
   * 複数の月間シフト読込結果（例: 8月分ファイル＋9月分ファイル、または同一
   * ワークブック内の複数DSPシート）を、1ドライバー分の {date: blocks[]} へ
   * 日付単位でマージする。
   *
   * 「最大2か月分」等、複数ソースを読み込む場合の入力タイムライン生成専用の
   * 関数であり、computeRolling60h() 自体は一切変更していない
   * （parseMonthlyRosterSheetRows() が空白セルも「範囲内」の空レコード
   * （blocks=[]）として返すため、日付が存在しない＝そのソースの
   * 読み込み範囲外、と一意に判定できる。空白の意味は0hではなく
   * resolveRosterBlanks() が決める。これにより buildContinuousDailySeries()
   * の既存ロジックだけで「隣接月データが無い日を推測で0h扱いにしない」を実現する）。
   *
   * 重複日付（同一ドライバー・同一日付が複数ソースに存在する場合）は
   * 黙って合算せず、後から渡されたソース（sources配列の後方＝より新しく
   * 読み込まれたもの）を採用し、duplicates配列にどちらを採用/破棄したかを記録する。
   *
   * @param {Array<{label:string, blocksByDate:Object}>} sources 読み込み順（古い→新しい）
   * @return {{merged:Object, duplicates:Array}}
   */
  function mergeRosterBlocksByDateAcrossSources(sources) {
    var merged = {};
    var sourceLabelByDate = {};
    var duplicates = [];

    (sources || []).forEach(function (src) {
      var blocksByDate = src.blocksByDate || {};
      Object.keys(blocksByDate).forEach(function (date) {
        if (Object.prototype.hasOwnProperty.call(merged, date)) {
          var prevBlocks = merged[date];
          var newBlocks = blocksByDate[date];
          var prevRaw = prevBlocks.map(function (b) { return b.rawCode; }).join('+') || '(空)';
          var newRaw = newBlocks.map(function (b) { return b.rawCode; }).join('+') || '(空)';
          duplicates.push({
            date: date,
            keptLabel: src.label,
            keptRawCode: newRaw,
            discardedLabel: sourceLabelByDate[date],
            discardedRawCode: prevRaw,
            valuesDiffer: prevRaw !== newRaw,
          });
        }
        merged[date] = blocksByDate[date];
        sourceLabelByDate[date] = src.label;
      });
    });

    return { merged: merged, duplicates: duplicates };
  }

  function blocksSignature(blocks) {
    return (blocks || []).map(function (b) { return b.code; }).join('+');
  }

  function blocksDefinedHours(blocks) {
    var total = 0;
    for (var i = 0; i < (blocks || []).length; i++) {
      var b = blocks[i];
      if (!b || b.blank || b.conflict || b.defined === false || typeof b.hours !== 'number' || isNaN(b.hours)) return null;
      total += b.hours;
    }
    return total;
  }

  /**
   * mergeRosterBlocksByDateAcrossSources() の「読込順に依存しない」版（月またぎ安全化。既存関数は変更しない）。
   * 同一ドライバー・同一日付が複数ソースにある場合:
   *   - 空白 vs 勤務記号（休を含む）… 記号を採用（blankOverrides に記録）
   *   - 同じ記号同士 / 空白同士      … 重複件数のみ記録（duplicates）
   *   - 休 vs 勤務記号・異なる記号同士 … conflicts に記録。全候補の時間が確定かつ同一ならその時間を採用、
   *                                      そうでなければ conflict ブロック（時間未確定＝判定不能。knownOver は維持）
   * ソースは label 順に並べ替えてから処理するため、読込順で結果は変わらない。
   *
   * @param {Array<{label:string, blocksByDate:Object, cellsByDate?:Object}>} sources
   * @return {{merged:Object, duplicates:Array, blankOverrides:Array, conflicts:Array}}
   */
  function mergeRosterBlocksByDateAcrossSourcesStrict(sources) {
    var byDate = {};
    (sources || []).slice().sort(function (a, b) {
      return String(a.label) < String(b.label) ? -1 : String(a.label) > String(b.label) ? 1 : 0;
    }).forEach(function (src) {
      var blocksByDate = src.blocksByDate || {};
      var cellsByDate = src.cellsByDate || {};
      Object.keys(blocksByDate).forEach(function (date) {
        (byDate[date] = byDate[date] || []).push({
          label: src.label,
          cell: cellsByDate[date] || '',
          blocks: blocksByDate[date] || [],
          sig: blocksSignature(blocksByDate[date]),
        });
      });
    });

    var merged = {};
    var duplicates = [];
    var blankOverrides = [];
    var conflicts = [];
    function describe(e) {
      return {
        label: e.label,
        cell: e.cell,
        rawCode: e.blocks.map(function (b) { return b.rawCode; }).join('+') || '(空)',
        hours: blocksDefinedHours(e.blocks),
      };
    }

    Object.keys(byDate).sort().forEach(function (date) {
      var entries = byDate[date];
      if (entries.length === 1) {
        merged[date] = entries[0].blocks;
        return;
      }
      var nonBlank = entries.filter(function (e) { return e.sig !== ''; });
      var blank = entries.filter(function (e) { return e.sig === ''; });
      if (nonBlank.length === 0) {
        merged[date] = [];
        duplicates.push({ date: date, kind: 'same', count: entries.length, sources: entries.map(describe) });
        return;
      }
      if (blank.length > 0) {
        blankOverrides.push({ date: date, kept: nonBlank.map(describe), ignoredBlank: blank.map(describe) });
      }
      var bySig = {};
      nonBlank.forEach(function (e) { (bySig[e.sig] = bySig[e.sig] || []).push(e); });
      var sigs = Object.keys(bySig).sort();
      if (sigs.length === 1) {
        merged[date] = bySig[sigs[0]][0].blocks;
        if (nonBlank.length > 1) duplicates.push({ date: date, kind: 'same', count: nonBlank.length, sources: nonBlank.map(describe) });
        return;
      }
      var candidates = sigs.map(function (sg) { return bySig[sg][0]; });
      var hoursList = candidates.map(function (e) { return blocksDefinedHours(e.blocks); });
      var uniqueHours = hoursList.every(function (h) { return h !== null && h === hoursList[0]; });
      var conflictRec = {
        date: date,
        sources: nonBlank.map(describe),
        resolution: uniqueHours ? 'same_hours' : 'undetermined',
        resolvedHours: uniqueHours ? hoursList[0] : null,
      };
      conflicts.push(conflictRec);
      if (uniqueHours) {
        merged[date] = candidates[0].blocks; // 時間は全候補で同一（記号表記のみ異なる）
      } else {
        merged[date] = [{
          code: 'CONFLICT',
          rawCode: candidates.map(function (e) { return e.blocks.map(function (b) { return b.rawCode; }).join('+'); }).join(' / '),
          source: 'roster',
          hours: null,
          defined: false,
          conflict: true,
          candidates: conflictRec.sources,
        }];
      }
    });
    return { merged: merged, duplicates: duplicates, blankOverrides: blankOverrides, conflicts: conflicts };
  }

  /**
   * 月間シフト表（最大2ファイル×複数シート）→ ドライバー別 {date: blocks[]} の構築
   * （rolling60h-ui.js の読込経路を共通化したもの。月またぎ安全化オプションを有効にして解析し、
   *  読込順非依存の Strict マージを行う）。
   *
   * @param {Array<{label:string, sheetsData:Object}>} rosterSources  sheetsData: { sheetName: rows }
   * @param {Object} [options] { isNonDriverRow }
   * @return {{driverMeta:Object, rosterBlocksByDriver:Object, warnings:Array, sourceRanges:Object,
   *           duplicates:Array, blankOverrides:Array, conflicts:Array}}
   */
  function buildRosterTimelineFromSources(rosterSources, options) {
    options = options || {};
    var driverMeta = {};
    var metaLabel = {}; // key -> 採用した meta のソースlabel（label順で決めるため読込順に依存しない）
    var contributions = {};
    var warnings = [];
    var sourceRanges = {};
    (rosterSources || []).forEach(function (source) {
      var sourceRange = null;
      Object.keys(source.sheetsData || {}).forEach(function (sheetName) {
        var parsed = parseMonthlyRosterSheetRows(source.sheetsData[sheetName], {
          isNonDriverRow: options.isNonDriverRow || null,
          excludeLeadInBlankColumns: true,
          restoreDayNumberHeaders: true,
          trackCells: true,
        });
        warnings = warnings.concat(parsed.warnings.map(function (w) {
          return Object.assign({ file: source.label, sheet: sheetName }, w);
        }));
        if (parsed.meta && parsed.meta.dateRange) {
          if (!sourceRange) sourceRange = { min: parsed.meta.dateRange.min, max: parsed.meta.dateRange.max };
          else {
            if (parsed.meta.dateRange.min < sourceRange.min) sourceRange.min = parsed.meta.dateRange.min;
            if (parsed.meta.dateRange.max > sourceRange.max) sourceRange.max = parsed.meta.dateRange.max;
          }
        }
        var grouped = groupRosterRecordsByDriver(parsed.records);
        Object.keys(grouped).forEach(function (key) {
          var lbl = source.label + '::' + sheetName;
          if (!driverMeta[key] || lbl > metaLabel[key]) {
            driverMeta[key] = grouped[key].meta;
            metaLabel[key] = lbl;
          }
          (contributions[key] = contributions[key] || []).push({
            label: source.label + '::' + sheetName,
            blocksByDate: grouped[key].blocksByDate,
            cellsByDate: grouped[key].cellsByDate || {},
          });
        });
      });
      if (sourceRange) sourceRanges[source.label] = sourceRange;
    });

    var rosterBlocksByDriver = {};
    var duplicates = [];
    var blankOverrides = [];
    var conflicts = [];
    var sortedMeta = {};
    Object.keys(driverMeta).sort().forEach(function (key) { sortedMeta[key] = driverMeta[key]; });
    driverMeta = sortedMeta;
    Object.keys(contributions).sort().forEach(function (key) {
      var m = mergeRosterBlocksByDateAcrossSourcesStrict(contributions[key]);
      rosterBlocksByDriver[key] = m.merged;
      var tag = { driverKey: key, driverName: (driverMeta[key] || {}).name || key };
      m.duplicates.forEach(function (d) { duplicates.push(Object.assign({}, tag, d)); });
      m.blankOverrides.forEach(function (d) { blankOverrides.push(Object.assign({}, tag, d)); });
      m.conflicts.forEach(function (d) { conflicts.push(Object.assign({}, tag, d)); });
    });
    return {
      driverMeta: driverMeta,
      rosterBlocksByDriver: rosterBlocksByDriver,
      warnings: warnings,
      sourceRanges: sourceRanges,
      duplicates: duplicates,
      blankOverrides: blankOverrides,
      conflicts: conflicts,
    };
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
      var unconfirmedDates = [];
      windowDays.forEach(function (d) {
        total += d.dailyTotalHours;
        actualHours += d.actualHours;
        rosterHours += d.rosterHours;
        if (d.hasUndefinedHours) undefinedDates.push(d.date);
        if (d.hasUnconfirmed) unconfirmedDates.push(d.date);
        if (d.noData) noDataDates.push(d.date);
      });
      // complete=false（このウィンドウ内に noData 日を含む＝隣接月データ未読込等で
      // 7日分が揃っていない）の場合、over/warningは「完全なRolling判定」としては
      // 扱わない（隣接月データが無い日を推測で0h扱いにして安全側判定を出さないため）。
      // totalHours等は参考値として「取得できている日数分の合計」をそのまま返す。
      var complete = noDataDates.length === 0;
      var rawOver = total > limitHours;
      var rawWarning = !rawOver && total >= warningHours;
      var hasUndefinedHours = undefinedDates.length > 0;
      // 7日が揃わない、または未確定記号を含む窓は判定不能。
      // 既知分の合計は totalHours に残すが、超過・接近にはしない。
      var hasUnconfirmed = unconfirmedDates.length > 0;
      var undetermined = !complete || hasUndefinedHours || hasUnconfirmed;
      // 未確定の空白を含む窓でも、確定済みの時間だけで上限を超えていれば危険情報として残す
      // （未確定日は加算しないので、total は確定分のみの下限値）。判定自体は 'undetermined' のまま。
      var knownOver = hasUnconfirmed && rawOver;
      var over = !undetermined && rawOver;
      var warning = !undetermined && rawWarning;
      var judgment = undetermined ? 'undetermined' : over ? 'exceed' : warning ? 'approach' : 'within';
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
        judgment: judgment,
        complete: complete,
        availableDays: 7 - noDataDates.length,
        undefinedDates: undefinedDates,
        noDataDates: noDataDates,
        hasUndefinedHours: hasUndefinedHours,
        hasUnconfirmed: hasUnconfirmed,
        unconfirmedDates: unconfirmedDates,
        knownOver: knownOver,
        knownOverBy: knownOver ? total - limitHours : 0,
      });
    }
    return results;
  }

  var APPROACH_MARGIN_HOURS = 11;
  var APPROACH_RULE = 'prefix6-margin11';

  function addDaysIso(iso, days) {
    var parts = String(iso || '').split('-');
    if (parts.length < 3) return '';
    var date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    if (isNaN(date.getTime())) return '';
    date.setUTCDate(date.getUTCDate() + days);
    return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
  }

  function todayDutyFromBlocks(blocks) {
    if (!blocks || !blocks.length) return 'unknown';
    var work = false;
    var off = false;
    var unknown = false;
    blocks.forEach(function (block) {
      if (!block || block.defined === false || typeof block.hours !== 'number') {
        unknown = true;
        return;
      }
      if (block.code === 'KYU' || block.hours === 0) off = true;
      else if (block.hours > 0) work = true;
    });
    if (work) return 'work';
    if (unknown) return 'unknown';
    if (off) return 'off';
    return 'unknown';
  }

  function priorWindowTotal(windows, referenceDate) {
    var yesterday = addDaysIso(referenceDate, -1);
    var found = null;
    (windows || []).forEach(function (window) {
      if (!window || window.endDate !== yesterday) return;
      if (window.judgment === 'undetermined' || window.complete === false) return;
      found = window;
    });
    return found && typeof found.totalHours === 'number' ? found.totalHours : null;
  }

  // 当日で終わる7日窓（開始=基準日-6日）の、当日を除いた6日分。
  // 前日で終わる7日窓（基準日-7日を含む）は使わない。
  function prefixHoursBeforeToday(series, referenceDate) {
    var start = addDaysIso(referenceDate, -6);
    var end = addDaysIso(referenceDate, -1);
    if (!start || !end) return null;
    var byDate = {};
    (series || []).forEach(function (day) {
      if (day && day.date) byDate[day.date] = day;
    });
    var total = 0;
    var cursor = start;
    for (var i = 0; i < 6; i++) {
      var day = byDate[cursor];
      if (!day || day.noData || day.hasUndefinedHours || day.hasUnconfirmed || typeof day.dailyTotalHours !== 'number') return null;
      total += day.dailyTotalHours;
      if (cursor === end) return total;
      cursor = addDaysIso(cursor, 1);
    }
    return null;
  }

  function approachByMargin(preTodayHours, duty) {
    if (typeof preTodayHours !== 'number' || !isFinite(preTodayHours)) {
      return { notice: 'none', reason: '当日を含まない6日累計が取得不可' };
    }
    if (preTodayHours > 60 || preTodayHours < 60 - APPROACH_MARGIN_HOURS) {
      return { notice: 'none', reason: '警戒幅の外' };
    }
    if (duty === 'work') return { notice: 'approach', reason: '当日勤務あり' };
    if (duty === 'off') return { notice: 'excluded', reason: '当日休み' };
    return { notice: 'unconfirmed', reason: '勤務予定未確認' };
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
  function pickReport5Sheet(sheetNames) {
    sheetNames = sheetNames || [];
    for (var i = 0; i < sheetNames.length; i++) {
      if (sheetNames[i] === 'Report5_Daily_Data') return sheetNames[i];
    }
    return null;
  }

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
    // ヘッダーが無い列位置の推測は、明示したときだけ行う。
    // シフトブックの「貼付」は正式なデイリー取得元にしない。
    if (col.tid === -1 && options.allowHeaderlessFallback) {
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

      var rawHour = row[col.hour];
      var hours = typeof rawHour === 'number' ? rawHour : parseFloat(rawHour);
      var hoursOk = rawHour !== null && rawHour !== undefined && rawHour !== '' && !isNaN(hours);

      records.push({
        transportId: tid,
        date: dateStr,
        dsp: col.dsp >= 0 ? String(row[col.dsp] || '').trim() : '',
        hours: hoursOk ? hours : null,
        hoursOk: hoursOk,
        hoursKind: 'estimated_working_hour',
        startTime: col.start >= 0 ? row[col.start] : null,
        endTime: col.end >= 0 ? row[col.end] : null,
      });
    }
    var actualDates = records.map(function (r) { return r.date; }).sort();
    var dateRange = actualDates.length > 0 ? { min: actualDates[0], max: actualDates[actualDates.length - 1] } : null;
    return { records: records, warnings: warnings, dateRange: dateRange };
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
    var colDateKey = {}; // colIndex -> 'YYYY-MM-DD'（見出し復元の「前列」判定用）
    for (var c2 = 0; c2 < headerRow.length; c2++) {
      if (isValidDateCell(headerRow[c2])) {
        var key = parseExcelDateFlexible(headerRow[c2]);
        if (!key) continue;
        (dateGroups[key] = dateGroups[key] || []).push(c2);
        colDateKey[c2] = key;
      } else if (options.restoreDayNumberHeaders && colDateKey[c2 - 1]) {
        // 月末列の見出しが数式ではなく定数の日番号（例: 10月シートAO3=31）になっている場合の復元。
        // 前列の有効日付+1日の「日」と一致し、同じ月に収まり、曜日行も前列・当列とも一致する時だけ採用する。
        var restored = restoreDayNumberHeader(headerRow[c2], colDateKey[c2 - 1], rows[headerRowIdx + 1], c2);
        if (restored) {
          (dateGroups[restored.date] = dateGroups[restored.date] || []).push(c2);
          colDateKey[c2] = restored.date;
          warnings.push({
            type: 'header_date_restored',
            date: restored.date,
            col: c2,
            colLetter: columnLetter(c2),
            cell: columnLetter(c2) + (headerRowIdx + 1),
            rawHeader: restored.dayNumber,
            prevDate: colDateKey[c2 - 1],
            weekday: restored.weekday,
            reason: '前列' + colDateKey[c2 - 1] + 'の翌日・同月・曜日「' + restored.weekday + '」が一致したため、定数見出し' + restored.dayNumber + 'を' + restored.date + 'として復元',
          });
        }
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
    // 空白セル（≠未読み込み日付）を「日付は読み込み範囲内」の空レコード
    // として残す（rawCode:''。0hとは断定しない。意味づけは resolveRosterBlanks）。これにより、後段の
    // buildContinuousDailySeries()で「レコードが無い日付」＝「このシートの
    // 読み込み範囲外（＝月またぎ時に隣接月データが無い日）」と一意に区別できる
    // （月端の日付を推測で0h扱いにしないための土台。§複数月マージで利用）。
    var records = [];
    var allDateKeys = Object.keys(codeColByDate);
    if (options.excludeLeadInBlankColumns) {
      // シートの対象月（日付列が最も多い月）以外で、ドライバー行が全員空白の日付列は
      // 「前月/翌月の助走列」＝このシートの対象期間外として結合に参加させない
      // （例: 11月シートの10/25〜10/31。個人単位の空白＝通常休みとは区別する）。
      var leadIn = findLeadInBlankDateKeys(rows, dataStartRow, nameCol, codeColByDate, options.isNonDriverRow);
      if (leadIn.excluded.length > 0) {
        var excludedSet = {};
        leadIn.excluded.forEach(function (k) {
          excludedSet[k] = true;
          warnings.push({
            type: 'lead_in_blank_date_column_excluded',
            date: k,
            col: codeColByDate[k],
            colLetter: columnLetter(codeColByDate[k]),
            targetMonth: leadIn.targetMonth,
            reason: '対象月' + leadIn.targetMonth + '以外の日付列で、ドライバー行が全員空白のため対象期間外として除外',
          });
        });
        allDateKeys = allDateKeys.filter(function (k) { return !excludedSet[k]; });
      }
    }
    for (var r3 = dataStartRow; r3 < rows.length; r3++) {
      var drow = rows[r3];
      if (!drow) continue;
      var name = String(drow[nameCol] || '').trim();
      if (!name) continue;
      if (typeof options.isNonDriverRow === 'function' && options.isNonDriverRow(name)) continue;

      var company = companyCol >= 0 ? String(drow[companyCol] || '').trim() : '';
      var transportId = tidCol >= 0 ? String(drow[tidCol] || '').trim() : '';

      allDateKeys.forEach(function (dateKey) {
        var col = codeColByDate[dateKey];
        var cellVal = drow[col];
        var isBlank = cellVal === undefined || cellVal === null || cellVal === '';
        var rec = {
          name: name,
          company: company,
          transportId: transportId,
          date: dateKey,
          rawCode: isBlank ? '' : cellVal,
        };
        if (options.trackCells) rec.cell = columnLetter(col) + (r3 + 1);
        records.push(rec);
      });
    }

    var sortedDates = allDateKeys.slice().sort();

    return {
      records: records,
      warnings: warnings,
      meta: {
        headerRowIdx: headerRowIdx,
        nameCol: nameCol,
        companyCol: companyCol,
        tidCol: tidCol,
        dateCount: sortedDates.length,
        dateRange: sortedDates.length > 0 ? { min: sortedDates[0], max: sortedDates[sortedDates.length - 1] } : null,
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
      if (rec.cell) {
        // trackCells 指定時のみ（由来セルの追跡用。既存呼び出しの戻り値は変えない）
        var cells = byDriver[key].cellsByDate = byDriver[key].cellsByDate || {};
        cells[rec.date] = cells[rec.date] ? cells[rec.date] + ',' + rec.cell : rec.cell;
      }
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
      var hoursOk = rec.hoursOk !== false && typeof rec.hours === 'number' && !isNaN(rec.hours);
      d[rec.date].push({
        code: 'AMAZON_ESTIMATE',
        rawCode: '(estimated_working_hour)',
        source: 'actual',
        hours: hoursOk ? rec.hours : null,
        defined: hoursOk,
        hoursKind: 'estimated_working_hour',
      });
    });
    return byTid;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  function hourDisplay() {
    if (typeof window !== 'undefined' && window.DutyHoursFormat) return window.DutyHoursFormat;
    if (global && global.DutyHoursFormat) return global.DutyHoursFormat;
    if (typeof require === 'function') {
      try { return require('./duty-hours-format.js'); } catch (e) { return null; }
    }
    return null;
  }

  function formatHourText(hours) {
    var api = hourDisplay();
    if (api && typeof hours === 'number' && isFinite(hours)) return api.durationText(hours);
    var rounded = Math.round(hours * 100) / 100;
    return rounded.toFixed(2).replace(/\.?0+$/, '') + 'h';
  }

  function formatRollingBlockLabel(block) {
    if (!block) return '未取得';
    if (block.conflict) return '衝突';
    if (block.blank) return '未取得';
    var actual = block.source === 'actual' || block.code === 'AMAZON_ESTIMATE' || block.code === 'AMAZON_ACTUAL';
    if (actual) {
      if (block.defined && typeof block.hours === 'number' && !isNaN(block.hours)) return formatHourText(block.hours) + ' 実績';
      return '未取得';
    }
    if (block.code === 'KYU' || block.rawCode === '休') return '休';
    if (!block.defined || typeof block.hours !== 'number' || isNaN(block.hours)) return '判定不能';
    var mark = block.rawCode && block.rawCode !== '(estimated_working_hour)' ? block.rawCode : formatHourText(block.hours);
    return mark + ' 予定';
  }

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
    resolveRosterBlanks: resolveRosterBlanks,
    mergeRosterBlocksByDateAcrossSources: mergeRosterBlocksByDateAcrossSources,
    mergeRosterBlocksByDateAcrossSourcesStrict: mergeRosterBlocksByDateAcrossSourcesStrict,
    buildRosterTimelineFromSources: buildRosterTimelineFromSources,
    restoreDayNumberHeader: restoreDayNumberHeader,

    // Rolling計算コア
    computeRolling60h: computeRolling60h,
    APPROACH_MARGIN_HOURS: APPROACH_MARGIN_HOURS,
    APPROACH_RULE: APPROACH_RULE,
    addDaysIso: addDaysIso,
    todayDutyFromBlocks: todayDutyFromBlocks,
    priorWindowTotal: priorWindowTotal,
    prefixHoursBeforeToday: prefixHoursBeforeToday,
    approachByMargin: approachByMargin,
    computeRollingRisk: computeRollingRisk,

    // 行レベルパーサ
    pickReport5Sheet: pickReport5Sheet,
    parseAmazonDailyRows: parseAmazonDailyRows,
    parseMonthlyRosterSheetRows: parseMonthlyRosterSheetRows,

    // 統合ヘルパー
    groupRosterRecordsByDriver: groupRosterRecordsByDriver,
    groupActualRecordsByTransportId: groupActualRecordsByTransportId,
    formatRollingBlockLabel: formatRollingBlockLabel,
  };

  global.RollingCore = RollingCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RollingCore;
  }
})(typeof window !== 'undefined' ? window : global);
