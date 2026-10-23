import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const republish = require('../duty-risk-republish.js');
const route = require('../duty-risk-republish-route.js');

const checkedAt = '2026-10-23T07:08:56.960Z';

// PID 22940 started at 13:33 and loaded this allowlist. f3f93b4 wrote the
// verify-* codes at 16:25, and Node does not reload a cached module.
const loadedAtStartup = [
  'timeout', 'incomplete', 'mismatch', 'stale', 'already-published', 'published',
  'not-configured', 'unauthorized', 'busy', 'read-failed', 'queue-unreadable',
  'queue-not-saved', 'nothing-pending', 'duplicate',
];

function startupReason(value) {
  return loadedAtStartup.indexOf(value) >= 0 ? value : 'incomplete';
}

function gasCatchBefore() {
  return 'incomplete';
}

function gasCatchAfter(err) {
  const detail = err && err.message ? String(err.message) : '';
  return detail === 'verify-snapshot' || detail === 'verify-run' ? detail : 'incomplete';
}

function memoryFs() {
  const files = {};
  return {
    files,
    mkdirSync() {},
    writeFileSync(file, data) { files[String(file)] = String(data); },
    readFileSync(file) {
      if (!Object.prototype.hasOwnProperty.call(files, String(file))) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files[String(file)];
    },
    renameSync(from, to) {
      files[String(to)] = files[String(from)];
      delete files[String(from)];
    },
    unlinkSync(file) { delete files[String(file)]; },
  };
}

function pair() {
  return {
    snapshot: { checkedAt, usable: true, fetchStatus: 'success', alerts: [] },
    history: { runs: [{ predictedAt: checkedAt, referenceDate: '2026-10-23', predictions: [{ subjectId: 'TID-1' }] }] },
  };
}

async function replay(bodyOrError) {
  const disk = memoryFs();
  const saved = pair();
  republish.remember(disk, path, 'queue.json', saved.snapshot, saved.history);
  const client = {
    current() { return { ok: false, reason: 'not-published' }; },
    publish() {
      if (bodyOrError instanceof Error) return Promise.reject(bodyOrError);
      return Promise.resolve(bodyOrError);
    },
  };
  const result = await republish.retrySaved({
    fs: disk,
    path,
    queueFile: 'queue.json',
    client,
    timeoutMs: 1000,
    log() {},
  });
  return result.results[0];
}

assert.equal(startupReason('verify-snapshot'), 'incomplete');
assert.equal(startupReason('verify-run'), 'incomplete');
assert.equal(republish.reasonCode('verify-snapshot'), 'verify-snapshot');
assert.equal(republish.reasonCode('verify-run'), 'verify-run');

const verifyError = new Error('verify-snapshot');
assert.equal(gasCatchBefore(verifyError), 'incomplete');
assert.equal(gasCatchAfter(verifyError), 'verify-snapshot');
assert.equal(startupReason(gasCatchAfter(verifyError)), 'incomplete');
assert.equal(republish.reasonCode(gasCatchAfter(verifyError)), 'verify-snapshot');
assert.equal(startupReason(gasCatchBefore(verifyError)), 'incomplete');

const preserved = await replay({
  ok: false,
  published: false,
  reason: 'verify-snapshot',
  checkedAt,
});
assert.equal(preserved.reason, 'verify-snapshot');
assert.equal(preserved.published, false);
const throughRoute = route.safeBody({ ok: false, results: [preserved] });
assert.equal(throughRoute.results[0].reason, 'verify-snapshot');
assert.equal(startupReason(preserved.reason), 'incomplete');

for (const reason of ['unknown-action', 'snapshot-not-usable', 'snapshot-not-success', 'verify-snapshot']) {
  const kept = await replay({ ok: false, published: false, reason, stage: 'select', checkedAt });
  assert.equal(republish.reasonCode(reason), reason);
  assert.equal(kept.reason, reason);
  assert.equal(kept.stage, 'select');
}

assert.equal(republish.reasonCode('山田太郎'), 'redacted');
assert.equal(republish.reasonCode('duty-risk-token-do-not-log'), 'redacted');

const httpError = new Error('Request failed with status code 500');
httpError.response = { status: 500, data: { ok: false, published: false, reason: 'verify-run', stage: 'verify-run', snapshot: { name: '架空氏名' } } };
const overwritten = await replay(httpError);
assert.equal(overwritten.reason, 'verify-run');
assert.equal(overwritten.httpStatus, 500);
assert.equal(overwritten.stage, 'verify-run');
assert.equal(JSON.stringify(overwritten).includes('架空氏名'), false);

const html = await replay('<!DOCTYPE html><html>temporary error</html>');
assert.equal(html.reason, 'incomplete');
assert.equal(html.published, false);

const redirectSource = fs.readFileSync(new URL('../node_modules/follow-redirects/index.js', import.meta.url), 'utf8');
assert.equal(redirectSource.includes('this._options.method = "GET"'), true);
assert.equal(redirectSource.includes('this._requestBodyBuffers = []'), true);

console.log('duty-risk-reason-mask.test.mjs: ALL PASSED');
