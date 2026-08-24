import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 43100 + Math.floor(Math.random() * 200);
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: Object.assign({}, process.env, { PORT: String(port) }),
  stdio: ['ignore', 'pipe', 'pipe']
});

function request(method, urlPath, body) {
  return fetch('http://127.0.0.1:' + port + urlPath, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body || undefined
  });
}

function waitForListen() {
  return new Promise(function (resolve, reject) {
    var timeout = setTimeout(function () {
      reject(new Error('server did not start'));
    }, 8000);
    child.stdout.on('data', function (buf) {
      if (String(buf).indexOf('listening') >= 0) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on('error', reject);
    child.on('exit', function (code) {
      clearTimeout(timeout);
      reject(new Error('server exited ' + code));
    });
  });
}

try {
  await waitForListen();

  var home = await request('GET', '/');
  assert.equal(home.status, 200);
  var html = await home.text();
  assert.match(html, /3分でデモを体験/);
  assert.match(html, /現場司令室/);
  assert.match(html, /プロフィール/);

  var opsJs = await request('GET', '/src/ops.js');
  assert.equal(opsJs.status, 200);
  assert.match(String(opsJs.headers.get('content-type') || ''), /javascript/);

  var health = await request('GET', '/health');
  assert.equal(health.status, 200);
  var healthJson = await health.json();
  assert.equal(healthJson.ok, true);

  var css = await request('GET', '/assets/app.css');
  assert.equal(css.status, 200);
  assert.match(String(css.headers.get('content-type') || ''), /text\/css/);
  var cssText = await css.text();
  assert.match(cssText, /--navy/);

  var js = await request('GET', '/src/app.js');
  assert.equal(js.status, 200);
  assert.match(String(js.headers.get('content-type') || ''), /javascript/);
  var jsText = await js.text();
  assert.match(jsText, /window\.DemoApp/);
assert.match(jsText, /openLineModal/);
assert.match(jsText, /renderDriverBoard/);

  var line = await request('POST', '/api/line/send', '{}');
  assert.equal(line.status, 403);
  var lineJson = await line.json();
  assert.equal(lineJson.ok, false);
  assert.equal(lineJson.demo, true);
  assert.match(lineJson.message, /送信されません/);

  console.log('smoke.test.mjs ok');
} finally {
  child.kill();
}
