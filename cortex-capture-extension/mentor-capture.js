/**
 * OFK3 Mentor Capture v0 — page MAIN world only.
 * Observes Mentor's own GET responses for shift meta and shift rows.
 * Does not call Mentor APIs and does not read credentials or browser storage.
 * Does not send data anywhere. Diagnostic display and clipboard JSON are redacted.
 */
(function (global) {
  'use strict';

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
    body.data.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      Object.keys(row).forEach(function (key) { keySet[key] = true; });
      if (presentValue(row.shiftStartTime)) out.rowsWithShiftStartTime += 1;
      if (presentValue(row.shiftEndTime)) out.rowsWithShiftEndTime += 1;
      if (row.shiftEndTime === 'N/A') {
        out.rowsWithEndNA += 1;
        if (!openSample) openSample = row;
      }
      if (!sample) sample = row;
    });
    out.detectedRowKeys = Object.keys(keySet).sort();
    out.candidateIdentifierFields = IDENTIFIER_CANDIDATES.filter(function (name) {
      return Object.prototype.hasOwnProperty.call(keySet, name);
    });
    out.sampleRow = redactRow(openSample || sample);
    return out;
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

  function kindCaptured(state, kind) {
    if (kind === 'meta') return !!state.metaCaptured;
    if (kind === 'shifts') return !!state.shiftsCaptured;
    return false;
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
      errorMessage: parsed ? parsed.errorMessage : safeErrorMessage(obs.error || obs.errorMessage)
    };
    var accepted = !!(parsed && parsed.ok && status >= 200 && status < 300);
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
      state.sampleRow = shifts.sampleRow;
      state.issue = '';
    }
    state.capturedAt = new Date().toISOString();
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
    captureStatus: captureStatus,
    pathnameOnly: pathnameOnly,
    publicRequestTarget: publicRequestTarget,
    rememberObserved: rememberObserved,
    parseResponseText: parseResponseText,
    applyObservation: applyObservation,
    safeErrorMessage: safeErrorMessage,
    safeHeaderValue: safeHeaderValue,
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

  function observeFetchResponse(kind, info, res) {
    var facts = {
      pathname: pathnameOnly(info && info.url),
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
        errorMessage: 'clone unavailable'
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
        error: e
      }));
      schedulePaint();
      return;
    }
    cloned.text().then(function (text) {
      applyObservation(state, kind, Object.assign(facts, {
        clone: 'SUCCESS',
        textStatus: 'SUCCESS',
        text: text
      }));
      schedulePaint();
    }, function (e) {
      applyObservation(state, kind, Object.assign(facts, {
        clone: 'SUCCESS',
        textStatus: 'FAILED',
        error: e
      }));
      schedulePaint();
    });
  }

  function observeXhr(kind, xhr) {
    var facts = {
      pathname: pathnameOnly(xhr && xhr.__ofk3MentorUrl),
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
      var promise = origFetch.apply(this, arguments);
      if (kind && promise && typeof promise.then === 'function') {
        promise.then(function (res) {
          state.responsesReceived += 1;
          try { observeFetchResponse(kind, info, res); } catch (e) {}
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
  var panelCollapsed = false;

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
    if (title) title.style.display = panelCollapsed ? 'none' : '';
    if (details) details.style.display = panelCollapsed ? 'none' : 'block';
    if (toggle) toggle.textContent = panelCollapsed ? 'MENTOR CAPTURE v0' : '最小化';
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

  function ensurePanel() {
    if (!document.documentElement || document.getElementById(PANEL_ID)) return;
    var host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483646;';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = '.box{width:420px;max-height:70vh;overflow:auto;background:#111;color:#fff;font:12px/1.45 sans-serif;padding:10px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35)} .box.collapsed{width:auto;max-height:none;padding:0;background:transparent;box-shadow:none;overflow:visible} .head{display:flex;align-items:center;justify-content:space-between;gap:8px} button{margin:8px 8px 0 0;background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer} .chip{margin:0;font-weight:700} .note{opacity:.8;min-height:1.2em}';
    var box = document.createElement('div');
    box.className = 'box';
    var head = document.createElement('div');
    head.className = 'head';
    head.id = 'ofk3-mentor-head';
    var titleName = document.createElement('b');
    titleName.id = 'ofk3-mentor-title';
    titleName.textContent = 'MENTOR CAPTURE v0';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'ofk3-mentor-toggle';
    toggle.className = 'chip';
    toggle.textContent = '最小化';
    toggle.addEventListener('click', function () {
      setPanelCollapsed(!panelCollapsed);
    });
    head.appendChild(titleName);
    head.appendChild(toggle);
    var details = document.createElement('div');
    details.id = 'ofk3-mentor-details';
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
    details.appendChild(status);
    details.appendChild(body);
    details.appendChild(button);
    details.appendChild(copyNote);
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
