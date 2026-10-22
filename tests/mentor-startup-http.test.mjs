import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));
const Route = require(path.join(repo, 'mentor-startup-route.js'));
const Schedule = require(path.join(repo, 'mentor-startup-schedule.js'));

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

const NOW = new Date('2026-10-14T01:00:00.000Z');
const FRESH = NOW.toISOString();
const LATER = '2026-10-14T01:05:00.000Z';
const SUSPECT = 'Mentor未起動疑い（要確認）';
const UNKNOWN = '判定不能（原因付き）';

function view(rows, counts) {
  return {
    enabled: true,
    reason: '',
    date: '2026-10-14',
    counts: counts,
    sources: { scheduling: 'ready', mentor: 'ready' },
    rows: rows
  };
}

function person(name, id, status) {
  return {
    row: { status: status, schedulingName: name, cause: '' },
    identity: { schedulingId: id }
  };
}

function bodyFor(people, judgedAt, sample) {
  return {
    view: view(people.map(function (item) { return item.row; }), {
      total: people.length,
      active: 0,
      ended: 0,
      suspect: people.filter(function (item) { return item.row.status === SUSPECT; }).length,
      undetermined: people.filter(function (item) { return item.row.status === UNKNOWN; }).length
    }),
    identities: people.map(function (item) { return item.identity; }),
    assignments: people.map(function (item) { return { transportId: item.identity.schedulingId, routeCode: 'DCX1' }; }),
    schedulingCapturedAt: FRESH,
    mentorCapturedAt: FRESH,
    judgedAt: judgedAt,
    sample: sample === true
  };
}

function unavailableBody() {
  return {
    view: { enabled: false, reason: 'データ未取得', date: '2026-10-14', sources: { scheduling: 'ready', mentor: 'missing' }, counts: {} },
    identities: [],
    schedulingCapturedAt: FRESH,
    mentorCapturedAt: null,
    judgedAt: LATER,
    sample: true
  };
}

function start(dir) {
  const server = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      const result = Route.handle({
        method: req.method,
        path: new URL(req.url, 'http://127.0.0.1').pathname,
        body: raw ? JSON.parse(raw) : {},
        remote: '127.0.0.1',
        now: NOW,
        dir: dir
      });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      const address = server.address();
      resolve({ server: server, base: 'http://127.0.0.1:' + address.port });
    });
  });
}

function request(base, method, pathname, body) {
  return new Promise(function (resolve, reject) {
    const payload = body ? JSON.stringify(body) : '';
    const url = new URL(pathname, base);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-http-'));
const started = await start(dir);
const base = started.base;
const pair = [
  person('架空一', 'ID-1', SUSPECT),
  person('', 'ID-2', UNKNOWN)
];
const six = ['架空一', '架空二', '架空三', '架空四', '架空五', '架空六'].map(function (name, index) {
  return person(name, 'ID-' + (index + 1), SUSPECT);
});

const unset = await request(base, 'GET', '/mentor-startup/plan');
assert(unset.body.speak === false && unset.body.reason === 'unset', 'an unset clock does not auto-speak');

await request(base, 'POST', '/mentor-startup/settings', { overallTime: '10:00', cycles: {} });
const first = await request(base, 'POST', '/mentor-startup/notice', bodyFor(pair, FRESH, true));
assert(first.body.sample === true && first.body.suspectCount === 1 && first.body.undeterminedCount === 1, 'test data is marked and the two statuses stay separate');
assert(first.body.people[0].name === '架空一' && first.body.people[0].schedulingId === 'ID-1', 'the first name stays with its own id');
assert(first.body.people[1].name === '' && first.body.people[1].schedulingId === 'ID-2', 'the unnamed row keeps its own id');

const plan = await request(base, 'GET', '/mentor-startup/plan');
assert(plan.body.speak === true && plan.body.text.indexOf('架空一さんは未起動の疑いです。') >= 0, 'the suspect is named');
assert(plan.body.text.indexOf('識別子ID-2は判定不能です。') >= 0 && plan.body.text.indexOf('架空一') < plan.body.text.indexOf('識別子ID-2'), 'the missing name uses that row id and not the other name');
assert(plan.body.text.indexOf('未起動者は') < 0, 'neither status is a confirmed unstarted judgment');
const key = plan.body.key;

const again = await request(base, 'POST', '/mentor-startup/notice', bodyFor(pair, LATER, true));
const repeated = await request(base, 'GET', '/mentor-startup/plan');
assert(again.body.judgedAt === FRESH && repeated.body.key === key && repeated.body.reason === 'in-flight', 'the same capture does not become a second notification');

const failedAck = await request(base, 'POST', '/mentor-startup/ack', { key: key, ok: false });
assert(failedAck.body.kept === true, 'a failed playback stays retryable');
const retry = await request(base, 'GET', '/mentor-startup/plan');
assert(retry.body.speak === true && retry.body.key === key, 'the same notice can be read again after a playback failure');

const saved = await request(base, 'POST', '/mentor-startup/ack', { key: key, ok: true });
assert(saved.body.ok === true && saved.body.kept === false, 'a successful playback is stored');
const done = await request(base, 'GET', '/mentor-startup/plan');
assert(done.body.speak === false && done.body.reason === 'already-spoken', 'a successful playback is not repeated');

const blocked = await request(base, 'POST', '/mentor-startup/notice', unavailableBody());
assert(blocked.body.kept === true && blocked.body.people.length === 2, 'a partial capture does not erase the stored people');

const changed = bodyFor([person('架空一', 'ID-1', SUSPECT), person('架空更新', 'ID-3', SUSPECT)], LATER, true);
changed.schedulingCapturedAt = LATER;
const updated = await request(base, 'POST', '/mentor-startup/notice', changed);
const updatedPlan = await request(base, 'GET', '/mentor-startup/plan');
assert(updated.body.judgedAt === LATER && updatedPlan.body.key !== key && updatedPlan.body.speak === true, 'a changed capture becomes a new notice');
assert(updatedPlan.body.text.indexOf('架空更新さんは未起動の疑いです。') >= 0, 'the updated person is the one spoken');

const many = await request(base, 'POST', '/mentor-startup/notice', bodyFor(six, LATER, true));
assert(many.body.people.length === 6 && many.body.sample === true, 'six test people stay available for the screen');
const manySpeech = Schedule.speech({
  outcome: 'withheld',
  suspectCount: 6,
  undeterminedCount: 0,
  unconfirmed: many.body.people,
  schedulingCapturedAt: FRESH,
  mentorCapturedAt: FRESH,
  judgedAt: LATER
}, NOW, 15 * 60 * 1000).text;
assert(manySpeech.indexOf('架空五さんは未起動の疑いです。') >= 0 && manySpeech.indexOf('架空六') < 0 && manySpeech.indexOf('ほか1名は画面で確認してください。') >= 0, 'speech names five people and sends the rest to the screen');

const friday = fs.readFileSync(path.join(repo, 'friday/mentor-startup-alerts.js'), 'utf8');
assert(friday.indexOf('__FRIDAY_SPEECH_BUSY') >= 0 && friday.indexOf('payload.people') >= 0, 'FRIDAY waits for the shared speech queue and shows the people');

started.server.close();
console.log('mentor-startup-http: ok');
