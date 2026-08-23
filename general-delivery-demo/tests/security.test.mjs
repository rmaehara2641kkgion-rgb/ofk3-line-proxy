import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['node_modules', '.git']);
const forbidden = [
  /Amazon/i,
  /OFK3/i,
  /TransportID/i,
  /FTDS/,
  /Mentor/,
  /\bLAT\b/,
  /\bDNR\b/,
  /\bDSP\b/,
  /script\.google\.com/,
  /notify-api\.line\.me/,
  /api\.line\.me/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /CHANNEL_ACCESS_TOKEN/,
  /090-\d{4}-\d{4}/,
  /TBA\d{8,}/
];

function walk(dir, files) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    if (skip.has(entry.name)) return;
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name === 'security.test.mjs') return;
    else if (/\.(js|html|css|json|md|mjs|csv)$/i.test(entry.name)) files.push(full);
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
assert.match(html, /サンプルデータで試す/);
assert.doesNotMatch(html, /line-channel-token/);
assert.doesNotMatch(html, /proxy-secret/);

var server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.match(server, /LINE_SEND_ENABLED/);
assert.match(server, /previewOnly/);
assert.doesNotMatch(server, /path\.join\(__dirname, '\.\.'\)/);

console.log('security.test.mjs ok (' + files.length + ' files scanned)');
