import assert from 'assert';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const snap = require('../duty-risk-snapshot.js');
const harvest = require('../harvest-rolling60h-run.js');

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

const checkedAt = '2026-10-21T02:07:52.450Z';
const previous = { checkedAt: '2026-10-20T00:00:00.000Z', usable: true, fetchStatus: 'success', alerts: [] };
const file = 'local/inoichi-rolling-snapshot.json';

function captured(overrides) {
  const summary = Object.assign({
    ok: true,
    checkedAt: checkedAt,
    fileSuccess: 2,
    fileFailure: 0,
    historyCreated: 1,
    historyDuplicate: false,
    historySaved: true,
  }, overrides || {});
  return {
    summary: summary,
    drivers: [{
      transportId: 'TID-1',
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

const missing = harvest.run({});
assert.equal(missing.reason, 'runner-missing');
assert.equal(missing.ok, false);
const capturedMissing = harvest.capture({});
assert.equal(capturedMissing.summary.reason, 'runner-missing');
assert.deepEqual(capturedMissing.drivers, []);
assert.deepEqual(capturedMissing.predictions, []);

const fsOk = memoryFs({ [file]: JSON.stringify(previous) });
let published = null;
const saved = await snap.finish({
  fs: fsOk,
  path: path,
  captured: captured(),
  history: historyFor(checkedAt),
  snapshotFile: file,
  client: {
    publish: function (body) {
      published = body;
      return { ok: true, published: true, checkedAt: body.snapshot.checkedAt };
    },
  },
});
assert.equal(saved.save.replaced, true);
assert.equal(saved.publish.published, true);
assert.equal(saved.publish.reason, 'published');
const written = JSON.parse(fsOk.files[file]);
assert.equal(written.checkedAt, checkedAt);
assert.equal(written.usable, true);
assert.equal(published.snapshot.checkedAt, published.historyRun.predictedAt);
assert.equal(published.historyRun.predictedAt, checkedAt);
assert.equal(fsOk.files[file + '.tmp'], undefined);
assert.equal(saved.lines.length, 3);
assert.equal(saved.lines[0].startsWith('回収結果 '), true);
assert.equal(saved.lines[1].startsWith('保存結果 '), true);
assert.equal(saved.lines[2].startsWith('公開結果 '), true);

const fsDup = memoryFs({ [file]: JSON.stringify(previous) });
let dupCalls = 0;
const duplicate = await snap.finish({
  fs: fsDup,
  path: path,
  captured: captured({ historyDuplicate: true, historyCreated: 0, checkedAt: '2026-10-22T00:00:00.000Z' }),
  history: historyFor(checkedAt),
  snapshotFile: file,
  client: { publish: function () { dupCalls += 1; return { ok: true, published: true }; } },
});
assert.equal(duplicate.save.reason, 'duplicate');
assert.equal(duplicate.publish.reason, 'duplicate');
assert.equal(dupCalls, 0);
assert.equal(JSON.parse(fsDup.files[file]).checkedAt, previous.checkedAt);

const fsSave = memoryFs({ [file]: JSON.stringify(previous) });
fsSave.renameSync = function () { throw new Error('disk full'); };
let saveCalls = 0;
const saveFailed = await snap.finish({
  fs: fsSave,
  path: path,
  captured: captured(),
  history: historyFor(checkedAt),
  snapshotFile: file,
  client: { publish: function () { saveCalls += 1; return { ok: true, published: true }; } },
});
assert.equal(saveFailed.save.replaced, false);
assert.equal(saveFailed.save.kept, true);
assert.equal(saveFailed.publish.reason, 'save-failed');
assert.equal(saveCalls, 0);
assert.equal(JSON.parse(fsSave.files[file]).checkedAt, previous.checkedAt);
assert.equal(fsSave.files[file + '.tmp'], undefined);

const fsGas = memoryFs({ [file]: JSON.stringify(previous) });
const gasFailed = await snap.finish({
  fs: fsGas,
  path: path,
  captured: captured(),
  history: historyFor(checkedAt),
  snapshotFile: file,
  client: { publish: function () { return Promise.reject(new Error('timeout')); } },
});
assert.equal(gasFailed.save.replaced, true);
assert.equal(gasFailed.publish.published, false);
assert.equal(gasFailed.publish.reason, 'timeout');
assert.equal(JSON.parse(fsGas.files[file]).checkedAt, checkedAt);

const fsKeep = memoryFs({ [file]: JSON.stringify(previous) });
const mismatch = await snap.finish({
  fs: fsKeep,
  path: path,
  captured: captured(),
  history: historyFor('2026-10-19T00:00:00.000Z'),
  snapshotFile: file,
  client: { publish: function () { throw new Error('should not publish'); } },
});
assert.equal(mismatch.save.reason, 'mismatch');
assert.equal(JSON.parse(fsKeep.files[file]).checkedAt, previous.checkedAt);

const partial = await snap.finish({
  fs: memoryFs({ [file]: JSON.stringify(previous) }),
  path: path,
  captured: captured({ fileSuccess: 1, fileFailure: 1 }),
  history: historyFor(checkedAt),
  snapshotFile: file,
  client: { publish: function () { throw new Error('should not publish'); } },
});
assert.equal(partial.save.reason, 'collection-not-ok');
assert.equal(partial.publish.published, false);

console.log('duty-risk-snapshot.test.mjs: ALL PASSED');
