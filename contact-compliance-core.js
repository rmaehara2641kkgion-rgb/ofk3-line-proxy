/**
 * OFK3 Contact Compliance（CC）— CC Logic Version 1 判定・集計コア（DOM非依存の純粋関数のみ）
 *
 * Amazon Contact Compliance 生データ（1行 = CC判定1件）から CC率を算出する。
 * Wk40 OFK3 実データで Amazon 表示値（約78.75%）と 0.03pt 差で一致することを確認したルール:
 *
 *   1. 対象: Shipment Reason が CC_ELIGIBLE_REASONS の4種類のみ（それ以外は対象外）
 *   2. Contact: Call Event または Text Event が存在すれば true（両方あっても1件）
 *   3. 判定: 対象 AND Contact → Compliant / 対象 AND Contactなし → Non-Compliant
 *   4. CC率 = Compliant / (Compliant + Non-Compliant) × 100（0件は null）
 *
 * 通話時間（Total/Transporter Call Duration）・chat_reason_code は Ver.1 では判定に使わない。
 * Destination Address / Scannable ID / Stop 単位の dedupe は行わない（各対象行 = 1件）。
 *
 * 既存の「べき架電/実架電」（index.html の isCcCallRequired / isCcCallMade）とは別指標。
 * そちらは協力会社ダッシュボード・累計取込・分析CSVで使われているため変更していない。
 *
 * DA名解決（Transporter ID → 氏名）はこのコアでは行わない。呼び出し側が
 * resolveName(tid) を渡す（index.html では既存の buildTidToNameLookup を再利用）。
 */
(function (global) {
  'use strict';

  var CC_LOGIC_VERSION = 1;

  // CC対象 Shipment Reason（ここを変更すれば対象理由を追加・削除できる）
  var CC_ELIGIBLE_REASONS = [
    'CUSTOMER_UNAVAILABLE',
    'INACCESSIBLE_DELIVERY_LOCATION',
    'ADDRESS_NOT_FOUND',
    'NO_SECURE_LOCATION'
  ];

  // CC画面の Shipment Reason 日本語表示（表示専用。判定には元コードを使う）
  var CC_REASON_LABELS_JA = {
    CUSTOMER_UNAVAILABLE: '不在',
    INACCESSIBLE_DELIVERY_LOCATION: '配達先アクセス不可',
    ADDRESS_NOT_FOUND: '住所不明',
    NO_SECURE_LOCATION: '安全な置き場所なし'
  };

  var CC_STATUS = {
    COMPLIANT: 'COMPLIANT',
    NON_COMPLIANT: 'NON_COMPLIANT',
    NOT_ELIGIBLE: 'NOT_ELIGIBLE'
  };

  var CC_STATUS_LABELS_JA = {
    COMPLIANT: '適合',
    NON_COMPLIANT: '非適合',
    NOT_ELIGIBLE: '対象外'
  };

  var CC_UNKNOWN_DA_LABEL = '未特定';

  var CC_LOGIC_LABEL = 'CC Logic Ver.' + CC_LOGIC_VERSION;

  // CC率の評価色分け閾値。Amazon正式基準が未確認のため現時点は null（色分けしない）。
  // 正式基準が判明したら例: [{ min: 95, level: 'good' }, { min: 85, level: 'warn' }, { min: 0, level: 'bad' }]
  var CC_RATE_LEVEL_THRESHOLDS = null;

  // 取込必須列（Amazon Contact Compliance ファイルのヘッダー名）。列順には依存しない。
  var CC_REQUIRED_COLUMNS = [
    { key: 'eventDate', header: 'Event Date' },
    { key: 'scannableId', header: 'Scannable ID' },
    { key: 'destinationAddressId', header: 'Destination Address ID' },
    { key: 'transporterId', header: 'Transporter ID' },
    { key: 'shipmentReason', header: 'Shipment Reason' },
    { key: 'callEvent', header: 'Call Event' },
    { key: 'textEvent', header: 'Text Event' }
  ];

  var HEADER_SCAN_ROWS = 15;

  function cellText(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/ /g, ' ').trim();
  }

  function normalizeCcHeader(h) {
    return cellText(h).replace(/^﻿/, '').toLowerCase().replace(/[\s_]+/g, ' ').trim();
  }

  function headerMatchesColumn(normalized, col) {
    if (normalized === normalizeCcHeader(col.header)) return true;
    // 既存 isTransporterHeader と同じ表記揺れ（TransporterID / Transport ID）を許容
    if (col.key === 'transporterId') {
      var compact = normalized.replace(/\s/g, '');
      return compact === 'transporterid' || compact === 'transportid';
    }
    return false;
  }

  // ヘッダー行 → { columns: {key: index}, missing: [header名] }。同名列は先勝ち。
  function ccMapColumns(headerRow) {
    var columns = {};
    var row = headerRow || [];
    for (var i = 0; i < row.length; i++) {
      var n = normalizeCcHeader(row[i]);
      if (!n) continue;
      for (var c = 0; c < CC_REQUIRED_COLUMNS.length; c++) {
        var col = CC_REQUIRED_COLUMNS[c];
        if (columns[col.key] === undefined && headerMatchesColumn(n, col)) columns[col.key] = i;
      }
    }
    var missing = [];
    for (var m = 0; m < CC_REQUIRED_COLUMNS.length; m++) {
      if (columns[CC_REQUIRED_COLUMNS[m].key] === undefined) missing.push(CC_REQUIRED_COLUMNS[m].header);
    }
    return { columns: columns, missing: missing };
  }

  // 先頭 HEADER_SCAN_ROWS 行のうち必須列が最も多く揃う行をヘッダー行とする（同数なら先勝ち）
  function ccFindHeaderRow(rows) {
    var best = -1;
    var bestFound = 0;
    var limit = Math.min((rows || []).length, HEADER_SCAN_ROWS);
    for (var r = 0; r < limit; r++) {
      var found = CC_REQUIRED_COLUMNS.length - ccMapColumns(rows[r]).missing.length;
      if (found > bestFound) {
        bestFound = found;
        best = r;
      }
    }
    return best;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // Event Date を YYYY-MM-DD に正規化（Date / Excelシリアル値 / 文字列に対応）
  function normalizeCcEventDate(v) {
    if (v === null || v === undefined || v === '') return '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return '';
      return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 80000) {
      var ms = Math.round((Math.floor(v) - 25569) * 86400000);
      var d = new Date(ms);
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    var s = cellText(v);
    var m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) return m[1] + '-' + pad2(parseInt(m[2], 10)) + '-' + pad2(parseInt(m[3], 10));
    return s.split(/[ T]/)[0];
  }

  // 2次元配列（ヘッダー行含む）→ CC明細レコード配列。
  // 必須列不足時は { error: 'missing_columns', missing: [...] } を返す。
  function ccParseRows(rows) {
    if (!rows || rows.length === 0) return { error: 'empty', missing: [] };
    var headerIndex = ccFindHeaderRow(rows);
    if (headerIndex < 0) {
      var allMissing = [];
      for (var a = 0; a < CC_REQUIRED_COLUMNS.length; a++) allMissing.push(CC_REQUIRED_COLUMNS[a].header);
      return { error: 'missing_columns', missing: allMissing };
    }
    var mapped = ccMapColumns(rows[headerIndex]);
    if (mapped.missing.length > 0) {
      return { error: 'missing_columns', missing: mapped.missing, headerIndex: headerIndex };
    }
    var cols = mapped.columns;
    var records = [];
    for (var r = headerIndex + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var rec = {
        eventDate: normalizeCcEventDate(row[cols.eventDate]),
        scannableId: cellText(row[cols.scannableId]),
        destinationAddressId: cellText(row[cols.destinationAddressId]),
        transporterId: cellText(row[cols.transporterId]),
        shipmentReason: cellText(row[cols.shipmentReason]),
        callEvent: cellText(row[cols.callEvent]),
        textEvent: cellText(row[cols.textEvent])
      };
      // 必須列がすべて空の行（末尾の空行など）だけをスキップする
      var empty = true;
      for (var k in rec) {
        if (rec[k] !== '') { empty = false; break; }
      }
      if (empty) continue;
      records.push(rec);
    }
    return { records: records, headerIndex: headerIndex };
  }

  function isCcEligible(row) {
    return !!row && CC_ELIGIBLE_REASONS.indexOf(cellText(row.shipmentReason)) >= 0;
  }

  function hasCustomerContact(row) {
    return !!row && (cellText(row.callEvent) !== '' || cellText(row.textEvent) !== '');
  }

  function getCcStatus(row) {
    if (!isCcEligible(row)) return CC_STATUS.NOT_ELIGIBLE;
    return hasCustomerContact(row) ? CC_STATUS.COMPLIANT : CC_STATUS.NON_COMPLIANT;
  }

  // 0件は null（ゼロ除算しない）。戻り値は丸めない生の百分率。
  function calcCcRate(compliant, total) {
    if (!total || total <= 0) return null;
    return compliant / total * 100;
  }

  function formatCcRate(rate) {
    if (rate === null || rate === undefined || !isFinite(rate)) return '-';
    return rate.toFixed(2) + '%';
  }

  // CC_RATE_LEVEL_THRESHOLDS 未設定（現状）または rate=null のときは null（評価しない）
  function getCcRateLevel(rate, thresholds) {
    var list = thresholds === undefined ? CC_RATE_LEVEL_THRESHOLDS : thresholds;
    if (!list || rate === null || rate === undefined || !isFinite(rate)) return null;
    for (var i = 0; i < list.length; i++) {
      if (rate >= list[i].min) return list[i].level;
    }
    return null;
  }

  // Excel出力用: 画面表示（formatCcRate の toFixed(2)）と同じ小数2桁の数値。0件は null。
  function roundCcRate(rate) {
    if (rate === null || rate === undefined || !isFinite(rate)) return null;
    return parseFloat(rate.toFixed(2));
  }

  function getCcReasonLabel(reason) {
    var code = cellText(reason);
    return CC_REASON_LABELS_JA[code] || code;
  }

  function newCounter() {
    return { total: 0, compliant: 0, nonCompliant: 0, rate: null };
  }

  function addToCounter(counter, status) {
    if (status === CC_STATUS.NOT_ELIGIBLE) return;
    counter.total++;
    if (status === CC_STATUS.COMPLIANT) counter.compliant++;
    else counter.nonCompliant++;
  }

  function finishCounter(counter) {
    counter.rate = calcCcRate(counter.compliant, counter.total);
    return counter;
  }

  function calculateCcSummary(rows) {
    var summary = newCounter();
    summary.notEligible = 0;
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var status = getCcStatus(list[i]);
      if (status === CC_STATUS.NOT_ELIGIBLE) summary.notEligible++;
      else addToCounter(summary, status);
    }
    summary.logicVersion = CC_LOGIC_VERSION;
    return finishCounter(summary);
  }

  // CC_ELIGIBLE_REASONS の順で、0件の理由も含めて返す
  function groupCcByReason(rows) {
    var byReason = {};
    var out = [];
    for (var r = 0; r < CC_ELIGIBLE_REASONS.length; r++) {
      var c = newCounter();
      c.reason = CC_ELIGIBLE_REASONS[r];
      c.reasonLabel = getCcReasonLabel(c.reason);
      byReason[c.reason] = c;
      out.push(c);
    }
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var status = getCcStatus(list[i]);
      if (status === CC_STATUS.NOT_ELIGIBLE) continue;
      addToCounter(byReason[cellText(list[i].shipmentReason)], status);
    }
    for (var j = 0; j < out.length; j++) finishCounter(out[j]);
    return out;
  }

  function resolveCcDriverName(tid, resolveName) {
    var name = (tid && typeof resolveName === 'function') ? cellText(resolveName(tid)) : '';
    return name || CC_UNKNOWN_DA_LABEL;
  }

  // Transporter ID 単位。CC対象行が1件以上あるDAのみ。既定の並び = Non-Compliant 降順 → CC率昇順。
  function groupCcByDriver(rows, resolveName) {
    var byTid = {};
    var out = [];
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var status = getCcStatus(list[i]);
      if (status === CC_STATUS.NOT_ELIGIBLE) continue;
      var tid = cellText(list[i].transporterId);
      if (!byTid[tid]) {
        var c = newCounter();
        c.transporterId = tid;
        c.driverName = resolveCcDriverName(tid, resolveName);
        c.identified = c.driverName !== CC_UNKNOWN_DA_LABEL;
        byTid[tid] = c;
        out.push(c);
      }
      addToCounter(byTid[tid], status);
    }
    for (var j = 0; j < out.length; j++) finishCounter(out[j]);
    return sortCcDriverStats(out, 'nonCompliantDesc');
  }

  function compareRateAsc(a, b) {
    var ra = a.rate === null ? Infinity : a.rate;
    var rb = b.rate === null ? Infinity : b.rate;
    return ra - rb;
  }

  // mode: 'nonCompliantDesc' | 'rateAsc' | 'totalDesc'。元配列は変更しない。
  function sortCcDriverStats(list, mode) {
    var copy = (list || []).slice();
    copy.sort(function (a, b) {
      var d;
      if (mode === 'rateAsc') {
        d = compareRateAsc(a, b) || (b.nonCompliant - a.nonCompliant);
      } else if (mode === 'totalDesc') {
        d = (b.total - a.total) || (b.nonCompliant - a.nonCompliant);
      } else {
        d = (b.nonCompliant - a.nonCompliant) || compareRateAsc(a, b);
      }
      return d || (a.transporterId < b.transporterId ? -1 : (a.transporterId > b.transporterId ? 1 : 0));
    });
    return copy;
  }

  // Event Date 昇順
  function groupCcByDate(rows) {
    var byDate = {};
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var status = getCcStatus(list[i]);
      if (status === CC_STATUS.NOT_ELIGIBLE) continue;
      var date = cellText(list[i].eventDate);
      if (!byDate[date]) {
        byDate[date] = newCounter();
        byDate[date].eventDate = date;
      }
      addToCounter(byDate[date], status);
    }
    var keys = Object.keys(byDate).sort();
    var out = [];
    for (var j = 0; j < keys.length; j++) out.push(finishCounter(byDate[keys[j]]));
    return out;
  }

  // Non-Compliant 行のみ（Event Date → DA名 → Scannable ID 順）
  function listCcNonCompliant(rows, resolveName) {
    var out = [];
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (getCcStatus(row) !== CC_STATUS.NON_COMPLIANT) continue;
      out.push({
        eventDate: cellText(row.eventDate),
        driverName: resolveCcDriverName(cellText(row.transporterId), resolveName),
        transporterId: cellText(row.transporterId),
        scannableId: cellText(row.scannableId),
        destinationAddressId: cellText(row.destinationAddressId),
        shipmentReason: cellText(row.shipmentReason),
        shipmentReasonLabel: getCcReasonLabel(row.shipmentReason),
        callEvent: cellText(row.callEvent),
        textEvent: cellText(row.textEvent),
        status: CC_STATUS.NON_COMPLIANT,
        statusLabel: CC_STATUS_LABELS_JA.NON_COMPLIANT
      });
    }
    out.sort(function (a, b) {
      if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? -1 : 1;
      if (a.driverName !== b.driverName) return a.driverName < b.driverName ? -1 : 1;
      return a.scannableId < b.scannableId ? -1 : (a.scannableId > b.scannableId ? 1 : 0);
    });
    return out;
  }

  // 取込〜全集計をまとめて行う（UI/サーバー共通の入口）
  function analyzeCcRows(rows, resolveName) {
    var parsed = ccParseRows(rows);
    if (parsed.error) return parsed;
    var records = parsed.records;
    return {
      logicVersion: CC_LOGIC_VERSION,
      records: records,
      summary: calculateCcSummary(records),
      byReason: groupCcByReason(records),
      byDriver: groupCcByDriver(records, resolveName),
      byDate: groupCcByDate(records),
      nonCompliant: listCcNonCompliant(records, resolveName)
    };
  }

  // analyzeCcRows() の結果 → Excel 5シート分の行データ（配列の配列）。判定・集計は再実行しない。
  // CC率は roundCcRate の数値（buildCcExportWorkbook が表示形式 0.00"%" を付ける）。0件は '-'。
  // rateColumn / rateCells: CC率セルの位置（0始まり）。driverSort: DA別の並び（画面の選択と揃える）。
  function buildCcExportSheets(result, driverSort) {
    var s = result.summary;
    function rateCell(rate) {
      var v = roundCcRate(rate);
      return v === null ? '-' : v;
    }
    var reasonCodes = CC_ELIGIBLE_REASONS.slice();
    var reasonDesc = [];
    for (var rc = 0; rc < reasonCodes.length; rc++) reasonDesc.push(getCcReasonLabel(reasonCodes[rc]) + '(' + reasonCodes[rc] + ')');

    var summaryRows = [
      ['項目', '値'],
      ['Logic Version', CC_LOGIC_LABEL],
      ['CC率', rateCell(s.rate)],
      ['CC対象件数', s.total],
      ['Compliant件数', s.compliant],
      ['Non-Compliant件数', s.nonCompliant],
      ['取込行数', result.records.length],
      ['対象外行数', s.notEligible],
      ['対象理由', reasonDesc.join(' / ')],
      ['判定条件', 'Call Event または Text Event が存在 = Compliant（両方あっても1件）'],
      ['集計単位', 'Amazonファイルの対象行1行 = 1件（dedupeなし）']
    ];

    var reasonRows = [['配送理由', 'Shipment Reason', '対象件数', 'Compliant', 'Non-Compliant', 'CC率']];
    for (var i = 0; i < result.byReason.length; i++) {
      var r = result.byReason[i];
      reasonRows.push([r.reasonLabel, r.reason, r.total, r.compliant, r.nonCompliant, rateCell(r.rate)]);
    }

    var driverRows = [['DA名', 'Transporter ID', '対象件数', 'Compliant', 'Non-Compliant', 'CC率']];
    var drivers = sortCcDriverStats(result.byDriver, driverSort || 'nonCompliantDesc');
    for (var d = 0; d < drivers.length; d++) {
      var ds = drivers[d];
      driverRows.push([ds.driverName, ds.transporterId, ds.total, ds.compliant, ds.nonCompliant, rateCell(ds.rate)]);
    }

    var dateRows = [['Event Date', '対象件数', 'Compliant', 'Non-Compliant', 'CC率']];
    for (var t = 0; t < result.byDate.length; t++) {
      var dr = result.byDate[t];
      dateRows.push([dr.eventDate, dr.total, dr.compliant, dr.nonCompliant, rateCell(dr.rate)]);
    }

    var ncRows = [['Event Date', 'DA名', 'Transporter ID', 'Scannable ID', 'Destination Address ID',
      'Shipment Reason', '配送理由（日本語）', 'Call Event', 'Text Event', '判定']];
    for (var n = 0; n < result.nonCompliant.length; n++) {
      var nc = result.nonCompliant[n];
      ncRows.push([nc.eventDate, nc.driverName, nc.transporterId, nc.scannableId, nc.destinationAddressId,
        nc.shipmentReason, nc.shipmentReasonLabel, nc.callEvent, nc.textEvent, 'Non-Compliant']);
    }

    return [
      { name: 'CCサマリー', rows: summaryRows, rateCells: [[2, 1]], widths: [20, 60] },
      { name: '理由別', rows: reasonRows, rateColumn: 5, widths: [20, 34, 10, 12, 14, 10] },
      { name: 'DA別', rows: driverRows, rateColumn: 5, widths: [22, 18, 10, 12, 14, 10] },
      { name: '日別', rows: dateRows, rateColumn: 4, widths: [14, 10, 12, 14, 10] },
      { name: 'Non-Compliant明細', rows: ncRows, widths: [12, 22, 18, 16, 22, 32, 20, 18, 18, 14] }
    ];
  }

  var CC_RATE_NUMBER_FORMAT = '0.00"%"';

  // buildCcExportSheets → SheetJS ワークブック。XLSX はブラウザのグローバル / Node の require('xlsx') を渡す。
  function buildCcExportWorkbook(XLSX, result, driverSort) {
    var wb = XLSX.utils.book_new();
    var sheets = buildCcExportSheets(result, driverSort);
    for (var i = 0; i < sheets.length; i++) {
      var sh = sheets[i];
      var ws = XLSX.utils.aoa_to_sheet(sh.rows);
      var cells = (sh.rateCells || []).slice();
      if (sh.rateColumn !== undefined) {
        for (var r = 1; r < sh.rows.length; r++) cells.push([r, sh.rateColumn]);
      }
      for (var c = 0; c < cells.length; c++) {
        var cell = ws[XLSX.utils.encode_cell({ r: cells[c][0], c: cells[c][1] })];
        if (cell && cell.t === 'n') cell.z = CC_RATE_NUMBER_FORMAT;
      }
      var cols = [];
      for (var w = 0; w < sh.widths.length; w++) cols.push({ wch: sh.widths[w] });
      ws['!cols'] = cols;
      XLSX.utils.book_append_sheet(wb, ws, sh.name);
    }
    return wb;
  }

  var ContactComplianceCore = {
    CC_LOGIC_VERSION: CC_LOGIC_VERSION,
    CC_ELIGIBLE_REASONS: CC_ELIGIBLE_REASONS,
    CC_REASON_LABELS_JA: CC_REASON_LABELS_JA,
    CC_STATUS: CC_STATUS,
    CC_STATUS_LABELS_JA: CC_STATUS_LABELS_JA,
    CC_UNKNOWN_DA_LABEL: CC_UNKNOWN_DA_LABEL,
    CC_LOGIC_LABEL: CC_LOGIC_LABEL,
    CC_RATE_LEVEL_THRESHOLDS: CC_RATE_LEVEL_THRESHOLDS,
    CC_REQUIRED_COLUMNS: CC_REQUIRED_COLUMNS,
    normalizeCcHeader: normalizeCcHeader,
    ccMapColumns: ccMapColumns,
    ccFindHeaderRow: ccFindHeaderRow,
    normalizeCcEventDate: normalizeCcEventDate,
    ccParseRows: ccParseRows,
    isCcEligible: isCcEligible,
    hasCustomerContact: hasCustomerContact,
    getCcStatus: getCcStatus,
    calcCcRate: calcCcRate,
    formatCcRate: formatCcRate,
    getCcRateLevel: getCcRateLevel,
    roundCcRate: roundCcRate,
    buildCcExportSheets: buildCcExportSheets,
    buildCcExportWorkbook: buildCcExportWorkbook,
    getCcReasonLabel: getCcReasonLabel,
    calculateCcSummary: calculateCcSummary,
    groupCcByReason: groupCcByReason,
    resolveCcDriverName: resolveCcDriverName,
    groupCcByDriver: groupCcByDriver,
    sortCcDriverStats: sortCcDriverStats,
    groupCcByDate: groupCcByDate,
    listCcNonCompliant: listCcNonCompliant,
    analyzeCcRows: analyzeCcRows
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ContactComplianceCore;
  }
  if (typeof global !== 'undefined') {
    global.ContactComplianceCore = ContactComplianceCore;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
