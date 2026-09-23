/**
 * OFK3 Cortex 13:00 priority extraction — pure functions.
 *
 * Field mapping is taken from Cortex HAR + Route CSV (DCX47):
 *   plannedEndTime     = stop-level epoch ms  = CSV M「予定時間」
 *   plannedStartTime   = stop-level epoch ms  (NOT used for the 13:00 cut)
 *   windowStartTime    = task-level epoch seconds (float)
 *   windowEndTime      = task-level epoch seconds (float) = CSV J「Time Window」end
 *   taskType           = PICK_UP | DROP_OFF  (only DROP_OFF is a delivery package)
 *
 * No network. No cookies/tokens. Do not log Authorization headers.
 */
(function (global) {
  'use strict';

  var TOKYO = 'Asia/Tokyo';
  var CUTOFF_H = 13;
  var CUTOFF_M = 0;
  var CUTOFF_S = 0;
  var ELEVEN_HOUR = 11;

  var ERROR = {
    SCHEMA: 'API_SCHEMA_CHANGED',
    MISSING_DETAILS: 'ROUTE_DETAILS_MISSING',
    MISSING_PLANNED_END: 'PLANNED_END_MISSING',
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    NOT_FOUND: 'NOT_FOUND',
    TIMEOUT: 'TIMEOUT',
    NETWORK: 'NETWORK',
    NO_DEPARTURE: 'PLANNED_DEPARTURE_MISSING',
    DOM_NOT_FOUND: 'ROUTE_ROW_NOT_FOUND',
    MISSING_SUMMARIES: 'ROUTE_SUMMARIES_MISSING'
  };

  function epochToMs(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return null;
    if (n >= 1e12) return n;
    if (n >= 1e9) return n * 1000;
    return null;
  }

  function tokyoParts(ms) {
    if (ms == null) return null;
    var dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: TOKYO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    var map = {};
    dtf.formatToParts(new Date(ms)).forEach(function (p) {
      if (p.type !== 'literal') map[p.type] = p.value;
    });
    var hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0;
    var msOfDay =
      hour * 3600000 +
      parseInt(map.minute, 10) * 60000 +
      parseInt(map.second, 10) * 1000 +
      (ms % 1000);
    return {
      year: parseInt(map.year, 10),
      month: parseInt(map.month, 10),
      day: parseInt(map.day, 10),
      hour: hour,
      minute: parseInt(map.minute, 10),
      second: parseInt(map.second, 10),
      msOfDay: msOfDay
    };
  }

  function formatTokyoClock(ms) {
    var p = tokyoParts(ms);
    if (!p) return '';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second);
  }

  function formatTokyoDateTime(ms) {
    var p = tokyoParts(ms);
    if (!p) return '';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return p.year + '-' + pad(p.month) + '-' + pad(p.day) + ' ' +
      pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second);
  }

  function localDateKey(localDate) {
    if (!localDate || localDate.length < 3) return '';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return localDate[0] + '-' + pad(localDate[1]) + '-' + pad(localDate[2]);
  }

  function cutoffMsOfDay() {
    return CUTOFF_H * 3600000 + CUTOFF_M * 60000 + CUTOFF_S * 1000;
  }

  function isOnOrBeforeCutoff(ms) {
    var p = tokyoParts(ms);
    if (!p) return false;
    return p.msOfDay <= cutoffMsOfDay();
  }

  function isExact1300Clock(ms) {
    var p = tokyoParts(ms);
    if (!p) return false;
    return p.hour === 13 && p.minute === 0 && p.second === 0 && (ms % 1000 === 0);
  }

  function isSameLocalDate(ms, localDate) {
    if (!localDate || localDate.length < 3) return true;
    var p = tokyoParts(ms);
    if (!p) return false;
    return p.year === localDate[0] && p.month === localDate[1] && p.day === localDate[2];
  }

  function classifyHttpError(status) {
    if (status === 401) return ERROR.UNAUTHORIZED;
    if (status === 403) return ERROR.FORBIDDEN;
    if (status === 404) return ERROR.NOT_FOUND;
    if (status === 408 || status === 504) return ERROR.TIMEOUT;
    return ERROR.NETWORK;
  }

  function describeHttpError(status, error) {
    var st = Number(status);
    var code = error || (st ? classifyHttpError(st) : '');
    if (code === ERROR.UNAUTHORIZED || code === 'UNAUTHORIZED' || st === 401) {
      return {
        error: ERROR.UNAUTHORIZED,
        message: 'UNAUTHORIZED（未ログイン）。CortexにログインしたタブでBookmarkletを再実行してください'
      };
    }
    if (code === ERROR.FORBIDDEN || code === 'FORBIDDEN' || st === 403) {
      return {
        error: ERROR.FORBIDDEN,
        message: 'FORBIDDEN（権限不足）。このアカウントではCortex APIを取得できません'
      };
    }
    if (code) return { error: code, message: String(code) };
    if (st) return { error: classifyHttpError(st), message: 'HTTP ' + st };
    return { error: ERROR.NETWORK, message: '取得失敗' };
  }

  function driverNameFromDetails(details) {
    var list = (details && details.transporters) || [];
    if (!list.length) return '';
    var t = list[0] || {};
    return String((t.lastName || '') + ' ' + (t.firstName || '')).trim();
  }

  function trackingIdOf(task) {
    var map = (task && task.domainMap) || {};
    return String(map.scannableId || task.referenceId || '').trim();
  }

  /**
   * 11:00 departure routes.
   * Evidence: plannedDepartureTime hour in Asia/Tokyo == 11.
   * hour == 9 (Biker) is not an 11:00 departure.
   * Do not use route-code ranges. Do not hardcode a route count.
   */
  function selectElevenOClockRoutes(summariesPayload) {
    var warnings = [];
    if (!summariesPayload || !Array.isArray(summariesPayload.rmsRouteSummaries)) {
      return {
        ok: false,
        error: ERROR.SCHEMA,
        message: 'route-summaries に rmsRouteSummaries がありません',
        routes: [],
        skipped: [],
        warnings: warnings
      };
    }
    var routes = [];
    var skipped = [];
    var missingDeparture = 0;
    summariesPayload.rmsRouteSummaries.forEach(function (row) {
      if (!row || !row.routeId) {
        skipped.push({ reason: ERROR.SCHEMA, routeCode: row && row.routeCode });
        return;
      }
      var depMs = epochToMs(row.plannedDepartureTime);
      if (depMs == null) {
        missingDeparture += 1;
        skipped.push({
          reason: ERROR.NO_DEPARTURE,
          routeId: row.routeId,
          routeCode: row.routeCode
        });
        return;
      }
      var parts = tokyoParts(depMs);
      var selected = parts && parts.hour === ELEVEN_HOUR;
      var item = {
        routeId: row.routeId,
        routeCode: row.routeCode,
        plannedDepartureTime: depMs,
        plannedDepartureClock: formatTokyoClock(depMs),
        serviceTypeName: row.serviceTypeName || '',
        selected: selected
      };
      if (selected) routes.push(item);
      else skipped.push({
        reason: 'NOT_11_DEPARTURE',
        routeId: row.routeId,
        routeCode: row.routeCode,
        plannedDepartureClock: formatTokyoClock(depMs)
      });
    });
    if (summariesPayload.rmsRouteSummaries.length &&
        missingDeparture === summariesPayload.rmsRouteSummaries.length) {
      return {
        ok: false,
        error: ERROR.SCHEMA,
        message: '全Routeで plannedDepartureTime が欠損しています（schema変更の可能性）',
        routes: [],
        skipped: skipped,
        warnings: warnings
      };
    }
    return { ok: true, routes: routes, skipped: skipped, warnings: warnings };
  }

  function extractFromRouteDetails(details, options) {
    options = options || {};
    var notes = [];
    if (!details || !details.rmsRouteDetails) {
      return {
        ok: false,
        error: ERROR.MISSING_DETAILS,
        message: 'route-details に rmsRouteDetails がありません',
        packages: [],
        stopCount: 0,
        packageCount: 0
      };
    }
    var rd = details.rmsRouteDetails;
    if (!Array.isArray(rd.stops)) {
      return {
        ok: false,
        error: ERROR.SCHEMA,
        message: 'rmsRouteDetails.stops がありません',
        routeCode: rd.routeCode,
        routeId: rd.routeId,
        packages: [],
        stopCount: 0,
        packageCount: 0
      };
    }

    var localDate = rd.localDate;
    var packages = [];
    var missingPlannedEndStops = [];
    var addressById = {};
    (details.addresses || []).forEach(function (a) {
      if (a && a.addressId) addressById[a.addressId] = a;
    });

    rd.stops.forEach(function (stop) {
      var tasks = stop && stop.tasks;
      if (!stop || !Array.isArray(tasks)) return;
      var plannedEndMs = epochToMs(stop.plannedEndTime);
      var plannedStartMs = epochToMs(stop.plannedStartTime);
      if (plannedEndMs == null) {
        var hasDrop = tasks.some(function (t) { return t && t.taskType === 'DROP_OFF'; });
        if (hasDrop) {
          missingPlannedEndStops.push(stop.sequenceNumber);
          notes.push({
            code: ERROR.MISSING_PLANNED_END,
            stop: stop.sequenceNumber,
            message: 'plannedEndTime 欠損のため対象外'
          });
        }
        return;
      }

      tasks.forEach(function (task) {
        if (!task || task.taskType !== 'DROP_OFF') return;
        var windowEndMs = epochToMs(task.windowEndTime);
        var windowStartMs = epochToMs(task.windowStartTime);
        if (windowEndMs == null) return;
        if (!isExact1300Clock(windowEndMs)) return;
        if (!isSameLocalDate(windowEndMs, localDate)) return;
        if (!isOnOrBeforeCutoff(plannedEndMs)) return;

        var location = resolveStopAddress(details, stop, task);
        packages.push({
          routeCode: rd.routeCode,
          routeId: rd.routeId,
          stop: stop.sequenceNumber,
          trackingId: trackingIdOf(task),
          timeWindowed: !!task.timeWindowed,
          promiseType: task.promiseType || '',
          windowStartTime: windowStartMs,
          windowEndTime: windowEndMs,
          windowLabel: formatTokyoClock(windowStartMs) + '-' + formatTokyoClock(windowEndMs),
          plannedStartTime: plannedStartMs,
          plannedEndTime: plannedEndMs,
          plannedEndClock: formatTokyoClock(plannedEndMs),
          address: location.address,
          latitude: location.latitude,
          longitude: location.longitude
        });
      });
    });

    var stopSet = {};
    packages.forEach(function (p) { stopSet[p.stop] = true; });
    var stopNumbers = Object.keys(stopSet).map(function (s) { return parseInt(s, 10); }).sort(function (a, b) { return a - b; });
    var lastStop = stopNumbers.length ? stopNumbers[stopNumbers.length - 1] : null;
    var lastPkg = null;
    packages.forEach(function (p) {
      if (p.stop === lastStop) lastPkg = p;
    });

    return {
      ok: true,
      routeCode: rd.routeCode,
      routeId: rd.routeId,
      localDate: localDate,
      localDateKey: localDateKey(localDate),
      driverName: driverNameFromDetails(details),
      plannedDepartureClock: formatTokyoClock(epochToMs(rd.plannedDepartureTime)),
      packages: packages,
      stopNumbers: stopNumbers,
      stopCount: stopNumbers.length,
      packageCount: packages.length,
      lastStop: lastStop,
      lastPlannedEndClock: lastPkg ? lastPkg.plannedEndClock : '',
      missingPlannedEndStops: missingPlannedEndStops,
      notes: notes
    };
  }

  function sequenceStopLocation(details, stop) {
    var addresses = (details && Array.isArray(details.addresses)) ? details.addresses : [];
    var tasks = (stop && stop.tasks) || [];
    var task = null;
    var i;
    for (i = 0; i < tasks.length; i++) {
      if (tasks[i] && tasks[i].taskType === 'DROP_OFF') {
        task = tasks[i];
        break;
      }
    }
    if (!task && tasks[0]) task = tasks[0];
    var ids = [];
    function addId(v) {
      if (v == null || v === '') return;
      v = String(v);
      if (ids.indexOf(v) < 0) ids.push(v);
    }
    addId(task && task.addressId);
    addId(stop && stop.addressId);
    addId(task && task.destinationAddressId);
    addId(stop && stop.destinationAddressId);
    var addr = null;
    for (i = 0; i < addresses.length && !addr; i++) {
      var a = addresses[i] || {};
      var aid = a.addressId != null ? String(a.addressId) : '';
      var id = a.id != null ? String(a.id) : '';
      if ((aid && ids.indexOf(aid) >= 0) || (id && ids.indexOf(id) >= 0)) addr = a;
    }
    if (!addr && addresses.length === 1) addr = addresses[0] || {};
    function coordOf(value) {
      if (value == null || value === '') return null;
      var n = Number(value);
      return isFinite(n) ? n : null;
    }
    var lat = coordOf(addr && (addr.latitude != null ? addr.latitude :
      (addr.lat != null ? addr.lat : (addr.geoLocation && addr.geoLocation.latitude))));
    var lng = coordOf(addr && (addr.longitude != null ? addr.longitude :
      (addr.lng != null ? addr.lng : (addr.geoLocation && addr.geoLocation.longitude))));
    var text = '';
    if (addr) {
      text = addr.fullAddress || addr.address || [addr.address1, addr.address2, addr.address3, addr.city].filter(Boolean).join(' ');
    }
    return { address: text || '', latitude: lat, longitude: lng };
  }

  // Full Cortex visit order from already-captured route-details.
  // Does not apply 13:00 filters. sequenceNumber is the canonical visit order.
  function extractRouteSequence(details) {
    if (!details || !details.rmsRouteDetails || !Array.isArray(details.rmsRouteDetails.stops)) {
      return {
        ok: false,
        routeCode: details && details.rmsRouteDetails ? details.rmsRouteDetails.routeCode : '',
        routeId: details && details.rmsRouteDetails ? details.rmsRouteDetails.routeId : '',
        driverName: '',
        stops: []
      };
    }
    var rd = details.rmsRouteDetails;
    var driverName = driverNameFromDetails(details);
    var stops = [];
    rd.stops.forEach(function (stop) {
      if (!stop) return;
      var tasks = Array.isArray(stop.tasks) ? stop.tasks : [];
      var dropCount = 0;
      var i;
      for (i = 0; i < tasks.length; i++) {
        if (tasks[i] && tasks[i].taskType === 'DROP_OFF') dropCount += 1;
      }
      var location = sequenceStopLocation(details, stop);
      var plannedEndMs = epochToMs(stop.plannedEndTime);
      var seq = stop.sequenceNumber == null || stop.sequenceNumber === '' ? null : Number(stop.sequenceNumber);
      if (seq != null && !isFinite(seq)) seq = null;
      stops.push({
        routeCode: rd.routeCode || '',
        routeId: rd.routeId || '',
        driverName: driverName,
        sequenceNumber: seq,
        stop: seq,
        plannedEndTime: plannedEndMs,
        plannedEndClock: formatTokyoClock(plannedEndMs),
        address: location.address,
        latitude: location.latitude,
        longitude: location.longitude,
        packageCount: dropCount
      });
    });
    return {
      ok: true,
      routeCode: rd.routeCode || '',
      routeId: rd.routeId || '',
      driverName: driverName,
      stops: stops
    };
  }

  // Full DROP_OFF package → sequenceNumber index (no 13:00 / time-window filter).
  // Separate from extractFromRouteDetails packages (Cortex 13:00 priority only).
  function emptyPackageSequenceDiagnostics() {
    return {
      skippedMissingTrackingId: 0,
      skippedMissingSequence: 0,
      skippedEmptyTasks: 0,
      duplicateTrackingIdConflicts: [],
      indexCount: 0,
      byRoute: {}
    };
  }

  function extractPackageSequenceIndex(details) {
    var diagnostics = emptyPackageSequenceDiagnostics();
    if (!details || !details.rmsRouteDetails || !Array.isArray(details.rmsRouteDetails.stops)) {
      return {
        ok: false,
        routeCode: details && details.rmsRouteDetails ? details.rmsRouteDetails.routeCode : '',
        routeId: details && details.rmsRouteDetails ? details.rmsRouteDetails.routeId : '',
        index: [],
        diagnostics: diagnostics
      };
    }
    var rd = details.rmsRouteDetails;
    var routeCode = String(rd.routeCode || '');
    var index = [];
    var seenSeqByTracking = {};

    rd.stops.forEach(function (stop) {
      if (!stop) return;
      var seq = stop.sequenceNumber == null || stop.sequenceNumber === '' ? null : Number(stop.sequenceNumber);
      if (seq != null && !isFinite(seq)) seq = null;
      var tasks = Array.isArray(stop.tasks) ? stop.tasks : [];
      if (!tasks.length) {
        diagnostics.skippedEmptyTasks += 1;
        return;
      }
      tasks.forEach(function (task) {
        if (!task || task.taskType !== 'DROP_OFF') return;
        if (seq == null) {
          diagnostics.skippedMissingSequence += 1;
          return;
        }
        var tid = trackingIdOf(task);
        if (!tid) {
          diagnostics.skippedMissingTrackingId += 1;
          return;
        }
        if (!seenSeqByTracking[tid]) seenSeqByTracking[tid] = [];
        var prev = seenSeqByTracking[tid];
        var alreadyHasSame = false;
        var i;
        for (i = 0; i < prev.length; i++) {
          if (prev[i] === seq) alreadyHasSame = true;
        }
        if (!alreadyHasSame && prev.length > 0) {
          diagnostics.duplicateTrackingIdConflicts.push({
            routeCode: routeCode,
            trackingId: tid,
            sequenceNumbers: prev.concat([seq])
          });
        }
        if (!alreadyHasSame) prev.push(seq);
        // Keep every DROP_OFF row; never silent-overwrite a different sequence.
        index.push({
          routeCode: routeCode,
          trackingId: tid,
          sequenceNumber: seq
        });
      });
    });

    diagnostics.indexCount = index.length;
    if (routeCode) diagnostics.byRoute[routeCode] = index.length;
    return {
      ok: true,
      routeCode: routeCode,
      routeId: rd.routeId || '',
      index: index,
      diagnostics: diagnostics
    };
  }

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var cur = '';
    var inQuotes = false;
    var s = String(text || '').replace(/^\uFEFF/, '');
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { cur += '"'; i += 1; }
          else inQuotes = false;
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(cur);
        cur = '';
      } else if (c === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else if (c !== '\r') {
        cur += c;
      }
    }
    if (cur.length || row.length) {
      row.push(cur);
      rows.push(row);
    }
    return rows;
  }

  function parseTokyoDateTime(value) {
    var t = String(value || '').trim();
    if (!t) return null;
    t = t.replace(' ', 'T');
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += '+09:00';
    var ms = Date.parse(t);
    return isFinite(ms) ? ms : null;
  }

  function csvWindowEndMs(label) {
    var raw = String(label || '').trim();
    if (!raw) return null;
    var parts = raw.split(/\s+-\s+/);
    return parseTokyoDateTime(parts[parts.length - 1]);
  }

  function csvCol(headers, names) {
    var i, j, h;
    for (i = 0; i < headers.length; i++) {
      h = String(headers[i] || '').trim();
      for (j = 0; j < names.length; j++) {
        if (h === names[j]) return i;
      }
    }
    return -1;
  }

  /**
   * Same 13:00 rule as extractFromRouteDetails, applied to Cortex Route CSV columns.
   * Time Window end == 13:00:00 JST, plannedEnd (予定時間) <= 13:00:00.000 JST,
   * 集荷 / PICK_UP excluded. Stop 2/3 stay included — no extra filter.
   */
  function extractFromCortexCsv(text, options) {
    options = options || {};
    var rows = parseCsv(text);
    if (!rows.length) {
      return { ok: false, error: ERROR.SCHEMA, message: 'CSVが空です', packages: [], stopCount: 0, packageCount: 0, stopNumbers: [] };
    }
    var headers = rows[0];
    var iStop = csvCol(headers, ['stop', '停留所番号']);
    var iWindow = csvCol(headers, ['timeWindow', 'Time Window']);
    var iPlanned = csvCol(headers, ['plannedEnd', '予定時間']);
    var iLabel = csvCol(headers, ['labelKind', '停止ラベル']);
    var iTrack = csvCol(headers, ['trackingId', '追跡ID', 'Tracking ID']);
    var iRoute = csvCol(headers, ['routeCode', 'ルート', 'Route']);
    if (iStop < 0 || iWindow < 0 || iPlanned < 0) {
      return { ok: false, error: ERROR.SCHEMA, message: 'CSV列（停留所番号 / Time Window / 予定時間）が見つかりません', packages: [], stopCount: 0, packageCount: 0, stopNumbers: [] };
    }

    var localDate = options.localDate || null;
    var packages = [];
    var routeCode = options.routeCode || '';
    var i;
    for (i = 1; i < rows.length; i++) {
      var row = rows[i] || [];
      var label = iLabel >= 0 ? String(row[iLabel] || '') : '';
      if (label === 'PICKUP' || label.indexOf('集荷') >= 0) continue;
      var windowEndMs = csvWindowEndMs(row[iWindow]);
      if (windowEndMs == null) continue;
      if (!isExact1300Clock(windowEndMs)) continue;
      var plannedEndMs = parseTokyoDateTime(row[iPlanned]);
      if (plannedEndMs == null) continue;
      if (!localDate) {
        var p0 = tokyoParts(windowEndMs);
        if (p0) localDate = [p0.year, p0.month, p0.day];
      }
      if (!isSameLocalDate(windowEndMs, localDate)) continue;
      if (!isOnOrBeforeCutoff(plannedEndMs)) continue;
      var stopNo = parseInt(row[iStop], 10);
      if (!routeCode && iRoute >= 0) routeCode = String(row[iRoute] || '').trim();
      var windowParts = String(row[iWindow] || '').split(/\s+-\s+/);
      packages.push({
        routeCode: iRoute >= 0 ? String(row[iRoute] || routeCode || '').trim() : routeCode,
        stop: isFinite(stopNo) ? stopNo : row[iStop],
        trackingId: iTrack >= 0 ? String(row[iTrack] || '').trim() : '',
        windowEndTime: windowEndMs,
        windowLabel: formatTokyoClock(parseTokyoDateTime(windowParts[0])) + '-' + formatTokyoClock(windowEndMs),
        plannedEndTime: plannedEndMs,
        plannedEndClock: formatTokyoClock(plannedEndMs)
      });
    }

    var stopSet = {};
    packages.forEach(function (p) { stopSet[p.stop] = true; });
    var stopNumbers = Object.keys(stopSet).map(function (s) { return parseInt(s, 10); }).sort(function (a, b) { return a - b; });
    var lastStop = stopNumbers.length ? stopNumbers[stopNumbers.length - 1] : null;
    var lastPkg = null;
    packages.forEach(function (p) { if (p.stop === lastStop) lastPkg = p; });
    return {
      ok: true,
      routeCode: routeCode,
      localDate: localDate,
      localDateKey: localDateKey(localDate),
      packages: packages,
      stopNumbers: stopNumbers,
      stopCount: stopNumbers.length,
      packageCount: packages.length,
      lastStop: lastStop,
      lastPlannedEndClock: lastPkg ? lastPkg.plannedEndClock : ''
    };
  }

  function finiteCoord(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function addressText(addr) {
    addr = addr || {};
    if (addr.fullAddress) return String(addr.fullAddress);
    if (addr.address) return String(addr.address);
    return [addr.address1, addr.address2, addr.address3, addr.city, addr.state, addr.postalCode]
      .filter(Boolean).join(' ');
  }

  function resolveStopAddress(details, stop, task) {
    var addresses = (details && Array.isArray(details.addresses)) ? details.addresses : [];
    var ids = [];
    function addId(v) {
      if (v == null || v === '') return;
      v = String(v);
      if (ids.indexOf(v) < 0) ids.push(v);
    }
    addId(task && task.addressId);
    addId(stop && stop.addressId);
    addId(task && task.destinationAddressId);
    addId(stop && stop.destinationAddressId);

    var addr = null;
    for (var i = 0; i < addresses.length && !addr; i++) {
      var a = addresses[i] || {};
      var aid = a.addressId != null ? String(a.addressId) : '';
      var id = a.id != null ? String(a.id) : '';
      if ((aid && ids.indexOf(aid) >= 0) || (id && ids.indexOf(id) >= 0)) addr = a;
    }
    if (!addr && addresses.length === 1) addr = addresses[0] || {};

    var lat = finiteCoord(addr && (addr.latitude != null ? addr.latitude :
      (addr.lat != null ? addr.lat : (addr.geoLocation && addr.geoLocation.latitude))));
    var lng = finiteCoord(addr && (addr.longitude != null ? addr.longitude :
      (addr.lng != null ? addr.lng : (addr.geoLocation && addr.geoLocation.longitude))));
    return { address: addressText(addr), latitude: lat, longitude: lng };
  }

  function summarizeResults(results, failures) {
    var routes = [];
    var packages = [];
    var routeStops = [];
    var packageSequenceIndex = [];
    var packageSequenceDiagnostics = emptyPackageSequenceDiagnostics();
    var packageAssistIndex = [];
    var packageAssistDiagnostics = emptyPackageAssistDiagnostics();
    (results || []).forEach(function (r) {
      if (!r || !r.ok) return;
      routes.push(r);
      (r.packages || []).forEach(function (p) {
        packages.push(Object.assign({ driverName: r.driverName }, p));
      });
      (r.routeStops || []).forEach(function (s) {
        routeStops.push(Object.assign({ driverName: r.driverName }, s));
      });
      (r.packageSequenceIndex || []).forEach(function (row) {
        packageSequenceIndex.push(row);
      });
      (r.packageAssistIndex || []).forEach(function (row) {
        packageAssistIndex.push(row);
      });
      var d = r.packageSequenceDiagnostics;
      if (d) {
        packageSequenceDiagnostics.skippedMissingTrackingId += d.skippedMissingTrackingId || 0;
        packageSequenceDiagnostics.skippedMissingSequence += d.skippedMissingSequence || 0;
        packageSequenceDiagnostics.skippedEmptyTasks += d.skippedEmptyTasks || 0;
        (d.duplicateTrackingIdConflicts || []).forEach(function (c) {
          packageSequenceDiagnostics.duplicateTrackingIdConflicts.push(c);
        });
        Object.keys(d.byRoute || {}).forEach(function (rc) {
          packageSequenceDiagnostics.byRoute[rc] = (packageSequenceDiagnostics.byRoute[rc] || 0) + (d.byRoute[rc] || 0);
        });
      }
      var ad = r.packageAssistDiagnostics;
      if (ad) {
        packageAssistDiagnostics.trDetailsCaptured = Math.max(
          packageAssistDiagnostics.trDetailsCaptured || 0,
          ad.trDetailsCaptured || 0
        );
        packageAssistDiagnostics.trDetailsMissing += ad.trDetailsMissing || 0;
        packageAssistDiagnostics.assistMatched += ad.assistMatched || 0;
        packageAssistDiagnostics.assistUnmatched += ad.assistUnmatched || 0;
        packageAssistDiagnostics.skippedMissingTrackingId += ad.skippedMissingTrackingId || 0;
        packageAssistDiagnostics.skippedMissingReferenceId += ad.skippedMissingReferenceId || 0;
        Object.keys(ad.byRoute || {}).forEach(function (rc) {
          packageAssistDiagnostics.byRoute[rc] = (packageAssistDiagnostics.byRoute[rc] || 0) + (ad.byRoute[rc] || 0);
        });
      }
    });
    packageSequenceDiagnostics.indexCount = packageSequenceIndex.length;
    packageAssistDiagnostics.indexCount = packageAssistIndex.length;
    packages.sort(function (a, b) {
      if (a.routeCode !== b.routeCode) {
        return String(a.routeCode || '').localeCompare(String(b.routeCode || ''), 'en', { numeric: true });
      }
      return (a.stop || 0) - (b.stop || 0);
    });
    var stopKeys = {};
    packages.forEach(function (p) { stopKeys[p.routeCode + '#' + p.stop] = true; });
    return {
      routes: routes,
      packages: packages,
      routeStops: routeStops,
      packageSequenceIndex: packageSequenceIndex,
      packageSequenceDiagnostics: packageSequenceDiagnostics,
      packageSequenceRouteCount: Object.keys(packageSequenceDiagnostics.byRoute).length,
      packageAssistIndex: packageAssistIndex,
      packageAssistDiagnostics: packageAssistDiagnostics,
      routeCount: routes.length,
      stopCount: Object.keys(stopKeys).length,
      packageCount: packages.length,
      failures: failures || []
    };
  }

  function formatFetchReport(stats) {
    stats = stats || {};
    var savedLine = stats.saved === false ? 'JSON保存に失敗しました。' : 'JSONを保存しました。';
    var lines;
    if (stats.summariesOk === false) {
      lines = ['route-summaries 取得失敗', ''];
      if (stats.summariesStatus != null && stats.summariesStatus !== '') {
        lines.push('HTTP ' + stats.summariesStatus);
      }
      lines.push(stats.summariesError || 'ERROR');
      if (stats.summariesError === 'UNAUTHORIZED' || stats.summariesStatus === 401) {
        lines.push('セッション切れ・未ログイン');
      } else if (stats.summariesError === 'FORBIDDEN' || stats.summariesStatus === 403) {
        lines.push('権限不足');
      }
      lines.push('');
      lines.push(savedLine);
      return lines.join('\n');
    }
    lines = [
      'Cortex取得完了',
      '',
      '全Route: ' + (stats.totalRouteCount != null ? stats.totalRouteCount : '-'),
      '11時Route: ' + (stats.selectedRouteCount != null ? stats.selectedRouteCount : '-'),
      '取得成功: ' + (stats.successCount != null ? stats.successCount : '-'),
      '取得失敗: ' + (stats.failureCount != null ? stats.failureCount : '-')
    ];
    (stats.failures || []).forEach(function (f) {
      if (!f) return;
      lines.push('');
      lines.push('FAILED');
      lines.push(f.routeCode || f.routeId || '?');
      if (f.httpStatus != null && f.httpStatus !== '') lines.push('HTTP ' + f.httpStatus);
      lines.push(f.error || 'ERROR');
    });
    lines.push('');
    lines.push(savedLine);
    return lines.join('\n');
  }

  // Bag / Driver Aid enrichment (optional). Exact JOIN only: referenceId === trId.
  // Color codes confirmed from Cortex frontend _I map. JP labels only where confirmed.
  var BAG_COLOR_BY_CODE = {
    BLK: { color: 'Black', ja: '黒' },
    RED: { color: 'Red', ja: '赤' },
    NVY: { color: 'Navy', ja: 'Navy' },
    YLO: { color: 'Yellow', ja: '黄色' },
    GRY: { color: 'Gray', ja: 'Gray' },
    WHT: { color: 'White', ja: 'White' },
    BRO: { color: 'Brown', ja: 'Brown' },
    ORG: { color: 'Orange', ja: 'Orange' },
    PRP: { color: 'Purple', ja: '紫' },
    GRN: { color: 'Green', ja: 'Green' },
    PNK: { color: 'Pink', ja: 'Pink' }
  };

  function emptyPackageAssistDiagnostics() {
    return {
      trDetailsCaptured: 0,
      trDetailsMissing: 0,
      assistMatched: 0,
      assistUnmatched: 0,
      skippedMissingTrackingId: 0,
      skippedMissingReferenceId: 0,
      indexCount: 0,
      byRoute: {}
    };
  }

  function parseBagName(bagName) {
    var raw = bagName == null ? '' : String(bagName).trim();
    var out = {
      bagName: raw || null,
      bagColorCode: null,
      bagColor: null,
      bagNumber: null,
      bagDisplay: null
    };
    if (!raw) return out;
    // Cortex frontend c5e("bag", bagName): split("-"), last segment color code,
    // bag number = previous segment (or prefix before "_" in last segment).
    var parts = raw.split('-');
    if (parts.length <= 2) return out;
    var last = parts[parts.length - 1] || '';
    var bagNumber = parts[parts.length - 2] || '';
    if (last.indexOf('_') >= 0) bagNumber = last.split('_')[0] || bagNumber;
    if (!last || last.length < 3) return out;
    var code = last.slice(-3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return out;
    out.bagNumber = bagNumber ? String(bagNumber) : null;
    var mapped = BAG_COLOR_BY_CODE[code];
    if (!mapped) return out; // unknown code: keep raw + bagNumber, do not invent color
    out.bagColorCode = code;
    out.bagColor = mapped.color;
    out.bagDisplay = (mapped.ja || mapped.color) + (out.bagNumber ? (' ' + out.bagNumber) : '');
    return out;
  }

  function parseTrDetailsBody(body) {
    var map = {};
    var list = body && Array.isArray(body.trDetails) ? body.trDetails : [];
    list.forEach(function (row) {
      if (!row) return;
      var trId = String(row.trId || '').trim();
      if (!trId) return;
      var bagName = row.bagName == null || row.bagName === '' ? null : String(row.bagName);
      var bagScannableId = row.bagScannableId == null || row.bagScannableId === ''
        ? null
        : String(row.bagScannableId);
      var row1 = {};
      row1[trId] = { trId: trId, bagName: bagName, bagScannableId: bagScannableId };
      mergeTrDetailsMaps(map, row1);
    });
    return map;
  }

  // A later bagName:null (e.g. after delivery) never erases a bag captured earlier.
  // null -> non-null upgrades normally.
  function mergeTrDetailsMaps(into, from) {
    into = into || {};
    from = from || {};
    Object.keys(from).forEach(function (trId) {
      if (!trId || !from[trId]) return;
      var prev = Object.prototype.hasOwnProperty.call(into, trId) ? into[trId] : null;
      var next = from[trId];
      if (prev && prev.bagName && !next.bagName) {
        into[trId] = Object.assign({}, prev, { nullSeenAfterCapture: true });
        return;
      }
      into[trId] = next;
    });
    return into;
  }

  // ---- Bag enrichment phase (optional; runs only after the normal route tour) ----
  // Native Cortex UI click -> Cortex's own POST /tasks/trDetails -> existing interceptor.
  // Never builds an API request. Results never go into store.failures.
  var BAG_STATUS = {
    CAPTURED: 'captured',
    CAPTURED_NULL: 'captured_null',
    NOT_ATTEMPTED: 'not_attempted',
    DOM_NOT_FOUND: 'dom_not_found',
    DOM_AMBIGUOUS: 'dom_ambiguous',
    CLICK_FAILED: 'click_failed',
    TIMEOUT: 'timeout',
    STOP_NOT_FOUND: 'stop_not_found',
    STOP_AMBIGUOUS: 'stop_ambiguous',
    STOP_EXPAND_FAILED: 'stop_expand_failed',
    PACKAGE_DOM_NOT_FOUND: 'package_dom_not_found',
    PACKAGE_CLICK_TARGET_NOT_FOUND: 'package_click_target_not_found',
    ROUTE_ABORTED: 'route_aborted'
  };

  function hasTrDetails(trDetailsByTrId, referenceId) {
    return !!(trDetailsByTrId && referenceId &&
      Object.prototype.hasOwnProperty.call(trDetailsByTrId, referenceId));
  }

  // captured / captured_null once the trId Response is stored; null when not yet fetched.
  function capturedBagStatus(trDetailsByTrId, referenceId) {
    if (!hasTrDetails(trDetailsByTrId, referenceId)) return null;
    var tr = trDetailsByTrId[referenceId];
    return tr && tr.bagName ? BAG_STATUS.CAPTURED : BAG_STATUS.CAPTURED_NULL;
  }

  // Same 13:00 rule as extractFromRouteDetails.
  function isPriorityDropOff(stop, task, localDate) {
    if (!stop || !task || task.taskType !== 'DROP_OFF') return false;
    var plannedEndMs = epochToMs(stop.plannedEndTime);
    if (plannedEndMs == null) return false;
    var windowEndMs = epochToMs(task.windowEndTime);
    if (windowEndMs == null) return false;
    if (!isExact1300Clock(windowEndMs)) return false;
    if (!isSameLocalDate(windowEndMs, localDate)) return false;
    return isOnOrBeforeCutoff(plannedEndMs);
  }

  function compareBagTargets(a, b) {
    var rc = String(a.routeCode || '').localeCompare(String(b.routeCode || ''), 'en', { numeric: true });
    if (rc) return rc;
    return Number(a.stop || 0) - Number(b.stop || 0);
  }

  // 13:00 priority packages that still need a native trDetails click.
  // DOM key is task.domainMap.scannableId only (no trackingIdOf fallback).
  function selectBagTargets(detailsList, trDetailsByTrId) {
    var out = {
      targets: [],
      priorityCount: 0,
      skipped: { alreadyCaptured: 0, missingScannableId: 0, missingReferenceId: 0, duplicateReferenceId: 0 }
    };
    var seen = {};
    (detailsList || []).forEach(function (details) {
      var rd = details && details.rmsRouteDetails;
      if (!rd || !Array.isArray(rd.stops)) return;
      rd.stops.forEach(function (stop) {
        if (!stop || !Array.isArray(stop.tasks)) return;
        stop.tasks.forEach(function (task) {
          if (!isPriorityDropOff(stop, task, rd.localDate)) return;
          out.priorityCount += 1;
          var referenceId = String(task.referenceId || '').trim();
          var map = task.domainMap || {};
          var scannableId = String(map.scannableId || '').trim();
          if (!referenceId) { out.skipped.missingReferenceId += 1; return; }
          if (hasTrDetails(trDetailsByTrId, referenceId)) { out.skipped.alreadyCaptured += 1; return; }
          if (!scannableId) { out.skipped.missingScannableId += 1; return; }
          if (seen[referenceId]) { out.skipped.duplicateReferenceId += 1; return; }
          seen[referenceId] = true;
          out.targets.push({
            routeId: String(rd.routeId || ''),
            routeCode: String(rd.routeCode || ''),
            stop: stop.sequenceNumber,
            scannableId: scannableId,
            referenceId: referenceId
          });
        });
      });
    });
    out.targets.sort(compareBagTargets);
    return out;
  }

  function groupBagTargetsByRoute(targets) {
    var groups = [];
    var byId = {};
    (targets || []).forEach(function (t) {
      var key = t.routeId || t.routeCode;
      if (!byId[key]) {
        byId[key] = { routeId: t.routeId, routeCode: t.routeCode, targets: [] };
        groups.push(byId[key]);
      }
      byId[key].targets.push(t);
    });
    return groups;
  }

  // entries: [{ text, key }]. Exact textContent.trim() === scannableId only.
  function indexExactDomTextMatches(entries, wanted) {
    var want = {};
    (wanted || []).forEach(function (w) { if (w) want[String(w)] = true; });
    var out = {};
    (entries || []).forEach(function (e) {
      if (!e) return;
      var text = String(e.text == null ? '' : e.text).trim();
      if (!text || !Object.prototype.hasOwnProperty.call(want, text)) return;
      if (!out[text]) out[text] = [];
      if (out[text].indexOf(e.key) < 0) out[text].push(e.key);
    });
    return out;
  }

  function domMatchStatus(matches) {
    var n = Array.isArray(matches) ? matches.length : 0;
    if (n === 0) return 'none';
    if (n === 1) return 'unique';
    return 'ambiguous';
  }

  function createBagRun(targets) {
    return {
      id: 'bag-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      targets: (targets || []).slice(),
      attempted: {},
      results: {},
      clicks: 0,
      ended: false,
      aborted: ''
    };
  }

  function bagTargetAttempted(run, referenceId) {
    return !!(run && run.attempted && Object.prototype.hasOwnProperty.call(run.attempted, referenceId));
  }

  function markBagAttempted(run, referenceId) {
    if (run && referenceId) run.attempted[referenceId] = true;
  }

  function recordBagResult(run, referenceId, status, detail) {
    if (!run || !referenceId) return;
    markBagAttempted(run, referenceId);
    run.results[referenceId] = { status: status, detail: detail || '' };
  }

  // Targets still worth one click: not captured yet and not attempted in this run.
  function pendingBagTargets(run, targets, trDetailsByTrId) {
    return (targets || []).filter(function (t) {
      if (!t || !t.referenceId) return false;
      if (hasTrDetails(trDetailsByTrId, t.referenceId)) return false;
      return !bagTargetAttempted(run, t.referenceId);
    });
  }

  function emptyBagCounts() {
    var counts = {};
    Object.keys(BAG_STATUS).forEach(function (k) { counts[BAG_STATUS[k]] = 0; });
    return counts;
  }

  // Captured Response wins over attempt outcome (e.g. a timeout later satisfied
  // by a multi-row Response). Untouched targets stay not_attempted.
  function summarizeBagRun(run, trDetailsByTrId) {
    var counts = emptyBagCounts();
    var byReferenceId = {};
    ((run && run.targets) || []).forEach(function (t) {
      var status = capturedBagStatus(trDetailsByTrId, t.referenceId);
      if (!status) {
        var r = run.results[t.referenceId];
        status = r && r.status ? r.status : BAG_STATUS.NOT_ATTEMPTED;
      }
      byReferenceId[t.referenceId] = status;
      counts[status] = (counts[status] || 0) + 1;
    });
    return {
      targetCount: ((run && run.targets) || []).length,
      clicks: (run && run.clicks) || 0,
      stopClicks: (run && run.stopClicks) || 0,
      routeResults: ((run && run.routeResults) || []).slice(),
      aborted: (run && run.aborted) || '',
      counts: counts,
      byReferenceId: byReferenceId
    };
  }

  var BAG_SUMMARY_LABELS = [
    ['captured', 'captured'],
    ['captured_null', 'null'],
    ['stop_not_found', 'Stop未発見'],
    ['stop_ambiguous', 'Stop重複'],
    ['stop_expand_failed', 'Stop展開失敗'],
    ['package_dom_not_found', 'Package未発見'],
    ['dom_not_found', 'not found'],
    ['package_click_target_not_found', '荷物番号click対象なし'],
    ['dom_ambiguous', 'ambiguous'],
    ['click_failed', 'click失敗'],
    ['timeout', 'timeout'],
    ['route_aborted', 'Route中断'],
    ['not_attempted', '未試行']
  ];

  function formatBagSummary(summary) {
    var c = (summary && summary.counts) || emptyBagCounts();
    var parts = ['Bag取得完了 対象 ' + ((summary && summary.targetCount) || 0)];
    BAG_SUMMARY_LABELS.forEach(function (pair) {
      var always = pair[0] === 'captured' || pair[0] === 'captured_null' || pair[0] === 'timeout' || pair[0] === 'not_attempted';
      if (always || c[pair[0]]) parts.push(pair[1] + ' ' + (c[pair[0]] || 0));
    });
    parts.push('click ' + ((summary && summary.clicks) || 0));
    parts.push('Stop click ' + ((summary && summary.stopClicks) || 0));
    var text = parts.join(' / ');
    if (summary && summary.aborted) text += ' / 中断: ' + summary.aborted;
    return text;
  }

  // Normal tour results are frozen before the Bag phase and restored after it,
  // so Cortex re-fetches while re-opening Routes can neither change them nor add failures.
  function snapshotNormalCapture(store) {
    store = store || {};
    return {
      summaries: store.summaries || null,
      detailsByRouteId: Object.assign({}, store.detailsByRouteId || {}),
      failures: (store.failures || []).slice()
    };
  }

  function restoreNormalCapture(store, snap) {
    if (!store || !snap) return store;
    store.summaries = snap.summaries;
    store.detailsByRouteId = Object.assign({}, snap.detailsByRouteId);
    store.failures = snap.failures.slice();
    return store;
  }

  // ---- Bag v2: Route -> Stop -> Package engine (DOM-free; the runner supplies the driver) ----
  // Stop labels: exact number only ("#16", "Stop 16", "Stop #16", "ストップ 16"). "#1" never matches 11.
  var STOP_LABEL_PATTERNS = [
    /^#\s*(\d{1,4})$/,
    /^(?:stop|ストップ|停車地)\s*#?\s*(\d{1,4})$/i
  ];

  function parseStopLabel(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t || t.length > 20) return null;
    for (var i = 0; i < STOP_LABEL_PATTERNS.length; i++) {
      var m = t.match(STOP_LABEL_PATTERNS[i]);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // entries: [{ text, key }] -> keys whose text is exactly a label for sequenceNumber.
  function matchStopLabelEntries(entries, sequenceNumber) {
    var want = Number(sequenceNumber);
    var out = [];
    if (!isFinite(want)) return out;
    (entries || []).forEach(function (e) {
      if (!e) return;
      if (parseStopLabel(e.text) === want && out.indexOf(e.key) < 0) out.push(e.key);
    });
    return out;
  }

  // Package-number-like token (e.g. DA0012405022); used only to bound a package card.
  function isPackageNumberText(text) {
    return /^[A-Z]{2,4}\d{8,14}$/.test(String(text == null ? '' : text).trim());
  }

  function groupBagTargetsByStop(targets) {
    var stops = [];
    var bySeq = {};
    (targets || []).forEach(function (t) {
      var key = String(t.stop);
      if (!bySeq[key]) {
        bySeq[key] = { stop: t.stop, targets: [] };
        stops.push(bySeq[key]);
      }
      bySeq[key].targets.push(t);
    });
    stops.sort(function (a, b) { return Number(a.stop || 0) - Number(b.stop || 0); });
    return stops;
  }

  // Any pending DA of the Stop already rendered -> the Stop is open; do not click (would collapse).
  function stopNeedsExpand(stopTargets, presentByScannableId) {
    presentByScannableId = presentByScannableId || {};
    return !(stopTargets || []).some(function (t) {
      var list = presentByScannableId[t.scannableId];
      return Array.isArray(list) && list.length > 0;
    });
  }

  function formatBagProgress(p) {
    p = p || {};
    var lines = ['Bag取得中'];
    if (p.routeTotal) lines.push('Route ' + (p.routeIndex || 0) + '/' + p.routeTotal + ' ' + (p.routeCode || ''));
    if (p.stopTotal) lines.push('Stop ' + (p.stopIndex || 0) + '/' + p.stopTotal + (p.stopSeq != null ? ' (#' + p.stopSeq + ')' : ''));
    if (p.packageTotal) lines.push('Package ' + (p.packageIndex || 0) + '/' + p.packageTotal + (p.scannableId ? ' ' + p.scannableId : ''));
    lines.push('状態: ' + (p.state || '-'));
    lines.push('click ' + (p.clicks || 0) + ' / Stop click ' + (p.stopClicks || 0));
    return lines.join('\n');
  }

  /**
   * opts: { run, routes:[{routeId, routeCode, targets}], getTrMap(), driver, onProgress(p),
   *         routeBudgetMs, now(), done(abortedMessage) }
   * driver (all async via callback):
   *   openRoute(route, cb({ok, detail}))
   *   ensureStop(stop, pendingTargets, onState(text), cb({ok, clicked, status, detail, abortRoute}))
   *   findPackage(target, stop, cb({ok, handle, status, detail}))
   *   clickPackage(target, handle, cb({ok, detail, abortRoute}))
   *   waitTrDetails(target, cb(gotBoolean))
   *   restoreAfterPackage(target, cb({ok, detail}))
   *   leaveStop(stop, cb({ok, detail}))
   *   returnToList(cb({ok, detail}))
   * One Route failing marks that Route route_aborted and continues when the list is back.
   */
  function runBagEngine(opts) {
    var run = opts.run;
    var driver = opts.driver;
    var routes = opts.routes || [];
    var now = opts.now || function () { return Date.now(); };
    var budget = opts.routeBudgetMs > 0 ? opts.routeBudgetMs : 90000;
    var progress = {
      routeIndex: 0, routeTotal: routes.length, routeCode: '',
      stopIndex: 0, stopTotal: 0, stopSeq: null,
      packageIndex: 0, packageTotal: 0, scannableId: '', state: ''
    };
    run.routeResults = run.routeResults || [];
    run.stopClicks = run.stopClicks || 0;
    var finished = false;

    function emit(patch) {
      Object.keys(patch || {}).forEach(function (k) { progress[k] = patch[k]; });
      progress.clicks = run.clicks;
      progress.stopClicks = run.stopClicks;
      if (typeof opts.onProgress === 'function') opts.onProgress(Object.assign({}, progress));
    }
    function trMap() { return opts.getTrMap(); }
    function pend(targets) { return pendingBagTargets(run, targets, trMap()); }
    function stopped() { return finished || run.ended || run.stopRequested; }
    function finish(aborted) {
      if (finished) return;
      finished = true;
      opts.done(aborted || '');
    }
    function markAll(targets, status, detail) {
      pend(targets).forEach(function (t) { recordBagResult(run, t.referenceId, status, detail || ''); });
    }

    function nextRoute(i) {
      if (stopped()) return;
      if (i >= routes.length) { finish(''); return; }
      var route = routes[i];
      if (!pend(route.targets).length) { nextRoute(i + 1); return; }
      var stops = groupBagTargetsByStop(route.targets);
      var deadline = now() + budget;
      var result = { routeCode: route.routeCode, status: 'done', detail: '', stopClicks: 0 };
      run.routeResults.push(result);

      function abortRoute(detail) {
        result.status = BAG_STATUS.ROUTE_ABORTED;
        result.detail = detail || '';
        markAll(route.targets, BAG_STATUS.ROUTE_ABORTED, detail);
        back();
      }

      function back() {
        emit({ state: 'Route一覧へ復帰中' });
        driver.returnToList(function (res) {
          if (stopped()) return;
          if (!res || !res.ok) {
            if (result.status !== BAG_STATUS.ROUTE_ABORTED) {
              result.status = BAG_STATUS.ROUTE_ABORTED;
              result.detail = (res && res.detail) || 'Route一覧へ戻れません';
            }
            finish('Route一覧へ戻れませんでした（' + route.routeCode + '）' + (res && res.detail ? ': ' + res.detail : ''));
            return;
          }
          nextRoute(i + 1);
        });
      }

      function nextStop(j) {
        if (stopped()) return;
        if (j >= stops.length) { back(); return; }
        var stop = stops[j];
        var list = pend(stop.targets);
        if (!list.length) { nextStop(j + 1); return; }
        if (now() > deadline) { abortRoute('Route上限時間を超過'); return; }
        emit({
          stopIndex: j + 1, stopSeq: stop.stop,
          packageIndex: 0, packageTotal: stop.targets.length, scannableId: '',
          state: 'Stop #' + stop.stop + '探索中'
        });
        driver.ensureStop(stop, list, function (state) { emit({ state: state }); }, function (res) {
          if (stopped()) return;
          if (res && res.clicked) {
            run.stopClicks += 1;
            result.stopClicks += 1;
          }
          if (!res || !res.ok) {
            markAll(stop.targets, (res && res.status) || BAG_STATUS.STOP_NOT_FOUND, res && res.detail);
            if (res && res.abortRoute) { abortRoute(res.detail); return; }
            nextStop(j + 1);
            return;
          }
          nextPackage(stop, function () {
            driver.leaveStop(stop, function (lres) {
              if (stopped()) return;
              if (!lres || !lres.ok) { abortRoute((lres && lres.detail) || 'Stopから戻れません'); return; }
              nextStop(j + 1);
            });
          });
        });
      }

      function nextPackage(stop, doneStop) {
        if (stopped()) return;
        var list = pend(stop.targets);
        if (!list.length) { doneStop(); return; }
        if (now() > deadline) { abortRoute('Route上限時間を超過'); return; }
        var t = list[0];
        emit({ packageIndex: stop.targets.indexOf(t) + 1, scannableId: t.scannableId, state: t.scannableId + '探索中' });
        driver.findPackage(t, stop, function (res) {
          if (stopped()) return;
          if (!res || !res.ok) {
            recordBagResult(run, t.referenceId, (res && res.status) || BAG_STATUS.PACKAGE_DOM_NOT_FOUND, res && res.detail);
            nextPackage(stop, doneStop);
            return;
          }
          markBagAttempted(run, t.referenceId);
          run.clicks += 1;
          emit({ state: '荷物番号クリック' });
          driver.clickPackage(t, res.handle, function (cres) {
            if (stopped()) return;
            if (!cres || !cres.ok) {
              recordBagResult(run, t.referenceId, BAG_STATUS.CLICK_FAILED, cres && cres.detail);
              if (cres && cres.abortRoute) { abortRoute(cres.detail); return; }
              nextPackage(stop, doneStop);
              return;
            }
            emit({ state: 'trDetails待機中' });
            driver.waitTrDetails(t, function (got) {
              if (stopped()) return;
              var status = got ? capturedBagStatus(trMap(), t.referenceId) : null;
              recordBagResult(run, t.referenceId, status || BAG_STATUS.TIMEOUT, status ? '' : 'trDetails not observed');
              emit({ state: status || BAG_STATUS.TIMEOUT });
              driver.restoreAfterPackage(t, function (rres) {
                if (stopped()) return;
                if (!rres || !rres.ok) { abortRoute((rres && rres.detail) || 'Package detailから戻れません'); return; }
                nextPackage(stop, doneStop);
              });
            });
          });
        });
      }

      emit({
        routeIndex: i + 1, routeCode: route.routeCode,
        stopIndex: 0, stopTotal: stops.length, stopSeq: null,
        packageIndex: 0, packageTotal: 0, scannableId: '', state: 'Routeを開いています'
      });
      driver.openRoute(route, function (res) {
        if (stopped()) return;
        if (!res || !res.ok) { abortRoute((res && res.detail) || 'Routeを開けません'); return; }
        nextStop(0);
      });
    }

    nextRoute(0);
  }

  function extractPackageAssistIndex(details, trDetailsByTrId, bagStatusByReferenceId) {
    var diagnostics = emptyPackageAssistDiagnostics();
    trDetailsByTrId = trDetailsByTrId || {};
    diagnostics.trDetailsCaptured = Object.keys(trDetailsByTrId).length;
    if (!details || !details.rmsRouteDetails || !Array.isArray(details.rmsRouteDetails.stops)) {
      return {
        ok: false,
        routeCode: details && details.rmsRouteDetails ? details.rmsRouteDetails.routeCode : '',
        routeId: details && details.rmsRouteDetails ? details.rmsRouteDetails.routeId : '',
        index: [],
        diagnostics: diagnostics
      };
    }
    var rd = details.rmsRouteDetails;
    var routeCode = String(rd.routeCode || '');
    var index = [];
    rd.stops.forEach(function (stop) {
      if (!stop) return;
      var tasks = Array.isArray(stop.tasks) ? stop.tasks : [];
      tasks.forEach(function (task) {
        if (!task || task.taskType !== 'DROP_OFF') return;
        var tid = trackingIdOf(task);
        if (!tid) {
          diagnostics.skippedMissingTrackingId += 1;
          return;
        }
        var referenceId = String(task.referenceId || '').trim();
        if (!referenceId) {
          diagnostics.skippedMissingReferenceId += 1;
        }
        var driverAid = task.driverAssistText == null || task.driverAssistText === ''
          ? null
          : String(task.driverAssistText);
        var tr = hasTrDetails(trDetailsByTrId, referenceId) ? trDetailsByTrId[referenceId] : null;
        var bagName = tr && tr.bagName ? String(tr.bagName) : null;
        var bagScannableId = tr && tr.bagScannableId ? String(tr.bagScannableId) : null;
        var parsed = parseBagName(bagName);
        if (referenceId && tr) diagnostics.assistMatched += 1;
        else if (referenceId) {
          diagnostics.assistUnmatched += 1;
          diagnostics.trDetailsMissing += 1;
        }
        index.push({
          routeCode: routeCode,
          trackingId: tid,
          referenceId: referenceId || null,
          driverAid: driverAid,
          bagName: bagName,
          bagScannableId: bagScannableId,
          bagColorCode: parsed.bagColorCode,
          bagColor: parsed.bagColor,
          bagNumber: parsed.bagNumber,
          bagDisplay: parsed.bagDisplay,
          bagStatus: tr
            ? capturedBagStatus(trDetailsByTrId, referenceId)
            : ((bagStatusByReferenceId && referenceId && bagStatusByReferenceId[referenceId]) || BAG_STATUS.NOT_ATTEMPTED),
          bagSource: tr ? 'trDetails' : null
        });
      });
    });
    diagnostics.indexCount = index.length;
    if (routeCode) diagnostics.byRoute[routeCode] = index.length;
    return {
      ok: true,
      routeCode: routeCode,
      routeId: rd.routeId || '',
      index: index,
      diagnostics: diagnostics
    };
  }

  function createCaptureStore() {
    return { summaries: null, detailsByRouteId: {}, trDetailsByTrId: {}, failures: [] };
  }

  function isCortexApiCaptureUrl(url) {
    var s = String(url || '');
    return /\/operations\/execution\/api\/route-summaries(?:[/?#]|$)/.test(s) ||
      /\/operations\/execution\/api\/route-details\//.test(s) ||
      /\/operations\/execution\/api\/tasks\/trDetails(?:[/?#]|$)/.test(s);
  }

  function routeIdFromDetailsUrl(url) {
    var s = String(url || '');
    var m = s.match(/\/route-details\/([^/?#]+)/);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  function secretCaptureKey(key) {
    var k = String(key || '').toLowerCase();
    return k === 'cookie' || k === 'set-cookie' || k === 'authorization' ||
      k.indexOf('hmac') >= 0 || k.indexOf('x-cortex-') === 0 || k === 'user-ref';
  }

  function sanitizeCapturedJson(value) {
    try {
      return JSON.parse(JSON.stringify(value, function (k, v) {
        if (k && secretCaptureKey(k)) return undefined;
        return v;
      }));
    } catch (e) {
      return {
        details: [],
        failures: [{ error: 'JSON_PARSE', message: '捕捉データの出力に失敗しました' }]
      };
    }
  }

  function applyCapturedCortexResponse(store, evt) {
    if (!store) store = createCaptureStore();
    evt = evt || {};
    var url = evt.url || '';
    var status = Number(evt.status);
    var body = evt.body;
    // Response JSON only. Never read Cookie / Authorization / HMAC / session / timestamp.
    if (body && typeof body === 'object') body = sanitizeCapturedJson(body);
    if (!isCortexApiCaptureUrl(url)) return store;
    if (/\/route-summaries(?:[/?#]|$)/.test(url)) {
      if (status >= 200 && status < 300 && body && Array.isArray(body.rmsRouteSummaries)) {
        store.summaries = body;
      } else {
        store.failures.push({
          error: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : ('HTTP_' + status),
          httpStatus: status,
          message: 'route-summaries HTTP ' + status
        });
      }
      return store;
    }
    if (/\/tasks\/trDetails(?:[/?#]|$)/.test(url)) {
      if (!store.trDetailsByTrId) store.trDetailsByTrId = {};
      if (status >= 200 && status < 300 && body && Array.isArray(body.trDetails)) {
        mergeTrDetailsMaps(store.trDetailsByTrId, parseTrDetailsBody(body));
      }
      return store;
    }
    var routeId = routeIdFromDetailsUrl(url);
    if (!routeId && body && body.rmsRouteDetails && body.rmsRouteDetails.routeId) {
      routeId = String(body.rmsRouteDetails.routeId);
    }
    if (status >= 200 && status < 300 && body && body.rmsRouteDetails) {
      if (routeId) {
        store.detailsByRouteId[routeId] = body;
        store.failures = (store.failures || []).filter(function (f) {
          return !(f && f.routeId === routeId &&
            (f.error === ERROR.TIMEOUT || f.error === ERROR.DOM_NOT_FOUND));
        });
      }
    } else {
      store.failures.push({
        routeId: routeId,
        routeCode: body && body.rmsRouteDetails && body.rmsRouteDetails.routeCode,
        error: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : ('HTTP_' + status),
        httpStatus: status,
        message: 'route-details HTTP ' + status
      });
    }
    return store;
  }

  function buildCaptureBundle(store, extras) {
    extras = extras || {};
    store = store || createCaptureStore();
    var details = [];
    Object.keys(store.detailsByRouteId).forEach(function (id) {
      details.push(store.detailsByRouteId[id]);
    });
    var trDetails = [];
    Object.keys(store.trDetailsByTrId || {}).forEach(function (trId) {
      trDetails.push(store.trDetailsByTrId[trId]);
    });
    var summaries = store.summaries || null;
    var total = summaries && Array.isArray(summaries.rmsRouteSummaries)
      ? summaries.rmsRouteSummaries.length
      : details.length;
    var eleven = summaries ? selectElevenOClockRoutes(summaries) : { ok: false, routes: [] };
    var bundle = {
      localDate: extras.localDate || '',
      captureMode: 'spa-intercept',
      summaries: summaries,
      details: details,
      trDetails: trDetails,
      bagStatusByReferenceId: store.bagStatusByReferenceId ? Object.assign({}, store.bagStatusByReferenceId) : undefined,
      failures: (store.failures || []).slice(),
      totalRouteCount: total,
      selectedRouteCount: eleven.ok ? eleven.routes.length : details.length
    };
    return sanitizeCapturedJson(bundle);
  }

  function createTourState(opts) {
    opts = opts || {};
    return {
      status: 'idle',
      routes: [],
      index: 0,
      currentRouteId: '',
      currentRouteCode: '',
      timeoutMs: opts.timeoutMs > 0 ? Number(opts.timeoutMs) : 15000,
      waitingSince: 0,
      visitedRouteIds: {}
    };
  }

  function tourRoutesFromSummaries(summaries) {
    var sel = selectElevenOClockRoutes(summaries);
    if (!sel || !sel.ok) return [];
    return (sel.routes || []).slice();
  }

  function armTour(store, tour) {
    tour = tour || createTourState();
    var visited = tour.visitedRouteIds || {};
    var routes = (store && store.summaries) ? tourRoutesFromSummaries(store.summaries) : [];
    tour.routes = routes;
    tour.index = 0;
    tour.currentRouteId = '';
    tour.currentRouteCode = '';
    tour.visitedRouteIds = visited;
    if (!store || !store.summaries) tour.status = 'idle';
    else tour.status = routes.length ? 'running' : 'done';
    return tour;
  }

  function tourProgress(store, tour) {
    store = store || createCaptureStore();
    tour = tour || createTourState();
    var selected = (tour.routes || []).length;
    var success = 0;
    (tour.routes || []).forEach(function (r) {
      if (r && r.routeId && store.detailsByRouteId[r.routeId]) success += 1;
    });
    return {
      summariesReady: !!store.summaries,
      selectedCount: selected,
      detailsCount: success,
      detailsTotal: selected,
      currentRouteCode: tour.currentRouteCode || '',
      currentRouteId: tour.currentRouteId || '',
      successCount: success,
      failureCount: (store.failures || []).length,
      status: tour.status || 'idle'
    };
  }

  function recordTourFailure(store, route, info) {
    if (!store) store = createCaptureStore();
    route = route || {};
    info = info || {};
    var routeId = route.routeId || '';
    if (routeId) {
      var dup = false;
      (store.failures || []).forEach(function (f) {
        if (f && f.routeId === routeId) dup = true;
      });
      if (dup) return store;
    }
    store.failures.push(sanitizeCapturedJson({
      routeId: routeId,
      routeCode: route.routeCode || '',
      error: info.error || ERROR.NETWORK,
      message: String(info.message || info.error || '取得失敗')
    }));
    return store;
  }

  function markRouteVisited(tour, routeId) {
    tour = tour || createTourState();
    if (!tour.visitedRouteIds) tour.visitedRouteIds = {};
    if (routeId) tour.visitedRouteIds[String(routeId)] = true;
    return tour;
  }

  function isRouteVisited(tour, routeId) {
    if (!tour || !tour.visitedRouteIds || !routeId) return false;
    return !!tour.visitedRouteIds[String(routeId)];
  }

  function nextTourRoute(store, tour) {
    store = store || createCaptureStore();
    tour = tour || createTourState();
    if (tour.status === 'stopped') return null;
    var routes = tour.routes || [];
    var i = tour.index || 0;
    while (i < routes.length) {
      var r = routes[i];
      var id = r && r.routeId;
      if (id && (store.detailsByRouteId[id] || isRouteVisited(tour, id))) {
        i += 1;
        continue;
      }
      tour.index = i;
      tour.currentRouteId = id || '';
      tour.currentRouteCode = r ? (r.routeCode || '') : '';
      markRouteVisited(tour, id);
      return r || null;
    }
    tour.index = routes.length;
    tour.currentRouteId = '';
    tour.currentRouteCode = '';
    if (tour.status !== 'stopped') tour.status = 'done';
    return null;
  }

  function firstUncapturedTourRoute(store, tour) {
    store = store || createCaptureStore();
    tour = tour || createTourState();
    var routes = tour.routes || [];
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      var id = r && r.routeId;
      if (!id) continue;
      if (store.detailsByRouteId[id]) continue;
      tour.index = i;
      return r;
    }
    return null;
  }

  var pocRunSeq = 0;

  function createPocDiagnostics(route) {
    route = route || {};
    return {
      routeCode: String(route.routeCode || ''),
      routeId: String(route.routeId || ''),
      domFound: 'no',
      coords: 'no',
      attach: '-',
      mousePressed: '-',
      mouseReleased: '-',
      details: '-',
      runEnded: 'no'
    };
  }

  function createPocRun(route) {
    pocRunSeq += 1;
    return {
      id: pocRunSeq,
      active: true,
      ended: false,
      failureRecorded: false,
      route: route || null,
      diagnostics: createPocDiagnostics(route)
    };
  }

  function pocRunIsCurrent(run, id) {
    return !!(run && run.active && !run.ended && run.id === id);
  }

  function endPocRun(run, store, failureInfo) {
    if (!run || run.ended) return run;
    run.ended = true;
    run.active = false;
    if (run.diagnostics) run.diagnostics.runEnded = 'yes';
    if (failureInfo && !run.failureRecorded) {
      run.failureRecorded = true;
      recordTourFailure(store, run.route || {}, failureInfo);
    }
    return run;
  }

  function applyTourTimeout(store, tour) {
    store = store || createCaptureStore();
    tour = tour || createTourState();
    var route = (tour.routes || [])[tour.index];
    if (!route) return store;
    if (route.routeId && store.detailsByRouteId[route.routeId]) return store;
    recordTourFailure(store, route, {
      error: ERROR.TIMEOUT,
      message: 'route-details が時間内に捕捉できませんでした（XHR未検出）'
    });
    tour.index += 1;
    return store;
  }

  function cssEscapeIdent(value) {
    var s = String(value == null ? '' : value);
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    } catch (e) {}
    return s.replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      return '\\' + ch;
    });
  }

  function routeCardSelector(routeId) {
    return '.route-' + cssEscapeIdent(String(routeId || ''));
  }

  function classListHasRouteCard(className, routeId) {
    var token = 'route-' + String(routeId || '');
    if (!routeId || token === 'route-') return false;
    var parts = String(className || '').split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === token) return true;
    }
    return false;
  }

  var ROUTE_CARD_CLICK_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

  function viewportClickPoint(rect) {
    if (!rect) return null;
    var left = Number(rect.left);
    var top = Number(rect.top);
    var w = Number(rect.width);
    var h = Number(rect.height);
    if (!isFinite(left) || !isFinite(top) || !(w > 0) || !(h > 0)) return null;
    return { x: left + (w / 2), y: top + (h / 2) };
  }

  function pickRouteCardClickTarget(nodes, route) {
    nodes = nodes || [];
    route = route || {};
    var code = String(route.routeCode || '');
    var pIdx = -1;
    var spanIdx = -1;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i] || {};
      var tag = String(n.tag || '').toLowerCase();
      if (code && tag === 'p' && String(n.title || '') === code) pIdx = i;
      if (code && tag === 'span' && String(n.text || '').trim() === code && spanIdx < 0) spanIdx = i;
    }
    if (spanIdx >= 0) return spanIdx;
    if (pIdx >= 0) return pIdx;
    return -1;
  }

  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function textHasRouteCode(text, code) {
    if (!code) return false;
    return new RegExp('(?:^|[^A-Za-z0-9])' + escapeRegExp(code) + '(?:$|[^A-Za-z0-9])').test(String(text || ''));
  }

  function isPreferredRouteHref(href) {
    return /\/operations\/execution\/dv\/routes\//.test(String(href || ''));
  }

  function hrefMatchesRoute(href, route) {
    route = route || {};
    var h = String(href || '');
    if (!h) return false;
    var id = String(route.routeId || '');
    var code = String(route.routeCode || '');
    if (id && h.indexOf(id) >= 0) return true;
    if (code && h.indexOf(encodeURIComponent(code)) >= 0) return true;
    if (code && h.indexOf(code) >= 0) return true;
    return false;
  }

  function isLeafTextClickTarget(node) {
    node = node || {};
    if (isPreferredRouteHref(node.href) || (String(node.tag || '').toLowerCase() === 'a' && node.href)) {
      return false;
    }
    var tag = String(node.tag || '').toLowerCase();
    return tag === 'span' || tag === 'td' || tag === 'th' || tag === 'li' || tag === 'p' || tag === 'label';
  }

  function isClickableRouteControl(node) {
    node = node || {};
    if (isLeafTextClickTarget(node)) return false;
    if (isPreferredRouteHref(node.href)) return true;
    var tag = String(node.tag || '').toLowerCase();
    var role = String(node.role || '').toLowerCase();
    if (tag === 'a' && node.href) return true;
    if (role === 'link' || role === 'button') return true;
    if (tag === 'button') return true;
    if (tag === 'tr' || role === 'row') return true;
    return false;
  }

  function pickRouteClickCandidate(nodes, route) {
    nodes = nodes || [];
    route = route || {};
    var code = String(route.routeCode || '');
    var id = String(route.routeId || '');
    var best = -1;
    var bestScore = 0;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i] || {};
      if (isLeafTextClickTarget(n)) continue;
      if (!isClickableRouteControl(n)) continue;
      var score = 0;
      var text = String(n.text || '');
      var href = String(n.href || '');
      var did = String(n.dataRouteId || '');
      var dcode = String(n.dataRouteCode || '');
      var tag = String(n.tag || '').toLowerCase();
      var role = String(n.role || '').toLowerCase();
      if (isPreferredRouteHref(href) && hrefMatchesRoute(href, route)) score += 220;
      else if (isPreferredRouteHref(href) && (textHasRouteCode(text, code) || text === code)) score += 160;
      if (id && did === id) score += 100;
      if (id && href.indexOf(id) >= 0) score += 80;
      if (code && dcode === code) score += 70;
      if (code && text === code) score += 30;
      else if (code && textHasRouteCode(text, code)) {
        score += 20;
        if (text.length > 80) score -= 10;
      }
      if (score <= 0) continue;
      if (tag === 'a' || role === 'link') score += 12;
      if (tag === 'button' || role === 'button') score += 8;
      if (tag === 'tr' || role === 'row') score += 4;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  function resolveClickableAncestor(chain, route) {
    chain = chain || [];
    var clickable = [];
    var indices = [];
    for (var i = 0; i < chain.length; i++) {
      if (isClickableRouteControl(chain[i])) {
        clickable.push(chain[i]);
        indices.push(i);
      }
    }
    var pick = pickRouteClickCandidate(clickable, route);
    if (pick < 0) return -1;
    return indices[pick];
  }

  function emptySummary(extra) {
    return Object.assign({
      ok: false,
      routes: [],
      packages: [],
      routeStops: [],
      packageSequenceIndex: [],
      packageSequenceDiagnostics: emptyPackageSequenceDiagnostics(),
      packageSequenceRouteCount: 0,
      packageAssistIndex: [],
      packageAssistDiagnostics: emptyPackageAssistDiagnostics(),
      failures: [],
      routeCount: 0,
      stopCount: 0,
      packageCount: 0,
      selectedRouteCount: 0,
      totalRouteCount: 0,
      successCount: 0,
      failureCount: 0
    }, extra || {});
  }

  function ingestBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') {
      return emptySummary({ error: ERROR.SCHEMA, message: 'JSON bundle がありません' });
    }

    if (bundle.authError || bundle.httpStatus === 401 || bundle.httpStatus === 403) {
      var authDesc = describeHttpError(bundle.httpStatus, bundle.authError);
      var authFails = Array.isArray(bundle.failures) && bundle.failures.length
        ? bundle.failures
        : [{ error: authDesc.error, httpStatus: bundle.httpStatus, message: authDesc.message }];
      return emptySummary({
        error: authDesc.error,
        message: authDesc.message,
        failures: authFails,
        failureCount: authFails.length
      });
    }

    var failures = [];
    var results = [];
    var detailsList = [];
    if (Array.isArray(bundle.details)) detailsList = bundle.details;
    else if (bundle.rmsRouteDetails) detailsList = [bundle];
    else if (bundle.rmsRouteSummaries && !bundle.details) {
      return emptySummary({
        error: ERROR.MISSING_DETAILS,
        message: 'route-summaries のみです。route-details が必要です'
      });
    }

    var trDetailsByTrId = {};
    if (bundle.trDetailsByTrId && typeof bundle.trDetailsByTrId === 'object') {
      mergeTrDetailsMaps(trDetailsByTrId, bundle.trDetailsByTrId);
    }
    if (Array.isArray(bundle.trDetails)) {
      mergeTrDetailsMaps(trDetailsByTrId, parseTrDetailsBody({ trDetails: bundle.trDetails }));
    }

    detailsList.forEach(function (d, idx) {
      var extracted = extractFromRouteDetails(d);
      if (!extracted.ok) {
        failures.push({
          index: idx,
          routeId: d && d.rmsRouteDetails && d.rmsRouteDetails.routeId,
          routeCode: d && d.rmsRouteDetails && d.rmsRouteDetails.routeCode,
          error: extracted.error,
          message: extracted.message
        });
        return;
      }
      extracted.routeStops = extractRouteSequence(d).stops || [];
      var pkgIndex = extractPackageSequenceIndex(d);
      extracted.packageSequenceIndex = pkgIndex.index || [];
      extracted.packageSequenceDiagnostics = pkgIndex.diagnostics || emptyPackageSequenceDiagnostics();
      var assist = extractPackageAssistIndex(d, trDetailsByTrId,
        bundle.bagStatusByReferenceId && typeof bundle.bagStatusByReferenceId === 'object' ? bundle.bagStatusByReferenceId : null);
      extracted.packageAssistIndex = assist.index || [];
      extracted.packageAssistDiagnostics = assist.diagnostics || emptyPackageAssistDiagnostics();
      results.push(extracted);
    });

    if (Array.isArray(bundle.failures)) {
      bundle.failures.forEach(function (f) {
        if (!f) return;
        var desc = describeHttpError(f.httpStatus, f.error);
        failures.push({
          routeId: f.routeId,
          routeCode: f.routeCode,
          error: desc.error,
          httpStatus: f.httpStatus,
          message: f.message || desc.message
        });
      });
    }

    var summary = summarizeResults(results, failures);
    summary.successCount = results.length;
    summary.failureCount = failures.length;
    if (bundle.summaries && Array.isArray(bundle.summaries.rmsRouteSummaries)) {
      summary.totalRouteCount = bundle.summaries.rmsRouteSummaries.length;
    } else if (typeof bundle.totalRouteCount === 'number') {
      summary.totalRouteCount = bundle.totalRouteCount;
    } else {
      summary.totalRouteCount = 0;
    }
    if (bundle.summaries) {
      summary.elevenOClock = selectElevenOClockRoutes(bundle.summaries);
      summary.selectedRouteCount = summary.elevenOClock.ok ? summary.elevenOClock.routes.length : 0;
    } else if (typeof bundle.selectedRouteCount === 'number') {
      summary.selectedRouteCount = bundle.selectedRouteCount;
    } else {
      summary.selectedRouteCount = results.length + failures.length;
    }

    if (results.length > 0) {
      summary.ok = true;
    } else if (detailsList.length === 0 && failures.length === 0) {
      summary.ok = true;
    } else {
      summary.ok = false;
      summary.error = failures[0] && failures[0].error;
      summary.message = (failures[0] && failures[0].message) || '全 Route の route-details 解析に失敗しました';
    }
    return summary;
  }

  var Cortex13PriorityCore = {
    ERROR: ERROR,
    TOKYO: TOKYO,
    epochToMs: epochToMs,
    tokyoParts: tokyoParts,
    formatTokyoClock: formatTokyoClock,
    formatTokyoDateTime: formatTokyoDateTime,
    isOnOrBeforeCutoff: isOnOrBeforeCutoff,
    isExact1300Clock: isExact1300Clock,
    classifyHttpError: classifyHttpError,
    describeHttpError: describeHttpError,
    formatFetchReport: formatFetchReport,
    createCaptureStore: createCaptureStore,
    isCortexApiCaptureUrl: isCortexApiCaptureUrl,
    routeIdFromDetailsUrl: routeIdFromDetailsUrl,
    applyCapturedCortexResponse: applyCapturedCortexResponse,
    secretCaptureKey: secretCaptureKey,
    sanitizeCapturedJson: sanitizeCapturedJson,
    buildCaptureBundle: buildCaptureBundle,
    createTourState: createTourState,
    tourRoutesFromSummaries: tourRoutesFromSummaries,
    armTour: armTour,
    tourProgress: tourProgress,
    recordTourFailure: recordTourFailure,
    markRouteVisited: markRouteVisited,
    isRouteVisited: isRouteVisited,
    nextTourRoute: nextTourRoute,
    firstUncapturedTourRoute: firstUncapturedTourRoute,
    createPocDiagnostics: createPocDiagnostics,
    createPocRun: createPocRun,
    pocRunIsCurrent: pocRunIsCurrent,
    endPocRun: endPocRun,
    applyTourTimeout: applyTourTimeout,
    cssEscapeIdent: cssEscapeIdent,
    routeCardSelector: routeCardSelector,
    classListHasRouteCard: classListHasRouteCard,
    ROUTE_CARD_CLICK_EVENTS: ROUTE_CARD_CLICK_EVENTS,
    viewportClickPoint: viewportClickPoint,
    pickRouteCardClickTarget: pickRouteCardClickTarget,
    textHasRouteCode: textHasRouteCode,
    isPreferredRouteHref: isPreferredRouteHref,
    hrefMatchesRoute: hrefMatchesRoute,
    isLeafTextClickTarget: isLeafTextClickTarget,
    isClickableRouteControl: isClickableRouteControl,
    pickRouteClickCandidate: pickRouteClickCandidate,
    resolveClickableAncestor: resolveClickableAncestor,
    selectElevenOClockRoutes: selectElevenOClockRoutes,
    resolveStopAddress: resolveStopAddress,
    extractFromRouteDetails: extractFromRouteDetails,
    extractRouteSequence: extractRouteSequence,
    extractPackageSequenceIndex: extractPackageSequenceIndex,
    parseBagName: parseBagName,
    parseTrDetailsBody: parseTrDetailsBody,
    extractPackageAssistIndex: extractPackageAssistIndex,
    emptyPackageAssistDiagnostics: emptyPackageAssistDiagnostics,
    extractFromCortexCsv: extractFromCortexCsv,
    summarizeResults: summarizeResults,
    ingestBundle: ingestBundle,
    BAG_STATUS: BAG_STATUS,
    mergeTrDetailsMaps: mergeTrDetailsMaps,
    hasTrDetails: hasTrDetails,
    capturedBagStatus: capturedBagStatus,
    isPriorityDropOff: isPriorityDropOff,
    selectBagTargets: selectBagTargets,
    groupBagTargetsByRoute: groupBagTargetsByRoute,
    indexExactDomTextMatches: indexExactDomTextMatches,
    domMatchStatus: domMatchStatus,
    createBagRun: createBagRun,
    bagTargetAttempted: bagTargetAttempted,
    markBagAttempted: markBagAttempted,
    recordBagResult: recordBagResult,
    pendingBagTargets: pendingBagTargets,
    summarizeBagRun: summarizeBagRun,
    formatBagSummary: formatBagSummary,
    snapshotNormalCapture: snapshotNormalCapture,
    restoreNormalCapture: restoreNormalCapture,
    parseStopLabel: parseStopLabel,
    matchStopLabelEntries: matchStopLabelEntries,
    isPackageNumberText: isPackageNumberText,
    groupBagTargetsByStop: groupBagTargetsByStop,
    stopNeedsExpand: stopNeedsExpand,
    formatBagProgress: formatBagProgress,
    runBagEngine: runBagEngine
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Cortex13PriorityCore;
  }
  global.Cortex13PriorityCore = Cortex13PriorityCore;
})(typeof window !== 'undefined' ? window : global);
