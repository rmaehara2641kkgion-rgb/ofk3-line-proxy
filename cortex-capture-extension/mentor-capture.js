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

  function buildDiagnostic(state) {
    state = state || {};
    return {
      product: 'MENTOR CAPTURE v0',
      capture: captureStatus(!!state.metaCaptured, !!state.shiftsCaptured),
      capturedAt: state.capturedAt || null,
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
    issue: ''
  };

  function stamp() {
    state.capturedAt = new Date().toISOString();
  }

  function noteIssue(code) {
    if (state.metaCaptured && state.shiftsCaptured) return;
    state.issue = code;
    paint();
  }

  function applyMeta(body) {
    var summary = summarizeMeta(body);
    if (!summary.ok) {
      noteIssue(summary.issue || 'META_NOT_OBJECT');
      return;
    }
    state.metaCaptured = true;
    state.metaTopKeys = summary.topKeys;
    state.structureKeys = summary.structureKeys;
    if (summary.issue && !state.shiftsCaptured) state.issue = summary.issue;
    else if (!summary.issue) state.issue = state.shiftsCaptured ? '' : state.issue;
    stamp();
    paint();
  }

  function applyShifts(body) {
    var summary = summarizeShifts(body);
    if (!summary.ok) {
      noteIssue(summary.issue || 'NO_DATA_ARRAY');
      return;
    }
    state.shiftsCaptured = true;
    state.totalRows = summary.totalRows;
    state.detectedRowKeys = summary.detectedRowKeys;
    state.candidateIdentifierFields = summary.candidateIdentifierFields;
    state.rowsWithShiftStartTime = summary.rowsWithShiftStartTime;
    state.rowsWithShiftEndTime = summary.rowsWithShiftEndTime;
    state.rowsWithEndNA = summary.rowsWithEndNA;
    state.sampleRow = summary.sampleRow;
    state.issue = '';
    stamp();
    paint();
  }

  function observeResponse(kind, res) {
    try {
      if (!res || typeof res.clone !== 'function') {
        noteIssue('NO_CLONE');
        return;
      }
      var status = Number(res.status);
      res.clone().json().then(function (body) {
        if (!(status >= 200 && status < 300)) {
          noteIssue('HTTP_' + status);
          return;
        }
        if (kind === 'meta') applyMeta(body);
        else applyShifts(body);
      }).catch(function () {
        noteIssue('RESPONSE_JSON_UNAVAILABLE');
      });
    } catch (e) {
      noteIssue('OBSERVE_FAILED');
    }
  }

  function installFetch() {
    if (global.__OFK3_MENTOR_HOOKED__) return;
    var origFetch = global.fetch;
    if (typeof origFetch !== 'function') return;
    global.fetch = function (input, init) {
      var info = requestInfo(input, init);
      var promise = origFetch.apply(this, arguments);
      var kind = captureKind(info.url, info.method);
      if (kind && promise && typeof promise.then === 'function') {
        promise.then(function (res) {
          observeResponse(kind, res);
        }, function () {});
      }
      return promise;
    };
    global.__OFK3_MENTOR_HOOKED__ = true;
  }

  installFetch();

  var PANEL_ID = 'ofk3-mentor-capture-v0';

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
    line(body, 'meta captured: ', diagnostic.metaCaptured);
    line(body, 'shifts captured: ', diagnostic.shiftsCaptured);
    line(body, 'capturedAt: ', diagnostic.capturedAt || '-');
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
    host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483646;';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = '.box{width:320px;max-height:70vh;overflow:auto;background:#111;color:#fff;font:12px/1.45 sans-serif;padding:10px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35)} button{margin:8px 8px 0 0;background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer} .note{opacity:.8;min-height:1.2em}';
    var box = document.createElement('div');
    box.className = 'box';
    var title = document.createElement('div');
    var titleName = document.createElement('b');
    titleName.textContent = 'MENTOR CAPTURE v0';
    title.appendChild(titleName);
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
    box.appendChild(title);
    box.appendChild(status);
    box.appendChild(body);
    box.appendChild(button);
    box.appendChild(copyNote);
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
