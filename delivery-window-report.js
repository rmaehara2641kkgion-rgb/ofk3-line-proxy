/**
 * OFK3 delivery-window ingest + report (Phase 3) - pure functions, no file/DOM access.
 *
 * ingest():     SearchResults CSV text + elimination workbook (SheetJS) -> table + error list
 * summaries:    one primary reason per target ID (sum == target count), all reasons kept
 * scenarios:    side-by-side counts under different analysis settings. Scenarios are ANALYSIS
 *               ONLY; the production condition is the first scenario ("current") and is never
 *               relaxed by this module.
 * CSV builders: return strings; writing files is the caller's job (see scripts/).
 * ES5, no template literals, no logging.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./delivery-window-core.js'));
  } else {
    root.DeliveryWindowReport = factory(root.DeliveryWindowCore);
  }
}(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  var DEFAULT_SHEET = 'エリミネーション報告';
  var BOM = '﻿';

  // Japanese labels for the report (code -> label)
  var REASON_LABEL = {
    ok: '読み上げ可能',
    not_found: 'どちらにも無い',
    not_in_elimi: 'SearchResultsのみ(エリミ未掲載)',
    not_in_sr: 'SearchResultsに無い',
    ambiguous_scan: 'スキャン値が曖昧',
    dup_cycle_elimi: 'エリミでCycle重複',
    dup_conflict_sr: 'SearchResults重複で内容が不一致',
    time_blank: '時間欄が空欄',
    time_partial: '開始/終了の片方のみ',
    time_invalid: '時刻が不正',
    date_span: '開始日と終了日が異なる',
    date_promised_missing: '約束日が空欄/不正',
    date_mismatch: '約束日と時間帯の日付が不一致',
    date_out_of_range: '基準日から当日・翌日の範囲外',
    date_ref_missing: '基準日なし',
    conflict_elimi: 'エリミ見出しと時間帯が不一致'
  };

  /** Primary-reason display order (same as the evaluation order). */
  var REASON_ORDER = ['ok', 'not_found', 'not_in_elimi', 'not_in_sr', 'dup_cycle_elimi', 'dup_conflict_sr',
    'time_blank', 'time_partial', 'time_invalid', 'date_span', 'date_promised_missing', 'date_mismatch',
    'date_out_of_range', 'date_ref_missing', 'conflict_elimi'];

  function sheetToAoa(XLSX, workbook, sheetName) {
    var ws = workbook && workbook.Sheets && workbook.Sheets[sheetName];
    if (!ws) return null;
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  }

  /**
   * ingest({ srText, XLSX, workbook, sheetName?, options?, loadedAt? })
   * -> { ok, errors:[{code,detail}], warnings:[...], table|null, input:{srRows,elimiRecords,reportDate}, stats }
   * Any structural error returns table:null: a half-valid table is never produced.
   */
  function ingest(args) {
    var errors = [], warnings = [];
    var sr = Core.parseSearchResults(args.srText);
    if (!sr.ok) errors.push({ code: 'sr_' + sr.error, detail: sr.missingColumns.join(', ') });
    var sheetName = args.sheetName || DEFAULT_SHEET;
    var aoa = args.workbook ? sheetToAoa(args.XLSX, args.workbook, sheetName) : null;
    var el = null;
    if (!args.workbook) errors.push({ code: 'elimi_no_workbook', detail: '' });
    else if (!aoa) errors.push({ code: 'elimi_sheet_missing', detail: sheetName });
    else {
      el = Core.parseElimiCycleSheet(aoa, { sheetName: sheetName });
      if (!el.ok) errors.push({ code: 'elimi_' + el.error, detail: sheetName });
      else {
        if (!el.reportDate) warnings.push({ code: 'elimi_report_date_missing', detail: '' });
        if (el.invalidCells) warnings.push({ code: 'elimi_invalid_id_cells', detail: String(el.invalidCells) });
      }
    }
    if (errors.length) return { ok: false, errors: errors, warnings: warnings, table: null, input: null, stats: null };
    if (sr.blankIdRows) warnings.push({ code: 'sr_blank_id_rows', detail: String(sr.blankIdRows) });
    var input = { srRows: sr.rows, elimiRecords: el.records, reportDate: el.reportDate, loadedAt: args.loadedAt || null };
    var table = Core.buildTable(input, args.options || {});
    return { ok: true, errors: errors, warnings: warnings, table: table, input: input,
      stats: { srRows: sr.rowCount, elimiRecords: el.records.length, sections: el.sections } };
  }

  // ------------------------------------------------------------------ summaries
  function targetResults(table) {
    var out = [], i;
    for (i = 0; i < table.all.length; i++) if (table.all[i].cycles.length) out.push(table.all[i]);
    return out;
  }

  function primaryKey(r) { return r.status === 'unknown' ? r.reason : 'ok'; }

  /** One primary reason per target ID. Returns { total, counts:{key:n}, anyCounts:{key:n} } */
  function reasonSummary(table) {
    var res = targetResults(table), counts = {}, any = {}, i, j;
    for (i = 0; i < res.length; i++) {
      var k = primaryKey(res[i]);
      counts[k] = (counts[k] || 0) + 1;
      var seen = {};
      for (j = 0; j < res[i].allReasons.length; j++) {
        var q = res[i].allReasons[j];
        if (!seen[q]) { seen[q] = true; any[q] = (any[q] || 0) + 1; }
      }
    }
    return { total: res.length, counts: counts, anyCounts: any };
  }

  var SCENARIOS = [
    { name: 'current', label: '現行(本番条件)', options: {} },
    { name: 'heading_off', label: '見出し比較なし', options: { headingCheck: false } },
    { name: 'date_range_off', label: '当日/翌日制限なし', options: { dateRange: null } },
    { name: 'heading_and_range_off', label: '見出し比較なし+日付制限なし', options: { headingCheck: false, dateRange: null } }
  ];

  /**
   * Re-builds the table for each scenario. Scenarios only toggle headingCheck / dateRange; every
   * other safety condition (blank time, date mismatch, duplicates, ...) is identical in all.
   */
  function compareScenarios(input, baseOptions, scenarios) {
    var list = scenarios || SCENARIOS, out = [], i, base = baseOptions || {};
    for (i = 0; i < list.length; i++) {
      var o = {}, k;
      for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) o[k] = base[k];
      for (k in list[i].options) if (Object.prototype.hasOwnProperty.call(list[i].options, k)) o[k] = list[i].options[k];
      var t = Core.buildTable(input, o);
      var s = reasonSummary(t);
      out.push({ name: list[i].name, label: list[i].label, total: s.total, readable: s.counts.ok || 0, counts: s.counts, table: t });
    }
    return out;
  }

  // ------------------------------------------------------------------ CSV
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvRow(a) { return a.map(csvCell).join(','); }
  function csv(rows) { return BOM + rows.map(csvRow).join('\r\n') + '\r\n'; }

  /** reason,label,count,share_pct,also_has (count of IDs that have the reason at all) - sum(count) == total */
  function summaryCsv(table) {
    var s = reasonSummary(table), rows = [['primary_reason', 'label', 'count', 'share_pct', 'ids_with_this_reason_any']], i, sum = 0;
    for (i = 0; i < REASON_ORDER.length; i++) {
      var k = REASON_ORDER[i], n = s.counts[k] || 0;
      if (!n && !(s.anyCounts[k])) continue;
      sum += n;
      rows.push([k, REASON_LABEL[k] || k, n, s.total ? (Math.round(n / s.total * 1000) / 10) : 0, k === 'ok' ? '' : (s.anyCounts[k] || 0)]);
    }
    rows.push(['TOTAL', '', sum, s.total ? 100 : 0, '']);
    return csv(rows);
  }

  /** One row per ID (targets first, then SearchResults-only IDs). */
  function itemsCsv(table) {
    var rows = [['scope', 'tracking_id', 'cycles', 'status', 'primary_reason', 'all_reasons', 'sr_start', 'sr_end', 'sr_promised', 'window_date', 'day_offset', 'heading_differs', 'speech']];
    var tgt = [], other = [], i, r;
    for (i = 0; i < table.all.length; i++) (table.all[i].cycles.length ? tgt : other).push(table.all[i]);
    function line(scope, r) {
      return [scope, r.id, r.cycles.join('+'), r.status, r.status === 'unknown' ? r.reason : 'ok', r.allReasons.join('|'),
        r.srStart || '', r.srEnd || '', r.srPromised || '', r.date || '', r.dayOffset === undefined ? '' : r.dayOffset,
        r.headingDiffers ? 'yes' : '', r.status === 'window' ? r.speech : (r.status === 'no_window' ? Core.SPEECH_NO_WINDOW : '')];
    }
    for (i = 0; i < tgt.length; i++) rows.push(line('elimi_target', tgt[i]));
    for (i = 0; i < other.length; i++) { r = other[i]; rows.push(line('sr_only', r)); }
    return csv(rows);
  }

  /** scenario x reason count matrix, plus readable count. */
  function scenarioCsv(results) {
    var keys = REASON_ORDER.slice(), head = ['scenario', 'label', 'total'], i, j;
    for (i = 0; i < keys.length; i++) head.push(keys[i]);
    var rows = [head];
    for (j = 0; j < results.length; j++) {
      var row = [results[j].name, results[j].label, results[j].total];
      for (i = 0; i < keys.length; i++) row.push(results[j].counts[keys[i]] || 0);
      rows.push(row);
    }
    return csv(rows);
  }

  /** Items whose primary reason changes between two scenario results: [{from,to,count}] */
  function transitions(a, b) {
    var out = {}, i;
    for (i = 0; i < a.table.all.length; i++) {
      var x = a.table.all[i];
      if (!x.cycles.length) continue;
      var y = b.table.byId[x.id];
      var kx = primaryKey(x), ky = primaryKey(y);
      if (kx !== ky) { var key = kx + ' -> ' + ky; out[key] = (out[key] || 0) + 1; }
    }
    return out;
  }

  /** Counts only; safe to show or log (no IDs, no times). */
  function errorSummary(ing) {
    return { ok: ing.ok, errors: ing.errors, warnings: ing.warnings, stats: ing.stats && { srRows: ing.stats.srRows, elimiRecords: ing.stats.elimiRecords },
      report: ing.table ? ing.table.report : null };
  }

  return {
    DEFAULT_SHEET: DEFAULT_SHEET, SCENARIOS: SCENARIOS, REASON_ORDER: REASON_ORDER, REASON_LABEL: REASON_LABEL,
    ingest: ingest, reasonSummary: reasonSummary, compareScenarios: compareScenarios, transitions: transitions,
    summaryCsv: summaryCsv, itemsCsv: itemsCsv, scenarioCsv: scenarioCsv, errorSummary: errorSummary, csv: csv
  };
}));
