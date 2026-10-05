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

console.log('mentor-capture-v0 tests passed');
