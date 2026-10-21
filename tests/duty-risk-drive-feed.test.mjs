import fs from 'fs';
import assert from 'assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pub = require('../duty-risk-publication.js');
const client = require('../duty-risk-gas-client.js');
const feed = require('../duty-risk-feed-route.js');
const dash = require('../duty-risk-dashboard.js');

function pair(checkedAt, extra) {
  return {
    snapshot: {
      checkedAt: checkedAt,
      usable: true,
      fetchStatus: 'success',
      alerts: [{ name: '試験 太郎', disposition: 'exceed', basis: 'forecast', startDate: '2026-10-22', endDate: '2026-10-28', totalHours: 61, transportId: 'TID-1' }],
      basisCounts: { actualExceed: 0 },
    },
    history: {
      runs: [{
        predictedAt: checkedAt,
        referenceDate: '2026-10-21',
        predictions: [{
          subjectId: 'TID-1',
          start: '2026-10-15',
          end: '2026-10-21',
          predictedTotal: 40,
          level: 'within',
          days: [
            { date: '2026-10-15', hours: 5, origin: 'daily-estimate' },
            { date: '2026-10-16', hours: 5, origin: 'daily-estimate' },
            { date: '2026-10-17', hours: 5, origin: 'daily-estimate' },
            { date: '2026-10-18', hours: 5, origin: 'daily-estimate' },
            { date: '2026-10-19', hours: 5, origin: 'daily-estimate' },
            { date: '2026-10-20', hours: 5, origin: 'daily-estimate' },
            { date: '2026-10-21', hours: 10, origin: 'roster-plan' },
          ],
        }],
      }, extra].filter(Boolean),
    },
  };
}

const checkedAt = '2026-10-21T02:07:52.450Z';
const sample = pair(checkedAt);
const selected = pub.selectPair(sample.snapshot, sample.history);
assert.equal(selected.ok, true);
assert.equal(selected.historyRun.predictedAt, checkedAt);
assert.equal(selected.historyRun.predictions.length, 1);

const store = pub.createMemoryStore();
const saved = pub.publishToStore(store, selected);
assert.equal(saved.ok, true);
const loaded = pub.readPublished(store);
assert.equal(loaded.ok, true);
assert.equal(loaded.checkedAt, checkedAt);
assert.equal(loaded.snapshot.alerts[0].name, '試験 太郎');
assert.equal(loaded.historyRun.predictions[0].subjectId, 'TID-1');

const bigChecked = '2026-10-22T00:00:00.000Z';
const padding = 'x'.repeat(1900000);
const bigRun = {
  predictedAt: bigChecked,
  referenceDate: '2026-10-22',
  predictions: [{ subjectId: 'TID-LARGE', start: '2026-10-16', end: '2026-10-22', predictedTotal: 11, level: 'within', days: [], padding: padding }],
};
assert.ok(Buffer.byteLength(JSON.stringify(bigRun)) >= 1.8 * 1024 * 1024);
const bigPair = pub.selectPair({
  checkedAt: bigChecked,
  usable: true,
  fetchStatus: 'success',
  alerts: [],
  basisCounts: {},
}, { runs: [bigRun] });
const bigSaved = pub.publishToStore(store, bigPair);
assert.equal(bigSaved.ok, true);
const bigLoaded = pub.readPublished(store);
assert.equal(bigLoaded.historyRun.predictedAt, bigChecked);
assert.ok(Buffer.byteLength(JSON.stringify(bigLoaded.historyRun)) >= 1.8 * 1024 * 1024);
assert.equal(bigLoaded.historyRun.predictions.length, 1);

const previous = pub.readPublished(store);
let writes = 0;
const failing = {
  readPointer: store.readPointer.bind(store),
  readPart: store.readPart.bind(store),
  writePointer: function () { throw new Error('pointer should stay'); },
  writePart: function (generation, name, value) {
    writes += 1;
    if (name === 'history-run') {
      const error = new Error('timeout');
      throw error;
    }
    store.writePart(generation, name, value);
  },
};
const newerChecked = '2026-10-23T00:00:00.000Z';
const newerPair = pub.selectPair({
  checkedAt: newerChecked,
  usable: true,
  fetchStatus: 'success',
  alerts: [],
}, { runs: [{ predictedAt: newerChecked, referenceDate: '2026-10-23', predictions: [] }] });
const broken = pub.publishToStore(failing, newerPair);
assert.equal(broken.ok, false);
assert.equal(broken.reason, 'timeout');
assert.equal(broken.published, false);
assert.equal(pub.readPublished(store).checkedAt, previous.checkedAt);
assert.ok(writes >= 1);

const mismatched = pub.selectPair(sample.snapshot, { runs: [{ predictedAt: '2026-10-20T00:00:00.000Z', referenceDate: '2026-10-20', predictions: [] }] });
assert.equal(mismatched.ok, false);
assert.equal(mismatched.reason, 'mismatch');
let touched = false;
const guard = {
  readPointer: function () { return null; },
  writePart: function () { touched = true; },
  readPart: function () { return null; },
  writePointer: function () { touched = true; },
};
const rejected = pub.handleStoreRequest({
  action: 'publish',
  headerToken: 'secret',
  body: { action: 'publish', snapshot: sample.snapshot, historyRun: { predictedAt: 'other', referenceDate: '2026-10-21', predictions: [] } },
}, guard, 'secret');
assert.equal(rejected.status, 409);
assert.equal(rejected.body.reason, 'mismatch');
assert.equal(touched, false);

const deniedStore = {
  readPointer: function () { throw new Error('store read'); },
  writePart: function () { throw new Error('store write'); },
  readPart: function () { throw new Error('store read'); },
  writePointer: function () { throw new Error('store write'); },
};
const denied = pub.handleStoreRequest({ action: 'current', body: { action: 'current' } }, deniedStore, 'secret');
assert.equal(denied.status, 401);
assert.equal(denied.body.reason, 'unauthorized');
const missingConfig = pub.handleStoreRequest({ headerToken: 'secret', action: 'current' }, deniedStore, '');
assert.equal(missingConfig.status, 503);

const gas = fs.readFileSync(new URL('../gas/duty-risk-store.gs', import.meta.url), 'utf8');
assert.equal(gas.includes('setSharing'), false);
assert.equal(gas.includes('ANYONE'), false);
const getAt = gas.indexOf('function doGet');
const postAt = gas.indexOf('function doPost');
assert.ok(gas.indexOf('dutyRiskAuthorize_(e)', getAt) < gas.indexOf('dutyRiskFolder_()', getAt));
assert.ok(gas.indexOf('dutyRiskAuthorize_(e)', postAt) < gas.indexOf('dutyRiskFolder_()', postAt));
assert.ok(gas.indexOf("generation + '-history-run.json'", postAt) < gas.indexOf('DUTY_RISK_POINTER_NAME', postAt));
assert.equal(gas.includes('マニフェスト'), false);
assert.equal(gas.includes('TENKO_MASTER'), false);

let published = false;
const summary = { ok: true, checkedAt: checkedAt, driverCount: 1 };
const summaryCopy = JSON.stringify(summary);
const timed = await client.afterHarvest({
  summary: summary,
  snapshot: sample.snapshot,
  history: sample.history,
  timeoutMs: 30,
  client: { publish: function () { published = true; return new Promise(function () {}); } },
});
assert.equal(timed.reason, 'timeout');
assert.equal(timed.published, false);
assert.equal(JSON.stringify(summary), summaryCopy);
assert.equal(published, true);

let calls = 0;
const skipped = await client.afterHarvest({
  summary: { ok: true },
  snapshot: sample.snapshot,
  history: { runs: [] },
  client: { publish: function () { calls += 1; return { ok: true }; } },
});
assert.equal(skipped.reason, 'mismatch');
assert.equal(calls, 0);

const notOk = await client.afterHarvest({
  summary: { ok: false },
  client: { publish: function () { calls += 1; return { ok: true }; } },
});
assert.equal(notOk.reason, 'harvest-not-ok');
assert.equal(calls, 0);

function response() {
  const out = { code: 0, body: null, status: function (code) { out.code = code; return out; }, json: function (body) { out.body = body; return out; } };
  return out;
}
let loadedGas = false;
const anonymous = response();
feed.handle({ headers: {} }, anonymous, {
  proxySecret: 'proxy-secret',
  load: function () { loadedGas = true; return { ok: true, snapshot: {}, historyRun: {}, checkedAt: checkedAt }; },
});
assert.equal(anonymous.code, 401);
assert.equal(anonymous.body.reason, 'unauthorized');
assert.equal(anonymous.body.lastSuccessAt, null);
assert.equal(loadedGas, false);

const open = response();
feed.handle({ headers: { 'x-proxy-secret': 'proxy-secret' } }, open, {
  proxySecret: '',
  load: function () { loadedGas = true; },
});
assert.equal(open.code, 503);
assert.equal(loadedGas, false);

const timedFeed = response();
await new Promise(function (resolve) {
  const res = {
    status: function (code) { timedFeed.code = code; return res; },
    json: function (body) { timedFeed.body = body; resolve(); return res; },
  };
  feed.handle({ get: function () { return 'proxy-secret'; } }, res, {
    proxySecret: 'proxy-secret',
    lastSuccessAt: checkedAt,
    load: function () { return Promise.resolve({ ok: false, reason: 'timeout' }); },
  });
});
assert.equal(timedFeed.code, 504);
assert.equal(timedFeed.body.reason, 'timeout');
assert.equal(timedFeed.body.lastSuccessAt, checkedAt);

const view = dash.buildView(loaded.snapshot, { runs: [loaded.historyRun] }, {
  byTransportId: { 'TID-1': { japaneseName: 'マスタ 太郎', englishName: 'Test' } },
});
assert.equal(view.ok, true);
assert.equal(view.ranking[0].name, 'マスタ 太郎');
assert.equal(dash.failureText({ ok: false, reason: 'timeout', lastSuccessAt: checkedAt }).includes('2026-10-21 11:07:52'), true);
assert.equal(dash.failureText({ ok: false }).includes('不明'), true);

const server = fs.readFileSync(new URL('../render-webhook-server.js', import.meta.url), 'utf8');
const runAt = server.indexOf("require('./harvest-rolling60h-run.js').capture(");
const publishAt = server.indexOf('duty-risk-snapshot.js');
assert.ok(runAt > 0 && publishAt > runAt);
assert.equal(server.includes("return summary;"), true);
const runner = fs.readFileSync(new URL('../harvest-rolling60h-run.js', import.meta.url), 'utf8');
assert.equal(runner.includes('duty-risk'), false);
const historySource = fs.readFileSync(new URL('../harvest-rolling60h-history.js', import.meta.url), 'utf8');
assert.equal(historySource.includes('duty-risk'), false);
const dashSource = fs.readFileSync(new URL('../duty-risk-dashboard.js', import.meta.url), 'utf8');
assert.equal(dashSource.includes('/duty-risk-feed'), true);
assert.equal(dashSource.includes('computeRolling'), false);
assert.equal(dashSource.includes('rolling60h-core'), false);
const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.equal(page.includes('function dutyRiskAuthHeaders'), true);
assert.equal(page.includes('function resolveDutyRiskMasterName'), true);

console.log('duty-risk-drive-feed.test.mjs: ALL PASSED');
