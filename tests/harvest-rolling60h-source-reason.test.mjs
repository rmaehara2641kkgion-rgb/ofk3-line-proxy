import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const run = require('../harvest-rolling60h-run.js');
const collectorMod = require('../harvest-collector-rolling60h.js');
const route = require('../harvest-rolling60h-route.js');

const rolling = require('../rolling60h-core.js');
const harvest = require('../harvest-daily-manifest.js');
const dryRun = require('../inoichi-rolling-dryrun.js');

// 存在しないフォルダ・読み込み例外でも落ちず、理由コードだけが返る
const fakeFs = {
  existsSync: () => false,
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0 }),
};
const pathMod = require('node:path');
const summary = run.capture({
  fs: fakeFs, path: pathMod, xlsx: {}, rolling, harvest, dryRun,
  dailyDir: '/none/daily', shiftDir: '/none/shift', historyFile: '',
}).summary;
assert.equal(summary.dailyReason, 'source-unavailable');
assert.equal(summary.shiftReason, 'source-unavailable');
assert.equal(summary.fileSuccess, 0);

// 最新日が同日に複数あるとき（Drive の重複コピー等）は曖昧として理由に出る
const dupFs = {
  existsSync: () => true,
  readdirSync: () => ['Daily_AMZL_JP_Working_Hour_2026-10-25_GION.xlsx', 'Daily_AMZL_JP_Working_Hour_2026-10-25_GION (1).xlsx'],
  statSync: () => ({ mtimeMs: 1 }),
};
const dup = run.capture({
  fs: dupFs, path: pathMod, xlsx: {}, rolling, harvest, dryRun,
  dailyDir: '/d', shiftDir: '/s', historyFile: '',
}).summary;
assert.equal(dup.dailyReason, 'ambiguous-latest');

// 読み込み例外（ロック・同期中など）
const throwing = {
  readFile: () => { throw new Error('EBUSY C:\\secret\\path'); },
  utils: {},
};
const thrown = run.capture({
  fs: { existsSync: () => true, readdirSync: () => ['Daily_AMZL_JP_Working_Hour_2026-10-25_GION.xlsx'], statSync: () => ({ mtimeMs: 1 }) },
  path: pathMod, xlsx: throwing, rolling, harvest, dryRun, dailyDir: '/d', shiftDir: '/s', historyFile: '',
}).summary;
assert.equal(thrown.dailyReason, 'read-failed');
assert.ok(!JSON.stringify(thrown).includes('secret'), '例外メッセージ・パスを持ち出さない');

// コレクター: 失敗理由が errors に出て、成功時は出ない
const collector = collectorMod.createCollector({});
const failed = collector.normalize({ status: 200, body: { ok: true, shiftFile: 'a.xlsx', fileSuccess: 1, fileFailure: 1, dailyReason: 'ambiguous-latest', shiftReason: 'ok' } });
assert.equal(failed.status, 'partial');
assert.equal(failed.errors.length, 1);
assert.ok(failed.errors[0].message.includes('ambiguous-latest'));
const good = collector.normalize({ status: 200, body: { ok: true, dailyFile: 'd.xlsx', shiftFile: 's.xlsx', fileSuccess: 2, fileFailure: 0, dailyReason: 'ok', shiftReason: 'ok' } });
assert.equal(good.errors.length, 0);
const hostile = collector.normalize({ status: 200, body: { ok: true, fileSuccess: 1, fileFailure: 1, dailyReason: '<script>x</script>' } });
assert.ok(!hostile.errors[0].message.includes('<'));

// publish-status: ループバック＋ヘッダー必須、結果コードのみ
function res() { const o = { code: 0, body: null, status(c) { o.code = c; return o; }, json(b) { o.body = b; return o; } }; return o; }
const local = { socket: { remoteAddress: '127.0.0.1' }, get: () => '1' };
const remote = { socket: { remoteAddress: '203.0.113.1' }, get: () => '1' };
let r = res();
route.handleStatus(remote, r, { publishStatus: () => ({ ok: true }) });
assert.equal(r.code, 403);
r = res();
route.handleStatus(local, r, { publishStatus: () => ({ ok: true, gasUrlConfigured: true }) });
assert.equal(r.code, 200);
assert.equal(r.body.gasUrlConfigured, true);

console.log('harvest-rolling60h-source-reason.test.mjs: ALL PASSED');
