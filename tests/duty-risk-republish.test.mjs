import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const republish = require('../duty-risk-republish.js');
const pub = require('../duty-risk-publication.js');
const snap = require('../duty-risk-snapshot.js');
const route = require('../duty-risk-republish-route.js');

const token = 'duty-risk-token-do-not-log';
const person = '架空氏名ログ禁止';
const olderAt = '2026-10-20T00:00:00.000Z';
const checkedAt = '2026-10-21T02:07:52.450Z';
const newerAt = '2026-10-22T03:00:00.000Z';
const snapshotFile = 'local/inoichi-rolling-snapshot.json';
const queueFile = path.join(path.dirname(snapshotFile), 'duty-risk-publish-queue.json');

function memoryFs(initial) {
  const files = Object.assign({}, initial || {});
  return {
    files: files,
    mkdirSync: function () {},
    writeFileSync: function (file, data) { files[String(file)] = String(data); },
    readFileSync: function (file) {
      if (!Object.prototype.hasOwnProperty.call(files, String(file))) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files[String(file)];
    },
    renameSync: function (from, to) {
      if (!Object.prototype.hasOwnProperty.call(files, String(from))) throw new Error('ENOENT');
      files[String(to)] = files[String(from)];
      delete files[String(from)];
    },
    unlinkSync: function (file) { delete files[String(file)]; },
  };
}

function viewPair(at, name) {
  return {
    snapshot: {
      checkedAt: at,
      usable: true,
      fetchStatus: 'success',
      alerts: [{ name: name || person, disposition: 'exceed' }],
    },
    history: {
      runs: [{
        predictedAt: at,
        referenceDate: '2026-10-21',
        predictions: [{ subjectId: 'TID-1', start: '2026-10-15', end: '2026-10-21', predictedTotal: 61, level: 'exceed', days: [] }],
      }],
    },
  };
}

function captured(at) {
  return {
    summary: {
      ok: true,
      checkedAt: at,
      fileSuccess: 2,
      fileFailure: 0,
      historyCreated: 1,
      historyDuplicate: false,
      historySaved: true,
    },
    drivers: [{
      transportId: 'TID-1',
      name: person,
      judgment: 'evaluated',
      windows: [{ judgment: 'exceed', complete: true, startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 61, overBy: 1 }],
    }],
    predictions: [{ subjectId: 'TID-1', start: '2026-10-15', end: '2026-10-21', predictedTotal: 61, level: 'exceed' }],
  };
}

function historyFor(at) {
  return {
    runs: [{
      predictedAt: at,
      referenceDate: '2026-10-21',
      predictions: [{ subjectId: 'TID-1', start: '2026-10-15', end: '2026-10-21', predictedTotal: 61, level: 'exceed', days: [] }],
    }],
  };
}

function queueOf(disk) {
  return JSON.parse(disk.files[queueFile]);
}

function logsClear(lines) {
  const text = (lines || []).join('\n');
  assert.equal(text.includes(token), false);
  assert.equal(text.includes(person), false);
  assert.equal(text.includes('TID-1'), false);
  assert.equal(text.includes('predictions'), false);
  assert.equal(text.includes('alerts'), false);
}

const store = pub.createMemoryStore();
let partWrites = 0;
const counting = {
  readPointer: function () { return store.readPointer(); },
  readPart: function (generation, name) { return store.readPart(generation, name); },
  writePointer: function (value) { partWrites += 1; store.writePointer(value); },
  writePart: function (generation, name, value) { partWrites += 1; store.writePart(generation, name, value); },
};
const older = pub.selectPair(viewPair(olderAt).snapshot, viewPair(olderAt).history);
const firstSaved = pub.publishToStore(counting, older);
assert.equal(firstSaved.published, true);
const firstGeneration = pub.readPublished(store).generation;
const writesAfterFirst = partWrites;
const duplicateSave = pub.publishToStore(counting, older);
assert.equal(duplicateSave.published, false);
assert.equal(duplicateSave.duplicate, true);
assert.equal(duplicateSave.reason, 'already-published');
assert.equal(duplicateSave.generation, firstGeneration);
assert.equal(partWrites, writesAfterFirst);
assert.equal(pub.readPublished(store).checkedAt, olderAt);
assert.equal(pub.readPublished(store).generation, firstGeneration);

const newer = pub.selectPair(viewPair(newerAt).snapshot, viewPair(newerAt).history);
const newerSaved = pub.publishToStore(counting, newer);
assert.equal(newerSaved.published, true);
assert.equal(pub.readPublished(store).checkedAt, newerAt);
const writesAfterNewer = partWrites;
const staleSave = pub.publishToStore(counting, older);
assert.equal(staleSave.published, false);
assert.equal(staleSave.reason, 'stale');
assert.equal(partWrites, writesAfterNewer);
assert.equal(pub.readPublished(store).checkedAt, newerAt);
assert.equal(pub.readPublished(store).snapshot.alerts[0].name, person);

store.writePointer({ generation: 'gen-bad', checkedAt: 'not-a-date' });
const incomparable = pub.publishToStore(counting, newer);
assert.equal(incomparable.reason, 'mismatch');
assert.equal(incomparable.published, false);
assert.equal(store.readPointer().checkedAt, 'not-a-date');
store.writePointer({ generation: newerSaved.generation, checkedAt: newerAt });

const live = pub.createMemoryStore();
const previousGood = viewPair(olderAt, '前回正常');
pub.publishToStore(live, pub.selectPair(previousGood.snapshot, previousGood.history));
assert.equal(pub.readPublished(live).snapshot.alerts[0].name, '前回正常');

const previousSnapshot = { checkedAt: olderAt, usable: true, fetchStatus: 'success', alerts: [{ name: '前回正常' }] };
const disk = memoryFs({ [snapshotFile]: JSON.stringify(previousSnapshot) });
const logs = [];
const failed = await snap.finish({
  fs: disk,
  path: path,
  captured: captured(checkedAt),
  history: historyFor(checkedAt),
  snapshotFile: snapshotFile,
  client: {
    publish: function () { return Promise.reject(new Error('timeout ' + token)); },
  },
  log: function (line) { logs.push(line); },
});
assert.equal(failed.save.replaced, true);
assert.equal(failed.publish.published, false);
assert.equal(failed.publish.reason, 'timeout');
assert.equal(failed.lines.length, 3);
assert.equal(JSON.parse(disk.files[snapshotFile]).checkedAt, checkedAt);
const queued = queueOf(disk);
assert.equal(queued.items.length, 1);
assert.equal(queued.items[0].status, 'pending');
assert.equal(queued.items[0].snapshot.checkedAt, checkedAt);
assert.equal(queued.items[0].historyRun.predictedAt, checkedAt);
assert.equal(JSON.stringify(queued).includes(token), false);
logsClear(logs);
logsClear(failed.lines);
assert.equal(pub.readPublished(live).checkedAt, olderAt);
assert.equal(pub.readPublished(live).snapshot.alerts[0].name, '前回正常');

const snapshotBeforeRetry = disk.files[snapshotFile];
let publishCalls = [];
function client(mode) {
  return {
    token: token,
    current: function () { return pub.readPublished(live); },
    publish: function (body) {
      publishCalls.push(body.snapshot.checkedAt);
      assert.equal(body.snapshot.checkedAt, body.historyRun.predictedAt);
      assert.equal(JSON.stringify(body).includes(token), false);
      if (mode.hang) return new Promise(function () {});
      if (mode.fail) return Promise.reject(new Error(token));
      return pub.publishToStore(live, pub.selectPair(body.snapshot, { runs: [body.historyRun] }));
    },
  };
}

const retryLogs = [];
const hung = await republish.retrySaved({
  fs: disk,
  path: path,
  queueFile: queueFile,
  client: client({ hang: true }),
  timeoutMs: 30,
  log: function (line) { retryLogs.push(line); },
});
assert.equal(hung.results[0].reason, 'timeout');
assert.equal(hung.results[0].published, false);
assert.equal(queueOf(disk).items[0].status, 'pending');
assert.equal(pub.readPublished(live).checkedAt, olderAt);
assert.equal(pub.readPublished(live).snapshot.alerts[0].name, '前回正常');
assert.equal(disk.files[snapshotFile], snapshotBeforeRetry);
assert.equal(publishCalls.length, 1);
logsClear(retryLogs);

publishCalls = [];
const currentHung = await republish.retrySaved({
  fs: disk,
  path: path,
  queueFile: queueFile,
  client: {
    current: function () { return new Promise(function () {}); },
    publish: function () { publishCalls.push('sent'); return { ok: true, published: true, checkedAt: checkedAt }; },
  },
  timeoutMs: 30,
  log: function (line) { retryLogs.push(line); },
});
assert.equal(currentHung.results[0].reason, 'timeout');
assert.equal(publishCalls.length, 0);
assert.equal(queueOf(disk).items[0].status, 'pending');
assert.equal(pub.readPublished(live).checkedAt, olderAt);
assert.equal(pub.readPublished(live).snapshot.alerts[0].name, '前回正常');

const secretLogs = [];
const leaked = await republish.retrySaved({
  fs: disk,
  path: path,
  queueFile: queueFile,
  client: client({ fail: true }),
  timeoutMs: 1000,
  log: function (line) { secretLogs.push(line); },
});
assert.equal(leaked.results[0].reason, 'incomplete');
assert.equal(queueOf(disk).items[0].status, 'pending');
assert.equal(JSON.stringify(queueOf(disk)).includes(token), false);
logsClear(secretLogs);
assert.equal(pub.readPublished(live).checkedAt, olderAt);

publishCalls = [];
const sent = await republish.retrySaved({
  fs: disk,
  path: path,
  queueFile: queueFile,
  client: client({}),
  timeoutMs: 1000,
  log: function (line) { retryLogs.push(line); },
});
assert.equal(sent.results[0].published, true);
assert.equal(sent.results[0].reason, 'published');
assert.equal(sent.results[0].checkedAt, checkedAt);
assert.equal(publishCalls.length, 1);
assert.equal(pub.readPublished(live).checkedAt, checkedAt);
assert.equal(pub.readPublished(live).historyRun.predictedAt, checkedAt);
assert.equal(queueOf(disk).items[0].status, 'published');
logsClear(retryLogs);

const beforeDuplicate = pub.readPublished(live).generation;
publishCalls = [];
const again = await republish.retrySaved({
  fs: disk,
  path: path,
  queueFile: queueFile,
  client: client({}),
  log: function (line) { retryLogs.push(line); },
});
assert.equal(again.results[0].reason, 'nothing-pending');
assert.equal(publishCalls.length, 0);
assert.equal(pub.readPublished(live).generation, beforeDuplicate);

const queuedAgain = queueOf(disk);
queuedAgain.items[0].status = 'pending';
disk.files[queueFile] = JSON.stringify(queuedAgain);
publishCalls = [];
const already = await republish.retrySaved({
  fs: disk,
  path: path,
  queueFile: queueFile,
  client: client({}),
  log: function (line) { retryLogs.push(line); },
});
assert.equal(already.results[0].reason, 'already-published');
assert.equal(already.results[0].duplicate, true);
assert.equal(publishCalls.length, 0);
assert.equal(pub.readPublished(live).generation, beforeDuplicate);
assert.equal(queueOf(disk).items[0].status, 'published');

const oldDisk = memoryFs();
const oldPair = viewPair(olderAt);
const newPair = viewPair(newerAt);
oldDisk.files[queueFile] = JSON.stringify({
  version: 1,
  items: [
    { checkedAt: olderAt, status: 'pending', attempts: 0, snapshot: oldPair.snapshot, historyRun: oldPair.history.runs[0] },
    { checkedAt: newerAt, status: 'pending', attempts: 0, snapshot: newPair.snapshot, historyRun: newPair.history.runs[0] },
  ],
});
const fresh = pub.createMemoryStore();
pub.publishToStore(fresh, pub.selectPair(viewPair(olderAt, '前回正常').snapshot, viewPair(olderAt, '前回正常').history));
const keptGeneration = pub.readPublished(fresh).generation;
const order = [];
const reversed = await republish.retrySaved({
  fs: oldDisk,
  path: path,
  queueFile: queueFile,
  client: {
    current: function () { return pub.readPublished(fresh); },
    publish: function (body) {
      order.push(body.snapshot.checkedAt);
      assert.equal(body.snapshot.checkedAt, body.historyRun.predictedAt);
      return pub.publishToStore(fresh, pub.selectPair(body.snapshot, { runs: [body.historyRun] }));
    },
  },
  log: function () {},
});
assert.deepEqual(order, [newerAt]);
assert.equal(reversed.results[0].published, true);
assert.equal(reversed.results[0].checkedAt, newerAt);
assert.equal(reversed.results[1].reason, 'stale');
assert.equal(pub.readPublished(fresh).checkedAt, newerAt);
assert.notEqual(pub.readPublished(fresh).generation, keptGeneration);
const oldItem = queueOf(oldDisk).items.filter(function (item) { return item.checkedAt === olderAt; })[0];
assert.equal(oldItem.status, 'superseded');
assert.equal(oldItem.snapshot.checkedAt, olderAt);
assert.equal(oldItem.historyRun.predictedAt, olderAt);

const guarded = pub.createMemoryStore();
pub.publishToStore(guarded, pub.selectPair(newPair.snapshot, newPair.history));
const guardedGeneration = pub.readPublished(guarded).generation;
const guardDisk = memoryFs();
guardDisk.files[queueFile] = JSON.stringify({
  version: 1,
  items: [{ checkedAt: olderAt, status: 'pending', attempts: 0, snapshot: oldPair.snapshot, historyRun: oldPair.history.runs[0] }],
});
let guardSends = 0;
const guardedRetry = await republish.retrySaved({
  fs: guardDisk,
  path: path,
  queueFile: queueFile,
  client: {
    publish: function (body) {
      guardSends += 1;
      return pub.publishToStore(guarded, pub.selectPair(body.snapshot, { runs: [body.historyRun] }));
    },
  },
  log: function () {},
});
assert.equal(guardSends, 1);
assert.equal(guardedRetry.results[0].reason, 'stale');
assert.equal(pub.readPublished(guarded).checkedAt, newerAt);
assert.equal(pub.readPublished(guarded).generation, guardedGeneration);
assert.equal(JSON.parse(guardDisk.files[queueFile]).items[0].status, 'superseded');

const mismatchDisk = memoryFs({ [snapshotFile]: snapshotBeforeRetry });
const mismatchSnapshot = viewPair(checkedAt).snapshot;
const mismatchRun = viewPair(checkedAt).history.runs[0];
mismatchRun.predictedAt = '2026-10-21T02:07:52.451Z';
mismatchDisk.files[queueFile] = JSON.stringify({
  version: 1,
  items: [{ checkedAt: checkedAt, status: 'pending', attempts: 0, snapshot: mismatchSnapshot, historyRun: mismatchRun }],
});
let mismatchSends = 0;
const mismatchLogs = [];
const mismatch = await republish.retrySaved({
  fs: mismatchDisk,
  path: path,
  queueFile: queueFile,
  client: {
    current: function () { return pub.readPublished(live); },
    publish: function () { mismatchSends += 1; return { ok: true, published: true, checkedAt: checkedAt }; },
  },
  log: function (line) { mismatchLogs.push(line); },
});
assert.equal(mismatch.results[0].reason, 'mismatch');
assert.equal(mismatchSends, 0);
assert.equal(pub.readPublished(live).checkedAt, checkedAt);
assert.equal(mismatchDisk.files[snapshotFile], snapshotBeforeRetry);
const mismatchItem = JSON.parse(mismatchDisk.files[queueFile]).items[0];
assert.equal(mismatchItem.status, 'rejected');
assert.equal(mismatchItem.snapshot.checkedAt, checkedAt);
assert.notEqual(mismatchItem.snapshot.checkedAt, mismatchItem.historyRun.predictedAt);
logsClear(mismatchLogs);

const calls = [];
const app = { post: function (routePath, fn) { calls.push({ routePath: routePath, fn: fn }); } };
let retried = false;
route.mount(app, {
  isLoopback: function () { return false; },
  retry: function () { retried = true; },
});
const denied = { code: 0, body: null, status: function (code) { denied.code = code; return denied; }, json: function (body) { denied.body = body; return denied; } };
calls[0].fn({ get: function () { return '1'; } }, denied);
assert.equal(denied.code, 403);
assert.equal(retried, false);

const allowed = { code: 0, body: null, status: function (code) { allowed.code = code; return allowed; }, json: function (body) { allowed.body = body; return allowed; } };
calls.length = 0;
route.mount(app, {
  isLoopback: function () { return true; },
  retry: function () {
    return {
      ok: true,
      results: [{
        checkedAt: checkedAt,
        published: true,
        reason: 'published',
        generation: 'gen-1',
        token: token,
        snapshot: { alerts: [{ name: person }] },
        historyRun: { predictions: [{ subjectId: 'TID-1' }] },
      }],
    };
  },
});
await calls[0].fn({ get: function (header) { return header === 'X-Harvest-Local' ? '1' : ''; } }, allowed);
assert.equal(allowed.code, 200);
assert.equal(JSON.stringify(allowed.body).includes(token), false);
assert.equal(JSON.stringify(allowed.body).includes(person), false);
assert.equal(JSON.stringify(allowed.body).includes('TID-1'), false);
assert.equal(allowed.body.results[0].published, true);
assert.equal(allowed.body.results[0].checkedAt, checkedAt);

const server = fs.readFileSync(new URL('../render-webhook-server.js', import.meta.url), 'utf8');
const runAt = server.indexOf("require('./harvest-rolling60h-run.js').capture(");
const republishAt = server.indexOf('duty-risk-republish-route.js');
assert.ok(runAt > 0 && republishAt > runAt);
assert.equal(server.includes('return summary;'), true);
assert.equal(server.includes("message.split(token).join('[redacted]')"), true);
const source = fs.readFileSync(new URL('../duty-risk-republish.js', import.meta.url), 'utf8');
assert.equal(source.includes('harvest-rolling60h-run'), false);
assert.equal(source.includes('rolling60h-core'), false);
assert.equal(source.includes('xlsx'), false);
assert.equal(source.includes('DUTY_RISK_GAS_TOKEN'), false);
const gas = fs.readFileSync(new URL('../gas/duty-risk-store.gs', import.meta.url), 'utf8');
const postAt = gas.indexOf('function doPost');
assert.ok(gas.indexOf("reason: 'already-published'", postAt) < gas.indexOf("generation + '-snapshot.json'", postAt));
assert.ok(gas.indexOf("reason: 'stale'", postAt) < gas.indexOf("generation + '-snapshot.json'", postAt));
const runner = fs.readFileSync(new URL('../harvest-rolling60h-run.js', import.meta.url), 'utf8');
assert.equal(runner.includes('duty-risk-republish'), false);
const historySource = fs.readFileSync(new URL('../harvest-rolling60h-history.js', import.meta.url), 'utf8');
assert.equal(historySource.includes('duty-risk'), false);

const restartAt = '2026-10-21T04:00:00.000Z';
const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-risk-queue-'));
try {
  const restartQueue = path.join(restartDir, 'duty-risk-publish-queue.json');
  const restartCurrent = path.join(restartDir, 'current.json');
  const restartOut = path.join(restartDir, 'out.json');
  const restartChild = path.join(restartDir, 'restore.mjs');
  const restartPair = viewPair(restartAt);
  const remembered = republish.remember(fs, path, restartQueue, restartPair.snapshot, restartPair.history, { published: false, reason: 'timeout' });
  assert.equal(remembered.ok, true);
  const cold = JSON.parse(fs.readFileSync(restartQueue, 'utf8'));
  assert.equal(cold.items.length, 1);
  assert.equal(cold.items[0].status, 'pending');
  assert.equal(cold.items[0].snapshot.checkedAt, cold.items[0].historyRun.predictedAt);
  fs.writeFileSync(restartCurrent, JSON.stringify({ ok: false, reason: 'not-published' }));
  const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'duty-risk-republish.js');
  fs.writeFileSync(restartChild, [
    "import fs from 'fs';",
    "import path from 'path';",
    "import { createRequire } from 'module';",
    'const require = createRequire(import.meta.url);',
    'const republish = require(' + JSON.stringify(modulePath) + ');',
    'const queueFile = ' + JSON.stringify(restartQueue) + ';',
    'const current = JSON.parse(fs.readFileSync(' + JSON.stringify(restartCurrent) + ", 'utf8'));",
    'const sent = [];',
    'const result = await republish.retrySaved({',
    '  fs: fs,',
    '  path: path,',
    '  queueFile: queueFile,',
    '  client: {',
    '    current: function () { return current; },',
    '    publish: function (body) {',
    '      sent.push({ checkedAt: body.snapshot.checkedAt, predictedAt: body.historyRun.predictedAt });',
    "      return { ok: true, published: true, checkedAt: body.snapshot.checkedAt, generation: 'gen-after-restart' };",
    '    },',
    '  },',
    '  log: function () {},',
    '});',
    'fs.writeFileSync(' + JSON.stringify(restartOut) + ', JSON.stringify({ result: result, sent: sent }));',
  ].join('\n'));
  const restoredRun = spawnSync(process.execPath, [restartChild], { encoding: 'utf8' });
  assert.equal(restoredRun.status, 0, restoredRun.stderr || restoredRun.stdout);
  const restored = JSON.parse(fs.readFileSync(restartOut, 'utf8'));
  assert.equal(restored.sent.length, 1);
  assert.equal(restored.sent[0].checkedAt, restartAt);
  assert.equal(restored.sent[0].predictedAt, restartAt);
  assert.equal(restored.result.results[0].published, true);
  assert.equal(restored.result.results[0].generation, 'gen-after-restart');
  const afterRestart = JSON.parse(fs.readFileSync(restartQueue, 'utf8'));
  assert.equal(afterRestart.items[0].status, 'published');
  assert.equal(afterRestart.items[0].generation, 'gen-after-restart');
  assert.equal(fs.readFileSync(restartOut, 'utf8').includes(token), false);
  assert.equal(fs.readFileSync(restartOut, 'utf8').includes(person), false);
} finally {
  fs.rmSync(restartDir, { recursive: true, force: true });
}

const followDisk = memoryFs({ [snapshotFile]: JSON.stringify(previousSnapshot) });
const followStore = pub.createMemoryStore();
pub.publishToStore(followStore, pub.selectPair(viewPair(olderAt, '前回正常').snapshot, viewPair(olderAt, '前回正常').history));
let followMode = 'fail';
const followClient = {
  current: function () { return pub.readPublished(followStore); },
  publish: function (body) {
    assert.equal(body.snapshot.checkedAt, body.historyRun.predictedAt);
    if (followMode === 'fail') return Promise.reject(new Error('timeout'));
    return pub.publishToStore(followStore, pub.selectPair(body.snapshot, { runs: [body.historyRun] }));
  },
};
const failedFollow = await snap.finish({
  fs: followDisk,
  path: path,
  captured: captured(checkedAt),
  history: historyFor(checkedAt),
  snapshotFile: snapshotFile,
  client: followClient,
});
assert.equal(failedFollow.publish.reason, 'timeout');
assert.equal(queueOf(followDisk).items[0].status, 'pending');
assert.equal(queueOf(followDisk).items[0].checkedAt, checkedAt);
assert.equal(pub.readPublished(followStore).checkedAt, olderAt);
const newerFollow = '2026-10-22T05:00:00.000Z';
followMode = 'publish';
const newerFollowResult = await snap.finish({
  fs: followDisk,
  path: path,
  captured: captured(newerFollow),
  history: historyFor(newerFollow),
  snapshotFile: snapshotFile,
  client: followClient,
});
assert.equal(newerFollowResult.publish.published, true);
assert.equal(JSON.parse(followDisk.files[snapshotFile]).checkedAt, newerFollow);
assert.equal(pub.readPublished(followStore).checkedAt, newerFollow);
assert.equal(pub.readPublished(followStore).historyRun.predictedAt, newerFollow);
const followItems = queueOf(followDisk).items;
const keptOld = followItems.filter(function (item) { return item.checkedAt === checkedAt; })[0];
const keptNew = followItems.filter(function (item) { return item.checkedAt === newerFollow; })[0];
assert.equal(keptOld.status, 'pending');
assert.equal(keptOld.snapshot.checkedAt, keptOld.historyRun.predictedAt);
assert.equal(keptNew.status, 'published');
const followGeneration = pub.readPublished(followStore).generation;
const directOld = pub.publishToStore(followStore, pub.selectPair(keptOld.snapshot, { runs: [keptOld.historyRun] }));
assert.equal(directOld.published, false);
assert.equal(directOld.reason, 'stale');
assert.equal(pub.readPublished(followStore).generation, followGeneration);
assert.equal(pub.readPublished(followStore).checkedAt, newerFollow);
let followSends = 0;
const followRetry = await republish.retrySaved({
  fs: followDisk,
  path: path,
  queueFile: queueFile,
  client: {
    current: function () { return pub.readPublished(followStore); },
    publish: function () { followSends += 1; return { ok: true, published: true, checkedAt: checkedAt }; },
  },
  log: function () {},
});
assert.equal(followSends, 0);
assert.equal(followRetry.results[0].reason, 'stale');
assert.equal(followRetry.results[0].checkedAt, checkedAt);
assert.equal(pub.readPublished(followStore).checkedAt, newerFollow);
assert.equal(pub.readPublished(followStore).generation, followGeneration);
assert.equal(queueOf(followDisk).items.filter(function (item) { return item.checkedAt === checkedAt; })[0].status, 'superseded');

console.log('duty-risk-republish.test.mjs: ALL PASSED');
