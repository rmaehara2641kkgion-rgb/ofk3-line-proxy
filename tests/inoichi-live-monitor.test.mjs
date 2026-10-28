import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const M = require('../inoichi-live-monitor.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var passed = 0, failed = 0;
function eq(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('FAIL - ' + name + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}
function ok(name, c) { eq(name, !!c, true); }

var NOW = Date.parse('2026-10-28T03:00:00.000Z');
var FRESH = '2026-10-28T02:59:00.000Z';

function feed(over) {
  return {
    ok: true, ok_: 1,
    payload: Object.assign({
      ok: true, app: 'harvest-rolling60h', connected: true, fetchStatus: 'success', stale: false,
      checkedAt: FRESH, safe: true, referenceDate: '2026-10-28', actualThrough: '2026-10-27', alerts: []
    }, over || {}),
    fetchedAt: FRESH, source: 'test'
  };
}
function alert(cat, name, extra) {
  return Object.assign({ category: cat, driver: name, transportId: 'T1', scope: 'today', period: '2026-10-22 〜 2026-10-28', reason: 'r' }, extra || {});
}
function roll(f) { return M.judgeRolling60h(f, NOW); }

// --- Rolling60h judgement (reuses OFK3 result; no recomputation) ---
eq('(1) fetch failure -> failed, not ok', roll({ ok: false, error: 'ECONNREFUSED' }).status, 'failed');
eq('(1b) failed shows no metrics', roll({ ok: false, error: 'x' }).metrics, []);
eq('(2) wrong app payload -> failed', roll({ ok: true, payload: { app: 'other', alerts: [] } }).status, 'failed');
eq('(3) OFK3 unavailable payload -> undetermined', roll(feed({ ok: false, connected: false, stale: true, alerts: [{ category: 'insufficient' }] })).status, 'undetermined');
eq('(3b) update-stopped -> stale', roll(feed({ ok: false, connected: false, gap: 'update-stopped', stale: true })).status, 'stale');
eq('(4) clean safe feed -> ok', roll(feed()).status, 'ok');
var w = roll(feed({ safe: false, alerts: [alert('forecast_exceed', 'A', { forecastHours: 61.5 }), alert('approach', 'B', { forecastHours: 59 }), alert('insufficient', 'C')] }));
eq('(5) exceed/approach -> warn', w.status, 'warn');
eq('(5b) counts', w.metrics.map(function (m) { return m.value; }), [1, 1, 1]);
eq('(5c) undetermined rows are kept (not dropped)', w.rows.filter(function (r) { return r.category === 'insufficient'; }).length, 1);
eq('(5d) forecast hours passed through unchanged', w.rows[0].forecastHours, 61.5);
var u = roll(feed({ safe: false, alerts: [alert('duty_unconfirmed', 'D')] }));
eq('(6) only undetermined -> undetermined, never ok', u.status, 'undetermined');
eq('(7) safe!==true without alerts -> undetermined', roll(feed({ safe: false })).status, 'undetermined');
eq('(8) payload.stale -> stale', roll(feed({ stale: true })).status, 'stale');
eq('(9) old checkedAt -> stale', roll(feed({ checkedAt: '2026-10-28T02:00:00.000Z' })).status, 'stale');
eq('(9b) missing checkedAt -> stale', roll(feed({ checkedAt: null })).status, 'stale');
eq('(10) judged time and source date are kept separate', [w.judgedAt, w.sourceUpdatedAt], [FRESH, '2026-10-27']);

// --- Whole state ---
var st = M.buildMonitorState({ fetches: { rolling60h: feed() }, now: NOW });
eq('(11) six cards', st.cards.map(function (c) { return c.id; }), ['important', 'mentor', 'rolling60h', 'today', 'errors', 'engine']);
eq('(12) mentor is unsupported (never 0 / normal)', st.cards[1].status, 'unsupported');
eq('(13) today is unsupported', st.cards[3].status, 'unsupported');
eq('(14) engine is unsupported (never ran)', st.engine.status, 'unsupported');
eq('(15) important is NOT ok while mentor unjudged', st.cards[0].status, 'undetermined');
eq('(15b) important count covers judged sources only (labelled)', [st.cards[0].metrics[0].value, /判定できた監視のみ/.test(st.cards[0].metrics[0].label)], [0, true]);
var st2 = M.buildMonitorState({ fetches: { rolling60h: feed({ safe: false, alerts: [alert('forecast_exceed', 'A', { forecastHours: 62 })] }) }, now: NOW });
eq('(16) important aggregates warnings', [st2.cards[0].status, st2.cards[0].rows.length], ['warn', 1]);
var st3 = M.buildMonitorState({ fetches: { rolling60h: { ok: false, error: 'timeout', fetchedAt: FRESH } }, now: NOW });
eq('(17) fetch failure surfaces in errors card + link', [st3.cards[4].status, st3.link.status], ['failed', 'failed']);
eq('(17b) important has null count on failure (not 0)', st3.cards[0].metrics[0].value, null);
var sample = JSON.stringify(st);
ok('(18) no sample/Prototype text in live state', sample.indexOf('Prototype') === -1 && sample.indexOf('サンプル') === -1);

// --- Server /api/monitor with a mock OFK3 (test only) ---
function listen(srv) { return new Promise(function (r) { srv.listen(0, '127.0.0.1', function () { r(srv.address().port); }); }); }
function get(port, p) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
      var b = []; res.on('data', function (c) { b.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, body: Buffer.concat(b).toString('utf8') }); });
    }).on('error', reject);
  });
}
function startIno(env) {
  return new Promise(function (resolve, reject) {
    var cp = spawn(process.execPath, [path.join(ROOT, 'inoichi-server.js')], { env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1' }, env) });
    var out = '';
    cp.stdout.on('data', function (d) {
      out += d;
      var m = out.match(/127\.0\.0\.1:(\d+)/);
      if (m) resolve({ cp: cp, port: Number(m[1]) });
    });
    cp.on('error', reject);
    setTimeout(function () { reject(new Error('server start timeout')); }, 8000);
  });
}

var mockMode = 'exceed';
var mockHits = 0;
var mock = http.createServer(function (req, res) {
  mockHits++;
  if (req.method !== 'GET' || req.url !== '/harvest/rolling60h/alerts') { res.writeHead(404); return res.end(); }
  if (mockMode === 'down') { res.writeHead(503); return res.end('x'); }
  var body = feed(mockMode === 'exceed'
    ? { checkedAt: new Date().toISOString(), safe: false, alerts: [alert('forecast_exceed', 'テスト対象', { forecastHours: 63 })] }
    : { checkedAt: new Date().toISOString() }).payload;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});
var mockPort = await listen(mock);

var ino = await startIno({ OFK3_BASE_URL: 'http://127.0.0.1:' + mockPort });
try {
  var r1 = await get(ino.port, '/api/monitor');
  var s1 = JSON.parse(r1.body);
  eq('(19) /api/monitor 200', r1.status, 200);
  eq('(19b) real feed reflected: warn + driver', [s1.cards[2].status, s1.cards[2].rows[0].driver, s1.cards[2].rows[0].forecastHours], ['warn', 'テスト対象', 63]);
  var hits = mockHits;
  await get(ino.port, '/api/monitor');
  eq('(20) repeated requests are cached (OFK3 not hammered)', mockHits, hits);
  var page = await get(ino.port, '/');
  ok('(21) page title is INO-1 only', page.body.indexOf('<title>INO-1</title>') !== -1 && !/prototype|プロトタイプ/i.test(page.body));
  var mf = await get(ino.port, '/inoichi.webmanifest');
  ok('(22) manifest name INO-1', JSON.parse(mf.body).name === 'INO-1');
  var post = await new Promise(function (resolve) {
    var rq = http.request({ host: '127.0.0.1', port: ino.port, path: '/api/monitor', method: 'POST' }, function (res) { resolve(res.statusCode); });
    rq.end();
  });
  eq('(23) POST still 405', post, 405);
} finally { ino.cp.kill(); }

var ino2 = await startIno({ OFK3_BASE_URL: 'http://127.0.0.1:' + mockPort });
mockMode = 'down';
try {
  var s2 = JSON.parse((await get(ino2.port, '/api/monitor')).body);
  eq('(24) OFK3 error -> failed, not ok', [s2.cards[2].status, s2.link.status], ['failed', 'failed']);
} finally { ino2.cp.kill(); }

mock.close();
var ino3 = await startIno({ OFK3_BASE_URL: 'http://127.0.0.1:' + mockPort });
try {
  var s3 = JSON.parse((await get(ino3.port, '/api/monitor')).body);
  eq('(25) OFK3 unreachable -> failed', s3.cards[2].status, 'failed');
} finally { ino3.cp.kill(); }

var ino4 = await startIno({ OFK3_BASE_URL: 'http://example.com' });
try {
  var s4 = JSON.parse((await get(ino4.port, '/api/monitor')).body);
  eq('(26) non-loopback http upstream refused -> failed', s4.cards[2].status, 'failed');
} finally { ino4.cp.kill(); }

// --- Name / icon ---
var files = ['inoichi-dashboard.html', 'inoichi-dashboard.js', 'inoichi-server.js', 'inoichi.webmanifest', 'inoichi-launch.ps1', 'inoichi-stop.ps1', 'inoichi-install-shortcut.ps1'];
files.forEach(function (f) {
  var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  var hit = src.split('\n').filter(function (l) { return /prototype|プロトタイプ/i.test(l) && l.indexOf('inoichi-prototype1-step8') === -1; });
  eq('(27) no Prototype wording in ' + f, hit, []);
});
function icoSizes(p) {
  var b = fs.readFileSync(p);
  var n = b.readUInt16LE(4), out = [];
  for (var i = 0; i < n; i++) { var w = b[6 + i * 16] || 256; out.push(w); }
  return out;
}
['assets/inoichi.ico', 'assets/inoichi-taskbar.ico'].forEach(function (p) {
  eq('(28) ICO sizes ' + p, icoSizes(path.join(ROOT, p)), [16, 24, 32, 48, 64, 128, 256]);
});
function pngCorner(p) {
  var b = fs.readFileSync(path.join(ROOT, p));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
eq('(29) icon source is square', pngCorner('assets/inoichi-taskbar-source.png')[0], pngCorner('assets/inoichi-taskbar-source.png')[1]);

console.log('inoichi-live-monitor tests ' + (failed ? 'failed' : 'passed') + ' (' + passed + ' ok, ' + failed + ' failed)');
process.exit(failed ? 1 : 0);
