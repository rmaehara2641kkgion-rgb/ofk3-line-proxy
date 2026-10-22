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
assert(suspectSpeech.outcome === 'withheld' && suspectSpeech.text === 'Mentor起動状況を報告します。サイクル1で未起動の疑いが2名います。画面で確認してください。', 'suspects are reported as a count');
assert(suspectSpeech.text.indexOf('山田') < 0 && suspectSpeech.text.indexOf('佐藤') < 0, 'unconfirmed names are absent from speech');

const activeBook = load([person(sched, '山田', '太郎')], [mentorRow(sched, '山田', '太郎')]);
const activeView = activeBook.suspectView(DAY, true);
assert(activeView.counts.active === 1 && activeView.counts.suspect === 0 && activeView.counts.undetermined === 0, 'an active candidate is not a suspect');
const activeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-clear-'));
const activeHandoff = activeBook.startupHandoff(DAY);
publish(activeDir, activeHandoff, assigned([sched], 'DCX47'));
const clearNotice = Route.handle({ method: 'GET', path: '/mentor-startup/notice', remote: '127.0.0.1', now: NOW, dir: activeDir }).body;
assert(clearNotice.outcome === 'clear' && clearNotice.scheduledCount === null, 'a fully active view is clear and does not invent a scheduled count');
assert(Schedule.speech(clearNotice, NOW, Core.STALE_MS).text === 'Mentor起動状況を確認しました。サイクル1の未起動者は0名です。', 'clear speech uses the cycle on the notice');

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
const template = Schedule.confirmedSentence('1', ['山田 太郎', '佐藤 花子', '鈴木 一郎']);
assert(template === 'Mentor起動状況を報告します。サイクル1の出勤予定者のうち、未起動者は3名です。山田 太郎さん、佐藤 花子さん、鈴木 一郎さん。確認をお願いします。', 'the confirmed sentence matches the requested shape');
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
assert(direct.text === template && direct.outcome === 'confirmed', 'a notice that already has a definitive list can be spoken');

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
assert(due.body.speak === true && due.body.cycle === '1' && due.body.text === 'Mentor起動状況を報告します。サイクル1で未起動の疑いが2名います。画面で確認してください。' && due.body.text.indexOf('山田') < 0, 'the due cycle speaks its own suspect count');
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
assert(manual.body.reason === 'manual' && manual.body.text.indexOf('未起動の疑いが2名') >= 0 && manual.body.text.indexOf('山田') < 0, 'manual readout does not require the clock');
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
assert(atCycle1.body.speak === true && atCycle1.body.cycle === '1' && atCycle1.body.text === 'Mentor起動状況を報告します。サイクル1で未起動の疑いが1名います。画面で確認してください。', 'cycle 1 time speaks only cycle 1');
assert(atCycle1.body.text.indexOf('サイクル2') < 0 && atCycle1.body.text.indexOf('佐藤') < 0, 'cycle 1 speech does not take another cycle or a name');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: NOW, dir: splitDir, body: { key: atCycle1.body.key, ok: true } });
const atCycle2 = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-14T01:05:00.000Z'), dir: splitDir });
assert(atCycle2.body.speak === true && atCycle2.body.cycle === '2' && atCycle2.body.text.indexOf('サイクル2で未起動の疑いが1名') >= 0 && atCycle2.body.text.indexOf('サイクル1') < 0, 'cycle 2 time speaks only cycle 2');

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
assert(partialPlan.body.cycle === '1' && partialPlan.body.text.indexOf('疑いが1名') >= 0 && partialPlan.body.text.indexOf('2名') < 0, 'an unresolved person is not added to cycle 1');

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
assert(counted.length === 1 && countedText === 'Mentor起動状況を報告します。サイクル1で未起動の疑いが3名います。判定不能は1名です。画面で確認してください。', 'undetermined people are counted apart from suspects');
assert(countedText.indexOf('山田') < 0 && countedText.indexOf('高橋') < 0 && counted[0].confirmedUnstartedCount === 0, 'neither group is named or confirmed unstarted');

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
assert(Schedule.speechOverall(doubled, NOW, Core.STALE_MS).text === 'Mentor起動状況を報告します。本日の未起動の疑いは1名、判定不能は1名です。画面で確認してください。', 'the day report names neither group as confirmed unstarted');

const dayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-day-'));
const daySettings = Route.handle({ method: 'GET', path: '/mentor-startup/settings', remote: '127.0.0.1', now: NOW, dir: dayDir });
assert(daySettings.body.overallTime === null && Object.keys(daySettings.body.cycles).length === 0, 'overall and cycle times start unset');
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: dayDir,
  body: { overallTime: '10:00', cycles: { '1': { time: '10:05' }, '2': { time: null }, '3': { time: null } } }
});
publish(dayDir, suspectHandoff, [{ transportId: sched, routeCode: 'DCX47' }]);
const dayPlan = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dayDir });
assert(dayPlan.body.speak === true && dayPlan.body.scope === 'overall' && dayPlan.body.text === 'Mentor起動状況を報告します。本日の未起動の疑いは2名、判定不能は0名です。画面で確認してください。', 'the day clock includes people whose cycle is unknown');
assert(dayPlan.body.text.indexOf('サイクル') < 0 && dayPlan.body.text.indexOf('未起動者') < 0 && dayPlan.body.text.indexOf('山田') < 0, 'the day report does not assign a cycle or read a name');
const dayKey = dayPlan.body.key;
assert(dayKey.indexOf('|overall|') >= 0, 'the day report uses its own generation key');
Route.handle({ method: 'POST', path: '/mentor-startup/ack', remote: '127.0.0.1', now: NOW, dir: dayDir, body: { key: dayKey, ok: true } });
const dayAgain = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: NOW, dir: dayDir });
assert(dayAgain.body.speak === false && dayAgain.body.reason === 'already-spoken', 'the day report is not repeated');
const cycleAfterDay = Route.handle({ method: 'GET', path: '/mentor-startup/plan', remote: '127.0.0.1', now: new Date('2026-10-14T01:05:00.000Z'), dir: dayDir });
assert(cycleAfterDay.body.speak === true && cycleAfterDay.body.scope === 'cycle' && cycleAfterDay.body.cycle === '1' && cycleAfterDay.body.text.indexOf('サイクル1で未起動の疑いが1名') >= 0, 'a later cycle clock still speaks only the resolved people');
assert(cycleAfterDay.body.key !== dayKey && cycleAfterDay.body.key.indexOf('|overall|') < 0, 'the cycle key is distinct from the day key');

const staleDay = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-startup-stale-day-'));
Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: staleDay,
  body: { overallTime: '10:00', cycles: { '1': { time: null } } }
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
assert(staleDayPlan.body.speak === true && staleDayPlan.body.text === Schedule.FAILURE && staleDayPlan.body.text.indexOf('本日の未起動') < 0, 'an old capture is not spoken as the day count');
const failedDay = Schedule.speechOverall(Notice.overallFromNotices([mentorFailNotice]), NOW, Core.STALE_MS);
assert(failedDay.text === Schedule.FAILURE, 'a mentor fetch failure is not spoken as the day count');
const badOverall = Route.handle({
  method: 'POST',
  path: '/mentor-startup/settings',
  remote: '127.0.0.1',
  now: NOW,
  dir: dayDir,
  body: { overallTime: '8:40', cycles: { '1': { time: null } } }
});
assert(badOverall.status === 400, 'a partial overall time is rejected');

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

console.log('mentor-startup-friday: ok');
