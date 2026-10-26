import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const route = require('../harvest-rolling60h-route.js');
const feed = require('../rolling60h-dispatch-feed.js');
const run = require('../harvest-rolling60h-run.js');

assert.equal(typeof feed.read, 'function');
assert.equal(typeof run.loadRoster, 'function');
assert.equal(run.loadRoster({}).reason, 'reader-missing');

function res() {
  const o = { code: 0, body: null, status(c) { o.code = c; return o; }, json(b) { o.body = b; return o; } };
  return o;
}
const local = { socket: { remoteAddress: '127.0.0.1' }, get: () => '1' };
const remote = { socket: { remoteAddress: '203.0.113.1' }, get: () => '1' };

let r = res();
route.handleAlerts(remote, r, { readDispatch: () => ({ app: 'harvest-rolling60h', alerts: [{ name: '試験' }] }) });
assert.equal(r.code, 403);
assert.equal(r.body.app, 'harvest-rolling60h');
assert.equal(r.body.connected, false);
assert.deepEqual(r.body.alerts, []);
assert.equal(JSON.stringify(r.body).includes('試験'), false);

r = res();
route.handleAlerts(local, r, {});
assert.equal(r.code, 200);
assert.equal(r.body.ok, false);
assert.equal(r.body.app, 'harvest-rolling60h');
assert.equal(r.body.connected, false);
assert.deepEqual(r.body.alerts, []);

r = res();
route.handleAlerts(local, r, { readDispatch: () => { throw new Error('hidden'); } });
assert.equal(r.code, 200);
assert.equal(r.body.connected, false);
assert.equal(JSON.stringify(r.body).includes('hidden'), false);

const personal = {
  ok: true,
  app: 'harvest-rolling60h',
  connected: true,
  fetchStatus: 'ok',
  stale: false,
  checkedAt: '2026-10-26T00:00:00.000Z',
  approachRule: 'fixture',
  referenceDate: '2026-10-26',
  alerts: [{ name: '試験', transportId: 'T-1', status: 'exceed' }],
};
r = res();
route.handleAlerts(local, r, { readDispatch: () => personal });
assert.equal(r.code, 200);
assert.equal(r.body, personal);

r = res();
route.handleAlerts(local, r, { readDispatch: () => ({ app: 'ofk3.rolling60h.friday-summary', driverCount: 1 }) });
assert.equal(r.code, 200);
assert.equal(r.body.app, 'harvest-rolling60h');
assert.equal(r.body.connected, false);
assert.equal(Object.prototype.hasOwnProperty.call(r.body, 'driverCount'), false);

const routes = {};
route.mount({
  post(path) { routes[path] = 'post'; },
  get(path) { routes['GET ' + path] = 'get'; },
}, {});
assert.equal(routes['GET /harvest/rolling60h/alerts'], 'get');
assert.equal(routes['GET /harvest/rolling60h/publish-status'], 'get');

const server = fs.readFileSync(new URL('../render-webhook-server.js', import.meta.url), 'utf8');
assert.ok(server.includes('readDispatch:'), '既存アラートの読み取りを接続する');
assert.ok(server.includes('publishStatus: dutyRiskPublishStatus'), '公開状態APIは残す');
const summary = fs.readFileSync(new URL('../rolling60h-summary-bridge.js', import.meta.url), 'utf8');
assert.equal(summary.includes('/harvest/rolling60h/alerts'), false, '人数要約は対象者APIを使わない');
assert.equal(summary.includes('transportId'), false);

console.log('harvest-rolling60h-alerts-route.test.mjs: ALL PASSED');
