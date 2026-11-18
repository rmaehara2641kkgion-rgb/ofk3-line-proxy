import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Core = require(join(root, 'delivery-window-core.js'));
const Session = require(join(root, 'delivery-window-session.js'));
const Scan = require(join(root, 'delivery-window-scan.js'));
const XLSX = require('xlsx');

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
}
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

const REF = '2026-11-17', D = REF + ' ';
const id = (n) => 'DA' + String(n).padStart(10, '0');
const HEAD = 'Tracking ID,Last Updated Time,Scheduled Delivery Start Time,Scheduled Delivery End Time,Promised Delivery Date';
const sr = (lines) => HEAD + '\n' + lines.join('\n') + '\n';
const line = (n, s, e) => [id(n), '2026-11-17 09:00:00', s, e, REF].join(',');
const SR_8_12 = sr([line(1, D + '08:00:00', D + '12:00:00')]);
const SR_14_16 = sr([line(1, D + '14:00:00', D + '16:00:00')]);
function workbook(c1) {
  const rows = [[null], [null, 'RTS報告'], [null], [null, '日付', 46343], [null, 'Node', 'OFK3'], [null],
    [null, 'Cycle1', null, null, 'Cycle2', null], [null, 'AM指定・14-16指定・BC', null, null, '16-18時指定', null], [null, '番号', 'トラッキングID', null, '番号', 'トラッキングID']];
  c1.forEach((n, i) => rows.push([null, i + 1, id(n)]));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'エリミネーション報告');
  return wb;
}
function deferred() { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; }
function make() {
  const ctl = Scan.createScanController({});
  const changes = [];
  const s = Session.createSession({ XLSX, controller: ctl, now: () => new Date(2026, 10, 17, 9, 5), onChange: (st) => changes.push(st.status) });
  return { s, ctl, changes };
}
const answer = (ctl, n) => ctl.handleScan(id(n)).label;

function t0() {}
t('initial state: mode OFF, nothing loaded, scanning impossible; OFF means pass-through to the normal DA search', async () => {
  const { s } = make();
  const st = s.getState();
  eq([st.mode, st.status, st.canScan, st.missing], [false, 'needs_files', false, ['elimi', 'sr']], 'initial');
  eq(s.gate(id(1), true), 'off', 'mode OFF -> pass through even with no data');
});
t('mode ON without data: scanning blocked, both files named; with one file: the other is named', async () => {
  const { s } = make();
  s.setMode(true);
  eq([s.getState().canScan, s.gate(id(1), true), s.getState().missingLabels], [false, 'blocked', ['エリミ報告書(.xlsx)', 'SearchResults(.csv)']], 'none');
  await s.loadElimi(workbook([1]));
  eq([s.getState().status, s.getState().missing, s.gate(id(1), true)], ['needs_files', ['sr'], 'blocked'], 'only elimi');
});
t('both files -> ready; table is installed; last-update info is exposed; ready does not depend on the manifest', async () => {
  const { s, ctl } = make();
  s.setMode(true); await s.loadElimi(workbook([1])); const st = await s.loadSr(SR_8_12);
  eq([st.status, st.canScan, st.srLastUpdated, st.loadedAt], ['ready', true, '2026-11-17 09:00:00', '2026-11-17 09:05'], 'ready');
  eq(answer(ctl, 1), '8時から12時', 'answers');
});
t('gate: explicit scans of any length are processed; idle-path values shorter than a Tracking ID wait; empty is ignored', async () => {
  const { s } = make();
  s.setMode(true); await s.loadElimi(workbook([1])); await s.loadSr(SR_8_12);
  eq([s.gate(id(1), true), s.gate('abc', true), s.gate('abc', false), s.gate(id(1), false), s.gate('   ', true), s.gate('', false)], ['process', 'process', 'wait', 'process', 'empty', 'empty'], 'gate');
});
t('stale load guard: a slow OLD SearchResults read finishing after a newer one never overwrites it', async () => {
  const { s, ctl } = make();
  s.setMode(true); await s.loadElimi(workbook([1]));
  const slow = deferred(), fast = deferred();
  const pOld = s.loadSr(() => slow.p), pNew = s.loadSr(() => fast.p);
  eq(s.getState().status, 'loading', 'loading');
  eq([s.getState().canScan, s.gate(id(1), true)], [false, 'blocked'], 'no scanning while loading');
  fast.res(SR_14_16); await pNew;
  eq(answer(ctl, 1), '14時から16時', 'new data active');
  slow.res(SR_8_12); await pOld;
  eq(answer(ctl, 1), '14時から16時', 'old result discarded');
  eq(s.getState().status, 'ready', 'still ready');
});
t('stale load guard (reverse order and failures): old read failing late does not break newer good data', async () => {
  const { s, ctl } = make();
  s.setMode(true); await s.loadElimi(workbook([1]));
  const a = deferred(), b = deferred();
  const pa = s.loadSr(() => a.p), pb = s.loadSr(() => b.p);
  b.res(SR_8_12); await pb;
  a.rej(new Error('late failure')); await pa;
  eq([s.getState().status, answer(ctl, 1)], ['ready', '8時から12時'], 'unaffected');
  const c = deferred(), d = deferred();
  const pc = s.loadSr(() => c.p), pd = s.loadSr(() => d.p);
  c.res(SR_14_16); await pc;                       // older finishes first, but a newer load is still pending
  eq([s.getState().status, s.getState().canScan], ['loading', false], 'still loading until the newest settles');
  d.res(SR_8_12); await pd;
  eq(answer(ctl, 1), '8時から12時', 'newest wins');
});
t('while any load is pending the previous table is unusable (no silent use of old data)', async () => {
  const { s, ctl } = make();
  s.setMode(true); await s.loadElimi(workbook([1])); await s.loadSr(SR_8_12);
  const d = deferred(); const p = s.loadElimi(() => d.p);
  eq(ctl.handleScan(id(1)).reason, 'table_not_loaded', 'no table during load');
  d.res(workbook([1])); await p;
  eq(answer(ctl, 1), '8時から12時', 'back after load');
});
t('read failure -> error status, no table; a following good file recovers', async () => {
  const { s, ctl } = make();
  s.setMode(true); await s.loadElimi(workbook([1]));
  const st = await s.loadSr(() => Promise.reject(new Error('x')));
  eq([st.status, st.canScan, st.errors[0].code], ['error', false, 'sr_read_failed'], 'error');
  eq(ctl.handleScan(id(1)).reason, 'table_not_loaded', 'no table');
  eq((await s.loadSr(SR_8_12)).status, 'ready', 'recovered');
});
t('a bad replacement file invalidates the previous good table instead of silently keeping it', async () => {
  const { s, ctl } = make();
  s.setMode(true); await s.loadElimi(workbook([1])); await s.loadSr(SR_8_12);
  const st = await s.loadSr('Tracking ID,Foo\nx,y\n');
  eq([st.status, st.errors[0].code, st.canScan], ['error', 'sr_missing_columns', false], 'rejected');
  eq(ctl.handleScan(id(1)).reason, 'table_not_loaded', 'old table gone');
});
t('mode toggling never changes the loaded data; OFF always passes through', async () => {
  const { s, ctl } = make();
  s.setMode(true); await s.loadElimi(workbook([1])); await s.loadSr(SR_8_12);
  s.setMode(false); eq(s.gate(id(1), true), 'off', 'off');
  s.setMode(true); eq([s.getState().status, answer(ctl, 1)], ['ready', '8時から12時'], 'data kept in memory');
});
t('production table options are used: headingCheck stays true by default', async () => {
  const { s, ctl } = make();
  const wb = (() => { const w = workbook([]); return w; })();
  s.setMode(true); await s.loadElimi(wb); await s.loadSr(SR_8_12);
  assert(ctl.dataInfo().loaded, 'loaded'); eq(ctl.dataInfo().report.elimiUniqueIds, 0, 'empty elimi list parsed');
  // a Cycle2 entry with a non-16-18 window must still be stopped (heading safety stop)
  const rows = [[null], [null], [null], [null, '日付', 46343], [null], [null], [null, 'Cycle1', null, null, 'Cycle2', null], [null, 'AM指定・14-16指定・BC', null, null, '16-18時指定', null], [null, '番号', 'トラッキングID', null, '番号', 'トラッキングID'], [null, 1, null, null, 1, id(1)]];
  const w2 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w2, XLSX.utils.aoa_to_sheet(rows), 'エリミネーション報告');
  await s.loadElimi(w2);
  eq(ctl.handleScan(id(1)).reason, 'conflict_elimi', 'heading check ON');
});
t('onChange errors never break the session; session source has no storage/network access', async () => {
  const ctl = Scan.createScanController({});
  const s = Session.createSession({ XLSX, controller: ctl, onChange() { throw new Error('ui'); } });
  s.setMode(true); await s.loadElimi(workbook([1])); eq((await s.loadSr(SR_8_12)).status, 'ready', 'still works');
});

console.log('delivery-window-session tests');
for (const [name, fn] of tests) {
  try { await fn(); passed += 1; console.log('  ok - ' + name); } catch (e) { console.error('  NOT OK - ' + name + '\n' + e.message); process.exit(1); }
}
console.log('\n' + passed + ' tests passed');
