import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
function read(name) { return readFileSync(join(repo, name), 'utf8'); }
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
const Core = require(join(repo, 'cortex-capture-extension/id-diag-core.js'));
assert(typeof Core.createSession === 'function', 'core loads');

const NOW = new Date('2026-10-12T02:30:00.000Z');
const FRESH = '2026-10-12T02:20:00.000Z';
const OLD = '2026-10-12T00:00:00.000Z';
const NINE = Date.UTC(2026, 9, 12, 0, 0, 0);
const ELEVEN = Date.UTC(2026, 9, 12, 2, 0, 0);
const SECRET_NAME = 'Yamada Taro SECRET';
const SECRET_MAIL = 'secret.person@example.com';
const SECRET_PHONE = '090-0000-0000';
const SECRET_RES = 'PROVIDER-RES-SECRET';
const SECRET_TOKEN = 'Bearer SECRET-TOKEN';
const ID_A = 'A12BC34DE56FG7';
const ID_B = 'B98ZY76XW54VU3';
const ID_DUP = 'C11DUP22DUP33X';
const STAFF_NUM = '445566';
const MENTOR_DRIVER = 'D77MENTOR88ID90';

function session() {
  return Core.createSession(function () { return NOW; });
}
function noSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  [SECRET_NAME, SECRET_MAIL, SECRET_PHONE, SECRET_RES, SECRET_TOKEN, ID_A, ID_B, ID_DUP, STAFF_NUM, MENTOR_DRIVER, '090-0000-0000'].forEach(function (secret) {
    assert(text.indexOf(secret) < 0, 'secret leaked: ' + secret);
  });
}
function pair(diag, left, right) {
  return (diag.pairs || []).filter(function (item) { return item.left === left && item.right === right; })[0];
}
function roster(people, capturedAt) {
  return {
    ok: true,
    capturedAt: capturedAt || FRESH,
    fromDate: '2026-10-11',
    people: people
  };
}
function person(id, reservations) {
  return { driverPersonId: id, reservations: reservations || [] };
}
function block(date, id, minutes, epoch, status) {
  return {
    date: date,
    daPersonId: id,
    startTimeInMinutes: minutes,
    startTimeInEpoch: epoch,
    status: status || 'ASSIGNED'
  };
}
function mentor(rows, capturedAt) {
  return { ok: true, capturedAt: capturedAt || FRESH, rows: rows };
}

const exact = session();
exact.ingestScheduling(roster([
  person(ID_A, [block('2026-10-12', ID_A, 540, NINE, 'ASSIGNED')])
]));
const exactDiag = exact.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_A, active: true }
]));
assert(exactDiag.identityProven === false, 'exact string match is not identity');
assert(exactDiag.crossStatus === 'ready', 'both sides ready');
const exactPair = pair(exactDiag, 'driverPersonId', 'realStaffNumber');
assert(exactPair.exactValueCount === 1 && exactPair.uniquePeople === 1, 'exact unique string match');
assert(exactPair.formatAligned === true, 'same id shape can be aligned without proving identity');
assert(exactDiag.stringCoverageComplete === true, 'full unique string cover is only a coverage flag');
assert(exactPair.identityProven === false, 'pair itself is not identity proof');
noSecrets(exactDiag);
noSecrets(Core.copyPayload(exactDiag, '2026-10-12'));
assert(Core.copyPayload(exactDiag, '2026-10-12').indexOf('未起動候補') < 0, 'copy does not list unstarted candidates');
assert(Core.copyPayload(exactDiag, '2026-10-12').indexOf('未起動判定: しない') > 0, 'copy says absence is not judged');

const formatMismatch = session();
formatMismatch.ingestScheduling(roster([person(ID_A, [block('2026-10-12', ID_A, 540, NINE)])]));
const mismatchDiag = formatMismatch.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: STAFF_NUM, active: true }
]));
const mismatchPair = pair(mismatchDiag, 'driverPersonId', 'realStaffNumber');
assert(mismatchPair.exactValueCount === 0, 'different id text does not match');
assert(mismatchPair.formatAligned === false, 'letter-then-alnum and digits differ');
assert(mismatchDiag.stringCoverageComplete === false, 'format mismatch does not prove coverage');
assert(mismatchDiag.identityProven === false, 'format mismatch is not identity');
noSecrets(mismatchDiag);

const duplicate = session();
duplicate.ingestScheduling(roster([
  person(ID_DUP, [block('2026-10-12', ID_DUP, 540, NINE)]),
  person(ID_DUP, [block('2026-10-12', ID_DUP, 660, ELEVEN)])
]));
const duplicateDiag = duplicate.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_DUP, active: true }
]));
const duplicatePair = pair(duplicateDiag, 'driverPersonId', 'realStaffNumber');
assert(duplicatePair.exactValueCount === 1, 'duplicate value still intersects once');
assert(duplicatePair.uniquePeople === 0 && duplicatePair.ambiguous === 2, 'repeated ids are ambiguous');
assert(duplicateDiag.scheduling.driverPersonId.duplicateValues === 1, 'duplicate value counted');
assert(duplicateDiag.stringCoverageComplete === false, 'ambiguous ids do not prove coverage');

const missing = session();
missing.ingestScheduling(roster([
  person('', [block('2026-10-12', '', 540, NINE)]),
  person(ID_B, [block('2026-10-12', ID_B, 540, NINE)])
]));
const missingDiag = missing.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_B, active: false }
]));
const missingPair = pair(missingDiag, 'driverPersonId', 'realStaffNumber');
assert(missingPair.missing === 1 && missingPair.uniquePeople === 1, 'blank id is missing and the other can still match');
assert(missingDiag.mentor.activeRows === 0, 'inactive row is not active');
assert(missingDiag.stringCoverageComplete === false, 'a missing id means coverage is not complete');
assert(JSON.stringify(missingDiag).indexOf('未起動候補') < 0, 'inactive is not labeled unstarted');

const scheduleBody = {
  data: [
    {
      driverPersonId: ID_A,
      associateName: SECRET_NAME,
      email: SECRET_MAIL,
      phone: SECRET_PHONE,
      reservationsMap: {
        '2026-10-12': [
          {
            daPersonId: ID_A,
            startTimeInMinutes: 540,
            startTimeInEpoch: NINE,
            durationInMinutes: 120,
            status: 'ASSIGNED',
            serviceAreaId: 'area-secret',
            providerReservationId: SECRET_RES
          },
          {
            daPersonId: ID_A,
            startTimeInMinutes: 660,
            startTimeInEpoch: ELEVEN,
            durationInMinutes: 180,
            status: 'ASSIGNED',
            providerReservationId: SECRET_RES
          }
        ]
      },
      authorization: SECRET_TOKEN
    },
    {
      driverPersonId: ID_B,
      reservationsMap: {}
    },
    {
      driverPersonId: 'E45OTHER67KIND8',
      reservationsMap: {
        '2026-10-12': [
          {
            daPersonId: 'E45OTHER67KIND8',
            startTimeInMinutes: 600,
            startTimeInEpoch: Date.UTC(2026, 9, 12, 1, 0, 0),
            status: 'CANCELLED'
          }
        ]
      }
    }
  ]
};
const extracted = Core.extractRoster(scheduleBody, 'https://logistics.amazon.co.jp/scheduling/api/rosters?fromDate=2026-10-11&serviceAreaId=SECRET-AREA', FRESH);
assert(extracted.ok === true && extracted.people.length === 3, 'roster extract keeps people only');
assert(extracted.fromDate === '2026-10-11', 'fromDate is the only query value kept');
noSecrets(JSON.stringify(extracted).replace(new RegExp(ID_A, 'g'), '').replace(new RegExp(ID_B, 'g'), ''));
assert(JSON.stringify(extracted).indexOf(SECRET_NAME) < 0, 'name dropped');
assert(JSON.stringify(extracted).indexOf(SECRET_RES) < 0, 'reservation id dropped');
assert(JSON.stringify(extracted).indexOf('SECRET-AREA') < 0, 'service area query dropped');
assert(JSON.stringify(extracted).indexOf(SECRET_TOKEN) < 0, 'token dropped');
function nameField(list, field) {
  return (list || []).filter(function (item) { return item.field === field; })[0];
}
assert(nameField(extracted.nameFields, 'associateName').present === 1 && nameField(extracted.nameFields, 'associateName').missing === 2, 'associateName is counted without its text');
assert(nameField(extracted.nameFields, 'schedulingName').present === 0 && nameField(extracted.nameFields, 'firstName').present === 0 && nameField(extracted.nameFields, 'lastName').present === 0 && nameField(extracted.nameFields, 'displayName').present === 0, 'absent name fields stay visible as missing');
assert(JSON.stringify(extracted.nameFields).indexOf('email') < 0 && JSON.stringify(extracted.nameFields).indexOf('phone') < 0, 'contact fields are not listed as names');
const namedBody = JSON.parse(JSON.stringify(scheduleBody));
namedBody.data[0].driverName = SECRET_NAME;
namedBody.data[0].firstName = { given: SECRET_NAME };
namedBody.data[1].associateName = '   ';
namedBody.data.push(null);
const namedExtracted = Core.extractRoster(namedBody, 'https://logistics.amazon.co.jp/scheduling/api/rosters?fromDate=2026-10-11', FRESH);
assert(nameField(namedExtracted.nameFields, 'driverName').present === 1 && nameField(namedExtracted.nameFields, 'driverName').missing === 3, 'driverName on the same record is counted');
assert(nameField(namedExtracted.nameFields, 'firstName').present === 1, 'a non-empty name object counts as present');
assert(nameField(namedExtracted.nameFields, 'associateName').present === 1 && nameField(namedExtracted.nameFields, 'associateName').missing === 3, 'blank text and a non-object row count as missing');
assert(namedExtracted.people[0].driverName === SECRET_NAME && !namedExtracted.people[0].associateName, 'driverName stays on the roster record and associateName is not copied');
assert(JSON.stringify(namedExtracted.nameFields).indexOf(SECRET_NAME) < 0 && JSON.stringify(namedExtracted).indexOf(SECRET_MAIL) < 0 && JSON.stringify(namedExtracted).indexOf(SECRET_PHONE) < 0, 'counts omit name text, and mail and phone stay out');
const namedSession = session();
const namedDiag = namedSession.ingestScheduling(namedExtracted);
const namedLines = Core.panelLines(namedDiag, '2026-10-12').join('\n');
assert(namedLines.indexOf('associateName: あり1 / 欠損3') >= 0 && namedLines.indexOf('driverName: あり1 / 欠損3') >= 0, 'the diagnostic lists field names and counts');
assert(namedLines.indexOf(SECRET_NAME) < 0 && namedLines.indexOf(SECRET_MAIL) < 0 && namedLines.indexOf(ID_A) < 0, 'the diagnostic text has no name or raw id');
assert(namedDiag.identityProven === false, 'seeing a name field does not prove identity');
const namedCopy = Core.copyPayload(namedDiag, '2026-10-12');
assert(namedCopy.indexOf(SECRET_NAME) < 0 && namedCopy.indexOf('あり1 / 欠損3') >= 0, 'the copied diagnostic keeps counts and drops name text');

const scheduleSession = session();
const scheduleDiag = scheduleSession.ingestScheduling(extracted);
const day = scheduleDiag.scheduling.schedule.byDate['2026-10-12'];
assert(scheduleDiag.scheduling.peopleCount === 3, 'people count is people');
assert(day.peopleWithReservation === 2 && day.peopleWithoutReservation === 1, 'reservation presence is counted in people');
assert(day.reservationCount === 3 && day.assignedReservations === 2, 'reservation counts are not people counts');
assert(day.multiBlockPeople === 1, 'two blocks on one person');
assert(day.otherStatusCounts.CANCELLED === 1, 'non ASSIGNED status counted');
assert(day.startHourCounts['09'] === 1 && day.startHourCounts['11'] === 1, 'start hours come from minutes');
assert(day.clock.minuteMatch === 3 && day.clock.minuteMismatch === 0, 'epoch matches Tokyo minutes');
assert(day.clock.dateMatch === 3, 'epoch date matches the reservation date in Tokyo');
assert(scheduleDiag.scheduling.personDa.same === 2, 'same driverPersonId and daPersonId');
assert(scheduleDiag.scheduling.personDa.noReservation === 1, 'person without reservations');
const badClock = Core.extractRoster({
  data: [{
    driverPersonId: ID_A,
    reservationsMap: {
      '2026-10-12': [{ daPersonId: ID_A, startTimeInMinutes: 540, startTimeInEpoch: ELEVEN, status: 'ASSIGNED' }]
    }
  }]
}, 'https://logistics.amazon.co.jp/rosters?fromDate=2026-10-12', FRESH);
const badDay = session().ingestScheduling(badClock).scheduling.schedule.byDate['2026-10-12'];
assert(badDay.clock.minuteMismatch === 1, '540 minutes does not match an 11:00 epoch');

const mentorOnly = session();
const mentorOnlyDiag = mentorOnly.ingestMentor(mentor([{ driverId: ID_A, realStaffNumber: ID_A, active: true }]));
assert(mentorOnlyDiag.crossStatus === 'scheduling-missing' && mentorOnlyDiag.pairs == null, 'mentor first is incomplete, not zero matches');
const mentorThenScheduling = mentorOnly.ingestScheduling(roster([person(ID_A, [block('2026-10-12', ID_A, 540, NINE)])]));
assert(mentorThenScheduling.crossStatus === 'ready' && pair(mentorThenScheduling, 'driverPersonId', 'realStaffNumber').uniquePeople === 1, 'scheduling arriving second completes the compare');

const schedulingOnly = session();
const schedulingOnlyDiag = schedulingOnly.ingestScheduling(roster([person(ID_A, [])]));
assert(schedulingOnlyDiag.crossStatus === 'mentor-missing' && schedulingOnlyDiag.pairs == null, 'scheduling first is incomplete');
const schedulingThenMentor = schedulingOnly.ingestMentor(mentor([{ driverId: ID_B, realStaffNumber: ID_A, active: true }]));
assert(schedulingThenMentor.crossStatus === 'ready', 'mentor arriving second completes the compare');
assert(pair(schedulingThenMentor, 'driverPersonId', 'driverId').exactValueCount === 0, 'different fields do not match just because both exist');

const failed = session();
failed.ingestMentor(mentor([{ driverId: ID_A, realStaffNumber: ID_A, active: true }]));
const failedDiag = failed.ingestScheduling({ ok: false, issue: 'JSON_PARSE_FAILED', capturedAt: FRESH });
assert(failedDiag.crossStatus === 'failed' && failedDiag.pairs == null, 'capture failure is not a zero match');
assert(failedDiag.scheduling.state === 'failed', 'failed side stays visible');

const stale = session();
stale.ingestScheduling(roster([person(ID_A, [block('2026-10-12', ID_A, 540, NINE)])], OLD));
const staleDiag = stale.ingestMentor(mentor([{ driverId: ID_B, realStaffNumber: ID_A, active: true }], OLD));
assert(staleDiag.stale === true, 'old capture is flagged');
assert(staleDiag.pairs && staleDiag.stringCoverageComplete === false, 'stale data does not prove coverage');
assert(staleDiag.absenceSafe === false, 'stale data is not safe to call absent');

assert(Core.isRosterRequest('https://logistics.amazon.co.jp/scheduling/api/rosters?fromDate=2026-10-11&serviceAreaId=SECRET', 'GET') === true, 'rosters GET on the scheduling host matches');
assert(Core.isRosterRequest('https://logistics.amazon.co.jp/scheduling/api/rosters/', 'GET') === true, 'trailing slash still matches');
assert(Core.isRosterRequest('https://logistics.amazon.co.jp/scheduling/api/rosters/extra', 'GET') === false, 'longer path does not match');
assert(Core.isRosterRequest('https://logistics.amazon.co.jp/operations/execution/api/route-summaries', 'GET') === false, 'cortex path does not match');
assert(Core.isRosterRequest('https://vrm-mentor.edriving.com/reports/driver/shifts', 'GET') === false, 'mentor path does not match');
assert(Core.isRosterRequest('https://logistics.amazon.co.jp/scheduling/api/rosters', 'POST') === false, 'POST is ignored');
assert(Core.isRosterRequest('https://example.test/rosters', 'GET') === false, 'other host is ignored');
assert(Core.foreignRosterHost('https://example.test/rosters', 'GET') === 'example.test', 'other host is reported without the query');

const posted = [];
const responseBody = JSON.stringify(scheduleBody);
const response = {
  status: 200,
  ok: true,
  url: 'https://logistics.amazon.co.jp/scheduling/api/rosters?fromDate=2026-10-11&serviceAreaId=SECRET-AREA',
  clone: function () {
    return { text: function () { return Promise.resolve(responseBody); } };
  }
};
let fetchCalls = 0;
const sandbox = {
  URL: URL,
  Promise: Promise,
  location: {
    hostname: 'logistics.amazon.co.jp',
    pathname: '/scheduling/calendar-view/week',
    origin: 'https://logistics.amazon.co.jp'
  },
  postMessage: function (data) { posted.push(JSON.parse(JSON.stringify(data))); },
  addEventListener: function () {},
  fetch: function () {
    fetchCalls += 1;
    return Promise.resolve(response);
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('cortex-capture-extension/id-diag-core.js'), sandbox, { filename: 'id-diag-core.js' });
vm.runInContext(read('cortex-capture-extension/scheduling-capture.js'), sandbox, { filename: 'scheduling-capture.js' });
const returned = sandbox.fetch('https://logistics.amazon.co.jp/scheduling/api/rosters?fromDate=2026-10-11&serviceAreaId=SECRET-AREA');
const same = await returned;
assert(same === response, 'page receives the original response');
assert(fetchCalls === 1, 'roster observation does not send a second request');
await Promise.resolve();
await Promise.resolve();
assert(posted.length === 1 && posted[0].type === 'scheduling-ids', 'roster observation publishes one digest');
noSecrets(JSON.stringify(posted[0]).replace(new RegExp(ID_A, 'g'), '').replace(new RegExp(ID_B, 'g'), '').replace(/E45OTHER67KIND8/g, ''));
assert(JSON.stringify(posted[0]).indexOf(SECRET_NAME) < 0, 'hook drops names');
const ignored = sandbox.fetch('https://logistics.amazon.co.jp/operations/execution/api/route-summaries?localDate=2026-10-12');
assert(await ignored === response, 'non-roster fetch still returns the page response');
await Promise.resolve();
assert(posted.length === 1, 'cortex responses are not diagnosed as rosters');
const foreign = sandbox.fetch('https://example.test/scheduling/rosters?access_token=SECRET-TOKEN');
assert(await foreign === response, 'a foreign roster request is not replaced');
await Promise.resolve();
assert(posted.length === 2 && posted[1].digest.ok === true, 'a later foreign host does not erase a captured roster');
assert(posted[1].digest.meta.otherHosts[0] === 'example.test', 'only the hostname is kept');
assert(JSON.stringify(posted[1]).indexOf('SECRET-TOKEN') < 0, 'foreign roster query is not kept');

const foreignOnly = [];
const foreignSandbox = {
  URL: URL,
  Promise: Promise,
  location: sandbox.location,
  postMessage: function (data) { foreignOnly.push(JSON.parse(JSON.stringify(data))); },
  addEventListener: function () {},
  fetch: function () { return Promise.resolve(response); }
};
foreignSandbox.window = foreignSandbox;
foreignSandbox.globalThis = foreignSandbox;
vm.createContext(foreignSandbox);
vm.runInContext(read('cortex-capture-extension/id-diag-core.js'), foreignSandbox, { filename: 'id-diag-core.js' });
vm.runInContext(read('cortex-capture-extension/scheduling-capture.js'), foreignSandbox, { filename: 'scheduling-capture.js' });
await foreignSandbox.fetch('https://example.test/scheduling/rosters?access_token=SECRET-TOKEN');
await Promise.resolve();
assert(foreignOnly.length === 1 && foreignOnly[0].digest.issue === 'OTHER_HOST', 'a roster on another host is not treated as captured');
assert(JSON.stringify(foreignOnly[0]).indexOf('SECRET-TOKEN') < 0, 'foreign query is dropped');

const mentorPosts = [];
const mentorSandbox = {
  URL: URL,
  Promise: Promise,
  location: { hostname: 'vrm-mentor.edriving.com', origin: 'https://vrm-mentor.edriving.com', pathname: '/#/trip-session-report' },
  postMessage: function (data) { mentorPosts.push(JSON.parse(JSON.stringify(data))); },
  addEventListener: function () {},
  document: { documentElement: null, addEventListener: function () {}, getElementById: function () { return null; } },
  setTimeout: function () {}
};
mentorSandbox.window = mentorSandbox;
mentorSandbox.globalThis = mentorSandbox;
vm.createContext(mentorSandbox);
vm.runInContext(read('cortex-capture-extension/id-diag-core.js'), mentorSandbox, { filename: 'id-diag-core.js' });
vm.runInContext(read('cortex-capture-extension/mentor-capture.js'), mentorSandbox, { filename: 'mentor-capture.js' });
mentorSandbox.OFK3MentorCapture.applyObservation({
  metaCaptured: false,
  shiftsCaptured: false,
  lastResponse: null
}, 'shifts', {
  clone: 'SUCCESS',
  textStatus: 'SUCCESS',
  status: 200,
  text: JSON.stringify({
    data: [{
      driverId: MENTOR_DRIVER,
      realStaffNumber: ID_A,
      firstName: SECRET_NAME,
      lastName: 'Secret',
      shiftEndTime: 'N/A',
      vrmStatus: 'Active',
      authorization: SECRET_TOKEN
    }]
  })
});
assert(mentorPosts.length === 1 && mentorPosts[0].type === 'mentor-ids', 'mentor capture publishes ids for the local compare');
assert(mentorPosts[0].digest.rows[0].realStaffNumber === ID_A, 'staff number stays in memory for the compare');
assert(mentorPosts[0].digest.rows[0].firstName === SECRET_NAME, 'mentor names stay in the in-memory digest');
const mentorHeld = Core.createSession(function () { return NOW; });
const mentorHeldDiag = mentorHeld.ingestMentor(mentorPosts[0].digest);
assert(Core.copyPayload(mentorHeldDiag).indexOf(SECRET_NAME) < 0 && Core.panelLines(mentorHeldDiag).join('\n').indexOf(SECRET_NAME) < 0, 'diagnostic copy and panel drop mentor names');
assert(JSON.stringify(mentorPosts[0]).indexOf(SECRET_TOKEN) < 0, 'mentor publish drops tokens');
const activeSnap = mentorSandbox.OFK3MentorCapture.buildActiveSnapshot({
  data: [{ driverId: MENTOR_DRIVER, realStaffNumber: ID_A, shiftEndTime: 'N/A', vrmStatus: 'Active', firstName: 'Keep' }]
}, FRESH);
assert(activeSnap.activeCount === 1, 'active rule still keeps N/A Active rows');

const phase1 = read('cortex-capture-extension/phase1-core.js');
const cortexFn = phase1.slice(phase1.indexOf('function isCortexApiCaptureUrl'), phase1.indexOf('function routeIdFromDetailsUrl'));
assert(cortexFn.indexOf('route-summaries') > 0 && cortexFn.indexOf('route-details') > 0 && cortexFn.indexOf('trDetails') > 0, 'cortex paths remain');
assert(cortexFn.indexOf('rosters') < 0, 'cortex filter does not gain rosters');
const background = read('cortex-capture-extension/background.js');
const handler = background.slice(background.indexOf('function handleIdDiag'), background.indexOf('function resolveOfk3BaseUrl'));
assert(handler.indexOf('fetch(') < 0 && handler.indexOf('mentor-active') < 0 && handler.indexOf('chrome.storage') < 0, 'id diagnostic does not send or store');
assert(background.indexOf('/mentor-active/import') > 0, 'existing mentor send path remains');
const manifest = JSON.parse(read('cortex-capture-extension/manifest.json'));
const scriptLists = manifest.content_scripts.map(function (item) { return item.js.join(','); });
assert(scriptLists.indexOf('id-diag-core.js,scheduling-capture.js') >= 0, 'scheduling hook is registered');
assert(scriptLists.indexOf('phase1-core.js,phase1-runner.js') >= 0, 'cortex hook remains');
assert(manifest.content_scripts.some(function (item) {
  return item.js.indexOf('mentor-capture.js') >= 0 && item.matches[0] === 'https://vrm-mentor.edriving.com/*';
}), 'mentor capture remains on mentor');
assert(manifest.content_scripts.some(function (item) {
  return item.world === 'MAIN' && item.js.indexOf('master-capture.js') >= 0 && item.matches.indexOf('https://ofk3-line-proxy-1.onrender.com/index.html') >= 0;
}), 'delivery page reader is registered');
assert(manifest.content_scripts.some(function (item) {
  return item.world === 'ISOLATED' && item.js.indexOf('master-bridge.js') >= 0;
}), 'delivery page bridge is registered');
const masterCapture = read('cortex-capture-extension/master-capture.js');
const masterBridge = read('cortex-capture-extension/master-bridge.js');
assert(masterCapture.indexOf('fetch(') < 0 && masterCapture.indexOf('XMLHttpRequest') < 0 && masterCapture.indexOf('localStorage') < 0, 'delivery page signal does not read storage or call the network');
assert(masterBridge.indexOf('fetch(') < 0 && masterBridge.indexOf('XMLHttpRequest') < 0, 'delivery page bridge does not call the network');
assert(masterBridge.indexOf('lineMapping') < 0 && masterBridge.indexOf('phoneMapping') < 0, 'bridge does not read line or phone maps');
assert(handler.indexOf('ingestMaster') > 0, 'background accepts the local master digest');

['id-diag-core.js', 'scheduling-capture.js', 'scheduling-bridge.js', 'mentor-diag-bridge.js', 'id-diag-panel.js', 'master-capture.js', 'master-bridge.js'].forEach(function (name) {
  const source = read('cortex-capture-extension/' + name);
  assert(source.indexOf('console.log') < 0, name + ' does not log');
  assert(source.indexOf('chrome.storage') < 0, name + ' does not use storage');
  assert(source.indexOf('/mentor-active/import') < 0, name + ' does not post the mentor snapshot');
});

const capture = read('cortex-capture-extension/mentor-capture.js');
const diagAt = capture.indexOf("diag.id = 'ofk3-id-diag'");
const copyAt = capture.indexOf('診断JSONコピー');
assert(diagAt > 0 && copyAt > diagAt, 'ID diagnostic is created with the mentor panel, above the existing buttons');
const panelSrc = read('cortex-capture-extension/id-diag-panel.js');
assert(panelSrc.indexOf('tries > 40') < 0, 'diagnostic mount does not give up after a short wait');
assert(panelSrc.indexOf('本人対応を確認する') > 0 && panelSrc.indexOf('本人対応確認を閉じる') > 0 && panelSrc.indexOf('ofk3-id-confirm') > 0, 'confirmation opens from a labeled button');
assert(panelSrc.indexOf('点呼要確認一覧') > 0 && panelSrc.indexOf('点呼要確認一覧を閉じる') > 0 && panelSrc.indexOf('ofk3-rollcall') > 0, 'roll call list opens from a labeled button');
assert(panelSrc.indexOf('（待機中）') > 0 && panelSrc.indexOf('本人照合に課題あり') > 0 && panelSrc.indexOf('要確認人数') > 0, 'the list separates waiting rows from the attention count');
assert(panelSrc.indexOf('rollBody.textContent = \'\'') > 0, 'closing the roll call list removes names');
assert(panelSrc.indexOf('id-diag-rollcall') > 0 && panelSrc.indexOf('fetch(') < 0, 'roll call reads the in-memory session only');
assert(panelSrc.indexOf('.open = true') < 0 && panelSrc.indexOf('open="open"') < 0, 'confirmation panel starts closed');
assert(panelSrc.indexOf('copyPayload(latest') > 0 && panelSrc.indexOf('latest = data.confirmation') < 0, 'copy uses the redacted diagnostic only');
assert(panelSrc.indexOf('confirmBody.textContent = \'\'') > 0, 'closing the panel removes names from the page');

function tokyoClock(day, hour, minute) {
  return new Date(Date.UTC(2026, 9, day, hour - 9, minute, 0));
}
function dayBlock(diag, date) {
  return diag.scheduling.schedule.byDate[date].assignedActive;
}
function freshSession(now) {
  const iso = now.toISOString();
  return { now: now, iso: iso, session: Core.createSession(function () { return now; }) };
}

const matchNow = tokyoClock(12, 11, 4);
const matchFresh = freshSession(matchNow);
matchFresh.session.ingestScheduling(roster([
  person(ID_A, [
    block('2026-10-12', ID_A, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0)),
    block('2026-10-12', ID_A, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))
  ]),
  person(ID_B, [block('2026-10-12', ID_B, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0), 'CANCELLED')]),
  person('', [block('2026-10-12', '', 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))])
], matchFresh.iso));
const matchDiag = matchFresh.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_A, active: true },
  { driverId: ID_B, realStaffNumber: ID_A, active: false }
], matchFresh.iso));
const matchDay = dayBlock(matchDiag, '2026-10-12');
assert(matchDay.assignedPeople === 2 && matchDay.assignedBlocks === 3, 'only ASSIGNED people and blocks are counted');
assert(matchDay.multiBlockPeople === 1, 'two blocks stay one person');
assert(matchDay.before === 0 && matchDay.within5 === 2 && matchDay.after5 === 1, '09:00 is past five minutes and 11:00 is inside five minutes at 11:04');
assert(matchDay.uniqueStringMatch === 1 && matchDay.notInActive === 0 && matchDay.unmatchable === 1, 'one unique active string match and one blank id');
assert(matchDay.uniqueStringMatch + matchDay.notInActive + matchDay.unmatchable === matchDay.assignedPeople, 'person counts partition the ASSIGNED cohort');
assert(matchDay.identityProven === false && matchDay.absenceIsUnstarted === false, 'string match is not identity and absence is not unstarted');
const matchCopy = Core.copyPayload(matchDiag, '2026-10-12');
noSecrets(matchCopy);
assert(matchCopy.indexOf('本人確定ではない') > 0 && matchCopy.indexOf('未起動ではない') > 0, 'labels stay short of identity and unstarted');
assert(matchCopy.indexOf('未起動候補') < 0, 'no unstarted candidate list');

const missNow = freshSession(tokyoClock(12, 11, 5));
missNow.session.ingestScheduling(roster([
  person(ID_A, [block('2026-10-12', ID_A, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))])
], missNow.iso));
const missDiag = missNow.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: STAFF_NUM, active: true }
], missNow.iso));
const missDay = dayBlock(missDiag, '2026-10-12');
assert(missDay.after5 === 1 && missDay.uniqueStringMatch === 0 && missDay.notInActive === 1, 'a different staff string is not an active match');

const dupNow = freshSession(tokyoClock(12, 10, 59));
dupNow.session.ingestScheduling(roster([
  person(ID_DUP, [block('2026-10-12', ID_DUP, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))]),
  person(ID_DUP, [block('2026-10-12', ID_DUP, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))])
], dupNow.iso));
const dupDiag = dupNow.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_DUP, active: true }
], dupNow.iso));
const dupDay = dayBlock(dupDiag, '2026-10-12');
assert(dupDay.before === 2 && dupDay.uniqueStringMatch === 0 && dupDay.unmatchable === 2 && dupDay.notInActive === 0, 'duplicate ids are unmatchable and 10:59 is before 11:00');

const activeDup = freshSession(tokyoClock(12, 11, 0));
activeDup.session.ingestScheduling(roster([
  person(ID_A, [block('2026-10-12', ID_A, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))])
], activeDup.iso));
const activeDupDiag = activeDup.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_A, active: true },
  { driverId: ID_B, realStaffNumber: ID_A, active: true }
], activeDup.iso));
const activeDupDay = dayBlock(activeDupDiag, '2026-10-12');
assert(activeDupDay.within5 === 1 && activeDupDay.unmatchable === 1 && activeDupDay.uniqueStringMatch === 0, 'duplicate active staff numbers are not a unique match');

const edgeNow = freshSession(new Date('2026-10-12T15:02:00.000Z'));
edgeNow.session.ingestScheduling(roster([
  person(ID_A, [block('2026-10-12', ID_A, 23 * 60 + 50, Date.UTC(2026, 9, 12, 14, 50, 0))]),
  person(ID_B, [block('2026-10-13', ID_B, 10, Date.UTC(2026, 9, 12, 15, 10, 0))])
], edgeNow.iso));
const edgeDiag = edgeNow.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_A, active: true },
  { driverId: ID_B, realStaffNumber: ID_B, active: true }
], edgeNow.iso));
const late = dayBlock(edgeDiag, '2026-10-12');
const next = dayBlock(edgeDiag, '2026-10-13');
assert(late.assignedPeople === 1 && late.after5 === 1 && late.uniqueStringMatch === 1, '23:50 stays on the 12th and is twelve minutes after start');
assert(next.assignedPeople === 1 && next.before === 1 && next.uniqueStringMatch === 1, '00:10 on the 13th is still before start at 00:02');
assert(late.assignedBlocks === 1 && next.assignedBlocks === 1, 'date boundary does not move a block to the other day');

const missingMentor = Core.createSession(function () { return matchNow; });
const missingMentorDiag = missingMentor.ingestScheduling(roster([
  person(ID_A, [block('2026-10-12', ID_A, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))])
], matchFresh.iso));
const missingDay = dayBlock(missingMentorDiag, '2026-10-12');
assert(missingDay.comparable === false && missingDay.reason === 'mentor-missing', 'missing mentor data does not become a zero match');
assert(missingDay.uniqueStringMatch == null && missingDay.notInActive == null, 'incomplete compare has no active counts');
assert(Core.copyPayload(missingMentorDiag, '2026-10-12').indexOf('片方未取得') > 0, 'panel says the compare is incomplete');

const staleNow = freshSession(tokyoClock(12, 12, 0));
const oldCapture = staleNow.session.ingestScheduling(roster([
  person(ID_A, [block('2026-10-12', ID_A, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))])
], '2026-10-12T00:00:00.000Z'));
staleNow.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_A, active: true }
], '2026-10-12T00:00:00.000Z'));
const oldDay = dayBlock(staleNow.session.read('2026-10-12'), '2026-10-12');
assert(oldCapture.stale === true && oldDay.comparable === false && oldDay.reason === 'stale', 'stale captures are not used as a current active compare');
assert(oldDay.mismatchHasAfter5 == null, 'stale captures do not classify active mismatches');
assert(Core.panelLines(staleNow.session.read('2026-10-12'), '2026-10-12').join('\n').indexOf('取得が古い') > 0, 'panel shows the stale capture');

const splitIds = {
  before: 'B12BEFORE34ONLY',
  within: 'W12WITHIN56ONLY',
  afterHist: 'H12AFTER89HIST1',
  afterNone: 'N12AFTER90NONE2',
  unknown: 'U12UNKNOWN12TIME'
};
const splitNow = freshSession(tokyoClock(12, 11, 4));
splitNow.session.ingestScheduling(roster([
  person(ID_A, [block('2026-10-12', ID_A, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))]),
  person(splitIds.before, [block('2026-10-12', splitIds.before, 12 * 60, Date.UTC(2026, 9, 12, 3, 0, 0))]),
  person(splitIds.within, [block('2026-10-12', splitIds.within, 11 * 60 + 2, Date.UTC(2026, 9, 12, 2, 2, 0))]),
  person(splitIds.afterHist, [block('2026-10-12', splitIds.afterHist, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(splitIds.afterNone, [
    block('2026-10-12', splitIds.afterNone, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0)),
    block('2026-10-12', splitIds.afterNone, 12 * 60, Date.UTC(2026, 9, 12, 3, 0, 0))
  ]),
  person(splitIds.unknown, [block('2026-10-12', splitIds.unknown, null, null)]),
  person(ID_DUP, [block('2026-10-12', ID_DUP, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))]),
  person(ID_DUP, [block('2026-10-12', ID_DUP, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))])
], splitNow.iso));
const splitDiag = splitNow.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: ID_A, active: true },
  { driverId: ID_B, realStaffNumber: splitIds.afterHist, active: false }
], splitNow.iso));
const splitDay = dayBlock(splitDiag, '2026-10-12');
assert(splitDay.uniqueStringMatch === 1, 'the active string match stays out of the mismatch split');
assert(splitDay.mismatchBeforeOnly === 1, 'a later block is before start');
assert(splitDay.mismatchWithin5Only === 1, 'two minutes after start stays inside five minutes');
assert(splitDay.mismatchHasAfter5 === 2, 'one past block is enough, including a person who also has a future block');
assert(splitDay.mismatchUnknownTime === 1, 'a missing start stays unknown');
assert(splitDay.mismatchConfirmUnavailable === 2, 'duplicate ids are not placed in a time class');
assert(splitDay.assignedBlocks === 9 && splitDay.assignedPeople === 8, 'two blocks on one person count once as a person');
assert(splitDay.after5InAllRows === 1 && splitDay.after5AbsentFromAllRows === 1, 'past mismatches are split by presence in all mentor rows');
assert(splitDay.mismatchBeforeOnly + splitDay.mismatchWithin5Only + splitDay.mismatchHasAfter5 + splitDay.mismatchUnknownTime + splitDay.mismatchConfirmUnavailable === splitDay.notInActive, 'mismatch classes cover the active mismatches');
const splitCopy = Core.copyPayload(splitDiag, '2026-10-12');
Object.keys(splitIds).forEach(function (key) {
  assert(splitCopy.indexOf(splitIds[key]) < 0, 'mismatch split does not copy an id');
});
assert(splitCopy.indexOf('未起動候補') < 0 && splitCopy.indexOf('本人確定ではない') > 0, 'the split does not declare anyone unstarted or identified');

const edgeMiss = freshSession(new Date('2026-10-12T15:02:00.000Z'));
const lateId = 'E12EDGE98LATE01';
const earlyId = 'E13EDGE98EARLY2';
edgeMiss.session.ingestScheduling(roster([
  person(lateId, [block('2026-10-12', lateId, 23 * 60 + 50, Date.UTC(2026, 9, 12, 14, 50, 0))]),
  person(earlyId, [block('2026-10-13', earlyId, 10, Date.UTC(2026, 9, 12, 15, 10, 0))])
], edgeMiss.iso));
const edgeMissDiag = edgeMiss.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: STAFF_NUM, active: true }
], edgeMiss.iso));
assert(dayBlock(edgeMissDiag, '2026-10-12').mismatchHasAfter5 === 1 && dayBlock(edgeMissDiag, '2026-10-12').mismatchBeforeOnly === 0, '23:50 is past five minutes on the 12th at 00:02');
assert(dayBlock(edgeMissDiag, '2026-10-13').mismatchBeforeOnly === 1 && dayBlock(edgeMissDiag, '2026-10-13').mismatchHasAfter5 === 0, '00:10 on the 13th is still before start');
assert(Core.copyPayload(edgeMissDiag, '2026-10-12').indexOf(lateId) < 0, 'date boundary copy has no id');

const MASTER_NAME = '秘密 氏名マスター';
const MASTER_JP = 'にほんご表示名';
const masterIds = {
  match: 'M12MATCH45NAME01',
  nodept: 'M12NODEP45NAME02',
  ofk6: 'M12OFK645NAME003',
  dup: 'M12DUPID45NAME04',
  none: 'M12NONE45NAME005',
  multi: 'M12MULTI45NAME06',
  active: 'M12ACTIV45NAME07',
  hyphen: 'M12HYPHEN45NAME'
};
function masterEntry(name, id, department) {
  return { name: name, japaneseName: MASTER_JP, transportId: id, department: department || '' };
}
const masterNow = freshSession(tokyoClock(12, 11, 4));
masterNow.session.ingestScheduling(roster([
  person(masterIds.match, [block('2026-10-12', masterIds.match, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(masterIds.nodept, [block('2026-10-12', masterIds.nodept, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(masterIds.ofk6, [block('2026-10-12', masterIds.ofk6, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(masterIds.dup, [block('2026-10-12', masterIds.dup, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(masterIds.none, [block('2026-10-12', masterIds.none, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person('', [block('2026-10-12', '', 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(masterIds.multi, [
    block('2026-10-12', masterIds.multi, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0)),
    block('2026-10-12', masterIds.multi, 12 * 60, Date.UTC(2026, 9, 12, 3, 0, 0))
  ]),
  person(masterIds.active, [block('2026-10-12', masterIds.active, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(masterIds.hyphen, [block('2026-10-12', masterIds.hyphen, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))])
], masterNow.iso));
masterNow.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: masterIds.active, active: true }
], masterNow.iso));
const waiting = masterNow.session.ingestMaster({ phase: 'loading' });
assert(waiting.master.state === 'loading', 'a master reload clears the previous snapshot');
assert(waiting.scheduling.schedule.byDate['2026-10-12'].masterJoin.comparable === false, 'loading master is not a confirmed compare');
assert(waiting.scheduling.schedule.byDate['2026-10-12'].masterJoin.after5NameCandidate == null, 'loading master does not produce a name count');
const waitingText = Core.panelLines(waiting, '2026-10-12').join('\n');
assert(waitingText.indexOf('読み込み待ち') > 0 && waitingText.indexOf('マスタ登録人数') < 0, 'empty data before load completion is not shown as a count');
const masterDiag = masterNow.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: Date.parse(masterNow.iso),
  entries: [
    masterEntry(MASTER_NAME, masterIds.match, 'GDSダイレクト'),
    masterEntry('所属なし氏名', masterIds.nodept, ''),
    masterEntry('OFK6氏名', 'Ｍ１２ＯＦＫ６４５ＮＡＭＥ００３', 'OFK6'),
    masterEntry('重複一名', masterIds.dup, 'GDSパート'),
    masterEntry('重複二名', masterIds.dup, 'JHS'),
    masterEntry('複数ブロック氏名', masterIds.multi, 'GDSパート'),
    masterEntry('起動中氏名', masterIds.active, 'GDS管理'),
    masterEntry('ハイフン氏名', 'M12-HYPHEN45NAME', 'GDSダイレクト'),
    masterEntry('空ID氏名', '', 'GDSダイレクト')
  ]
});
const masterActive = dayBlock(masterDiag, '2026-10-12');
const masterJoin = masterDiag.scheduling.schedule.byDate['2026-10-12'].masterJoin;
assert(masterDiag.master.registered === 8 && masterDiag.master.duplicateIds === 1, 'registered people and duplicate transport ids are counted');
assert(masterJoin.comparable === true && masterJoin.identityProven === false && masterJoin.namesShown === false, 'a master string match is not identity');
assert(masterJoin.unique === 6 && masterJoin.absent === 1 && masterJoin.unmatchable === 2, 'unique, missing, and unmatchable ids partition the assigned people');
assert(masterJoin.unique + masterJoin.absent + masterJoin.unmatchable === masterActive.assignedPeople, 'each assigned person is counted once');
assert(masterActive.multiBlockPeople === 1 && masterJoin.unique >= 1, 'two blocks remain one person in the master compare');
assert(masterJoin.withDepartment === 5 && masterJoin.withoutDepartment === 1 && masterJoin.ofk6 === 1, 'department presence and OFK6 are separate counts');
assert(masterJoin.after5NameCandidate === 3, 'only a unique past mismatch with a department other than OFK6 can be named later');
const masterCopy = Core.copyPayload(masterDiag, '2026-10-12');
[MASTER_NAME, MASTER_JP, '所属なし氏名', 'OFK6氏名', '重複一名', 'GDSダイレクト'].concat(Object.keys(masterIds).map(function (key) { return masterIds[key]; })).forEach(function (secret) {
  assert(masterCopy.indexOf(secret) < 0, 'master compare copy has no personal value: ' + secret);
});
assert(masterCopy.indexOf('氏名の表示: しない') > 0 && masterCopy.indexOf('氏名は表示しない') > 0, 'the panel says names stay hidden');
const reloaded = masterNow.session.ingestMaster({ phase: 'loading' });
assert(reloaded.master.state === 'loading' && reloaded.master.registered == null, 'reload discards the previous master counts');
assert(Core.panelLines(reloaded, '2026-10-12').join('\n').indexOf('マスタ登録人数') < 0, 'discarded master counts leave the panel');
const emptyMaster = masterNow.session.ingestMaster({ ok: true, phase: 'ready', loadedAt: 1, entries: [] });
assert(emptyMaster.master.state === 'ready' && emptyMaster.master.registered === 0, 'a completed empty master is a real result');
assert(emptyMaster.scheduling.schedule.byDate['2026-10-12'].masterJoin.absent === 8 && emptyMaster.scheduling.schedule.byDate['2026-10-12'].masterJoin.unmatchable === 1, 'completed empty master does not count blank ids as mismatches');
const noMentor = Core.createSession(function () { return masterNow.now; });
noMentor.ingestScheduling(roster([
  person(masterIds.match, [block('2026-10-12', masterIds.match, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))])
], masterNow.iso));
const noMentorDiag = noMentor.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: 1,
  entries: [masterEntry(MASTER_NAME, masterIds.match, 'GDSダイレクト')]
});
assert(noMentorDiag.scheduling.schedule.byDate['2026-10-12'].masterJoin.unique === 1, 'master compare does not require mentor');
assert(noMentorDiag.scheduling.schedule.byDate['2026-10-12'].masterJoin.after5NameCandidate == null, 'the past-start name count waits for mentor');
assert(Core.panelLines(noMentorDiag, '2026-10-12').join('\n').indexOf('取得不足') > 0, 'panel shows the name count is not ready');

const masterPosts = [];
const masterTimers = [];
const masterIntervals = [];
const masterPage = {
  location: {
    hostname: 'ofk3-line-proxy-1.onrender.com',
    pathname: '/index.html',
    origin: 'https://ofk3-line-proxy-1.onrender.com'
  },
  postMessage: function (data, origin) {
    assert(origin === 'https://ofk3-line-proxy-1.onrender.com', 'status stays on the page origin');
    masterPosts.push(JSON.parse(JSON.stringify(data)));
  },
  addEventListener: function (type, fn) { masterPage.listeners.push(fn); },
  setTimeout: function (fn) { masterTimers.push(fn); return masterTimers.length; },
  setInterval: function (fn) { masterIntervals.push(fn); return masterIntervals.length; },
  localStorage: { getItem: function () { throw new Error('main world read storage'); } },
  listeners: []
};
masterPage.window = masterPage;
vm.createContext(masterPage);
vm.runInContext(read('cortex-capture-extension/master-capture.js'), masterPage, { filename: 'master-capture.js' });
assert(masterPosts.length === 0, 'the first status waits until the bridge is listening');
masterTimers[0]();
assert(masterPosts.length === 1 && masterPosts[0].phase === 'loading' && !masterPosts[0].entries, 'reload starts by discarding the old master');
masterIntervals[0]();
assert(masterPosts.length === 1, 'storage present before the page load flag is not a result');
masterPage.__ofk3MasterLoadStatus = { completedAt: 456 };
masterIntervals[0]();
assert(masterPosts[1].phase === 'ready' && masterPosts[1].loadedAt === 456, 'the load flag releases one status');
assert(JSON.stringify(masterPosts).indexOf(MASTER_NAME) < 0, 'the page signal has no name');

const bridgeSent = [];
const bridgeStorage = {};
bridgeStorage.transportIDs = JSON.stringify({ 'ハイフン氏名': 'Ｍ１２-ＨＹＰＨＥＮ４５ＮＡＭＥ' });
bridgeStorage.driverJapaneseNames = JSON.stringify({ 'ハイフン氏名': MASTER_JP });
bridgeStorage.driverDepartments = JSON.stringify({ 'ハイフン氏名': 'GDSダイレクト' });
bridgeStorage.lineMapping = JSON.stringify({ 'ハイフン氏名': 'U-SECRET-LINE' });
bridgeStorage.phoneMapping = JSON.stringify({ 'ハイフン氏名': SECRET_PHONE });
const bridgePage = {
  location: masterPage.location,
  localStorage: { getItem: function (key) { return Object.prototype.hasOwnProperty.call(bridgeStorage, key) ? bridgeStorage[key] : null; } },
  addEventListener: function (type, fn) { bridgePage.onMessage = fn; },
  postMessage: function () {},
  chrome: {
    runtime: {
      lastError: null,
      sendMessage: function (msg, cb) { bridgeSent.push(JSON.parse(JSON.stringify(msg))); if (cb) cb(); },
      onMessage: { addListener: function () {} }
    }
  }
};
bridgePage.window = bridgePage;
vm.createContext(bridgePage);
vm.runInContext(read('cortex-capture-extension/master-bridge.js'), bridgePage, { filename: 'master-bridge.js' });
assert(bridgeSent[0].type === 'id-diag-master' && bridgeSent[0].digest.phase === 'loading', 'opening the page clears the previous master');
vm.runInContext('onMessage({ source: window, origin: location.origin, data: { source: "OFK3_ID_DIAG", type: "master-status", phase: "ready", loadedAt: 456 } })', bridgePage);
assert(bridgeSent[1].digest.entries.length === 1, 'the bridge reads the three master maps after the load flag');
assert(JSON.stringify(bridgeSent[1]).indexOf('U-SECRET-LINE') < 0 && JSON.stringify(bridgeSent[1]).indexOf(SECRET_PHONE) < 0, 'line and phone values stay out of the master digest');
const fromBridge = Core.createSession(function () { return masterNow.now; });
fromBridge.ingestScheduling(roster([
  person(masterIds.hyphen, [block('2026-10-12', masterIds.hyphen, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))])
], masterNow.iso));
const bridged = fromBridge.ingestMaster(bridgeSent[1].digest);
assert(bridged.scheduling.schedule.byDate['2026-10-12'].masterJoin.unique === 1, 'fullwidth hyphenated transport ids match after normalization');
assert(Core.copyPayload(bridged, '2026-10-12').indexOf(MASTER_JP) < 0, 'bridged names are not in the diagnostic');

const causeShape = Core.masterShape([{ id: 'A12BC34DE56FG7' }]);
assert(Core.classifyAbsent('12345678901234', causeShape) === 'format', 'a different id shape is a format difference');
assert(Core.classifyAbsent('B12BC34DE56FG8', causeShape) === 'notInMaster', 'the same shape missing from the master is unregistered');
assert(Core.classifyAbsent('', causeShape) === 'missing', 'an empty id is missing');
assert(Core.classifyUnnamed('A12BC34DE56FG7', { nameCount: 1, department: 'GDSダイレクト' }, causeShape) === 'unknown', 'a nameable row has no unnamed cause');
assert(Core.classifyUnnamed('A12BC34DE56FG7', { nameCount: 2, department: '' }, causeShape) === 'duplicate', 'two master names are a duplicate');
assert(Core.classifyUnnamed('A12BC34DE56FG7', { nameCount: 1, department: '' }, causeShape) === 'noDepartment', 'a matched row can still lack a department');
assert(Core.classifyUnnamed('A12BC34DE56FG7', { nameCount: 1, department: 'OFK6' }, causeShape) === 'ofk6', 'OFK6 is its own cause');

const causeIds = {
  digit: '12345678901234',
  missing: 'B12BC34DE56FG8',
  later: 'D12BC34DE56FG9',
  plain: 'E12BC34DE56FG0',
  bare: 'C12NORM34DE56F',
  hyphen: 'C12-NORM34DE56F',
  nodept: 'F12BC34DE56FG1',
  ofk6: 'G12BC34DE56FG2',
  dup: 'H12BC34DE56FG3',
  named: 'J12BC34DE56FG4',
  active: 'K12BC34DE56FG5'
};
const causeNow = freshSession(tokyoClock(12, 11, 4));
causeNow.session.ingestScheduling(roster([
  person(causeIds.digit, [block('2026-10-12', causeIds.digit, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(causeIds.missing, [
    block('2026-10-12', causeIds.missing, 8 * 60, Date.UTC(2026, 9, 11, 23, 0, 0)),
    block('2026-10-12', causeIds.missing, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))
  ]),
  person(causeIds.later, [block('2026-10-12', causeIds.later, 12 * 60, Date.UTC(2026, 9, 12, 3, 0, 0))]),
  person(causeIds.hyphen, [block('2026-10-12', causeIds.hyphen, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(causeIds.nodept, [block('2026-10-12', causeIds.nodept, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(causeIds.ofk6, [block('2026-10-12', causeIds.ofk6, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(causeIds.dup, [block('2026-10-12', causeIds.dup, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(causeIds.named, [block('2026-10-12', causeIds.named, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]),
  person(causeIds.active, [block('2026-10-12', causeIds.active, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))])
], causeNow.iso));
causeNow.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: causeIds.active, active: true }
], causeNow.iso));
const causeDiag = causeNow.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: 1,
  entries: [
    masterEntry('原因なし', causeIds.plain, 'GDSダイレクト'),
    masterEntry('ハイフンマスタ', causeIds.bare, 'GDSダイレクト'),
    masterEntry('所属なし原因', causeIds.nodept, ''),
    masterEntry('OFK6原因', causeIds.ofk6, 'OFK6'),
    masterEntry('重複原因一', causeIds.dup, 'GDSパート'),
    masterEntry('重複原因二', causeIds.dup, 'JHS'),
    masterEntry('氏名可能', causeIds.named, 'GDSダイレクト'),
    masterEntry('起動中原因', causeIds.active, 'GDS管理')
  ]
});
const causeJoin = causeDiag.scheduling.schedule.byDate['2026-10-12'].masterJoin;
const causeActive = dayBlock(causeDiag, '2026-10-12');
function causeSum(causes) {
  return causes.missing + causes.format + causes.normalization + causes.duplicate + causes.notInMaster + causes.noDepartment + causes.ofk6 + causes.unknown;
}
assert(causeJoin.group1.total === causeJoin.absent && causeSum(causeJoin.group1) === causeJoin.group1.total, 'master mismatch causes cover that group');
assert(causeJoin.group1.format === 1 && causeJoin.group1.notInMaster === 2 && causeJoin.group1.missing === 0 && causeJoin.group1.duplicate === 0, 'format and unregistered ids explain the master mismatches');
assert(causeJoin.group2.total + causeJoin.after5NameCandidate === causeActive.mismatchHasAfter5, 'unnamed and named people cover the past active mismatches');
assert(causeJoin.group2.format === 1 && causeJoin.group2.notInMaster === 1 && causeJoin.group2.noDepartment === 1 && causeJoin.group2.ofk6 === 1 && causeJoin.group2.duplicate === 1, 'the unnamed past mismatches keep separate causes');
assert(causeJoin.group2.unknown === 0 && causeJoin.overlap === 2, 'only the shared mismatches are counted in both groups');
assert(causeJoin.normalizedMatch === 1 && causeJoin.group1.normalization === 0, 'normalization explains a match, not a mismatch');
assert(causeActive.multiBlockPeople === 1, 'two blocks on an unregistered person stay one person');
const causeText = Core.copyPayload(causeDiag, '2026-10-12');
Object.keys(causeIds).forEach(function (key) {
  assert(causeText.indexOf(causeIds[key]) < 0, 'cause copy has no id');
});
assert(causeText.indexOf('退職者の判定: しない') > 0 && causeText.indexOf('未起動候補') < 0, 'retirement and unstarted stay out of the cause report');
assert(causeText.indexOf('2グループに同時に入る人数: 2') > 0 && causeText.indexOf('原因未確定: 0') > 0, 'overlap and unknown causes are visible as counts');

const confirmIds = {
  ready: 'C12READY45NAME01',
  kana: 'C12KANA45NAME002',
  nodept: 'C12NODEP45NAME03',
  absent: 'C12ABSENT45NAME4',
  blank: 'C12BLANK45NAME05'
};
const confirmNow = freshSession(tokyoClock(12, 11, 4));
const guessedSchedulingName = '推測してはいけない氏名';
confirmNow.session.ingestScheduling(roster([
  Object.assign(person(confirmIds.ready, [block('2026-10-12', confirmIds.ready, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]), { associateName: guessedSchedulingName, schedulingName: guessedSchedulingName }),
  person(confirmIds.kana, [block('2026-10-12', confirmIds.kana, 10 * 60, Date.UTC(2026, 9, 12, 1, 0, 0))]),
  person(confirmIds.nodept, [block('2026-10-12', confirmIds.nodept, 11 * 60, Date.UTC(2026, 9, 12, 2, 0, 0))]),
  person(confirmIds.absent, [block('2026-10-12', confirmIds.absent, 8 * 60, Date.UTC(2026, 9, 11, 23, 0, 0))])
], confirmNow.iso));
confirmNow.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: confirmIds.ready, active: true }
], confirmNow.iso));
confirmNow.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: Date.parse(confirmNow.iso),
  entries: [
    { name: '確認キー', japaneseName: '確認 太郎', transportId: confirmIds.ready, department: 'GDSダイレクト' },
    { name: 'かなキー', japaneseName: 'かなキー', transportId: confirmIds.kana, department: 'GDS管理' },
    { name: '所属なし確認', japaneseName: '', transportId: confirmIds.nodept, department: '' }
  ]
});
const hidden = confirmNow.session.confirmationView('2026-10-12', false);
assert(hidden.enabled === true && hidden.rows.length === 0 && hidden.pending === 3 && hidden.confirmed === 0 && hidden.rejected === 0, 'a closed panel gets counts without name rows');
assert(JSON.stringify(hidden).indexOf('確認 太郎') < 0 && JSON.stringify(hidden).indexOf(confirmIds.ready) < 0, 'a closed confirmation response has no name or id');
const opened = confirmNow.session.confirmationView('2026-10-12', true);
assert(opened.identityProven === false && opened.rows.length === 3, 'a string match stays unconfirmed until a person chooses');
assert(opened.rows.every(function (row) { return row.status === 'pending' && row.schedulingName === '取得不可' && !row.id; }), 'scheduling names are not guessed and ids stay off the row');
assert(opened.unregistered === 1 && opened.noDepartment === 1, 'unregistered and unset department stay separate counts');
assert(opened.rows.some(function (row) { return row.masterName === '確認 太郎（確認キー）' && row.department === 'GDSダイレクト'; }), 'the master key and japanese name are both shown');
assert(opened.rows.some(function (row) { return row.masterName === '所属なし確認' && row.department === '未登録'; }), 'a missing department is labeled without guessing one');
assert(JSON.stringify(opened).indexOf(confirmIds.ready) < 0 && JSON.stringify(opened).indexOf(confirmIds.absent) < 0 && JSON.stringify(opened).indexOf(guessedSchedulingName) < 0, 'opened rows still omit raw ids and guessed names');
const confirmed = confirmNow.session.setConfirmation('2026-10-12', opened.rows.find(function (row) { return row.masterName.indexOf('確認 太郎') === 0; }).index, 'confirmed', opened.generation);
assert(confirmed.confirmed === 1 && confirmed.pending === 2 && confirmed.rejected === 0 && confirmed.identityProven === false, 'an administrator can mark one person confirmed');
const rejected = confirmNow.session.setConfirmation('2026-10-12', opened.rows.find(function (row) { return row.department === '未登録'; }).index, 'rejected', opened.generation);
assert(rejected.rejected === 1 && rejected.rows.some(function (row) { return row.department === '未登録' && row.status === 'rejected'; }), 'a rejected person stays visible and is marked out of operations');
const backToPending = confirmNow.session.setConfirmation('2026-10-12', opened.rows.find(function (row) { return row.department === '未登録'; }).index, 'pending', opened.generation);
assert(backToPending.rejected === 0 && backToPending.pending === 2 && backToPending.confirmed === 1, 'a person can be returned to unconfirmed');
const unchanged = confirmNow.session.setConfirmation('2026-10-12', 0, 'confirmed', opened.generation + 1);
assert(unchanged.confirmed === 1, 'a stale generation does not change confirmation');
const confirmCopy = Core.copyPayload(confirmNow.session.read('2026-10-12'), '2026-10-12');
['確認 太郎', '確認キー', 'かなキー', '所属なし確認', guessedSchedulingName].concat(Object.keys(confirmIds).map(function (key) { return confirmIds[key]; })).forEach(function (secret) {
  assert(confirmCopy.indexOf(secret) < 0, 'diagnostic copy has no confirmation personal value: ' + secret);
});
confirmNow.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: Date.parse(confirmNow.iso),
  entries: [
    { name: '確認キー', japaneseName: '確認 太郎', transportId: confirmIds.ready, department: 'GDSダイレクト' },
    { name: 'かなキー', japaneseName: 'かなキー', transportId: confirmIds.kana, department: 'GDS管理' },
    { name: '所属なし確認', japaneseName: '', transportId: confirmIds.nodept, department: '' }
  ]
});
assert(confirmNow.session.confirmationView('2026-10-12', true).confirmed === 1, 'the same master snapshot keeps the in-memory confirmation');
confirmNow.session.resetConfirmations();
assert(confirmNow.session.confirmationView('2026-10-12', true).confirmed === 0 && confirmNow.session.confirmationView('2026-10-12', true).pending === 3, 'reload returns everyone to unconfirmed');

const rosterNameIds = {
  shown: 'S12SHOW45NAME001',
  twinA: 'S12TWIN45NAME00A',
  twinB: 'S12TWIN45NAME00B',
  clash: 'S12CLASH45NAME01',
  blank: 'S12BLANK45NAME02',
  partial: 'S12PART45NAME003',
  dup: 'S12DUPID45NAME04'
};
const SHOWN_NAME = '表示 太郎';
const TWIN_NAME = '同姓 同名';
const CLASH_NAME = '別表記';
const PART_NAME = '部分 氏名';
function rosterNamed(id, full, first, last) {
  return Object.assign(person(id, [block('2026-10-12', id, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))]), {
    driverName: full,
    driverFirstName: first,
    driverLastName: last,
    schedulingName: guessedSchedulingName,
    associateName: guessedSchedulingName,
    email: SECRET_MAIL
  });
}
const rosterNames = freshSession(tokyoClock(12, 11, 4));
rosterNames.session.ingestScheduling(roster([
  rosterNamed(rosterNameIds.shown, SHOWN_NAME, '太郎', '表示'),
  rosterNamed(rosterNameIds.twinA, TWIN_NAME, '同名', '同姓'),
  rosterNamed(rosterNameIds.twinB, '同姓　同名', '同名', '同姓'),
  rosterNamed(rosterNameIds.clash, CLASH_NAME, '花子', '山田'),
  rosterNamed(rosterNameIds.blank, '   ', null, null),
  rosterNamed(rosterNameIds.partial, '', '部分', '氏名')
], rosterNames.iso));
rosterNames.session.ingestMentor(mentor([
  { driverId: MENTOR_DRIVER, realStaffNumber: rosterNameIds.shown, active: true }
], rosterNames.iso));
rosterNames.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: Date.parse(rosterNames.iso),
  entries: [
    { name: '表示キー', japaneseName: SHOWN_NAME, transportId: rosterNameIds.shown, department: 'GDSダイレクト' },
    { name: '同名甲', japaneseName: 'マスタ甲', transportId: rosterNameIds.twinA, department: 'GDSダイレクト' },
    { name: '同名乙', japaneseName: 'マスタ乙', transportId: rosterNameIds.twinB, department: 'GDSダイレクト' },
    { name: '衝突キー', japaneseName: 'マスタ衝突', transportId: rosterNameIds.clash, department: 'GDSダイレクト' },
    { name: '空欄キー', japaneseName: 'マスタ空欄', transportId: rosterNameIds.blank, department: 'GDSダイレクト' },
    { name: '部分キー', japaneseName: 'マスタ部分', transportId: rosterNameIds.partial, department: 'GDSダイレクト' }
  ]
});
const rosterHidden = rosterNames.session.confirmationView('2026-10-12', false);
assert(rosterHidden.enabled === true && rosterHidden.rows.length === 0 && rosterHidden.confirmed === 0, 'a closed confirmation keeps counts and no name rows');
assert(JSON.stringify(rosterHidden).indexOf(SHOWN_NAME) < 0 && JSON.stringify(rosterHidden).indexOf(TWIN_NAME) < 0 && JSON.stringify(rosterHidden).indexOf(CLASH_NAME) < 0, 'a closed confirmation has no scheduling names');
const rosterOpened = rosterNames.session.confirmationView('2026-10-12', true);
assert(rosterOpened.identityProven === false && rosterOpened.confirmed === 0 && rosterOpened.pending === 6, 'a displayed scheduling name stays unconfirmed');
const shownRow = rosterOpened.rows.filter(function (row) { return row.masterName === SHOWN_NAME + '（表示キー）'; })[0];
assert(shownRow && shownRow.schedulingName === SHOWN_NAME && shownRow.status === 'pending' && !shownRow.id, 'a unique roster name is shown beside the master name');
assert(rosterOpened.rows.filter(function (row) { return row.masterName.indexOf('マスタ甲') === 0 || row.masterName.indexOf('マスタ乙') === 0; }).every(function (row) { return row.schedulingName === '要確認'; }), 'the same name on two ids is not shown');
assert(rosterOpened.rows.some(function (row) { return row.masterName.indexOf('マスタ衝突') === 0 && row.schedulingName === '要確認'; }), 'a full name that disagrees with the parts is not shown');
assert(rosterOpened.rows.some(function (row) { return row.masterName.indexOf('マスタ空欄') === 0 && row.schedulingName === '取得不可'; }), 'a blank roster name stays unavailable');
assert(rosterOpened.rows.some(function (row) { return row.masterName.indexOf('マスタ部分') === 0 && row.schedulingName === '要確認'; }), 'parts without driverName are not composed into a display name');
assert(JSON.stringify(rosterOpened).indexOf(CLASH_NAME) < 0 && JSON.stringify(rosterOpened).indexOf(PART_NAME) < 0 && JSON.stringify(rosterOpened).indexOf(guessedSchedulingName) < 0 && JSON.stringify(rosterOpened).indexOf(SECRET_MAIL) < 0, 'ambiguous names, guessed names, and mail stay off the open rows');
Object.keys(rosterNameIds).forEach(function (key) {
  assert(JSON.stringify(rosterOpened).indexOf(rosterNameIds[key]) < 0, 'open rows omit raw ids');
});
const rosterCopy = Core.copyPayload(rosterNames.session.read('2026-10-12'), '2026-10-12');
[SHOWN_NAME, TWIN_NAME, CLASH_NAME, PART_NAME, guessedSchedulingName, SECRET_MAIL].concat(Object.keys(rosterNameIds).map(function (key) { return rosterNameIds[key]; })).forEach(function (secret) {
  assert(rosterCopy.indexOf(secret) < 0, 'diagnostic copy omits roster names and ids: ' + secret);
});
const marked = rosterNames.session.setConfirmation('2026-10-12', shownRow.index, 'confirmed', rosterOpened.generation);
assert(marked.confirmed === 1 && marked.rows[shownRow.index].status === 'confirmed' && marked.identityProven === false, 'only the manual button marks a person confirmed');
const dupNames = freshSession(tokyoClock(12, 11, 4));
dupNames.session.ingestScheduling(roster([
  rosterNamed(rosterNameIds.dup, '重複 一名', '一名', '重複'),
  rosterNamed(rosterNameIds.dup, '重複 二名', '二名', '重複')
], dupNames.iso));
dupNames.session.ingestMentor(mentor([{ driverId: MENTOR_DRIVER, realStaffNumber: rosterNameIds.dup, active: true }], dupNames.iso));
dupNames.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: Date.parse(dupNames.iso),
  entries: [{ name: '重複キー', japaneseName: 'マスタ重複', transportId: rosterNameIds.dup, department: 'GDSダイレクト' }]
});
const dupView = dupNames.session.confirmationView('2026-10-12', true);
assert(dupView.enabled === false && dupView.reason === '対応が曖昧' && dupView.rows.length === 0, 'a repeated id keeps the confirmation list closed');
assert(JSON.stringify(dupView).indexOf('重複 一名') < 0 && JSON.stringify(dupView).indexOf('重複 二名') < 0, 'duplicate id names stay out of the closed list');
assert(Core.copyPayload(dupNames.session.read('2026-10-12'), '2026-10-12').indexOf('重複 一名') < 0, 'duplicate id names stay out of the diagnostic');

const mentorIds = {
  history: 'H12HIST45NAME001',
  drivers: 'H12DRIV45NAME002',
  names: 'H12NAME45NAME003',
  blank: 'H12BLNK45NAME004',
  order: 'H12ORDR45NAME005',
  space: 'H12SPAC45NAME006',
  english: 'H12ENGL45NAME007',
  differ: 'H12DIFF45NAME008'
};
const MENTOR_DRIVER_A = 'D12MENTORA45NAME1';
const MENTOR_DRIVER_B = 'D12MENTORB45NAME2';
function mentorShift(staff, driver, first, last, active) {
  return { realStaffNumber: staff, driverId: driver, firstName: first, lastName: last, active: !!active };
}
const mentorCheck = freshSession(tokyoClock(12, 11, 4));
mentorCheck.session.ingestScheduling(roster([
  rosterNamed(mentorIds.history, '山田 太郎', '太郎', '山田'),
  rosterNamed(mentorIds.drivers, '佐藤 花子', '花子', '佐藤'),
  rosterNamed(mentorIds.names, '鈴木 一郎', '一郎', '鈴木'),
  rosterNamed(mentorIds.blank, '空欄 人名', '人名', '空欄'),
  rosterNamed(mentorIds.order, '太郎山田', '太郎', '山田'),
  rosterNamed(mentorIds.space, '山田太郎', '太郎', '山田'),
  rosterNamed(mentorIds.english, 'Taro Yamada', 'Taro', 'Yamada'),
  rosterNamed(mentorIds.differ, '高橋 剛', '剛', '高橋')
], mentorCheck.iso));
mentorCheck.session.ingestMentor(mentor([
  mentorShift(mentorIds.history, MENTOR_DRIVER_A, '太郎', '山田', false),
  mentorShift(mentorIds.history, MENTOR_DRIVER_A, '太 郎', '山 田', true),
  mentorShift(mentorIds.drivers, MENTOR_DRIVER_A, '花子', '佐藤', false),
  mentorShift(mentorIds.drivers, MENTOR_DRIVER_B, '花子', '佐藤', false),
  mentorShift(mentorIds.names, MENTOR_DRIVER_A, '一郎', '鈴木', false),
  mentorShift(mentorIds.names, MENTOR_DRIVER_A, '次郎', '鈴木', false),
  mentorShift(mentorIds.blank, MENTOR_DRIVER_A, '', '', false),
  mentorShift(mentorIds.order, MENTOR_DRIVER_A, '太郎', '山田', false),
  mentorShift(mentorIds.space, MENTOR_DRIVER_A, '太 郎', '山 田', false),
  mentorShift(mentorIds.english, MENTOR_DRIVER_A, 'ＴＡＲＯ', 'ＹＡＭＡＤＡ', false),
  mentorShift(mentorIds.differ, MENTOR_DRIVER_A, '健', '高橋', false)
], mentorCheck.iso));
mentorCheck.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: Date.parse(mentorCheck.iso),
  entries: Object.keys(mentorIds).map(function (key) {
    return { name: key + 'キー', japaneseName: 'マスタ' + key, transportId: mentorIds[key], department: 'GDSダイレクト' };
  })
});
const mentorClosed = mentorCheck.session.confirmationView('2026-10-12', false);
assert(mentorClosed.enabled === true && mentorClosed.rows.length === 0 && mentorClosed.confirmed === 0, 'mentor names stay off the closed confirmation');
const mentorOpened = mentorCheck.session.confirmationView('2026-10-12', true);
assert(mentorOpened.identityProven === false && mentorOpened.confirmed === 0 && mentorOpened.pending === 8, 'mentor name agreement does not confirm anyone');
function mentorRow(label) {
  return mentorOpened.rows.filter(function (row) { return row.masterName.indexOf('マスタ' + label) === 0; })[0];
}
const historyRow = mentorRow('history');
assert(historyRow.mentorSession === '同一人物候補・過去セッション重複' && historyRow.mentorNameCompare === '氏名一致候補' && historyRow.mentorName === '山田 太郎' && historyRow.status === 'pending', 'repeated sessions of one person stay a candidate');
const driverRow = mentorRow('drivers');
assert(driverRow.mentorSession === '要確認' && driverRow.mentorNameCompare === '氏名一致候補' && driverRow.mentorName === '佐藤 花子', 'two driver ids stay unresolved even when the name matches');
const namesRow = mentorRow('names');
assert(namesRow.mentorSession === '要確認' && namesRow.mentorNameCompare === '判定不能' && !namesRow.mentorName, 'two mentor names are not shown');
const blankRow = mentorRow('blank');
assert(blankRow.mentorSession === '判定不能' && blankRow.mentorNameCompare === '判定不能' && !blankRow.mentorName, 'a missing mentor name is undetermined');
assert(mentorRow('order').mentorNameCompare === '氏名一致候補' && mentorRow('space').mentorNameCompare === '氏名一致候補' && mentorRow('english').mentorNameCompare === '氏名一致候補', 'order, spaces, width, and case still match');
assert(mentorRow('differ').mentorNameCompare === '氏名不一致' && mentorRow('differ').mentorName === '高橋 健' && mentorRow('differ').status === 'pending', 'a different mentor name stays unconfirmed');
const mentorMarked = mentorCheck.session.setConfirmation('2026-10-12', historyRow.index, 'confirmed', mentorOpened.generation);
assert(mentorMarked.confirmed === 1 && mentorMarked.identityProven === false && mentorMarked.rows[historyRow.index].status === 'confirmed', 'only the manual button confirms a mentor candidate');
const mentorSecrets = ['山田 太郎', '佐藤 花子', '鈴木 一郎', '鈴木 次郎', '高橋 健', 'ＴＡＲＯ', 'ＹＡＭＡＤＡ', MENTOR_DRIVER_A, MENTOR_DRIVER_B].concat(Object.keys(mentorIds).map(function (key) { return mentorIds[key]; }));
mentorSecrets.forEach(function (secret) {
  assert(JSON.stringify(mentorClosed).indexOf(secret) < 0, 'closed confirmation omits mentor personal data: ' + secret);
});
const mentorCopy = Core.copyPayload(mentorCheck.session.read('2026-10-12'), '2026-10-12');
mentorSecrets.forEach(function (secret) {
  assert(mentorCopy.indexOf(secret) < 0, 'diagnostic copy omits mentor personal data: ' + secret);
});
assert(mentorCopy.indexOf('同一人物候補・過去セッション重複 1') >= 0 && mentorCopy.indexOf('氏名一致候補') >= 0 && mentorCopy.indexOf('氏名不一致') >= 0 && mentorCopy.indexOf('未起動判定: しない') >= 0, 'diagnostic keeps counts without calling anyone unstarted');
assert(mentorCopy.indexOf('未起動候補') < 0, 'inactive mentor rows are not unstarted candidates');

const staleConfirm = freshSession(tokyoClock(12, 11, 4));
staleConfirm.session.ingestScheduling(roster([
  person(confirmIds.ready, [block('2026-10-12', confirmIds.ready, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))])
], OLD));
staleConfirm.session.ingestMentor(mentor([{ driverId: MENTOR_DRIVER, realStaffNumber: confirmIds.ready, active: true }], staleConfirm.iso));
staleConfirm.session.ingestMaster({ ok: true, phase: 'ready', loadedAt: Date.parse(staleConfirm.iso), entries: [{ name: '期限切れ氏名', japaneseName: '期限切れ氏名', transportId: confirmIds.ready, department: 'GDSダイレクト' }] });
const staleView = staleConfirm.session.confirmationView('2026-10-12', true);
assert(staleView.enabled === false && staleView.reason === '取得が古い' && staleView.rows.length === 0 && JSON.stringify(staleView).indexOf('期限切れ氏名') < 0, 'stale data disables confirmation and hides names');

const failedConfirm = freshSession(tokyoClock(12, 11, 4));
failedConfirm.session.ingestScheduling(roster([
  person(confirmIds.ready, [block('2026-10-12', confirmIds.ready, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))])
], failedConfirm.iso));
failedConfirm.session.ingestMentor({ ok: false, issue: 'FAILED', capturedAt: failedConfirm.iso });
failedConfirm.session.ingestMaster({ ok: true, phase: 'ready', loadedAt: Date.parse(failedConfirm.iso), entries: [{ name: '失敗氏名', japaneseName: '失敗氏名', transportId: confirmIds.ready, department: 'GDSダイレクト' }] });
const failedView = failedConfirm.session.confirmationView('2026-10-12', true);
assert(failedView.enabled === false && failedView.reason === '取得失敗' && failedView.rows.length === 0 && JSON.stringify(failedView).indexOf('失敗氏名') < 0, 'a failed capture disables confirmation');

const duplicateConfirm = freshSession(tokyoClock(12, 11, 4));
duplicateConfirm.session.ingestScheduling(roster([
  person(confirmIds.ready, [block('2026-10-12', confirmIds.ready, 9 * 60, Date.UTC(2026, 9, 12, 0, 0, 0))])
], duplicateConfirm.iso));
duplicateConfirm.session.ingestMentor(mentor([{ driverId: MENTOR_DRIVER, realStaffNumber: confirmIds.ready, active: true }], duplicateConfirm.iso));
duplicateConfirm.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: Date.parse(duplicateConfirm.iso),
  entries: [
    { name: '重複確認一', japaneseName: '重複確認一', transportId: confirmIds.ready, department: 'GDSダイレクト' },
    { name: '重複確認二', japaneseName: '重複確認二', transportId: confirmIds.ready, department: 'JHS' }
  ]
});
const duplicateView = duplicateConfirm.session.confirmationView('2026-10-12', true);
assert(duplicateView.enabled === false && duplicateView.reason === '対応が曖昧' && duplicateView.rows.length === 0, 'a duplicate transport id disables confirmation');
assert(JSON.stringify(duplicateView).indexOf('重複確認一') < 0 && JSON.stringify(duplicateView).indexOf(confirmIds.ready) < 0, 'an ambiguous confirmation response has no name or id');
assert(opened.enabled === true && opened.rows.length === 3 && opened.pending === 3 && opened.rows.every(function (row) { return row.status === 'pending'; }), 'unregistered people do not hide the uniquely matched rows');

const restoredSession = Core.createSession(function () { return NOW; });
assert(restoredSession.confirmationView('2026-10-12', true).reason === '取得不足' && restoredSession.confirmationView('2026-10-12', true).rows.length === 0, 'confirmation without captured sources stays closed to names');
restoredSession.ingestScheduling(roster([person(ID_A, [block('2026-10-12', ID_A, 540, NINE)])], FRESH));
const partialDiag = restoredSession.ingestMentor(mentor([{ driverId: MENTOR_DRIVER, realStaffNumber: ID_A, active: true }], FRESH));
assert(partialDiag.crossStatus === 'ready' && restoredSession.confirmationView('2026-10-12', true).reason === '取得不足', 'a ready scheduling and mentor diagnostic still needs the master');
restoredSession.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: Date.parse(FRESH),
  entries: [{ name: '確認キー', japaneseName: '確認 太郎', transportId: ID_A, department: 'GDSダイレクト' }]
});
const restoredView = restoredSession.confirmationView('2026-10-12', true);
assert(restoredView.enabled === true && restoredView.rows.length === 1 && restoredView.rows[0].status === 'pending', 'restoring the three captures enables confirmation without marking anyone confirmed');
assert(JSON.stringify(restoredSession.read('2026-10-12')).indexOf('確認 太郎') < 0, 'the restored diagnostic still omits the name');

function panelElement(tag) {
  var node = {
    tag: tag,
    id: '',
    className: '',
    type: '',
    style: {},
    children: [],
    parentElement: null,
    parentNode: null,
    _text: '',
    _top: 0,
    _height: 20,
    open: false,
    listeners: {},
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0
  };
  Object.defineProperty(node, 'textContent', {
    get: function () {
      if (node.children.length) return node.children.map(function (child) { return child.textContent; }).join('');
      return node._text;
    },
    set: function (value) {
      node._text = value == null ? '' : String(value);
      node.children = [];
    }
  });
  Object.defineProperty(node, 'nextSibling', {
    get: function () {
      if (!node.parentElement) return null;
      return node.parentElement.children[node.parentElement.children.indexOf(node) + 1] || null;
    }
  });
  node.appendChild = function (child) {
    child.parentElement = node;
    child.parentNode = node;
    node.children.push(child);
    if (child.id === 'ofk3-id-confirm') child._top = 500;
    return child;
  };
  node.insertBefore = function (child, ref) {
    child.parentElement = node;
    child.parentNode = node;
    var at = node.children.indexOf(ref);
    if (at < 0) node.children.push(child);
    else node.children.splice(at, 0, child);
    if (child.id === 'ofk3-id-confirm') child._top = 500;
    return child;
  };
  node.addEventListener = function (type, fn) {
    node.listeners[type] = node.listeners[type] || [];
    node.listeners[type].push(fn);
  };
  node.querySelector = function (sel) {
    return findNode(node, function (child) {
      return sel.charAt(0) === '#' ? child.id === sel.slice(1) : child.tag === sel;
    });
  };
  node.getBoundingClientRect = function () {
    var top = node._top;
    var parent = node.parentElement;
    while (parent) {
      top -= parent.scrollTop || 0;
      parent = parent.parentElement;
    }
    return { top: top, bottom: top + node._height, left: 0, right: 100, width: 100, height: node._height };
  };
  return node;
}
function findNode(node, pred) {
  for (var i = 0; i < node.children.length; i += 1) {
    if (pred(node.children[i])) return node.children[i];
    var nested = findNode(node.children[i], pred);
    if (nested) return nested;
  }
  return null;
}
function clickControl(button) {
  (button.listeners.click || []).forEach(function (fn) { fn(); });
}
const panelWindow = {
  location: { hostname: 'vrm-mentor.edriving.com', origin: 'https://vrm-mentor.edriving.com' },
  listeners: {},
  OFK3IdDiag: {
    panelLines: function () { return ['ID照合診断（調査用）']; },
    copyPayload: function () { return '{}'; }
  },
  addEventListener: function (type, fn) {
    panelWindow.listeners[type] = panelWindow.listeners[type] || [];
    panelWindow.listeners[type].push(fn);
  },
  postMessage: function (data) {
    var source = panelWindow.__panelGlobal || panelWindow;
    (panelWindow.listeners.message || []).slice().forEach(function (fn) {
      try { fn({ source: source, data: data }); }
      catch (err) { panelWindow.lastMessageError = String(err && err.stack || err); }
    });
  },
  setInterval: function () { return 1; },
  clearInterval: function () {}
};
panelWindow.document = {
  body: panelElement('body'),
  documentElement: panelElement('html'),
  createElement: panelElement,
  getElementById: function (id) {
    return id === 'ofk3-mentor-capture-v0' ? panelHost : findNode(panelHost, function (child) { return child.id === id; });
  }
};
const panelHost = panelElement('div');
panelHost.id = 'ofk3-mentor-capture-v0';
const panelShadow = panelElement('div');
panelShadow.getElementById = function (id) {
  return findNode(panelShadow, function (child) { return child.id === id; });
};
panelHost.shadowRoot = panelShadow;
const panelBox = panelElement('div');
panelBox.className = 'box';
panelBox.clientHeight = 120;
panelBox.scrollHeight = 900;
const panelOuter = panelElement('div');
panelOuter.id = 'ofk3-mentor-details';
const panelDiag = panelElement('div');
panelDiag.id = 'ofk3-id-diag';
const panelPre = panelElement('pre');
panelPre.id = 'ofk3-id-diag-body';
panelDiag.appendChild(panelElement('b'));
panelDiag.appendChild(panelPre);
panelOuter.appendChild(panelDiag);
panelBox.appendChild(panelOuter);
panelShadow.appendChild(panelBox);
panelWindow.window = panelWindow;
panelWindow.globalThis = panelWindow;
panelWindow.refreshPosts = 0;
panelWindow.confirmReads = 0;
panelWindow.addEventListener('message', function (ev) {
  var data = ev.data;
  if (!data || data.source !== 'OFK3_ID_DIAG') return;
  if (data.type === 'id-diag-rollcall') {
    panelWindow.rollReads = (panelWindow.rollReads || 0) + 1;
    panelWindow.postMessage({
      source: 'OFK3_ID_DIAG',
      type: 'rollcall-view',
      token: data.token,
      rollCall: {
        enabled: true,
        reason: '',
        detail: '',
        date: '2026-10-12',
        captured: {
          scheduling: '2026-10-12T02:20:00.000Z',
          mentor: '2026-10-12T02:20:00.000Z',
          master: '2026-10-12T02:20:00.000Z'
        },
        counts: { total: 2, before: 0, within5: 0, activeCandidate: 1, activeUnseen: 0, after5Unmatched: 1, unknownTime: 0, identityIssues: 1 },
        identityProven: false,
        namesShown: data.includeRows === true,
        rows: data.includeRows ? [
          {
            status: '開始後5分以上・照合不能',
            identity: 'OFK3マスタ未登録',
            schedulingName: '一覧 太郎',
            masterName: 'マスタ未登録',
            department: 'マスタ未登録',
            startLabel: '09:00（開始予定）',
            elapsed: '経過 6分',
            mentorText: '判定不能 / 判定不能',
            mentorName: '',
            confirmation: '未確認',
            note: 'マスタ未登録'
          },
          {
            status: '開始後5分以上・Active確認候補',
            schedulingName: '一覧 花子',
            masterName: '花子（花子キー）',
            department: 'GDSダイレクト',
            startLabel: '09:00（最初の開始予定・2件）',
            elapsed: '経過 6分',
            mentorText: '同一人物候補 / 氏名一致候補',
            mentorName: '花子 名',
            confirmation: '未確認',
            note: ''
          }
        ] : [
          { schedulingName: '閉じてはいけない氏名', masterName: '閉じてはいけない氏名', mentorName: '閉じてはいけない氏名' }
        ]
      }
    });
    return;
  }
  if (data.type === 'id-diag-refresh') {
    panelWindow.refreshPosts += 1;
    panelWindow.postMessage({
      source: 'OFK3_ID_DIAG',
      type: 'diag-result',
      diagnostic: { scheduling: { schedule: { dateKeys: ['2026-10-12'], focus: '2026-10-12' } } }
    });
    return;
  }
  if (data.type !== 'id-diag-confirm-read') return;
  panelWindow.confirmReads += 1;
  var ready = panelWindow.confirmReads > 1;
  panelWindow.postMessage({
    source: 'OFK3_ID_DIAG',
    type: 'confirm-view',
    token: data.token,
    confirmation: ready ? {
      enabled: true,
      reason: '',
      unregistered: 3,
      noDepartment: 1,
      confirmed: 0,
      rejected: 0,
      pending: 1,
      generation: 5,
      identityProven: false,
      rows: [{
        index: 0,
        schedulingName: '取得不可',
        masterName: '確認 太郎（確認キー）',
        department: 'GDSダイレクト',
        status: 'pending'
      }]
    } : { enabled: false, reason: '取得不足', rows: [] }
  });
});
vm.runInNewContext('this.__panelGlobal = typeof window !== "undefined" ? window : globalThis;\n' + read('cortex-capture-extension/id-diag-panel.js'), panelWindow, { filename: 'id-diag-panel.js' });
const confirmSection = panelShadow.getElementById('ofk3-id-confirm');
const confirmButton = panelShadow.getElementById('ofk3-id-confirm-toggle');
const refreshBeforeOpen = panelWindow.refreshPosts;
assert(confirmButton && confirmButton.textContent === '本人対応を確認する', 'the confirmation control starts as a closed button');
assert(confirmButton.style.background && confirmButton.style.border && confirmButton.style.padding, 'the confirmation button has a visible button style');
assert(confirmSection && confirmSection.hidden === true, 'the confirmation list starts hidden');
assert(panelDiag.children.indexOf(confirmButton.parentElement) < panelDiag.children.indexOf(panelPre) && panelDiag.children.indexOf(confirmSection) < panelDiag.children.indexOf(panelPre), 'the button and confirmation list sit above the long diagnostic');
clickControl(confirmButton);
const confirmBody = panelShadow.getElementById('ofk3-id-confirm-body');
assert(confirmSection.hidden === false && confirmButton.textContent === '本人対応確認を閉じる', 'the button opens the confirmation list and renames itself');
assert(panelWindow.refreshPosts === refreshBeforeOpen + 1, 'a missing session asks the open pages to resend captured data once');
assert(confirmBody.textContent.indexOf('未確認 1人') >= 0 && confirmBody.textContent.indexOf('確認済み 0人') >= 0, 'expanded section shows the confirmation counts');
assert(confirmBody.textContent.indexOf('確認 太郎（確認キー）') >= 0 && confirmBody.textContent.indexOf('確認済みにする') >= 0, 'expanded section shows the master name and confirmation buttons');
assert(confirmBody.textContent.indexOf('/ 未確認') >= 0, 'a string match stays unconfirmed on screen');
assert(panelBox.scrollTop === 500, 'opening the section scrolls it into the panel');
panelWindow.postMessage({ source: 'OFK3_ID_DIAG', type: 'confirm-view', token: 1, confirmation: { enabled: false, reason: '取得不足', rows: [] } });
assert(confirmBody.textContent.indexOf('確認 太郎（確認キー）') >= 0, 'an older missing-data response does not replace the list');
clickControl(confirmButton);
assert(confirmSection.hidden === true && confirmBody.textContent === '' && confirmButton.textContent === '本人対応を確認する', 'closing removes the names and restores the button label');

const rollSection = panelShadow.getElementById('ofk3-rollcall');
const rollButton = panelShadow.getElementById('ofk3-rollcall-toggle');
const rollBody = panelShadow.getElementById('ofk3-rollcall-body');
const rollSummary = panelShadow.getElementById('ofk3-rollcall-summary');
assert(rollButton && rollButton.textContent === '点呼要確認一覧', 'the roll call control starts closed');
assert(rollSection && rollSection.hidden === true && rollBody.textContent === '', 'the roll call list starts hidden and empty');
assert((rollSummary.textContent || '').indexOf('閉じてはいけない氏名') < 0 && rollBody.textContent.indexOf('閉じてはいけない氏名') < 0, 'a closed roll call response does not put names in the page');
clickControl(rollButton);
assert(rollSection.hidden === false && rollButton.textContent === '点呼要確認一覧を閉じる', 'the roll call button opens the list');
assert(rollSummary.textContent.indexOf('最終取得 Scheduling') >= 0 && rollSummary.textContent.indexOf('総予約 2') >= 0 && rollSummary.textContent.indexOf('要確認人数 1') >= 0 && rollSummary.textContent.indexOf('本人照合に課題あり 1') >= 0, 'the open list shows separate totals, attention, and identity reference counts');
assert(rollBody.textContent.indexOf('一覧 太郎') >= 0 && rollBody.textContent.indexOf('一覧 太郎') < rollBody.textContent.indexOf('一覧 花子'), 'people who need review stay above the others');
assert(rollBody.textContent.indexOf('マスタ未登録') >= 0 && rollBody.textContent.indexOf('最初の開始予定・2件') >= 0, 'the open list shows department and the earliest start rule');
const rollDept = panelShadow.getElementById('ofk3-rollcall-dept');
const rollStatus = panelShadow.getElementById('ofk3-rollcall-status');
rollDept.value = 'GDSダイレクト';
(rollDept.listeners.change || []).forEach(function (fn) { fn(); });
assert(rollBody.textContent.indexOf('一覧 花子') >= 0 && rollBody.textContent.indexOf('一覧 太郎') < 0, 'department filter keeps one department');
rollDept.value = 'すべて';
(rollDept.listeners.change || []).forEach(function (fn) { fn(); });
rollStatus.value = '開始後5分以上・照合不能';
(rollStatus.listeners.change || []).forEach(function (fn) { fn(); });
assert(rollBody.textContent.indexOf('一覧 太郎') >= 0 && rollBody.textContent.indexOf('一覧 花子') < 0, 'status filter keeps one class');
const refreshBeforeRoll = panelWindow.refreshPosts;
clickControl(panelShadow.getElementById('ofk3-rollcall-refresh'));
assert(panelWindow.refreshPosts === refreshBeforeRoll + 1, 'the roll call refresh asks open pages to resend captured data');
clickControl(rollButton);
assert(rollSection.hidden === true && rollBody.textContent === '' && rollButton.textContent === '点呼要確認一覧', 'closing the roll call list removes names from the DOM');
assert(rollSummary.textContent.indexOf('一覧 太郎') < 0 && rollSummary.textContent.indexOf('一覧 花子') < 0 && rollSummary.textContent.indexOf('花子 名') < 0, 'the remaining summary has counts and capture times only');

function rollPerson(id, full, first, last, reservations) {
  return Object.assign(person(id, reservations), {
    driverName: full,
    driverFirstName: first,
    driverLastName: last
  });
}
function rollMaster(id, key, japanese, department) {
  return { name: key, japaneseName: japanese, transportId: id, department: department };
}
function rollMentor(staff, driver, first, last, active) {
  return { driverId: driver, realStaffNumber: staff, firstName: first, lastName: last, active: !!active };
}
function loadRoll(now, people, mentorRows, entries, capturedAt) {
  const pack = freshSession(now);
  const iso = capturedAt || pack.iso;
  pack.session.ingestScheduling(roster(people, iso));
  if (mentorRows) pack.session.ingestMentor(mentor(mentorRows, iso));
  if (entries) {
    pack.session.ingestMaster({
      ok: true,
      phase: 'ready',
      loadedAt: capturedAt ? Date.parse(capturedAt) : now.getTime(),
      entries: entries
    });
  }
  return pack.session;
}
function assertNoRollSecrets(view, secrets) {
  const text = JSON.stringify(view);
  secrets.forEach(function (secret) {
    assert(text.indexOf(secret) < 0, 'roll call leaked ' + secret);
  });
  assert(text.indexOf('未起動') < 0 && text.indexOf('点呼未実施') < 0, 'roll call does not assert unstarted or missed roll call');
}
const ROLL_READY = 'R12READY45NAME1';
const ROLL_MISS = 'R12MISSN45NAME1';
const ROLL_BAD = 'R12NAMES45NAME1';
const ROLL_CLASH = 'R12IDCLS45NAME1';
const ROLL_DUP = 'R12DUPID45NAME1';
const ROLL_DAY1 = 'R12DATE145NAME1';
const ROLL_DAY2 = 'R12DATE245NAME2';
const ROLL_OLD = 'R12STALE45NAME1';
const ROLL_GAP = 'R12GAPID45NAME1';
const DRV_1 = 'R12DRV0145NAME01';
const DRV_2 = 'R12DRV0245NAME02';
const DRV_3 = 'R12DRV0345NAME03';
const nineEpoch = Date.UTC(2026, 9, 12, 0, 0, 0);

const beforeRoll = loadRoll(tokyoClock(12, 8, 30), [
  rollPerson(ROLL_READY, '開始前 花子', '花子', '開始前', [block('2026-10-12', ROLL_READY, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_READY, DRV_1, '花子', '開始前', true)
], [
  rollMaster(ROLL_READY, '開始前キー', '開始前 花子', 'GDSダイレクト')
]);
const beforeView = beforeRoll.rollCallView('2026-10-12', true);
assert(beforeView.enabled && beforeView.rows.length === 1 && beforeView.rows[0].status === '開始前', 'a start in the future stays before start');
assert(beforeView.rows[0].elapsed === '開始まで 30分' && beforeView.rows[0].startLabel === '09:00（開始予定）', 'elapsed time is until the scheduled start');
assert(beforeView.rows[0].confirmation === '未確認' && beforeView.identityProven === false, 'being before start does not confirm the person');

const withinRoll = loadRoll(new Date(Date.UTC(2026, 9, 12, 0, 4, 59)), [
  rollPerson(ROLL_READY, '四分 花子', '花子', '四分', [block('2026-10-12', ROLL_READY, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_READY, DRV_1, '花子', '四分', false)
], [
  rollMaster(ROLL_READY, '四分キー', '四分 花子', 'GDSダイレクト')
]);
const withinView = withinRoll.rollCallView('2026-10-12', true);
assert(withinView.rows.length === 1 && withinView.rows[0].status === '開始後5分未満' && withinView.rows[0].elapsed === '経過 4分59秒', '4 minutes 59 seconds stays inside five minutes');

const fiveRoll = loadRoll(new Date(Date.UTC(2026, 9, 12, 0, 5, 0)), [
  rollPerson(ROLL_READY, '五分 花子', '花子', '五分', [block('2026-10-12', ROLL_READY, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_READY, DRV_1, '花子', '五分', false)
], [
  rollMaster(ROLL_READY, '五分キー', '五分 花子', 'GDS管理')
]);
const fiveView = fiveRoll.rollCallView('2026-10-12', true);
assert(fiveView.rows.length === 1 && fiveView.rows[0].status === '開始後5分以上・Active未確認' && fiveView.rows[0].elapsed === '経過 5分', 'exactly five minutes is after the boundary and not an active candidate without Active');
assert(fiveView.counts.activeCandidate === 0 && fiveView.counts.activeUnseen === 1, 'the five minute row is counted as active-unseen');

const multiNow = tokyoClock(12, 9, 6);
const multiRoll = loadRoll(multiNow, [
  rollPerson(ROLL_READY, '複数 花子', '花子', '複数', [
    block('2026-10-12', ROLL_READY, 13 * 60, Date.UTC(2026, 9, 12, 4, 0, 0)),
    block('2026-10-12', ROLL_READY, 9 * 60, nineEpoch)
  ])
], [
  rollMentor(ROLL_READY, DRV_1, '花子', '複数', true)
], [
  rollMaster(ROLL_READY, '複数キー', '複数 花子', 'GDSダイレクト')
]);
const multiView = multiRoll.rollCallView('2026-10-12', true);
assert(multiView.rows.length === 1, 'multiple blocks stay one person');
assert(multiView.rows[0].status === '開始後5分以上・Active確認候補', 'the class uses the earliest start, which is already past five minutes');
assert(multiView.rows[0].startLabel === '09:00（最初の開始予定・2件）' && multiView.rows[0].elapsed === '経過 6分', 'the row says the time is the earliest scheduled start');
assert(multiView.rows[0].mentorText === '同一人物候補 / 氏名一致候補' && multiView.rows[0].mentorName === '複数 花子', 'an active row with one id and the same name is a candidate');
assert(multiView.rows[0].confirmation === '未確認', 'an active candidate is not automatically confirmed');
const multiConfirm = multiRoll.confirmationView('2026-10-12', true);
assert(multiConfirm.enabled && multiConfirm.pending === 1 && multiConfirm.confirmed === 0, 'opening the roll call does not change confirmation');
multiRoll.rollCallView('2026-10-12', true);
assert(multiRoll.confirmationView('2026-10-12', true).confirmed === 0, 'reading the roll call does not confirm anyone');
const multiMarked = multiRoll.setConfirmation('2026-10-12', 0, 'confirmed', multiConfirm.generation);
assert(multiMarked.confirmed === 1, 'the existing confirmation button still works');
assert(multiRoll.rollCallView('2026-10-12', true).rows[0].confirmation === '確認済み', 'the roll call shows the manual confirmation');

const unseenRoll = loadRoll(multiNow, [
  rollPerson(ROLL_READY, '未確認 花子', '花子', '未確認', [block('2026-10-12', ROLL_READY, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_READY, DRV_1, '花子', '未確認', false)
], [
  rollMaster(ROLL_READY, '未確認キー', '未確認 花子', 'GDSダイレクト')
]);
const unseenView = unseenRoll.rollCallView('2026-10-12', true);
assert(unseenView.rows[0].status === '開始後5分以上・Active未確認' && unseenView.counts.activeCandidate === 0, 'a matched person without Active is not an active candidate');

const clashRoll = loadRoll(multiNow, [
  rollPerson(ROLL_CLASH, '衝突 花子', '花子', '衝突', [block('2026-10-12', ROLL_CLASH, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_CLASH, DRV_1, '花子', '衝突', true),
  rollMentor(ROLL_CLASH, DRV_2, '花子', '衝突', false)
], [
  rollMaster(ROLL_CLASH, '衝突キー', '衝突 花子', 'GDSダイレクト')
]);
const clashView = clashRoll.rollCallView('2026-10-12', true);
assert(clashView.rows.length === 1 && clashView.rows[0].status === '開始後5分以上・照合不能' && clashView.rows[0].identity === 'Mentor照合不能' && clashView.rows[0].note === 'MentorのIDが複数', 'two mentor driver ids are not an active candidate');
assert(clashView.counts.activeCandidate === 0, 'an id conflict is not counted as an active candidate');
assertNoRollSecrets(clashView, [ROLL_CLASH, DRV_1, DRV_2]);

const dupRoll = loadRoll(multiNow, [
  rollPerson(ROLL_DUP, '重複 一郎', '一郎', '重複', [block('2026-10-12', ROLL_DUP, 9 * 60, nineEpoch)]),
  rollPerson(ROLL_DUP, '重複 二郎', '二郎', '重複', [block('2026-10-12', ROLL_DUP, 10 * 60, Date.UTC(2026, 9, 12, 1, 0, 0))])
], [
  rollMentor(ROLL_DUP, DRV_1, '一郎', '重複', true)
], [
  rollMaster(ROLL_DUP, '重複キー', '重複 一郎', 'GDSダイレクト')
]);
const schedulingDupView = dupRoll.rollCallView('2026-10-12', true);
assert(schedulingDupView.rows.length === 1 && schedulingDupView.rows[0].status === '開始後5分以上・照合不能' && schedulingDupView.rows[0].schedulingName === '要確認', 'duplicate scheduling ids collapse to one review row');
assertNoRollSecrets(schedulingDupView, ['重複 一郎', '重複 二郎', ROLL_DUP]);

const nameRoll = loadRoll(multiNow, [
  rollPerson(ROLL_BAD, '氏名 花子', '花子', '氏名', [block('2026-10-12', ROLL_BAD, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_BAD, DRV_1, '健', '高橋', true)
], [
  rollMaster(ROLL_BAD, '氏名キー', '氏名 花子', 'GDSダイレクト')
]);
const nameView = nameRoll.rollCallView('2026-10-12', true);
assert(nameView.rows[0].status === '開始後5分以上・照合不能' && nameView.rows[0].identity === '氏名不一致' && nameView.rows[0].note === '氏名不一致' && nameView.counts.activeCandidate === 0, 'a different mentor name is not an active candidate');
assert(nameView.rows[0].mentorName === '高橋 健' && nameView.rows[0].confirmation === '未確認', 'the differing mentor name can be shown without confirming the person');

const missingMaster = loadRoll(multiNow, [
  rollPerson(ROLL_READY, '登録 花子', '花子', '登録', [block('2026-10-12', ROLL_READY, 8 * 60, Date.UTC(2026, 9, 11, 23, 0, 0))]),
  rollPerson(ROLL_MISS, '未登録 三郎', '三郎', '未登録', [block('2026-10-12', ROLL_MISS, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_READY, DRV_1, '花子', '登録', true),
  rollMentor(ROLL_MISS, DRV_3, '三郎', '未登録', true)
], [
  rollMaster(ROLL_READY, '登録キー', '登録 花子', 'GDSダイレクト')
]);
const missingView = missingMaster.rollCallView('2026-10-12', true);
assert(missingView.enabled && missingView.rows.length === 2, 'an unregistered person stays on the roll call list');
assert(missingView.rows[0].schedulingName === '未登録 三郎' && missingView.rows[0].masterName === 'マスタ未登録' && missingView.rows[0].department === 'マスタ未登録', 'the unregistered person is labeled from scheduling and the master gap');
assert(missingView.rows[0].status === '開始後5分以上・照合不能' && missingView.rows[0].identity === 'OFK3マスタ未登録' && missingView.rows[1].status === '開始後5分以上・Active確認候補', 'after five minutes, an unregistered person stays above an active candidate');
const confirmBeside = missingMaster.confirmationView('2026-10-12', true);
assert(confirmBeside.enabled && confirmBeside.rows.length === 1 && confirmBeside.unregistered === 1, 'confirmation keeps the unique match and counts the unregistered person separately');
assert(JSON.stringify(confirmBeside).indexOf('未登録 三郎') < 0, 'the confirmation list does not take the unregistered scheduling name');
assertNoRollSecrets(missingView, [ROLL_READY, ROLL_MISS, DRV_1, DRV_3]);

const gapRoll = loadRoll(multiNow, [
  rollPerson(ROLL_GAP, '欠け 氏名', '氏名', '欠け', [block('2026-10-12', ROLL_GAP, 9 * 60, nineEpoch)])
], null, [
  rollMaster(ROLL_GAP, '欠けキー', '欠け 氏名', 'GDSダイレクト')
]);
const gapView = gapRoll.rollCallView('2026-10-12', true);
assert(gapView.enabled === false && gapView.reason === '取得不足' && gapView.detail === '未取得' && gapView.rows.length === 0, 'missing mentor data does not classify anyone');
assertNoRollSecrets(gapView, ['欠け 氏名', ROLL_GAP]);

const oldIso = new Date(multiNow.getTime() - 16 * 60000).toISOString();
const oldRoll = loadRoll(multiNow, [
  rollPerson(ROLL_OLD, '古い 氏名', '氏名', '古い', [block('2026-10-12', ROLL_OLD, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_OLD, DRV_1, '氏名', '古い', true)
], [
  rollMaster(ROLL_OLD, '古いキー', '古い 氏名', 'GDSダイレクト')
], oldIso);
const oldView = oldRoll.rollCallView('2026-10-12', true);
assert(oldView.enabled === false && oldView.reason === '取得不足' && oldView.detail === '取得が古い' && oldView.rows.length === 0, 'stale data is shown as insufficient and is not classified');
assertNoRollSecrets(oldView, ['古い 氏名', ROLL_OLD, DRV_1]);
assert(oldView.captured.scheduling === oldIso && oldView.captured.mentor === oldIso, 'stale capture times stay visible');

const dateRoll = loadRoll(tokyoClock(12, 10, 0), [
  rollPerson(ROLL_DAY1, '日付 一郎', '一郎', '日付', [block('2026-10-12', ROLL_DAY1, 9 * 60, nineEpoch)]),
  rollPerson(ROLL_DAY2, '日付 次郎', '次郎', '日付', [block('2026-10-13', ROLL_DAY2, 9 * 60, Date.UTC(2026, 9, 13, 0, 0, 0))])
], [
  rollMentor(ROLL_DAY1, DRV_1, '一郎', '日付', true),
  rollMentor(ROLL_DAY2, DRV_2, '次郎', '日付', true)
], [
  rollMaster(ROLL_DAY1, '日付キー', '日付 一郎', 'GDSダイレクト'),
  rollMaster(ROLL_DAY2, '翌日キー', '日付 次郎', 'GDS管理')
]);
const dayOne = dateRoll.rollCallView('2026-10-12', true);
const dayTwo = dateRoll.rollCallView('2026-10-13', true);
assert(dayOne.date === '2026-10-12' && dayOne.rows.length === 1 && dayOne.rows[0].schedulingName === '日付 一郎' && dayOne.rows[0].status === '開始後5分以上・Active確認候補', 'the selected date keeps that day only');
assert(dayTwo.date === '2026-10-13' && dayTwo.rows.length === 1 && dayTwo.rows[0].schedulingName === '日付 次郎' && dayTwo.rows[0].status === '開始前', 'the next date uses that date’s own start');
assert(JSON.stringify(dayOne).indexOf('日付 次郎') < 0 && JSON.stringify(dayTwo).indexOf('日付 一郎') < 0, 'switching dates does not keep the other day’s name');
const dayClosed = dateRoll.rollCallView('2026-10-12', false);
assert(dayClosed.namesShown === false && dayClosed.rows.length === 0 && dayClosed.counts.activeCandidate === 1, 'a closed roll call keeps counts and drops names');
assertNoRollSecrets(dayClosed, ['日付 一郎', '日付 次郎', ROLL_DAY1, ROLL_DAY2, DRV_1, DRV_2]);
const dateCopy = Core.copyPayload(dateRoll.read('2026-10-12'), '2026-10-12');
['日付 一郎', '日付 次郎', '日付キー', '翌日キー', ROLL_DAY1, ROLL_DAY2, DRV_1, DRV_2].forEach(function (secret) {
  assert(dateCopy.indexOf(secret) < 0, 'diagnostic copy has no roll call personal value: ' + secret);
});
assert(dateCopy.indexOf('点呼未実施') < 0 && dateCopy.indexOf('未起動候補') < 0, 'diagnostic copy does not assert a missed roll call');

function rollAttention(counts) {
  return counts.activeUnseen + counts.after5Unmatched + counts.unknownTime;
}
function rollPartition(counts) {
  return counts.before + counts.within5 + counts.activeCandidate + counts.activeUnseen + counts.after5Unmatched + counts.unknownTime;
}
const ROLL_BMENT = 'R12BMENT45NAME1';
const ROLL_BMAST = 'R12BMAST45NAME1';
const ROLL_FNAME = 'R12FNAME45NAME1';
const ROLL_FACT = 'R12FACTV45NAME1';
const ROLL_UNK = 'R12UNKTM45NAME1';
const DRV_4 = 'R12DRV0445NAME04';
const DRV_5 = 'R12DRV0545NAME05';
const earlyNow = tokyoClock(12, 8, 30);
const beforeMentor = loadRoll(earlyNow, [
  rollPerson(ROLL_BMENT, '開始前 不能', '不能', '開始前', [block('2026-10-12', ROLL_BMENT, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_BMENT, DRV_4, '不能', '開始前', false),
  rollMentor(ROLL_BMENT, DRV_5, '不能', '開始前', false)
], [
  rollMaster(ROLL_BMENT, '不能キー', '開始前 不能', 'GDSダイレクト')
]);
const beforeMentorView = beforeMentor.rollCallView('2026-10-12', true);
assert(beforeMentorView.rows[0].status === '開始前' && beforeMentorView.rows[0].timeStatus === '開始前' && beforeMentorView.rows[0].identity === 'Mentor照合不能', 'a mentor conflict before start stays before start');
assert(beforeMentorView.counts.before === 1 && beforeMentorView.counts.identityIssues === 1 && rollAttention(beforeMentorView.counts) === 0, 'a before-start identity issue is a reference count only');

const beforeMaster = loadRoll(earlyNow, [
  rollPerson(ROLL_BMAST, '開始前 未登録', '未登録', '開始前', [block('2026-10-12', ROLL_BMAST, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_BMAST, DRV_4, '未登録', '開始前', true)
], []);
const beforeMasterView = beforeMaster.rollCallView('2026-10-12', true);
assert(beforeMasterView.rows[0].status === '開始前' && beforeMasterView.rows[0].identity === 'OFK3マスタ未登録' && beforeMasterView.rows[0].masterName === 'マスタ未登録', 'an unregistered person before start stays before start');
assert(beforeMasterView.counts.before === 1 && beforeMasterView.counts.identityIssues === 1 && rollAttention(beforeMasterView.counts) === 0, 'an unregistered person before start is not an attention count');
assert(beforeMasterView.rows[0].note === 'マスタ未登録', 'the master gap stays visible as auxiliary text');

const fiveEdge = new Date(Date.UTC(2026, 9, 12, 0, 5, 0));
const fiveMismatch = loadRoll(fiveEdge, [
  rollPerson(ROLL_FNAME, '五分 不一致', '不一致', '五分', [block('2026-10-12', ROLL_FNAME, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_FNAME, DRV_4, '健', '高橋', true)
], [
  rollMaster(ROLL_FNAME, '不一致キー', '五分 不一致', 'GDSダイレクト')
]);
const fiveMismatchView = fiveMismatch.rollCallView('2026-10-12', true);
assert(fiveMismatchView.rows[0].status === '開始後5分以上・照合不能' && fiveMismatchView.rows[0].identity === '氏名不一致' && fiveMismatchView.rows[0].elapsed === '経過 5分', 'a name mismatch at five minutes is unmatched, not an active candidate');
assert(fiveMismatchView.counts.activeCandidate === 0 && fiveMismatchView.counts.activeUnseen === 0 && fiveMismatchView.counts.after5Unmatched === 1, 'the mismatched five minute row is only in the unmatched count');

const fiveActive = loadRoll(fiveEdge, [
  rollPerson(ROLL_FACT, '五分 一致', '一致', '五分', [block('2026-10-12', ROLL_FACT, 9 * 60, nineEpoch)])
], [
  rollMentor(ROLL_FACT, DRV_4, '一致', '五分', true)
], [
  rollMaster(ROLL_FACT, '一致キー', '五分 一致', 'GDSダイレクト')
]);
const fiveActiveView = fiveActive.rollCallView('2026-10-12', true);
assert(fiveActiveView.rows[0].status === '開始後5分以上・Active確認候補' && fiveActiveView.rows[0].identity === 'ID・氏名一致候補' && fiveActiveView.rows[0].confirmation === '未確認' && fiveActiveView.rows[0].elapsed === '経過 5分', 'an active name and id match at five minutes is a candidate and stays unconfirmed');
assert(fiveActiveView.counts.identityIssues === 0 && fiveActiveView.counts.activeCandidate === 1, 'a clean active candidate is not an identity issue');

const unknownRoll = loadRoll(fiveEdge, [
  rollPerson(ROLL_UNK, '時刻 不明', '不明', '時刻', [block('2026-10-12', ROLL_UNK, null, null)])
], [
  rollMentor(ROLL_UNK, DRV_4, '不明', '時刻', true)
], [
  rollMaster(ROLL_UNK, '不明キー', '時刻 不明', 'GDSダイレクト')
]);
const unknownView = unknownRoll.rollCallView('2026-10-12', true);
assert(unknownView.rows[0].status === '時刻不明' && unknownView.rows[0].timeStatus === '時刻不明' && unknownView.rows[0].identity === 'ID・氏名一致候補', 'a missing start time stays in its own class');
assert(unknownView.counts.unknownTime === 1 && unknownView.counts.identityIssues === 0 && rollAttention(unknownView.counts) === 1, 'unknown time is attention without becoming an identity issue');

const PART = {
  beforeMentor: 'R12PART145NAME01',
  beforeMaster: 'R12PART245NAME02',
  waiting: 'R12PART345NAME03',
  unseen: 'R12PART445NAME04',
  mismatch: 'R12PART545NAME05',
  active: 'R12PART645NAME06',
  unknown: 'R12PART745NAME07'
};
const partRoll = loadRoll(fiveEdge, [
  rollPerson(PART.beforeMentor, '集計 不能', '不能', '集計', [block('2026-10-12', PART.beforeMentor, 10 * 60, Date.UTC(2026, 9, 12, 1, 0, 0))]),
  rollPerson(PART.beforeMaster, '集計 未登録', '未登録', '集計', [block('2026-10-12', PART.beforeMaster, 10 * 60 + 30, Date.UTC(2026, 9, 12, 1, 30, 0))]),
  rollPerson(PART.waiting, '集計 待機', '待機', '集計', [block('2026-10-12', PART.waiting, 9 * 60 + 1, Date.UTC(2026, 9, 12, 0, 1, 0))]),
  rollPerson(PART.unseen, '集計 未確認', '未確認', '集計', [block('2026-10-12', PART.unseen, 9 * 60, nineEpoch)]),
  rollPerson(PART.mismatch, '集計 不一致', '不一致', '集計', [block('2026-10-12', PART.mismatch, 9 * 60, nineEpoch)]),
  rollPerson(PART.active, '集計 候補', '候補', '集計', [block('2026-10-12', PART.active, 9 * 60, nineEpoch)]),
  rollPerson(PART.unknown, '集計 不明', '不明', '集計', [block('2026-10-12', PART.unknown, null, null)])
], [
  rollMentor(PART.beforeMentor, DRV_4, '不能', '集計', false),
  rollMentor(PART.beforeMentor, DRV_5, '不能', '集計', false),
  rollMentor(PART.beforeMaster, DRV_4, '未登録', '集計', true),
  rollMentor(PART.waiting, DRV_4, '待機', '集計', false),
  rollMentor(PART.unseen, DRV_4, '未確認', '集計', false),
  rollMentor(PART.mismatch, DRV_4, '健', '高橋', true),
  rollMentor(PART.active, DRV_4, '候補', '集計', true),
  rollMentor(PART.unknown, DRV_4, '不明', '集計', true)
], [
  rollMaster(PART.beforeMentor, '不能キー', '集計 不能', 'GDSダイレクト'),
  rollMaster(PART.waiting, '待機キー', '集計 待機', 'GDSダイレクト'),
  rollMaster(PART.unseen, '未確認キー', '集計 未確認', 'GDS管理'),
  rollMaster(PART.mismatch, '不一致キー', '集計 不一致', 'GDSダイレクト'),
  rollMaster(PART.active, '候補キー', '集計 候補', 'GDSダイレクト'),
  rollMaster(PART.unknown, '不明キー', '集計 不明', 'GDSダイレクト')
]);
const partView = partRoll.rollCallView('2026-10-12', true);
assert(partView.counts.total === 7 && rollPartition(partView.counts) === partView.counts.total, 'time classes add up to the reserved people');
assert(partView.counts.before === 2 && partView.counts.within5 === 1 && partView.counts.activeUnseen === 1 && partView.counts.after5Unmatched === 1 && partView.counts.activeCandidate === 1 && partView.counts.unknownTime === 1, 'each person is in one time class');
assert(partView.counts.identityIssues === 3 && rollAttention(partView.counts) === 3, 'identity issues overlap the time classes and before-start issues stay out of attention');
assert(partView.rows[0].status === '開始後5分以上・Active未確認' && partView.rows[1].status === '開始後5分以上・照合不能' && partView.rows[2].status === '時刻不明', 'attention rows stay above the normal rows');
assert(partView.rows.filter(function (row) { return row.status === '開始前'; }).length === 2, 'both before-start people stay in that class');
assert(partView.rows.every(function (row) { return row.confirmation === '未確認'; }), 'the classification does not confirm anyone');
const partClosed = partRoll.rollCallView('2026-10-12', false);
assert(partClosed.rows.length === 0 && partClosed.counts.total === 7, 'closing the list drops names and keeps the totals');
const partSecrets = ['集計 不能', '集計 未登録', '集計 待機', '集計 未確認', '集計 不一致', '集計 候補', '集計 不明', '不能キー', '待機キー', '未確認キー', '不一致キー', '候補キー', '不明キー', '高橋 健'].concat(Object.keys(PART).map(function (key) { return PART[key]; }), [DRV_4, DRV_5]);
assertNoRollSecrets(partClosed, partSecrets);
partSecrets.forEach(function (secret) {
  assert(Core.copyPayload(partRoll.read('2026-10-12'), '2026-10-12').indexOf(secret) < 0, 'diagnostic copy has no partition personal value: ' + secret);
});

const HIST_DAY = '2026-10-13';
const histDayStart = Date.UTC(2026, 9, 12, 15, 0, 0);
const histNextStart = histDayStart + 86400000;
const histSameMs = Date.UTC(2026, 9, 13, 2, 0, 0);
const histPrevSec = Math.floor(Date.UTC(2026, 9, 12, 9, 0, 0) / 1000);
const histPrevBoundarySec = Math.floor(Date.UTC(2026, 9, 12, 14, 59, 59) / 1000);
const histOtherMs = Date.UTC(2026, 9, 13, 16, 0, 0);
const HIST_FP = 'SECRET-FLEET-HISTORY';
const HIST_STAFF = 'SECRET-STAFF-HISTORY';
const HIST_STAFF_2 = 'SECRET-STAFF-HISTORY-2';
const HIST_DRIVER = 'SECRET-DRIVER-HISTORY';
const HIST_DRIVER_2 = 'SECRET-DRIVER-HISTORY-2';
const HIST_NAME = 'Secret History Person';
const HIST_OPAQUE = '9988776655';
function historyUrl(start, end, date, fp) {
  var url = 'https://vrm-mentor.edriving.com/reports/driver/shifts?decorate=yes&startTime=' + start + '&endTime=' + end;
  if (date) url += '&localDate=' + date;
  if (fp) url += '&fpId=' + fp;
  return url;
}
const historyBody = {
  data: [
    { driverId: HIST_DRIVER, realStaffNumber: HIST_STAFF, firstName: HIST_NAME, lastName: 'Alpha', shiftStartTime: histDayStart, shiftEndTime: 'N/A', vrmStatus: 'Active' },
    { driverId: HIST_DRIVER, realStaffNumber: HIST_STAFF, firstName: HIST_NAME, lastName: 'Alpha', shiftStartTime: String(histSameMs), shiftEndTime: histSameMs, vrmStatus: 'Complete' },
    { driverId: HIST_DRIVER_2, realStaffNumber: HIST_STAFF_2, firstName: 'Beta', lastName: 'Person', shiftStartTime: null, shiftEndTime: histPrevSec, vrmStatus: 'Idle' },
    { realStaffNumber: 'H3DATE45NAME01', shiftEndTime: String(histPrevBoundarySec), vrmStatus: 'Parked' },
    { realStaffNumber: 'H4DATE45NAME01', shiftEndTime: '2026-10-12T15:00:00.000Z' },
    { realStaffNumber: 'H5DATE45NAME01', shiftEndTime: '2026-10-13T00:30:00' },
    { realStaffNumber: 'H6DATE45NAME01', shiftEndTime: '12:15' },
    { realStaffNumber: 'H7DATE45NAME01', shiftEndTime: null },
    { realStaffNumber: 'H8DATE45NAME01' },
    { realStaffNumber: 'H9DATE45NAME01', shiftEndTime: 10 },
    { realStaffNumber: 'H10DATE45NAME1', shiftEndTime: '2026-02-31T00:00:00Z' },
    { realStaffNumber: 'H11DATE45NAME1', shiftEndTime: histOtherMs, vrmStatus: 'Active' },
    { driverId: HIST_DRIVER, realStaffNumber: 'H12DATE45NAME01', firstName: HIST_NAME, lastName: 'Alpha', shiftEndTime: histSameMs, vrmStatus: 'Complete' },
    { driverId: HIST_DRIVER_2, realStaffNumber: 'H12DATE45NAME01', firstName: 'Other', lastName: 'Name', shiftEndTime: histSameMs, vrmStatus: 'Idle' },
    { realStaffNumber: 'H13DATE45NAME1', shiftEndTime: 'not-a-time' },
    { realStaffNumber: 'H14DATE45NAME1', shiftEndTime: 'N/A' },
    { realStaffNumber: 'H15DATE45NAME1', shiftEndTime: 'N/A', vrmStatus: HIST_OPAQUE }
  ]
};
const historyDigest = Core.mentorDigest(historyBody, FRESH, historyUrl(histDayStart, histNextStart, HIST_DAY, HIST_FP));
const history = historyDigest.history;
assert(history.available === true && history.rangeStatus === 'verified', 'a full-day query range is verified');
assert(history.targetDate === HIST_DAY && history.rangeStartDate === HIST_DAY && history.rangeEndDate === '2026-10-14', 'range dates are JST calendar dates');
assert(history.includesTarget === true && history.coversFullTargetDay === true, 'the full-day range includes and covers the target');
assert(history.localDateParse === 'ok' && history.startTimeParse === 'ok' && history.endTimeParse === 'ok', 'query datetimes parse');
assert(history.fpIdPresent === true && history.returnCompleteness === 'unverified', 'fpId is presence only and completeness stays unverified');
assert(history.startTypes.number === 1 && history.startTypes.numericString === 1 && history.startTypes.nullish === 15, 'start types keep number, numeric string, and nullish apart');
assert(history.startEpoch.epochMs === 2 && history.startEpoch.epochSec === 0 && history.startEpoch.unparseable === 0, 'valid start epochs are milliseconds');
assert(history.endTypes.na === 3 && history.endTypes.number === 6 && history.endTypes.numericString === 1 && history.endTypes.timeString === 1 && history.endTypes.isoDatetime === 3 && history.endTypes.nullish === 2 && history.endTypes.other === 1, 'end types match the fixture mix');
assert(history.endEpoch.epochMs === 4 && history.endEpoch.epochSec === 2 && history.endEpoch.unparseable === 1, 'end epochs split milliseconds, seconds, and invalid numbers');
assert(history.endDates.sameDay === 5 && history.endDates.previousDay === 2 && history.endDates.otherDay === 1 && history.endDates.undated === 9 && history.endDates.targetUnverified === 0, 'JST end dates keep the midnight boundary and leave time-only strings undated');
assert(history.vrmStatus.active === 2 && history.vrmStatus.endNA.active === 1 && history.vrmStatus.notEndNA.active === 1, 'Active status is counted apart from the open-row condition');
assert(history.vrmStatus.endNA.missing === 1 && history.vrmStatus.other.some(function (item) { return item.status === '(opaque)' && item.count === 1; }), 'unsafe status text is opaque and N/A missing status stays missing');
assert(history.sessions.multiRowIdentifiers === 2 && history.sessions.mixedActiveCandidates === 1 && history.sessions.parseableEndCandidates === 7 && history.sessions.identityConflictCandidates === 1, 'session counts stay aggregate');
assert(historyDigest.rows.filter(function (row) { return row.active; }).length === 1, 'only N/A and Active stays the open row');
assert(historyDigest.rows[11].active === false, 'Active status with an end time is not an open row');
const historySecrets = [HIST_FP, HIST_STAFF, HIST_STAFF_2, HIST_DRIVER, HIST_DRIVER_2, HIST_NAME, HIST_OPAQUE, '12:15', String(histSameMs), 'not-a-time'];
const historyCopy = Core.copyPayload(Core.createSession(function () { return NOW; }).ingestMentor(historyDigest), HIST_DAY);
historySecrets.forEach(function (secret) {
  assert(historyCopy.indexOf(secret) < 0, 'history copy leaked ' + secret);
});
assert(historyCopy.indexOf('取得範囲: verified') > 0 && historyCopy.indexOf('対象日と同日 5') > 0 && historyCopy.indexOf('API返却の完全性: 断定しない') > 0, 'history copy shows the safe aggregates');
assert(historyCopy.indexOf('点呼完了の判定: しない') > 0 && historyCopy.indexOf('未起動判定: しない') > 0 && historyCopy.indexOf('個人別の当日稼働履歴: 確定しない') > 0, 'history copy does not confirm a person or a completed roll call');
assert(historyCopy.indexOf('http') < 0 && historyCopy.indexOf('fpId=') < 0, 'history copy has no url');

const partialHistory = Core.mentorDigest({ data: [{ shiftEndTime: 'N/A', vrmStatus: 'Active' }] }, FRESH, historyUrl(histDayStart + 9 * 3600000, histDayStart + 12 * 3600000, HIST_DAY, '')).history;
assert(partialHistory.rangeStatus === 'verified' && partialHistory.includesTarget === true && partialHistory.coversFullTargetDay === false && partialHistory.fpIdPresent === false, 'a partial window includes the target day without covering it');
const outsideHistory = Core.mentorDigest({ data: [{ shiftEndTime: 'N/A', vrmStatus: 'Active' }] }, FRESH, historyUrl(histDayStart - 86400000, histDayStart, HIST_DAY, '')).history;
assert(outsideHistory.rangeStatus === 'verified' && outsideHistory.includesTarget === false && outsideHistory.coversFullTargetDay === false, 'a range that ends at the target midnight does not include the target day');
const reversedHistory = Core.mentorDigest({ data: [{ shiftEndTime: histSameMs }] }, FRESH, historyUrl(histNextStart, histDayStart, HIST_DAY, '')).history;
assert(reversedHistory.rangeStatus === 'range-unverified' && reversedHistory.includesTarget === null && reversedHistory.coversFullTargetDay === null, 'a reversed range stays unverified');
const bareHistory = Core.mentorDigest({ data: [{ shiftEndTime: histSameMs, realStaffNumber: HIST_STAFF }] }, FRESH).history;
assert(bareHistory.rangeStatus === 'range-unverified' && bareHistory.localDateParse === 'missing' && bareHistory.endDates.sameDay === 0 && bareHistory.endDates.targetUnverified === 1 && bareHistory.endDates.undated === 0, 'without a target date, a parsed end is not called same-day');
const badDateHistory = Core.mentorDigest({ data: [{ shiftEndTime: 'N/A' }] }, FRESH, historyUrl(histDayStart, histNextStart, '2026-02-31', '')).history;
assert(badDateHistory.rangeStatus === 'range-unverified' && badDateHistory.localDateParse === 'failed' && badDateHistory.targetDate === '', 'an impossible localDate fails closed');
assert(JSON.stringify(bareHistory).indexOf(HIST_STAFF) < 0, 'a staff id is not part of the history aggregate');

const classNow = tokyoClock(13, 9, 10);
const classPack = freshSession(classNow);
const classActive = 'H1ACTIV45NAME01';
const classEnded = 'H1ENDED45NAME01';
const classDigest = Core.mentorDigest({
  data: [
    { driverId: 'DRV-CLASS-1', realStaffNumber: classActive, firstName: '候補', lastName: '分類', shiftEndTime: 'N/A', vrmStatus: 'Active' },
    { driverId: 'DRV-CLASS-1', realStaffNumber: classActive, firstName: '候補', lastName: '分類', shiftEndTime: Date.UTC(2026, 9, 13, 1, 0, 0), vrmStatus: 'Complete' },
    { driverId: 'DRV-CLASS-2', realStaffNumber: classEnded, firstName: '終了', lastName: '分類', shiftEndTime: Date.UTC(2026, 9, 13, 1, 0, 0), vrmStatus: 'Complete' }
  ]
}, classPack.iso, historyUrl(histDayStart, histNextStart, HIST_DAY, HIST_FP));
classPack.session.ingestScheduling(roster([
  rollPerson(classActive, '分類 候補', '候補', '分類', [block('2026-10-13', classActive, 9 * 60, Date.UTC(2026, 9, 13, 0, 0, 0))]),
  rollPerson(classEnded, '分類 終了', '終了', '分類', [block('2026-10-13', classEnded, 9 * 60, Date.UTC(2026, 9, 13, 0, 0, 0))])
], classPack.iso));
classPack.session.ingestMentor(classDigest);
classPack.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: classNow.getTime(),
  entries: [
    rollMaster(classActive, '候補キー', '分類 候補', 'GDSダイレクト'),
    rollMaster(classEnded, '終了キー', '分類 終了', 'GDSダイレクト')
  ]
});
const classView = classPack.session.rollCallView('2026-10-13', true);
assert(classView.counts.total === 2 && classView.counts.activeCandidate === 1 && classView.counts.activeUnseen === 1 && classView.counts.before === 0 && classView.counts.after5Unmatched === 0, 'same-day history does not change the roll call counts');
assert(classView.rows.map(function (row) { return row.status; }).sort().join('|') === '開始後5分以上・Active未確認|開始後5分以上・Active確認候補', 'an ended session stays Active未確認 and an open row stays a candidate');
assert(classView.rows.every(function (row) { return row.confirmation === '未確認'; }), 'history diagnostics do not confirm anyone');
const earlyPack = freshSession(tokyoClock(13, 8, 30));
earlyPack.session.ingestScheduling(roster([
  rollPerson(classActive, '分類 候補', '候補', '分類', [block('2026-10-13', classActive, 9 * 60, Date.UTC(2026, 9, 13, 0, 0, 0))])
], earlyPack.iso));
earlyPack.session.ingestMentor(Core.mentorDigest({
  data: [{ driverId: 'DRV-CLASS-1', realStaffNumber: classActive, firstName: '候補', lastName: '分類', shiftEndTime: Date.UTC(2026, 9, 12, 23, 0, 0), vrmStatus: 'Complete' }]
}, earlyPack.iso, historyUrl(histDayStart, histNextStart, HIST_DAY, '')));
earlyPack.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: tokyoClock(13, 8, 30).getTime(),
  entries: [rollMaster(classActive, '候補キー', '分類 候補', 'GDSダイレクト')]
});
assert(earlyPack.session.rollCallView('2026-10-13', true).rows[0].status === '開始前', 'a parsed end time before the start stays before start');
const withinPack = freshSession(new Date(Date.UTC(2026, 9, 13, 0, 4, 0)));
withinPack.session.ingestScheduling(roster([
  rollPerson(classEnded, '分類 終了', '終了', '分類', [block('2026-10-13', classEnded, 9 * 60, Date.UTC(2026, 9, 13, 0, 0, 0))])
], withinPack.iso));
withinPack.session.ingestMentor(Core.mentorDigest({
  data: [{ driverId: 'DRV-CLASS-2', realStaffNumber: classEnded, firstName: '終了', lastName: '分類', shiftEndTime: '12:15', vrmStatus: 'Complete' }]
}, withinPack.iso, historyUrl(histDayStart, histNextStart, HIST_DAY, '')));
withinPack.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: withinPack.now.getTime(),
  entries: [rollMaster(classEnded, '終了キー', '分類 終了', 'GDSダイレクト')]
});
assert(withinPack.session.rollCallView('2026-10-13', true).rows[0].status === '開始後5分未満', 'a time-only end string does not move a row out of the five-minute wait');
const stalePack = freshSession(classNow);
const staleIso = new Date(classNow.getTime() - 16 * 60000).toISOString();
stalePack.session.ingestScheduling(roster([
  rollPerson(classEnded, '分類 終了', '終了', '分類', [block('2026-10-13', classEnded, 9 * 60, Date.UTC(2026, 9, 13, 0, 0, 0))])
], staleIso));
stalePack.session.ingestMentor(Core.mentorDigest({
  data: [{ driverId: 'DRV-CLASS-2', realStaffNumber: classEnded, firstName: '終了', lastName: '分類', shiftEndTime: histSameMs, vrmStatus: 'Complete' }]
}, staleIso, historyUrl(histDayStart, histNextStart, HIST_DAY, '')));
stalePack.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: classNow.getTime() - 16 * 60000,
  entries: [rollMaster(classEnded, '終了キー', '分類 終了', 'GDSダイレクト')]
});
const staleClass = stalePack.session.rollCallView('2026-10-13', true);
assert(staleClass.enabled === false && staleClass.reason === '取得不足' && staleClass.rows.length === 0, 'history diagnostics do not bypass the 15 minute gate');
const classCopy = Core.copyPayload(classPack.session.read('2026-10-13'), '2026-10-13');
['分類 候補', '分類 終了', '候補キー', '終了キー', classActive, classEnded, HIST_FP, 'DRV-CLASS-1', 'DRV-CLASS-2'].forEach(function (secret) {
  assert(classCopy.indexOf(secret) < 0, 'classification copy leaked ' + secret);
});
assert(classCopy.indexOf('fetch(') < 0 && classCopy.indexOf('XMLHttpRequest') < 0, 'diagnostic copy contains no request call');
assert(read('cortex-capture-extension/id-diag-core.js').indexOf("row.shiftEndTime === 'N/A' && row.vrmStatus === 'Active'") > 0, 'the open active condition is unchanged');
assert(read('cortex-capture-extension/id-diag-core.js').indexOf('fetch(') < 0 && read('cortex-capture-extension/id-diag-core.js').indexOf('XMLHttpRequest') < 0, 'history summary adds no network call');

const refNow = tokyoClock(13, 9, 10);
const refPack = freshSession(refNow);
const refUrl = historyUrl(histDayStart, histNextStart, HIST_DAY, '');
const REF = {
  ended: 'R1ENDED45NAME01',
  prev: 'R1PREV045NAME01',
  both: 'R1BOTH045NAME01',
  multi: 'R1MULTI45NAME01',
  clash: 'R1CLASH45NAME01',
  name: 'R1NAMES45NAME01',
  nomaster: 'R1NOMST45NAME01',
  nomentor: 'R1NOMNT45NAME01',
  open: 'R1OPEN045NAME01',
  bad: 'R1BADTM45NAME01',
  boundary: 'R1BOUND45NAME01',
  next: 'R1NEXT045NAME01',
  before: 'R1BEFOR45NAME01',
  within: 'R1WITHN45NAME01'
};
const refDriver = {
  ended: 'R1DRVEND45NAME01',
  prev: 'R1DRVPRV45NAME01',
  both: 'R1DRVBOT45NAME01',
  multi: 'R1DRVMLT45NAME01',
  clashA: 'R1DRVCL145NAME01',
  clashB: 'R1DRVCL245NAME01',
  name: 'R1DRVNAM45NAME01',
  nomaster: 'R1DRVNOM45NAME01',
  open: 'R1DRVOPN45NAME01',
  bad: 'R1DRVBAD45NAME01',
  boundary: 'R1DRVBND45NAME01',
  next: 'R1DRVNXT45NAME01',
  before: 'R1DRVBFR45NAME01',
  within: 'R1DRVWTN45NAME01'
};
function refPerson(id, family, given, minutes) {
  return rollPerson(id, family + ' ' + given, given, family, [block('2026-10-13', id, minutes, Date.UTC(2026, 9, 13, 0, 0, 0))]);
}
function refMentor(staff, driver, family, given, end) {
  return { driverId: driver, realStaffNumber: staff, firstName: given, lastName: family, shiftEndTime: end, vrmStatus: 'Active' };
}
const refDigest = Core.mentorDigest({
  data: [
    refMentor(REF.ended, refDriver.ended, '終了', 'あり', histSameMs),
    refMentor(REF.prev, refDriver.prev, '前日', 'のみ', histPrevSec * 1000),
    refMentor(REF.both, refDriver.both, '両方', 'あり', 'N/A'),
    refMentor(REF.both, refDriver.both, '両方', 'あり', histSameMs),
    refMentor(REF.multi, refDriver.multi, '複数', '終了', histSameMs),
    refMentor(REF.multi, refDriver.multi, '複数', '終了', histSameMs + 60000),
    refMentor(REF.clash, refDriver.clashA, '衝突', '識別', histSameMs),
    refMentor(REF.clash, refDriver.clashB, '衝突', '識別', histSameMs),
    refMentor(REF.name, refDriver.name, '高橋', '健', histSameMs),
    refMentor(REF.nomaster, refDriver.nomaster, '未登録', 'マスタ', histSameMs),
    refMentor(REF.open, refDriver.open, '稼働', '中', 'N/A'),
    refMentor(REF.bad, refDriver.bad, '不正', '時刻', 10),
    refMentor(REF.boundary, refDriver.boundary, '境界', '当日', histDayStart),
    refMentor(REF.next, refDriver.next, '境界', '翌日', histNextStart),
    refMentor(REF.before, refDriver.before, '開始前', '履歴', histSameMs),
    refMentor(REF.within, refDriver.within, '待機', '中', 'N/A')
  ]
}, refPack.iso, refUrl);
assert(refDigest.rows.filter(function (row) { return row.realStaffNumber === REF.both && row.active; }).length === 1, 'an N/A Active row stays active beside a same-day end');
assert(refDigest.rows.filter(function (row) { return row.realStaffNumber === REF.both && row.active === false && row.endDate === HIST_DAY; }).length === 1, 'a numeric end on an Active status is not a current active row');
assert(refDigest.rows.filter(function (row) { return row.realStaffNumber === REF.open; })[0].endDate === '', 'N/A does not become an end date');
assert(refDigest.rows.filter(function (row) { return row.realStaffNumber === REF.bad; })[0].endDate === '', 'an invalid end number does not become a date');
assert(refDigest.rows.filter(function (row) { return row.realStaffNumber === REF.boundary; })[0].endDate === HIST_DAY, 'JST midnight is the same day');
assert(refDigest.rows.filter(function (row) { return row.realStaffNumber === REF.next; })[0].endDate === '2026-10-14', 'the next JST midnight is the next day');
assert(refDigest.rows.filter(function (row) { return row.realStaffNumber === REF.prev; })[0].endDate === '2026-10-12', 'the previous JST day stays previous');
refPack.session.ingestScheduling(roster([
  refPerson(REF.ended, '終了', 'あり', 9 * 60),
  refPerson(REF.prev, '前日', 'のみ', 9 * 60),
  refPerson(REF.both, '両方', 'あり', 9 * 60),
  refPerson(REF.multi, '複数', '終了', 9 * 60),
  refPerson(REF.clash, '衝突', '識別', 9 * 60),
  refPerson(REF.name, '不一致', '氏名', 9 * 60),
  refPerson(REF.nomaster, '未登録', 'マスタ', 9 * 60),
  refPerson(REF.nomentor, '不在', 'メンター', 9 * 60),
  refPerson(REF.open, '稼働', '中', 9 * 60),
  refPerson(REF.bad, '不正', '時刻', 9 * 60),
  refPerson(REF.boundary, '境界', '当日', 9 * 60),
  refPerson(REF.next, '境界', '翌日', 9 * 60),
  refPerson(REF.before, '開始前', '履歴', 10 * 60),
  refPerson(REF.within, '待機', '中', 9 * 60 + 6)
], refPack.iso));
refPack.session.ingestMentor(refDigest);
refPack.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: refNow.getTime(),
  entries: Object.keys(REF).filter(function (key) { return key !== 'nomaster'; }).map(function (key) {
    var person = {
      ended: ['終了', 'あり'],
      prev: ['前日', 'のみ'],
      both: ['両方', 'あり'],
      multi: ['複数', '終了'],
      clash: ['衝突', '識別'],
      name: ['不一致', '氏名'],
      nomentor: ['不在', 'メンター'],
      open: ['稼働', '中'],
      bad: ['不正', '時刻'],
      boundary: ['境界', '当日'],
      next: ['境界', '翌日'],
      before: ['開始前', '履歴'],
      within: ['待機', '中']
    }[key];
    return rollMaster(REF[key], key + 'キー', person[0] + ' ' + person[1], 'GDSダイレクト');
  })
});
const refView = refPack.session.rollCallView('2026-10-13', true);
function refRowByName(family) {
  return refView.rows.filter(function (row) { return row.schedulingName.indexOf(family) === 0; })[0];
}
assert(refView.counts.total === 14 && rollPartition(refView.counts) === 14, 'existing classes still add up to the reserved people');
assert(refView.counts.before === 1 && refView.counts.within5 === 1 && refView.counts.activeCandidate === 2 && refView.counts.activeUnseen === 6 && refView.counts.after5Unmatched === 4 && refView.counts.unknownTime === 0, 'same-day history does not move the existing classes');
assert(rollAttention(refView.counts) === 10, 'the attention count stays on the existing classes');
assert(refView.sameDay.ended + refView.sameDay.absent + refView.sameDay.unmatched + refView.sameDay.rangeUnverified + refView.sameDay.unavailable === refView.counts.total, 'reference counts are one per reserved person');
assert(refRowByName('終了').status === '開始後5分以上・Active未確認' && refRowByName('終了').sameDayHistory === '当日終了時刻あり（同一人物候補）' && refRowByName('終了').confirmation === '未確認', 'a unique same-day end is a reference only');
assert(refRowByName('前日').sameDayHistory === '当日終了履歴未検出', 'a previous-day end is not a same-day history');
assert(refRowByName('両方').status === '開始後5分以上・Active確認候補' && refRowByName('両方').sameDayHistory === '当日終了時刻あり（同一人物候補）', 'current Active and a same-day end stay in their own fields');
assert(refRowByName('複数').sameDayHistory === '当日終了時刻あり（同一人物候補）' && refView.rows.filter(function (row) { return row.schedulingName.indexOf('複数') === 0; }).length === 1, 'several end sessions stay one person');
assert(refRowByName('衝突').status === '開始後5分以上・照合不能' && refRowByName('衝突').sameDayHistory === '履歴照合不能', 'an id conflict is not linked');
assert(refRowByName('不一致').sameDayHistory === '履歴照合不能', 'a different name is not linked');
assert(refRowByName('未登録').identity === 'OFK3マスタ未登録' && refRowByName('未登録').sameDayHistory === '履歴照合不能', 'a missing master row is not linked');
assert(refRowByName('不在').sameDayHistory === '履歴照合不能', 'a person with no mentor row is not linked');
assert(refRowByName('稼働').status === '開始後5分以上・Active確認候補' && refRowByName('稼働').sameDayHistory === '当日終了履歴未検出', 'an open row without an end stays undetected, not unstarted');
assert(refRowByName('不正').sameDayHistory === '当日終了履歴未検出', 'an invalid end time is not a same-day history');
assert(refView.rows.filter(function (row) { return row.schedulingName === '境界 当日'; })[0].sameDayHistory === '当日終了時刻あり（同一人物候補）', 'the JST midnight end counts for that date');
assert(refView.rows.filter(function (row) { return row.schedulingName === '境界 翌日'; })[0].sameDayHistory === '当日終了履歴未検出', 'the next JST midnight does not count for the selected date');
assert(refRowByName('開始前').status === '開始前' && refRowByName('開始前').sameDayHistory === '当日終了時刻あり（同一人物候補）', 'a same-day end before the start does not change the time class');
assert(refRowByName('待機').status === '開始後5分未満' && refRowByName('待機').sameDayHistory === '当日終了履歴未検出', 'the five-minute wait stays a wait');
assert(refView.sameDay.ended === 5 && refView.sameDay.absent === 5 && refView.sameDay.unmatched === 4, 'reference buckets match the fixture');
const refClosed = refPack.session.rollCallView('2026-10-13', false);
assert(refClosed.rows.length === 0 && refClosed.counts.total === 14 && refClosed.sameDay.ended === 5, 'closing the list drops names and keeps both totals');
const refSecrets = ['終了 あり', '前日 のみ', '両方 あり', '複数 終了', '衝突 識別', '不一致 氏名', '未登録 マスタ', '不在 メンター', '稼働 中', '不正 時刻', '境界 当日', '境界 翌日', '開始前 履歴', '待機 中', '高橋', '健'].concat(Object.keys(REF).map(function (key) { return REF[key]; }), Object.keys(refDriver).map(function (key) { return refDriver[key]; }), [String(histSameMs), String(histDayStart)]);
assertNoRollSecrets(refClosed, refSecrets);
const refCopy = Core.copyPayload(refPack.session.read('2026-10-13'), '2026-10-13');
refSecrets.forEach(function (secret) {
  assert(refCopy.indexOf(secret) < 0, 'reference copy leaked ' + secret);
});
assert(refCopy.indexOf('"endDate"') < 0, 'diagnostic copy has no per-session end field');

const unverifiedPack = freshSession(refNow);
unverifiedPack.session.ingestScheduling(roster([
  refPerson(REF.ended, '終了', 'あり', 9 * 60)
], unverifiedPack.iso));
unverifiedPack.session.ingestMentor(Core.mentorDigest({
  data: [refMentor(REF.ended, refDriver.ended, '終了', 'あり', histSameMs)]
}, unverifiedPack.iso));
unverifiedPack.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: refNow.getTime(),
  entries: [rollMaster(REF.ended, '終了キー', '終了 あり', 'GDSダイレクト')]
});
const unverifiedView = unverifiedPack.session.rollCallView('2026-10-13', true);
assert(unverifiedView.counts.activeUnseen === 1 && unverifiedView.sameDay.rangeUnverified === 1 && unverifiedView.sameDay.ended === 0, 'an unverified range stops the reference without changing the class');
const staleRef = freshSession(refNow);
const staleRefIso = new Date(refNow.getTime() - 16 * 60000).toISOString();
staleRef.session.ingestScheduling(roster([
  refPerson(REF.ended, '終了', 'あり', 9 * 60)
], staleRefIso));
staleRef.session.ingestMentor(Core.mentorDigest({
  data: [refMentor(REF.ended, refDriver.ended, '終了', 'あり', histSameMs)]
}, staleRefIso, refUrl));
staleRef.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: refNow.getTime() - 16 * 60000,
  entries: [rollMaster(REF.ended, '終了キー', '終了 あり', 'GDSダイレクト')]
});
const staleRefView = staleRef.session.rollCallView('2026-10-13', true);
assert(staleRefView.enabled === false && staleRefView.counts.total === 0 && staleRefView.rows.length === 0 && staleRefView.sameDay.unavailable === 1 && staleRefView.sameDay.ended === 0, 'stale data stops classification and marks the reference unavailable');
assert(JSON.stringify(staleRefView).indexOf('終了 あり') < 0 && JSON.stringify(staleRefView).indexOf(REF.ended) < 0, 'the stopped reference has no name or id');
assert(read('cortex-capture-extension/id-diag-panel.js').indexOf('Mentor当日履歴（参考）') > 0 && read('cortex-capture-extension/id-diag-panel.js').indexOf('fetch(') < 0, 'the reference is display-only');

function causeTotal(causes) {
  return Object.keys(causes || {}).reduce(function (sum, key) { return sum + causes[key]; }, 0);
}
assert(refRowByName('終了').endedHistoryMark === true && refRowByName('終了').status === '開始後5分以上・Active未確認' && refRowByName('終了').confirmation === '未確認', 'an unseen person with a same-day end is marked for display and stays unconfirmed');
assert(refRowByName('前日').endedHistoryMark === false && refRowByName('前日').status === '開始後5分以上・Active未確認', 'an unseen person without a same-day end is not marked');
assert(refRowByName('両方').endedHistoryMark === false && refRowByName('両方').sameDayHistory === '当日終了時刻あり（同一人物候補）', 'a current active candidate is not given the unseen-history mark');
assert(refRowByName('複数').endedHistoryMark === true && refView.rows.filter(function (row) { return row.schedulingName.indexOf('複数') === 0; }).length === 1, 'several end sessions stay one marked person');
assert(refView.ui.activeUnseenEnded === 3 && refView.ui.activeUnseenOther === 3 && refView.ui.activeUnseenEnded + refView.ui.activeUnseenOther === refView.counts.activeUnseen, 'the unseen history split adds up to the unseen class');
assert(refView.ui.activeUnseenRangeHold === 0, 'a verified range does not hold the unseen history split');
assert(refRowByName('衝突').unmatchedCause === 'ID重複・競合', 'two mentor driver ids stay an id conflict');
assert(refRowByName('不一致').unmatchedCause === '氏名不一致', 'a different name keeps the existing name cause');
assert(refRowByName('未登録').unmatchedCause === 'OFK3マスタ未登録', 'a missing master keeps the existing master cause');
assert(refRowByName('不在').unmatchedCause === 'Mentor照合不能', 'a missing mentor row keeps the existing mentor cause');
assert(causeTotal(refView.ui.causes) === refView.counts.after5Unmatched, 'cause counts are one per unmatched person');
assert(rollPartition(refView.counts) === refView.counts.total && rollAttention(refView.counts) === 10, 'display marks do not change the class total or the attention count');
assert(refClosed.rows.length === 0 && refClosed.ui.activeUnseenEnded === 3, 'closing the list keeps the display counts and drops the rows');

const uiNow = tokyoClock(12, 9, 10);
const UI_BLANK = '';
const UI_DUP = 'R1UIDUP45NAME01';
const UI_NAME = 'R1UINAM45NAME01';
const UI_DRV = 'R1UIDRV45NAME01';
const uiPack = loadRoll(uiNow, [
  rollPerson(UI_BLANK, '空白 識別', '識別', '空白', [block('2026-10-12', UI_BLANK, 9 * 60, nineEpoch)]),
  rollPerson(UI_DUP, '重複 一郎', '一郎', '重複', [block('2026-10-12', UI_DUP, 9 * 60, nineEpoch)]),
  rollPerson(UI_DUP, '重複 二郎', '二郎', '重複', [block('2026-10-12', UI_DUP, 9 * 60, nineEpoch)]),
  rollPerson(UI_NAME, '氏名 複数', '複数', '氏名', [block('2026-10-12', UI_NAME, 9 * 60, nineEpoch)])
], [
  { driverId: UI_DRV, realStaffNumber: UI_NAME, firstName: '複数', lastName: '氏名', active: false },
  { driverId: UI_DRV, realStaffNumber: UI_NAME, firstName: '別', lastName: '名前', active: false }
], [
  rollMaster(UI_DUP, '重複キー', '重複 一郎', 'GDSダイレクト'),
  rollMaster(UI_NAME, '氏名キー', '氏名 複数', 'GDSダイレクト')
]);
const uiView = uiPack.rollCallView('2026-10-12', true);
const uiBlank = uiView.rows.filter(function (row) { return row.unmatchedCause === '取得データ不足'; })[0];
const uiName = uiView.rows.filter(function (row) { return row.schedulingName === '氏名 複数'; })[0];
assert(uiView.rows.length === 3 && rollPartition(uiView.counts) === 3, 'blank, duplicate, and name-conflict people stay one each');
assert(uiBlank.status === '開始後5分以上・照合不能' && uiBlank.endedHistoryMark === false, 'a missing scheduling id is shown as missing data');
assert(uiView.rows.filter(function (row) { return row.unmatchedCause === 'ID重複・競合'; }).length === 1 && uiView.ui.causes['ID重複・競合'] === 1, 'two scheduling people on one id stay one id-conflict count');
assert(uiName.unmatchedCause === 'Mentor照合不能' && uiView.ui.causes['氏名不一致'] === 0, 'two mentor names with one driver id stay a mentor mismatch');
assert(uiView.rows.every(function (row) { return row.endedHistoryMark === false; }), 'unverified history does not mark an unseen end');
assert(uiView.ui.activeUnseenEnded === 0, 'unverified history does not count an unseen end');

assert(unverifiedView.rows[0].endedHistoryMark === false && unverifiedView.ui.activeUnseenEnded === 0 && unverifiedView.ui.activeUnseenOther === 1 && unverifiedView.ui.activeUnseenRangeHold === 1 && unverifiedView.counts.activeUnseen === 1, 'an unverified range keeps the class and does not claim an end');
assert(staleRefView.rows.length === 0 && staleRefView.ui.activeUnseenEnded === 0 && staleRefView.ui.activeUnseenOther === 0 && staleRefView.counts.total === 0, 'stale data has no class, no end mark, and no absence claim in the counts');
assert(JSON.stringify(staleRefView).indexOf('当日終了履歴なし') < 0 && JSON.stringify(unverifiedView).indexOf('Active未確認｜当日終了履歴あり（参考）') < 0, 'stopped and unverified views do not carry the emphasis sentence');

const panelUi = read('cortex-capture-extension/id-diag-panel.js');
assert(panelUi.indexOf('Active未確認｜当日終了履歴あり（参考）') > 0, 'the list has a text mark for an unseen same-day end');
assert(panelUi.indexOf("row.endedHistoryMark === true && row.status === '開始後5分以上・Active未確認' && row.sameDayHistory === '当日終了時刻あり（同一人物候補）'") > 0, 'the mark requires both the unseen class and the same-day reference');
assert(panelUi.indexOf('正常終了') < 0 && panelUi.indexOf('照合不能の原因:') > 0, 'the mark does not confirm completion and the cause stays visible');
assert(panelUi.indexOf('Active未確認のうち当日終了履歴あり') > 0 && panelUi.indexOf('範囲未検証・期限切れ等') > 0 && panelUi.indexOf('履歴がないとは断定しません') > 0, 'the summary separates the unseen end and withholds an absence claim when the range is unverified');
assert(panelUi.indexOf('var attention = (counts.activeUnseen || 0) + (counts.after5Unmatched || 0) + (counts.unknownTime || 0);') > 0, 'the attention formula is unchanged');
assert(panelUi.indexOf('fetch(') < 0 && panelUi.indexOf('XMLHttpRequest') < 0, 'the list display adds no request');

const SUS_DAY = '2026-10-13';
const susNine = Date.UTC(2026, 9, 13, 0, 0, 0);
const susNow = new Date(Date.UTC(2026, 9, 13, 1, 0, 0));
const susUrl = historyUrl(histDayStart, histNextStart, HIST_DAY, '');
const susPartial = historyUrl(histDayStart + 9 * 3600000, histDayStart + 12 * 3600000, HIST_DAY, '');
const SUS = {
  before: 'S1BEFOR45NAME01',
  exact: 'S1EXACT45NAME01',
  active: 'S1ACTIV45NAME01',
  ended: 'S1ENDED45NAME01',
  absent: 'S1ABSNT45NAME01',
  clash: 'S1CLASH45NAME01',
  name: 'S1NAMES45NAME01',
  nomaster: 'S1NOMST45NAME01',
  multi: 'S1MULTI45NAME01',
  unknown: 'S1UNKTM45NAME01',
  prev: 'S1PREV045NAME01',
  both: 'S1BOTHS45NAME01',
  edge: 'S1EDGE045NAME01'
};
function susPerson(id, family, given, epoch, minutes) {
  return rollPerson(id, family + ' ' + given, given, family, [block(SUS_DAY, id, minutes, epoch)]);
}
function susMentor(staff, driver, family, given, end) {
  return { driverId: driver, realStaffNumber: staff, firstName: given, lastName: family, shiftEndTime: end, vrmStatus: 'Active' };
}
function loadSuspect(now, people, mentorRows, entries, url) {
  const pack = freshSession(now);
  pack.session.ingestScheduling(roster(people, pack.iso));
  pack.session.ingestMentor(Core.mentorDigest({ data: mentorRows }, pack.iso, url));
  pack.session.ingestMaster({
    ok: true,
    phase: 'ready',
    loadedAt: now.getTime(),
    entries: entries
  });
  return pack.session;
}
function susFind(view, family) {
  return view.rows.filter(function (row) { return row.schedulingName.indexOf(family) === 0; })[0];
}
function susSum(counts) {
  return counts.active + counts.ended + counts.suspect + counts.undetermined;
}
const susPeople = [
  susPerson(SUS.before, '開始', '前', Date.UTC(2026, 9, 13, 2, 0, 0), 11 * 60),
  susPerson(SUS.exact, '同時', '刻', susNow.getTime(), 10 * 60),
  susPerson(SUS.active, '稼働', '中', susNine, 9 * 60),
  susPerson(SUS.ended, '終了', '履歴', susNine, 9 * 60),
  susPerson(SUS.absent, '該当', 'なし', susNine, 9 * 60),
  susPerson(SUS.clash, '衝突', '識別', susNine, 9 * 60),
  susPerson(SUS.name, '不一致', '氏名', susNine, 9 * 60),
  susPerson(SUS.nomaster, '未登録', 'マスタ', susNine, 9 * 60),
  rollPerson(SUS.multi, '複数 予約', '予約', '複数', [
    block(SUS_DAY, SUS.multi, 8 * 60, Date.UTC(2026, 9, 12, 23, 0, 0)),
    block(SUS_DAY, SUS.multi, 8 * 60 + 30, Date.UTC(2026, 9, 12, 23, 30, 0)),
    block(SUS_DAY, SUS.multi, 15 * 60, Date.UTC(2026, 9, 13, 6, 0, 0))
  ]),
  susPerson(SUS.unknown, '時刻', '不明', null, null),
  susPerson(SUS.prev, '前日', 'のみ', susNine, 9 * 60),
  susPerson(SUS.both, '両方', 'あり', susNine, 9 * 60)
];
const susMentorRows = [
  susMentor(SUS.active, 'S1DRVACT45NAME01', '稼働', '中', 'N/A'),
  susMentor(SUS.ended, 'S1DRVEND45NAME01', '終了', '履歴', histSameMs),
  susMentor(SUS.clash, 'S1DRVCL145NAME01', '衝突', '識別', histSameMs),
  susMentor(SUS.clash, 'S1DRVCL245NAME01', '衝突', '識別', histSameMs),
  susMentor(SUS.name, 'S1DRVNAM45NAME01', '高橋', '健', histSameMs),
  susMentor(SUS.nomaster, 'S1DRVNOM45NAME01', '未登録', 'マスタ', histSameMs),
  susMentor(SUS.prev, 'S1DRVPRV45NAME01', '前日', 'のみ', histPrevSec * 1000),
  susMentor(SUS.both, 'S1DRVBOT45NAME01', '両方', 'あり', 'N/A'),
  susMentor(SUS.both, 'S1DRVBOT45NAME01', '両方', 'あり', histSameMs)
];
const susMasters = ['before', 'exact', 'active', 'ended', 'absent', 'clash', 'name', 'multi', 'unknown', 'prev', 'both'].map(function (key) {
  const person = {
    before: ['開始', '前'],
    exact: ['同時', '刻'],
    active: ['稼働', '中'],
    ended: ['終了', '履歴'],
    absent: ['該当', 'なし'],
    clash: ['衝突', '識別'],
    name: ['不一致', '氏名'],
    multi: ['複数', '予約'],
    unknown: ['時刻', '不明'],
    prev: ['前日', 'のみ'],
    both: ['両方', 'あり']
  }[key];
  return rollMaster(SUS[key], key + 'キー', person[0] + ' ' + person[1], 'GDSダイレクト');
});
const susSession = loadSuspect(susNow, susPeople, susMentorRows, susMasters, susUrl);
const susRollBefore = JSON.stringify(susSession.rollCallView(SUS_DAY, false).counts);
const susView = susSession.suspectView(SUS_DAY, true);
const susRollAfter = JSON.stringify(susSession.rollCallView(SUS_DAY, false).counts);
assert(susRollBefore === susRollAfter, 'the suspect list does not change the roll call counts');
assert(susView.counts.total === 9 && susSum(susView.counts) === susView.counts.total, 'the four suspect classes add up to people past their start');
assert(susView.counts.active === 2 && susView.counts.ended === 2 && susView.counts.suspect === 3 && susView.counts.undetermined === 2, 'active, ended, suspect, and undetermined stay in their own counts');
assert(!susFind(susView, '開始') && !susFind(susView, '同時') && !susFind(susView, '時刻'), 'before start, the exact start, and an unknown start stay out of the list');
assert(susFind(susView, '稼働').status === '現在Active確認候補' && susFind(susView, '両方').status === '現在Active確認候補', 'a current open active row is the active candidate');
assert(susFind(susView, '終了').status === '当日終了履歴あり（参考）', 'a same-day end without a current active row is a reference');
assert(susFind(susView, '該当').status === 'Mentor未起動疑い（要確認）' && susFind(susView, '該当').mentorText === '該当行なし', 'a missing mentor row can remain a suspect when the id is unique');
assert(susFind(susView, '前日').status === 'Mentor未起動疑い（要確認）', 'a previous-day end does not count as a same-day end');
assert(susFind(susView, '複数').status === 'Mentor未起動疑い（要確認）' && susView.rows.filter(function (row) { return row.schedulingName.indexOf('複数') === 0; }).length === 1 && susFind(susView, '複数').startLabel.indexOf('08:00:00') === 0 && susFind(susView, '複数').startLabel.indexOf('2件') > 0, 'several reservations stay one person at the earliest started time');
assert(susFind(susView, '衝突').status === '判定不能（原因付き）' && susFind(susView, '衝突').cause === 'ID重複・競合', 'an id conflict stays undetermined');
assert(susFind(susView, '不一致').cause === '氏名不一致', 'a different name stays undetermined');
assert(susFind(susView, '未登録').status === '当日終了履歴あり（参考）' && susFind(susView, '未登録').cause === '' && susFind(susView, '未登録').department === 'マスタ未登録', 'a missing master row stays auxiliary and does not block the two-source class');
assert(susView.rows[0].status === 'Mentor未起動疑い（要確認）', 'suspect rows stay above the other classes');
const susClosed = susSession.suspectView(SUS_DAY, false);
assert(susClosed.rows.length === 0 && susClosed.counts.suspect === 3, 'closing the suspect list drops names and keeps the counts');
const susNames = ['開始 前', '同時 刻', '稼働 中', '終了 履歴', '該当 なし', '衝突 識別', '不一致 氏名', '未登録 マスタ', '複数 予約', '時刻 不明', '前日 のみ', '両方 あり', '高橋', '健'];
assertNoRollSecrets(susClosed, susNames.concat(Object.keys(SUS).map(function (key) { return SUS[key]; })));
const susCopy = Core.copyPayload(susSession.read(SUS_DAY), SUS_DAY);
susNames.concat(Object.keys(SUS).map(function (key) { return SUS[key]; }), [String(susNine), String(histSameMs)]).forEach(function (secret) {
  assert(susCopy.indexOf(secret) < 0, 'diagnostic copy leaked a suspect value: ' + secret);
});
const susRoll = susSession.rollCallView(SUS_DAY, false);
assert(rollPartition(susRoll.counts) === susRoll.counts.total && rollAttention(susRoll.counts) === susRoll.counts.activeUnseen + susRoll.counts.after5Unmatched + susRoll.counts.unknownTime, 'roll call totals and attention stay on the existing formula');

function edgeSession(now, url) {
  return loadSuspect(now, [
    susPerson(SUS.edge, '境界', '一秒', susNine, 9 * 60)
  ], [], [
    rollMaster(SUS.edge, '境界キー', '境界 一秒', 'GDSダイレクト')
  ], url);
}
const edgeBefore = edgeSession(new Date(susNine - 1000), susUrl).suspectView(SUS_DAY, true);
const edgeExact = edgeSession(new Date(susNine), susUrl).suspectView(SUS_DAY, true);
const edgeAfterSession = edgeSession(new Date(susNine + 1000), susUrl);
const edgeAfter = edgeAfterSession.suspectView(SUS_DAY, true);
const edgeRoll = edgeAfterSession.rollCallView(SUS_DAY, true);
assert(edgeBefore.counts.total === 0 && edgeExact.counts.total === 0, 'a start in the future and the exact start second stay out');
assert(edgeAfter.counts.total === 1 && edgeAfter.counts.suspect === 1 && edgeAfter.rows[0].status === 'Mentor未起動疑い（要確認）' && edgeAfter.rows[0].elapsed.indexOf('1秒') > 0, 'one second after the start is a suspect');
assert(edgeRoll.rows[0].status === '開始後5分未満' && rollAttention(edgeRoll.counts) === 0 && rollPartition(edgeRoll.counts) === 1, 'one second after the start stays inside five minutes on the roll call');
const edgePartial = edgeSession(new Date(susNine + 1000), susPartial).suspectView(SUS_DAY, true);
assert(edgePartial.counts.suspect === 0 && edgePartial.rows[0].cause === '取得範囲が対象日全体を覆わない', 'a partial day range does not become a suspect');
const edgeMissing = edgeSession(new Date(susNine + 1000), null).suspectView(SUS_DAY, true);
assert(edgeMissing.counts.suspect === 0 && edgeMissing.rows[0].cause === '取得範囲未検証', 'an unverified range does not become a suspect');
const edgeStaleNow = new Date(susNine + 1000);
const edgeStaleIso = new Date(edgeStaleNow.getTime() - 16 * 60000).toISOString();
const edgeStale = freshSession(edgeStaleNow);
edgeStale.session.ingestScheduling(roster([
  susPerson(SUS.edge, '境界', '一秒', susNine, 9 * 60)
], edgeStaleIso));
edgeStale.session.ingestMentor(Core.mentorDigest({ data: [] }, edgeStaleIso, susUrl));
edgeStale.session.ingestMaster({
  ok: true,
  phase: 'ready',
  loadedAt: edgeStaleNow.getTime() - 16 * 60000,
  entries: [rollMaster(SUS.edge, '境界キー', '境界 一秒', 'GDSダイレクト')]
});
const edgeStaleView = edgeStale.session.suspectView(SUS_DAY, true);
assert(edgeStaleView.counts.total === 1 && edgeStaleView.counts.suspect === 0 && edgeStaleView.counts.undetermined === 1 && edgeStaleView.rows.length === 0 && edgeStaleView.causes['15分超過'] === 1, 'stale data stays undetermined and shows no suspect');
assert(JSON.stringify(edgeStaleView).indexOf('境界 一秒') < 0 && JSON.stringify(edgeStaleView).indexOf(SUS.edge) < 0 && JSON.stringify(edgeStaleView).indexOf('点呼未実施') < 0, 'the stale suspect view has no name, id, or missed-roll claim');
const suspectPanel = read('cortex-capture-extension/id-diag-panel.js');
assert(suspectPanel.indexOf('Mentor未起動疑い一覧') > 0 && suspectPanel.indexOf('未起動疑いは調査用の参考情報です。Mentorの取得漏れがある可能性があり、未起動・点呼未実施を証明するものではありません。') > 0, 'the separate list shows the required caution');
assert(suspectPanel.indexOf('未起動確定') < 0 && suspectPanel.indexOf('正常終了') < 0 && suspectPanel.indexOf('fetch(') < 0 && suspectPanel.indexOf('XMLHttpRequest') < 0, 'the suspect list adds no completion claim and no request');
assert(read('cortex-capture-extension/id-diag-core.js').indexOf("row.shiftEndTime === 'N/A' && row.vrmStatus === 'Active'") > 0, 'the open active condition stays in place');

console.log('scheduling-mentor-id-diag: ok');
