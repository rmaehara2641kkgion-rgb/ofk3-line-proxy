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
    NO_DEPARTURE: 'PLANNED_DEPARTURE_MISSING'
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
   * Evidence (HAR 2026-09-18, 22 DCX routes):
   *   plannedDepartureTime hour in Asia/Tokyo == 11  → 18 routes
   *   hour == 9 (Biker) → 4 routes, not 11:00 arrival
   * Do not use route-code ranges.
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

        var addr = addressById[task.addressId || stop.addressId] || {};
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
          address: [addr.address1, addr.address2, addr.city].filter(Boolean).join(' ')
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

  function summarizeResults(results, failures) {
    var routes = [];
    var packages = [];
    (results || []).forEach(function (r) {
      if (!r || !r.ok) return;
      routes.push(r);
      (r.packages || []).forEach(function (p) {
        packages.push(Object.assign({ driverName: r.driverName }, p));
      });
    });
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
      routeCount: routes.length,
      stopCount: Object.keys(stopKeys).length,
      packageCount: packages.length,
      failures: failures || []
    };
  }

  function ingestBundle(bundle) {
    var failures = [];
    var results = [];
    if (!bundle || typeof bundle !== 'object') {
      return { ok: false, error: ERROR.SCHEMA, message: 'JSON bundle がありません', routes: [], packages: [], failures: [] };
    }
    var detailsList = [];
    if (Array.isArray(bundle.details)) detailsList = bundle.details;
    else if (bundle.rmsRouteDetails) detailsList = [bundle];
    else if (bundle.rmsRouteSummaries && !bundle.details) {
      return {
        ok: false,
        error: ERROR.MISSING_DETAILS,
        message: 'route-summaries のみです。route-details が必要です',
        routes: [],
        packages: [],
        failures: []
      };
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
      results.push(extracted);
    });

    var summary = summarizeResults(results, failures);
    summary.ok = results.length > 0 || detailsList.length === 0;
    if (detailsList.length > 0 && results.length === 0) {
      summary.ok = false;
      summary.error = failures[0] && failures[0].error;
      summary.message = '全 Route の route-details 解析に失敗しました';
    } else {
      summary.ok = true;
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
    selectElevenOClockRoutes: selectElevenOClockRoutes,
    extractFromRouteDetails: extractFromRouteDetails,
    summarizeResults: summarizeResults,
    ingestBundle: ingestBundle
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Cortex13PriorityCore;
  }
  global.Cortex13PriorityCore = Cortex13PriorityCore;
})(typeof window !== 'undefined' ? window : global);
