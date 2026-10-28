'use strict';

/**
 * INO-1 localhost HTTP server.
 *
 * Serves the INO-1 Dashboard from 127.0.0.1 only, using Node.js standard
 * modules, and exposes GET /api/monitor which reads the OFK3 Rolling60h
 * result (GET /harvest/rolling60h/alerts) read-only. No writes to OFK3, no
 * real notifications.
 *
 * Usage:
 *   node inoichi-server.js
 *
 * The server binds to 127.0.0.1:8765 by default. The port can be overridden
 * with the PORT environment variable:
 *   set PORT=9000 && node inoichi-server.js
 *
 * OFK3_BASE_URL (origin only, default http://127.0.0.1:3000): where the OFK3
 * server runs. http is accepted for loopback only, https otherwise.
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');
var https = require('https');
var LiveMonitor = require('./inoichi-live-monitor.js');

var HOST = process.env.HOST || '127.0.0.1';
var PORT = parseInt(process.env.PORT || '8765', 10);

var ROOT = path.resolve(__dirname);

var OFK3_FEED_PATH = '/harvest/rolling60h/alerts';
var UPSTREAM_TIMEOUT_MS = 8000;
var UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;
// Short cache so auto-refresh and the refresh button never hammer OFK3.
var MONITOR_CACHE_MS = 5000;

var ALLOWED_FILES = {
  '/inoichi-live-monitor.js': true,
  '/inoichi.webmanifest': true,
  '/assets/inoichi-icon-256.png': true,
  '/assets/inoichi-taskbar-192.png': true,
  '/assets/inoichi-taskbar-512.png': true,
  '/inoichi-dashboard.html': true,
  '/inoichi-dashboard.css': true,
  '/inoichi-dashboard.js': true,
  '/inoichi-detection-core.js': true,
  '/inoichi-detection-rules.js': true,
  '/inoichi-fleet-adapter.js': true,
  '/inoichi-alert-store.js': true,
  '/inoichi-notification-adapter.js': true,
  '/assets/inoichi-logo.png': true,
  '/assets/inoichi.ico': true,
  '/assets/inoichi-logo-light.webp': true,
  '/assets/inoichi-castle-bg.webp': true
};

var DASHBOARD_ALIASES = {
  '/': '/inoichi-dashboard.html'
};

var CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

var DISALLOWED_METHODS = { POST: true, PUT: true, PATCH: true, DELETE: true };

var SERVER_TOKEN = 'inoichi-prototype1-step8';

function contentTypeFor(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function isSafePath(pathname) {
  if (typeof pathname !== 'string') return false;
  if (pathname.length === 0 || pathname.length > 4096) return false;
  // Reject null bytes and control characters.
  if (/[\x00-\x1f]/.test(pathname)) return false;
  // Reject backslashes, which could be interpreted as Windows path separators.
  if (pathname.indexOf('\\') !== -1) return false;
  // Reject any traversal attempt.
  if (pathname.indexOf('..') !== -1) return false;
  // Require normalized, relative-looking path that starts with '/'.
  if (!pathname.startsWith('/')) return false;
  return true;
}

function normalizeUrlPath(pathname) {
  // Normalize redundant slashes and '.' segments while preserving the leading '/'.
  return path.posix.normalize(pathname);
}

function send(res, statusCode, body, contentType, extraHeaders) {
  var headers = {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  };
  if (extraHeaders) {
    var keys = Object.keys(extraHeaders);
    for (var i = 0; i < keys.length; i++) {
      headers[keys[i]] = extraHeaders[keys[i]];
    }
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

function parseUpstreamOrigin(value) {
  var raw = (value === undefined || value === null || String(value).trim() === '') ? 'http://127.0.0.1:3000' : String(value).trim();
  var u;
  try { u = new URL(raw); } catch (e) { return { ok: false, error: 'OFK3_BASE_URL is not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'OFK3_BASE_URL must be http(s)' };
  if (u.username || u.password) return { ok: false, error: 'OFK3_BASE_URL must not contain credentials' };
  if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return { ok: false, error: 'OFK3_BASE_URL must be an origin only' };
  var loop = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
  if (u.protocol === 'http:' && !loop) return { ok: false, error: 'http is allowed for loopback only' };
  return { ok: true, origin: u.origin };
}

// GET only. Resolves { ok, payload, error, fetchedAt, source } - never throws.
function fetchOfk3Feed(origin) {
  return new Promise(function (resolve) {
    var fetchedAt = new Date().toISOString();
    var source = origin + OFK3_FEED_PATH;
    var done = false;
    function finish(r) {
      if (done) return;
      done = true;
      r.fetchedAt = fetchedAt;
      r.source = source;
      resolve(r);
    }
    var lib = origin.indexOf('https:') === 0 ? https : http;
    var req;
    try {
      req = lib.get(source, { headers: { Accept: 'application/json' }, timeout: UPSTREAM_TIMEOUT_MS }, function (up) {
        if (up.statusCode !== 200) {
          up.resume();
          return finish({ ok: false, error: 'HTTP ' + up.statusCode });
        }
        var chunks = [];
        var size = 0;
        up.on('data', function (c) {
          size += c.length;
          if (size > UPSTREAM_MAX_BYTES) {
            up.destroy();
            return finish({ ok: false, error: 'response too large' });
          }
          chunks.push(c);
        });
        up.on('error', function () { finish({ ok: false, error: 'connection error' }); });
        up.on('end', function () {
          try {
            finish({ ok: true, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (e) {
            finish({ ok: false, error: 'invalid JSON' });
          }
        });
      });
    } catch (e) {
      return finish({ ok: false, error: 'request failed' });
    }
    req.on('timeout', function () { req.destroy(); finish({ ok: false, error: 'timeout' }); });
    req.on('error', function (err) { finish({ ok: false, error: (err && err.code) || 'connection error' }); });
  });
}

var monitorCache = { at: 0, body: null };

function buildMonitor(origin) {
  return fetchOfk3Feed(origin).then(function (feed) {
    return LiveMonitor.buildMonitorState({ fetches: { rolling60h: feed }, now: Date.now() });
  });
}

function handleMonitor(req, res) {
  var upstream = parseUpstreamOrigin(process.env.OFK3_BASE_URL);
  if (!upstream.ok) {
    var failed = LiveMonitor.buildMonitorState({
      fetches: { rolling60h: { ok: false, error: upstream.error, fetchedAt: new Date().toISOString(), source: 'OFK3_BASE_URL' } },
      now: Date.now()
    });
    return send(res, 200, JSON.stringify(failed), 'application/json; charset=utf-8');
  }
  var nowMs = Date.now();
  if (monitorCache.body && nowMs - monitorCache.at < MONITOR_CACHE_MS) {
    return send(res, 200, req.method === 'HEAD' ? '' : monitorCache.body, 'application/json; charset=utf-8');
  }
  buildMonitor(upstream.origin).then(function (state) {
    monitorCache = { at: Date.now(), body: JSON.stringify(state) };
    send(res, 200, req.method === 'HEAD' ? '' : monitorCache.body, 'application/json; charset=utf-8');
  }).catch(function () {
    send(res, 500, 'Internal server error');
  });
}

function handleRequest(req, res) {
  if (DISALLOWED_METHODS[req.method]) {
    return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', {
      'Allow': 'GET, HEAD'
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', {
      'Allow': 'GET, HEAD'
    });
  }

  var parsed = url.parse(req.url || '/');
  var pathname = normalizeUrlPath(parsed.pathname);

  if (!isSafePath(pathname)) {
    return send(res, 404, 'Not found');
  }

  if (pathname === '/api/monitor') return handleMonitor(req, res);

  var targetPath = DASHBOARD_ALIASES[pathname] || pathname;

  if (!ALLOWED_FILES[targetPath]) {
    return send(res, 404, 'Not found');
  }

  var filePath = path.join(ROOT, targetPath);
  var resolved = path.resolve(filePath);
  var resolvedRoot = path.resolve(ROOT);

  // Final safety check: resolved path must be inside the repository root.
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return send(res, 404, 'Not found');
  }

  fs.readFile(resolved, function (err, data) {
    if (err) {
      if (err.code === 'ENOENT') {
        return send(res, 404, 'Not found');
      }
      return send(res, 500, 'Internal server error');
    }

    var contentType = contentTypeFor(resolved);
    var cacheControl = 'public, max-age=0, must-revalidate';
    if (targetPath === '/inoichi-dashboard.html' || targetPath === '/inoichi-dashboard.js') {
      cacheControl = 'no-store';
    }

    send(res, 200, data, contentType, {
      'Cache-Control': cacheControl,
      'Content-Length': Buffer.byteLength(data),
      'X-INOICHI-Server': SERVER_TOKEN
    });
  });
}

var server = http.createServer(handleRequest);

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('ERROR: Port ' + PORT + ' is already in use.');
    console.error('Please stop the existing process or choose a different port:');
    console.error('  set PORT=9000 && node inoichi-server.js');
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error('ERROR: Permission denied to bind to ' + HOST + ':' + PORT);
    process.exit(1);
  }
  console.error('ERROR: Server failed to start:', err.message || err);
  process.exit(1);
});

server.listen(PORT, HOST, function () {
  var actualPort = server.address().port;
  console.log('INO-1 Dashboard: http://' + HOST + ':' + actualPort + '/');
});

function shutdown() {
  server.close(function () {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server: server, HOST: HOST, PORT: PORT, parseUpstreamOrigin: parseUpstreamOrigin };
