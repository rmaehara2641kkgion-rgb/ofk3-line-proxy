// normalizeLatTimeline() / chronological timeline normalization regression test.
//
// Background: absoluteMinutes (27c5d2b) fixed diffs for cells that carry their own
// date (Excel date+time serials, "YYYY/M/D HH:MM:SS" text). W37 real data showed
// that 出発予定/実出発/FirstScan/LastScan frequently arrive as bare "HH:mm" text with
// NO date at all (including >24h elapsed-time-looking strings like "35:42"), which
// absoluteMinutes could not disambiguate on its own (single-cell function, no
// cross-event context). This test locks in normalizeLatTimeline()'s anchor
// (scheduledDeparture) + business-order chain (DS到着→DS入場→FirstScan→LastScan→
// 実出発→DS退出) reconciliation, and its isTimelineSuspicious/timelineWarningReason
// flags for values that remain implausible even after the best-effort reconciliation
// (flag only — never mutate/clamp/delete the underlying number).
//
// Extracts the real LAT block from index.html (same technique as
// tests/lat-production-pipeline.test.mjs) and drives mergeAndRender() directly
// against hand-built latBeaconMap entries shaped exactly like what
// latParseRawTurnoverRows/latParseRawRoutesRows/latTryCombineRaw/the LOW branch of
// handleLatFile produce today (display strings + *Raw fields + dayNumber).
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function extractBlock(html, startMarker, endMarker) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  assert(startIdx >= 0, 'start marker: ' + startMarker);
  assert(endIdx > startIdx, 'end marker after start: ' + endMarker);
  return html.slice(startIdx, endIdx);
}

const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8');
const latSource = extractBlock(indexHtml, '// ===== LAT分析 =====', '// ===== DNR分析 =====');
const coreSource = readFileSync(join(repoRoot, 'lat-departure-core.js'), 'utf8');
const timelineSource = readFileSync(join(repoRoot, 'lat-timeline-core.js'), 'utf8');

function newElement() {
  var el = {
    _classes: new Set(), style: {}, textContent: '', innerHTML: '', value: '', disabled: false
  };
  el.classList = {
    add: function (c) { el._classes.add(c); },
    remove: function (c) { el._classes.delete(c); },
    contains: function (c) { return el._classes.has(c); }
  };
  el.removeAttribute = function () {};
  el.setAttribute = function () {};
  el.addEventListener = function () {};
  return el;
}

function buildSandbox() {
  var elements = new Map();
  var sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.alert = function (m) { console.log('[alert] ' + m); };
  sandbox.localStorage = {
    _store: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; },
    setItem: function (k, v) { this._store[k] = String(v); },
    removeItem: function (k) { delete this._store[k]; }
  };
  sandbox.document = {
    readyState: 'complete',
    getElementById: function (id) { if (!elements.has(id)) elements.set(id, newElement()); return elements.get(id); },
    createElement: function () { return newElement(); },
    addEventListener: function () {}
  };
  sandbox.addEventListener = function () {};

  // Driver identity fixtures: 山田玲緒 with 3 historical name variants across 2 TIDs,
  // aliases already registered (mirrors real driver-master consolidation state).
  sandbox.transportIDs = { '玲緒 山田 山': 'T100', '山田 玲緒': 'T200' };
  sandbox.driverNameAliases = { '玲緒 山田 山': '山田 玲緒', '玲緒 山田': '山田 玲緒' };
  sandbox.driverJapaneseNames = { '山田 玲緒': '山田 玲緒' };
  sandbox.driverDB = { '山田 玲緒': {} };
  sandbox.lineMapping = {};
  function resolveDriverKey(name) {
    if (!name) return name;
    if (sandbox.driverNameAliases[name]) return sandbox.driverNameAliases[name];
    if (sandbox.driverDB[name] || sandbox.lineMapping[name] || sandbox.transportIDs[name]) return name;
    return name;
  }
  sandbox.resolveDriverKey = resolveDriverKey;
  sandbox.resolveDriverKeyByTid = function (tid) {
    if (!tid) return '';
    for (var k in sandbox.transportIDs) { if (sandbox.transportIDs[k] === tid) return resolveDriverKey(k); }
    return '';
  };
  sandbox.dnrResultData = [];
  sandbox.getTodayJst = function () { return '2026-09-16'; };
  sandbox.updateQualitySummary = function () {};
  return sandbox;
}

var sandbox = buildSandbox();
var context = vm.createContext(sandbox);
vm.runInContext(coreSource, context, { filename: 'lat-departure-core.js' });
vm.runInContext(timelineSource, context, { filename: 'lat-timeline-core.js' });
vm.runInContext(latSource, context, { filename: 'index.html#LAT block' });

function route(overrides) {
  var base = {
    date: '2026/9/3', dayNumber: sandbox.latParseDateToDayNumber('2026/9/3'),
    employeeId: '', wave: 'CX3', routeCode: 'DSX03', turnover: '',
    arrival: '', entrance: '', departure: '', exit: '', firstScan: '', lastScan: '', plannedDeparture: '',
    arrivalRaw: '', entranceRaw: '', departureRaw: '', exitRaw: '', firstScanRaw: '', lastScanRaw: '', plannedDepartureRaw: ''
  };
  return Object.assign(base, overrides);
}

function run(routes) {
  sandbox.latBeaconMap = routes;
  sandbox.mergeAndRender();
  return sandbox.latResultData;
}

// 1. 通常ケース: 予定18:50 実出発18:55 => +5分
var results = run({
  'R-NORMAL-1': route({ departure: '18:55', departureRaw: '18:55', plannedDeparture: '18:50', plannedDepartureRaw: '18:50' })
});
var r = results.find(function (x) { return x.routeId === 'R-NORMAL-1'; });
assert(r.diffMin === 5, '1. normal: 18:50 -> 18:55 => +5min, got ' + r.diffMin);
assert(r.judgment === '定刻', '1. normal judgment is 定刻, got ' + r.judgment);
assert(!r.isTimelineSuspicious, '1. normal case not flagged suspicious');

// 2. 通常の早着: 予定18:50 実出発18:45 => -5分
results = run({
  'R-EARLY-1': route({ departure: '18:45', departureRaw: '18:45', plannedDeparture: '18:50', plannedDepartureRaw: '18:50' })
});
r = results.find(function (x) { return x.routeId === 'R-EARLY-1'; });
assert(r.diffMin === -5, '2. early: 18:50 -> 18:45 => -5min, got ' + r.diffMin);
assert(!r.isTimelineSuspicious, '2. early case not flagged suspicious');

// 3. Excel日付保持ケース（27c5d2bで対応済み。回帰確認）
results = run({
  'R-DATEKEEP-1': route({
    entrance: '23:40:00', entranceRaw: '2026/9/3 23:40:00',
    exit: '00:30:00', exitRaw: '2026/9/4 00:30:00',
    firstScan: '23:50:00', firstScanRaw: '2026/9/3 23:50:00',
    lastScan: '00:20:00', lastScanRaw: '2026/9/4 00:20:00',
    departure: '00:25:00', departureRaw: '2026/9/4 00:25:00',
    plannedDeparture: '23:50', plannedDepartureRaw: '23:50'
  })
});
r = results.find(function (x) { return x.routeId === 'R-DATEKEEP-1'; });
assert(r.loadingMin === 30, '3. own-date preserved: loadingMin=30 (no regression), got ' + r.loadingMin);
assert(r.stayMin === 50, '3. own-date preserved: stayMin=50 (no regression), got ' + r.stayMin);
assert(r.diffMin === 35, '3. own-date preserved: diffMin=35 (no regression), got ' + r.diffMin);
assert(!r.isTimelineSuspicious, '3. own-date preserved case not flagged suspicious');

// 4. 24h超ケース（実データ相当）: 予定18:50 実出発35:42 => 無条件に+1012分を返さない
results = run({
  'R-OVER24-1': route({ departure: '35:42', departureRaw: '35:42', plannedDeparture: '18:50', plannedDepartureRaw: '18:50' })
});
r = results.find(function (x) { return x.routeId === 'R-OVER24-1'; });
assert(r.diffMin !== 1012, '4. 24h-over case does not unconditionally yield +1012min, got ' + r.diffMin);
assert(r.isTimelineSuspicious === true, '4. 24h-over case is flagged suspicious');
assert(r.judgment === '', '4. 24h-over case not auto-classified as 早着/定刻/遅延, got judgment=' + JSON.stringify(r.judgment));
assert(r.judgmentDisplay === '判定不可（異常値）', '4. 24h-over case shows anomaly judgment display, got ' + r.judgmentDisplay);

// 5. FirstScan/LastScan逆転ケース: FirstScan37:00 LastScan02:24 => -2076分にならない
results = run({
  'R-REVERSE-1': route({ firstScan: '37:00', firstScanRaw: '37:00', lastScan: '02:24', lastScanRaw: '02:24' })
});
r = results.find(function (x) { return x.routeId === 'R-REVERSE-1'; });
assert(r.loadingMin !== -2076, '5. FirstScan/LastScan reversal: does not become -2076min, got ' + r.loadingMin);
assert(r.loadingMin >= 0, '5. FirstScan/LastScan reversal: never negative (business order enforced), got ' + r.loadingMin);
assert(r.isTimelineSuspicious === true, '5. FirstScan/LastScan reversal case is flagged suspicious');

// 6. 正だが異常に長いケース: FirstScan34:40 LastScan48:30 => 830分を無条件の正常積込として扱わない
results = run({
  'R-LONGPOS-1': route({ firstScan: '34:40', firstScanRaw: '34:40', lastScan: '48:30', lastScanRaw: '48:30' })
});
r = results.find(function (x) { return x.routeId === 'R-LONGPOS-1'; });
assert(r.isTimelineSuspicious === true, '6. plausible-but-long positive case is flagged suspicious (not silently accepted), loadingMin=' + r.loadingMin);

// 7. 欠損ケース: FirstScan/LastScanともに空でも既存処理が壊れない
results = run({
  'R-MISSING-1': route({
    firstScan: '', firstScanRaw: '', lastScan: '', lastScanRaw: '',
    departure: '18:55', departureRaw: '18:55', plannedDeparture: '18:50', plannedDepartureRaw: '18:50'
  })
});
r = results.find(function (x) { return x.routeId === 'R-MISSING-1'; });
assert(r.loadingMin === '', '7. missing FirstScan/LastScan: loadingMin stays empty (not fabricated), got ' + JSON.stringify(r.loadingMin));
assert(r.diffMin === 5, '7. missing FirstScan/LastScan does not break unrelated diffMin, got ' + r.diffMin);
assert(!r.isTimelineSuspicious, '7. missing-only case not flagged suspicious');

// 8. 回帰確認: 山田玲緒の人物統合（resolveDriverKeyByTid）が今回の変更で壊れていないこと
results = run({
  'R-DRIVER-OLD': route({ employeeId: 'T100', departure: '18:55', departureRaw: '18:55', plannedDeparture: '18:50', plannedDepartureRaw: '18:50' }),
  'R-DRIVER-NEW': route({ employeeId: 'T200', departure: '18:52', departureRaw: '18:52', plannedDeparture: '18:50', plannedDepartureRaw: '18:50' })
});
var names = results.map(function (x) { return x.driverName; });
assert(new Set(names).size === 1, '8. 山田玲緒 identity: old/new TID both resolve to one person, got ' + JSON.stringify(names));
assert(names[0] === '山田 玲緒 (山田 玲緒)', '8. 山田玲緒 identity: correct display name, got ' + names[0]);

// 9. W37 beacon mm:ss.tenths: 予定11:20 実出発57:46.8 => Amazon公式 -22.2 に一致（HH:mm解釈しない）
results = run({
  'R-MMSS-1': route({
    date: '2026/9/11',
    dayNumber: sandbox.latParseDateToDayNumber('2026/9/11'),
    arrivalRaw: '53:34.3', arrival: '53:34',
    entranceRaw: '53:34.3', entrance: '53:34',
    firstScanRaw: '54:02.7', firstScan: '54:02',
    lastScanRaw: '55:19.8', lastScan: '55:19',
    departureRaw: '57:46.8', departure: '57:46',
    exitRaw: '57:46.8', exit: '57:46',
    plannedDeparture: '11:20', plannedDepartureRaw: '2026/9/11 11:20',
    turnover: '4.2'
  })
});
r = results.find(function (x) { return x.routeId === 'R-MMSS-1'; });
assert(Math.abs(r.diffMin - (-22.2)) <= 0.3, '9. mm:ss.tenths matches Amazon -22.2, got ' + r.diffMin);
assert(r.loadingMin > 0 && r.loadingMin < 10, '9. loading is minutes not 77+/533, got ' + r.loadingMin);
assert(!r.isTimelineSuspicious, '9. reconstructed W37 CYCLE_1 is not suspicious, reason=' + r.timelineWarningReason);
assert(r.judgment === '早着出発', '9. early judgment after reconstruction, got ' + r.judgment);

// 10. 欠損スキャンを跨いでも 120分ルールを隣接扱いしない
results = run({
  'R-SKIP-1': route({
    date: '2026/9/11',
    dayNumber: sandbox.latParseDateToDayNumber('2026/9/11'),
    arrivalRaw: '30:40.0', arrival: '30:40',
    entranceRaw: '30:40.0', entrance: '30:40',
    firstScanRaw: '', lastScanRaw: '',
    departureRaw: '42:38.0', departure: '42:38',
    exitRaw: '42:38.0', exit: '42:38',
    plannedDeparture: '15:00', plannedDepartureRaw: '2026/9/11 15:00',
    turnover: '12'
  })
});
r = results.find(function (x) { return x.routeId === 'R-SKIP-1'; });
assert(Math.abs(r.diffMin - (-17.4)) <= 0.3, '10. skipped scans still reconstruct departure, got ' + r.diffMin);
assert(!r.isTimelineSuspicious, '10. missing scans must not inherit adjacent 120min rule, reason=' + r.timelineWarningReason);

// 11. tenths無しの 35:07/44:00 は 533分を正常積込にしない
results = run({
  'R-FAKE533': route({ firstScanRaw: '35:07', firstScan: '35:07', lastScanRaw: '44:00', lastScan: '44:00' })
});
r = results.find(function (x) { return x.routeId === 'R-FAKE533'; });
assert(r.isTimelineSuspicious === true, '11. 35:07-44:00 without tenths stays suspicious, loadingMin=' + r.loadingMin);

// 12. tenths無し 39:44/42:04 は 140分を無条件正常にしない
results = run({
  'R-FAKE140': route({ firstScanRaw: '39:44', firstScan: '39:44', lastScanRaw: '42:04', lastScan: '42:04' })
});
r = results.find(function (x) { return x.routeId === 'R-FAKE140'; });
assert(r.isTimelineSuspicious === true, '12. 39:44-42:04 without tenths stays suspicious, loadingMin=' + r.loadingMin);

// 13. 時跨ぎ mm:ss: 入場34:55.4 / 出発07:22.2 / 予定11:20 => 10:34→11:07（滞在32.5）。順序逆転として捨てない
results = run({
  'R-WRAP-1': route({
    date: '2026/9/10',
    dayNumber: sandbox.latParseDateToDayNumber('2026/9/10'),
    arrivalRaw: '34:55.4', arrival: '34:55',
    entranceRaw: '34:55.4', entrance: '34:55',
    firstScanRaw: '', lastScanRaw: '',
    departureRaw: '07:22.2', departure: '07:22',
    exitRaw: '07:22.2', exit: '07:22',
    plannedDeparture: '11:20', plannedDepartureRaw: '2026/9/10 11:20',
    turnover: '32.5'
  })
});
r = results.find(function (x) { return x.routeId === 'R-WRAP-1'; });
assert(Math.abs(r.diffMin - (-12.6)) <= 0.3, '13. hour-wrap matches Amazon -12.6, got ' + r.diffMin);
assert(!r.isTimelineSuspicious, '13. hour-wrap reconstructable visit is not suspicious, reason=' + r.timelineWarningReason);
assert(r.judgment === '早着出発', '13. hour-wrap early judgment, got ' + r.judgment);

// 14. 滞在10.9分の窓の外にある LastScan 45:32.1 は復元不能のまま隔離
results = run({
  'R-SCANOUT-1': route({
    date: '2026/9/9',
    dayNumber: sandbox.latParseDateToDayNumber('2026/9/9'),
    arrivalRaw: '22:53.8', arrival: '22:53',
    entranceRaw: '22:53.8', entrance: '22:53',
    firstScanRaw: '26:05.0', firstScan: '26:05',
    lastScanRaw: '45:32.1', lastScan: '45:32',
    departureRaw: '33:47.6', departure: '33:47',
    exitRaw: '33:47.6', exit: '33:47',
    plannedDeparture: '18:50', plannedDepartureRaw: '2026/9/9 18:50',
    turnover: '10.9'
  })
});
r = results.find(function (x) { return x.routeId === 'R-SCANOUT-1'; });
assert(r.isTimelineSuspicious === true, '14. lastScan outside stay window stays isolated');
assert(r.judgmentDisplay === '判定不可（異常値）', '14. still 判定不可, got ' + r.judgmentDisplay);

console.log('lat-timeline-normalization.test.mjs: all tests passed');
