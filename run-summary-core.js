/**
 * OFK3 運行実績集計（月次・所属別・ドライバー別）— 純粋ロジック（UI非依存・XLSX非依存）
 *
 * 目的:
 *   DAシフト表（月間シフト表）から、対象月の「所属別・ドライバー別 運行回数」を
 *   毎回原体から再計算する。シフト回数・運行種類は「シフト表を正」とする。
 *   アルコールチェックデータは監査（照合）用途のみに使い、シフトを増減させない。
 *
 * 再利用している既存機能:
 *   - RollingCore.normalizeRollingShiftCode（rolling60h-core.js）… 勤務記号の正規化
 *     （○の異体字・❽/⑧・全角英数・BIKE/Bike 等の表記揺れ吸収）
 *   - RollingCore.parseExcelDateFlexible / isValidDateCell … 日付ヘッダー判定
 *   - AssignSupportCore.isShiftNonDriverRow（呼び出し側から options で注入）
 *     … 「必要台数」「合計」等の非ドライバー行の除外
 *   - 「メイン」シート優先（既存 parseShiftForExec / processShiftMaster /
 *     tenko-transport-audit と同じ方針）。列位置はヘッダー名から検出する。
 *
 * 制約: index.html と同じくテンプレートリテラル禁止（文字列連結のみ）。
 */
(function (global) {
  'use strict';

  function rollingCore() {
    if (global.RollingCore) return global.RollingCore;
    if (typeof require === 'function') {
      try {
        return require('./rolling60h-core.js');
      } catch (e) {}
    }
    return null;
  }

  // ===========================================================================
  // 1. 集計対象シフトコード
  // ===========================================================================

  /** 集計列（表示順）。key は RollingCore.normalizeRollingShiftCode の戻り値 */
  var TARGET_CODES = [
    { key: 'MARU', label: '○' },
    { key: 'HACHI', label: '❽' },
    { key: 'BIKE', label: 'bike' },
    { key: 'B1', label: 'b1' },
    { key: 'B2', label: 'b2' },
    { key: 'C1', label: 'C1' },
    { key: 'C3', label: 'C3' },
  ];
  var TARGET_KEYS = TARGET_CODES.map(function (c) { return c.key; });

  /**
   * 既存コード（rolling60h-core.js / assign-support-core.js）で実在が確認されている
   * 「勤務だが今回の集計列に含めない」記号。UNKNOWN_SHIFT とは別に件数を可視化する。
   */
  var OTHER_KNOWN_CODES = ['C2', '唐津', '嘉', '嘉麻'];

  /**
   * 集計列へ読み替える派生コード（正式な集計ルール。月を問わず適用する）。
   * キーは NFKC 正規化＋英字大文字化後の表記（全角「研Ｃ１」や「c319」も対象）。
   *   研修 → ○ / 研C1 → C1 / C319・C320 → C3
   */
  var CODE_ALIASES = { '研修': 'MARU', '研C1': 'C1', C319: 'C3', C320: 'C3' };

  /** 非稼働（運行回数に含めない）判定 */
  function isNonWorkingCode(s) {
    return s.indexOf('休') >= 0 || s === '欠勤' || s === '有給';
  }

  var UNKNOWN_SHIFT = 'UNKNOWN_SHIFT';

  /**
   * シフト表セル1件を分類する。
   * @return {{category:'TARGET'|'BLANK'|'NON_WORKING'|'OTHER'|'UNKNOWN_SHIFT', code:string, raw:string, convertedFrom?:string}}
   */
  function classifyShiftCell(value) {
    var raw = value === null || value === undefined ? '' : String(value).trim();
    if (!raw) return { category: 'BLANK', code: '', raw: '' };
    var compact = raw.replace(/[\s　]+/g, '');
    if (isNonWorkingCode(compact)) return { category: 'NON_WORKING', code: compact, raw: raw };
    var aliasKey = nfkc(compact).toUpperCase();
    if (Object.prototype.hasOwnProperty.call(CODE_ALIASES, aliasKey)) {
      return { category: 'TARGET', code: CODE_ALIASES[aliasKey], raw: raw, convertedFrom: aliasKey };
    }
    var rc = rollingCore();
    var code = rc ? rc.normalizeRollingShiftCode(compact) : compact;
    if (TARGET_KEYS.indexOf(code) >= 0) return { category: 'TARGET', code: code, raw: raw };
    if (OTHER_KNOWN_CODES.indexOf(code) >= 0) return { category: 'OTHER', code: code, raw: raw };
    return { category: UNKNOWN_SHIFT, code: compact, raw: raw };
  }

  // ===========================================================================
  // 2. 正規化（氏名・所属）
  // ===========================================================================

  function nfkc(s) {
    return typeof s.normalize === 'function' ? s.normalize('NFKC') : s;
  }

  /** 表示用氏名: 前後空白除去・全角/半角/連続スペースを半角スペース1つに統一 */
  function normalizeDisplayName(name) {
    return String(name === null || name === undefined ? '' : name)
      .replace(/[\s　]+/g, ' ')
      .trim();
  }

  /** 同一人物判定キー（既存 renderTenkoMatchTable と同じく空白をすべて除去） */
  function nameKey(name) {
    return nfkc(String(name === null || name === undefined ? '' : name)).replace(/[\s　]+/g, '');
  }

  /** 所属のグルーピングキー（表記は原体のまま表示し、キーのみ正規化） */
  function companyKey(company) {
    return nfkc(String(company || '')).replace(/[\s　]+/g, '');
  }

  // ===========================================================================
  // 3. 日付ユーティリティ
  // ===========================================================================

  /** 0始まり列番号＋1始まり行番号 → Excelのセル番地（例: 'AB12'）。列不明なら '' */
  function cellAddress(col, row) {
    if (typeof col !== 'number' || col < 0) return '';
    var s = '';
    var n = col + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s + row;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** Excelシリアル値 → YYYY-MM-DD（UTCで計算しタイムゾーンずれを避ける） */
  function serialToYMD(num) {
    var d = new Date(Math.round((num - 25569) * 86400000));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /**
   * ヘッダーセル → {date:'YYYY-MM-DD'} または {day:1..31} または null
   */
  function parseHeaderDateCell(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
      return { date: v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate()) };
    }
    if (typeof v === 'number') {
      if (v > 40000 && v < 60000) return { date: serialToYMD(v) };
      if (v >= 1 && v <= 31 && Math.floor(v) === v) return { day: v };
      return null;
    }
    var s = String(v).trim();
    var m = s.match(/^(\d{1,2})日?$/);
    if (m) {
      var n = parseInt(m[1], 10);
      return n >= 1 && n <= 31 ? { day: n } : null;
    }
    var rc = rollingCore();
    if (rc && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(s)) {
      var ymd = rc.parseExcelDateFlexible(s);
      if (ymd) return { date: ymd };
    }
    return null;
  }

  /** シート上部から「2026年9月」のような年月表記を拾う（日付ヘッダーが日番号のみの場合用） */
  function findYearMonthInRows(rows, upToRow) {
    for (var r = 0; r <= upToRow && r < rows.length; r++) {
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) {
        var m = String(row[c] === null || row[c] === undefined ? '' : row[c]).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
      }
    }
    return null;
  }

  function parseMonthKey(month) {
    var m = String(month || '').match(/^(\d{4})-(\d{1,2})$/);
    if (!m) return null;
    return { year: parseInt(m[1], 10), month: parseInt(m[2], 10), key: m[1] + '-' + pad2(parseInt(m[2], 10)) };
  }

  // ===========================================================================
  // 4. シフト表シート解析（列位置はヘッダー名から検出）
  // ===========================================================================

  var NAME_LABELS = ['名前', '氏名', 'ドライバー名', 'ドライバー', 'name'];
  var COMPANY_LABELS = ['社名', '所属', '会社名', '所属会社', 'affiliation'];
  var COUNT_LABELS = ['回数'];

  function compactLabel(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[\s　]/g, '').toLowerCase();
  }

  /**
   * 月間シフト表の1シート（sheet_to_json(header:1) の2次元配列）を解析する。
   * @param {Array<Array>} rows
   * @param {{month?:string, isNonDriverRow?:function, sheetName?:string}} options
   */
  function parseShiftSheetRows(rows, options) {
    options = options || {};
    var sheetName = options.sheetName || '';
    var warnings = [];
    rows = rows || [];

    // 1) 氏名ヘッダー行の検出
    var headerRowIdx = -1;
    var nameCol = -1;
    var scan = Math.min(rows.length, 20);
    for (var r = 0; r < scan && headerRowIdx < 0; r++) {
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) {
        if (NAME_LABELS.indexOf(compactLabel(row[c])) >= 0) {
          headerRowIdx = r;
          nameCol = c;
          break;
        }
      }
    }
    if (headerRowIdx < 0) {
      return { ok: false, records: [], warnings: [{ type: 'NAME_HEADER_NOT_FOUND', sheet: sheetName }], meta: {} };
    }
    var headerRow = rows[headerRowIdx] || [];
    var companyCol = -1;
    var tidCol = -1;
    var countCol = -1;
    for (var hc = 0; hc < headerRow.length; hc++) {
      var lab = compactLabel(headerRow[hc]);
      if (companyCol < 0 && COMPANY_LABELS.indexOf(lab) >= 0) companyCol = hc;
      if (tidCol < 0 && lab.indexOf('transportid') >= 0) tidCol = hc;
      if (countCol < 0 && COUNT_LABELS.indexOf(lab) >= 0) countCol = hc;
    }
    if (companyCol < 0) warnings.push({ type: 'COMPANY_HEADER_NOT_FOUND', sheet: sheetName });

    // 2) 日付ヘッダー行の検出（氏名ヘッダー行の前後2行で日付セルが最も多い行）
    var dateRowIdx = -1;
    var best = 0;
    for (var dr = Math.max(0, headerRowIdx - 2); dr <= Math.min(rows.length - 1, headerRowIdx + 1); dr++) {
      var cnt = 0;
      var drow = rows[dr] || [];
      for (var dc = nameCol + 1; dc < drow.length; dc++) {
        if (dc === countCol || dc === tidCol || dc === companyCol) continue;
        if (parseHeaderDateCell(drow[dc])) cnt++;
      }
      if (cnt > best) {
        best = cnt;
        dateRowIdx = dr;
      }
    }
    if (dateRowIdx < 0 || best < 7) {
      return { ok: false, records: [], warnings: warnings.concat([{ type: 'DATE_HEADER_NOT_FOUND', sheet: sheetName }]), meta: {} };
    }

    // 3) 日番号 → 年月の解決（Date型ヘッダーならそのまま、日番号なら年月表記 or 選択月）
    var ym = null;
    var target = parseMonthKey(options.month);
    var found = findYearMonthInRows(rows, headerRowIdx);
    if (found) ym = found;
    else if (target) ym = { year: target.year, month: target.month };
    if (found && target && (found.year !== target.year || found.month !== target.month)) {
      warnings.push({ type: 'SHEET_MONTH_DIFFERS_FROM_SELECTED', sheet: sheetName, sheetMonth: found.year + '-' + pad2(found.month), selected: target.key });
    }

    var dataStart = Math.max(headerRowIdx, dateRowIdx) + 1;
    var dateGroups = {};
    var dateHeaderRow = rows[dateRowIdx] || [];
    for (var c2 = nameCol + 1; c2 < dateHeaderRow.length; c2++) {
      if (c2 === countCol || c2 === tidCol || c2 === companyCol) continue;
      var h = parseHeaderDateCell(dateHeaderRow[c2]);
      if (!h) continue;
      var key = h.date;
      if (!key) {
        if (!ym) {
          return { ok: false, records: [], warnings: warnings.concat([{ type: 'MONTH_UNRESOLVED', sheet: sheetName }]), meta: {} };
        }
        key = ym.year + '-' + pad2(ym.month) + '-' + pad2(h.day);
      }
      (dateGroups[key] = dateGroups[key] || []).push(c2);
    }

    // 4) 同一日付が複数列ある場合は「記号が入っている列」（非数値率が高い列）を採用
    //    （rolling60h-core.js parseMonthlyRosterSheetRows と同じ方針）
    var sample = rows.slice(dataStart, dataStart + 40);
    var colByDate = {};
    Object.keys(dateGroups).forEach(function (k) {
      var cols = dateGroups[k];
      if (cols.length === 1) {
        colByDate[k] = cols[0];
        return;
      }
      var bestCol = cols[0];
      var bestScore = -1;
      cols.forEach(function (col) {
        var total = 0;
        var strs = 0;
        sample.forEach(function (sr) {
          var v = sr ? sr[col] : undefined;
          if (v === undefined || v === null || v === '') return;
          total++;
          if (typeof v !== 'number') strs++;
        });
        var score = total > 0 ? strs / total : -1;
        if (score > bestScore) {
          bestScore = score;
          bestCol = col;
        }
      });
      colByDate[k] = bestCol;
      warnings.push({ type: 'DUPLICATE_DATE_COLUMN_RESOLVED', sheet: sheetName, date: k, chosenCol: bestCol, candidateCols: cols });
    });
    var dateKeys = Object.keys(colByDate).sort();

    // 5) データ行
    var records = [];
    var currentCompany = '';
    for (var r3 = dataStart; r3 < rows.length; r3++) {
      var dataRow = rows[r3];
      if (!dataRow) continue;
      if (companyCol >= 0) {
        var comp = String(dataRow[companyCol] === null || dataRow[companyCol] === undefined ? '' : dataRow[companyCol]).trim();
        // 結合セル（所属ブロックの先頭行のみ値あり）に対応して直前の所属を引き継ぐ
        // （既存 parseShiftForExec と同じ挙動）
        if (comp) currentCompany = comp;
      }
      var rawName = dataRow[nameCol];
      var display = normalizeDisplayName(rawName);
      if (!display) continue;
      if (/^\d+$/.test(display)) continue;
      if (NAME_LABELS.indexOf(compactLabel(display)) >= 0) continue;
      if (typeof options.isNonDriverRow === 'function' && options.isNonDriverRow(display)) continue;

      var cells = [];
      for (var i = 0; i < dateKeys.length; i++) {
        var v = dataRow[colByDate[dateKeys[i]]];
        cells.push({ date: dateKeys[i], col: colByDate[dateKeys[i]], value: v === undefined ? '' : v });
      }
      var countVal = countCol >= 0 ? dataRow[countCol] : null;
      records.push({
        sheet: sheetName,
        row: r3 + 1,
        company: normalizeDisplayName(currentCompany),
        rawName: String(rawName),
        name: display,
        nameKey: nameKey(display),
        transportId: tidCol >= 0 ? String(dataRow[tidCol] === null || dataRow[tidCol] === undefined ? '' : dataRow[tidCol]).replace(/[\s　]/g, '') : '',
        countColumnValue: typeof countVal === 'number' ? countVal : countVal && !isNaN(Number(countVal)) ? Number(countVal) : null,
        cells: cells,
      });
    }

    return {
      ok: true,
      records: records,
      warnings: warnings,
      meta: {
        sheet: sheetName,
        headerRowIdx: headerRowIdx,
        dateRowIdx: dateRowIdx,
        nameCol: nameCol,
        companyCol: companyCol,
        tidCol: tidCol,
        countCol: countCol,
        dateRange: dateKeys.length ? { min: dateKeys[0], max: dateKeys[dateKeys.length - 1] } : null,
      },
    };
  }

  /** シフト読込対象外のシート（rolling60h-ui.js の除外リストと同じ系統） */
  var SHEET_BLACKLIST = ['貼付', 'WH60', '点呼表', 'Export', 'システム'];

  /**
   * ワークブック（{シート名: rows}）からシフトレコードを抽出する。
   * 「メイン」シートがあればそれのみを使う（DSP別シートとの二重計上を避ける）。
   * 無い場合は、氏名・日付ヘッダーを検出できた全シートを使う。
   */
  function parseShiftWorkbook(sheets, sheetOrder, options) {
    options = options || {};
    var names = sheetOrder && sheetOrder.length ? sheetOrder : Object.keys(sheets || {});
    var targets = names.indexOf('メイン') >= 0 ? ['メイン'] : names.filter(function (n) { return SHEET_BLACKLIST.indexOf(n) < 0; });
    var records = [];
    var warnings = [];
    var used = [];
    targets.forEach(function (sn) {
      var parsed = parseShiftSheetRows(sheets[sn], { month: options.month, isNonDriverRow: options.isNonDriverRow, sheetName: sn });
      warnings = warnings.concat(parsed.warnings);
      if (parsed.ok && parsed.records.length) {
        used.push(parsed.meta);
        records = records.concat(parsed.records);
      }
    });
    if (!used.length) warnings.push({ type: 'NO_SHIFT_SHEET_PARSED' });
    return { records: records, warnings: warnings, sheetsUsed: used };
  }

  // ===========================================================================
  // 5. 集計
  // ===========================================================================

  function emptyCounts() {
    var o = {};
    TARGET_KEYS.forEach(function (k) { o[k] = 0; });
    return o;
  }

  function sumCounts(counts) {
    var t = 0;
    TARGET_KEYS.forEach(function (k) { t += counts[k] || 0; });
    return t;
  }

  /**
   * シフトレコードを「人物」単位に束ねる。
   * - 同一所属・同一氏名キー（空白表記揺れ吸収）は同一人物として統合
   * - 同一氏名キーでも Transport ID が異なれば別人のまま（警告）
   * - 同一氏名キーが複数所属にまたがる場合も統合しない（警告）
   */
  function groupPersons(records, warnings) {
    var groups = {};
    var order = [];
    records.forEach(function (rec) {
      var gk = companyKey(rec.company) + '|' + rec.nameKey;
      if (!groups[gk]) {
        groups[gk] = [];
        order.push(gk);
      }
      groups[gk].push(rec);
    });

    var persons = [];
    order.forEach(function (gk) {
      var recs = groups[gk];
      var tids = {};
      recs.forEach(function (r) { if (r.transportId) tids[r.transportId] = true; });
      var tidList = Object.keys(tids);
      var buckets = [];
      if (tidList.length > 1) {
        warnings.push({ type: 'SAME_NAME_DIFFERENT_TID', company: recs[0].company, name: recs[0].name, transportIds: tidList });
        tidList.forEach(function (t) {
          buckets.push(recs.filter(function (r) { return r.transportId === t; }));
        });
        var noTid = recs.filter(function (r) { return !r.transportId; });
        if (noTid.length) buckets.push(noTid);
      } else {
        buckets.push(recs);
      }
      buckets.forEach(function (b) {
        if (b.length > 1) {
          var variants = {};
          b.forEach(function (r) { variants[r.rawName] = true; });
          warnings.push({ type: 'MERGED_DUPLICATE_ROWS', company: b[0].company, name: b[0].name, rawNames: Object.keys(variants), rows: b.map(function (r) { return r.sheet + '!' + r.row; }) });
        }
        persons.push({
          company: b[0].company,
          name: b[0].name,
          nameKey: b[0].nameKey,
          transportId: b.filter(function (r) { return r.transportId; }).map(function (r) { return r.transportId; })[0] || '',
          records: b,
        });
      });
    });

    var byName = {};
    persons.forEach(function (p) {
      (byName[p.nameKey] = byName[p.nameKey] || []).push(p);
    });
    Object.keys(byName).forEach(function (k) {
      var comps = {};
      byName[k].forEach(function (p) { comps[p.company] = true; });
      if (Object.keys(comps).length > 1) {
        warnings.push({ type: 'SAME_NAME_MULTIPLE_COMPANIES', name: byName[k][0].name, companies: Object.keys(comps) });
      }
    });
    return persons;
  }

  /**
   * 月次の所属別・ドライバー別 運行回数を集計する。
   * @param {Array} records parseShiftWorkbook().records
   * @param {{month:string}} options month='YYYY-MM'（対象月以外の日付列は集計しない）
   */
  function summarizeShiftRecords(records, options) {
    options = options || {};
    var target = parseMonthKey(options.month);
    var warnings = [];
    var persons = groupPersons(records || [], warnings);
    var unknownShifts = [];
    var convertedCodes = []; // 研修→○ 等の読み替え実績（原体のセル位置つき）
    var otherCodes = {};
    var nonWorkingCount = 0;
    var outOfMonthCells = 0;
    var dateMin = null;
    var dateMax = null;

    persons.forEach(function (p) {
      p.counts = emptyCounts();
      p.shiftDays = {}; // date -> [code]（アルコール照合用）
      var seen = {}; // date|code -> 'sheet!row'
      p.records.forEach(function (rec) {
        rec.cells.forEach(function (cell) {
          var cls = classifyShiftCell(cell.value);
          if (cls.category === 'BLANK') return;
          if (target && cell.date.slice(0, 7) !== target.key) {
            outOfMonthCells++;
            return;
          }
          if (!dateMin || cell.date < dateMin) dateMin = cell.date;
          if (!dateMax || cell.date > dateMax) dateMax = cell.date;
          if (cls.category === 'NON_WORKING') {
            nonWorkingCount++;
            return;
          }
          if (cls.category === 'OTHER') {
            otherCodes[cls.code] = (otherCodes[cls.code] || 0) + 1;
            return;
          }
          if (cls.category === UNKNOWN_SHIFT) {
            unknownShifts.push({ type: UNKNOWN_SHIFT, company: p.company, name: p.name, date: cell.date, raw: cls.raw, sheet: rec.sheet, row: rec.row, cell: cellAddress(cell.col, rec.row) });
            return;
          }
          var dk = cell.date + '|' + cls.code;
          if (seen[dk]) {
            // 同一人物の重複行に同じ日・同じ記号 → 二重計上しない
            warnings.push({ type: 'DUPLICATE_SHIFT_SAME_DAY', company: p.company, name: p.name, date: cell.date, code: cls.code, rows: [seen[dk], rec.sheet + '!' + rec.row] });
            return;
          }
          seen[dk] = rec.sheet + '!' + rec.row;
          p.counts[cls.code]++;
          if (cls.convertedFrom) {
            convertedCodes.push({ company: p.company, name: p.name, date: cell.date, raw: cls.raw, code: cls.code, sheet: rec.sheet, row: rec.row, cell: cellAddress(cell.col, rec.row) });
          }
          (p.shiftDays[cell.date] = p.shiftDays[cell.date] || []).push(cls.code);
        });
      });
      p.total = sumCounts(p.counts);

      // シフト表の「回数」列がある場合は照合のみ行う（値は採用しない）
      var countVals = p.records.map(function (r) { return r.countColumnValue; }).filter(function (v) { return typeof v === 'number'; });
      if (p.records.length === 1 && countVals.length === 1 && countVals[0] !== p.total) {
        warnings.push({ type: 'COUNT_COLUMN_MISMATCH', company: p.company, name: p.name, sheetCount: countVals[0], computed: p.total });
      }
    });

    // 所属別に集約（所属表記は原体の表記で表示、キーのみ正規化）
    var affMap = {};
    var affOrder = [];
    persons.forEach(function (p) {
      var ck = companyKey(p.company) || '(所属不明)';
      if (!affMap[ck]) {
        affMap[ck] = { key: ck, company: p.company || '(所属不明)', labels: {}, counts: emptyCounts(), total: 0, headcount: 0, drivers: [], zeroShiftDrivers: [] };
        affOrder.push(ck);
      }
      var a = affMap[ck];
      a.labels[p.company] = true;
      if (p.total > 0) {
        a.drivers.push(p);
        a.headcount++;
        TARGET_KEYS.forEach(function (k) { a.counts[k] += p.counts[k]; });
        a.total += p.total;
      } else {
        a.zeroShiftDrivers.push(p);
      }
    });
    affOrder.forEach(function (ck) {
      var labels = Object.keys(affMap[ck].labels);
      if (labels.length > 1) warnings.push({ type: 'COMPANY_LABEL_VARIANTS', company: affMap[ck].company, variants: labels });
    });

    var affiliations = affOrder
      .map(function (ck) { return affMap[ck]; })
      .filter(function (a) { return a.total > 0; })
      .sort(function (x, y) { return x.company < y.company ? -1 : x.company > y.company ? 1 : 0; });

    var totals = { counts: emptyCounts(), total: 0, headcount: 0 };
    affiliations.forEach(function (a) {
      TARGET_KEYS.forEach(function (k) { totals.counts[k] += a.counts[k]; });
      totals.total += a.total;
      totals.headcount += a.headcount;
    });

    return {
      month: target ? target.key : '',
      codes: TARGET_CODES.slice(),
      totals: totals,
      affiliations: affiliations,
      persons: persons,
      unknownShifts: unknownShifts,
      convertedCodes: convertedCodes,
      otherCodes: otherCodes,
      nonWorkingCount: nonWorkingCount,
      outOfMonthCells: outOfMonthCells,
      dateRange: dateMin ? { min: dateMin, max: dateMax } : null,
      warnings: warnings,
    };
  }

  /** ワークブック → 集計（シート解析＋集計のまとめ呼び出し） */
  function summarizeShiftWorkbook(sheets, sheetOrder, options) {
    options = options || {};
    var parsed = parseShiftWorkbook(sheets, sheetOrder, options);
    var result = summarizeShiftRecords(parsed.records, options);
    result.warnings = parsed.warnings.concat(result.warnings);
    result.sheetsUsed = parsed.sheetsUsed;
    return result;
  }

  // ===========================================================================
  // 7. Excel出力用 AOA（「所属別運行集計」シート）
  // ===========================================================================

  function codeLabels() {
    return TARGET_CODES.map(function (c) { return c.label; });
  }

  function countsRow(counts) {
    return TARGET_KEYS.map(function (k) { return counts[k] || 0; });
  }

  function monthLabel(month) {
    var t = parseMonthKey(month);
    return t ? t.year + '年' + t.month + '月' : '';
  }

  function buildSummaryAoa(result) {
    var aoa = [];
    aoa.push(['所属別運行集計' + (result.month ? '（' + monthLabel(result.month) + '）' : '')]);
    aoa.push([]);
    aoa.push(['■ 所属別サマリー']);
    aoa.push(['所属', '合計シフト'].concat(codeLabels()).concat(['構成人数']));
    result.affiliations.forEach(function (a) {
      aoa.push([a.company, a.total].concat(countsRow(a.counts)).concat([a.headcount]));
    });
    aoa.push(['全社合計', result.totals.total].concat(countsRow(result.totals.counts)).concat([result.totals.headcount]));
    aoa.push([]);
    aoa.push(['■ 所属別 → ドライバー別内訳']);
    result.affiliations.forEach(function (a) {
      aoa.push(['所属', 'ドライバー名', '合計シフト'].concat(codeLabels()));
      a.drivers.forEach(function (d) {
        aoa.push([a.company, d.name, d.total].concat(countsRow(d.counts)));
      });
      aoa.push([a.company + ' 合計', '', a.total].concat(countsRow(a.counts)));
      aoa.push([]);
    });
    return aoa;
  }

  function buildUnknownAoa(result) {
    var aoa = [['種別', '所属', 'ドライバー名', '日付', 'シフト表の値', 'シート', 'セル', '集計先']];
    var labelOf = {};
    TARGET_CODES.forEach(function (c) { labelOf[c.key] = c.label; });
    result.unknownShifts.forEach(function (u) {
      aoa.push([UNKNOWN_SHIFT, u.company, u.name, u.date, u.raw, u.sheet, u.cell || String(u.row), '（集計しない）']);
    });
    (result.convertedCodes || []).forEach(function (x) {
      aoa.push(['読み替え', x.company, x.name, x.date, x.raw, x.sheet, x.cell || String(x.row), labelOf[x.code]]);
    });
    Object.keys(result.otherCodes).forEach(function (k) {
      aoa.push(['集計対象外コード', '', '', '', k + '（' + result.otherCodes[k] + '件）', '', '', '（集計しない）']);
    });
    return aoa;
  }

  var RunSummaryCore = {
    TARGET_CODES: TARGET_CODES,
    OTHER_KNOWN_CODES: OTHER_KNOWN_CODES,
    CODE_ALIASES: CODE_ALIASES,
    UNKNOWN_SHIFT: UNKNOWN_SHIFT,
    classifyShiftCell: classifyShiftCell,
    normalizeDisplayName: normalizeDisplayName,
    nameKey: nameKey,
    parseShiftSheetRows: parseShiftSheetRows,
    parseShiftWorkbook: parseShiftWorkbook,
    summarizeShiftRecords: summarizeShiftRecords,
    summarizeShiftWorkbook: summarizeShiftWorkbook,
    buildSummaryAoa: buildSummaryAoa,
    buildUnknownAoa: buildUnknownAoa,
  };

  global.RunSummaryCore = RunSummaryCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RunSummaryCore;
  }
})(typeof window !== 'undefined' ? window : global);
