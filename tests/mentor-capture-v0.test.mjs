import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, '..');
const mentorPath = join(repo, 'cortex-capture-extension', 'mentor-capture.js');
const mentorSrc = readFileSync(mentorPath, 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

const sandbox = {
  URL: URL,
  Date: Date,
  JSON: JSON,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  Boolean: Boolean,
  AbortController: AbortController,
  console: console
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(mentorSrc, sandbox, { filename: 'mentor-capture.js' });
const MC = sandbox.OFK3MentorCapture;
assert(MC && typeof MC.captureKind === 'function', 'diagnostic API is exported without installing hooks');
assert(sandbox.__OFK3_MENTOR_HOOKED__ !== true, 'hooks stay off outside the Mentor host');

const metaUrl = 'https://mis-api.edriving.com/reports/driver/shifts/meta';
const shiftsUrl = 'https://mis-api.edriving.com/reports/driver/shifts?decorate=yes&startTime=1&endTime=2&localDate=2026-10-05&fpId=SECRET-FLEET';
const devicesUrl = 'https://mis-api.edriving.com/reports/driver/shifts/devices';

assert(MC.captureKind('https://logistics.amazon.co.jp/operations', 'GET') === '', 'case 1: non-Mentor URL is ignored');
assert(MC.captureKind('https://vrm-mentor.edriving.com/#/login', 'GET') === '', 'case 2: login page navigation is not a shift request');
assert(MC.captureKind(metaUrl, 'GET') === 'meta', 'meta GET is captured');
assert(MC.captureKind(shiftsUrl, 'GET') === 'shifts', 'shifts GET is captured');
assert(MC.captureKind(shiftsUrl, 'POST') === '', 'POST shifts is ignored');
assert(MC.captureKind(devicesUrl, 'GET') === '', 'devices GET is ignored');
assert(MC.captureKind(devicesUrl, 'POST') === '', 'devices POST is ignored');
assert(MC.captureKind(shiftsUrl, 'GET').indexOf('SECRET-FLEET') < 0, 'capture kind does not keep the query string');

assert(MC.captureStatus(false, false) === 'WAITING', 'case 2: nothing captured stays WAITING');

const meta = MC.summarizeMeta({
  structure: {
    driverId: { name: 'Driver Id' },
    firstName: { name: 'First Name' },
    lastName: { name: 'Last Name' },
    staffNumber: { name: 'Staff Number' },
    shiftStartTime: { name: 'Shift Start Time' },
    shiftEndTime: { name: 'Shift End Time' },
    transporterId: { name: 'Transporter' }
  }
});
assert(meta.ok && meta.structureKeys.indexOf('driverId') >= 0, 'case 3: meta structure keys are kept');
assert(meta.structureKeys.indexOf('transporterId') >= 0, 'meta keeps keys outside the candidate list');
assert(JSON.stringify(meta).indexOf('Driver Id') < 0, 'meta summary keeps keys, not column display values');

const secretName = 'Yamada Taro';
const secretId = 'DA-SECRET-42';
const secretStaff = 'STF-7788';
const shifts = MC.summarizeShifts({
  data: [
    {
      driverId: secretId,
      firstName: secretName,
      staffNumber: secretStaff,
      shiftStartTime: 1791160800000,
      shiftEndTime: 'N/A',
      device: 'phone-secret',
      fpId: 'SECRET-FLEET',
      transporterId: 'TR-SECRET'
    },
    {
      driverId: 'DA-OTHER',
      name: 'Other Person',
      shiftStartTime: 1791160900000,
      shiftEndTime: 1791170000000,
      device: 'phone-2'
    },
    {
      driverId: 'DA-CLOSED',
      shiftStartTime: 1791161000000,
      shiftEndTime: '12:15',
      device: ''
    }
  ]
});
assert(shifts.ok, 'case 3: shifts body with data array is accepted');
assert(shifts.totalRows === 3, 'case 4: totalRows');
assert(shifts.rowsWithShiftStartTime === 3, 'shiftStartTime count');
assert(shifts.rowsWithShiftEndTime === 3, 'shiftEndTime count includes N/A and timestamps');
assert(shifts.rowsWithEndNA === 1, 'case 5: N/A rows are counted');
assert(shifts.detectedRowKeys.indexOf('transporterId') >= 0, 'detected row keys include non-candidate fields');
assert(shifts.candidateIdentifierFields.indexOf('driverId') >= 0, 'candidate driverId is reported when present');
assert(shifts.candidateIdentifierFields.indexOf('firstName') >= 0, 'candidate firstName is reported when present');
assert(shifts.candidateIdentifierFields.indexOf('staffNumber') >= 0, 'candidate staffNumber is reported when present');
assert(shifts.candidateIdentifierFields.indexOf('transporterId') < 0, 'non-candidates stay in detected keys only');
assert(shifts.sampleRow.shiftEndTime === 'N/A', 'sample prefers an open session and keeps the N/A sentinel');
assert(shifts.sampleRow.shiftStartTime === '[NUMBER]', 'sample hides the timestamp digits');

const openStatus = 'On Trip';
const idleStatus = 'Idle';
const opaqueStatus = '9988776655';
const namedStatus = '山田太郎';
const anon = MC.summarizeShifts({
  data: [
    {
      driverId: secretId,
      realStaffNumber: secretStaff,
      firstName: secretName,
      vrmStatus: openStatus,
      device: { id: 'phone-secret' },
      vehicleIdentifier: 'VH-SECRET',
      shiftStartTime: 1791160800000,
      shiftEndTime: 'N/A'
    },
    {
      driverId: secretId,
      realStaffNumber: 'STF-OTHER',
      vrmStatus: openStatus,
      device: '',
      vehicleIdentifier: '   ',
      shiftStartTime: 1791160900000,
      shiftEndTime: 'N/A'
    },
    {
      driverId: 'DA-OPEN-3',
      realStaffNumber: '',
      vrmStatus: idleStatus,
      device: null,
      vehicleIdentifier: null,
      shiftEndTime: 'N/A'
    },
    {
      driverId: 'DA-OPEN-4',
      realStaffNumber: secretStaff,
      vrmStatus: opaqueStatus,
      device: [],
      vehicleIdentifier: {},
      shiftStartTime: 1791161000000,
      shiftEndTime: 'N/A'
    },
    {
      driverId: '   ',
      realStaffNumber: 'STF-CLOSED',
      vrmStatus: namedStatus,
      shiftStartTime: 1791161100000,
      shiftEndTime: 1791170000000
    }
  ]
});
assert(anon.rowsWithEndNA === 4, 'N/A rows are counted without listing them');
assert(anon.naVrmStatusCounts[openStatus] === 2 && anon.naVrmStatusCounts[idleStatus] === 1, 'N/A rows are counted by vrmStatus label');
assert(anon.naVrmStatusCounts['(opaque)'] === 1, 'identifier-shaped vrmStatus values are not copied');
assert(anon.naDeviceNonEmpty === 1 && anon.naDeviceEmpty === 3, 'N/A device empty and non-empty counts');
assert(anon.naVehicleIdentifierNonEmpty === 1 && anon.naVehicleIdentifierEmpty === 3, 'N/A vehicleIdentifier empty and non-empty counts');
assert(anon.naRowsWithShiftStartTime === 3, 'N/A rows with shiftStartTime are counted');
assert(anon.naRowsWithDriverId === 4, 'N/A rows with driverId are counted');
assert(anon.naRowsWithRealStaffNumber === 3, 'N/A rows with realStaffNumber are counted');
assert(anon.activeOpenRows === 0, 'N/A rows that are not Active stay out of the open set');
assert(anon.driverIdsWithMultipleRealStaffNumbers === 1, 'one driverId mapping to several staff numbers is a count');
assert(anon.realStaffNumbersWithMultipleDriverIds === 1, 'one staff number mapping to several driverIds is a count');
const anonCopy = JSON.stringify(anon);
assert(anonCopy.indexOf(secretId) < 0 && anonCopy.indexOf(secretStaff) < 0 && anonCopy.indexOf(secretName) < 0, 'anonymous counts omit driver values');
assert(anonCopy.indexOf('VH-SECRET') < 0 && anonCopy.indexOf('phone-secret') < 0, 'anonymous counts omit device and vehicle values');
assert(anonCopy.indexOf(opaqueStatus) < 0 && anonCopy.indexOf(namedStatus) < 0, 'unsafe vrmStatus values are not copied');
assert(anonCopy.indexOf('STF-OTHER') < 0 && anonCopy.indexOf('DA-OPEN-3') < 0, 'other identifier values are not copied');

const openKeys = MC.summarizeShifts({
  data: [
    { driverId: 'DRV-1', realStaffNumber: 'STF-1', firstName: secretName, vrmStatus: 'Active', shiftEndTime: 'N/A' },
    { driverId: 'DRV-1', realStaffNumber: 'STF-1', vrmStatus: 'Complete', shiftEndTime: 10 },
    { driverId: 'DRV-2', realStaffNumber: 'STF-2', vrmStatus: 'Active', shiftEndTime: 'N/A' },
    { driverId: 'DRV-2', realStaffNumber: 'STF-2', vrmStatus: 'Active', shiftEndTime: 'N/A' },
    { driverId: 'DRV-3', realStaffNumber: 'STF-3', vrmStatus: 'Idle', shiftEndTime: 'N/A' },
    { driverId: 'DRV-4', realStaffNumber: 'STF-9', vrmStatus: 'Complete', shiftEndTime: 11 },
    { driverId: 'DRV-4', realStaffNumber: 'STF-8', vrmStatus: 'Complete', shiftEndTime: 12 },
    { driverId: 'DRV-5', realStaffNumber: 'STF-7', vrmStatus: 'Complete', shiftEndTime: 13 },
    { driverId: 'DRV-6', realStaffNumber: 'STF-7', vrmStatus: 'Complete', shiftEndTime: 14 },
    { driverId: '', realStaffNumber: 'STF-6', vrmStatus: 'Active', shiftEndTime: 'N/A' }
  ]
});
assert(openKeys.activeOpenRows === 4, 'active open rows are N/A and Active only');
assert(openKeys.activeOpenDriverIdUnique === 2 && openKeys.activeOpenDriverIdDuplicateValues === 1, 'active open driverId uniqueness ignores closed history');
assert(openKeys.activeOpenRealStaffNumberUnique === 3 && openKeys.activeOpenRealStaffNumberDuplicateValues === 1, 'active open staff uniqueness ignores closed history and blank driverIds');
assert(openKeys.driverIdsWithMultipleRealStaffNumbers === 1, 'repeated sessions with the same pair are not a mapping conflict');
assert(openKeys.realStaffNumbersWithMultipleDriverIds === 1, 'one staff number used by two driverIds is a mapping conflict');
const openCopy = JSON.stringify(openKeys);
assert(openCopy.indexOf('DRV-1') < 0 && openCopy.indexOf('STF-1') < 0 && openCopy.indexOf(secretName) < 0, 'active open counts omit identifier values');
assert(openCopy.indexOf('stableKeyCandidate') < 0, 'all-row uniqueness is not treated as the identifier decision');

const anonObserved = MC.applyObservation(freshState(), 'shifts', {
  pathname: '/reports/driver/shifts',
  method: 'GET',
  status: 200,
  type: 'cors',
  ok: true,
  contentType: 'application/json',
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  text: JSON.stringify({
    data: [
      { driverId: 'A', realStaffNumber: '1', vrmStatus: 'Active', device: 'x', vehicleIdentifier: 'y', shiftStartTime: 1, shiftEndTime: 'N/A' },
      { driverId: 'A', realStaffNumber: '1', vrmStatus: openStatus, shiftEndTime: 2 },
      { driverId: 'B', realStaffNumber: '2', vrmStatus: 'Active', shiftEndTime: 'N/A' }
    ]
  })
});
const anonDiagnostic = MC.buildDiagnostic(anonObserved);
assert(anonDiagnostic.naVrmStatusCounts.Active === 2, 'diagnostic keeps N/A status counts');
assert(anonDiagnostic.naDeviceNonEmpty === 1 && anonDiagnostic.naVehicleIdentifierNonEmpty === 1, 'diagnostic keeps N/A empty checks');
assert(anonDiagnostic.activeOpenRows === 2, 'diagnostic keeps the active open row count');
assert(anonDiagnostic.activeOpenDriverIdUnique === 2 && anonDiagnostic.activeOpenDriverIdDuplicateValues === 0, 'diagnostic keeps active open uniqueness');
assert(anonDiagnostic.driverIdsWithMultipleRealStaffNumbers === 0 && anonDiagnostic.realStaffNumbersWithMultipleDriverIds === 0, 'diagnostic keeps mapping conflict counts');
assert(JSON.stringify(anonDiagnostic).indexOf('stableKeyCandidate') < 0, 'diagnostic does not publish an all-row key choice');
assert(JSON.stringify(anonDiagnostic).indexOf('"x"') < 0 && JSON.stringify(anonDiagnostic).indexOf('"y"') < 0, 'diagnostic does not copy device or vehicle values');

const diagnostic = MC.buildDiagnostic({
  metaCaptured: true,
  shiftsCaptured: true,
  capturedAt: '2026-10-05T12:00:00.000Z',
  metaTopKeys: meta.topKeys,
  structureKeys: meta.structureKeys,
  totalRows: shifts.totalRows,
  detectedRowKeys: shifts.detectedRowKeys,
  candidateIdentifierFields: shifts.candidateIdentifierFields,
  rowsWithShiftStartTime: shifts.rowsWithShiftStartTime,
  rowsWithShiftEndTime: shifts.rowsWithShiftEndTime,
  rowsWithEndNA: shifts.rowsWithEndNA,
  sampleRow: shifts.sampleRow,
  issue: ''
});
const copied = JSON.stringify(diagnostic);
assert(diagnostic.capture === 'SUCCESS', 'both responses produce SUCCESS');
assert(copied.indexOf(secretName) < 0, 'case 6: driver name is absent from diagnostic JSON');
assert(copied.indexOf(secretId) < 0, 'case 6: driver id value is absent');
assert(copied.indexOf(secretStaff) < 0, 'case 6: staff number value is absent');
assert(copied.indexOf('SECRET-FLEET') < 0, 'case 6: fleet id value is absent');
assert(copied.indexOf('phone-secret') < 0, 'case 6: device value is absent');
assert(copied.indexOf('1791160800000') < 0, 'case 6: raw timestamp is absent');
assert(copied.indexOf('TR-SECRET') < 0, 'case 6: extra identifier value is absent');
assert(diagnostic.sampleRow.driverId === '[REDACTED]', 'string identifiers are redacted');
assert(MC.summarizeShifts({ rows: [] }).issue === 'NO_DATA_ARRAY', 'a body without data is not treated as shifts');

assert(mentorSrc.indexOf('localStorage') < 0, 'case 7: does not touch localStorage');
assert(mentorSrc.indexOf('document.cookie') < 0, 'case 7: does not read cookies');
assert(mentorSrc.indexOf('access_token') < 0, 'case 7: does not name the access token key');
assert(mentorSrc.indexOf('Authorization') < 0, 'case 7: does not read Authorization');
assert(mentorSrc.indexOf('getRequestHeader') < 0 && mentorSrc.indexOf('getAllResponseHeaders') < 0, 'case 7: does not read request headers or every response header');
assert(mentorSrc.indexOf('res.clone().json()') < 0, 'does not rely on response.json()');
assert(mentorSrc.indexOf('cloned.text()') >= 0 && mentorSrc.indexOf('JSON.parse') >= 0, 'reads a clone as text and parses it');
assert(mentorSrc.indexOf('origFetch.apply') >= 0, 'returns the page fetch promise');
assert(mentorSrc.indexOf('vrm-mentor.edriving.com') >= 0, 'host gate is explicit');
assert(mentorSrc.indexOf('top:12px;right:12px') >= 0, 'diagnostic panel is fixed at the top right');
assert(mentorSrc.indexOf('left:12px;bottom:12px') < 0, 'diagnostic panel is not fixed at the bottom left');
assert(mentorSrc.indexOf('最小化') >= 0 && mentorSrc.indexOf('ofk3-mentor-details') >= 0, 'diagnostic panel can collapse to the title');
assert(mentorSrc.indexOf("if (title) title.style.display = 'none';") >= 0, 'the shell title stays hidden so Mentor稼働確認 is shown once');
assert(mentorSrc.indexOf('shifts\\/devices') >= 0, 'devices path is explicitly excluded');

const manifest = JSON.parse(readFileSync(join(repo, 'cortex-capture-extension', 'manifest.json'), 'utf8'));
const scripts = manifest.content_scripts;
assert(scripts.some(function (cs) {
  return cs.world === 'MAIN' && (cs.js || []).indexOf('phase1-core.js') >= 0 && (cs.js || []).indexOf('phase1-runner.js') >= 0 &&
    (cs.matches || []).indexOf('https://logistics.amazon.co.jp/*') >= 0;
}), 'case 8: Cortex MAIN script matches are unchanged');
assert(scripts.some(function (cs) {
  return cs.world === 'ISOLATED' && (cs.js || []).indexOf('bridge.js') >= 0;
}), 'case 8: Cortex bridge remains');
assert(scripts.some(function (cs) {
  return cs.world === 'MAIN' && (cs.js || []).indexOf('mentor-capture.js') >= 0 &&
    (cs.matches || []).length === 1 && cs.matches[0] === 'https://vrm-mentor.edriving.com/*';
}), 'Mentor script is limited to the Mentor origin');
assert(!scripts.some(function (cs) {
  return (cs.matches || []).some(function (m) { return m.indexOf('mis-api.edriving.com') >= 0; });
}), 'content script is not injected on the API host');
assert((manifest.host_permissions || []).indexOf('https://logistics.amazon.co.jp/*') >= 0, 'Amazon host permission remains');
assert((manifest.host_permissions || []).indexOf('https://mis-api.edriving.com/*') < 0, 'extension does not gain API host permission');

const runner = readFileSync(join(repo, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
const core = readFileSync(join(repo, 'cortex-capture-extension', 'phase1-core.js'), 'utf8');
assert(runner.indexOf('mentor-capture') < 0 && core.indexOf('mentor-capture') < 0, 'case 8: Cortex capture files do not import Mentor');
assert(runner.indexOf("mk('Bag取得'") >= 0 && runner.indexOf('origFetch.apply') >= 0, 'case 8: Bag button and Cortex fetch wrap remain');

function freshState() {
  return {
    hookInstalled: true,
    hookInstalledAt: '2026-10-05T12:00:00.000Z',
    fetchIntercepted: 2,
    xhrIntercepted: 0,
    metaMatched: 1,
    shiftsMatched: 1,
    responsesReceived: 1,
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
}

const secretBody = JSON.stringify({
  data: [{
    driverId: secretId,
    firstName: secretName,
    staffNumber: secretStaff,
    shiftStartTime: 1791160800000,
    shiftEndTime: 'N/A',
    device: 'phone-secret'
  }]
});
const parsedOk = MC.applyObservation(freshState(), 'shifts', {
  pathname: shiftsUrl,
  method: 'GET',
  transport: 'fetch',
  status: 200,
  type: 'cors',
  ok: true,
  redirected: false,
  bodyUsed: false,
  contentType: 'application/json; charset=utf-8',
  contentLength: '48800',
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  text: secretBody
});
const parsedCopy = JSON.stringify(MC.buildDiagnostic(parsedOk));
assert(parsedOk.shiftsCaptured && parsedOk.totalRows === 1, 'text then JSON.parse fills shift rows');
assert(parsedOk.rowsWithEndNA === 1, 'parsed N/A row is counted');
assert(parsedOk.lastResponse.jsonParse === 'SUCCESS', 'JSON.parse success is recorded');
assert(parsedOk.lastResponse.text === 'SUCCESS' && parsedOk.lastResponse.clone === 'SUCCESS', 'clone and text success are recorded');
assert(parsedOk.lastResponse.pathname.indexOf('SECRET-FLEET') < 0, 'last pathname drops the query');
assert(parsedOk.lastResponse.pathname === '/reports/driver/shifts', 'last pathname is the shifts path');
assert(parsedCopy.indexOf(secretName) < 0 && parsedCopy.indexOf(secretId) < 0 && parsedCopy.indexOf(secretStaff) < 0, 'parsed diagnostic hides driver values');
assert(parsedCopy.indexOf('1791160800000') < 0, 'parsed diagnostic hides the timestamp');
const secretQuery = 'https://vrm-mentor.edriving.com/reports/driver/shifts?localDate=2026-10-13&startTime=1&endTime=2&fpId=SECRET-FLEET';
const keptUrl = MC.applyObservation(freshState(), 'shifts', {
  pathname: '/reports/driver/shifts',
  requestUrl: secretQuery,
  method: 'GET',
  transport: 'fetch',
  status: 200,
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  text: secretBody
});
const keptCopy = JSON.stringify(MC.buildDiagnostic(keptUrl));
assert(keptCopy.indexOf('SECRET-FLEET') < 0 && keptCopy.indexOf(secretQuery) < 0 && keptCopy.indexOf('localDate') < 0, 'the capture diagnostic does not keep the request url or query');

const prefixed = MC.applyObservation(freshState(), 'shifts', {
  pathname: '/reports/driver/shifts',
  method: 'GET',
  status: 200,
  type: 'cors',
  ok: true,
  contentType: 'application/json',
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  text: ")]}',\n" + secretBody
});
assert(prefixed.shiftsCaptured && prefixed.lastResponse.xssiPrefix === 'YES', 'Angular XSSI prefix is removed before parse');
assert(JSON.stringify(prefixed.lastResponse).indexOf(secretName) < 0, 'prefix path does not keep the body');

const empty = MC.applyObservation(freshState(), 'meta', {
  pathname: '/reports/driver/shifts/meta',
  method: 'GET',
  status: 200,
  type: 'cors',
  ok: true,
  bodyUsed: false,
  contentType: 'application/json',
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  text: ''
});
assert(empty.issue === 'EMPTY_BODY' && empty.metaCaptured === false, 'empty body is its own issue');
assert(empty.lastResponse.textLength === 0 && empty.lastResponse.jsonParse === 'FAILED', 'empty body records text length');

const brokenSecret = 'DRIVER-SECRET-VALUE-SHOULD-NOT-APPEAR';
const broken = MC.applyObservation(freshState(), 'shifts', {
  pathname: '/reports/driver/shifts',
  method: 'GET',
  status: 200,
  type: 'basic',
  ok: true,
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  text: brokenSecret
});
assert(broken.issue === 'JSON_PARSE_FAILED' && broken.shiftsCaptured === false, 'invalid JSON does not become rows');
assert(JSON.stringify(MC.buildDiagnostic(broken)).indexOf(brokenSecret) < 0, 'invalid body text is not copied into the diagnostic');

const cloneFail = MC.applyObservation(freshState(), 'shifts', {
  pathname: '/reports/driver/shifts',
  method: 'GET',
  status: 200,
  type: 'opaque',
  ok: false,
  bodyUsed: true,
  clone: 'FAILED',
  textStatus: 'FAILED',
  text: brokenSecret,
  errorName: 'TypeError',
  errorMessage: 'Failed to execute clone: body stream is locked'
});
assert(cloneFail.issue === 'CLONE_FAILED', 'clone failure is recorded');
assert(JSON.stringify(MC.buildDiagnostic(cloneFail)).indexOf(brokenSecret) < 0, 'clone failure does not keep the unread body');
assert(cloneFail.lastResponse.type === 'opaque' && cloneFail.lastResponse.bodyUsed === true, 'opaque and bodyUsed are visible');

const kept = MC.applyObservation(parsedOk, 'shifts', {
  pathname: '/reports/driver/shifts',
  method: 'GET',
  status: 200,
  type: 'cors',
  ok: true,
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  text: ''
});
assert(kept.totalRows === 1 && kept.issue === '', 'a later empty body does not erase a captured shift response');

assert(MC.safeHeaderValue('application/json') === 'application/json', 'content type is kept');
assert(MC.safeHeaderValue('Bearer SECRET') === '', 'unsafe header text is dropped');
assert(MC.captureKind(devicesUrl, 'GET') === '', 'devices stay excluded after the reader change');

const observed = { observedPaths: [], observedPathCount: 0 };
MC.rememberObserved(observed, 'fetch', 'GET', shiftsUrl);
MC.rememberObserved(observed, 'xhr', 'POST', 'https://user:SECRET-FLEET@mis-api.edriving.com/reports/driver/shifts/meta?fpId=SECRET-FLEET#frag');
assert(observed.observedPaths.length === 2, 'observed paths are recorded');
assert(observed.observedPaths[0].pathname === '/reports/driver/shifts', 'observed pathname drops the query');
assert(observed.observedPaths[0].hostname === 'mis-api.edriving.com', 'observed hostname is kept');
assert(JSON.stringify(observed).indexOf('SECRET-FLEET') < 0, 'observed paths omit query and userinfo');
assert(observed.observedPaths[1].pathname === '/reports/driver/shifts/meta', 'meta pathname is recorded without the query');
for (var n = 0; n < 40; n += 1) MC.rememberObserved(observed, 'fetch', 'GET', 'https://vrm-mentor.edriving.com/asset/' + n + '?token=SECRET-FLEET');
assert(observed.observedPaths.length === 30, 'observed paths stop at 30');
assert(observed.observedPathCount === 42, 'observed path count includes paths beyond the cap');
assert(JSON.stringify(MC.buildDiagnostic(observed)).indexOf('SECRET-FLEET') < 0, 'diagnostic observedPaths omit secrets');

var parent = new AbortController();
var bridge = MC.detachableSignal(parent.signal);
assert(bridge.pageAborted() === 'false', 'page signal starts unaborted');
bridge.detach();
parent.abort();
assert(bridge.pageAborted() === 'true', 'page abort is still visible after detach');
assert(bridge.signal.aborted === false, 'detach stops the fetch signal from being aborted');
var parentEarly = new AbortController();
var early = MC.detachableSignal(parentEarly.signal);
parentEarly.abort();
assert(early.signal.aborted === true, 'abort before the response still cancels the fetch signal');
var abortedRead = MC.applyObservation(freshState(), 'shifts', {
  pathname: '/reports/driver/shifts',
  method: 'GET',
  status: 200,
  type: 'cors',
  ok: true,
  bodyUsed: false,
  contentType: 'application/json',
  clone: 'SUCCESS',
  textStatus: 'FAILED',
  errorName: 'AbortError',
  errorMessage: 'signal is aborted without reason',
  signalAtStart: 'false',
  signalAtResponse: 'false',
  signalAtReadFailure: 'true'
});
assert(abortedRead.issue === 'TEXT_FAILED', 'aborted body read stays a text failure');
assert(abortedRead.lastResponse.signalAtStart === 'false', 'signal state at start is kept');
assert(abortedRead.lastResponse.signalAtResponse === 'false', 'signal state at response is kept');
assert(abortedRead.lastResponse.signalAtReadFailure === 'true', 'signal state at read failure is kept');
assert(JSON.stringify(abortedRead.lastResponse).indexOf('Bearer') < 0, 'abort diagnostic has no credential text');

console.log('mentor-capture-v0 tests passed');
