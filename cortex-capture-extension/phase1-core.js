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

  function createCaptureStore() {
    return { summaries: null, detailsByRouteId: {}, failures: [] };
  }

  function isCortexApiCaptureUrl(url) {
    var s = String(url || '');
    return /\/operations\/execution\/api\/route-summaries(?:[/?#]|$)/.test(s) ||
      /\/operations\/execution\/api\/route-details\//.test(s);
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
    extractFromRouteDetails: extractFromRouteDetails,
    extractFromCortexCsv: extractFromCortexCsv,
    summarizeResults: summarizeResults,
    ingestBundle: ingestBundle
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Cortex13PriorityCore;
  }
  global.Cortex13PriorityCore = Cortex13PriorityCore;
})(typeof window !== 'undefined' ? window : global);
