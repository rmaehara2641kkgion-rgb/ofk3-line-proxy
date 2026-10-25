import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dash = require('../duty-risk-dashboard.js');
const client = require('../duty-risk-gas-client.js');
const feed = require('../duty-risk-feed-route.js');

// ---- 60時間境界（既存仕様: 予定込みで60h以上は予測超過、実績確定は超過扱いにしない）
function windowFor(id, hours, origins) {
  const dates = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
  const days = dates.map((date, i) => ({ date, hours: hours[i], origin: origins[i] }));
  const total = days.reduce((sum, d) => sum + d.hours, 0);
  return { subjectId: id, start: dates[0], end: dates[6], predictedTotal: total, level: 'within', days };
}
const planOrigins = Array(6).fill('daily-estimate').concat(['roster-plan']);
const checkedAt = '2026-10-21T02:07:52.450Z';
function snapshotWith(predictions) {
  return {
    snapshot: { checkedAt, usable: true, fetchStatus: 'success', alerts: [], basisCounts: {} },
    historyRun: { predictedAt: checkedAt, referenceDate: '2026-10-21', predictions },
  };
}
const under = windowFor('U', [8, 8, 8, 8, 8, 8, 11.9], planOrigins); // 59.9
const exact = windowFor('E', [8, 8, 8, 8, 8, 8, 12], planOrigins); // 60
const over = windowFor('O', [8, 8, 8, 8, 8, 8, 12.1], planOrigins); // 60.1
const built = dash.buildView(
  snapshotWith([under, exact, over]).snapshot,
  { runs: [snapshotWith([]).historyRun, ] .map(() => snapshotWith([under, exact, over]).historyRun) },
  { byTransportId: {} }
);
const byId = Object.fromEntries(built.ranking.map((r) => [r.transportId, r]));
assert.equal(byId.U.forecastOver, false, '60h未満は超過にしない');
assert.equal(byId.E.forecastOver, true, 'ちょうど60hは予測超過（既存仕様）');
assert.equal(byId.O.forecastOver, true, '60h超過は予測超過');

// 日付境界: 取得日時はUTC→JST表示（日付を跨ぐ）
assert.equal(dash.failureText({ reason: 'timeout', lastSuccessAt: '2026-10-20T15:30:00.000Z' }).includes('2026-10-21 00:30:00'), true);
assert.equal(dash.failureText({ reason: 'timeout', lastSuccessAt: '2026-10-20T14:59:59.000Z' }).includes('2026-10-20 23:59:59'), true);
assert.equal(dash.failureText({ reason: 'timeout' }).includes('不明'), true);

// ---- 状態の分類: 成功 / データなし / 失敗
const okBody = { ok: true, snapshot: {}, historyRun: {} };
assert.equal(dash.classifyFeed(okBody, 200).kind, 'ok');
assert.equal(dash.classifyFeed({ ok: false, reason: 'not-published' }, 200).kind, 'empty');
assert.equal(dash.classifyFeed({ ok: false, reason: 'timeout' }, 504).kind, 'failure');
assert.equal(dash.classifyFeed({ ok: true }, 200).kind, 'failure', '本文欠落は成功扱いにしない');
assert.equal(dash.classifyFeed(null, 502).reason, 'upstream-http');
assert.ok(dash.failureText({ reason: 'unauthorized' }).includes('認証'));
assert.ok(!dash.emptyText().includes('取得できませんでした'));

// ---- サーバー側: 通信失敗・HTML応答・タイムアウトを区別し、握りつぶさずログに残す
const logs = [];
const log = (line) => logs.push(line);
let r = await client.fetchCurrent({ log, lastSuccessAt: checkedAt, client: { current: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) } });
assert.equal(r.reason, 'network');
assert.equal(r.lastSuccessAt, checkedAt);
r = await client.fetchCurrent({ log, client: { current: () => Promise.reject(Object.assign(new Error('x'), { response: { status: 403 } })) } });
assert.equal(r.reason, 'upstream-http');
assert.equal(r.httpStatus, 403);
r = await client.fetchCurrent({ log, client: { current: () => Promise.resolve('<html>Sign in</html>') } });
assert.equal(r.reason, 'invalid-response');
r = await client.fetchCurrent({ log, timeoutMs: 20, client: { current: () => new Promise(() => {}) } });
assert.equal(r.reason, 'timeout');
r = await client.fetchCurrent({ log, client: { current: () => { throw new Error('boom'); } } });
assert.equal(r.reason, 'network');
r = await client.fetchCurrent({ log, client: { current: () => Promise.resolve(okBody) } });
assert.equal(r.ok, true);
assert.ok(logs.length >= 5, '失敗理由がログに残る');
assert.ok(logs.every((l) => !/token|secret/i.test(l)), 'ログに秘密情報を含めない');

function call(deps) {
  return new Promise((resolve) => {
    const res = { code: 0, status(c) { res.code = c; return res; }, json(b) { resolve({ code: res.code, body: b }); return res; } };
    const merged = { proxySecret: 's', log };
    Object.defineProperties(merged, Object.getOwnPropertyDescriptors(deps));
    feed.handle({ headers: { 'x-proxy-secret': 's' } }, res, merged);
  });
}
let out = await call({ load: () => Promise.resolve({ ok: false, reason: 'not-published', lastSuccessAt: null }) });
assert.equal(out.code, 200);
assert.equal(out.body.reason, 'not-published');
out = await call({ load: () => Promise.resolve('<html>') });
assert.equal(out.code, 502);
assert.equal(out.body.reason, 'invalid-response');
out = await call({ load: () => Promise.resolve({ ok: false, reason: 'read-failed', snapshot: { stale: 1 }, historyRun: {} }) });
assert.equal(out.body.snapshot, undefined, '失敗応答に古い本文を載せない');
const state = { lastSuccessAt: null };
out = await call({ load: () => Promise.resolve({ ok: true, checkedAt, snapshot: {}, historyRun: {} }), get lastSuccessAt() { return state.lastSuccessAt; }, set lastSuccessAt(v) { state.lastSuccessAt = v; } });
assert.equal(state.lastSuccessAt, checkedAt);
out = await call({ load: () => Promise.reject(new Error('secret-token-123')) });
assert.equal(out.code, 502);
assert.ok(!logs.join('\n').includes('secret-token-123'));

// ---- 画面: 成功→失敗で古いデータを最新として見せない。再読み込みで再取得する
function fakeRoot() {
  return { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
}
globalThis.document = { getElementById: () => null };
globalThis.console = Object.assign(Object.create(console), { warn: () => {} });
let responses = [];
let fetchCount = 0;
globalThis.fetch = () => {
  fetchCount += 1;
  const next = responses.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve({ status: next.status, json: () => (next.invalid ? Promise.reject(new Error('bad json')) : Promise.resolve(next.body)) });
};
const good = snapshotWith([exact]);
const root = fakeRoot();

responses = [{ status: 200, body: { ok: false, reason: 'not-published', lastSuccessAt: null } }];
await dash.mount(root);
assert.ok(root.innerHTML.includes('公開されていません'));
assert.ok(!root.innerHTML.includes('取得できませんでした'));

responses = [{ status: 200, body: { ok: true, checkedAt, snapshot: good.snapshot, historyRun: good.historyRun } }];
await dash.mount(root);
assert.ok(root.innerHTML.includes('勤務時間リスク'));
assert.ok(root.innerHTML.includes('2026-10-21 11:07:52'));
assert.ok(!root.innerHTML.includes('最新のデータではありません'));

responses = [{ status: 502, body: { ok: false, reason: 'network', lastSuccessAt: checkedAt } }];
await dash.mount(root);
assert.ok(root.innerHTML.includes('取得できませんでした'));
assert.ok(root.innerHTML.includes('最新のデータではありません'), '失敗時は前回データを最新と表示しない');
assert.ok(root.innerHTML.includes('2026-10-21 11:07:52'));

responses = [new TypeError('fetch failed')];
await dash.mount(root);
assert.ok(root.innerHTML.includes('ブラウザからサーバーへ接続できません'));

responses = [{ status: 502, invalid: true }];
await dash.mount(root);
assert.ok(root.innerHTML.includes('取得できませんでした'));

const before = fetchCount;
responses = [{ status: 200, body: { ok: true, checkedAt, snapshot: good.snapshot, historyRun: good.historyRun } }];
await dash.mount(root); // 再読み込み: 必ず再取得し、失敗表示は消える
assert.equal(fetchCount, before + 1);
assert.ok(!root.innerHTML.includes('最新のデータではありません'));
assert.ok(!root.innerHTML.includes('取得できませんでした'));

// 対象者ゼロは成功（データなし）として失敗と区別する
const zero = snapshotWith([]);
responses = [{ status: 200, body: { ok: true, checkedAt, snapshot: zero.snapshot, historyRun: zero.historyRun } }];
await dash.mount(root);
assert.ok(root.innerHTML.includes('対象者がいません'));
assert.ok(!root.innerHTML.includes('取得できませんでした'));

console.log('duty-risk-feed-failure.test.mjs: ALL PASSED');
