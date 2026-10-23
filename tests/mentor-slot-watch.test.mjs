import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));
const Watch = require(path.join(repo, 'cortex-capture-extension/mentor-slot-watch.js'));

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

const morning = new Date('2026-10-23T00:00:00.000Z');
const plan = Watch.alarmPlan(morning);
assert(plan.length === 5, 'four slot alarms plus the outbox alarm');
assert(plan.map(function (alarm) { return alarm.time; }).slice(0, 4).join(',') === '09:03,11:08,11:33,14:58', 'each slot is prepared two minutes earlier');
assert(plan[0].when === Date.parse('2026-10-23T09:03:00+09:00'), 'the first prep is today when it is still ahead');
assert(plan[4].name === Watch.OUTBOX_ALARM && plan[4].periodInMinutes === 1, 'a stopped server is retried without reloading Amazon');

const afterPrep = new Date('2026-10-23T00:04:00.000Z');
const later = Watch.alarmPlan(afterPrep);
assert(later[0].when === Date.parse('2026-10-24T09:03:00+09:00'), 'a passed prep moves to the next day');

const freshAt = '2026-10-23T00:00:00.000Z';
const fresh = Watch.prepAction({
  stamps: { schedulingCapturedAt: freshAt, mentorCapturedAt: freshAt },
  reloads: {}
}, '1', morning);
assert(fresh.resend === true && fresh.reload === false && fresh.reason === 'fresh', 'fresh background data is resent without a reload');
const marked = Watch.markReload({}, fresh.reloadKey, fresh.mark);
const again = Watch.prepAction({
  stamps: { schedulingCapturedAt: freshAt, mentorCapturedAt: freshAt },
  reloads: marked
}, '1', morning);
assert(again.reload === false && again.resend === false && again.reason === 'already-fresh', 'a fresh slot is not fetched twice');

const stale = Watch.prepAction({
  stamps: { schedulingCapturedAt: '2026-10-22T10:00:00.000Z', mentorCapturedAt: '2026-10-22T10:00:00.000Z' },
  reloads: {}
}, '2', new Date('2026-10-23T02:08:00.000Z'));
assert(stale.reload === true && stale.resend === false && stale.reloadKey === '2026-10-23|2', 'stale data allows one reload for that slot');
const used = Watch.markReload({}, stale.reloadKey, stale.mark);
const second = Watch.prepAction({
  stamps: { schedulingCapturedAt: '2026-10-22T10:00:00.000Z', mentorCapturedAt: '2026-10-22T10:00:00.000Z' },
  reloads: used
}, '2', new Date('2026-10-23T02:09:00.000Z'));
assert(second.reload === false && second.reason === 'reload-used', 'the same slot is not reloaded again');

const during = Watch.duePreps(new Date('2026-10-23T00:04:00.000Z'), {});
assert(during.indexOf('1') >= 0 && during.indexOf('2') < 0, 'a missed 09:03 prep still runs inside the 09:05 window');
const done = Watch.duePreps(new Date('2026-10-23T00:04:00.000Z'), { '2026-10-23|1': 'reload' });
assert(done.indexOf('1') < 0, 'a completed reload is not repeated after the worker restarts');

const queued = Watch.enqueue([], { key: 'same', payload: { view: { date: '2026-10-23' } }, queuedAt: freshAt });
const kept = Watch.enqueue(queued, { key: 'same', payload: { view: { date: '2026-10-23' } }, queuedAt: freshAt });
assert(kept.length === 1, 'the outbox keeps one copy of a judgment');
assert(Watch.drop(kept, 'same').length === 0, 'a delivered judgment leaves the outbox');

assert(Watch.loginUrl('https://vrm-mentor.edriving.com/#/login') === true, 'a login page is not reloaded');
assert(Watch.loginUrl('https://vrm-mentor.edriving.com/#/trip-session-report') === false, 'an open report can be refreshed once');
assert(Watch.slotByAlarm('mentor-prep-4').time === '15:00', 'the 15:00 alarm maps to its slot');

const background = fs.readFileSync(path.join(repo, 'cortex-capture-extension/background.js'), 'utf8');
const manifest = fs.readFileSync(path.join(repo, 'cortex-capture-extension/manifest.json'), 'utf8');
assert(background.indexOf('mentor-slot-watch.js') >= 0 && background.indexOf('ofk3MentorOutbox') >= 0 && background.indexOf('chrome.tabs.reload') >= 0, 'the worker restores the outbox and can refresh a logged-in tab');
assert(background.indexOf('http://127.0.0.1:3000/mentor-startup/notice') >= 0 && background.indexOf('cycle: null') >= 0, 'the existing mentor publish stays');
assert(manifest.indexOf('"alarms"') >= 0, 'the worker can wake after it stops');
assert(background.indexOf('password') < 0 && background.indexOf('signIn') < 0, 'Amazon login is not automated');

console.log('mentor-slot-watch ok');
