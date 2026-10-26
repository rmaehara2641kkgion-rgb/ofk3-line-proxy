import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridge = require(join(root, 'rolling60h-summary-bridge.js'));
const core = readFileSync(join(root, 'rolling60h-core.js'), 'utf8');
const board = readFileSync(join(root, 'rolling60h-local-board.js'), 'utf8');
const store = readFileSync(join(root, 'rolling60h-local-store.js'), 'utf8');
const ui = readFileSync(join(root, 'rolling60h-board-ui.js'), 'utf8');

const summary = {
  kind: 'ofk3.rolling60h.friday-summary',
  schemaVersion: 1,
  ready: true,
  generatedAt: '2026-10-26T01:20:00.000Z',
  counts: { exceed: 7, approach: 2 }
};

let calls = 0;
const down = await bridge.deliver(summary, function () {
  calls += 1;
  return Promise.reject(new Error('ECONNREFUSED'));
});
assert.equal(down.ok, false);
assert.equal(down.reason, 'unreachable');
assert.equal(calls, 1);
assert.match(bridge.message(down), /このブラウザに残っています/);

const skipped = await bridge.deliver({ ready: false, kind: summary.kind, schemaVersion: 1 }, function () {
  throw new Error('must not send');
});
assert.equal(skipped.reason, 'not-ready');

const sent = await bridge.deliver(summary, function (_url, init) {
  assert.equal(init.method, 'POST');
  assert.equal(JSON.parse(init.body).counts.exceed, 7);
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve({ ok: true, stored: true }); }
  });
});
assert.equal(sent.ok, true);

assert.equal(core.indexOf('wh60-harvest-bridge') < 0, true);
assert.equal(board.indexOf('rolling60h-summary-bridge') < 0, true);
assert.equal(store.indexOf('127.0.0.1:3100') < 0, true);
assert.equal(ui.indexOf('rolling60h-summary-bridge') < 0, true);
assert.equal(readFileSync(join(root, 'index.html'), 'utf8').includes('/rolling60h-summary-bridge.js'), true);

assert.equal(bridge.localPage({ location: { hostname: '127.0.0.1' } }), true);
assert.equal(bridge.localPage({ location: { hostname: 'localhost' } }), true);
assert.equal(bridge.localPage({ location: { hostname: 'ofk3.onrender.com' } }), false);

function page(hostname) {
  const events = {};
  let fetches = 0;
  return {
    events: events,
    fetches: function () { return fetches; },
    location: { hostname: hostname },
    document: {
      readyState: 'complete',
      body: { appendChild: function () {} },
      getElementById: function () { return null; },
      createElement: function () { return { style: {}, setAttribute: function () {} }; },
      addEventListener: function () {}
    },
    addEventListener: function (type, fn) { events[type] = fn; },
    fetch: function () { fetches += 1; return Promise.reject(new Error('down')); },
    Rolling60hBoardUI: { getFridaySummary: function () { return Promise.resolve(summary); } }
  };
}

const remote = page('ofk3.onrender.com');
bridge.install(remote);
await new Promise(function (resolve) { setTimeout(resolve, 20); });
assert.equal(remote.fetches(), 0);
assert.equal(remote.events['ofk3:rolling60h-summary'], undefined);

const local = page('127.0.0.1');
bridge.install(local);
await new Promise(function (resolve) { setTimeout(resolve, 30); });
assert.equal(typeof local.events['ofk3:rolling60h-summary'], 'function');
assert.equal(local.fetches(), 1);

console.log('wh60 harvest bridge tests passed');
