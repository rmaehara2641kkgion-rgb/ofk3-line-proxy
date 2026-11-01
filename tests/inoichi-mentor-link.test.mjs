// INO-1 <-> OFK3 Mentor startup notice (read-only link).
// Notices are produced by the real OFK3 code (id-diag-core suspectView +
// mentor-startup-notice/route); INO-1 only maps them to display states.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));
const Core = require(path.join(repo, 'cortex-capture-extension/id-diag-core.js'));
const Schedule = require(path.join(repo, 'mentor-startup-schedule.js'));
const Route = require(path.join(repo, 'mentor-startup-route.js'));
const Monitor = require(path.join(repo, 'inoichi-live-monitor.js'));

var passed = 0, failed = 0;
function eq(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}
function ok(name, c) { eq(name, !!c, true); }

const DAY = '2026-10-14';
const NOW = new Date('2026-10-14T01:00:00.000Z');
const START = Date.UTC(2026, 9, 14, 0, 0, 0);
const RANGE_START = Date.UTC(2026, 9, 13, 15, 0, 0);
const RANGE_END = RANGE_START + 86400000;
const FRESH = NOW.toISOString();
const MENTOR_URL = 'https://vrm-mentor.edriving.com/reports/driver/shifts?decorate=yes&startTime=' + RANGE_START + '&endTime=' + RANGE_END + '&localDate=' + DAY;
const SCHED = 'S1YAMAD45NAME01';
const OTHER = 'S2SATOH45NAME01';
const MIN = 60000;

function person(id, family, given) {
  return { driverPersonId: id, driverName: family + ' ' + given, driverLastName: family, driverFirstName: given,
    reservations: [{ date: DAY, daPersonId: id, startTimeInMinutes: 9 * 60, startTimeInEpoch: START, status: 'ASSIGNED' }] };
}
function mentorRow(staff, family, given) {
  return { driverId: 'D' + staff, realStaffNumber: staff, firstName: given, lastName: family, shiftEndTime: 'N/A', vrmStatus: 'Active' };
}
function load(people, rows) {
  const book = Core.createSession(function () { return NOW; });
  book.ingestScheduling({ ok: true, capturedAt: FRESH, fromDate: '2026-10-13', people: people });
  if (rows) book.ingestMentor(Core.mentorDigest({ data: rows }, FRESH, MENTOR_URL));
  book.ingestMaster({ ok: true, phase: 'ready', loadedAt: NOW.getTime(), entries: people.map(function (p) { return { name: p.driverName, japaneseName: p.driverName, transportId: p.driverPersonId, department: 'GDSダイレクト' }; }) });
  return book;
}
function publish(dir, book, assignments) {
  const h = book.startupHandoff(DAY);
  return Route.handle({ method: 'POST', path: '/mentor-startup/notice', remote: '127.0.0.1', now: NOW, dir: dir,
    body: { view: h.view, identities: h.identities, assignments: assignments, schedulingCapturedAt: FRESH, mentorCapturedAt: FRESH, judgedAt: FRESH } });
}
function getNotice(dir) {
  return Route.handle({ method: 'GET', path: '/mentor-startup/notice', remote: '127.0.0.1', now: NOW, dir: dir }).body;
}
function tmp(n) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ino-mentor-' + n + '-')); }
function route(code) { return [{ transportId: SCHED, routeCode: code }]; }
function wrap(payload) { return { ok: true, payload: payload, fetchedAt: FRESH, source: 'test' }; }
function judge(payload, plusMin) {
  return Monitor.judgeMentor(wrap(payload), NOW.getTime() + (plusMin === undefined ? 1 : plusMin) * MIN);
}

// ---- real notices from the real OFK3 code ----
const suspectDir = tmp('suspect');
publish(suspectDir, load([person(SCHED, '山田', '太郎'), person(OTHER, '佐藤', '花子')], [mentorRow('M1OTHER45NAME01', '別', '人')]),
  [{ transportId: SCHED, routeCode: 'DCX47' }, { transportId: OTHER, routeCode: 'DCX48' }]);
const suspectPayload = getNotice(suspectDir);

const clearDir = tmp('clear');
publish(clearDir, load([person(SCHED, '山田', '太郎')], [mentorRow(SCHED, '山田', '太郎')]), route('DCX47'));
const clearPayload = getNotice(clearDir);

const failDir = tmp('fail');
{
  const b = Core.createSession(function () { return NOW; });
  b.ingestScheduling({ ok: true, capturedAt: FRESH, fromDate: '2026-10-13', people: [person(SCHED, '山田', '太郎')] });
  b.ingestMentor({ ok: false, issue: 'FAILED', capturedAt: FRESH });
  publish(failDir, b, route('DCX47'));
}
const unavailablePayload = getNotice(failDir);

const multiDir = tmp('multi');
publish(multiDir, load([person(SCHED, '山田', '太郎'), person(OTHER, '佐藤', '花子')], [mentorRow('M1OTHER45NAME01', '別', '人')]),
  [{ transportId: SCHED, routeCode: 'DCX47' }, { transportId: OTHER, routeCode: 'DMX3' }]);
const multiPayload = getNotice(multiDir);
const emptyPayload = getNotice(tmp('empty'));

// (1) suspects -> warn, never "confirmed unstarted"
var s = judge(suspectPayload);
eq('(1) suspects -> warn', s.status, 'warn');
eq('(1b) suspect count surfaced', s.metrics.filter(function (m) { return /未起動疑い/.test(m.label); })[0].value, 2);
ok('(1c) never says confirmed unstarted', !/未起動(が)?確定|未起動者は/.test(JSON.stringify(s)) && /確定ではありません/.test(s.reason));
eq('(1d) suspect rows carry the suspect label', s.rows.filter(function (r) { return r.category === 'suspect'; }).length, 2);
ok('(1e) basis (sources/cycle) is shown', s.notes.some(function (n) { return /スケジュール=/.test(n) && /サイクル1/.test(n); }));
ok('(1f) judged time kept', !!s.judgedAt && !!s.sourceUpdatedAt);

// (2) clear + fresh -> ok (and says it is not identity/attendance proof)
var c = judge(clearPayload);
eq('(2) clear fresh -> ok', c.status, 'ok');
eq('(2b) active candidate counted separately', [c.metrics[1].value, c.metrics[3].value], [1, 0]);
ok('(2c) not framed as roll-call done', c.notes.some(function (n) { return /点呼完了ではありません/.test(n); }));

// (3) clear but undetermined > 0 must NOT be fully ok
var mixed = JSON.parse(JSON.stringify(clearPayload));
mixed.undeterminedCount = 1; mixed.notices.forEach(function (n) { n.undeterminedCount = 1; });
var m = judge(mixed);
eq('(3) clear + undetermined -> undetermined', m.status, 'undetermined');
ok('(3b) reason mentions 判定不能 and not-normal', /判定不能 1/.test(m.reason) && /完全な正常とは判定できません/.test(m.reason));

// (4) OFK3 could not judge (source failure) -> undetermined, no counts, no names
var u = judge(unavailablePayload);
eq('(4) unavailable -> undetermined', u.status, 'undetermined');
eq('(4b) counts are null, not 0', u.metrics.map(function (x) { return x.value; }), [null, null, null, null, null]);
eq('(4c) no person rows', u.rows.filter(function (r) { return r.category === 'suspect' || r.category === 'undetermined'; }).length, 0);

// (5) no notice at all (extension/tabs not sending) -> undetermined
var e = judge(emptyPayload);
eq('(5) empty -> undetermined, not ok', e.status, 'undetermined');
ok('(5b) says not retrieved', /未取得/.test(e.reason));

// (6) 15-minute freshness (same limit as OFK3) and equivalence with OFK3's own speech rule
eq('(6) 14 min -> still judged', judge(clearPayload, 14).status, 'ok');
eq('(6b) 16 min -> stale', judge(clearPayload, 16).status, 'stale');
eq('(6c) stale suspects are not shown as current', judge(suspectPayload, 16).status, 'stale');
eq('(6d) stale shows no counts or names', [judge(suspectPayload, 16).metrics.map(function (x) { return x.value; }), judge(suspectPayload, 16).rows.filter(function (r) { return r.category === 'suspect'; }).length], [[null, null, null, null, null], 0]);
[1, 14, 16, 60].forEach(function (min) {
  const at = new Date(NOW.getTime() + min * MIN);
  const ofk3Stale = Schedule.speech(clearPayload.notices[0], at, Core.STALE_MS).outcome === 'unavailable';
  eq('(6e) INO-1 freshness == OFK3 freshness at +' + min + ' min', judge(clearPayload, min).status === 'stale', ofk3Stale);
});
const old = JSON.parse(JSON.stringify(clearPayload));
old.notices.forEach(function (n) { n.mentorCapturedAt = new Date(NOW.getTime() - 20 * MIN).toISOString(); });
old.mentorCapturedAt = old.notices[0].mentorCapturedAt;
eq('(6f) any one stale capture time makes it stale', judge(old, 1).status, 'stale');
const missingTime = JSON.parse(JSON.stringify(clearPayload));
missingTime.notices.forEach(function (n) { n.judgedAt = null; });
missingTime.judgedAt = null;
eq('(6g) missing judged time is stale, not ok', judge(missingTime, 1).status, 'stale');

// (7) multiple cycles
eq('(7) two notices', multiPayload.notices.length, 2);
var mc = judge(multiPayload);
eq('(7b) multi-cycle suspects -> warn with summed count', [mc.status, mc.metrics[3].value], ['warn', 2]);
ok('(7c) cycles listed', mc.notes.some(function (n) { return /対象サイクル: サイクル1、サイクル2/.test(n); }));
const oneStale = JSON.parse(JSON.stringify(multiPayload));
oneStale.notices[1].judgedAt = new Date(NOW.getTime() - 30 * MIN).toISOString();
var os1 = judge(oneStale, 1);
eq('(7d) one stale cycle: warn kept for the fresh cycle, stale cycle excluded', [os1.status, os1.metrics[3].value], ['warn', 1]);
ok('(7e) stale cycle noted', os1.notes.some(function (n) { return /15分を超えて古い/.test(n); }));
const clearMulti = JSON.parse(JSON.stringify(multiPayload));
clearMulti.notices.forEach(function (n) { n.outcome = 'clear'; n.suspectCount = 0; n.undeterminedCount = 0; n.unconfirmed = []; });
clearMulti.notices[1].judgedAt = new Date(NOW.getTime() - 30 * MIN).toISOString();
eq('(7f) clear + one stale cycle is NOT ok', judge(clearMulti, 1).status, 'stale');
const clearUnavail = JSON.parse(JSON.stringify(clearMulti));
clearUnavail.notices[1].judgedAt = FRESH; clearUnavail.notices[1].outcome = 'unavailable'; clearUnavail.notices[1].outcomeReason = 'Mentor取得失敗';
eq('(7g) clear + one unavailable cycle is NOT ok', judge(clearUnavail, 1).status, 'undetermined');

// (8) fetch failure / malformed
eq('(8) OFK3 connection failed -> failed', Monitor.judgeMentor({ ok: false, error: 'ECONNREFUSED' }, NOW.getTime()).status, 'failed');
eq('(8b) bad payload -> failed', Monitor.judgeMentor(wrap({ hello: 1 }), NOW.getTime()).status, 'failed');
eq('(8c) unknown outcome -> failed', Monitor.judgeMentor(wrap({ ok: true, notices: [{ outcome: 'weird' }] }), NOW.getTime()).status, 'failed');
eq('(8d) no mentor fetch configured -> unsupported', Monitor.judgeMentor(undefined, NOW.getTime()).status, 'unsupported');

// (9) privacy: only whitelisted fields; no scheduling IDs; names only on usable notices
const flat = JSON.stringify([s, c, u, e, mc]);
ok('(9) no scheduling id leaks', flat.indexOf(SCHED) < 0 && flat.indexOf(OTHER) < 0 && flat.indexOf('schedulingId') < 0);
ok('(9b) stale notices expose no names', JSON.stringify(judge(suspectPayload, 16)).indexOf('山田') < 0 && JSON.stringify(judge(suspectPayload, 16)).indexOf('佐藤') < 0);

// (10) important alert aggregation
var st = Monitor.buildMonitorState({ fetches: { rolling60h: { ok: false, error: 'x' }, mentor: wrap(suspectPayload) }, now: NOW.getTime() + MIN });
eq('(10) important aggregates mentor suspects', [st.cards[0].status, st.cards[0].rows.filter(function (r) { return /Mentor監視/.test(r.categoryLabel); }).length], ['warn', 2]);
var st2 = Monitor.buildMonitorState({ fetches: { rolling60h: { ok: false, error: 'x' }, mentor: wrap(clearPayload) }, now: NOW.getTime() + MIN });
ok('(10b) important is not ok while rolling is failed', st2.cards[0].status !== 'ok');
eq('(10c) link failed when any feed failed', st2.link.status, 'failed');

// (11) source guard: no re-implementation of the matcher in INO-1
['inoichi-live-monitor.js', 'inoichi-server.js', 'inoichi-dashboard.js'].forEach(function (f) {
  const src = fs.readFileSync(path.join(repo, f), 'utf8');
  ok('(11) ' + f + ' does not contain the matcher', src.indexOf('ingestMentor') < 0 && src.indexOf('buildSuspectList') < 0 && src.indexOf('id-diag-core') < 0);
});
const mentorSrc = ['mentor-startup-route.js', 'mentor-startup-notice.js', 'cortex-capture-extension/id-diag-core.js'].map(function (f) { return fs.readFileSync(path.join(repo, f), 'utf8'); }).join('\n');
ok('(11b) OFK3 Mentor code does not reference INO-1 (no push to INO-1)', !/inoichi-server|127\.0\.0\.1:8765|\/api\/monitor/.test(mentorSrc));

// ---- server level: INO-1 server <- mock OFK3 hosting the real route ----
var upstreamRequests = [];
var mentorDir = suspectDir;
var rolling = { ok: true, app: 'harvest-rolling60h', connected: true, stale: false, safe: true, referenceDate: DAY, actualThrough: DAY, alerts: [] };
const mock = http.createServer(function (req, res) {
  upstreamRequests.push(req.method + ' ' + req.url);
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (req.url === '/harvest/rolling60h/alerts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.assign({}, rolling, { checkedAt: new Date().toISOString() })));
  }
  if (req.url === '/mentor-startup/notice') {
    if (mentorDir === null) { res.writeHead(503); return res.end('down'); }
    var body = getNotice(mentorDir);
    // test-only: re-stamp capture times to "now" so the 15-minute rule sees fresh data
    var nowIso = new Date().toISOString();
    (body.notices || []).forEach(function (n) { n.schedulingCapturedAt = nowIso; n.mentorCapturedAt = nowIso; n.judgedAt = nowIso; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  res.writeHead(404); res.end();
});
await new Promise(function (r) { mock.listen(0, '127.0.0.1', r); });
function startIno() {
  return new Promise(function (resolve, reject) {
    const cp = spawn(process.execPath, [path.join(repo, 'inoichi-server.js')], { env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1', OFK3_BASE_URL: 'http://127.0.0.1:' + mock.address().port }) });
    var out = '';
    cp.stdout.on('data', function (d) { out += d; var mm = out.match(/127\.0\.0\.1:(\d+)/); if (mm) resolve({ cp: cp, port: Number(mm[1]) }); });
    setTimeout(function () { reject(new Error('start timeout')); }, 8000);
  });
}
function get(port, p, headers) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: port, path: p, headers: headers || {} }, function (res) {
      var b = []; res.on('data', function (x) { b.push(x); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }); });
    }).on('error', reject);
  });
}
async function monitor(port) { return JSON.parse((await get(port, '/api/monitor')).body); }

var ino = await startIno();
try {
  var r = await get(ino.port, '/api/monitor');
  var state = JSON.parse(r.body);
  var mcard = state.cards.filter(function (x) { return x.id === 'mentor'; })[0];
  eq('(12) server: mentor card from real OFK3 route -> warn', mcard.status, 'warn');
  ok('(12b) server response carries no scheduling IDs', r.body.indexOf(SCHED) < 0 && r.body.indexOf('schedulingId') < 0);
  ok('(12c) no CORS header on the monitor response', !r.headers['access-control-allow-origin']);
  eq('(12d) only GETs to the two allowed OFK3 paths', Array.from(new Set(upstreamRequests)).sort(), ['GET /harvest/rolling60h/alerts', 'GET /mentor-startup/notice']);
  eq('(13) foreign Host header refused', (await get(ino.port, '/api/monitor', { Host: 'evil.example' })).status, 403);
  eq('(13b) cross-site fetch refused', (await get(ino.port, '/api/monitor', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  eq('(13c) foreign Origin refused', (await get(ino.port, '/api/monitor', { Origin: 'http://evil.example' })).status, 403);
} finally { ino.cp.kill(); }

mentorDir = clearDir;
ino = await startIno();
try {
  var s2 = await monitor(ino.port);
  eq('(14) server: clear notice -> ok', s2.cards.filter(function (x) { return x.id === 'mentor'; })[0].status, 'ok');
  ok('(14b) server: important not ok while other monitors are unsupported', s2.cards[0].status !== 'ok');
} finally { ino.cp.kill(); }

mentorDir = null;
ino = await startIno();
try {
  var s3 = await monitor(ino.port);
  eq('(15) server: OFK3 mentor endpoint down -> mentor failed, rolling still judged', [s3.cards[1].status, s3.cards[2].status], ['failed', 'ok']);
  eq('(15b) server: link not ok when a feed failed', s3.link.status, 'failed');
} finally { ino.cp.kill(); }
mock.close();

console.log('inoichi-mentor-link tests ' + (failed ? 'failed' : 'passed') + ' (' + passed + ' ok, ' + failed + ' failed)');
process.exit(failed ? 1 : 0);
