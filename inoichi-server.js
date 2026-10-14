'use strict';

/**
 * INO-1 Prototype 1 localhost HTTP server.
 *
 * Serves the INO-1 Dashboard from 127.0.0.1 only, using Node.js standard
 * modules. No real data connections, no real notifications, no external APIs.
 *
 * Usage:
 *   node inoichi-server.js
 *
 * The server binds to 127.0.0.1:8765 by default. The port can be overridden
 * with the PORT environment variable:
 *   set PORT=9000 && node inoichi-server.js
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');

var HOST = process.env.HOST || '127.0.0.1';
var PORT = parseInt(process.env.PORT || '8765', 10);

var ROOT = path.resolve(__dirname);

var ALLOWED_FILES = {
  '/inoichi-dashboard.html': true,
  '/inoichi-dashboard.css': true,
  '/inoichi-dashboard.js': true,
  '/inoichi-detection-core.js': true,
  '/inoichi-detection-rules.js': true,
  '/inoichi-fleet-adapter.js': true,
  '/inoichi-alert-store.js': true,
  '/inoichi-notification-adapter.js': true
};

var DASHBOARD_ALIASES = {
  '/': '/inoichi-dashboard.html'
};

var CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
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

module.exports = { server: server, HOST: HOST, PORT: PORT };
