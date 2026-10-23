import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));
const Core = require(path.join(repo, 'cortex-capture-extension/id-diag-core.js'));
const Notice = require(path.join(repo, 'mentor-startup-notice.js'));
const Schedule = require(path.join(repo, 'mentor-startup-schedule.js'));
const Route = require(path.join(repo, 'mentor-startup-route.js'));

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

const DAY = '2026-10-14';
const NOW = new Date('2026-10-14T01:00:00.000Z');
const START = Date.UTC(2026, 9, 14, 0, 0, 0);
const RANGE_START = Date.UTC(2026, 9, 13, 15, 0, 0);
const RANGE_END = RANGE_START + 86400000;
const FRESH = NOW.toISOString();
const MENTOR_URL = 'https://vrm-mentor.edriving.com/reports/driver/shifts?decorate=yes&startTime=' + RANGE_START + '&endTime=' + RANGE_END + '&localDate=' + DAY;
const sched = 'S1YAMAD45NAME01';
const other = 'S2SATOH45NAME01';

function session() {
  return Core.createSession(function () { return NOW; });
}
function person(id, family, given, spelled) {
  return {
    driverPersonId: id,
    driverName: spelled || (family + ' ' + given),
    driverLastName: family,
    driverFirstName: given,
    reservations: [{ date: DAY, daPersonId: id, startTimeInMinutes: 9 * 60, startTimeInEpoch: START, status: 'ASSIGNED' }]
  };
}
function master(id, japanese) {
  return { name: japanese, japaneseName: japanese, transportId: id, department: 'GDSダイレクト' };
}
function mentorRow(staff, family, given) {
  return { driverId: 'D' + staff, realStaffNumber: staff, firstName: given, lastName: family, shiftEndTime: 'N/A', vrmStatus: 'Active' };
}
function load(people, rows) {
  const book = session();
  book.ingestScheduling({ ok: true, capturedAt: FRESH, fromDate: '2026-10-13', people: people });
  if (rows) book.ingestMentor(Core.mentorDigest({ data: rows }, FRESH, MENTOR_URL));
  book.ingestMaster({ ok: true, phase: 'ready', loadedAt: NOW.getTime(), entries: people.map(function (item) { return master(item.driverPersonId, item.driverName); }) });
  return book;
}
function meta() {
  return { schedulingCapturedAt: FRESH, mentorCapturedAt: FRESH, judgedAt: FRESH };
}
function publish(dir, source, assignments) {
  var handoff = source && source.view && Array.isArray(source.identities);
  return Route.handle({
    method: 'POST',
    path: '/mentor-startup/notice',
    remote: '127.0.0.1',
    now: NOW,
    dir: dir,
    body: Object.assign({
      view: handoff ? source.view : source,
      identities: handoff ? source.identities : [],
      assignments: assignments || null
    }, meta())
  });
}
function assigned(ids, routeCode) {
  return ids.map(function (id) { return { transportId: id, routeCode: routeCode }; });
}
function daySlots(active) {
  return Schedule.defaultSlots().map(function (slot) {
    if (!active || !active[slot.id]) return { id: slot.id, time: slot.time, enabled: false };
    return { id: slot.id, time: active[slot.id], enabled: true };
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-'));
const suspectBook = load(
  [person(sched, '山田', '太郎'), person(other, '佐藤', '花子')],
  [mentorRow('M1OTHER45NAME01', '別', '人'), mentorRow('M2OTHER45NAME01', '他', '人')]
);
const suspectView = suspectBook.suspectView(DAY, true);
const suspectHandoff = suspectBook.startupHandoff(DAY);
assert(suspectView.counts.suspect === 2, 'existing matcher keeps both unmatched people as suspects');
assert(JSON.stringify(suspectView).indexOf(sched) < 0 && JSON.stringify(suspectView).indexOf(other) < 0, 'the panel view does not publish raw ids');
assert(suspectHandoff.identities.map(function (row) { return row.schedulingId; }).sort().join() === [sched, other].sort().join(), 'the local handoff keeps the scheduling ids');
const suspectSaved = publish(dir, suspectHandoff, assigned([sched, other], 'DCX47'));
assert(suspectSaved.status === 200 && suspectSaved.body.confirmedUnstartedCount === 0 && suspectSaved.body.suspectCount === 2, 'suspects are stored without a confirmed unstarted count');
const suspectNotice = Route.handle({ method: 'GET', path: '/mentor-startup/notice', remote: '127.0.0.1', now: NOW, dir: dir }).body;
assert(suspectNotice.confirmedUnstarted.length === 0, 'stored notice has no confirmed unstarted people');
assert(suspectNotice.unconfirmed.map(function (row) { return row.schedulingId; }).sort().join() === [sched, other].sort().join(), 'each scheduling id stays attached');
const suspectSpeech = Schedule.speech(suspectNotice, NOW, Core.STALE_MS);
assert(suspectSpeech.outcome === 'withheld' && suspectSpeech.text.indexOf('サイクル1の確認対象2名のうち、未起動の疑いがある方は2名です。') >= 0, 'suspects are reported with the evaluated count');
assert(suspectSpeech.text.indexOf('山田 太郎さん') >= 0 && suspectSpeech.text.indexOf('佐藤 花子さん') >= 0 && suspectSpeech.text.indexOf('確認をお願いします。') >= 0, 'suspect names are read from the current notice');
assert(suspectSpeech.text.indexOf('未起動者') < 0 && suspectSpeech.text.indexOf('未起動断定') < 0, 'the report does not claim a confirmed unstarted person');

const activeBook = load([person(sched, '山田', '太郎')], [mentorRow(sched, '山田', '太郎')]);
const activeView = activeBook.suspectView(DAY, true);
assert(activeView.counts.active === 1 && activeView.counts.suspect === 0 && activeView.counts.undetermined === 0, 'an active candidate is not a suspect');
const activeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-clear-'));
const activeHandoff = activeBook.startupHandoff(DAY);
publish(activeDir, activeHandoff, assigned([sched], 'DCX47'));
const clearNotice = Route.handle({ method: 'GET', path: '/mentor-startup/notice', remote: '127.0.0.1', now: NOW, dir: activeDir }).body;
assert(clearNotice.outcome === 'clear' && clearNotice.scheduledCount === null, 'a fully active view is clear and does not invent a scheduled count');
assert(Schedule.speech(clearNotice, NOW, Core.STALE_MS).text === 'Mentor起動状況を報告します。サイクル1の確認対象1名のうち、未起動の疑いはありません。', 'clear speech says there is no suspicion');

const mentorFail = session();
mentorFail.ingestScheduling({ ok: true, capturedAt: FRESH, fromDate: '2026-10-13', people: [person(sched, '山田', '太郎')] });
mentorFail.ingestMentor({ ok: false, issue: 'FAILED', capturedAt: FRESH });
const mentorFailNotice = Notice.fromSuspectView(mentorFail.suspectView(DAY, true), meta());
assert(mentorFailNotice.outcome === 'unavailable' && mentorFailNotice.outcomeReason === 'Mentor取得失敗' && mentorFailNotice.confirmedUnstartedCount === 0, 'mentor fetch failure is not an unstarted judgment');
assert(Schedule.speech(mentorFailNotice, NOW, Core.STALE_MS).text === Schedule.FAILURE && Schedule.speech(mentorFailNotice, NOW, Core.STALE_MS).text.indexOf('山田') < 0, 'mentor failure uses the check-screen sentence');

const scheduleFail = session();
scheduleFail.ingestScheduling({ ok: false, issue: 'FAILED', capturedAt: FRESH });
scheduleFail.ingestMentor(Core.mentorDigest({ data: [mentorRow(sched, '山田', '太郎')] }, FRESH, MENTOR_URL));
const scheduleFailNotice = Notice.fromSuspectView(scheduleFail.suspectView(DAY, true), meta());
assert(scheduleFailNotice.outcomeReason === 'スケジュール取得失敗' && Schedule.speech(scheduleFailNotice, NOW, Core.STALE_MS).text === Schedule.FAILURE, 'schedule fetch failure is not an unstarted judgment');

const folded = load(
  [person(sched, '山田', '太郎'), person(sched, '山田', '太郎', '山田太郎')],
  [mentorRow('M1OTHER45NAME01', '別', '人')]
);
const foldedHandoff = folded.startupHandoff(DAY);
assert(foldedHandoff.view.rows.length === 1 && foldedHandoff.identities.length === 1 && foldedHandoff.identities[0].schedulingId === sched, 'the same scheduling id is one person');
assert(JSON.stringify(foldedHandoff.view).indexOf(sched) < 0, 'the folded panel view does not publish the raw id');
const foldedNotice = Notice.fromSuspectView(foldedHandoff.view, Object.assign({ identities: foldedHandoff.identities }, meta()));
assert(foldedNotice.unconfirmed.length === 1 && foldedNotice.unconfirmed[0].schedulingId === sched && foldedNotice.confirmedUnstartedCount === 0, 'name spelling does not create a second unstarted person');

const forged = Notice.fromSuspectView({
  enabled: true,
  reason: '',
  date: DAY,
  counts: { total: 1, active: 0, ended: 0, suspect: 0, undetermined: 0 },
  sources: { scheduling: 'ready', mentor: 'ready' },
  rows: [{ status: '未起動', schedulingId: sched, schedulingName: '山田 太郎', cause: '' }]
}, meta());
assert(forged.confirmedUnstartedCount === 0 && Schedule.speech(forged, NOW, Core.STALE_MS).text.indexOf('山田') < 0, 'a status outside the existing matcher is not spoken as unstarted');

const named = Schedule.speech({
  outcome: 'clear',
  cycle: '1',
  confirmedUnstartedCount: 3,
  confirmedUnstarted: [{ name: '山田 太郎' }, { name: '佐藤 花子' }, { name: '鈴木 一郎' }],
  schedulingCapturedAt: FRESH,
  mentorCapturedAt: FRESH,
  judgedAt: FRESH,
  date: DAY
}, NOW, Core.STALE_MS);
assert(named.outcome === 'clear' && named.text.indexOf('山田') < 0, 'a clear result does not read a name list');
const template = Schedule.confirmedSentence('', ['山田 太郎', '佐藤 花子', '鈴木 一郎']);
assert(template === 'Mentor起動状況を報告します。確認対象3名のうち、未起動の疑いがある方は3名です。対象者は、山田 太郎さん、佐藤 花子さん、鈴木 一郎さんです。確認をお願いします。', 'the suspect sentence matches the requested shape');
assert(template.indexOf('未起動者') < 0 && template.indexOf('未起動断定') < 0, 'the suspect sentence does not use a confirmed-unstarted phrase');
const direct = Schedule.speech({
  outcome: 'withheld',
  cycle: '1',
  confirmedUnstartedCount: 3,
  confirmedUnstarted: [{ name: '山田 太郎' }, { name: '佐藤 花子' }, { name: '鈴木 一郎' }],
  schedulingCapturedAt: FRESH,
  mentorCapturedAt: FRESH,
  judgedAt: FRESH,
  date: DAY
}, NOW, Core.STALE_MS);
assert(direct.outcome === 'clear' && direct.text.indexOf('未起動の疑いはありません') >= 0 && direct.text.indexOf('山田') < 0 && direct.text.indexOf('未起動者') < 0, 'a definitive unstarted list is not spoken');

Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: dir,
  body: { freshnessMs: null, cycles: { '1': { time: '10:00' }, '2': { time: null } } }
});
const early = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-14T00:59:00.000Z'), dir: dir });
assert(early.body.speak === false && early.body.reason === 'not-due', 'a minute before the setting does not speak');
const cycleTwo = publish(dir, suspectHandoff, assigned([sched, other], 'DMX12'));
assert(cycleTwo.body.cycle === '2', 'cycle 2 comes from the DMX route prefix');
const unset = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dir });
assert(unset.body.speak === false && unset.body.reason === 'unset', 'an unset cycle time does not speak');
publish(dir, suspectHandoff, assigned([sched, other], 'DCX47'));
const due = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dir });
assert(due.body.speak === true && due.body.cycle === '1' && due.body.text.indexOf('未起動の疑いがある方は2名です。') >= 0 && due.body.text.indexOf('山田 太郎さん') >= 0, 'the due cycle speaks its own suspect count and names');
const second = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dir });
assert(second.body.speak === false && second.body.reason === 'in-flight', 'the same generation is not spoken twice');
const failed = Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: NOW, dir: dir, body: { key: due.body.key, ok: false } });
assert(failed.body.kept === true, 'a failed playback releases the generation');
const kept = Route.handle({ method: 'GET', path: '/mentor-startup/notice', remote: '127.0.0.1', now: NOW, dir: dir }).body;
assert(kept.unconfirmed.length === 2, 'failed playback keeps the alert');
const retry = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dir });
assert(retry.body.speak === true, 'a failed playback can be tried again in the same minute');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: NOW, dir: dir, body: { key: retry.body.key, ok: true } });
const duplicate = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dir });
assert(duplicate.body.speak === false && duplicate.body.reason === 'already-spoken', 'a successful playback is not repeated');

const child = spawnSync(process.execPath, [path.join(repo, 'tests/mentor-startup-plan-cli.cjs'), dir, NOW.toISOString()], { encoding: 'utf8' });
assert(child.status === 0, 'restart process exits');
const restarted = JSON.parse(child.stdout);
assert(restarted.speak === false && restarted.reason === 'already-spoken', 'a restarted process does not repeat the generation');

const manual = Route.handle({ method: 'GET', path: '/mentor-startup/manual', remote: '127.0.0.1', now: NOW, dir: dir });
assert(manual.body.reason === 'manual' && manual.body.text.indexOf('未起動の疑いがある方は2名') >= 0 && manual.body.text.indexOf('未起動者') < 0, 'manual readout does not require the clock');
const afterManual = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dir });
assert(afterManual.body.reason === 'already-spoken', 'manual readout does not erase the auto-speech record');

const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-stale-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: staleDir,
  body: { cycles: { '1': { time: '10:00' } } }
});
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: NOW,
  dir: staleDir,
  body: {
    view: activeHandoff.view,
    identities: activeHandoff.identities,
    assignments: assigned([sched], 'DCX47'),
    cycle: '2',
    schedulingCapturedAt: '2026-10-13T22:00:00.000Z',
    mentorCapturedAt: FRESH,
    judgedAt: FRESH
  }
});
const stale = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: staleDir });
assert(stale.body.speak === true && stale.body.cycle === '1' && stale.body.text === Schedule.FAILURE && stale.body.outcome === 'unavailable', 'an old capture stays on its route cycle and is not spoken as a normal result');

const remote = Route.handle({ method: 'POST', path: '/mentor-startup/notice', remote: '203.0.113.8', now: NOW, dir: dir, body: { view: suspectView } });
assert(remote.status === 403, 'a non-loopback post is refused');
const invalidTime = Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: dir,
  body: { cycles: { '1': { time: '8:40' } } }
});
assert(invalidTime.status === 400, 'a partial clock time is rejected');

const Cycle = require(path.join(repo, 'mentor-startup-cycle.js'));
const phase1 = fs.readFileSync(path.join(repo, 'cortex-capture-extension/phase1-core.js'), 'utf8');
assert(phase1.indexOf("DCX: 'C1'") >= 0 && phase1.indexOf("DMX: 'C2'") >= 0 && phase1.indexOf("DSX: 'C3'") >= 0, 'the existing route prefix map is unchanged');
assert(Cycle.cycleFromRouteCode('DCX47') === '1' && Cycle.cycleFromRouteCode('DMX3') === '2' && Cycle.cycleFromRouteCode('DSX1') === '3', 'route prefixes use the existing cycle map');
assert(Cycle.cycleFromRouteCode('C1') === '' && Cycle.cycleForRoutes(['〇']).cycle === null, 'a shift symbol is not treated as a cycle');
assert(Cycle.cycleForRoutes(['DCX1', 'DMX2']).reason === Cycle.MIXED && Cycle.cycleForRoutes(['DCX1', 'ZZZ9']).reason === Cycle.UNKNOWN_PREFIX, 'mixed or unknown routes stay unresolved');

const splitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-split-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: splitDir,
  body: { cycles: { '1': { time: '10:00' }, '2': { time: '10:05' } } }
});
const splitSaved = publish(splitDir, suspectHandoff, [
  { transportId: sched, routeCode: 'DCX47' },
  { transportId: other, routeCode: 'DMX3', driverName: '佐藤 花子', shiftCode: 'C1' }
]);
assert(splitSaved.body.notices.length === 2, 'one route cycle each');
const atCycle1 = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: splitDir });
assert(atCycle1.body.speak === true && atCycle1.body.cycle === '1' && atCycle1.body.text.indexOf('サイクル1の確認対象1名のうち、未起動の疑いがある方は1名です。') >= 0, 'cycle 1 time speaks only cycle 1');
assert(atCycle1.body.text.indexOf('サイクル2') < 0 && atCycle1.body.text.indexOf('佐藤') < 0, 'cycle 1 speech does not take another cycle');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: NOW, dir: splitDir, body: { key: atCycle1.body.key, ok: true } });
const atCycle2 = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-14T01:05:00.000Z'), dir: splitDir });
assert(atCycle2.body.speak === true && atCycle2.body.cycle === '2' && atCycle2.body.text.indexOf('サイクル2の確認対象1名のうち、未起動の疑いがある方は1名です。') >= 0 && atCycle2.body.text.indexOf('サイクル1') < 0, 'cycle 2 time speaks only cycle 2');

const partialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-partial-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: partialDir,
  body: { cycles: { '1': { time: '10:00' } } }
});
publish(partialDir, suspectHandoff, [{ transportId: sched, routeCode: 'DCX47' }]);
const partial = Route.handle({ method: 'GET', path: '/mentor-startup/notice', remote: '127.0.0.1', now: NOW, dir: partialDir }).body;
assert(partial.notices.length === 2, 'a person without an assignment stays outside the known cycle');
const unknown = partial.notices.filter(function (notice) { return !notice.cycle; })[0];
assert(unknown && unknown.suspectCount === 1 && unknown.cycleReason === Cycle.NO_ASSIGNMENT, 'the unresolved person keeps an explicit reason');
const partialPlan = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: partialDir });
assert(partialPlan.body.cycle === '1' && partialPlan.body.text.indexOf('未起動の疑いがある方は1名') >= 0 && partialPlan.body.text.indexOf('2名') < 0, 'an unresolved person is not added to cycle 1');

const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-bare-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: bareDir,
  body: { cycles: { '1': { time: '10:00' } } }
});
const bare = publish(bareDir, suspectHandoff, null);
assert(bare.body.cycle === null && bare.body.outcomeReason === '未起動疑い', 'no assignment does not invent cycle 1');
const bareNotice = Route.handle({ method: 'GET', path: '/mentor-startup/notice', remote: '127.0.0.1', now: NOW, dir: bareDir }).body;
assert(bareNotice.cycleReason === Cycle.NO_FIELD, 'the roster has no cycle field');
const barePlan = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: bareDir });
assert(barePlan.body.speak === false && barePlan.body.reason === 'unset' && barePlan.body.text.indexOf('サイクル1') < 0, 'an unresolved notice is not spoken on another cycle clock');

const counted = Notice.noticesFromSuspectView({
  enabled: true,
  reason: '',
  date: DAY,
  counts: { total: 4, active: 0, ended: 0, suspect: 3, undetermined: 1 },
  sources: { scheduling: 'ready', mentor: 'ready' },
  rows: [
    { status: 'Mentor未起動疑い（要確認）', schedulingName: '山田 太郎', cause: '' },
    { status: 'Mentor未起動疑い（要確認）', schedulingName: '佐藤 花子', cause: '' },
    { status: 'Mentor未起動疑い（要確認）', schedulingName: '鈴木 一郎', cause: '' },
    { status: '判定不能（原因付き）', schedulingName: '高橋 四郎', cause: '取得範囲未検証' }
  ]
}, Object.assign({
  identities: [{ schedulingId: 'A' }, { schedulingId: 'B' }, { schedulingId: 'C' }, { schedulingId: 'D' }],
  assignments: [
    { transportId: 'A', routeCode: 'DCX1' },
    { transportId: 'B', routeCode: 'DCX1' },
    { transportId: 'C', routeCode: 'DCX1' },
    { transportId: 'D', routeCode: 'DCX1' }
  ]
}, meta()));
const countedText = Schedule.speech(counted[0], NOW, Core.STALE_MS).text;
assert(counted.length === 1 && countedText.indexOf('サイクル1の確認対象4名のうち、未起動の疑いがある方は3名です。') >= 0 && countedText.indexOf('判定不能は1名です。') > countedText.indexOf('確認をお願いします。'), 'undetermined people are reported apart from suspects');
assert(countedText.indexOf('山田 太郎さん') >= 0 && countedText.indexOf('高橋 四郎さん') >= 0 && countedText.indexOf('未起動者') < 0 && counted[0].confirmedUnstartedCount === 0, 'each group keeps its own names');

const doubled = Notice.overallFromNotices([{
  outcome: 'withheld',
  date: DAY,
  cycle: null,
  unconfirmed: [
    { schedulingId: sched, status: 'Mentor未起動疑い（要確認）' },
    { schedulingId: sched, status: 'Mentor未起動疑い（要確認）' },
    { schedulingId: other, status: '判定不能（原因付き）' }
  ],
  schedulingCapturedAt: FRESH,
  mentorCapturedAt: FRESH,
  judgedAt: FRESH
}]);
assert(doubled.suspectCount === 1 && doubled.undeterminedCount === 1 && doubled.confirmedUnstartedCount === 0, 'the same scheduling id is counted once');
const doubledText = Schedule.speechOverall(doubled, NOW, Core.STALE_MS).text;
assert(doubledText.indexOf('未起動の疑いがある方は1名です。') >= 0 && doubledText.indexOf('判定不能は1名です。') > doubledText.indexOf('確認をお願いします。') && doubledText.indexOf('未起動者') < 0, 'the day report keeps the two groups separate');

const dayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-day-'));
const daySettings = Route.handle({ method: 'GET', path: '/mentor-startup/settings', remote: '127.0.0.1', now: NOW, dir: dayDir });
assert(daySettings.body.slots.map(function (slot) { return slot.time + ':' + (slot.enabled ? '1' : '0'); }).join(',') === '09:05:0,11:10:0,11:35:0,15:00:0' && Object.keys(daySettings.body.cycles).length === 0, 'four slots are shown and auto speech starts off');
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: dayDir,
  body: { slots: daySlots({ '1': '10:00' }), cycles: { '1': { time: '10:05' }, '2': { time: null }, '3': { time: null } } }
});
publish(dayDir, suspectHandoff, [{ transportId: sched, routeCode: 'DCX47' }]);
const dayPlan = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dayDir });
assert(dayPlan.body.speak === true && dayPlan.body.scope === 'slot' && dayPlan.body.slotId === '1' && dayPlan.body.text.indexOf('確認対象2名のうち、未起動の疑いがある方は2名です。') >= 0, 'the day slot includes people whose cycle is unknown');
assert(dayPlan.body.text.indexOf('サイクル') < 0 && dayPlan.body.text.indexOf('未起動者') < 0 && dayPlan.body.text.indexOf('山田 太郎さん') >= 0 && dayPlan.body.text.indexOf('佐藤 花子さん') >= 0, 'the day report does not assign a cycle');
const dayKey = dayPlan.body.key;
assert(dayKey.indexOf('|slot|1') >= 0, 'the day report uses its slot key');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: NOW, dir: dayDir, body: { key: dayKey, ok: true } });
const dayAgain = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dayDir });
assert(dayAgain.body.speak === false && dayAgain.body.reason === 'already-spoken', 'the day report is not repeated');
const cycleAfterDay = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-14T01:05:00.000Z'), dir: dayDir });
assert(cycleAfterDay.body.speak === true && cycleAfterDay.body.scope === 'cycle' && cycleAfterDay.body.cycle === '1' && cycleAfterDay.body.text.indexOf('サイクル1の確認対象1名のうち、未起動の疑いがある方は1名です。') >= 0, 'a later cycle clock still speaks only the resolved people');
assert(cycleAfterDay.body.key !== dayKey && cycleAfterDay.body.key.indexOf('|slot|') < 0, 'the cycle key is distinct from the day slot');

const staleDay = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-stale-day-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: staleDay,
  body: { slots: daySlots({ '1': '10:00' }), cycles: { '1': { time: null } } }
});
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: NOW,
  dir: staleDay,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, meta(), { schedulingCapturedAt: '2026-10-13T22:00:00.000Z' })
});
const staleDayPlan = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: staleDay });
assert(staleDayPlan.body.speak === true && staleDayPlan.body.reason === 'not-ready' && staleDayPlan.body.text === Schedule.FETCH_MISSED && staleDayPlan.body.text.indexOf('疑いはありません') < 0, 'an old capture is announced as a fetch failure, not as zero people');
const failedDay = Schedule.speechOverall(Notice.overallFromNotices([mentorFailNotice]), NOW, Core.STALE_MS);
assert(failedDay.text === Schedule.FAILURE, 'a mentor fetch failure is not spoken as the day count');
const badOverall = Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: dayDir,
  body: { slots: daySlots({ '1': '8:40' }), cycles: { '1': { time: null } } }
});
assert(badOverall.status === 400, 'a partial slot time is rejected');

const background = fs.readFileSync(path.join(repo, 'cortex-capture-extension/background.js'), 'utf8');
const core = fs.readFileSync(path.join(repo, 'cortex-capture-extension/id-diag-core.js'), 'utf8');
const server = fs.readFileSync(path.join(repo, 'render-webhook-server.js'), 'utf8');
assert(background.indexOf('http://127.0.0.1:3000/mentor-startup/notice') >= 0 && background.indexOf('cycle: null') >= 0, 'the extension publishes the existing view without inventing a cycle');
assert(background.indexOf('console.log') < 0 || background.indexOf('publishMentorStartup') >= 0, 'publisher is present');
assert(core.indexOf('未起動判定: しない') >= 0 && core.indexOf('Mentor未起動疑い（要確認）') >= 0, 'the existing matcher still refuses a definitive unstarted judgment');
assert(server.indexOf("require('./mentor-startup-route.js').mount") >= 0 && server.indexOf('duty-risk-republish-route.js') >= 0, 'mentor plan stays beside the duty-risk republish route');
assert(fs.existsSync(path.join(repo, 'duty-risk-feed-route.js')) && fs.existsSync(path.join(repo, 'duty-risk-republish.js')), 'the duty-risk feed and republish files stay');

const friday = fs.readFileSync(path.join(repo, 'friday/mentor-startup-alerts.js'), 'utf8');
assert(friday.indexOf('/mentor-startup/plan') >= 0 && friday.indexOf('/mentor-startup/ack') >= 0 && friday.indexOf('/mentor-startup/manual') >= 0, 'FRIDAY uses the scheduled, ack, and manual paths');
assert(friday.indexOf('localStorage') >= 0, 'FRIDAY remembers spoken generations in the browser');
assert(friday.indexOf('function waitIdle') >= 0 && friday.indexOf('speakText(payload.text)') >= 0, 'FRIDAY reuses the existing speech wait and speakText');
assert(friday.indexOf('data-slot-time') >= 0 && friday.indexOf('mentor-startup-save') >= 0 && friday.indexOf('function saveSettings') >= 0, 'four slots are edited from FRIDAY and saved explicitly');
assert(friday.indexOf('閉じている間の時刻は読み上げできません') >= 0, 'the screen says speech needs FRIDAY to stay open');
assert(friday.indexOf('loadSettings') >= 0 && friday.indexOf("get('/mentor-startup/settings')") >= 0, 'opening the screen reads the saved time without writing it');
assert(friday.indexOf('未起動断定') < 0 && friday.indexOf("reason.indexOf('未起動者') === 0") >= 0, 'the panel does not show a confirmed-unstarted phrase');

const cappedNames = ['山田 太郎', '佐藤 花子', '鈴木 一郎', '高橋 四郎', '伊藤 五郎', '渡辺 六郎'];
const capped = Schedule.speech({
  outcome: 'withheld',
  date: DAY,
  evaluatedCount: 8,
  suspectCount: 6,
  undeterminedCount: 2,
  sources: { scheduling: 'ready', mentor: 'ready' },
  unconfirmed: cappedNames.map(function (name) { return { name: name, status: 'Mentor未起動疑い（要確認）' }; }).concat([
    { name: '中村 七郎', status: '判定不能（原因付き）' },
    { name: '小林 八郎', status: '判定不能（原因付き）' }
  ]),
  schedulingCapturedAt: FRESH,
  mentorCapturedAt: FRESH,
  judgedAt: FRESH
}, NOW, Core.STALE_MS);
assert(capped.text.indexOf('確認対象8名のうち、未起動の疑いがある方は6名です。') >= 0 && capped.text.indexOf('ほか1名は画面で確認してください。') >= 0, 'a long roster keeps the count and caps the names');
assert(capped.text.indexOf('渡辺 六郎さん') < 0 && capped.text.indexOf('判定不能は2名です。') > capped.text.indexOf('確認をお願いします。'), 'the sixth suspect is omitted and undetermined stays separate');
assert(capped.text.split('さん').length - 1 === Schedule.NAME_LIMIT + 2, 'five suspect names and both undetermined names are read');

const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-sample-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: sampleDir,
  body: { slots: daySlots({ '1': '10:00' }), cycles: {} }
});
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: NOW,
  dir: sampleDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities, sample: true }, meta())
});
const samplePlan = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: sampleDir });
assert(samplePlan.body.speak === false && samplePlan.body.reason === 'sample' && samplePlan.body.sample === true && samplePlan.body.text === Schedule.SAMPLE, 'sample data is not a production announcement');

const otherDay = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-15T01:00:00.000Z'), dir: dayDir });
assert(otherDay.body.speak === true && otherDay.body.reason === 'not-ready' && otherDay.body.text === Schedule.FETCH_MISSED && otherDay.body.text.indexOf('山田') < 0, 'a new day does not repeat the previous success text');
const mismatch = Schedule.speechOverall(Notice.overallFromNotices([Object.assign({}, clearNotice, { date: '2026-10-13' })]), NOW, Core.STALE_MS);
assert(mismatch.text === Schedule.FAILURE && mismatch.text.indexOf('山田') < 0, 'a different target date is not spoken as today');

const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-retry-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: retryDir,
  body: { slots: daySlots({ '1': '10:00' }), cycles: {} }
});
publish(retryDir, suspectHandoff, null);
const firstTry = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: retryDir });
assert(firstTry.body.speak === true, 'the overall slot starts the announcement');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: NOW, dir: retryDir, body: { key: firstTry.body.key, ok: false } });
const retryLater = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-14T01:01:00.000Z'), dir: retryDir });
assert(retryLater.body.speak === true && retryLater.body.key === firstTry.body.key, 'a failed playback can be tried again during the short grace');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: new Date('2026-10-14T01:01:00.000Z'), dir: retryDir, body: { key: retryLater.body.key, ok: true } });
const changed = Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: new Date('2026-10-14T01:02:00.000Z'),
  dir: retryDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, meta(), { judgedAt: '2026-10-14T01:02:00.000Z' })
});
assert(changed.status === 200, 'a newer judgment can be stored');
const sameSlot = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-14T01:02:00.000Z'), dir: retryDir });
assert(sameSlot.body.speak === false && sameSlot.body.reason === 'already-spoken', 'the same date, time, and scope is not spoken twice');
const tooLate = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-14T01:04:00.000Z'), dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-late-')) });
assert(tooLate.body.reason === 'unset', 'a clock outside the slot does not invent a time');

const fourDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-four-'));
const atNine = new Date('2026-10-14T00:05:00.000Z');
const atNineTwenty = new Date('2026-10-14T00:20:00.000Z');
const atEleven = new Date('2026-10-14T02:10:00.000Z');
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: atNine,
  dir: fourDir,
  body: { slots: daySlots({ '1': '09:05', '2': '11:10' }), cycles: {} }
});
const savedFour = Route.handle({ method: 'GET', path: '/mentor-startup/settings', remote: '127.0.0.1', now: atNine, dir: fourDir }).body;
assert(savedFour.slots[0].enabled === true && savedFour.slots[1].enabled === true && savedFour.slots[2].enabled === false && savedFour.slots[3].enabled === false, 'each slot is enabled on its own');
publish(fourDir, suspectHandoff, null);
const firstSlot = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atNine, dir: fourDir });
assert(firstSlot.body.speak === true && firstSlot.body.slotId === '1', 'the first slot speaks when its time arrives');
const otherBrowser = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atNine, dir: fourDir });
assert(otherBrowser.body.speak === false && otherBrowser.body.reason === 'in-flight' && otherBrowser.body.key === firstSlot.body.key, 'Chrome and Edge share one in-flight slot');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: atNine, dir: fourDir, body: { key: firstSlot.body.key, ok: true } });
const afterSuccess = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atNineTwenty, dir: fourDir });
assert(afterSuccess.body.speak === false && afterSuccess.body.reason === 'already-spoken', 'the same slot does not speak again after success');
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: atEleven,
  dir: fourDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, {
    schedulingCapturedAt: atEleven.toISOString(),
    mentorCapturedAt: atEleven.toISOString(),
    judgedAt: atEleven.toISOString()
  })
});
const secondSlot = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atEleven, dir: fourDir });
assert(secondSlot.body.speak === true && secondSlot.body.slotId === '2' && secondSlot.body.key !== firstSlot.body.key && secondSlot.body.text.indexOf('山田 太郎さん') >= 0, 'the next slot can name the same people again');

const lateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-late-data-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: atNine,
  dir: lateDir,
  body: { slots: daySlots({ '1': '09:05', '2': '11:10' }), cycles: {} }
});
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: atNine,
  dir: lateDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, meta(), { schedulingCapturedAt: '2026-10-13T22:00:00.000Z', mentorCapturedAt: '2026-10-13T22:00:00.000Z', judgedAt: '2026-10-13T22:00:00.000Z' })
});
const waiting = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atNine, dir: lateDir });
assert(waiting.body.speak === true && waiting.body.reason === 'not-ready' && waiting.body.text === Schedule.FETCH_MISSED && waiting.body.text.indexOf('疑いはありません') < 0, 'missing fresh data announces a fetch failure instead of zero people');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: atNine, dir: lateDir, body: { key: waiting.body.key, ok: true } });
publish(lateDir, suspectHandoff, null);
const arrived = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atNineTwenty, dir: lateDir });
assert(arrived.body.speak === true && arrived.body.slotId === '1', 'fresh data after the slot time still speaks inside that slot window');
const missed = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atEleven, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-missed-')) });
assert(missed.body.reason === 'unset', 'an empty setting does not backfill an earlier slot');
const missedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-missed-real-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: atEleven,
  dir: missedDir,
  body: { slots: daySlots({ '1': '09:05', '2': '11:10' }), cycles: {} }
});
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: atEleven,
  dir: missedDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, {
    schedulingCapturedAt: atEleven.toISOString(),
    mentorCapturedAt: atEleven.toISOString(),
    judgedAt: atEleven.toISOString()
  })
});
const onlyCurrent = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atEleven, dir: missedDir });
assert(onlyCurrent.body.speak === true && onlyCurrent.body.slotId === '2' && onlyCurrent.body.keys.length === 1, 'opening FRIDAY after the next slot does not also read the missed slot');
const duplicateTime = Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: atNine,
  dir: fourDir,
  body: { slots: [
    { id: '1', time: '09:05', enabled: true },
    { id: '2', time: '09:05', enabled: false },
    { id: '3', time: '11:35', enabled: false },
    { id: '4', time: '15:00', enabled: false }
  ] }
});
assert(duplicateTime.status === 400 && duplicateTime.body.reason === 'duplicate-time', 'two slots cannot share one time');

const exclusiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-exclusive-'));
const at1500 = new Date('2026-10-14T06:00:00.000Z');
const at1510 = new Date('2026-10-14T06:10:00.000Z');
function freshMeta(at) {
  return {
    schedulingCapturedAt: at.toISOString(),
    mentorCapturedAt: at.toISOString(),
    judgedAt: at.toISOString()
  };
}
function spokenState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'mentor-startup-spoken.json'), 'utf8'));
}
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: atEleven,
  dir: exclusiveDir,
  body: { slots: daySlots({ '2': '11:10', '4': '15:00' }), cycles: {} }
});
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: atEleven,
  dir: exclusiveDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, freshMeta(atEleven))
});
const earlierSlot = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atEleven, dir: exclusiveDir });
assert(earlierSlot.body.speak === true && earlierSlot.body.slotId === '2', 'an earlier slot speaks before the 15:00 slot');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: atEleven, dir: exclusiveDir, body: { key: earlierSlot.body.key, ok: true } });
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: at1500,
  dir: exclusiveDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, freshMeta(at1500))
});
const successSlot = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: at1500, dir: exclusiveDir });
assert(successSlot.body.speak === true && successSlot.body.slotId === '4' && successSlot.body.text.indexOf(Schedule.FETCH_MISSED) < 0, 'the 15:00 slot speaks the normal judgment');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: at1500, dir: exclusiveDir, body: { key: successSlot.body.key, ok: true } });
const beforeFailure = spokenState(exclusiveDir);
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: at1510,
  dir: exclusiveDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, freshMeta(new Date('2026-10-14T05:40:00.000Z')))
});
const suppressed = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: at1510, dir: exclusiveDir });
assert(suppressed.body.speak === false && suppressed.body.reason === 'already-spoken' && suppressed.body.slotId === '4', 'a fetch failure is not spoken after the same slot succeeded');
const afterSuppress = spokenState(exclusiveDir);
assert(afterSuppress.confirmed[earlierSlot.body.key] === beforeFailure.confirmed[earlierSlot.body.key], 'another slot keeps its success record');
assert(afterSuppress.confirmed[successSlot.body.key] && !afterSuppress.confirmed[suppressed.body.key], 'the success record stays and the failure is not recorded');

const recoverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-recover-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: atEleven,
  dir: recoverDir,
  body: { slots: daySlots({ '2': '11:10', '4': '15:00' }), cycles: {} }
});
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: atEleven,
  dir: recoverDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, freshMeta(atEleven))
});
const keptSlot = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: atEleven, dir: recoverDir });
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: atEleven, dir: recoverDir, body: { key: keptSlot.body.key, ok: true } });
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: at1500,
  dir: recoverDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, freshMeta(new Date('2026-10-14T05:40:00.000Z')))
});
const failedSlot = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: at1500, dir: recoverDir });
assert(failedSlot.body.speak === true && failedSlot.body.slotId === '4' && failedSlot.body.text === Schedule.FETCH_MISSED, 'a slot with no success yet can announce the fetch failure');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: at1500, dir: recoverDir, body: { key: failedSlot.body.key, ok: true } });
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: at1510,
  dir: recoverDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, freshMeta(at1510))
});
const recovered = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: at1510, dir: recoverDir });
assert(recovered.body.speak === true && recovered.body.slotId === '4' && recovered.body.key !== failedSlot.body.key && recovered.body.text.indexOf(Schedule.FETCH_MISSED) < 0, 'fresh data after a failure returns to the normal announcement');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: at1510, dir: recoverDir, body: { key: recovered.body.key, ok: true } });
const recoveredState = spokenState(recoverDir);
assert(recoveredState.confirmed[keptSlot.body.key] && recoveredState.confirmed[failedSlot.body.key] && recoveredState.confirmed[recovered.body.key], 'recovery keeps the earlier slot, the failure record, and the new success');
const afterRecovery = new Date('2026-10-14T06:12:00.000Z');
Route.handle({
  method: 'POST',
  path: '/mentor-startup/notice',
  remote: '127.0.0.1',
  now: afterRecovery,
  dir: recoverDir,
  body: Object.assign({ view: suspectHandoff.view, identities: suspectHandoff.identities }, freshMeta(new Date('2026-10-14T05:40:00.000Z')))
});
const failedAgain = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: afterRecovery, dir: recoverDir });
assert(failedAgain.body.speak === false && failedAgain.body.reason === 'already-spoken' && failedAgain.body.slotId === '4', 'a failure does not follow the recovered announcement');
assert(spokenState(recoverDir).confirmed[keptSlot.body.key], 'the other slot is still recorded after recovery');

console.log('mentor-startup-friday: ok');
