/**
 * OFK3 Mentor Capture v0 — page MAIN world only.
 * Observes Mentor's own GET responses for shift meta and shift rows.
 * Does not call Mentor APIs and does not read credentials or browser storage.
 * Does not send data anywhere. Diagnostic display and clipboard JSON are redacted.
 */
(function (global) {
  'use strict';

  var lastMentorDigest = null;
  var IDENTIFIER_CANDIDATES = [
    'driverId',
    'driverID',
    'driver',
    'staffNumber',
    'staffNo',
    'employeeId',
    'employeeID',
    'name',
    'driverName',
    'firstName',
    'lastName'
  ];

  function captureKind(url, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return '';
    var path = '';
    try {
      path = new URL(String(url || ''), 'https://vrm-mentor.edriving.com').pathname;
    } catch (e) {
      path = String(url || '').split('?')[0];
    }
    if (/\/reports\/driver\/shifts\/devices(?:\/|$)/.test(path)) return '';
    if (/\/reports\/driver\/shifts\/meta(?:\/|$)/.test(path)) return 'meta';
    if (/\/reports\/driver\/shifts(?:\/|$)/.test(path)) return 'shifts';
    return '';
  }

  function requestInfo(input, init) {
    var url = '';
    var method = 'GET';
    try {
      if (typeof input === 'string') url = input;
      else if (input && typeof input.url === 'string') url = input.url;
      else if (input && typeof input.href === 'string') url = input.href;
      if (init && init.method) method = init.method;
      else if (input && typeof input.method === 'string') method = input.method;
    } catch (e) {}
    return { url: url, method: method };
  }

  function presentValue(value) {
    return value != null && value !== '';
  }

  function hasValue(value) {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }

  function statusBucket(value) {
    if (!hasValue(value)) return '(empty)';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value !== 'string' && typeof value !== 'number') return '(non-scalar)';
    var label = String(value).trim();
    if (label.length > 32 || /^\d{6,}$/.test(label)) return '(opaque)';
    if (!/^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,31}$/.test(label)) return '(opaque)';
    return label;
  }

  function tallyKey(rows, field) {
    var counts = Object.create(null);
    var present = 0;
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !hasValue(row[field])) return;
      present += 1;
      var raw = row[field];
      var token = (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean')
        ? String(raw)
        : JSON.stringify(raw);
      counts[token] = (counts[token] || 0) + 1;
    });
    var unique = 0;
    var duplicateValues = 0;
    var duplicateRows = 0;
    Object.keys(counts).forEach(function (token) {
      unique += 1;
      if (counts[token] > 1) {
        duplicateValues += 1;
        duplicateRows += counts[token];
      }
    });
    return {
      present: present,
      missing: rows.length - present,
      unique: unique,
      duplicateValues: duplicateValues,
      duplicateRows: duplicateRows
    };
  }

  function identifierToken(value) {
    if (!hasValue(value)) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  }

  function activeOpenRow(row) {
    return !!(row && typeof row === 'object' && !Array.isArray(row) && row.shiftEndTime === 'N/A' && row.vrmStatus === 'Active');
  }

  function mappingConflicts(rows) {
    var staffByDriver = Object.create(null);
    var driversByStaff = Object.create(null);
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      var driver = identifierToken(row.driverId);
      var staff = identifierToken(row.realStaffNumber);
      if (!driver || !staff) return;
      if (!staffByDriver[driver]) staffByDriver[driver] = Object.create(null);
      staffByDriver[driver][staff] = true;
      if (!driversByStaff[staff]) driversByStaff[staff] = Object.create(null);
      driversByStaff[staff][driver] = true;
    });
    var driverIdsWithMultipleRealStaffNumbers = 0;
    var realStaffNumbersWithMultipleDriverIds = 0;
    Object.keys(staffByDriver).forEach(function (driver) {
      if (Object.keys(staffByDriver[driver]).length > 1) driverIdsWithMultipleRealStaffNumbers += 1;
    });
    Object.keys(driversByStaff).forEach(function (staff) {
      if (Object.keys(driversByStaff[staff]).length > 1) realStaffNumbersWithMultipleDriverIds += 1;
    });
    return {
      driverIdsWithMultipleRealStaffNumbers: driverIdsWithMultipleRealStaffNumbers,
      realStaffNumbersWithMultipleDriverIds: realStaffNumbersWithMultipleDriverIds
    };
  }

  function redactRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var out = {};
    Object.keys(row).sort().forEach(function (key) {
      var value = row[key];
      if (key === 'shiftEndTime' && value === 'N/A') out[key] = 'N/A';
      else if (value == null) out[key] = '[NULL]';
      else if (typeof value === 'number') out[key] = '[NUMBER]';
      else if (typeof value === 'boolean') out[key] = '[BOOLEAN]';
      else if (typeof value === 'string') out[key] = '[REDACTED]';
      else if (Array.isArray(value)) out[key] = '[ARRAY]';
      else out[key] = '[OBJECT]';
    });
    return out;
  }

  function summarizeMeta(body) {
    var out = { ok: false, topKeys: [], structureKeys: [], issue: '' };
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      out.issue = 'META_NOT_OBJECT';
      return out;
    }
    out.ok = true;
    out.topKeys = Object.keys(body).slice(0, 40);
    var structure = null;
    if (body.structure && typeof body.structure === 'object' && !Array.isArray(body.structure)) {
      structure = body.structure;
    } else if (body.data && body.data.structure && typeof body.data.structure === 'object' && !Array.isArray(body.data.structure)) {
      structure = body.data.structure;
    }
    if (!structure) {
      out.issue = 'NO_STRUCTURE';
      return out;
    }
    out.structureKeys = Object.keys(structure).sort();
    return out;
  }

  function summarizeShifts(body) {
    var out = {
      ok: false,
      totalRows: 0,
      detectedRowKeys: [],
      candidateIdentifierFields: [],
      rowsWithShiftStartTime: 0,
      rowsWithShiftEndTime: 0,
      rowsWithEndNA: 0,
      naVrmStatusCounts: {},
      naDeviceEmpty: 0,
      naDeviceNonEmpty: 0,
      naVehicleIdentifierEmpty: 0,
      naVehicleIdentifierNonEmpty: 0,
      naRowsWithShiftStartTime: 0,
      naRowsWithDriverId: 0,
      naRowsWithRealStaffNumber: 0,
      activeOpenRows: 0,
      activeOpenDriverIdUnique: 0,
      activeOpenDriverIdDuplicateValues: 0,
      activeOpenRealStaffNumberUnique: 0,
      activeOpenRealStaffNumberDuplicateValues: 0,
      driverIdsWithMultipleRealStaffNumbers: 0,
      realStaffNumbersWithMultipleDriverIds: 0,
      sampleRow: null,
      issue: ''
    };
    if (!body || typeof body !== 'object' || !Array.isArray(body.data)) {
      out.issue = 'NO_DATA_ARRAY';
      return out;
    }
    out.ok = true;
    out.totalRows = body.data.length;
    var keySet = {};
    var sample = null;
    var openSample = null;
    var naStatus = {};
    body.data.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      Object.keys(row).forEach(function (key) { keySet[key] = true; });
      if (presentValue(row.shiftStartTime)) out.rowsWithShiftStartTime += 1;
      if (presentValue(row.shiftEndTime)) out.rowsWithShiftEndTime += 1;
      if (row.shiftEndTime === 'N/A') {
        out.rowsWithEndNA += 1;
        if (!openSample) openSample = row;
        var label = statusBucket(row.vrmStatus);
        naStatus[label] = (naStatus[label] || 0) + 1;
        if (hasValue(row.device)) out.naDeviceNonEmpty += 1;
        else out.naDeviceEmpty += 1;
        if (hasValue(row.vehicleIdentifier)) out.naVehicleIdentifierNonEmpty += 1;
        else out.naVehicleIdentifierEmpty += 1;
        if (hasValue(row.shiftStartTime)) out.naRowsWithShiftStartTime += 1;
        if (hasValue(row.driverId)) out.naRowsWithDriverId += 1;
        if (hasValue(row.realStaffNumber)) out.naRowsWithRealStaffNumber += 1;
      }
      if (!sample) sample = row;
    });
    Object.keys(naStatus).sort().forEach(function (label) {
      out.naVrmStatusCounts[label] = naStatus[label];
    });
    var activeOpen = body.data.filter(activeOpenRow);
    var activeDriver = tallyKey(activeOpen, 'driverId');
    var activeStaff = tallyKey(activeOpen, 'realStaffNumber');
    var mapping = mappingConflicts(body.data);
    out.activeOpenRows = activeOpen.length;
    out.activeOpenDriverIdUnique = activeDriver.unique;
    out.activeOpenDriverIdDuplicateValues = activeDriver.duplicateValues;
    out.activeOpenRealStaffNumberUnique = activeStaff.unique;
    out.activeOpenRealStaffNumberDuplicateValues = activeStaff.duplicateValues;
    out.driverIdsWithMultipleRealStaffNumbers = mapping.driverIdsWithMultipleRealStaffNumbers;
    out.realStaffNumbersWithMultipleDriverIds = mapping.realStaffNumbersWithMultipleDriverIds;
    out.detectedRowKeys = Object.keys(keySet).sort();
    out.candidateIdentifierFields = IDENTIFIER_CANDIDATES.filter(function (name) {
      return Object.prototype.hasOwnProperty.call(keySet, name);
    });
    out.sampleRow = redactRow(openSample || sample);
    return out;
  }

  function cleanSnapshotText(value, max) {
    if (typeof value === 'number' && isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    var text = value.trim();
    if (!text) return '';
    if (text.length > max) text = text.slice(0, max);
    if (/bearer|cookie|password/i.test(text)) return '';
    return text;
  }

  function cleanSnapshotStart(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && /^-?\d{1,16}$/.test(value.trim())) {
      var n = Number(value.trim());
      if (isFinite(n)) return n;
    }
    return null;
  }

  function cleanSnapshotVehicle(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text || text.length > 80) return null;
    if (/bearer|cookie|password/i.test(text)) return null;
    return text;
  }

  function buildActiveSnapshot(body, capturedAt) {
    var drivers = [];
    var rows = body && Array.isArray(body.data) ? body.data : [];
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      if (row.shiftEndTime !== 'N/A' || row.vrmStatus !== 'Active') return;
      var driver = {
        driverId: cleanSnapshotText(row.driverId, 80),
        realStaffNumber: cleanSnapshotText(row.realStaffNumber, 80),
        firstName: cleanSnapshotText(row.firstName, 80),
        lastName: cleanSnapshotText(row.lastName, 80),
        shiftStartTime: cleanSnapshotStart(row.shiftStartTime),
        vehicleIdentifier: cleanSnapshotVehicle(row.vehicleIdentifier)
      };
      if (!driver.driverId && !driver.realStaffNumber) return;
      drivers.push(driver);
    });
    var at = typeof capturedAt === 'string' ? capturedAt : '';
    return {
      capturedAt: at,
      source: 'mentor',
      activeCount: drivers.length,
      drivers: drivers
    };
  }

  function captureStatus(metaCaptured, shiftsCaptured) {
    if (metaCaptured && shiftsCaptured) return 'SUCCESS';
    if (shiftsCaptured) return 'SHIFTS CAPTURED';
    if (metaCaptured) return 'META CAPTURED';
    return 'WAITING';
  }

  function pathnameOnly(url) {
    var path = '';
    try {
      path = new URL(String(url || ''), 'https://vrm-mentor.edriving.com').pathname;
    } catch (e1) {
      path = String(url || '').split('?')[0];
    }
    if (path.length > 180) path = path.slice(0, 180);
    return path;
  }

  function publicRequestTarget(url) {
    var hostname = '';
    var pathname = '';
    try {
      var parsed = new URL(String(url || ''), 'https://vrm-mentor.edriving.com');
      hostname = parsed.hostname || '';
      pathname = parsed.pathname || '';
    } catch (e) {
      pathname = String(url || '').split('?')[0].split('#')[0];
    }
    if (!/^[A-Za-z0-9.-]{0,180}$/.test(hostname)) hostname = '';
    pathname = String(pathname || '').split('?')[0].split('#')[0];
    if (pathname.length > 180) pathname = pathname.slice(0, 180);
    if (!/^[\w./~%+-]*$/.test(pathname)) pathname = '';
    return { hostname: hostname, pathname: pathname };
  }

  function rememberObserved(state, transport, method, url) {
    if (!state) return;
    if (!state.observedPaths) state.observedPaths = [];
    state.observedPathCount = (state.observedPathCount || 0) + 1;
    if (state.observedPaths.length >= 30) return;
    var target = publicRequestTarget(url);
    var verb = String(method || '').toUpperCase();
    if (!/^[A-Z]{3,12}$/.test(verb)) verb = '';
    state.observedPaths.push({
      transport: transport === 'xhr' ? 'xhr' : 'fetch',
      method: verb,
      hostname: target.hostname,
      pathname: target.pathname
    });
  }

  function safeHeaderValue(value) {
    var text = value == null ? '' : String(value).trim();
    if (!text || text.length > 80) return '';
    if (!/^[A-Za-z0-9 .;=_+/,-]+$/.test(text)) return '';
    if (/bearer|token|cookie/i.test(text)) return '';
    return text;
  }

  function safeErrorName(value) {
    var name = value && value.name ? String(value.name) : (typeof value === 'string' ? value : '');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name)) return '';
    return name;
  }

  function safeErrorMessage(value) {
    var message = value && value.message ? String(value.message) : (typeof value === 'string' ? value : '');
    message = message.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
    message = message.replace(/\s+/g, ' ').trim();
    if (!message || message.length > 160) return 'unavailable';
    if (/[{}`]|bearer|token|cookie/i.test(message)) return 'unavailable';
    return message;
  }

  function safeResponseType(value) {
    var text = String(value || '');
    if (text === 'basic' || text === 'cors' || text === 'default' || text === 'error' || text === 'opaque' || text === 'opaqueredirect' || text === 'xhr') {
      return text;
    }
    return '';
  }

  function parseResponseText(text) {
    var raw = text == null ? '' : String(text);
    var out = {
      ok: false,
      body: null,
      textLength: raw.length,
      xssiPrefix: /^\)\]\}',?\n/.test(raw) ? 'YES' : 'NO',
      jsonParse: 'FAILED',
      errorName: '',
      errorMessage: '',
      issue: ''
    };
    var source = raw.replace(/^\)\]\}',?\n/, '');
    if (!source) {
      out.issue = 'EMPTY_BODY';
      out.errorName = 'SyntaxError';
      out.errorMessage = 'empty body';
      return out;
    }
    try {
      out.body = JSON.parse(source);
      out.ok = true;
      out.jsonParse = 'SUCCESS';
    } catch (e) {
      out.issue = 'JSON_PARSE_FAILED';
      out.errorName = safeErrorName(e);
      out.errorMessage = safeErrorMessage(e);
    }
    return out;
  }

  function signalState(signal) {
    try {
      if (!signal) return 'none';
      return signal.aborted ? 'true' : 'false';
    } catch (e) {
      return 'none';
    }
  }

  function safeSignalState(value) {
    if (value === 'true' || value === 'false' || value === 'none') return value;
    return 'none';
  }

  function detachableSignal(parent) {
    var controller = new AbortController();
    var detached = false;
    function forward() {
      if (detached || controller.signal.aborted) return;
      try { controller.abort(); } catch (e) {}
    }
    if (parent && typeof parent.addEventListener === 'function') {
      if (parent.aborted) forward();
      else parent.addEventListener('abort', forward);
    }
    return {
      signal: controller.signal,
      detach: function () {
        detached = true;
        if (parent && typeof parent.removeEventListener === 'function') {
          parent.removeEventListener('abort', forward);
        }
      },
      pageAborted: function () {
        return signalState(parent);
      }
    };
  }

  function pageSignal(input, init) {
    try {
      if (input && input.signal) return input.signal;
    } catch (e) {}
    try {
      if (init && init.signal) return init.signal;
    } catch (e2) {}
    return null;
  }

  function invokeFetch(origFetch, thisArg, input, init, bridge) {
    if (typeof Request === 'function' && input instanceof Request) {
      var copy = input.clone();
      return origFetch.call(thisArg, new Request(copy, { signal: bridge.signal }));
    }
    var nextInit = { signal: bridge.signal };
    if (init) {
      var key;
      for (key in init) {
        if (key === 'signal') continue;
        if (Object.prototype.hasOwnProperty.call(init, key)) nextInit[key] = init[key];
      }
    }
    return origFetch.call(thisArg, input, nextInit);
  }

  function kindCaptured(state, kind) {
    if (kind === 'meta') return !!state.metaCaptured;
    if (kind === 'shifts') return !!state.shiftsCaptured;
    return false;
  }

  function publishMentorIdMessage(digest) {
    try {
      if (typeof global.postMessage !== 'function') return;
      var target = '';
      try { target = global.location && global.location.origin; } catch (e0) { target = ''; }
      if (!target) return;
      lastMentorDigest = digest;
      global.postMessage({ source: 'OFK3_ID_DIAG', type: 'mentor-ids', digest: digest }, target);
    } catch (e1) {}
  }

  function shiftsFailureIssue(last) {
    if (!last || last.clone !== 'SUCCESS') return 'CLONE_FAILED';
    if (last.text !== 'SUCCESS') return 'TEXT_FAILED';
    if (last.jsonParse !== 'SUCCESS') return 'JSON_PARSE_FAILED';
    if (!(last.status >= 200 && last.status < 300)) return 'HTTP';
    return 'NO_DATA_ARRAY';
  }

  function publishMentorIdFailure(issue) {
    publishMentorIdMessage({
      ok: false,
      issue: issue || 'FAILED',
      capturedAt: new Date().toISOString()
    });
  }

  function publishMentorIdDigest(body, capturedAt, requestUrl) {
    try {
      var Core = global.OFK3IdDiag;
      if (!Core || typeof Core.mentorDigest !== 'function') return;
      publishMentorIdMessage(Core.mentorDigest(body, capturedAt, requestUrl));
    } catch (e1) {}
  }

  function applyObservation(state, kind, obs) {
    obs = obs || {};
    var cloneOk = obs.clone === 'SUCCESS';
    var textOk = obs.textStatus === 'SUCCESS';
    var parsed = cloneOk && textOk ? parseResponseText(obs.text) : null;
    var status = Number(obs.status) || 0;
    var last = {
      pathname: pathnameOnly(obs.pathname || obs.url || ''),
      method: String(obs.method || 'GET').toUpperCase(),
      transport: obs.transport === 'xhr' ? 'xhr' : 'fetch',
      status: status,
      type: safeResponseType(obs.type),
      ok: !!obs.ok,
      redirected: !!obs.redirected,
      bodyUsed: !!obs.bodyUsed,
      contentType: safeHeaderValue(obs.contentType),
      contentLength: safeHeaderValue(obs.contentLength),
      clone: cloneOk ? 'SUCCESS' : 'FAILED',
      text: textOk ? 'SUCCESS' : 'FAILED',
      textLength: parsed ? parsed.textLength : 0,
      xssiPrefix: parsed ? parsed.xssiPrefix : 'NO',
      jsonParse: parsed ? parsed.jsonParse : 'FAILED',
      errorName: parsed ? parsed.errorName : safeErrorName(obs.error || obs.errorName),
      errorMessage: parsed ? parsed.errorMessage : safeErrorMessage(obs.error || obs.errorMessage),
      signalAtStart: safeSignalState(obs.signalAtStart),
      signalAtResponse: safeSignalState(obs.signalAtResponse),
      signalAtReadFailure: textOk ? '' : safeSignalState(obs.signalAtReadFailure)
    };
    var accepted = !!(parsed && parsed.ok && status >= 200 && status < 300);
    if (kind === 'shifts' && !accepted) publishMentorIdFailure(shiftsFailureIssue(last));
    if (kindCaptured(state, kind) && !accepted) return state;
    state.lastResponse = last;
    if (!cloneOk) {
      state.issue = 'CLONE_FAILED';
      return state;
    }
    if (!textOk) {
      state.issue = 'TEXT_FAILED';
      return state;
    }
    if (!parsed.ok) {
      state.issue = parsed.issue || 'JSON_PARSE_FAILED';
      return state;
    }
    if (!(status >= 200 && status < 300)) {
      state.issue = 'HTTP_' + status;
      return state;
    }
    if (kind === 'meta') {
      var meta = summarizeMeta(parsed.body);
      if (!meta.ok) {
        state.issue = meta.issue || 'META_NOT_OBJECT';
        return state;
      }
      state.metaCaptured = true;
      state.metaTopKeys = meta.topKeys;
      state.structureKeys = meta.structureKeys;
      state.issue = meta.issue && !state.shiftsCaptured ? meta.issue : '';
    } else if (kind === 'shifts') {
      var shifts = summarizeShifts(parsed.body);
      if (!shifts.ok) {
        state.issue = shifts.issue || 'NO_DATA_ARRAY';
        return state;
      }
      state.shiftsCaptured = true;
      state.totalRows = shifts.totalRows;
      state.detectedRowKeys = shifts.detectedRowKeys;
      state.candidateIdentifierFields = shifts.candidateIdentifierFields;
      state.rowsWithShiftStartTime = shifts.rowsWithShiftStartTime;
      state.rowsWithShiftEndTime = shifts.rowsWithShiftEndTime;
      state.rowsWithEndNA = shifts.rowsWithEndNA;
      state.naVrmStatusCounts = shifts.naVrmStatusCounts;
      state.naDeviceEmpty = shifts.naDeviceEmpty;
      state.naDeviceNonEmpty = shifts.naDeviceNonEmpty;
      state.naVehicleIdentifierEmpty = shifts.naVehicleIdentifierEmpty;
      state.naVehicleIdentifierNonEmpty = shifts.naVehicleIdentifierNonEmpty;
      state.naRowsWithShiftStartTime = shifts.naRowsWithShiftStartTime;
      state.naRowsWithDriverId = shifts.naRowsWithDriverId;
      state.naRowsWithRealStaffNumber = shifts.naRowsWithRealStaffNumber;
      state.activeOpenRows = shifts.activeOpenRows;
      state.activeOpenDriverIdUnique = shifts.activeOpenDriverIdUnique;
      state.activeOpenDriverIdDuplicateValues = shifts.activeOpenDriverIdDuplicateValues;
      state.activeOpenRealStaffNumberUnique = shifts.activeOpenRealStaffNumberUnique;
      state.activeOpenRealStaffNumberDuplicateValues = shifts.activeOpenRealStaffNumberDuplicateValues;
      state.driverIdsWithMultipleRealStaffNumbers = shifts.driverIdsWithMultipleRealStaffNumbers;
      state.realStaffNumbersWithMultipleDriverIds = shifts.realStaffNumbersWithMultipleDriverIds;
      state.sampleRow = shifts.sampleRow;
      state.activeSnapshot = buildActiveSnapshot(parsed.body, new Date().toISOString());
      state.issue = '';
    }
    state.capturedAt = new Date().toISOString();
    if (kind === 'shifts' && state.shiftsCaptured && accepted && parsed && parsed.body) {
      publishMentorIdDigest(parsed.body, state.capturedAt, obs.requestUrl || '');
    }
    return state;
  }

  function buildDiagnostic(state) {
    state = state || {};
    var last = state.lastResponse || null;
    return {
      product: 'MENTOR CAPTURE v0',
      capture: captureStatus(!!state.metaCaptured, !!state.shiftsCaptured),
      capturedAt: state.capturedAt || null,
      hookInstalled: state.hookInstalled ? 'YES' : 'NO',
      hookInstalledAt: state.hookInstalledAt || null,
      fetchIntercepted: state.fetchIntercepted || 0,
      xhrIntercepted: state.xhrIntercepted || 0,
      metaMatched: state.metaMatched || 0,
      shiftsMatched: state.shiftsMatched || 0,
      responsesReceived: state.responsesReceived || 0,
      observedPathCount: state.observedPathCount || 0,
      observedPaths: (state.observedPaths || []).slice(0, 30),
      metaCaptured: state.metaCaptured ? 'YES' : 'NO',
      shiftsCaptured: state.shiftsCaptured ? 'YES' : 'NO',
      metaTopKeys: state.metaTopKeys || [],
      structureKeys: state.structureKeys || [],
      totalRows: state.totalRows || 0,
      detectedRowKeys: state.detectedRowKeys || [],
      candidateIdentifierFields: state.candidateIdentifierFields || [],
      rowsWithShiftStartTime: state.rowsWithShiftStartTime || 0,
      rowsWithShiftEndTime: state.rowsWithShiftEndTime || 0,
      rowsWithEndNA: state.rowsWithEndNA || 0,
      naVrmStatusCounts: state.naVrmStatusCounts || {},
      naDeviceEmpty: state.naDeviceEmpty || 0,
      naDeviceNonEmpty: state.naDeviceNonEmpty || 0,
      naVehicleIdentifierEmpty: state.naVehicleIdentifierEmpty || 0,
      naVehicleIdentifierNonEmpty: state.naVehicleIdentifierNonEmpty || 0,
      naRowsWithShiftStartTime: state.naRowsWithShiftStartTime || 0,
      naRowsWithDriverId: state.naRowsWithDriverId || 0,
      naRowsWithRealStaffNumber: state.naRowsWithRealStaffNumber || 0,
      activeOpenRows: state.activeOpenRows || 0,
      activeOpenDriverIdUnique: state.activeOpenDriverIdUnique || 0,
      activeOpenDriverIdDuplicateValues: state.activeOpenDriverIdDuplicateValues || 0,
      activeOpenRealStaffNumberUnique: state.activeOpenRealStaffNumberUnique || 0,
      activeOpenRealStaffNumberDuplicateValues: state.activeOpenRealStaffNumberDuplicateValues || 0,
      driverIdsWithMultipleRealStaffNumbers: state.driverIdsWithMultipleRealStaffNumbers || 0,
      realStaffNumbersWithMultipleDriverIds: state.realStaffNumbersWithMultipleDriverIds || 0,
      activeSnapshotCount: state.activeSnapshot && typeof state.activeSnapshot.activeCount === 'number' ? state.activeSnapshot.activeCount : null,
      sampleRow: state.sampleRow || null,
      lastResponse: last,
      issue: state.issue || '',
      endTimeMeaning: 'shiftEndTime "N/A" means a trip session with no end time'
    };
  }

  var api = {
    captureKind: captureKind,
    requestInfo: requestInfo,
    redactRow: redactRow,
    summarizeMeta: summarizeMeta,
    summarizeShifts: summarizeShifts,
    buildActiveSnapshot: buildActiveSnapshot,
    captureStatus: captureStatus,
    pathnameOnly: pathnameOnly,
    publicRequestTarget: publicRequestTarget,
    rememberObserved: rememberObserved,
    parseResponseText: parseResponseText,
    applyObservation: applyObservation,
    safeErrorMessage: safeErrorMessage,
    safeHeaderValue: safeHeaderValue,
    signalState: signalState,
    detachableSignal: detachableSignal,
    buildDiagnostic: buildDiagnostic,
    identifierCandidates: IDENTIFIER_CANDIDATES.slice()
  };
  global.OFK3MentorCapture = api;

  function onMentorHost() {
    try {
      return String(global.location && global.location.hostname || '') === 'vrm-mentor.edriving.com';
    } catch (e) {
      return false;
    }
  }

  if (!onMentorHost()) return;

  var state = {
    hookInstalled: false,
    hookInstalledAt: null,
    fetchIntercepted: 0,
    xhrIntercepted: 0,
    metaMatched: 0,
    shiftsMatched: 0,
    responsesReceived: 0,
    observedPathCount: 0,
    observedPaths: [],
    metaCaptured: false,
    shiftsCaptured: false,
    capturedAt: null,
    metaTopKeys: [],
    structureKeys: [],
    totalRows: 0,
    detectedRowKeys: [],
    candidateIdentifierFields: [],
    rowsWithShiftStartTime: 0,
    rowsWithShiftEndTime: 0,
    rowsWithEndNA: 0,
    naVrmStatusCounts: {},
    naDeviceEmpty: 0,
    naDeviceNonEmpty: 0,
    naVehicleIdentifierEmpty: 0,
    naVehicleIdentifierNonEmpty: 0,
    naRowsWithShiftStartTime: 0,
    naRowsWithDriverId: 0,
    naRowsWithRealStaffNumber: 0,
    activeOpenRows: 0,
    activeOpenDriverIdUnique: 0,
    activeOpenDriverIdDuplicateValues: 0,
    activeOpenRealStaffNumberUnique: 0,
    activeOpenRealStaffNumberDuplicateValues: 0,
    driverIdsWithMultipleRealStaffNumbers: 0,
    realStaffNumbersWithMultipleDriverIds: 0,
    activeSnapshot: null,
    sampleRow: null,
    issue: '',
    lastResponse: null
  };
  var paintScheduled = false;

  function schedulePaint() {
    if (paintScheduled) return;
    paintScheduled = true;
    global.setTimeout(function () {
      paintScheduled = false;
      paint();
    }, 0);
  }

  function readAllowedHeader(getter, name) {
    var lower = String(name || '').toLowerCase();
    if (lower !== 'content-type' && lower !== 'content-length') return '';
    try {
      return safeHeaderValue(getter(lower));
    } catch (e) {
      return '';
    }
  }

  function noteMatch(kind) {
    if (kind === 'meta') state.metaMatched += 1;
    else if (kind === 'shifts') state.shiftsMatched += 1;
  }

  function observeFetchResponse(kind, info, res, signals) {
    signals = signals || {};
    function pageAbortedNow() {
      return signals.pageAborted ? signals.pageAborted() : 'none';
    }
    var facts = {
      pathname: pathnameOnly(info && info.url),
      requestUrl: info && info.url,
      method: info && info.method,
      transport: 'fetch',
      status: res && Number(res.status) || 0,
      type: res && res.type,
      ok: !!(res && res.ok),
      redirected: !!(res && res.redirected),
      bodyUsed: !!(res && res.bodyUsed),
      contentType: res && res.headers ? readAllowedHeader(function (name) { return res.headers.get(name); }, 'content-type') : '',
      contentLength: res && res.headers ? readAllowedHeader(function (name) { return res.headers.get(name); }, 'content-length') : ''
    };
    if (!res || typeof res.clone !== 'function') {
      applyObservation(state, kind, Object.assign(facts, {
        clone: 'FAILED',
        textStatus: 'FAILED',
        errorName: 'TypeError',
        errorMessage: 'clone unavailable',
        signalAtStart: signals.signalAtStart,
        signalAtResponse: signals.signalAtResponse,
        signalAtReadFailure: pageAbortedNow()
      }));
      schedulePaint();
      return;
    }
    var cloned;
    try {
      cloned = res.clone();
    } catch (e) {
      applyObservation(state, kind, Object.assign(facts, {
        clone: 'FAILED',
        textStatus: 'FAILED',
        error: e,
        signalAtStart: signals.signalAtStart,
        signalAtResponse: signals.signalAtResponse,
        signalAtReadFailure: pageAbortedNow()
      }));
      schedulePaint();
      return;
    }
    cloned.text().then(function (text) {
      applyObservation(state, kind, Object.assign(facts, {
        clone: 'SUCCESS',
        textStatus: 'SUCCESS',
        text: text,
        signalAtStart: signals.signalAtStart,
        signalAtResponse: signals.signalAtResponse,
        signalAtReadFailure: ''
      }));
      schedulePaint();
    }, function (e) {
      applyObservation(state, kind, Object.assign(facts, {
        clone: 'SUCCESS',
        textStatus: 'FAILED',
        error: e,
        signalAtStart: signals.signalAtStart,
        signalAtResponse: signals.signalAtResponse,
        signalAtReadFailure: pageAbortedNow()
      }));
      schedulePaint();
    });
  }

  function observeXhr(kind, xhr) {
    var facts = {
      pathname: pathnameOnly(xhr && xhr.__ofk3MentorUrl),
      requestUrl: xhr && xhr.__ofk3MentorUrl,
      method: xhr && xhr.__ofk3MentorMethod,
      transport: 'xhr',
      status: xhr ? Number(xhr.status) || 0 : 0,
      type: 'xhr',
      ok: !!(xhr && xhr.status >= 200 && xhr.status < 300),
      redirected: false,
      bodyUsed: false,
      contentType: readAllowedHeader(function (name) { return xhr.getResponseHeader(name); }, 'content-type'),
      contentLength: readAllowedHeader(function (name) { return xhr.getResponseHeader(name); }, 'content-length')
    };
    var responseType = '';
    try { responseType = xhr.responseType || ''; } catch (e1) { responseType = ''; }
    if (responseType === 'json' && xhr.response && typeof xhr.response === 'object') {
      var encoded = '';
      try { encoded = JSON.stringify(xhr.response); } catch (e2) { encoded = ''; }
      applyObservation(state, kind, Object.assign(facts, {
        clone: 'SUCCESS',
        textStatus: encoded ? 'SUCCESS' : 'FAILED',
        text: encoded,
        errorName: encoded ? '' : 'TypeError',
        errorMessage: encoded ? '' : 'unavailable'
      }));
      schedulePaint();
      return;
    }
    var text = '';
    try {
      if (responseType && responseType !== 'text') {
        applyObservation(state, kind, Object.assign(facts, {
          clone: 'SUCCESS',
          textStatus: 'FAILED',
          errorName: 'InvalidStateError',
          errorMessage: 'unsupported responseType'
        }));
        schedulePaint();
        return;
      }
      text = xhr.responseText || '';
    } catch (e3) {
      applyObservation(state, kind, Object.assign(facts, {
        clone: 'SUCCESS',
        textStatus: 'FAILED',
        error: e3
      }));
      schedulePaint();
      return;
    }
    applyObservation(state, kind, Object.assign(facts, {
      clone: 'SUCCESS',
      textStatus: 'SUCCESS',
      text: text
    }));
    schedulePaint();
  }

  function installFetch() {
    if (global.__OFK3_MENTOR_HOOKED__) return;
    var origFetch = global.fetch;
    if (typeof origFetch !== 'function') return;
    global.fetch = function (input, init) {
      var info = requestInfo(input, init);
      state.fetchIntercepted += 1;
      rememberObserved(state, 'fetch', info.method, info.url);
      var kind = captureKind(info.url, info.method);
      noteMatch(kind);
      var bridge = null;
      var signalAtStart = 'none';
      var promise = null;
      if (kind && typeof AbortController === 'function') {
        try {
          bridge = detachableSignal(pageSignal(input, init));
          signalAtStart = bridge.pageAborted();
          promise = invokeFetch(origFetch, this, input, init, bridge);
        } catch (e0) {
          bridge = null;
          promise = null;
        }
      }
      if (!promise) promise = origFetch.apply(this, arguments);
      if (kind && promise && typeof promise.then === 'function') {
        promise.then(function (res) {
          state.responsesReceived += 1;
          var signalAtResponse = bridge ? bridge.pageAborted() : signalState(pageSignal(input, init));
          if (bridge) bridge.detach();
          try {
            observeFetchResponse(kind, info, res, {
              signalAtStart: signalAtStart,
              signalAtResponse: signalAtResponse,
              pageAborted: bridge ? function () { return bridge.pageAborted(); } : function () { return signalState(pageSignal(input, init)); }
            });
          } catch (e) {}
        }, function () {});
      }
      schedulePaint();
      return promise;
    };
    global.__OFK3_MENTOR_HOOKED__ = true;
  }

  function installXhr() {
    if (global.__OFK3_MENTOR_XHR_HOOKED__) return;
    if (!global.XMLHttpRequest || !global.XMLHttpRequest.prototype) return;
    var xhrOpen = global.XMLHttpRequest.prototype.open;
    var xhrSend = global.XMLHttpRequest.prototype.send;
    if (typeof xhrOpen !== 'function' || typeof xhrSend !== 'function') return;
    global.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__ofk3MentorMethod = method;
        this.__ofk3MentorUrl = url;
      } catch (e) {}
      return xhrOpen.apply(this, arguments);
    };
    global.XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var kind = '';
      try { kind = captureKind(xhr.__ofk3MentorUrl, xhr.__ofk3MentorMethod); } catch (e1) { kind = ''; }
      state.xhrIntercepted += 1;
      rememberObserved(state, 'xhr', xhr.__ofk3MentorMethod, xhr.__ofk3MentorUrl);
      noteMatch(kind);
      if (kind) {
        xhr.addEventListener('load', function () {
          state.responsesReceived += 1;
          try { observeXhr(kind, xhr); } catch (e2) {}
        });
      }
      schedulePaint();
      return xhrSend.apply(this, arguments);
    };
    global.__OFK3_MENTOR_XHR_HOOKED__ = true;
  }

  installFetch();
  installXhr();
  state.hookInstalled = !!(global.__OFK3_MENTOR_HOOKED__ || global.__OFK3_MENTOR_XHR_HOOKED__);
  state.hookInstalledAt = state.hookInstalled ? new Date().toISOString() : null;

  var PANEL_ID = 'ofk3-mentor-capture-v0';
  var panelCollapsed = true;

  function setPanelCollapsed(collapsed) {
    panelCollapsed = !!collapsed;
    var host = document.getElementById(PANEL_ID);
    if (!host || !host.shadowRoot) return;
    var box = host.shadowRoot.querySelector('.box');
    var head = host.shadowRoot.getElementById('ofk3-mentor-head');
    var title = host.shadowRoot.getElementById('ofk3-mentor-title');
    var toggle = host.shadowRoot.getElementById('ofk3-mentor-toggle');
    var details = host.shadowRoot.getElementById('ofk3-mentor-details');
    if (box) box.className = panelCollapsed ? 'box collapsed' : 'box';
    if (head) head.style.display = panelCollapsed ? 'block' : 'flex';
    if (title) title.style.display = 'none';
    if (details) details.style.display = panelCollapsed ? 'none' : 'block';
    if (toggle) toggle.textContent = panelCollapsed ? 'Mentor稼働確認' : '最小化';
  }

  function line(parent, label, value) {
    var row = document.createElement('div');
    var name = document.createElement('b');
    name.textContent = label;
    row.appendChild(name);
    row.appendChild(document.createTextNode(value == null ? '' : String(value)));
    parent.appendChild(row);
  }

  function sampleText(sample) {
    if (!sample) return '-';
    return Object.keys(sample).map(function (key) {
      return key + ': ' + sample[key];
    }).join('\n');
  }

  function paint() {
    var host = document.getElementById(PANEL_ID);
    if (!host || !host.shadowRoot) return;
    var body = host.shadowRoot.getElementById('ofk3-mentor-body');
    var status = host.shadowRoot.getElementById('ofk3-mentor-status');
    if (!body || !status) return;
    var diagnostic = buildDiagnostic(state);
    status.textContent = diagnostic.capture;
    body.textContent = '';
    var last = diagnostic.lastResponse || {};
    line(body, 'hook installed: ', diagnostic.hookInstalled);
    line(body, 'hookInstalledAt: ', diagnostic.hookInstalledAt || '-');
    line(body, 'fetch intercepted: ', diagnostic.fetchIntercepted);
    line(body, 'xhr intercepted: ', diagnostic.xhrIntercepted);
    line(body, 'meta matched: ', diagnostic.metaMatched);
    line(body, 'shifts matched: ', diagnostic.shiftsMatched);
    line(body, 'responses received: ', diagnostic.responsesReceived);
    line(body, 'observed paths: ', diagnostic.observedPathCount);
    var paths = document.createElement('pre');
    paths.textContent = (diagnostic.observedPaths || []).map(function (item) {
      return item.transport + ' ' + item.method + ' ' + item.hostname + ' ' + item.pathname;
    }).join('\n') || '-';
    paths.style.whiteSpace = 'pre-wrap';
    paths.style.margin = '4px 0 8px';
    body.appendChild(paths);
    line(body, 'meta captured: ', diagnostic.metaCaptured);
    line(body, 'shifts captured: ', diagnostic.shiftsCaptured);
    line(body, 'capturedAt: ', diagnostic.capturedAt || '-');
    line(body, 'last pathname: ', last.pathname || '-');
    line(body, 'last method: ', last.method || '-');
    line(body, 'last transport: ', last.transport || '-');
    line(body, 'status: ', last.status == null ? '-' : last.status);
    line(body, 'type: ', last.type || '-');
    line(body, 'ok: ', last.ok == null ? '-' : String(last.ok));
    line(body, 'redirected: ', last.redirected == null ? '-' : String(last.redirected));
    line(body, 'bodyUsed: ', last.bodyUsed == null ? '-' : String(last.bodyUsed));
    line(body, 'signal at start: ', last.signalAtStart || '-');
    line(body, 'signal at response: ', last.signalAtResponse || '-');
    line(body, 'signal at read failure: ', last.signalAtReadFailure || '-');
    line(body, 'content-type: ', last.contentType || '-');
    line(body, 'content-length: ', last.contentLength || '-');
    line(body, 'clone: ', last.clone || '-');
    line(body, 'text: ', last.text || '-');
    line(body, 'textLength: ', last.textLength == null ? '-' : last.textLength);
    line(body, 'xssiPrefix: ', last.xssiPrefix || '-');
    line(body, 'JSON.parse: ', last.jsonParse || '-');
    line(body, 'error.name: ', last.errorName || '-');
    line(body, 'error.message: ', last.errorMessage || '-');
    line(body, 'totalRows: ', diagnostic.totalRows);
    line(body, 'shiftStartTime: ', diagnostic.rowsWithShiftStartTime);
    line(body, 'shiftEndTime: ', diagnostic.rowsWithShiftEndTime);
    line(body, 'shiftEndTime == "N/A": ', diagnostic.rowsWithEndNA);
    line(body, 'N/A vrmStatus counts: ', Object.keys(diagnostic.naVrmStatusCounts || {}).map(function (label) {
      return label + '=' + diagnostic.naVrmStatusCounts[label];
    }).join(', ') || '-');
    line(body, 'N/A device empty / non-empty: ', diagnostic.naDeviceEmpty + ' / ' + diagnostic.naDeviceNonEmpty);
    line(body, 'N/A vehicleIdentifier empty / non-empty: ', diagnostic.naVehicleIdentifierEmpty + ' / ' + diagnostic.naVehicleIdentifierNonEmpty);
    line(body, 'N/A rows with shiftStartTime: ', diagnostic.naRowsWithShiftStartTime);
    line(body, 'N/A rows with driverId: ', diagnostic.naRowsWithDriverId);
    line(body, 'N/A rows with realStaffNumber: ', diagnostic.naRowsWithRealStaffNumber);
    line(body, 'active open rows: ', diagnostic.activeOpenRows);
    line(body, 'active open driverId unique / duplicate values: ', diagnostic.activeOpenDriverIdUnique + ' / ' + diagnostic.activeOpenDriverIdDuplicateValues);
    line(body, 'active open realStaffNumber unique / duplicate values: ', diagnostic.activeOpenRealStaffNumberUnique + ' / ' + diagnostic.activeOpenRealStaffNumberDuplicateValues);
    line(body, 'driverIds with multiple realStaffNumbers: ', diagnostic.driverIdsWithMultipleRealStaffNumbers);
    line(body, 'realStaffNumbers with multiple driverIds: ', diagnostic.realStaffNumbersWithMultipleDriverIds);
    line(body, 'active snapshot: ', diagnostic.activeSnapshotCount == null ? '-' : diagnostic.activeSnapshotCount);
    line(body, 'structure keys: ', diagnostic.structureKeys.length ? diagnostic.structureKeys.join(', ') : '-');
    line(body, 'Detected row keys: ', diagnostic.detectedRowKeys.length ? diagnostic.detectedRowKeys.join(', ') : '-');
    line(body, 'candidate identifier fields: ', diagnostic.candidateIdentifierFields.length ? diagnostic.candidateIdentifierFields.join(', ') : '-');
    if (diagnostic.issue) line(body, 'issue: ', diagnostic.issue);
    var sample = document.createElement('pre');
    sample.textContent = 'Sample Row Structure\n' + sampleText(diagnostic.sampleRow);
    sample.style.whiteSpace = 'pre-wrap';
    sample.style.margin = '8px 0 0';
    body.appendChild(sample);
  }

  function copyDiagnostic() {
    var text = JSON.stringify(buildDiagnostic(state), null, 2);
    var note = document.getElementById(PANEL_ID);
    var status = note && note.shadowRoot && note.shadowRoot.getElementById('ofk3-mentor-copy-note');
    function mark(message) {
      if (status) status.textContent = message;
    }
    if (global.navigator && global.navigator.clipboard && typeof global.navigator.clipboard.writeText === 'function') {
      global.navigator.clipboard.writeText(text).then(function () {
        mark('コピーしました');
      }).catch(function () {
        mark('コピーできませんでした');
      });
      return;
    }
    mark('コピーできませんでした');
  }

  function markSend(message) {
    var note = document.getElementById(PANEL_ID);
    var status = note && note.shadowRoot && note.shadowRoot.getElementById('ofk3-mentor-send-note');
    if (status) status.textContent = message;
  }

  function sendActiveSnapshot() {
    var snap = state.activeSnapshot;
    if (!snap || snap.source !== 'mentor' || !Array.isArray(snap.drivers)) {
      markSend('Active Snapshotがありません');
      return;
    }
    var requestId = String(Date.now());
    state.pendingSendId = requestId;
    try {
      global.postMessage({
        source: 'OFK3_MENTOR',
        type: 'mentor-active-import',
        requestId: requestId,
        payload: {
          capturedAt: snap.capturedAt,
          source: 'mentor',
          activeCount: snap.activeCount,
          drivers: snap.drivers
        }
      }, global.location.origin);
      markSend('送信中');
    } catch (e) {
      markSend('送信できませんでした');
    }
  }

  global.addEventListener('message', function (ev) {
    if (ev.source !== global) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_MENTOR' || data.type !== 'mentor-active-import-result') return;
    if (state.pendingSendId && data.requestId !== state.pendingSendId) return;
    if (data.ok) markSend('送信しました (' + (data.activeCount == null ? '-' : data.activeCount) + ')');
    else markSend(data.message || '送信できませんでした');
  });

  global.addEventListener('message', function (ev) {
    if (ev.source !== global) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_ID_DIAG' || data.type !== 'please-resend-mentor') return;
    if (!lastMentorDigest || typeof global.postMessage !== 'function') return;
    var target = '';
    try { target = global.location.origin; } catch (e) { target = ''; }
    if (!target) return;
    try {
      global.postMessage({ source: 'OFK3_ID_DIAG', type: 'mentor-ids', digest: lastMentorDigest }, target);
    } catch (e2) {}
  });

  function ensurePanel() {
    if (!document.documentElement || document.getElementById(PANEL_ID)) return;
    var host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483646;';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = '.box{width:min(460px,calc(100vw - 24px));max-height:70vh;overflow:auto;overflow-x:hidden;background:#111;color:#fff;font:13px/1.45 sans-serif;padding:10px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35)} .box.collapsed{width:auto;max-height:none;padding:0;background:transparent;box-shadow:none;overflow:visible} .head{display:flex;align-items:center;justify-content:space-between;gap:8px} button{margin:8px 8px 0 0;background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer} .chip{margin:0;font-weight:700} .note{opacity:.8;min-height:1.2em}';
    var box = document.createElement('div');
    box.className = 'box collapsed';
    var head = document.createElement('div');
    head.className = 'head';
    head.id = 'ofk3-mentor-head';
    head.style.display = 'block';
    var titleName = document.createElement('b');
    titleName.id = 'ofk3-mentor-title';
    titleName.textContent = 'Mentor稼働確認';
    titleName.style.display = 'none';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'ofk3-mentor-toggle';
    toggle.className = 'chip';
    toggle.textContent = 'Mentor稼働確認';
    toggle.addEventListener('click', function () {
      setPanelCollapsed(!panelCollapsed);
    });
    head.appendChild(titleName);
    head.appendChild(toggle);
    var details = document.createElement('div');
    details.id = 'ofk3-mentor-details';
    details.style.display = 'none';
    var diag = document.createElement('div');
    diag.id = 'ofk3-id-diag';
    diag.style.marginBottom = '10px';
    diag.style.paddingBottom = '8px';
    diag.style.borderBottom = '1px solid rgba(255,255,255,.2)';
    var diagTitle = document.createElement('b');
    diagTitle.textContent = 'ID照合診断（調査用）';
    var diagBody = document.createElement('pre');
    diagBody.id = 'ofk3-id-diag-body';
    diagBody.style.whiteSpace = 'pre-wrap';
    diagBody.style.overflowWrap = 'anywhere';
    diagBody.style.margin = '8px 0 0';
    diagTitle.hidden = true;
    diagBody.hidden = true;
    try {
      diagBody.textContent = (global.OFK3IdDiag && typeof global.OFK3IdDiag.panelLines === 'function')
        ? global.OFK3IdDiag.panelLines(null).join('\n')
        : 'ID照合診断（調査用）\n未取得';
    } catch (eDiag) {
      diagBody.textContent = 'ID照合診断（調査用）\n未取得';
    }
    diag.appendChild(diagTitle);
    diag.appendChild(diagBody);
    details.appendChild(diag);
    var tech = document.createElement('div');
    tech.id = 'ofk3-mentor-tech';
    tech.hidden = true;
    var techLabel = document.createElement('div');
    techLabel.textContent = 'API取得ログ';
    techLabel.style.fontWeight = '700';
    techLabel.style.marginTop = '8px';
    var status = document.createElement('div');
    status.id = 'ofk3-mentor-status';
    status.textContent = 'WAITING';
    var body = document.createElement('div');
    body.id = 'ofk3-mentor-body';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '診断JSONコピー';
    button.addEventListener('click', copyDiagnostic);
    var copyNote = document.createElement('div');
    copyNote.id = 'ofk3-mentor-copy-note';
    copyNote.className = 'note';
    var sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.textContent = 'HARVESTへ送る';
    sendButton.addEventListener('click', sendActiveSnapshot);
    var sendNote = document.createElement('div');
    sendNote.id = 'ofk3-mentor-send-note';
    sendNote.className = 'note';
    tech.appendChild(techLabel);
    tech.appendChild(status);
    tech.appendChild(body);
    tech.appendChild(button);
    tech.appendChild(copyNote);
    tech.appendChild(sendButton);
    tech.appendChild(sendNote);
    details.appendChild(tech);
    box.appendChild(head);
    box.appendChild(details);
    shadow.appendChild(style);
    shadow.appendChild(box);
    document.documentElement.appendChild(host);
    paint();
  }

  function onReady(fn) {
    if (document.documentElement) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(ensurePanel);
})(typeof window !== 'undefined' ? window : globalThis);
