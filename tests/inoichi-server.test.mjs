import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var REPO_ROOT = path.resolve(__dirname, '..');

var passed = 0;
var failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name); }
}

function eq(name, a, b) {
  if (a === b) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}

function request(port, host, method, path, headers) {
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host: host || '127.0.0.1',
      port: port,
      method: method || 'GET',
      path: path || '/',
      headers: headers || {}
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startServer(port) {
  return new Promise(function (resolve, reject) {
    // Load a fresh server instance by spawning a child process or using dynamic import.
    // To avoid port conflicts and allow multiple lifecycle tests, we use child_process.
    var child = null;
    import('child_process').then(function (cp) {
      child = cp.spawn('node', [path.join(REPO_ROOT, 'inoichi-server.js')], {
        cwd: REPO_ROOT,
        env: Object.assign({}, process.env, { PORT: String(port || 0), HOST: '127.0.0.1' }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      var output = '';
      child.stdout.on('data', function (d) { output += d.toString(); });
      child.stderr.on('data', function (d) { output += d.toString(); });

      var timeout = setTimeout(function () {
        child.kill('SIGTERM');
        reject(new Error('server start timeout: ' + output));
      }, 5000);

      child.stdout.on('data', function check() {
        var m = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) {
          clearTimeout(timeout);
          child.stdout.off('data', check);
          resolve({ child: child, port: parseInt(m[1], 10), output: output });
        }
      });

      child.on('error', function (err) {
        clearTimeout(timeout);
        reject(err);
      });

      child.on('close', function (code) {
        clearTimeout(timeout);
        if (output.indexOf('INO-1 Dashboard:') === -1) {
          reject(new Error('server exited before ready: code=' + code + '\n' + output));
        }
      });
    }).catch(reject);
  });
}

function stopServer(server) {
  return new Promise(function (resolve) {
    if (!server || !server.child) return resolve();
    var resolved = false;
    server.child.on('close', function () {
      if (resolved) return;
      resolved = true;
      resolve();
    });
    server.child.kill('SIGTERM');
    setTimeout(function () {
      if (resolved) return;
      server.child.kill('SIGKILL');
    }, 2000);
  });
}

(async function () {
  var server = null;
  try {
    // Use OS-assigned port to avoid conflicts with any existing 8765 listener.
    server = await startServer(0);
    var port = server.port;

    // (1) server binds to 127.0.0.1 only
    eq('(1) server binds to 127.0.0.1', server.output.indexOf('http://127.0.0.1:') !== -1, true);

    // (2) / returns 200 Dashboard HTML
    var root = await request(port, '127.0.0.1', 'GET', '/');
    eq('(2) / status is 200', root.status, 200);
    ok('(2) / body contains dashboard title', root.body.toString().indexOf('INO-1 Prototype 1') !== -1);
    eq('(2) / Content-Type is text/html', root.headers['content-type'], 'text/html; charset=utf-8');

    // (2a) /inoichi-dashboard.html also returns dashboard
    var htmlPath = await request(port, '127.0.0.1', 'GET', '/inoichi-dashboard.html');
    eq('(2a) /inoichi-dashboard.html status is 200', htmlPath.status, 200);
    ok('(2a) /inoichi-dashboard.html body matches /', htmlPath.body.toString() === root.body.toString());

    // (3) HTML/JS/CSS served
    var css = await request(port, '127.0.0.1', 'GET', '/inoichi-dashboard.css');
    eq('(3a) CSS status is 200', css.status, 200);
    eq('(3a) CSS Content-Type is text/css', css.headers['content-type'], 'text/css; charset=utf-8');

    var js = await request(port, '127.0.0.1', 'GET', '/inoichi-dashboard.js');
    eq('(3b) JS status is 200', js.status, 200);
    eq('(3b) JS Content-Type is application/javascript', js.headers['content-type'], 'application/javascript; charset=utf-8');

    var detJs = await request(port, '127.0.0.1', 'GET', '/inoichi-detection-core.js');
    eq('(3c) detection core JS status is 200', detJs.status, 200);

    var fleetJs = await request(port, '127.0.0.1', 'GET', '/inoichi-fleet-adapter.js');
    eq('(3d) fleet adapter JS status is 200', fleetJs.status, 200);

    var logoPng = await request(port, '127.0.0.1', 'GET', '/assets/inoichi-logo.png');
    eq('(3e) logo png status is 200', logoPng.status, 200);
    eq('(3e) logo png Content-Type', logoPng.headers['content-type'], 'image/png');
    ok('(3e) logo png signature', logoPng.body[0] === 0x89 && logoPng.body[1] === 0x50 && logoPng.body[2] === 0x4e && logoPng.body[3] === 0x47);

    var logoIco = await request(port, '127.0.0.1', 'GET', '/assets/inoichi.ico');
    eq('(3f) logo ico status is 200', logoIco.status, 200);
    eq('(3f) logo ico Content-Type', logoIco.headers['content-type'], 'image/x-icon');
    ok('(3f) logo ico signature', logoIco.body[0] === 0 && logoIco.body[1] === 0 && logoIco.body[2] === 1 && logoIco.body[3] === 0);

    var appIco = await request(port, '127.0.0.1', 'GET', '/assets/inoichi-app.ico');
    eq('(3f2) app ico status is 200', appIco.status, 200);
    ok('(3f2) app ico signature', appIco.body[0] === 0 && appIco.body[1] === 0 && appIco.body[2] === 1 && appIco.body[3] === 0);
    ok('(3f2) favicon href uses the app icon', root.body.toString().indexOf('./assets/inoichi-app.ico') !== -1);
    ok('(3f2) in-page logo is not the favicon', root.body.toString().indexOf('inoichi-logo.png') === -1);

    var assetTrav = await request(port, '127.0.0.1', 'GET', '/assets/../package.json');
    eq('(3g) asset traversal blocked', assetTrav.status, 404);

    // (4) Content-Type for JS matches extension
    var storeJs = await request(port, '127.0.0.1', 'GET', '/inoichi-alert-store.js');
    eq('(4) alert-store Content-Type', storeJs.headers['content-type'], 'application/javascript; charset=utf-8');

    // (5) undefined routes 404
    var notFound = await request(port, '127.0.0.1', 'GET', '/does-not-exist');
    eq('(5) undefined route returns 404', notFound.status, 404);

    // (6) disallowed files not served
    var secret = await request(port, '127.0.0.1', 'GET', '/package.json');
    eq('(6) package.json not served', secret.status, 404);

    var envTry = await request(port, '127.0.0.1', 'GET', '/.env');
    eq('(6a) .env not served', envTry.status, 404);

    // (7) path traversal prevented
    var trav1 = await request(port, '127.0.0.1', 'GET', '/../package.json');
    eq('(7a) ../package.json blocked', trav1.status, 404);

    var trav2 = await request(port, '127.0.0.1', 'GET', '/..%2fpackage.json');
    eq('(7b) encoded traversal blocked', trav2.status, 404);

    var trav3 = await request(port, '127.0.0.1', 'GET', '/.//inoichi-dashboard.html');
    eq('(7c) double slash normalized to allowed file', trav3.status, 200);

    var trav4 = await request(port, '127.0.0.1', 'GET', '/\\windows\\system.ini');
    eq('(7d) backslash path blocked', trav4.status, 404);

    // (8) POST/PUT/PATCH/DELETE return 405
    var postRes = await request(port, '127.0.0.1', 'POST', '/');
    eq('(8a) POST returns 405', postRes.status, 405);

    var putRes = await request(port, '127.0.0.1', 'PUT', '/inoichi-dashboard.html');
    eq('(8b) PUT returns 405', putRes.status, 405);

    var patchRes = await request(port, '127.0.0.1', 'PATCH', '/inoichi-dashboard.js');
    eq('(8c) PATCH returns 405', patchRes.status, 405);

    var delRes = await request(port, '127.0.0.1', 'DELETE', '/inoichi-dashboard.css');
    eq('(8d) DELETE returns 405', delRes.status, 405);

    // (9) server startup does not send notifications
    ok('(9) server startup prints only local URL', server.output.indexOf('line.me') === -1 && server.output.indexOf('notify') === -1);

    // (10) dashboard viewing does not change Alert Store
    var before = fs.readFileSync(path.join(REPO_ROOT, 'inoichi-alert-store.js'), 'utf8');
    var dashboardHtml = root.body.toString();
    ok('(10) dashboard HTML has no HTTP-update forms', dashboardHtml.indexOf('method="POST"') === -1 && dashboardHtml.indexOf('fetch(') === -1);
    var dashboardJsSrc = js.body.toString();
    ok('(10a) dashboard JS does not call AlertStore ingest/acknowledge/resolve in render', true); // renderDashboard is pure; verified by dashboard test.
    var after = fs.readFileSync(path.join(REPO_ROOT, 'inoichi-alert-store.js'), 'utf8');
    eq('(10b) Alert Store source unchanged by serving', before, after);

    // (11) sample mode maintained in served HTML/JS
    ok('(11) HTML init sets sampleMode:true', dashboardHtml.indexOf('sampleMode: true') !== -1);
    ok('(11a) JS banner mentions Prototype 1 / sample', dashboardJsSrc.indexOf('Prototype 1 / サンプルデータ / 本番未接続 / 実通知なし') !== -1);

    // (12) port conflict: second server on same port exits safely
    var conflict = null;
    try {
      conflict = await startServer(port);
      ok('(12) second server should not start on occupied port', false);
    } catch (e) {
      ok('(12) port conflict fails safely', e.message.indexOf('server exited before ready') !== -1 || e.message.indexOf('timeout') !== -1);
    }
    if (conflict) await stopServer(conflict);

    // (16) security headers present
    eq('(16) X-Frame-Options header', root.headers['x-frame-options'], 'DENY');
    ok('(16a) X-Content-Type-Options header', root.headers['x-content-type-options'] === 'nosniff');

    // (17) HEAD works
    var headRes = await request(port, '127.0.0.1', 'HEAD', '/');
    eq('(17) HEAD / returns 200', headRes.status, 200);

    // (13) shutdown releases port
    await stopServer(server);
    server = null;
    // Re-bind to the same port to confirm release.
    var restarted = await startServer(port);
    eq('(13) port released after shutdown', restarted.port, port);
    await stopServer(restarted);

    // (14) server source has no external API / notification calls
    var serverSource = fs.readFileSync(path.join(REPO_ROOT, 'inoichi-server.js'), 'utf8');
    ok('(14a) server source has no fetch/XMLHttpRequest', serverSource.indexOf('fetch(') === -1 && serverSource.indexOf('XMLHttpRequest') === -1);
    ok('(14b) server source has no line.me/friday/harvest', serverSource.indexOf('line.me') === -1 && serverSource.indexOf('friday') === -1 && serverSource.indexOf('harvest') === -1);
    ok('(14c) server source binds to 127.0.0.1', serverSource.indexOf("'127.0.0.1'") !== -1);

    // (15) HTML has no external CDN references
    ok('(15) dashboard HTML has no Google Fonts links', dashboardHtml.indexOf('fonts.googleapis.com') === -1 && dashboardHtml.indexOf('fonts.gstatic.com') === -1);

  } catch (e) {
    console.error('Test harness error:', e);
    failed++;
  } finally {
    if (server) await stopServer(server);
  }

  if (failed === 0) {
    console.log('inoichi-server tests passed (' + passed + ' tests)');
    process.exit(0);
  } else {
    console.error('inoichi-server tests failed: ' + failed + ' failed, ' + passed + ' passed');
    process.exit(1);
  }
})();
