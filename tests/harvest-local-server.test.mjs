import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import http from 'node:http';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
function read(name) { return readFileSync(join(root, name), 'utf8'); }
const L = require(join(root, 'harvest-local-server.js'));

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); passed += 1; }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
  passed += 1;
}

// ---- helpers ----
function listen(server) {
  return new Promise(function (resolve) { server.listen(0, '127.0.0.1', function () { resolve(server.address().port); }); });
}
function close(server) { return new Promise(function (resolve) { server.close(function () { resolve(); }); }); }
function request(port, path, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    const headers = Object.assign({ Host: '127.0.0.1:' + port }, opts.headers || {});
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method || 'GET', headers }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function json(r) { return JSON.parse(r.text); }
function fakeFetch(handler) {
  const calls = [];
  const fn = function (url, init) { calls.push({ url: String(url), init: init }); return Promise.resolve().then(function () { return handler(String(url), init); }); };
  fn.calls = calls;
  return fn;
}
function jsonResponse(status, obj, headers) {
  const body = JSON.stringify(obj);
  return new Response(body, { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
}
async function withServer(opts, fn) {
  const server = L.createServer(opts);
  const port = await listen(server);
  try { await fn(port, server); } finally { await close(server); }
}

// ---- minimal PNG decoder (8-bit, non-interlaced, RGB / RGBA) so the icons can be verified pixel-wise ----
function decodePng(buf) {
  assert(buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG signature');
  let pos = 8; let w = 0; let h = 0; let depth = 0; let ctype = 0; let interlace = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('latin1', pos + 4, pos + 8); const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  assert(depth === 8 && interlace === 0 && (ctype === 2 || ctype === 6), 'decodable PNG (8-bit RGB/RGBA)');
  const bpp = ctype === 6 ? 4 : 3; const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let r;
      if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
      else { const pp = a + b - c; const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)); }
      out[y * stride + x] = r & 255;
    }
  }
  return { w, h, bpp, ctype, px: function (x, y) { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2], bpp === 4 ? out[i + 3] : 255]; } };
}
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
// Verifies a black-and-white emblem icon: RGBA, transparent corners, opaque neutral pixels only, both black and white present.
function checkEmblem(img, label) {
  eq(img.ctype, 6, label + ': RGBA');
  [[0, 0], [img.w - 1, 0], [0, img.h - 1], [img.w - 1, img.h - 1]].forEach(function (c) { eq(img.px(c[0], c[1])[3], 0, label + ': transparent corner'); });
  let opaque = 0; let dark = 0; let light = 0; let colourful = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const p = img.px(x, y);
      if (p[3] < 250) continue;
      opaque += 1;
      if (Math.max(Math.abs(p[0] - p[1]), Math.abs(p[1] - p[2])) > 10) colourful += 1;
      if (p[0] < 60) dark += 1; else if (p[0] > 195) light += 1;
    }
  }
  eq(colourful, 0, label + ': no colour (black / white only)');
  assert(opaque > img.w * img.h * 0.55, label + ': emblem fills the icon');
  assert(dark / opaque > 0.25 && light / opaque > 0.15, label + ': both black field and white tree are present');
  // the centre of the top rim is white-on-black structure: outermost opaque pixel column of the vertical axis must exist
  assert(img.px(Math.floor(img.w / 2), Math.floor(img.h / 2))[3] === 255, label + ': centre opaque');
}
function pngSize(buf) {
  assert(buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG signature');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// ============ 1. refusal / config parsing ============
eq(L.refusalReason({ NODE_ENV: 'production' }), 'NODE_ENV=production', 'production refused');
eq(L.refusalReason({ NODE_ENV: 'Production' }), 'NODE_ENV=production', 'production (case) refused');
assert(/Render/.test(L.refusalReason({ RENDER: 'true' })), 'RENDER refused');
assert(/Render/.test(L.refusalReason({ RENDER_SERVICE_ID: 'srv-1' })), 'RENDER_SERVICE_ID refused');
assert(/Render/.test(L.refusalReason({ RENDER_EXTERNAL_URL: 'https://x.onrender.com' })), 'RENDER_EXTERNAL_URL refused');
eq([L.refusalReason({}), L.refusalReason({ NODE_ENV: 'development' }), L.refusalReason({ RENDER: '' })], [null, null, null], 'normal local env allowed');

eq(L.parsePort(undefined), { ok: true, port: 3100 }, 'default port 3100');
eq(L.parsePort('3200'), { ok: true, port: 3200 }, 'custom port');
['80', 'abc', '70000', '3100.5', '-1'].forEach(function (p) { eq(L.parsePort(p).ok, false, 'invalid port ' + p); });

eq(L.parseUpstream(undefined), { ok: true, origin: null }, 'unset upstream');
eq(L.parseUpstream('  '), { ok: true, origin: null }, 'blank upstream');
eq(L.parseUpstream('https://example.test'), { ok: true, origin: 'https://example.test' }, 'https origin');
eq(L.parseUpstream('http://127.0.0.1:3000/'), { ok: true, origin: 'http://127.0.0.1:3000' }, 'http loopback allowed');
['http://example.test', 'ftp://example.test', 'https://user:pw@example.test', 'https://example.test/path', 'https://example.test/?a=1', 'https://example.test/#x', 'not a url'].forEach(function (u) {
  eq(L.parseUpstream(u).ok, false, 'upstream rejected: ' + u);
});

// refuses to start as a process (never listens)
{
  const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const run = function (env) { return spawnSync(process.execPath, [join(root, 'harvest-local-server.js')], { env: Object.assign({}, base, env), encoding: 'utf8', timeout: 8000 }); };
  const a = run({ NODE_ENV: 'production' });
  eq(a.status, 1, 'process exits 1 under NODE_ENV=production');
  assert(/refuses to start/.test(a.stderr), 'explains refusal');
  eq(run({ RENDER: 'true' }).status, 1, 'process exits 1 under RENDER');
  eq(run({ HARVEST_PORT: 'abc' }).status, 1, 'process exits 1 on bad port');
}

// ============ 2. server behaviour ============
{
  const fetchSpy = fakeFetch(function () { throw new Error('must not be called'); });

  await withServer({ port: 0, env: {}, fetchImpl: fetchSpy }, async function (port, server) {
    eq(server.address().address, '127.0.0.1', 'listens on 127.0.0.1');

    // page
    const page = await request(port, '/harvest');
    eq([page.status, /text\/html/.test(page.headers['content-type'])], [200, true], 'GET /harvest');
    const csp = page.headers['content-security-policy'];
    assert(csp && csp.indexOf("connect-src 'self'") >= 0 && csp.indexOf("script-src 'self'") >= 0 && csp.indexOf("default-src 'none'") >= 0, 'CSP restricts to self');
    assert(page.headers['cache-control'] === 'no-store' && page.headers['x-content-type-options'] === 'nosniff', 'security headers');
    const html = page.text;
    assert(!/https?:\/\//i.test(html), 'page HTML has no external URL');
    assert(!/tailwind|cdn\./i.test(html), 'no CDN dependency');
    const order = ['/harvest-core.js', '/harvest-collectors-cortex.js', '/ofk3-harvest-ui.js', '/harvest-shell.js'].map(function (s) { return html.indexOf('src="' + s + '"'); });
    assert(order.every(function (i) { return i > 0; }) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], 'scripts present in order');
    assert(html.indexOf('ofk3-cortex-priority-ui.js') < 0, 'Cortex script is NOT loaded by the initial page');
    assert(html.indexOf('データ読込を開始') >= 0 && html.indexOf('id="dashboard-content"') >= 0, 'start button and HARVEST host present');
    assert(html.indexOf('<img src="/assets/harvest-logo-192.png"') >= 0, 'page header still shows the original Renaissance logo');
    assert(html.indexOf('src="/assets/harvest-192.png') < 0, 'emblem icon is not used as the page logo');
    assert(html.indexOf('rel="icon" href="/assets/harvest.ico?v=') >= 0 && html.indexOf('rel="manifest" href="/harvest.webmanifest?v=') >= 0, 'favicon and manifest linked with a cache-busting version');
    eq((await request(port, '/')).status, 302, '/ redirects to /harvest');
    eq((await request(port, '/harvest', { method: 'HEAD' })).status, 200, 'HEAD ok');

    // manifest + icons
    const mf = await request(port, '/harvest.webmanifest');
    eq(mf.status, 200, 'manifest served');
    assert(/manifest\+json/.test(mf.headers['content-type']), 'manifest content type');
    const m = json(mf);
    eq([m.name, m.short_name, m.start_url, m.scope, m.display], ['HARVEST', 'HARVEST', '/harvest', '/harvest', 'standalone'], 'manifest fields');
    eq(m.id, '/harvest', 'manifest id');
    assert(m.icons.every(function (i) { return /^\/assets\/harvest-(192|512)\.png\?v=\d+$/.test(i.src); }), 'manifest icons are the emblem files with a version');
    eq(m.icons.map(function (i) { return i.sizes; }), ['192x192', '512x512'], 'manifest icons');
    for (const ic of m.icons) {
      const r = await request(port, ic.src);
      eq([r.status, r.headers['content-type']], [200, 'image/png'], 'icon served ' + ic.src);
      eq(pngSize(r.buf).join('x'), ic.sizes, 'icon real size ' + ic.src);
    }
    const logo192 = await request(port, '/assets/harvest-logo-192.png');
    eq([logo192.status, sha256(logo192.buf)], [200, 'de2b1eb94b81ed5c3f394ba8e50bc6214af787d5ef1c5ed93f56252100698ad9'], 'original Renaissance logo served unchanged');
    const ico = await request(port, '/assets/harvest.ico?v=2');
    eq([ico.status, ico.headers['content-type']], [200, 'image/x-icon'], 'ico served');
    assert(!/service-?worker|serviceWorker/i.test(html + L.SHELL_JS), 'no service worker / offline cache');

    // existing scripts served as-is
    for (const f of ['harvest-core.js', 'harvest-collectors-cortex.js', 'ofk3-harvest-ui.js', 'ofk3-cortex-priority-ui.js']) {
      const r = await request(port, '/' + f);
      eq([r.status, r.text === read(f)], [200, true], 'served unmodified: ' + f);
    }

    // allow-list: nothing else is served
    for (const p of ['/package.json', '/render-webhook-server.js', '/inject-tenko-audit.js', '/index.html', '/harvest-local-server.js', '/assets/harvest-logo.png',
      '/.git/config', '/node_modules/express/package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/assets/', '/harvest/extra', '/harvest.html', '/inoichi-core.js']) {
      eq((await request(port, p)).status, 404, 'not served: ' + p);
    }

    // host header (DNS rebinding) / origin
    for (const h of ['evil.example', 'evil.example:' + port, '127.0.0.1', 'localhost', 'localhost:1', '127.0.0.1:' + (port + 1)]) {
      eq((await request(port, '/harvest', { headers: { Host: h } })).status, 403, 'host refused: "' + h + '"');
    }
    eq((await request(port, '/harvest', { headers: { Host: 'localhost:' + port } })).status, 200, 'localhost host allowed');
    eq((await request(port, '/harvest', { headers: { Origin: 'http://evil.example' } })).status, 403, 'cross-origin refused');
    eq((await request(port, '/cortex-priority?localDate=2026-10-15', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'cross-site refused');
    eq((await request(port, '/harvest', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200, 'same-origin ok');

    // write-type methods refused
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      for (const p of ['/harvest', '/cortex-priority', '/cortex-priority/import', '/tenko-sync', '/webhook']) {
        const r = await request(port, p, { method, body: method === 'POST' || method === 'PUT' ? '{"x":1}' : undefined, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {} });
        eq([r.status, r.headers.allow], [405, 'GET, HEAD'], method + ' ' + p + ' refused');
      }
    }

    // OFK3 routes do not exist here
    for (const p of ['/webhook', '/line-unlinked', '/tenko-sync', '/tenko-master', '/proxy', '/cortex-priority/import', '/wh60', '/ping']) {
      eq((await request(port, p)).status, 404, 'OFK3 route absent: ' + p);
    }

    // upstream not configured: no outbound call, explicit "empty" answer
    const r404 = await request(port, '/cortex-priority?localDate=2026-10-15');
    eq([r404.status, json(r404).harvestLocal, json(r404).status, json(r404).packages], [404, 'upstream-not-configured', 'empty', []], 'unset upstream -> empty');
    eq((await request(port, '/cortex-priority?localDate=2026-10-15&latest=1')).status, 404, 'unset upstream (latest) -> empty');
    eq(fetchSpy.calls.length, 0, 'NO outbound call when upstream is unset');
    const st = json(await request(port, '/harvest-status.json'));
    eq([st.app, st.upstreamOrigin, st.upstreamError], ['harvest-local', null, null], 'status reports no upstream');
  });
}

// upstream configured (fake fetch)
{
  const upstreamBody = { status: 'ok', localDate: '2026-10-15', packages: [{ routeCode: 'R', stop: 1, trackingId: 'T' }] };
  const f = fakeFetch(function () { return jsonResponse(200, upstreamBody); });
  await withServer({ port: 0, env: { HARVEST_UPSTREAM_BASE_URL: 'https://upstream.example' }, fetchImpl: f }, async function (port) {
    const st = json(await request(port, '/harvest-status.json'));
    eq(st.upstreamOrigin, 'https://upstream.example', 'status shows upstream origin');
    eq(f.calls.length, 0, 'no call at startup / status');
    await request(port, '/harvest');
    eq(f.calls.length, 0, 'page view does not call upstream');

    const ok = await request(port, '/cortex-priority?localDate=2026-10-15&latest=1', { headers: { Cookie: 'sid=secret', Authorization: 'Bearer secret', 'X-Proxy-Secret': 's', 'X-Tenko-Sync-Token': 't' } });
    eq([ok.status, json(ok)], [200, upstreamBody], 'relays 200 JSON');
    eq(ok.headers['x-harvest-upstream'], 'https://upstream.example', 'upstream origin header');
    eq(f.calls.length, 1, 'exactly one upstream call');
    const c = f.calls[0];
    eq(c.url, 'https://upstream.example/cortex-priority?localDate=2026-10-15&latest=1', 'upstream URL fixed to /cortex-priority + allowed query');
    eq([c.init.method, c.init.redirect], ['GET', 'manual'], 'GET only, redirects not followed');
    eq(Object.keys(c.init.headers).sort(), ['Accept', 'User-Agent'], 'only Accept / User-Agent sent');
    assert(!JSON.stringify(c.init).match(/cookie|authorization|secret|token/i), 'no cookie / credential forwarded');
    assert(c.init.signal && typeof c.init.signal.aborted === 'boolean', 'timeout signal attached');
    eq(L.UPSTREAM_TIMEOUT_MS, 5000, 'timeout is 5 s');
    assert(c.init.body === undefined, 'no body');

    // query allow-list: nothing else reaches the upstream
    const before = f.calls.length;
    for (const q of ['?localDate=2026-10-15&x=1', '?localDate=2026-10-15&latest=0', '?localDate=bad', '?localDate=2026-10-15&latest=1&path=/etc', '?url=http://evil.example', '?latest=2']) {
      const r = await request(port, '/cortex-priority' + q);
      eq(r.status, 400, 'rejected query ' + q);
    }
    eq(f.calls.length, before, 'rejected queries never reach upstream');
    // only the exact path is relayed
    for (const p of ['/cortex-priority/import', '/cortex-priority/', '/cortex-priority/../webhook', '/cortex-priorityx']) {
      eq((await request(port, p + '?localDate=2026-10-15')).status, 404, 'not relayed: ' + p);
    }
    eq(f.calls.length, before, 'other paths never reach upstream');
    // no localDate is also fine
    const r0 = await request(port, '/cortex-priority');
    eq(r0.status, 200, 'no query ok');
    eq(f.calls[f.calls.length - 1].url, 'https://upstream.example/cortex-priority', 'no query forwarded as-is');
  });

  // upstream errors are explicit
  async function relayWith(handler, path) {
    let out;
    await withServer({ port: 0, env: { HARVEST_UPSTREAM_BASE_URL: 'https://upstream.example' }, fetchImpl: fakeFetch(handler) }, async function (port) {
      out = await request(port, path || '/cortex-priority?localDate=2026-10-15');
    });
    return out;
  }
  const notFound = await relayWith(function () { return jsonResponse(404, { status: 'empty', packages: [] }); });
  eq([notFound.status, json(notFound).status], [404, 'empty'], 'upstream 404 passed through (no data)');
  const e500 = await relayWith(function () { return jsonResponse(500, { error: 'boom' }); });
  eq([e500.status, json(e500).status, json(e500).upstreamStatus], [502, 'error', 500], 'upstream 500 -> 502 with detail');
  const e401 = await relayWith(function () { return jsonResponse(401, { error: 'auth' }); });
  eq([e401.status, json(e401).upstreamStatus], [502, 401], 'upstream auth failure -> explicit 502 (no credentials sent)');
  const redir = await relayWith(function () { return new Response('', { status: 302, headers: { location: 'https://evil.example/' } }); });
  eq([redir.status, /redirect refused/.test(json(redir).message)], [502, true], 'redirect refused');
  const notJson = await relayWith(function () { return new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }); });
  eq([notJson.status, /non-JSON/.test(json(notJson).message)], [502, true], 'non-JSON refused');
  const big = await relayWith(function () { return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) } }); });
  eq([big.status, /too large/.test(json(big).message)], [502, true], 'oversized refused');
  const tmo = await relayWith(function () { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
  eq([tmo.status, /timeout/.test(json(tmo).message)], [504, true], 'timeout -> 504');
  const net = await relayWith(function () { throw new TypeError('fetch failed'); });
  eq([net.status, /unreachable/.test(json(net).message)], [502, true], 'network failure -> 502');
  assert(!/fetch failed/.test(net.text), 'internal error text is not leaked');

  // invalid upstream configuration disables the relay explicitly
  const bad = fakeFetch(function () { throw new Error('must not be called'); });
  await withServer({ port: 0, env: { HARVEST_UPSTREAM_BASE_URL: 'https://upstream.example/some/path' }, fetchImpl: bad }, async function (port) {
    const st = json(await request(port, '/harvest-status.json'));
    assert(st.upstreamError && st.upstreamOrigin === null, 'status reports configuration error');
    const r = await request(port, '/cortex-priority?localDate=2026-10-15');
    eq([r.status, /configuration invalid/.test(json(r).message)], [502, true], 'relay disabled on invalid config');
    eq(bad.calls.length, 0, 'no call with invalid config');
  });
}

// real HTTP upstream: GET only, nothing sensitive forwarded
{
  const seen = [];
  const up = http.createServer(function (req, res) {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', localDate: '2026-10-15', packages: [] }));
  });
  const upPort = await listen(up);
  try {
    await withServer({ port: 0, env: { HARVEST_UPSTREAM_BASE_URL: 'http://127.0.0.1:' + upPort } }, async function (port) {
      const r = await request(port, '/cortex-priority?localDate=2026-10-15', { headers: { Cookie: 'sid=1', Authorization: 'Bearer x' } });
      eq([r.status, json(r).status], [200, 'ok'], 'real relay works');
      eq(seen.length, 1, 'one upstream request');
      eq([seen[0].method, seen[0].url], ['GET', '/cortex-priority?localDate=2026-10-15'], 'upstream saw GET /cortex-priority');
      assert(!seen[0].headers.cookie && !seen[0].headers.authorization, 'no cookie / authorization reached upstream');
    });
  } finally { await close(up); }
}

// ============ 3. shell script behaviour (vm) ============
{
  function boot() {
    const scripts = [];
    const els = {};
    ['hv-upstream', 'hv-load', 'hv-resp', 'hv-result', 'hv-load-btn'].forEach(function (id) { els[id] = { id, textContent: '', className: '', disabled: false, _l: {}, addEventListener: function (t, fn) { this._l[t] = fn; } }; });
    const fetched = [];
    const document = {
      getElementById: function (id) { return els[id] || null; },
      createElement: function () { return { setAttribute: function () {} }; },
      body: { appendChild: function (s) { scripts.push(s.src); } }
    };
    const win = { fetch: function (u) { fetched.push(String(u)); return Promise.resolve(new Response(JSON.stringify({ app: 'harvest-local', upstreamOrigin: null }), { status: 200 })); } };
    win.window = win;
    vm.runInNewContext(L.SHELL_JS, { window: win, document, Response, Promise, Date, JSON, String, Array });
    return { els, scripts, fetched };
  }
  const b = boot();
  eq(b.scripts, [], 'shell appends no script at start');
  eq(b.fetched, ['/harvest-status.json'], 'shell only reads the local status file at start');
  assert(typeof b.els['hv-load-btn']._l.click === 'function', 'button wired');
  b.els['hv-load-btn']._l.click();
  eq(b.scripts, ['/ofk3-cortex-priority-ui.js'], 'Cortex script loaded only after the click');
  b.els['hv-load-btn']._l.click();
  eq(b.scripts.length, 1, 'second click does not load again');
  eq(L.SHELL_JS.split('ofk3-cortex-priority-ui.js').length - 1, 1, 'Cortex script referenced once, inside the click handler path');
  assert(!/visibilitychange|pageshow|focus|setInterval|setTimeout|addEventListener\("online"/.test(L.SHELL_JS), 'no auto-reload hooks');
}

// ============ 4. static contract / isolation ============
{
  const src = read('harvest-local-server.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/setInterval|setTimeout/.test(code), 'no timers');
  assert(!/writeFile|appendFile|createWriteStream|mkdir|unlink|rename\(/.test(code), 'no file writes');
  assert(!/require\('express'\)|require\("express"\)|axios|render-webhook-server|inject-tenko-audit/.test(code), 'does not load OFK3 / express / axios');
  assert(!/express\.static/.test(code), 'no express.static');
  assert(!/CHANNEL_ACCESS_TOKEN|ADMIN_LINE_ID|GAS_URL|GOOGLE_MAPS|TENKO|PROXY_SECRET|api\.line\.me|script\.google/.test(code), 'no LINE / GAS / Google / TENKO references');
  const envReads = Array.from(code.matchAll(/process\.env\.([A-Z_]+)|env\.([A-Z_]+)/g)).map(function (m) { return m[1] || m[2]; });
  const allowedEnv = new Set(['NODE_ENV', 'HARVEST_PORT', 'HARVEST_UPSTREAM_BASE_URL']);
  assert(envReads.every(function (n) { return allowedEnv.has(n); }), 'only NODE_ENV / HARVEST_PORT / HARVEST_UPSTREAM_BASE_URL are read: ' + envReads.join(','));
  assert(/listen\(port\.port, BIND_HOST/.test(code) && L.BIND_HOST === '127.0.0.1', 'binds to BIND_HOST 127.0.0.1');
  assert(!/0\.0\.0\.0|'::'/.test(code), 'never binds all interfaces');
  assert(!/method:\s*'(POST|PUT|DELETE|PATCH)'/.test(code), 'upstream method is GET only');

  // Render / OFK3 start paths are untouched and do not reference this server.
  const pkg = JSON.parse(read('package.json'));
  eq(pkg.scripts.start, 'node inject-tenko-audit.js', 'npm start unchanged');
  eq(pkg.scripts.dev, 'node inject-tenko-audit.js', 'npm run dev unchanged');
  eq(pkg.scripts['harvest:local'], 'node harvest-local-server.js', 'harvest:local script');
  assert(pkg.scripts['test:all'].indexOf('test:harvest-local') >= 0, 'test:all includes test:harvest-local');
  eq(pkg.main, 'render-webhook-server.js', 'package main unchanged');
  assert(read('render.yaml').indexOf('startCommand: node render-webhook-server.js') >= 0, 'Render start command unchanged');
  ['render.yaml', 'render-webhook-server.js', 'inject-tenko-audit.js', 'index.html'].forEach(function (f) {
    assert(!/harvest-local|harvest\.webmanifest|start-harvest/.test(read(f)), f + ' does not reference the local HARVEST app');
  });
}

// ============ 5. logo / icon assets ============
{
  // The in-page Renaissance logo and its master are byte-for-byte unchanged.
  eq(sha256(readFileSync(join(root, 'assets/harvest-logo.png'))), 'b49876cfc9cc21707ea9b9496cea42ac982386d64da3bc58cf92ffe9eec97fc0', 'Renaissance master logo unchanged');
  eq(sha256(readFileSync(join(root, 'assets/harvest-logo-192.png'))), 'de2b1eb94b81ed5c3f394ba8e50bc6214af787d5ef1c5ed93f56252100698ad9', 'Renaissance 192 logo unchanged');
  eq(pngSize(readFileSync(join(root, 'assets/harvest-logo.png'))), [1254, 1254], 'master logo kept at original size');

  // The supplied black-and-white emblem is the icon source.
  const master = decodePng(readFileSync(join(root, 'assets/harvest-emblem.png')));
  eq([master.w, master.h], [1254, 1254], 'emblem master size');
  let colourfulMaster = 0;
  for (let y = 0; y < master.h; y += 3) for (let x = 0; x < master.w; x += 3) { const p = master.px(x, y); if (Math.max(Math.abs(p[0] - p[1]), Math.abs(p[1] - p[2])) > 12) colourfulMaster += 1; }
  eq(colourfulMaster, 0, 'emblem master is black and white');

  const i192 = decodePng(readFileSync(join(root, 'assets/harvest-192.png')));
  const i512 = decodePng(readFileSync(join(root, 'assets/harvest-512.png')));
  eq([i192.w, i192.h, i512.w, i512.h], [192, 192, 512, 512], 'icon PNG sizes');
  checkEmblem(i192, '192');
  checkEmblem(i512, '512');
  assert(sha256(readFileSync(join(root, 'assets/harvest-192.png'))) !== 'de2b1eb94b81ed5c3f394ba8e50bc6214af787d5ef1c5ed93f56252100698ad9', '192 icon is the emblem, not the old logo');

  const ico = readFileSync(join(root, 'assets/harvest.ico'));
  eq([ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1], 'ICO header');
  const n = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16; const w = ico[e] === 0 ? 256 : ico[e]; const h = ico[e + 1] === 0 ? 256 : ico[e + 1];
    const len = ico.readUInt32LE(e + 8); const off = ico.readUInt32LE(e + 12);
    sizes.push(w);
    const frame = decodePng(ico.slice(off, off + len));
    eq([frame.w, frame.h, h], [w, w, w], 'ICO frame ' + w + 'px is a real ' + w + 'x' + w + ' image');
    checkEmblem(frame, 'ICO ' + w);
  }
  eq(sizes, [16, 24, 32, 48, 64, 128, 256], 'ICO contains exactly 16/24/32/48/64/128/256 px');
}

// ============ 6. Windows launcher (static; real behaviour needs Windows) ============
{
  ['start-harvest.cmd', 'stop-harvest.cmd'].forEach(function (f) {
    assert(existsSync(join(root, f)), f + ' exists');
    const raw = readFileSync(join(root, f));
    assert(raw.every(function (b) { return b < 128; }), f + ' is ASCII only');
    const t = raw.toString('latin1');
    assert(t.indexOf('\r\n') > 0 && !/[^\r]\n/.test(t), f + ' uses CRLF');
  });
  const sFull = read('start-harvest.cmd');
  const s = sFull.split('\r\n').filter(function (l) { return !/^\s*rem\b/i.test(l); }).join('\r\n'); // code only (comments may name what it does NOT start)
  assert(s.indexOf('harvest-local-server.js') >= 0 && s.indexOf('127.0.0.1') >= 0, 'launcher targets the local server on 127.0.0.1');
  assert(!/npm start|render-webhook-server|inject-tenko-audit/.test(s), 'launcher never starts OFK3');
  assert(!/CHANNEL_ACCESS_TOKEN|ADMIN_LINE_ID|GAS_URL|GOOGLE_MAPS|TENKO|PROXY_SECRET/.test(s), 'launcher sets no OFK3 secrets');
  assert(s.indexOf('Get-NetTCPConnection') >= 0 && s.indexOf('harvest-local') >= 0 && s.indexOf('used by another application') >= 0, 'detects a foreign process on the port and stops');
  assert(s.indexOf('PID_FILE') >= 0 && s.indexOf('-RedirectStandardError') >= 0, 'records PID and logs');
  assert(s.indexOf('msedge.exe') >= 0 && s.indexOf('chrome.exe') >= 0 && s.indexOf('msedge.exe') < s.indexOf('chrome.exe'), 'Edge preferred, Chrome fallback');
  assert(s.indexOf('--app=%URL%') >= 0 && s.indexOf('/harvest') >= 0, 'opens the /harvest app window');
  const stop = read('stop-harvest.cmd');
  assert(stop.indexOf('harvest-local-server.js') >= 0 && stop.indexOf('server.pid') >= 0, 'stop script verifies the process before stopping it');
  assert(read('.gitattributes').indexOf('*.cmd text eol=crlf') >= 0, '.gitattributes keeps CRLF for .cmd');

  // shortcut helper: creates a shortcut only; never pins or changes Windows settings
  ['create-harvest-shortcut.cmd', 'create-harvest-shortcut.ps1'].forEach(function (f) {
    assert(existsSync(join(root, f)), f + ' exists');
    const raw = readFileSync(join(root, f));
    assert(raw.every(function (b) { return b < 128; }), f + ' is ASCII only');
    const t = raw.toString('latin1');
    assert(t.indexOf('\r\n') > 0 && !/[^\r]\n/.test(t), f + ' uses CRLF');
  });
  const ps = read('create-harvest-shortcut.ps1');
  const psCode = ps.split('\r\n').filter(function (l) { return !/^\s*#/.test(l) && !/Write-Host/.test(l); }).join('\r\n');
  assert(psCode.indexOf("assets\\harvest.ico") >= 0 && psCode.indexOf('IconLocation') >= 0, 'shortcut uses the emblem ICO');
  assert(psCode.indexOf('start-harvest.cmd') >= 0 && /System32\\cmd\.exe/.test(psCode), 'shortcut runs start-harvest.cmd through cmd.exe (an executable target, so it can be pinned)');
  assert(psCode.indexOf("CreateShortcut") >= 0 && psCode.indexOf('.Save()') >= 0, 'creates a .lnk');
  assert(!/InvokeVerb|syspin|TaskBand|Set-ItemProperty|New-ItemProperty|reg(\.exe)? add|schtasks|Set-ExecutionPolicy|Register-ScheduledTask|Startup|Remove-Item|Invoke-WebRequest|Start-Process|netsh|powercfg/i.test(psCode), 'no pinning automation, registry / policy / scheduled-task changes, downloads or deletions');
  assert(/Pin to taskbar/.test(ps), 'tells the user to pin it themselves');
  const wrapper = read('create-harvest-shortcut.cmd');
  assert(wrapper.indexOf('-ExecutionPolicy Bypass') >= 0 && !/Set-ExecutionPolicy/.test(wrapper), 'execution policy is bypassed for this one process only, never changed');
  assert(wrapper.indexOf('create-harvest-shortcut.ps1') >= 0, 'wrapper runs the script');
  assert(read('.gitattributes').indexOf('*.ps1 text eol=crlf') >= 0, '.gitattributes keeps CRLF for .ps1');
  assert(read('.gitignore').indexOf('/harvest-local.config.cmd') >= 0, 'user config is git-ignored');
}

console.log('harvest-local-server tests passed (' + passed + ' assertions)');
