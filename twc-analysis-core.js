/**
 * OFK3 時間指定（TWC）週次解析 — 純粋ロジック（UI非依存）
 *
 * Amazon TWC Failed Deliveries を基準に正規化済み processedTimeWindowData を作る。
 * ファイル種類はファイル名ではなく列構造で判定する。
 */
(function (global) {
  'use strict';

  var KIND_TWC = 'twc';
  var KIND_GDS_SLS = 'gds_sls';
  var KIND_UNKNOWN = 'unknown';

  function normalizeHeader(h) {
    return String(h || '')
      .replace(/^\ufeff/, '')
      .trim()
      .toLowerCase()
      .replace(/[\s\-]+/g, '_');
  }

  function compactHeader(h) {
    return normalizeHeader(h).replace(/_/g, '');
  }

  function isTransporterHeader(h) {
    var c = compactHeader(h);
    return c === 'transporterid' || c === 'transportid' || c === 'transporter_id'.replace(/_/g, '');
  }

  function findHeaderIndex(name, headerRow) {
    var want = compactHeader(name);
    for (var i = 0; i < headerRow.length; i++) {
      if (compactHeader(headerRow[i]) === want) return i;
    }
    return -1;
  }

  function headerHas(headerRow, name) {
    return findHeaderIndex(name, headerRow) >= 0;
  }

  function scoreTwcHeaders(headerRow) {
    var s = 0;
    if (headerHas(headerRow, 'time_window')) s += 4;
    if (headerHas(headerRow, 'planned_enter_time')) s += 4;
    if (headerHas(headerRow, 'actual_attempt_time')) s += 4;
    if (headerRow.some(isTransporterHeader)) s += 2;
    if (headerHas(headerRow, 'scannable_id')) s += 2;
    if (headerHas(headerRow, 'failure_bridge')) s += 2;
    return s;
  }

  function scoreGdsSlsHeaders(headerRow) {
    var s = 0;
    if (headerHas(headerRow, 'dnr_cost_jpy') || headerHas(headerRow, 'dnr_cost_usd')) s += 4;
    if (headerHas(headerRow, 'conceded_units')) s += 3;
    if (headerHas(headerRow, 'shipment_reason')) s += 3;
    if (headerHas(headerRow, 'tracking_id')) s += 2;
    if (headerHas(headerRow, 'week')) s += 2;
    if (headerRow.some(isTransporterHeader)) s += 1;
    if (headerHas(headerRow, 'bucket')) s += 1;
    if (headerHas(headerRow, 'sub_bucket')) s += 1;
    return s;
  }

  function detectKindFromHeaders(headerRow) {
    if (!headerRow || !headerRow.length) return KIND_UNKNOWN;
    var twc = scoreTwcHeaders(headerRow);
    var gds = scoreGdsSlsHeaders(headerRow);
    if (twc >= 10 && twc > gds) return KIND_TWC;
    if (gds >= 8 && gds > twc) return KIND_GDS_SLS;
    return KIND_UNKNOWN;
  }

  function findHeaderRow(rows) {
    var limit = Math.min(rows.length, 15);
    var best = { index: -1, kind: KIND_UNKNOWN, score: 0 };
    for (var i = 0; i < limit; i++) {
      var row = rows[i] || [];
      var twc = scoreTwcHeaders(row);
      var gds = scoreGdsSlsHeaders(row);
      var kind = detectKindFromHeaders(row);
      var score = Math.max(twc, gds);
      if (kind !== KIND_UNKNOWN && score > best.score) {
        best = { index: i, kind: kind, score: score };
      }
    }
    return best;
  }

  function detectWorkbookKind(rows) {
    return findHeaderRow(rows || []).kind;
  }

  function cellStr(v) {
    if (v == null) return '';
    if (v instanceof Date && !isNaN(v.getTime())) return '';
    return String(v).trim();
  }

  function excelSerialToUtcMs(n) {
    return Math.round((n - 25569) * 86400 * 1000);
  }

  var FORMAT_FULL_DATETIME = 'full-datetime';
  var FORMAT_EXCEL_SERIAL = 'excel-serial';
  var FORMAT_TIME_ONLY = 'time-only';
  var FORMAT_TIME_ONLY_WITH_SECONDS = 'time-only-with-seconds';
  var FORMAT_AMAZON_SHORT_TIME = 'amazon-short-time';
  var FORMAT_EMPTY = 'empty';
  var FORMAT_UNKNOWN = 'unknown';

  function isSafeDatetimeFormat(format) {
    return format === FORMAT_FULL_DATETIME || format === FORMAT_EXCEL_SERIAL;
  }

  function classifyDatetimeFormat(value) {
    if (value == null || value === '') return FORMAT_EMPTY;
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? FORMAT_UNKNOWN : FORMAT_FULL_DATETIME;
    }
    if (typeof value === 'number' && isFinite(value)) {
      if (value > 20000) return FORMAT_EXCEL_SERIAL;
      return FORMAT_UNKNOWN;
    }
    var s = String(value).trim();
    if (!s) return FORMAT_EMPTY;
    if (/^\d{1,2}:\d{2}\.\d+$/.test(s)) return FORMAT_AMAZON_SHORT_TIME;
    if (/^\d{1,2}:\d{2}:\d{2}$/.test(s)) return FORMAT_TIME_ONLY_WITH_SECONDS;
    if (/^\d{1,2}:\d{2}$/.test(s)) return FORMAT_TIME_ONLY;
    if (/^\d+(\.\d+)?$/.test(s)) {
      var serial = parseFloat(s);
      if (isFinite(serial) && serial > 20000) return FORMAT_EXCEL_SERIAL;
      return FORMAT_UNKNOWN;
    }
    if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(s)) {
      return FORMAT_FULL_DATETIME;
    }
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(s)) {
      return FORMAT_FULL_DATETIME;
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return FORMAT_FULL_DATETIME;
    return FORMAT_UNKNOWN;
  }

  function parseYmdDateTime(s) {
    var ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!ymd) return null;
    var year = parseInt(ymd[1], 10);
    var month = parseInt(ymd[2], 10);
    var day = parseInt(ymd[3], 10);
    var hh = ymd[4] != null ? parseInt(ymd[4], 10) : 0;
    var mm = ymd[5] != null ? parseInt(ymd[5], 10) : 0;
    var ss = ymd[6] != null ? parseInt(ymd[6], 10) : 0;
    return new Date(Date.UTC(year, month - 1, day, hh - 9, mm, ss));
  }

  function parseMdyDateTime(s) {
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    var year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    var month = parseInt(m[1], 10);
    var day = parseInt(m[2], 10);
    var hh = m[4] != null ? parseInt(m[4], 10) : 0;
    var mm = m[5] != null ? parseInt(m[5], 10) : 0;
    var ss = m[6] != null ? parseInt(m[6], 10) : 0;
    return new Date(Date.UTC(year, month - 1, day, hh - 9, mm, ss));
  }

  function parseDateTime(value) {
    var format = classifyDatetimeFormat(value);
    if (!isSafeDatetimeFormat(format)) return null;
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return null;
      return new Date(value.getTime());
    }
    if (typeof value === 'number' && isFinite(value)) {
      if (value > 20000) return new Date(excelSerialToUtcMs(value));
      return null;
    }
    var s = String(value).trim();
    if (!s) return null;
    if (format === FORMAT_EXCEL_SERIAL) {
      var serial = parseFloat(s);
      if (isFinite(serial) && serial > 20000) return new Date(excelSerialToUtcMs(serial));
      return null;
    }
    var ymd = parseYmdDateTime(s);
    if (ymd && !isNaN(ymd.getTime())) return ymd;
    var mdy = parseMdyDateTime(s);
    if (mdy && !isNaN(mdy.getTime())) return mdy;
    var iso = Date.parse(s);
    if (!isNaN(iso)) return new Date(iso);
    return null;
  }

  function incrementCount(map, key) {
    map[key] = (map[key] || 0) + 1;
  }

  function buildDatetimeSafety(records) {
    var totalRows = records.length;
    var validRows = 0;
    var invalidRows = 0;
    var formatCounts = {};
    var violationCount = 0;
    var i;
    for (i = 0; i < records.length; i++) {
      var rec = records[i];
      incrementCount(formatCounts, rec.actualFormat || FORMAT_UNKNOWN);
      if (rec.datetimeValid) {
        validRows++;
        if (rec.status === 'failed') violationCount++;
      } else {
        invalidRows++;
      }
    }
    var ok = invalidRows === 0;
    return {
      ok: ok,
      reason: ok ? null : 'datetime-format-unrecognized',
      totalRows: totalRows,
      validRows: validRows,
      invalidRows: invalidRows,
      violations: ok ? violationCount : null,
      formatCounts: formatCounts,
      partial: validRows > 0 && invalidRows > 0,
    };
  }

  function toJstParts(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return null;
    var t = date.getTime() + 9 * 3600 * 1000;
    var x = new Date(t);
    return {
      y: x.getUTCFullYear(),
      mo: x.getUTCMonth() + 1,
      da: x.getUTCDate(),
      h: x.getUTCHours(),
      mi: x.getUTCMinutes(),
      s: x.getUTCSeconds(),
      minOfDay: x.getUTCHours() * 60 + x.getUTCMinutes(),
    };
  }

  function formatJst(date) {
    var p = toJstParts(date);
    if (!p) return null;
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return p.y + '-' + pad(p.mo) + '-' + pad(p.da) + ' ' + pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s);
  }

  function amazonWeekFromDate(date) {
    var p = toJstParts(date);
    if (!p) return null;
    var sun = Date.UTC(p.y, p.mo - 1, p.da) - new Date(Date.UTC(p.y, p.mo - 1, p.da)).getUTCDay() * 86400000;
    var jan1 = Date.UTC(p.y, 0, 1);
    var week1sun = jan1 - new Date(jan1).getUTCDay() * 86400000;
    if (sun < week1sun) {
      var prev = new Date(Date.UTC(p.y - 1, 11, 31));
      return amazonWeekFromDate(prev);
    }
    return Math.floor((sun - week1sun) / (7 * 86400000)) + 1;
  }

  function parseTimeWindow(raw) {
    var s = String(raw || '');
    var m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*-\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    function pad(n) {
      n = parseInt(n, 10);
      return (n < 10 ? '0' : '') + n;
    }
    return {
      start: pad(m[1]) + ':' + m[2],
      end: pad(m[4]) + ':' + m[5],
      startMin: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
      endMin: parseInt(m[4], 10) * 60 + parseInt(m[5], 10),
      raw: s.trim(),
    };
  }

  function overMinutesFromWindowEnd(actualDate, windowEndMin) {
    var p = toJstParts(actualDate);
    if (!p || windowEndMin == null) return null;
    var actualMs = Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi, p.s);
    var endH = Math.floor(windowEndMin / 60);
    var endM = windowEndMin % 60;
    var endMs = Date.UTC(p.y, p.mo - 1, p.da, endH, endM, 0);
    return Math.round((actualMs - endMs) / 60000);
  }

  function mean(nums) {
    if (!nums.length) return null;
    var s = 0;
    for (var i = 0; i < nums.length; i++) s += nums[i];
    return s / nums.length;
  }

  function median(nums) {
    if (!nums.length) return null;
    var a = nums.slice().sort(function (x, y) {
      return x - y;
    });
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function round1(n) {
    if (n == null || !isFinite(n)) return null;
    return Math.round(n * 10) / 10;
  }

  function mapTwcColumns(headerRow) {
    var cols = {};
    for (var i = 0; i < headerRow.length; i++) {
      var c = compactHeader(headerRow[i]);
      if (isTransporterHeader(headerRow[i])) cols.transporterId = i;
      else if (c === 'timewindow') cols.timeWindow = i;
      else if (c === 'plannedentertime') cols.plannedEnterTime = i;
      else if (c === 'actualattempttime') cols.actualAttemptTime = i;
      else if (c === 'scannableid') cols.scannableId = i;
      else if (c === 'trackingid') cols.trackingId = i;
      else if (c === 'failurebridge') cols.failureBridge = i;
      else if (c === 'manifestcycle') cols.manifestCycle = i;
      else if (c === 'week') cols.week = i;
    }
    return cols;
  }

  function mapGdsSlsColumns(headerRow) {
    var cols = {};
    for (var i = 0; i < headerRow.length; i++) {
      var c = compactHeader(headerRow[i]);
      if (isTransporterHeader(headerRow[i])) cols.transporterId = i;
      else if (c === 'trackingid') cols.trackingId = i;
      else if (c === 'week') cols.week = i;
      else if (c === 'shipmentreason') cols.shipmentReason = i;
      else if (c === 'dnrcostjpy') cols.dnrCostJpy = i;
    }
    return cols;
  }

  function requiredTwcMissing(cols) {
    var missing = [];
    if (cols.timeWindow == null) missing.push('time_window');
    if (cols.transporterId == null) missing.push('transporter_id');
    if (cols.plannedEnterTime == null) missing.push('planned_enter_time');
    if (cols.actualAttemptTime == null) missing.push('actual_attempt_time');
    return missing;
  }

  function lookupDriver(tid, lookupFn) {
    if (typeof lookupFn !== 'function') return { driverName: '', department: '', matched: false };
    var found = lookupFn(tid);
    if (!found) return { driverName: '', department: '', matched: false };
    return {
      driverName: found.driverName || found.name || '',
      department: found.department || found.dept || '',
      matched: !!(found.driverName || found.name),
    };
  }

  function parseTwcRows(rows, options) {
    options = options || {};
    var found = findHeaderRow(rows || []);
    var issues = [];
    if (found.kind !== KIND_TWC) {
      return {
        ok: false,
        kind: found.kind,
        records: [],
        issues: [{ code: found.kind === KIND_UNKNOWN ? 'UNSUPPORTED_FILE' : 'MISSING_COLUMNS', message: 'TWC Failed Deliveries として認識できません' }],
      };
    }
    var header = rows[found.index] || [];
    var cols = mapTwcColumns(header);
    var missing = requiredTwcMissing(cols);
    if (missing.length) {
      return {
        ok: false,
        kind: KIND_TWC,
        records: [],
        issues: [{ code: 'MISSING_COLUMNS', message: '必要列が不足しています: ' + missing.join(', '), columns: missing }],
      };
    }

    var seenIds = {};
    var records = [];
    for (var r = found.index + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var empty = true;
      for (var c = 0; c < row.length; c++) {
        if (cellStr(row[c]) !== '' || (row[c] instanceof Date)) {
          empty = false;
          break;
        }
      }
      if (empty) continue;

      var tid = cellStr(row[cols.transporterId]);
      var scannableId = cols.scannableId != null ? cellStr(row[cols.scannableId]) : '';
      var twRaw = row[cols.timeWindow];
      var actualFormat = classifyDatetimeFormat(row[cols.actualAttemptTime]);
      var planned = parseDateTime(row[cols.plannedEnterTime]);
      var actual = isSafeDatetimeFormat(actualFormat) ? parseDateTime(row[cols.actualAttemptTime]) : null;
      var tw = parseTimeWindow(twRaw);

      if (!tid && !scannableId && !tw) {
        issues.push({ code: 'UNPARSEABLE_ROW', message: '解析不能行', row: r + 1 });
        continue;
      }

      var rowIssues = [];
      if (scannableId) {
        if (seenIds[scannableId]) {
          rowIssues.push('DUPLICATE');
          issues.push({ code: 'DUPLICATE', message: 'scannable_id 重複: ' + scannableId, row: r + 1, scannableId: scannableId });
        }
        seenIds[scannableId] = (seenIds[scannableId] || 0) + 1;
      }
      if (!tw) {
        rowIssues.push('INVALID_TIME_WINDOW');
        issues.push({ code: 'UNPARSEABLE_ROW', message: 'time_window を解析できません', row: r + 1 });
      }
      var datetimeValid = !!(planned && actual);
      if (!datetimeValid) {
        rowIssues.push('INVALID_DATETIME');
        issues.push({
          code: 'INVALID_DATETIME',
          message: '日時を解析できません',
          row: r + 1,
          scannableId: scannableId,
          actualFormat: actualFormat,
        });
      }

      var master = lookupDriver(tid, options.lookupDriver);
      if (tid && !master.matched) {
        issues.push({ code: 'UNMATCHED_TID', message: 'Transport ID 未照合: ' + tid, transportId: tid, row: r + 1 });
      }

      var over = tw && actual ? overMinutesFromWindowEnd(actual, tw.endMin) : null;
      var week = actual ? amazonWeekFromDate(actual) : planned ? amazonWeekFromDate(planned) : null;
      var status = rowIssues.indexOf('UNPARSEABLE_ROW') >= 0 ? 'unparseable' : rowIssues.indexOf('INVALID_DATETIME') >= 0 || rowIssues.indexOf('INVALID_TIME_WINDOW') >= 0 ? 'invalid_datetime' : 'failed';

      records.push({
        week: week,
        transportId: tid,
        driverName: master.matched ? master.driverName : '',
        department: master.matched ? master.department || '' : '',
        matched: !!master.matched,
        windowStart: tw ? tw.start : null,
        windowEnd: tw ? tw.end : null,
        plannedEnterTime: formatJst(planned),
        actualAttemptTime: formatJst(actual),
        overMinutes: over,
        status: status,
        scannableId: scannableId,
        duplicate: rowIssues.indexOf('DUPLICATE') >= 0,
        actualFormat: actualFormat,
        datetimeValid: datetimeValid,
      });
    }

    var safety = buildDatetimeSafety(records);
    return {
      ok: true,
      kind: KIND_TWC,
      records: records,
      issues: issues,
      totalRows: safety.totalRows,
      validRows: safety.validRows,
      invalidRows: safety.invalidRows,
      violations: safety.violations,
      formatCounts: safety.formatCounts,
      partial: safety.partial,
      reason: safety.reason,
    };
  }

  function parseGdsSlsRows(rows) {
    var found = findHeaderRow(rows || []);
    if (found.kind !== KIND_GDS_SLS) {
      return { ok: false, kind: found.kind, records: [], weeks: [], trackingIds: [], transporterIds: [] };
    }
    var header = rows[found.index] || [];
    var cols = mapGdsSlsColumns(header);
    var records = [];
    var weeks = {};
    var trackingIds = [];
    var transporterIds = [];
    for (var r = found.index + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var tid = cols.transporterId != null ? cellStr(row[cols.transporterId]) : '';
      var tracking = cols.trackingId != null ? cellStr(row[cols.trackingId]) : '';
      var weekRaw = cols.week != null ? row[cols.week] : '';
      var week = weekRaw === '' || weekRaw == null ? null : parseInt(weekRaw, 10);
      if (!tid && !tracking) continue;
      if (week != null && isFinite(week)) weeks[week] = (weeks[week] || 0) + 1;
      if (tracking) trackingIds.push(tracking);
      if (tid) transporterIds.push(tid);
      records.push({
        week: week,
        transportId: tid,
        trackingId: tracking,
        shipmentReason: cols.shipmentReason != null ? cellStr(row[cols.shipmentReason]) : '',
      });
    }
    return {
      ok: true,
      kind: KIND_GDS_SLS,
      records: records,
      weeks: Object.keys(weeks).map(function (k) {
        return parseInt(k, 10);
      }),
      trackingIds: trackingIds,
      transporterIds: transporterIds,
    };
  }

  function inspectJoin(twcRecords, gds) {
    var twcIds = {};
    var gdsIds = {};
    var i;
    for (i = 0; i < twcRecords.length; i++) {
      if (twcRecords[i].scannableId) twcIds[twcRecords[i].scannableId] = (twcIds[twcRecords[i].scannableId] || 0) + 1;
    }
    var gdsTracks = gds && gds.trackingIds ? gds.trackingIds : [];
    for (i = 0; i < gdsTracks.length; i++) gdsIds[gdsTracks[i]] = (gdsIds[gdsTracks[i]] || 0) + 1;
    var overlap = [];
    for (var id in twcIds) {
      if (gdsIds[id]) overlap.push(id);
    }
    var twcTids = {};
    var gdsTids = {};
    for (i = 0; i < twcRecords.length; i++) {
      if (twcRecords[i].transportId) twcTids[twcRecords[i].transportId] = true;
    }
    var gdsTidList = gds && gds.transporterIds ? gds.transporterIds : [];
    for (i = 0; i < gdsTidList.length; i++) gdsTids[gdsTidList[i]] = true;
    var tidOverlap = [];
    for (var t in twcTids) {
      if (gdsTids[t]) tidOverlap.push(t);
    }
    return {
      scannableTrackingOverlap: overlap,
      transporterIdOverlap: tidOverlap,
      cardinality: overlap.length === 0 ? 'none' : 'unknown',
      safeToJoin: overlap.length > 0,
    };
  }

  function aggregateDrivers(records) {
    var byTid = {};
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var key = rec.transportId || '(empty)';
      if (!byTid[key]) {
        byTid[key] = {
          transportId: rec.transportId,
          driverName: rec.driverName,
          department: rec.department,
          matched: rec.matched,
          failedCount: 0,
          overs: [],
        };
      }
      byTid[key].failedCount++;
      if (rec.driverName && !byTid[key].driverName) byTid[key].driverName = rec.driverName;
      if (rec.department && !byTid[key].department) byTid[key].department = rec.department;
      if (rec.matched) byTid[key].matched = true;
      if (rec.overMinutes != null && isFinite(rec.overMinutes)) byTid[key].overs.push(rec.overMinutes);
    }
    var list = [];
    for (var k in byTid) {
      var d = byTid[k];
      list.push({
        transportId: d.transportId,
        driverName: d.driverName,
        department: d.department,
        matched: d.matched,
        failedCount: d.failedCount,
        avgOverMinutes: d.overs.length ? round1(mean(d.overs)) : null,
        maxOverMinutes: d.overs.length ? Math.max.apply(null, d.overs) : null,
      });
    }
    list.sort(function (a, b) {
      if (b.failedCount !== a.failedCount) return b.failedCount - a.failedCount;
      var ao = a.maxOverMinutes == null ? -1 : a.maxOverMinutes;
      var bo = b.maxOverMinutes == null ? -1 : b.maxOverMinutes;
      return bo - ao;
    });
    return list;
  }

  function aggregateDepartments(records, departmentCatalog) {
    var byDept = {};
    var i;
    var catalog = departmentCatalog || [];
    for (i = 0; i < catalog.length; i++) {
      byDept[catalog[i]] = { department: catalog[i], failedCount: 0, overs: [] };
    }
    for (i = 0; i < records.length; i++) {
      var rec = records[i];
      var dept = rec.matched && rec.department ? rec.department : '未照合';
      if (!byDept[dept]) byDept[dept] = { department: dept, failedCount: 0, overs: [] };
      byDept[dept].failedCount++;
      if (rec.overMinutes != null && isFinite(rec.overMinutes)) byDept[dept].overs.push(rec.overMinutes);
    }
    var list = [];
    for (var k in byDept) {
      var d = byDept[k];
      list.push({
        department: d.department,
        failedCount: d.failedCount,
        complianceRate: null,
        avgOverMinutes: d.overs.length ? round1(mean(d.overs)) : d.failedCount ? null : 0,
      });
    }
    return list;
  }

  function buildSummary(records) {
    var overs = [];
    var unmatched = 0;
    var invalid = 0;
    var weeks = {};
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (rec.week != null) weeks[rec.week] = (weeks[rec.week] || 0) + 1;
      if (!rec.matched) unmatched++;
      if (rec.status !== 'failed') invalid++;
      if (rec.overMinutes != null && isFinite(rec.overMinutes)) overs.push(rec.overMinutes);
    }
    var weekKeys = Object.keys(weeks);
    var week = null;
    if (weekKeys.length === 1) week = parseInt(weekKeys[0], 10);
    else if (weekKeys.length > 1) {
      var best = weekKeys[0];
      for (i = 1; i < weekKeys.length; i++) {
        if (weeks[weekKeys[i]] > weeks[best]) best = weekKeys[i];
      }
      week = parseInt(best, 10);
    }
    return {
      week: week,
      targetCount: records.length,
      failedCount: records.length,
      complianceRate: null,
      avgOverMinutes: overs.length ? Math.round(mean(overs)) : null,
      medianOverMinutes: overs.length ? Math.round(median(overs)) : null,
      maxOverMinutes: overs.length ? Math.max.apply(null, overs) : null,
      unmatchedTidCount: unmatched,
      invalidRowCount: invalid,
      overSampleCount: overs.length,
    };
  }

  function classifyWorkbooks(workbooks) {
    var result = { twc: [], gdsSls: [], unknown: [] };
    for (var i = 0; i < (workbooks || []).length; i++) {
      var wb = workbooks[i];
      var kind = detectWorkbookKind(wb.rows || []);
      var item = { fileName: wb.fileName || '', kind: kind, rows: wb.rows || [] };
      if (kind === KIND_TWC) result.twc.push(item);
      else if (kind === KIND_GDS_SLS) result.gdsSls.push(item);
      else result.unknown.push(item);
    }
    return result;
  }

  function processDroppedWorkbooks(workbooks, options) {
    options = options || {};
    var classified = classifyWorkbooks(workbooks);
    var issues = [];
    var i;
    for (i = 0; i < classified.unknown.length; i++) {
      issues.push({
        code: 'UNSUPPORTED_FILE',
        message: '対象外ファイル: ' + (classified.unknown[i].fileName || '(無名)'),
        fileName: classified.unknown[i].fileName,
      });
    }

    if (!classified.twc.length) {
      if (classified.gdsSls.length) {
        issues.push({ code: 'TWC_MISSING', message: 'TWC Failed Deliveries がありません。時間指定失敗の解析には TWC ファイルが必要です' });
      }
      return {
        ok: false,
        processedTimeWindowData: null,
        classified: classified,
        issues: issues,
      };
    }

    if (classified.twc.length > 1) {
      issues.push({ code: 'DUPLICATE', message: 'TWC ファイルが複数あります。先頭ファイルのみ使用します' });
    }
    if (!classified.gdsSls.length) {
      issues.push({ code: 'GDS_MISSING', message: 'GDS Raw Data for DSP SLS は未投入です。TWC 単体で解析します' });
    }

    var parsed = parseTwcRows(classified.twc[0].rows, options);
    if (!parsed.ok) {
      return { ok: false, processedTimeWindowData: null, classified: classified, issues: issues.concat(parsed.issues) };
    }
    issues = issues.concat(parsed.issues);

    var safety = {
      ok: parsed.invalidRows === 0,
      reason: parsed.reason || null,
      totalRows: parsed.totalRows,
      validRows: parsed.validRows,
      invalidRows: parsed.invalidRows,
      violations: parsed.violations,
      formatCounts: parsed.formatCounts || {},
      partial: !!parsed.partial,
    };
    if (!safety.ok) {
      issues.push({
        code: 'DATETIME_FORMAT_UNRECOGNIZED',
        message: 'actual_attempt_time を解析できません（解析不能 ' + safety.invalidRows + '件 / 有効 ' + safety.validRows + '件）',
        reason: 'datetime-format-unrecognized',
        totalRows: safety.totalRows,
        validRows: safety.validRows,
        invalidRows: safety.invalidRows,
        violations: null,
        formatCounts: safety.formatCounts,
        partial: safety.partial,
      });
      return {
        ok: false,
        reason: 'datetime-format-unrecognized',
        totalRows: safety.totalRows,
        validRows: safety.validRows,
        invalidRows: safety.invalidRows,
        violations: null,
        formatCounts: safety.formatCounts,
        partial: safety.partial,
        processedTimeWindowData: null,
        classified: classified,
        issues: issues,
        records: parsed.records,
      };
    }

    var gds = null;
    if (classified.gdsSls.length) {
      gds = parseGdsSlsRows(classified.gdsSls[0].rows);
      var join = inspectJoin(parsed.records, gds);
      if (!join.safeToJoin) {
        issues.push({
          code: 'JOIN_SKIPPED',
          message:
            'GDS SLS を認識しましたが、TWC.scannable_id と GDS.tracking_id の一致が ' +
            join.scannableTrackingOverlap.length +
            ' 件のため時間指定指標には統合しません',
          join: join,
        });
      }
      if (gds.weeks && gds.weeks.length === 1) {
        var gdsWeek = gds.weeks[0];
        var twcWeek = buildSummary(parsed.records).week;
        if (twcWeek != null && gdsWeek !== twcWeek) {
          issues.push({
            code: 'WEEK_MISMATCH',
            message: 'TWC から推定した週 (' + twcWeek + ') と GDS SLS の week (' + gdsWeek + ') が一致しません',
          });
        }
      }
    }

    var records = parsed.records;
    var summary = buildSummary(records);
    var drivers = aggregateDrivers(records);
    var departments = aggregateDepartments(records, options.departments || []);
    var processedTimeWindowData = {
      reportType: 'TWC',
      week: summary.week,
      generatedAt: new Date().toISOString(),
      source: {
        twcFileName: classified.twc[0].fileName || '',
        gdsSlsFileName: classified.gdsSls[0] ? classified.gdsSls[0].fileName : '',
        gdsIntegrated: false,
      },
      records: records,
      summary: summary,
      drivers: drivers,
      worstDrivers: drivers.slice(0, 3),
      departments: departments,
      issues: issues,
    };

    return {
      ok: true,
      reason: null,
      totalRows: safety.totalRows,
      validRows: safety.validRows,
      invalidRows: safety.invalidRows,
      violations: safety.violations,
      formatCounts: safety.formatCounts,
      partial: false,
      processedTimeWindowData: processedTimeWindowData,
      classified: classified,
      issues: issues,
    };
  }

  function toChappyJson(data) {
    if (!data) return null;
    var summary = data.summary || {};
    var worst = (data.worstDrivers || []).map(function (d) {
      return {
        transportId: d.transportId,
        driverName: d.driverName || null,
        department: d.department || null,
        failedCount: d.failedCount,
      };
    });
    var departments = (data.departments || []).map(function (d) {
      return {
        department: d.department,
        failedCount: d.failedCount,
        complianceRate: null,
        avgOverMinutes: d.avgOverMinutes,
      };
    });
    return {
      reportType: 'TWC',
      week: summary.week,
      summary: {
        failedCount: summary.failedCount,
        complianceRate: null,
        avgOverMinutes: summary.avgOverMinutes,
        maxOverMinutes: summary.maxOverMinutes,
        medianOverMinutes: summary.medianOverMinutes,
        targetCount: summary.targetCount,
      },
      worstDrivers: worst,
      departments: departments,
    };
  }

  function csvEscape(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(data) {
    var header = [
      'week',
      'transportId',
      'driverName',
      'department',
      'matched',
      'windowStart',
      'windowEnd',
      'plannedEnterTime',
      'actualAttemptTime',
      'overMinutes',
      'status',
      'scannableId',
    ];
    var lines = [header.join(',')];
    var records = (data && data.records) || [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      lines.push(
        [
          csvEscape(r.week),
          csvEscape(r.transportId),
          csvEscape(r.driverName || (r.matched ? '' : '未照合')),
          csvEscape(r.department),
          csvEscape(r.matched ? 'Y' : 'N'),
          csvEscape(r.windowStart),
          csvEscape(r.windowEnd),
          csvEscape(r.plannedEnterTime),
          csvEscape(r.actualAttemptTime),
          csvEscape(r.overMinutes),
          csvEscape(r.status),
          csvEscape(r.scannableId),
        ].join(',')
      );
    }
    return '\uFEFF' + lines.join('\n');
  }

  var TwcAnalysisCore = {
    KIND_TWC: KIND_TWC,
    KIND_GDS_SLS: KIND_GDS_SLS,
    KIND_UNKNOWN: KIND_UNKNOWN,
    normalizeHeader: normalizeHeader,
    detectKindFromHeaders: detectKindFromHeaders,
    detectWorkbookKind: detectWorkbookKind,
    parseTimeWindow: parseTimeWindow,
    parseDateTime: parseDateTime,
    classifyDatetimeFormat: classifyDatetimeFormat,
    isSafeDatetimeFormat: isSafeDatetimeFormat,
    FORMAT_FULL_DATETIME: FORMAT_FULL_DATETIME,
    FORMAT_EXCEL_SERIAL: FORMAT_EXCEL_SERIAL,
    FORMAT_TIME_ONLY: FORMAT_TIME_ONLY,
    FORMAT_TIME_ONLY_WITH_SECONDS: FORMAT_TIME_ONLY_WITH_SECONDS,
    FORMAT_AMAZON_SHORT_TIME: FORMAT_AMAZON_SHORT_TIME,
    FORMAT_EMPTY: FORMAT_EMPTY,
    FORMAT_UNKNOWN: FORMAT_UNKNOWN,
    amazonWeekFromDate: amazonWeekFromDate,
    overMinutesFromWindowEnd: overMinutesFromWindowEnd,
    parseTwcRows: parseTwcRows,
    parseGdsSlsRows: parseGdsSlsRows,
    inspectJoin: inspectJoin,
    classifyWorkbooks: classifyWorkbooks,
    processDroppedWorkbooks: processDroppedWorkbooks,
    aggregateDrivers: aggregateDrivers,
    aggregateDepartments: aggregateDepartments,
    buildSummary: buildSummary,
    toChappyJson: toChappyJson,
    toCsv: toCsv,
    formatJst: formatJst,
  };

  global.TwcAnalysisCore = TwcAnalysisCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TwcAnalysisCore;
  }
})(typeof window !== 'undefined' ? window : global);
