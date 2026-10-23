import assert from 'assert';
import fs from 'fs';

const TEN_MB = 10 * 1024 * 1024;

function pair(checkedAt, predictions) {
  return {
    snapshot: { checkedAt: checkedAt, usable: true, fetchStatus: 'success', alerts: [], basisCounts: {} },
    historyRun: { predictedAt: checkedAt, referenceDate: '2026-10-23', predictions: predictions },
  };
}

function createFolder(options) {
  const files = {};
  const listed = {};
  const lag = options && options.indexLag === true;
  const failNames = options && options.failNames ? options.failNames : {};
  return {
    files: files,
    createFile(name, content, mimeType) {
      if (failNames[name]) throw new Error('drive-write');
      if (mimeType && Buffer.byteLength(content) > TEN_MB) throw new Error('larger than 10MB');
      files[name] = content;
      if (!lag) listed[name] = true;
      return {
        getBlob() {
          return { getDataAsString() { return files[name]; } };
        },
        setContent(text) { files[name] = text; },
      };
    },
    getFilesByName(name) {
      const visible = listed[name] === true;
      return {
        hasNext() { return visible; },
        next() {
          return { getBlob() { return { getDataAsString() { return files[name]; } }; } };
        },
      };
    },
  };
}

function readJson(file) {
  return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
}

function writeJson(folder, name, value) {
  const text = JSON.stringify(value);
  return folder.createFile(name, text, 'application/json');
}

function publishFixed(folder, savedPair) {
  const previous = folder.getFilesByName('duty-risk-current.json').hasNext()
    ? readJson(folder.getFilesByName('duty-risk-current.json').next())
    : null;
  const lastSuccessAt = previous && previous.checkedAt ? previous.checkedAt : null;
  try {
    const generation = 'gen-test';
    const snapshotFile = writeJson(folder, generation + '-snapshot.json', savedPair.snapshot);
    const historyFile = writeJson(folder, generation + '-history-run.json', savedPair.historyRun);
    const savedSnapshot = readJson(snapshotFile);
    const savedRun = readJson(historyFile);
    if (!savedSnapshot || savedSnapshot.checkedAt !== savedPair.snapshot.checkedAt) throw new Error('verify-snapshot');
    if (!savedRun || savedRun.predictedAt !== savedPair.snapshot.checkedAt) throw new Error('verify-run');
    if (!savedRun.predictions || savedRun.predictions.length !== savedPair.historyRun.predictions.length) throw new Error('verify-run');
    writeJson(folder, 'duty-risk-current.json', { generation: generation, checkedAt: savedPair.snapshot.checkedAt });
    return { ok: true, published: true, generation: generation, checkedAt: savedPair.snapshot.checkedAt };
  } catch (error) {
    const detail = error && error.message ? String(error.message) : '';
    const reason = detail === 'verify-snapshot' || detail === 'verify-run' ? detail : 'incomplete';
    return { ok: false, published: false, reason: reason, lastSuccessAt: lastSuccessAt };
  }
}

function publishByName(folder, savedPair) {
  try {
    const generation = 'gen-old';
    writeJson(folder, generation + '-snapshot.json', savedPair.snapshot);
    writeJson(folder, generation + '-history-run.json', savedPair.historyRun);
    const snapshotListed = folder.getFilesByName(generation + '-snapshot.json');
    const historyListed = folder.getFilesByName(generation + '-history-run.json');
    const savedSnapshot = snapshotListed.hasNext() ? readJson(snapshotListed.next()) : readJson(null);
    const savedRun = historyListed.hasNext() ? readJson(historyListed.next()) : readJson(null);
    if (!savedSnapshot || savedSnapshot.checkedAt !== savedPair.snapshot.checkedAt) throw new Error('verify-snapshot');
    if (!savedRun || savedRun.predictions.length !== savedPair.historyRun.predictions.length) throw new Error('verify-run');
    writeJson(folder, 'duty-risk-current.json', { generation: generation, checkedAt: savedPair.snapshot.checkedAt });
    return { ok: true, published: true };
  } catch (error) {
    return { ok: false, published: false, reason: 'incomplete' };
  }
}

const checkedAt = '2026-10-23T07:08:56.960Z';
const small = pair(checkedAt, [{ subjectId: 'A', predictedTotal: 10 }]);
const smallFolder = createFolder();
const smallSaved = publishFixed(smallFolder, small);
assert.equal(smallSaved.published, true);
assert.equal(JSON.parse(smallFolder.files['duty-risk-current.json']).checkedAt, checkedAt);
assert.equal(JSON.parse(smallFolder.files['gen-test-history-run.json']).predictions.length, 1);

const padding = 'x'.repeat(1700000);
const largePredictions = [];
for (let index = 0; index < 2184; index += 1) largePredictions.push({ subjectId: 'S' + index, predictedTotal: index % 70, note: index === 0 ? padding : '' });
const large = pair(checkedAt, largePredictions);
const largeBytes = Buffer.byteLength(JSON.stringify(large.historyRun));
assert.ok(largeBytes >= 1660000 && largeBytes < TEN_MB, 'the sample history is about 1.66MB and under the 10MB Drive limit');
const lagging = createFolder({ indexLag: true });
const largeSaved = publishFixed(lagging, large);
assert.equal(largeSaved.published, true);
assert.equal(largeSaved.reason, undefined);
const storedRun = JSON.parse(lagging.files['gen-test-history-run.json']);
assert.equal(storedRun.predictions.length, 2184);
assert.equal(storedRun.predictedAt, checkedAt);
assert.equal(JSON.parse(lagging.files['duty-risk-current.json']).generation, 'gen-test');
assert.equal(lagging.getFilesByName('gen-test-history-run.json').hasNext(), false);

const laggedOld = createFolder({ indexLag: true });
const oldResult = publishByName(laggedOld, large);
assert.equal(oldResult.published, false);
assert.equal(oldResult.reason, 'incomplete');
assert.equal(laggedOld.files['duty-risk-current.json'], undefined);

const failedWrite = createFolder({ failNames: { 'gen-test-history-run.json': true } });
const failed = publishFixed(failedWrite, small);
assert.equal(failed.published, false);
assert.equal(failed.reason, 'incomplete');
assert.equal(failedWrite.files['duty-risk-current.json'], undefined);
assert.ok(failedWrite.files['gen-test-snapshot.json']);

const truncated = createFolder();
const originalCreate = truncated.createFile.bind(truncated);
truncated.createFile = function (name, content, mimeType) {
  if (name.indexOf('history-run') >= 0) {
    const parsed = JSON.parse(content);
    parsed.predictions = parsed.predictions.slice(0, 1);
    content = JSON.stringify(parsed);
  }
  return originalCreate(name, content, mimeType);
};
const missing = publishFixed(truncated, large);
assert.equal(missing.published, false);
assert.equal(missing.reason, 'verify-run');
assert.equal(truncated.files['duty-risk-current.json'], undefined);

const retryState = { failHistory: true };
const retryFolder = createFolder();
const retryCreate = retryFolder.createFile.bind(retryFolder);
retryFolder.createFile = function (name, content, mimeType) {
  if (retryState.failHistory && name.indexOf('history-run') >= 0) throw new Error('drive-write');
  return retryCreate(name, content, mimeType);
};
const firstTry = publishFixed(retryFolder, small);
assert.equal(firstTry.published, false);
assert.equal(firstTry.lastSuccessAt, null);
assert.equal(retryFolder.files['duty-risk-current.json'], undefined);
retryState.failHistory = false;
const retried = publishFixed(retryFolder, small);
assert.equal(retried.published, true);
assert.equal(JSON.parse(retryFolder.files['duty-risk-current.json']).checkedAt, checkedAt);
assert.equal(JSON.parse(retryFolder.files['gen-test-history-run.json']).predictions.length, 1);

const gas = fs.readFileSync(new URL('../gas/duty-risk-store.gs', import.meta.url), 'utf8');
const postAt = gas.indexOf('function doPost');
const body = gas.slice(postAt);
assert.ok(body.indexOf('var snapshotFile = dutyRiskWriteJson_') < body.indexOf('dutyRiskReadJson_(snapshotFile)'));
assert.ok(body.indexOf('var historyFile = dutyRiskWriteJson_') < body.indexOf('dutyRiskReadJson_(historyFile)'));
assert.ok(body.indexOf('dutyRiskReadJson_(historyFile)') < body.indexOf('DUTY_RISK_POINTER_NAME, {'));
assert.equal(body.includes('dutyRiskReadJson_(dutyRiskFind_(folder, generation'), false);

const doGet = gas.slice(gas.indexOf('function doGet'), postAt);
assert.ok(doGet.indexOf("e.parameter.action === 'revision'") < doGet.indexOf('dutyRiskFolder_('));
assert.equal(doGet.includes('DriveApp'), false);
assert.ok(doGet.includes('readsDrive: false'));
assert.ok(body.includes("stage = 'write-snapshot'"));
assert.ok(body.includes("stage = 'write-history'"));
assert.ok(body.includes("stage = 'verify-snapshot'"));
assert.ok(body.includes("stage = 'verify-run'"));
assert.ok(body.includes("stage = 'pointer'"));
assert.ok(body.includes('dutyRiskFaultReason_(err)'));
const logs = gas.split('\n').filter((line) => line.includes('Logger.log'));
assert.ok(logs.length >= 3);
for (const line of logs) {
  assert.equal(/token|snapshot|predictions|postData|historyRun|password|secret/i.test(line), false, line);
}

console.log('duty-risk-gas-publish: ok');
