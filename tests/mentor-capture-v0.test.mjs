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
assert(mentorSrc.indexOf('getRequestHeader') < 0 && mentorSrc.indexOf('getAllResponseHeaders') < 0, 'case 7: does not read headers');
assert(mentorSrc.indexOf('res.clone().json()') >= 0, 'uses a cloned response body');
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

console.log('mentor-capture-v0 tests passed');
