/**
 * OFK3 delivery-window core (Phase 2/3) - pure functions.
 *
 * Scan value -> Tracking ID -> delivery time window, by joining
 *   (A) Elimination report (cycle sections)   -- target set, section heading hints
 *   (B) Amazon SCC SearchResults CSV          -- Scheduled Delivery Start/End, Promised Delivery Date
 *
 * Rules (see docs/DELIVERY_WINDOW_SPEC.md):
 *  - A window is spoken only when it is positively confirmed. Everything else is "unknown"
 *    (spoken as the unknown phrase). Blank time fields NEVER mean "no time window".
 *  - "no_window" is reachable only through opts.noWindowEvidence (no evidence exists today).
 *  - When the two sources contradict, neither is trusted: recorded as a conflict, not spoken.
 *  - Date inconsistencies are excluded from speaking until verified.
 *
 * No network, no storage, no DOM, no Date/clock, no logging of delivery data. ES5 only,
 * no template literals (Edge IE-mode compatible).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DeliveryWindowCore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.1';

  var STATUS = { WINDOW: 'window', NO_WINDOW: 'no_window', UNKNOWN: 'unknown' };

  var REASON = {
    OK: 'ok',
    NOT_FOUND: 'not_found',             // scan value maps to no known ID
    AMBIGUOUS_SCAN: 'ambiguous_scan',   // scan value holds several ID-shaped tokens
    NOT_IN_ELIMI: 'not_in_elimi',
    NOT_IN_SR: 'not_in_sr',
    TIME_BLANK: 'time_blank',
    TIME_PARTIAL: 'time_partial',
    TIME_INVALID: 'time_invalid',
    DUP_CONFLICT_SR: 'dup_conflict_sr',
    DUP_CYCLE_ELIMI: 'dup_cycle_elimi',
    CONFLICT_ELIMI: 'conflict_elimi',
    DATE_MISMATCH: 'date_mismatch',     // window date != Promised Delivery Date
    DATE_SPAN: 'date_span',             // start date != end date
    DATE_PROMISED_MISSING: 'date_promised_missing',
    DATE_OUT_OF_RANGE: 'date_out_of_range',
    DATE_REF_MISSING: 'date_ref_missing'
  };

  var SPEECH_UNKNOWN = '確認できません！';
  var SPEECH_NO_WINDOW = '時間指定なし！';

  var SR_REQUIRED = [
    'Tracking ID',
    'Scheduled Delivery Start Time',
    'Scheduled Delivery End Time',
    'Promised Delivery Date'
  ];

  var ID_RE_FULL = /^[A-Z]{2}\d{10}$/;

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ------------------------------------------------------------------ CSV
  /** RFC4180-ish parser. Returns array of rows (arrays of strings). Strips a leading BOM. */
  function parseCsv(text) {
    var s = str(text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.substring(1);
    var rows = [], row = [], field = '', inQ = false, i = 0, n = s.length, c;
    while (i < n) {
      c = s.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQ = false; i += 1; continue;
        }
        field += c; i += 1; continue;
      }
      if (c === '"') { inQ = true; i += 1; continue; }
      if (c === ',') { row.push(field); field = ''; i += 1; continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && s.charAt(i + 1) === '\n') i += 1;
        row.push(field); field = ''; rows.push(row); row = []; i += 1; continue;
      }
      field += c; i += 1;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /**
   * SearchResults CSV text -> { ok, error, missingColumns, rows:[{id,start,end,promised,updated}], rowCount }
   * Extra columns are ignored. Rows with an empty Tracking ID are counted, not kept.
   */
  function parseSearchResults(text) {
    var grid = parseCsv(text);
    if (!grid.length) return { ok: false, error: 'empty', missingColumns: SR_REQUIRED.slice(), rows: [], rowCount: 0 };
    var head = grid[0].map(function (h) { return str(h).replace(/^\s+|\s+$/g, ''); });
    var idx = {}, i;
    for (i = 0; i < head.length; i++) if (!has(idx, head[i])) idx[head[i]] = i;
    var missing = SR_REQUIRED.filter(function (k) { return !has(idx, k); });
    if (missing.length) return { ok: false, error: 'missing_columns', missingColumns: missing, rows: [], rowCount: 0 };
    var out = [], blankId = 0;
    var ci = idx['Last Updated Time'];
    for (i = 1; i < grid.length; i++) {
      var r = grid[i];
      if (r.length === 1 && r[0] === '') continue; // blank line
      var id = normalizeId(r[idx['Tracking ID']]);
      if (!id) { blankId += 1; continue; }
      out.push({
        id: id,
        start: str(r[idx['Scheduled Delivery Start Time']]).replace(/^\s+|\s+$/g, ''),
        end: str(r[idx['Scheduled Delivery End Time']]).replace(/^\s+|\s+$/g, ''),
        promised: str(r[idx['Promised Delivery Date']]).replace(/^\s+|\s+$/g, ''),
        updated: ci === undefined ? '' : str(r[ci]).replace(/^\s+|\s+$/g, '')
      });
    }
    return { ok: true, error: null, missingColumns: [], rows: out, rowCount: out.length, blankIdRows: blankId };
  }

  // ------------------------------------------------------------------ scan value / ID
  function toHalfWidth(s) {
    return s.replace(/[！-～]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .replace(/　/g, ' ');
  }

  /** Normalise a stored/scanned value: half-width, trim, upper-case, control chars removed. */
  function normalizeId(v) {
    var s = toHalfWidth(str(v)).replace(/[\u0000-\u001F\u007F]/g, '');
    return s.replace(/^\s+|\s+$/g, '').toUpperCase();
  }

  /**
   * Resolve a raw scan value to a Tracking ID candidate.
   *  1. exact (after normalisation) -> kind 'exact'
   *  2. a configured literal prefix/suffix stripped, remainder is exactly an ID -> 'affix'
   *  3. exactly one ID-shaped token delimited by non-alphanumerics -> 'embedded'
   * Never matches an ID glued to other letters/digits ("XDA0000000001", "DA00000000013",
   * a truncated "DA000000000"), and never picks one of several tokens.
   * Returns { id|null, kind: 'exact'|'affix'|'embedded'|'none'|'ambiguous', raw length only }.
   */
  function resolveScan(raw, opts) {
    var v = normalizeId(raw);
    if (!v) return { id: null, kind: 'none' };
    if (ID_RE_FULL.test(v)) return { id: v, kind: 'exact' };
    var affixes = (opts && opts.allowedAffixes) || [];
    var i, a;
    for (i = 0; i < affixes.length; i++) {
      a = normalizeId(affixes[i]);
      if (!a) continue;
      if (v.indexOf(a) === 0 && ID_RE_FULL.test(v.substring(a.length))) return { id: v.substring(a.length), kind: 'affix' };
      if (v.length > a.length && v.lastIndexOf(a) === v.length - a.length && ID_RE_FULL.test(v.substring(0, v.length - a.length))) {
        return { id: v.substring(0, v.length - a.length), kind: 'affix' };
      }
    }
    var re = /(^|[^A-Z0-9])([A-Z]{2}\d{10})(?![A-Z0-9])/g, m, found = [];
    while ((m = re.exec(v)) !== null) {
      if (found.indexOf(m[2]) < 0) found.push(m[2]);
      re.lastIndex = m.index + m[1].length + m[2].length;
    }
    if (found.length === 1) return { id: found[0], kind: 'embedded' };
    if (found.length > 1) return { id: null, kind: 'ambiguous' };
    return { id: null, kind: 'none' };
  }

  // ------------------------------------------------------------------ time / date
  var TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

  /**
   * "YYYY-MM-DD HH:MM[:SS]" (wall clock, no zone) -> {date, min} or null.
   * Any zone suffix (Z, +09:00 ...) makes it invalid on purpose: the zone would be guessed.
   * Seconds are dropped (23:59:59 -> 23:59).
   */
  function parseTimestamp(s) {
    var m = TS_RE.exec(str(s));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = m[6] === undefined ? 0 : +m[6];
    if (!validDate(y, mo, d) || h > 23 || mi > 59 || se > 59) return null;
    return { date: m[1] + '-' + m[2] + '-' + m[3], min: h * 60 + mi };
  }

  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return false;
    var dim = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= dim[m - 1];
  }

  /** "YYYY-MM-DD" strict -> same string, else null. */
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s).replace(/^\s+|\s+$/g, ''));
    if (!m || !validDate(+m[1], +m[2], +m[3])) return null;
    return m[0];
  }

  function dayNumber(iso) {
    var p = iso.split('-');
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function dayDiff(a, b) { return dayNumber(a) - dayNumber(b); }

  function fmtClock(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return m === 0 ? (h + '時') : (h + '時' + m + '分');
  }
  /** Speech from data only: 480,720 -> "8時から12時！"; 1080,1439 -> "18時から23時59分！" */
  function windowSpeech(startMin, endMin) {
    return fmtClock(startMin) + 'から' + fmtClock(endMin) + '！';
  }
  function fmtHm(min) { return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60); }

  // ------------------------------------------------------------------ elimination report
  function toIsoFromCell(v) {
    if (v === null || v === undefined || v === '') return null;
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
      var t = new Date(v.getTime() + 12 * 3600 * 1000); // +12h: keeps the calendar day for midnight in +-12h zones
      return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
    }
    if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial
      var d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    var m = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(str(v));
    if (m && validDate(+m[1], +m[2], +m[3])) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
    return null;
  }

  function normHeading(s) {
    return toHalfWidth(str(s)).replace(/[‐-―−－ー]/g, '-').replace(/[～〜~]/g, '-');
  }

  /**
   * Section heading -> expectation. A heading that lists several categories ("AM指定・14-16指定・BC")
   * is MIXED: it can never be used to claim a contradiction.
   * Single category with one hour range ("16-18時指定") -> expected [[960,1080]].
   * Returns { mixed:boolean, expected: [[startMin,endMin]]|null }
   */
  function parseHeadingExpectation(heading) {
    var h = normHeading(heading).replace(/^\s+|\s+$/g, '');
    if (!h) return { mixed: false, expected: null };
    var cats = h.split(/[・,、\/\s]+/).filter(function (x) { return x !== ''; });
    if (cats.length > 1) return { mixed: true, expected: null };
    var m = /^(\d{1,2})-(\d{1,2})時?/.exec(h);
    if (m && +m[1] < +m[2] && +m[2] <= 24) return { mixed: false, expected: [[+m[1] * 60, +m[2] * 60]] };
    return { mixed: false, expected: null };
  }

  /**
   * Cycle-section parser for the sheet "エリミネーション報告" (array-of-arrays, header:1 style).
   * Layout it understands: a row holding "Cycle<N>" cells; the row below holds each section's
   * heading in the same column; a few rows further down a row labelled トラッキングID / TRID
   * gives the ID column; IDs follow until the sheet ends.
   * Returns { ok, error, records:[{id,cycle,heading,mixed,expected,row}], reportDate, invalidCells, sections }
   */
  function parseElimiCycleSheet(aoa, opts) {
    var sheetName = (opts && opts.sheetName) || '';
    var rows = aoa || [];
    var reportDate = null, r, c;
    for (r = 0; r < Math.min(rows.length, 15) && !reportDate; r++) {
      for (c = 0; c < (rows[r] || []).length; c++) {
        if (str(rows[r][c]).replace(/\s/g, '') === '日付') { reportDate = toIsoFromCell(rows[r][c + 1]) || toIsoFromCell(rows[r][c + 2]); break; }
      }
    }
    var sections = [];
    for (r = 0; r < Math.min(rows.length, 30); r++) {
      var row = rows[r] || [];
      for (c = 0; c < row.length; c++) {
        var cyc = /^Cycle\s*(\d+)$/i.exec(str(row[c]).replace(/^\s+|\s+$/g, ''));
        if (!cyc) continue;
        var heading = str((rows[r + 1] || [])[c]).replace(/^\s+|\s+$/g, '');
        var idCol = -1, hdrRow = -1, k, cc;
        for (k = r + 1; k <= r + 4 && idCol < 0; k++) {
          for (cc = c; cc <= c + 3; cc++) {
            if (/^(トラッキング\s*ID|TRID|Tracking\s*ID)$/i.test(str((rows[k] || [])[cc]).replace(/\s/g, ''))) { idCol = cc; hdrRow = k; break; }
          }
        }
        if (idCol < 0) return { ok: false, error: 'id_header_not_found', records: [], reportDate: reportDate, invalidCells: 0, sections: [] };
        var exp = parseHeadingExpectation(heading);
        sections.push({ cycle: 'Cycle' + cyc[1], heading: heading, idCol: idCol, hdrRow: hdrRow, mixed: exp.mixed, expected: exp.expected });
      }
    }
    if (!sections.length) return { ok: false, error: 'cycle_sections_not_found', records: [], reportDate: reportDate, invalidCells: 0, sections: [] };
    var records = [], invalid = 0, si;
    for (si = 0; si < sections.length; si++) {
      var sec = sections[si];
      for (r = sec.hdrRow + 1; r < rows.length; r++) {
        var v = (rows[r] || [])[sec.idCol];
        if (v === null || v === undefined || str(v).replace(/\s/g, '') === '') continue;
        var id = normalizeId(v);
        if (ID_RE_FULL.test(id)) {
          records.push({ id: id, cycle: sec.cycle, heading: sec.heading, mixed: sec.mixed, expected: sec.expected, sheet: sheetName, row: r + 1 });
        } else {
          invalid += 1;
        }
      }
    }
    return { ok: true, error: null, records: records, reportDate: reportDate, invalidCells: invalid,
      sections: sections.map(function (s) { return { cycle: s.cycle, heading: s.heading, mixed: s.mixed, expected: s.expected }; }) };
  }

  // ------------------------------------------------------------------ table
  function srRowInfo(r) {
    var blankS = r.start === '', blankE = r.end === '';
    var info = { start: r.start, end: r.end, promised: r.promised, kind: 'ok', s: null, e: null };
    if (blankS && blankE) { info.kind = 'blank'; return info; }
    if (blankS || blankE) { info.kind = 'partial'; return info; }
    var s = parseTimestamp(r.start), e = parseTimestamp(r.end);
    if (!s || !e) { info.kind = 'invalid'; return info; }
    info.s = s; info.e = e;
    if (s.date === e.date && s.min >= e.min) info.kind = 'invalid';
    return info;
  }

  function sameWindow(a, b) {
    return a.start === b.start && a.end === b.end && a.promised === b.promised;
  }

  function mkResult(id, status, reason, extra) {
    var o = { id: id, status: status, reason: reason, speech: status === STATUS.WINDOW ? null : (status === STATUS.NO_WINDOW ? SPEECH_NO_WINDOW : SPEECH_UNKNOWN) };
    if (extra) for (var k in extra) if (has(extra, k)) o[k] = extra[k];
    return o;
  }

  /**
   * Collects EVERY applicable problem (allReasons, in priority order). The first one is the
   * primary reason. Status is window only when there is no problem at all; no_window only when
   * the sole problem is a blank time and opts.noWindowEvidence(...) === true.
   */
  function resolveOne(id, sr, el, ctx) {
    var opts = ctx.opts, reasons = [], extra = { cycles: el ? el.cycles : [] }, i;
    var cycles = extra.cycles;
    if (!sr && !el) return finish(id, [REASON.NOT_FOUND], extra, ctx);
    if (!el && opts.requireElimi) reasons.push(REASON.NOT_IN_ELIMI);
    if (!sr) { reasons.push(REASON.NOT_IN_SR); return finish(id, reasons, extra, ctx); }
    if (el && el.cycles.length > 1) reasons.push(REASON.DUP_CYCLE_ELIMI);
    var first = sr.rows[0];
    for (i = 1; i < sr.rows.length; i++) {
      if (!sameWindow(first, sr.rows[i])) { reasons.push(REASON.DUP_CONFLICT_SR); break; }
    }
    extra.srStart = first.start; extra.srEnd = first.end; extra.srPromised = first.promised;
    var timeOk = false;
    if (first.kind === 'blank') reasons.push(REASON.TIME_BLANK);
    else if (first.kind === 'partial') reasons.push(REASON.TIME_PARTIAL);
    else if (first.kind === 'invalid') reasons.push(REASON.TIME_INVALID);
    else timeOk = true;
    if (timeOk) {
      var s = first.s, e = first.e;
      var promised = parseDate(first.promised);
      extra.startMin = s.min; extra.endMin = e.min; extra.date = s.date;
      if (s.date !== e.date) reasons.push(REASON.DATE_SPAN);
      if (!promised) reasons.push(REASON.DATE_PROMISED_MISSING);
      else if (s.date !== promised) reasons.push(REASON.DATE_MISMATCH);
      if (opts.dateRange) {
        if (!ctx.referenceDate) reasons.push(REASON.DATE_REF_MISSING);
        else {
          extra.dayOffset = dayDiff(s.date, ctx.referenceDate);
          if (extra.dayOffset < opts.dateRange.min || extra.dayOffset > opts.dateRange.max) reasons.push(REASON.DATE_OUT_OF_RANGE);
        }
      }
      if (el && el.expected && el.expected.length) {
        var match = false;
        for (i = 0; i < el.expected.length; i++) if (el.expected[i][0] === s.min && el.expected[i][1] === e.min) match = true;
        if (!match) {
          extra.expectedFromHeading = el.expected;
          extra.headingDiffers = true;
          if (opts.headingCheck) reasons.push(REASON.CONFLICT_ELIMI);
        }
      }
    }
    if (reasons.length === 1 && reasons[0] === REASON.TIME_BLANK && typeof opts.noWindowEvidence === 'function' &&
        opts.noWindowEvidence({ id: id, promised: first.promised, cycles: cycles.slice() }) === true) {
      return finish(id, [], extra, ctx, true);
    }
    return finish(id, reasons, extra, ctx);
  }

  function finish(id, reasons, extra, ctx, noWindow) {
    var o;
    if (noWindow) o = mkResult(id, STATUS.NO_WINDOW, REASON.OK, extra);
    else if (reasons.length) o = mkResult(id, STATUS.UNKNOWN, reasons[0], extra);
    else {
      extra.speech = windowSpeech(extra.startMin, extra.endMin);
      extra.startText = fmtHm(extra.startMin);
      extra.endText = fmtHm(extra.endMin);
      o = mkResult(id, STATUS.WINDOW, REASON.OK, extra);
    }
    o.allReasons = reasons.slice();
    return o;
  }

  /**
   * buildTable({srRows, elimiRecords, reportDate, loadedAt}, opts) -> table
   * opts: requireElimi (default true), dateRange {min,max} day offsets vs referenceDate
   *       (default {0,1}; null disables), referenceDate (default reportDate), noWindowEvidence(fn),
   *       allowedAffixes (scan prefixes/suffixes), headingCheck (default true: section-heading
 *       vs SearchResults contradiction check; false = analysis only, see spec)
   */
  function buildTable(input, options) {
    var o = options || {};
    var opts = {
      requireElimi: o.requireElimi === false ? false : true,
      dateRange: o.dateRange === null ? null : (o.dateRange || { min: 0, max: 1 }),
      headingCheck: o.headingCheck === false ? false : true,
      noWindowEvidence: o.noWindowEvidence || null,
      allowedAffixes: o.allowedAffixes || []
    };
    var referenceDate = o.referenceDate || input.reportDate || null;
    var srMap = Object.create(null), elMap = Object.create(null), srOrder = [], elOrder = [];
    var srRows = input.srRows || [], elRecs = input.elimiRecords || [], i, id;
    var lastUpdated = '';
    for (i = 0; i < srRows.length; i++) {
      var r = srRows[i];
      id = r.id;
      if (!srMap[id]) { srMap[id] = { rows: [] }; srOrder.push(id); }
      srMap[id].rows.push(srRowInfo(r));
      if (r.updated && r.updated > lastUpdated) lastUpdated = r.updated;
    }
    for (i = 0; i < elRecs.length; i++) {
      var rec = elRecs[i];
      id = rec.id;
      if (!elMap[id]) { elMap[id] = { cycles: [], expected: null, count: 0, mixed: false }; elOrder.push(id); }
      var e = elMap[id];
      e.count += 1;
      if (e.cycles.indexOf(rec.cycle) < 0) e.cycles.push(rec.cycle);
      if (rec.expected && !e.expected) e.expected = rec.expected;
      if (rec.mixed) e.mixed = true;
    }
    var byId = Object.create(null), all = [], ctx = { opts: opts, referenceDate: referenceDate };
    var seen = Object.create(null);
    var ids = elOrder.concat(srOrder.filter(function (x) { return !elMap[x]; }));
    for (i = 0; i < ids.length; i++) {
      id = ids[i];
      if (seen[id]) continue;
      seen[id] = true;
      byId[id] = resolveOne(id, srMap[id] || null, elMap[id] || null, ctx);
      all.push(byId[id]);
    }
    // report
    var rep = {
      srRows: srRows.length, srUniqueIds: srOrder.length, srDuplicateIds: 0, srDuplicateConflicts: 0,
      elimiRecords: elRecs.length, elimiUniqueIds: elOrder.length, elimiDuplicateIds: 0, elimiDuplicateCycleIds: 0,
      matched: 0, elimiOnly: 0, srOnly: 0,
      windowOk: 0, noWindow: 0, needsCheck: 0, byReason: {}, referenceDate: referenceDate
    };
    for (i = 0; i < srOrder.length; i++) {
      var g = srMap[srOrder[i]].rows;
      if (g.length > 1) {
        rep.srDuplicateIds += 1;
        for (var j = 1; j < g.length; j++) if (!sameWindow(g[0], g[j])) { rep.srDuplicateConflicts += 1; break; }
      }
    }
    for (i = 0; i < elOrder.length; i++) {
      var ee = elMap[elOrder[i]];
      if (ee.count > 1) rep.elimiDuplicateIds += 1;
      if (ee.cycles.length > 1) rep.elimiDuplicateCycleIds += 1;
      if (srMap[elOrder[i]]) rep.matched += 1; else rep.elimiOnly += 1;
    }
    for (i = 0; i < srOrder.length; i++) if (!elMap[srOrder[i]]) rep.srOnly += 1;
    for (i = 0; i < all.length; i++) {
      var x = all[i];
      if (!elMap[x.id]) continue; // report counts the target set (elimination list) only
      if (x.status === STATUS.WINDOW) rep.windowOk += 1;
      else if (x.status === STATUS.NO_WINDOW) rep.noWindow += 1;
      else { rep.needsCheck += 1; rep.byReason[x.reason] = (rep.byReason[x.reason] || 0) + 1; }
    }
    return {
      version: VERSION,
      byId: byId,
      all: all,
      options: opts,
      meta: { referenceDate: referenceDate, srLastUpdated: lastUpdated, loadedAt: input.loadedAt || null },
      report: rep
    };
  }

  /** Scan value -> result. Always returns an object; never throws. */
  function lookup(table, raw) {
    var res = table ? resolveScan(raw, table.options) : { id: null, kind: 'none' };
    if (!res.id) {
      return mkResult(null, STATUS.UNKNOWN, res.kind === 'ambiguous' ? REASON.AMBIGUOUS_SCAN : REASON.NOT_FOUND, { matchKind: res.kind });
    }
    var hit = table.byId[res.id];
    if (!hit) return mkResult(res.id, STATUS.UNKNOWN, REASON.NOT_FOUND, { matchKind: res.kind });
    var out = {};
    for (var k in hit) if (has(hit, k)) out[k] = hit[k];
    out.matchKind = res.kind;
    out.speech = hit.status === STATUS.WINDOW ? hit.speech : (hit.status === STATUS.NO_WINDOW ? SPEECH_NO_WINDOW : SPEECH_UNKNOWN);
    return out;
  }

  return {
    VERSION: VERSION, STATUS: STATUS, REASON: REASON,
    SPEECH_UNKNOWN: SPEECH_UNKNOWN, SPEECH_NO_WINDOW: SPEECH_NO_WINDOW, SR_REQUIRED: SR_REQUIRED,
    parseCsv: parseCsv, parseSearchResults: parseSearchResults,
    parseElimiCycleSheet: parseElimiCycleSheet, parseHeadingExpectation: parseHeadingExpectation,
    parseTimestamp: parseTimestamp, parseDate: parseDate, windowSpeech: windowSpeech,
    normalizeId: normalizeId, resolveScan: resolveScan,
    buildTable: buildTable, lookup: lookup
  };
}));
