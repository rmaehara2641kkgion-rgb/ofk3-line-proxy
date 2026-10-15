/**
 * HARVEST local app server (standalone, local only).
 *
 * Serves a dedicated HARVEST page at http://127.0.0.1:3100/harvest so HARVEST can run in its
 * own window (Edge/Chrome --app, PWA, taskbar). It does NOT start or load OFK3
 * (render-webhook-server.js), so none of OFK3's periodic jobs (WH60), LINE / GAS / Google calls
 * or other routes exist here. It is not part of the Render start path.
 *
 * Safety design
 *  - Local only: binds 127.0.0.1; refuses to start when NODE_ENV=production or a Render
 *    environment is detected; Host header allow-list (DNS-rebinding guard); cross-origin
 *    requests are rejected.
 *  - Read only: GET / HEAD only. No write routes, no file writes, no periodic timers.
 *  - Explicit allow-list of what is served (no directory serving). The page HTML and its
 *    small shell script are embedded here, so no new page is exposed by OFK3's static server.
 *  - The only outbound call is an OPT-IN, GET-only relay of /cortex-priority to
 *    HARVEST_UPSTREAM_BASE_URL (unset => no outbound communication at all). Only the query keys
 *    localDate / latest are accepted; 5 s timeout; no cookies / credentials / headers forwarded;
 *    redirects are refused; nothing is stored.
 *  - The page never loads ofk3-cortex-priority-ui.js (which fetches on load) until the user
 *    presses "データ読込を開始".
 *  - Page CSP: connect-src 'self' (the browser cannot call anything else).
 *
 * Env: HARVEST_PORT (default 3100), HARVEST_UPSTREAM_BASE_URL (default unset). No other
 * environment variable (LINE / GAS / Google / TENKO ...) is read.
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var BIND_HOST = '127.0.0.1';
var DEFAULT_PORT = 3100;
var UPSTREAM_TIMEOUT_MS = 5000;
var UPSTREAM_MAX_BYTES = 20 * 1024 * 1024;
var APP_ID = 'harvest-local';

// Existing scripts are served as-is from the repository by a fixed table (no directory serving).
var FILES = {
  '/harvest-core.js': { file: 'harvest-core.js', type: 'application/javascript; charset=utf-8' },
  '/harvest-collectors-cortex.js': { file: 'harvest-collectors-cortex.js', type: 'application/javascript; charset=utf-8' },
  '/ofk3-harvest-ui.js': { file: 'ofk3-harvest-ui.js', type: 'application/javascript; charset=utf-8' },
  '/ofk3-cortex-priority-ui.js': { file: 'ofk3-cortex-priority-ui.js', type: 'application/javascript; charset=utf-8' },
  '/assets/harvest-192.png': { file: 'assets/harvest-192.png', type: 'image/png' },
  '/assets/harvest-512.png': { file: 'assets/harvest-512.png', type: 'image/png' },
  '/assets/harvest.ico': { file: 'assets/harvest.ico', type: 'image/x-icon' }
};

var MANIFEST = {
  name: 'HARVEST',
  short_name: 'HARVEST',
  description: 'HARVEST Data Collector (local)',
  start_url: '/harvest',
  scope: '/harvest',
  display: 'standalone',
  background_color: '#f6efdc',
  theme_color: '#7a5c1e',
  icons: [
    { src: '/assets/harvest-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/assets/harvest-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
  ]
};

var SHELL_CSS = [
  'html,body{margin:0;padding:0;background:#f6efdc;color:#2b2416;font-family:"Segoe UI","Yu Gothic UI","Meiryo",sans-serif;}',
  '.wrap{max-width:980px;margin:0 auto;padding:16px;}',
  '.head{display:flex;align-items:center;gap:16px;margin-bottom:16px;}',
  '.head img{width:84px;height:84px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);}',
  '.head h1{margin:0;font-size:24px;letter-spacing:.06em;}',
  '.head p{margin:2px 0 0;font-size:12px;color:#6b5a33;}',
  '.panel{background:#fff;border:1px solid #d9c9a0;border-radius:10px;padding:14px 16px;margin-bottom:14px;}',
  '.panel h2{margin:0 0 8px;font-size:14px;}',
  '.kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;font-size:13px;}',
  '.kv dt{color:#6b5a33;}.kv dd{margin:0;word-break:break-all;}',
  '.btn{padding:9px 18px;background:#7a5c1e;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;}',
  '.btn[disabled]{background:#b9ad8c;cursor:default;}',
  '.note{font-size:12px;color:#6b5a33;line-height:1.7;}',
  '.ok{color:#15803d;font-weight:700;}.warn{color:#b45309;font-weight:700;}.ng{color:#b91c1c;font-weight:700;}',
  /* classes used by the existing HARVEST UI's button card */
  '.card{background:#fff;border:1px solid #d9c9a0;border-radius:10px;}.p-4{padding:16px;}.mb-4{margin-bottom:16px;}',
  '.text-sm{font-size:14px;}.text-xs{font-size:12px;}.font-medium{font-weight:600;}.mt-1{margin-top:4px;}.text-ink-lighter{color:#6b5a33;}',
  'p{margin:0;}'
].join('\n');

var SHELL_HTML = [
  '<!doctype html>',
  '<html lang="ja"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>HARVEST — Data Collector</title>',
  '<link rel="icon" href="/assets/harvest.ico">',
  '<link rel="manifest" href="/harvest.webmanifest">',
  '<meta name="theme-color" content="#7a5c1e">',
  '<style>' + SHELL_CSS + '</style></head><body>',
  '<div class="wrap">',
  '<div class="head"><img src="/assets/harvest-192.png" alt="HARVEST">',
  '<div><h1>HARVEST</h1><p>DATA COLLECTOR ／ 餓鬼道: データ観測・検証・正規化・handoff準備 (ローカル専用)</p></div></div>',
  '<div class="panel"><h2>データ取得状態</h2>',
  '<dl class="kv">',
  '<dt>取得元</dt><dd id="hv-upstream">確認中…</dd>',
  '<dt>読込状態</dt><dd id="hv-load">未開始 (ボタンを押すまで通信しません)</dd>',
  '<dt>最終応答</dt><dd id="hv-resp">-</dd>',
  '<dt>結果</dt><dd id="hv-result">-</dd>',
  '</dl>',
  '<p style="margin-top:12px;"><button type="button" id="hv-load-btn" class="btn">データ読込を開始</button></p>',
  '<p class="note" style="margin-top:10px;">この画面を開いただけ・再表示しただけでは Cortex 素材の読込を開始しません。',
  '「データ読込を開始」を押すと、取得元(上記)から送信済みの素材を1回読み込みます。Cortex の取得そのものは開始しません。',
  '読込後、下の「HARVEST 確認」から各 Collector を手動で再確認してください。</p></div>',
  '<div id="dashboard-content"></div>',
  '</div>',
  '<script src="/harvest-core.js"></script>',
  '<script src="/harvest-collectors-cortex.js"></script>',
  '<script src="/ofk3-harvest-ui.js"></script>',
  '<script src="/harvest-shell.js"></script>',
  '</body></html>'
].join('\n');

// Shell script: ES5, no template literals. Loads ofk3-cortex-priority-ui.js ONLY on button press and
// records /cortex-priority responses for the status panel (observation only).
var SHELL_JS = [
  '(function () {',
  "  'use strict';",
  '  var cortexRequested = false;',
  '  function $(id) { return document.getElementById(id); }',
  '  function setText(id, text, cls) { var e = $(id); if (!e) return; e.textContent = text; e.className = cls || ""; }',
  '  function fmtTime(d) { try { return d.toLocaleTimeString("ja-JP"); } catch (e) { return String(d); } }',
  '  function describe(status, body) {',
  '    body = body && typeof body === "object" ? body : {};',
  '    if (status === 200 && body.status === "ok") return { text: "データあり: " + (body.localDate || "?") + " / package " + (Array.isArray(body.packages) ? body.packages.length : "?") + "件", cls: "ok" };',
  '    if (status === 404) {',
  '      if (body.harvestLocal === "upstream-not-configured") return { text: "取得元(上流)が未設定のためデータなし。HARVEST_UPSTREAM_BASE_URL を設定して再起動してください", cls: "warn" };',
  '      return { text: "取得元に該当データがありません (拡張からの送信が未実施の可能性)", cls: "warn" };',
  '    }',
  '    if (status === 504) return { text: "取得元が5秒以内に応答しませんでした (スリープ復帰中の可能性)。時間をおいて再読込してください", cls: "ng" };',
  '    if (status === 502) return { text: "取得元エラー: " + (body.message || "不明"), cls: "ng" };',
  '    if (status === 400 || status === 403 || status === 405) return { text: "リクエストが拒否されました: " + (body.message || status), cls: "ng" };',
  '    return { text: "想定外の応答 (HTTP " + status + ")", cls: "ng" };',
  '  }',
  '  // Observation only: records /cortex-priority responses; never issues requests itself.',
  '  var origFetch = window.fetch;',
  '  window.fetch = function (input) {',
  '    var url = typeof input === "string" ? input : (input && input.url) || "";',
  '    var p = origFetch.apply(this, arguments);',
  '    if (url.indexOf("/cortex-priority") === 0) {',
  '      p.then(function (r) {',
  '        var c = r.clone();',
  '        c.json().then(function (j) { show(r.status, j); }, function () { show(r.status, {}); });',
  '      }, function () {',
  '        setText("hv-load", "失敗", "ng");',
  '        setText("hv-result", "ローカルサーバーに接続できません", "ng");',
  '      });',
  '    }',
  '    return p;',
  '  };',
  '  function show(status, body) {',
  '    var d = describe(status, body);',
  '    setText("hv-load", status === 200 ? "読込済み" : "読込完了 (データなし/エラー)", status === 200 ? "ok" : "warn");',
  '    setText("hv-resp", fmtTime(new Date()) + " (HTTP " + status + ")");',
  '    setText("hv-result", d.text, d.cls);',
  '  }',
  '  function showUpstream() {',
  '    origFetch("/harvest-status.json", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {',
  '      if (s.upstreamError) setText("hv-upstream", "設定エラー: " + s.upstreamError + " (中継は無効)", "ng");',
  '      else if (s.upstreamOrigin) setText("hv-upstream", s.upstreamOrigin + " (GET中継・ボタン押下時のみ)", "ok");',
  '      else setText("hv-upstream", "未設定 (外部通信なし・データなし表示)", "warn");',
  '    }, function () { setText("hv-upstream", "ローカルサーバー状態を取得できません", "ng"); });',
  '  }',
  '  function startLoad() {',
  '    if (cortexRequested) return;',
  '    cortexRequested = true;',
  '    var btn = $("hv-load-btn"); if (btn) btn.disabled = true;',
  '    setText("hv-load", "読込中…", "warn");',
  '    var s = document.createElement("script");',
  '    s.src = "/ofk3-cortex-priority-ui.js";',
  '    s.onerror = function () { setText("hv-load", "失敗", "ng"); setText("hv-result", "読込スクリプトを取得できません", "ng"); };',
  '    document.body.appendChild(s);',
  '  }',
  '  var b = $("hv-load-btn"); if (b) b.addEventListener("click", startLoad);',
  '  showUpstream();',
  '})();',
  ''
].join('\n');

function refusalReason(env) {
  env = env || {};
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return 'NODE_ENV=production';
  var keys = Object.keys(env);
  for (var i = 0; i < keys.length; i++) {
    if (/^RENDER(_|$)/.test(keys[i]) && env[keys[i]]) return 'Render environment (' + keys[i] + ')';
  }
  return null;
}

function parsePort(value) {
  if (value === undefined || value === null || value === '') return { ok: true, port: DEFAULT_PORT };
  var s = String(value).trim();
  var n = Number(s);
  if (!/^\d+$/.test(s) || !isFinite(n) || n < 1024 || n > 65535) {
    return { ok: false, error: 'HARVEST_PORT must be an integer between 1024 and 65535' };
  }
  return { ok: true, port: n };
}

function isLoopbackHost(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

// Upstream = origin only (no path / query / credentials). https required unless loopback.
function parseUpstream(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, origin: null };
  var u;
  try { u = new URL(String(value).trim()); } catch (e) { return { ok: false, error: 'HARVEST_UPSTREAM_BASE_URL is not a valid URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'upstream must be http(s)' };
  if (u.username || u.password) return { ok: false, error: 'upstream must not contain credentials' };
  if (u.search || u.hash) return { ok: false, error: 'upstream must not contain query or fragment' };
  if (u.pathname !== '/' && u.pathname !== '') return { ok: false, error: 'upstream must be an origin only (no path)' };
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return { ok: false, error: 'http upstream is allowed for loopback only (use https)' };
  return { ok: true, origin: u.origin };
}

var SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store'
};
var PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
  + "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res, status, type, body, extra) {
  var headers = { 'Content-Type': type };
  Object.keys(SECURITY_HEADERS).forEach(function (k) { headers[k] = SECURITY_HEADERS[k]; });
  if (extra) Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
  res.writeHead(status, headers);
  res.end(body);
}
function sendJson(res, status, obj, extra) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extra);
}

function validQuery(searchParams) {
  var out = [];
  var ok = true;
  var message = '';
  searchParams.forEach(function (v, k) {
    if (k === 'localDate') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) out.push(['localDate', v]); else { ok = false; message = 'localDate must be YYYY-MM-DD'; }
    } else if (k === 'latest') {
      if (v === '1') out.push(['latest', '1']); else { ok = false; message = 'latest must be 1'; }
    } else {
      ok = false; message = 'query parameter not allowed: ' + k;
    }
  });
  return { ok: ok, message: message, pairs: out };
}

// opts: { port, env, fetchImpl }. Returns an http.Server (not listening yet).
function createServer(opts) {
  opts = opts || {};
  var env = opts.env || {};
  var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  var upstream = parseUpstream(env.HARVEST_UPSTREAM_BASE_URL);
  var server = http.createServer();

  function allowedHost(hostHeader) {
    var addr = server.address();
    var port = addr && addr.port ? addr.port : opts.port;
    return hostHeader === '127.0.0.1:' + port || hostHeader === 'localhost:' + port;
  }

  function relay(req, res, searchParams) {
    if (!upstream.ok) {
      return sendJson(res, 502, { status: 'error', message: 'upstream configuration invalid: ' + upstream.error });
    }
    if (!upstream.origin) {
      return sendJson(res, 404, { status: 'empty', packages: [], harvestLocal: 'upstream-not-configured', message: 'upstream not configured' });
    }
    var q = validQuery(searchParams);
    if (!q.ok) return sendJson(res, 400, { status: 'error', message: q.message });
    if (!fetchImpl) return sendJson(res, 502, { status: 'error', message: 'fetch is not available in this Node.js version' });
    var url = new URL('/cortex-priority', upstream.origin);
    q.pairs.forEach(function (p) { url.searchParams.set(p[0], p[1]); });
    var signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : undefined;
    // GET only; no cookies, no Authorization, no forwarded client headers; redirects are refused.
    fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', headers: { Accept: 'application/json', 'User-Agent': APP_ID }, signal: signal })
      .then(function (r) {
        if (r.status >= 300 && r.status < 400) {
          return sendJson(res, 502, { status: 'error', upstreamStatus: r.status, message: 'upstream redirect refused' });
        }
        var declared = Number(r.headers.get('content-length'));
        if (declared && declared > UPSTREAM_MAX_BYTES) {
          return sendJson(res, 502, { status: 'error', upstreamStatus: r.status, message: 'upstream response too large' });
        }
        return r.arrayBuffer().then(function (buf) {
          if (buf.byteLength > UPSTREAM_MAX_BYTES) {
            return sendJson(res, 502, { status: 'error', upstreamStatus: r.status, message: 'upstream response too large' });
          }
          var json;
          try { json = JSON.parse(Buffer.from(buf).toString('utf8')); } catch (e) {
            return sendJson(res, 502, { status: 'error', upstreamStatus: r.status, message: 'upstream returned non-JSON (HTTP ' + r.status + ')' });
          }
          if (r.status === 200 || r.status === 404) {
            return sendJson(res, r.status, json, { 'X-Harvest-Upstream': upstream.origin });
          }
          return sendJson(res, 502, { status: 'error', upstreamStatus: r.status, message: 'upstream error (HTTP ' + r.status + ')' });
        });
      })
      .catch(function (e) {
        var timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        if (timedOut) return sendJson(res, 504, { status: 'error', message: 'upstream timeout (' + UPSTREAM_TIMEOUT_MS + ' ms)' });
        sendJson(res, 502, { status: 'error', message: 'upstream unreachable' });
      });
  }

  server.on('request', function (req, res) {
    try {
      if (!allowedHost(String(req.headers.host || ''))) {
        return sendJson(res, 403, { status: 'error', message: 'host not allowed' });
      }
      var site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') {
        return sendJson(res, 403, { status: 'error', message: 'cross-site request refused' });
      }
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) {
        return sendJson(res, 403, { status: 'error', message: 'cross-origin request refused' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { status: 'error', message: 'method not allowed' }, { Allow: 'GET, HEAD' });
      }
      var u = new URL(req.url, 'http://127.0.0.1');
      var p = u.pathname;
      var head = req.method === 'HEAD';

      if (p === '/') { res.writeHead(302, { Location: '/harvest' }); return res.end(); }
      if (p === '/harvest') {
        return send(res, 200, 'text/html; charset=utf-8', head ? '' : SHELL_HTML, { 'Content-Security-Policy': PAGE_CSP });
      }
      if (p === '/harvest-shell.js') return send(res, 200, 'application/javascript; charset=utf-8', head ? '' : SHELL_JS);
      if (p === '/harvest.webmanifest') return send(res, 200, 'application/manifest+json; charset=utf-8', head ? '' : JSON.stringify(MANIFEST));
      if (p === '/harvest-status.json') {
        return sendJson(res, 200, {
          app: APP_ID,
          upstreamOrigin: upstream.ok ? upstream.origin : null,
          upstreamError: upstream.ok ? null : upstream.error
        });
      }
      if (p === '/cortex-priority') {
        if (head) return sendJson(res, 405, { status: 'error', message: 'method not allowed' }, { Allow: 'GET' });
        return relay(req, res, u.searchParams);
      }
      if (Object.prototype.hasOwnProperty.call(FILES, p)) {
        var f = FILES[p];
        return fs.readFile(path.join(ROOT, f.file), function (err, data) {
          if (err) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
          send(res, 200, f.type, head ? '' : data);
        });
      }
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (e) {
      send(res, 500, 'text/plain; charset=utf-8', 'internal error');
    }
  });
  server.harvestUpstream = upstream;
  return server;
}

function main() {
  var reason = refusalReason(process.env);
  if (reason) {
    console.error('HARVEST local server refuses to start: ' + reason + '. This server is local-only.');
    process.exit(1);
  }
  var port = parsePort(process.env.HARVEST_PORT);
  if (!port.ok) {
    console.error('HARVEST local server: ' + port.error);
    process.exit(1);
  }
  var server = createServer({ port: port.port, env: process.env });
  server.on('error', function (e) {
    if (e && e.code === 'EADDRINUSE') console.error('HARVEST local server: port ' + port.port + ' is already in use. Not starting.');
    else console.error('HARVEST local server error: ' + (e && e.message));
    process.exit(1);
  });
  server.listen(port.port, BIND_HOST, function () {
    console.log('HARVEST local server: http://' + BIND_HOST + ':' + port.port + '/harvest (local only)');
    var up = server.harvestUpstream;
    if (!up.ok) console.log('upstream: INVALID (' + up.error + ') - relay disabled');
    else console.log('upstream: ' + (up.origin ? up.origin + ' (GET relay, on user action only)' : 'not configured (no outbound communication)'));
  });
}

if (require.main === module) main();

module.exports = {
  createServer: createServer,
  refusalReason: refusalReason,
  parsePort: parsePort,
  parseUpstream: parseUpstream,
  FILES: FILES,
  MANIFEST: MANIFEST,
  SHELL_HTML: SHELL_HTML,
  SHELL_JS: SHELL_JS,
  BIND_HOST: BIND_HOST,
  UPSTREAM_TIMEOUT_MS: UPSTREAM_TIMEOUT_MS
};
