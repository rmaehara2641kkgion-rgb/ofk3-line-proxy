import assert from 'assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const transport = require('../duty-risk-gas-transport.js');

const checkedAt = '2026-10-23T07:08:56.960Z';
const echo = 'https://script.googleusercontent.com/macros/echo?user_content_key=hidden';
const payload = {
  action: 'publish',
  token: 'duty-risk-token-do-not-log',
  snapshot: { alerts: [{ name: '架空氏名' }] },
  historyRun: { predictions: [{ subjectId: 'TID-1' }] },
};

function fakeHttp(script) {
  const calls = [];
  return {
    calls,
    post(url, body, config) {
      calls.push({ method: 'POST', url, body, config });
      return Promise.resolve(script.post(body, config));
    },
    get(url, config) {
      calls.push({ method: 'GET', url, config });
      return Promise.resolve(script.get(url, config));
    },
  };
}

const redirected = fakeHttp({
  post() {
    return { status: 302, headers: { location: echo }, data: '' };
  },
  get() {
    return {
      status: 200,
      data: { ok: false, published: false, reason: 'verify-snapshot', stage: 'verify-snapshot', revision: 'diag-20261023-1' },
    };
  },
});
const followed = await transport.postJson(redirected, 'https://script.google.com/macros/s/existing/exec', payload, { timeout: 1000 });
assert.equal(redirected.calls.filter((call) => call.method === 'POST').length, 1);
assert.equal(redirected.calls.filter((call) => call.method === 'GET').length, 1);
assert.equal(redirected.calls[1].method, 'GET');
assert.equal(redirected.calls[1].body, undefined);
assert.equal(redirected.calls[0].config.maxRedirects, 0);
assert.equal(followed.reason, 'verify-snapshot');
assert.equal(followed.stage, 'verify-snapshot');
assert.equal(followed.httpStatus, 200);
assert.equal(JSON.stringify(followed).includes('架空氏名'), false);
assert.equal(JSON.stringify(followed).includes('duty-risk-token-do-not-log'), false);
assert.equal(JSON.stringify(followed).includes(echo), false);

const foreign = fakeHttp({
  post() {
    return { status: 302, headers: { location: 'https://evil.example/collect' }, data: '' };
  },
  get() {
    throw new Error('followed unexpected host');
  },
});
const stopped = await transport.postJson(foreign, 'https://script.google.com/macros/s/existing/exec', payload, { timeout: 1000 });
assert.equal(foreign.calls.length, 1);
assert.equal(stopped.reason, 'redirect-unexpected');
assert.equal(stopped.stage, 'redirect');
assert.equal(JSON.stringify(stopped).includes('evil.example'), false);

const failed = fakeHttp({
  post() {
    return {
      status: 500,
      data: {
        ok: false,
        reason: 'verify-run',
        stage: 'verify-run',
        token: 'duty-risk-token-do-not-log',
        snapshot: { name: '架空氏名' },
      },
    };
  },
  get() { throw new Error('no redirect'); },
});
const httpError = await transport.postJson(failed, 'https://script.google.com/macros/s/existing/exec', payload, { timeout: 1000 });
assert.equal(httpError.httpStatus, 500);
assert.equal(httpError.reason, 'verify-run');
assert.equal(httpError.stage, 'verify-run');
assert.equal(JSON.stringify(httpError).includes('架空氏名'), false);
assert.equal(JSON.stringify(httpError).includes('duty-risk-token-do-not-log'), false);

const html = fakeHttp({
  post() {
    return { status: 200, data: '<html>架空氏名 duty-risk-token-do-not-log</html>' };
  },
  get() { throw new Error('no redirect'); },
});
const nonJson = await transport.postJson(html, 'https://script.google.com/macros/s/existing/exec', payload, { timeout: 1000 });
assert.equal(nonJson.reason, 'non-json');
assert.equal(nonJson.httpStatus, 200);
assert.equal(JSON.stringify(nonJson).includes('架空氏名'), false);
assert.equal(JSON.stringify(nonJson).includes('duty-risk-token-do-not-log'), false);

const current = fakeHttp({
  post() { throw new Error('current is not a post'); },
  get(url) {
    assert.equal(String(url).includes('script.google.com'), true);
    return { status: 200, data: { ok: true, checkedAt, snapshot: { name: '架空氏名' }, historyRun: { predictions: [] } } };
  },
});
const feed = await transport.getJson(current, 'https://script.google.com/macros/s/existing/exec', {
  timeout: 1000,
  params: { action: 'current', token: 'duty-risk-token-do-not-log' },
});
assert.equal(feed.ok, true);
assert.equal(feed.snapshot.name, '架空氏名');
assert.equal(feed.token, undefined);

console.log('duty-risk-gas-transport.test.mjs: ALL PASSED');
