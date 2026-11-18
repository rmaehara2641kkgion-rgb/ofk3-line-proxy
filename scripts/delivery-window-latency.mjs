// Synthetic latency measurement: scan string -> lookup -> speak() call, 5,000-row synthetic table.
// Uses a fake speechSynthesis, so it measures OUR code only (not the browser's audio start).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Core = require(join(root, 'delivery-window-core.js'));
const Spk = require(join(root, 'delivery-window-speaker.js'));
const Scan = require(join(root, 'delivery-window-scan.js'));

const N = Number(process.argv[2]) || 5000, SCANS = Number(process.argv[3]) || 20000;
const REF = '2026-11-17', D = REF + ' ';
const id = (n) => 'DA' + String(n).padStart(10, '0');
const wins = [['08:00', '12:00'], ['14:00', '16:00'], ['16:00', '18:00'], ['08:00', '22:00'], ['', '']];
const sr = [], el = [];
for (let i = 1; i <= N; i++) { const w = wins[i % wins.length]; sr.push({ id: id(i), start: w[0] ? D + w[0] + ':00' : '', end: w[1] ? D + w[1] + ':00' : '', promised: REF, updated: '' }); el.push({ id: id(i), cycle: 'Cycle1', heading: 'AM指定・14-16指定・BC', mixed: true, expected: null, row: 1 }); }
const t0 = performance.now();
const table = Core.buildTable({ srRows: sr, elimiRecords: el, reportDate: REF });
const buildMs = performance.now() - t0;
const synth = { getVoices: () => [{ name: 'Microsoft Ichiro', lang: 'ja-JP' }], speak() {}, cancel() {} };
const spk = Spk.createSpeaker({ synth, Utterance: function (t) { this.text = t; }, now: () => performance.now() }, {});
const ctl = Scan.createScanController({ speaker: spk, now: () => performance.now() }); ctl.setTable(table);
for (let i = 0; i < SCANS; i++) ctl.handleScan(id(1 + (i * 7919) % N));
const m = ctl.metrics();
const f = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
console.log(JSON.stringify({ rows: N, scans: m.scans, tableBuildMs: f(buildMs),
  lookupMs: { p50: f(m.lookupMs.p50), p95: f(m.lookupMs.p95), max: f(m.lookupMs.max) },
  scanToSpeakCallMs: { p50: f(m.scanToSpeakCallMs.p50), p95: f(m.scanToSpeakCallMs.p95), max: f(m.scanToSpeakCallMs.max) } }, null, 1));
