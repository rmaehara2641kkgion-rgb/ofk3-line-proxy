import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../friday-snapshot-bridge.js');
let passed = 0;
function ok(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed += 1;
}

ok('default endpoint is the friday receiver', bridge.resolveEndpoint({}).url === bridge.DEFAULT_ENDPOINT);
ok('page setting wins over the default', bridge.resolveEndpoint({ windowEndpoint: 'http://127.0.0.1:13230/api/ops/snapshot' }).url === 'http://127.0.0.1:13230/api/ops/snapshot');
ok('ofk3 and harvest ports are refused', ['3000', '3100'].every((port) => bridge.resolveEndpoint({ windowEndpoint: `http://127.0.0.1:${port}/api/ops/snapshot` }).error === 'blocked-port'));
ok('live friday port can be locked out of a test', bridge.resolveEndpoint({ windowEndpoint: bridge.DEFAULT_ENDPOINT, forbidLivePorts: true }).error === 'live-port');
ok('public hosts and other paths are refused', bridge.resolveEndpoint({ windowEndpoint: 'http://example.com/api/ops/snapshot' }).ok === false && bridge.resolveEndpoint({ windowEndpoint: 'http://127.0.0.1:13230/other' }).ok === false);

const stable = '[{"routeCode":"SYN-1"}]';
const state = bridge.noteSuccess({}, 0, stable);
ok('unchanged content waits for the heartbeat', bridge.decideSend(state, 30_000, stable, false).reason === 'unchanged');
ok('heartbeat is one minute', bridge.HEARTBEAT_MS === 60_000 && bridge.decideSend(state, 60_000, stable, false).reason === 'heartbeat');
ok('a content change sends immediately', bridge.decideSend(state, 10_000, stable + 'x', false).reason === 'changed');
const failed = bridge.noteFailure({ lastOkAt: 1, lastHash: stable, failureCount: 0 }, 100);
ok('failure clears the ack and waits five seconds', failed.lastOkAt === 0 && bridge.decideSend(failed, 100, stable, false).reason === 'backoff' && bridge.decideSend(failed, 5_100, stable, false).reason === 'retry');
ok('retries do not speed up without a bound', bridge.nextBackoff(0) === 5_000 && bridge.nextBackoff(6) === bridge.RETRY_MAX_MS && bridge.CHECK_MS === 2_000);

const sender = fs.readFileSync(new URL('../tenko-transport-audit-success.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
ok('sender delegates to the bridge', sender.includes('FridaySnapshotBridge.decideSend') || sender.includes('bridge.decideSend'));
ok('sender does not keep the old port 3000 target', !sender.includes('127.0.0.1:3000/api/ops/snapshot'));
ok('page loads the bridge first', page.indexOf('friday-snapshot-bridge.js') < page.indexOf('tenko-transport-audit-success.js'));

console.log(`friday snapshot bridge tests passed: ${passed}`);
