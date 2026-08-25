import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipDirs = new Set(['node_modules', '.git']);
const skipFiles = new Set(['security.test.mjs', 'package-lock.json']);

const forbidden = [
  /Amazon/i,
  /OFK3/i,
  /\bGDS\b/,
  /\bJHS\b/,
  /OFK6/,
  /TransportID/i,
  /Mentor/,
  /FTDS/,
  /\bDNR\b/,
  /\bLAT\b/,
  /\bDSP\b/,
  /amazonaws/i,
  /script\.google/,
  /LINE_CHANNEL/,
  /CHANNEL_SECRET/,
  /ACCESS_TOKEN/,
  /API_KEY/,
  /Bearer /,
  /notify-api\.line\.me/,
  /api\.line\.me/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /090-\d{4}-\d{4}/,
  /TBA\d{8,}/,
  /住所マスタ/,
  /PRIVATE_LINE/,
  /LINE_SEND_ENABLED/
];

function walk(dir, files) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    if (skipDirs.has(entry.name)) return;
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (skipFiles.has(entry.name)) return;
    else if (/\.(js|html|css|json|md|mjs|csv|yml|yaml)$/i.test(entry.name)) files.push(full);
  });
}

var files = [];
walk(root, files);
var hits = [];
files.forEach(function (file) {
  var text = fs.readFileSync(file, 'utf8');
  forbidden.forEach(function (re) {
    if (re.test(text)) hits.push(path.relative(root, file) + ' :: ' + re);
  });
});

assert.equal(hits.length, 0, 'forbidden terms:\n' + hits.join('\n'));

var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.match(html, /Demoでは実際には送信されません/);
assert.match(html, /3分でデモを体験/);
assert.match(html, /プロフィール/);
assert.match(html, /現場司令室/);
assert.match(html, /稼働中ドライバー一覧/);
assert.match(html, /line-modal/);
assert.match(html, /map-modal/);
assert.match(html, /出庫前/);
assert.match(html, /finish-explain/);
assert.match(html, /route-pin-inspect/);
assert.match(html, /← 前へ/);
assert.match(html, /次へ →/);
assert.match(html, /全体表示/);
assert.match(html, /すべて架空です/);
assert.match(html, /配送管理デモ \| Delivery Operations Demo/);
assert.doesNotMatch(html, /line-channel-token/);
assert.doesNotMatch(html, /proxy-secret/);
assert.doesNotMatch(html, /\.\.\//);
assert.doesNotMatch(html, /localStorage/);
assert.doesNotMatch(html, /sessionStorage/);
assert.doesNotMatch(html, /fetch\(/);

var appJs = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
assert.match(appJs, /openRouteMap/);
assert.match(appJs, /fitBounds/);
assert.match(appJs, /map-pin-regular/);
assert.match(appJs, /map-pin-timed/);
assert.match(appJs, /evidence-grid/);
assert.doesNotMatch(appJs, /fetch\(/);
assert.doesNotMatch(appJs, /localStorage/);
assert.doesNotMatch(appJs, /sessionStorage/);
assert.doesNotMatch(appJs, /\.\.\//);

var server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.match(server, /demo: true/);
assert.match(server, /\/health/);
assert.doesNotMatch(server, /path\.join\(__dirname, ['"]\.\./);
assert.doesNotMatch(server, /render-webhook-server/);
assert.doesNotMatch(server, /webhook/);
assert.doesNotMatch(server, /process\.env\.[A-Z_]*TOKEN/);

var sample = fs.readFileSync(path.join(root, 'src/sample-data.js'), 'utf8');
assert.match(sample, /デモ|サンプル|架空/);
assert.doesNotMatch(sample, /090-/);

console.log('security.test.mjs ok (' + files.length + ' files scanned)');
