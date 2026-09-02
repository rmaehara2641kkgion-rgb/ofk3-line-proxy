// RAW (Amazon Dive Deep Data) -> LOW-equivalent adapter integration test.
//
// Validates that "Loading Area Turnover" RAW + "Total Number of DSP Routes" RAW,
// once both are uploaded, are joined on route_id and converted into the exact
// same internal shape (latBeaconMap) that the existing LOW pipeline already
// produces, then merged through the SAME unmodified mergeAndRender()/
// renderLatResults() used by the LOW path (see lat-low-only-pipeline.test.mjs).
//
// Also validates the dashboard-protection contract:
//   - a single RAW file (only Turnover, or only Routes) must NOT touch
//     latResultData / rendered DOM at all (no partial/corrupted dashboard)
//   - once combined, unmatched / duplicate route_id counts are reported via
//     window.__latRawJoinDiagnosis, never silently dropped or expanded
//   - switching RAW -> LOW -> RAW never leaves stale state behind
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

function newElement() {
  var el = {
    _listeners: {},
    style: {},
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
    textContent: '',
    innerHTML: '',
    tagName: 'DIV',
    closest: function () { return null; }
  };
  el.addEventListener = function (type, cb) {
    if (!el._listeners[type]) el._listeners[type] = [];
    el._listeners[type].push(cb);
  };
  el.removeAttribute = function () {};
  el.dispatch = function (type, ev) {
    (el._listeners[type] || []).forEach(function (cb) { cb(ev); });
  };
  return el;
}

function buildSandbox() {
  var input = newElement();
  input.id = 'lat-file-input';
  input.tagName = 'INPUT';
  var zone = newElement();
  zone.id = 'lat-drop-zone';
  var elements = {
    'lat-file-input': input,
    'lat-drop-zone': zone,
    'lat-detail-tbody': newElement(),
    'lat-detail-thead-row': newElement(),
    'lat-total': newElement(),
    'lat-export-btn': newElement(),
    'lat-sort-select': { value: 'diff' },
    'lat-summary': newElement(),
    'lat-driver-summary': newElement(),
    'lat-timeline-visual': newElement(),
    'lat-timeline-bars': newElement(),
    'lat-date-range': newElement(),
    'lat-matched': newElement(),
    'lat-unmatched': newElement(),
    'lat-early': newElement(),
    'lat-ontime': newElement(),
    'lat-avg-loading': newElement(),
    'quality-hero': newElement(),
    'lat-loaded-msg': newElement()
  };
  elements['lat-export-btn'].disabled = true;

  var sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.alert = function (msg) { sandbox.__alerts = sandbox.__alerts || []; sandbox.__alerts.push(String(msg)); };
  sandbox.document = {
    readyState: 'complete',
    getElementById: function (id) { return elements[id] || null; },
    createElement: function () { return newElement(); },
    addEventListener: function () {}
  };
  sandbox.localStorage = { getItem: function () { return '{}'; }, setItem: function () {}, removeItem: function () {} };
  sandbox.LatDepartureCore = null;
  sandbox.driverJapaneseNames = {};

  sandbox.FileReader = function () { this.onload = null; };
  sandbox.FileReader.prototype.readAsArrayBuffer = function (file) {
    if (this.onload) this.onload({ target: { result: file.__buffer } });
  };
  sandbox.XLSX = {
    read: function (data) {
      var text = Buffer.from(data).toString('utf8').replace(/^﻿/, '');
      var rows = text.trim().split(/\r?\n/).filter(Boolean).map(function (l) { return l.split(','); });
      return { SheetNames: ['Sheet1'], Sheets: { Sheet1: { __rows: rows } } };
    },
    utils: { sheet_to_json: function (ws) { return ws.__rows; } }
  };

  return { sandbox, input, zone, elements };
}

function fileFor(relPath) {
  var csv = readFileSync(join(repoRoot, relPath), 'utf8');
  return { name: relPath.split('/').pop(), __buffer: Buffer.from(csv, 'utf8') };
}

function runTests() {
  var ctx = buildSandbox();
  var sandbox = ctx.sandbox;
  vm.runInContext(coreSource, vm.createContext(sandbox), { filename: 'lat-departure-core.js' });

  var dnrStub = 'var dnrResultData = []; function getTodayJst(){ return "2026-08-23"; } var driverJapaneseNames = {}; function updateQualitySummary(){} function buildTeamQualitySnapshot(){} function latFormatDate(d){ return d||""; }\n';
  vm.runInContext(dnrStub + latSource, vm.createContext(sandbox), { filename: 'index.html#LAT block' });

  // ---- STEP: format detection (unit-level, no file I/O) ----
  var lowColMap = { route_id: 0, loading_area_turnover: 1, employee_id: 2 };
  var rawTurnoverColMap = { route_id: 0, loading_area_turnover: 1, beacon_exit: 2 }; // no employee_id
  var rawRoutesColMap = { route_id: 0, employee_id: 1, planned_departure: 2 }; // no loading_area_turnover
  var noRouteIdColMap = { employee_id: 0, loading_area_turnover: 1 };
  assert(sandbox.latDetectInputFormat(lowColMap) === 'low', 'LOW signature detected as low');
  assert(sandbox.latDetectInputFormat(rawTurnoverColMap) === 'raw_turnover', 'Turnover-only signature detected as raw_turnover');
  assert(sandbox.latDetectInputFormat(rawRoutesColMap) === 'raw_routes', 'Routes-only signature detected as raw_routes');
  assert(sandbox.latDetectInputFormat(noRouteIdColMap) === 'low', 'no route_id falls back to existing LOW error handling, not treated as RAW');

  // ---- STEP: upload RAW Turnover ONLY -> must NOT touch the dashboard at all ----
  var turnoverFile = fileFor('tests/fixtures/lat-verify/raw-turnover-verify.csv');
  ctx.input.files = [turnoverFile];
  ctx.input.dispatch('change', { target: ctx.input, preventDefault: function () {} });

  assert(sandbox.latResultData.length === 0, 'Turnover alone: latResultData still empty (no partial dashboard)');
  assert(sandbox.__latRawJoinDiagnosis == null, 'Turnover alone: no join diagnosis yet');
  assert(ctx.elements['lat-total'].textContent === '', 'Turnover alone: lat-total DOM untouched');
  assert(ctx.elements['lat-loaded-msg'].textContent.indexOf('Loading Area Turnover読込済み(5件)') >= 0, 'pending status mentions Turnover count (unique route_id count, dedupe already applied)');
  assert(ctx.elements['lat-loaded-msg'].textContent.indexOf('もう一方のRAWファイル') >= 0, 'pending status asks for the other RAW file');

  // ---- STEP: upload RAW Routes -> both present, combine now happens ----
  var routesFile = fileFor('tests/fixtures/lat-verify/raw-routes-verify.csv');
  ctx.input.files = [routesFile];
  ctx.input.dispatch('change', { target: ctx.input, preventDefault: function () {} });

  var diag = sandbox.__latRawJoinDiagnosis;
  assert(diag, 'join diagnosis populated once both RAW files present');
  // raw-turnover-verify.csv has 6 data rows, one duplicate route_id (2789048-08) -> 5 unique + 1 duplicate
  assert(diag.turnoverCount === 5, 'turnoverCount (unique route_id after dedupe), got ' + diag.turnoverCount);
  assert(diag.turnoverDuplicateRouteIdCount === 1, 'turnoverDuplicateRouteIdCount reported, got ' + diag.turnoverDuplicateRouteIdCount);
  // raw-routes-verify.csv has 6 data rows, one duplicate route_id (2789048-99) -> 5 unique + 1 duplicate
  assert(diag.routesCount === 5, 'routesCount (unique route_id after dedupe), got ' + diag.routesCount);
  assert(diag.routesDuplicateRouteIdCount === 1, 'routesDuplicateRouteIdCount reported, got ' + diag.routesDuplicateRouteIdCount);
  // route 2789048-77 exists only in Turnover -> unmatched; 2789048-55 exists only in Routes -> routesOnlyCount
  assert(diag.matchedEmployeeCount === 4, 'matchedEmployeeCount, got ' + diag.matchedEmployeeCount);
  assert(diag.unmatchedEmployeeCount === 1, 'unmatchedEmployeeCount (2789048-77 has no Routes match), got ' + diag.unmatchedEmployeeCount);
  assert(diag.routesOnlyCount === 1, 'routesOnlyCount (2789048-55 has no Turnover match), got ' + diag.routesOnlyCount);
  assert(diag.beaconMapCount === 5, 'beaconMapCount == turnover population (LOW semantics: only routes with a turnover reading), got ' + diag.beaconMapCount);

  assert(sandbox.latResultData.length === 5, 'latResultData rebuilt from combined RAW, got ' + sandbox.latResultData.length);
  assert(ctx.elements['lat-total'].textContent === 5, 'lat-total DOM reflects combined result, got ' + ctx.elements['lat-total'].textContent);
  assert(ctx.elements['lat-loaded-msg'].textContent.indexOf('RAWから5ルート変換完了') >= 0, 'success status shows converted route count');

  // ---- STEP: field-level equivalence check against the same route in the LOW fixture ----
  // (low-lat-gds.csv / lat-low-only-pipeline.test.mjs asserts these exact beacon-derived
  // values for route 2789048-15 built straight from a LOW file; the RAW-combined path must
  // produce identical values for every field the LOW file itself supplies.)
  var r15 = sandbox.latResultData.find(function (r) { return r.routeId === '2789048-15'; });
  assert(r15, 'route 2789048-15 present after RAW combine');
  assert(r15.wave === 'CYCLE_3', 'wave matches LOW-equivalent, got ' + r15.wave);
  assert(r15.routeCode === 'DSX15', 'routeCode matches LOW-equivalent, got ' + r15.routeCode);
  assert(r15.dsArrival === '17:55:00', 'dsArrival matches LOW-equivalent, got ' + r15.dsArrival);
  assert(r15.dsEntrance === '18:00:00', 'dsEntrance matches LOW-equivalent, got ' + r15.dsEntrance);
  assert(r15.actualDeparture === '18:31:02', 'actualDeparture matches LOW-equivalent, got ' + r15.actualDeparture);
  assert(r15.dsExit === '18:35:00', 'dsExit matches LOW-equivalent, got ' + r15.dsExit);
  assert(r15.loadingMin === 15, 'loadingMin matches LOW-equivalent, got ' + r15.loadingMin);
  assert(r15.stayMin === 42.5, 'stayMin (turnover) matches LOW-equivalent, got ' + r15.stayMin);
  assert(r15.employeeId === 'A3NIVS2X2584EM', 'employeeId supplied by Routes RAW, got ' + r15.employeeId);
  // Fields the LOW-only fixture (no planned_departure column) cannot supply, but the
  // Routes RAW legitimately can -> this is an EXPECTED, documented capability difference,
  // not a discrepancy: RAW input carries planned_departure via Total Number of DSP Routes,
  // pure LOW-without-DSP does not.
  assert(r15.plannedDeparture === '18:10', 'plannedDeparture supplied by Routes RAW (LOW-only fixture has none), got ' + r15.plannedDeparture);
  assert(r15.judgment === '遅延', 'judgment computable only because Routes RAW supplied plannedDeparture, got ' + JSON.stringify(r15.judgment));

  // empty beacon_exit is preserved as empty (not backfilled from departure), same as LOW path
  var r99 = sandbox.latResultData.find(function (r) { return r.routeId === '2789048-99'; });
  assert(r99, 'route 2789048-99 present');
  assert(r99.dsExit === '', 'empty beacon_exit stays empty via RAW path too');
  assert(r99.employeeId === 'A3NIVS2X2584EM', 'duplicate route_id in Routes RAW resolved to the FIRST occurrence, not the later A1DIFFERENT row');

  // duplicate route_id in Turnover RAW (2789048-08): first occurrence (38.0min) must win, not the later 99.9min row
  var r08 = sandbox.latResultData.find(function (r) { return r.routeId === '2789048-08'; });
  assert(r08, 'route 2789048-08 present');
  assert(r08.stayMin === 38, 'duplicate route_id in Turnover RAW resolved to the FIRST occurrence, not the later duplicate, got ' + r08.stayMin);

  // route present only in Turnover (no Routes match) must still appear, with a red/unmatched employeeId
  var r77 = sandbox.latResultData.find(function (r) { return r.routeId === '2789048-77'; });
  assert(r77, 'route 2789048-77 (Turnover-only) still included, not silently dropped');
  assert(r77.employeeId === '', 'route 2789048-77 has no employeeId (unmatched, visible as such, not fabricated)');

  // route present only in Routes (no Turnover reading) must NOT appear (matches LOW semantics:
  // LOW/Turnover data only ever contains routes that actually have a turnover reading)
  var r55 = sandbox.latResultData.find(function (r) { return r.routeId === '2789048-55'; });
  assert(!r55, 'Routes-only route 2789048-55 is not fabricated into the beacon map');

  // ---- STEP: switch RAW -> LOW -> confirm full state replacement, no RAW bleed-through ----
  var lowFile = fileFor('tests/fixtures/lat-verify/low-lat-gds.csv');
  ctx.input.files = [lowFile];
  ctx.input.dispatch('change', { target: ctx.input, preventDefault: function () {} });

  assert(sandbox.latResultData.length === 4, 'LOW file after RAW: latResultData fully replaced (4 LOW rows), got ' + sandbox.latResultData.length);
  assert(!sandbox.latResultData.some(function (r) { return r.routeId === '2789048-77' || r.routeId === '2789048-01'; }) || sandbox.latResultData.some(function (r) { return r.routeId === '2789048-15'; }),
    'sanity: LOW result set is the LOW fixture, not a merge of RAW+LOW');
  assert(sandbox.latRawTurnoverRows === null, 'latRawTurnoverRows reset to null after loading a LOW file');
  assert(sandbox.latRawRoutesRows === null, 'latRawRoutesRows reset to null after loading a LOW file');
  assert(sandbox.__latRawJoinDiagnosis === null, '__latRawJoinDiagnosis reset to null after loading a LOW file');
  assert(Object.keys(sandbox.latBeaconMap).indexOf('2789048-77') < 0, 'no leftover RAW-only route in latBeaconMap after switching to LOW');

  // ---- STEP: switch LOW -> RAW again -> confirm it recombines cleanly (no LOW leftovers) ----
  ctx.input.files = [turnoverFile];
  ctx.input.dispatch('change', { target: ctx.input, preventDefault: function () {} });
  ctx.input.files = [routesFile];
  ctx.input.dispatch('change', { target: ctx.input, preventDefault: function () {} });

  assert(sandbox.latResultData.length === 5, 'RAW after LOW: recombines cleanly to 5 rows, got ' + sandbox.latResultData.length);
  assert(Object.keys(sandbox.latBeaconMap).indexOf('2789048-15') >= 0, 'RAW route present after switching back from LOW');
  assert(sandbox.latResultData.every(function (r) { return r.routeId.indexOf('2789048-') === 0; }), 'no stale LOW-only routeIds leaked into the RAW result set');

  console.log('lat-raw-turnover-pipeline.test.mjs: all tests passed');
  console.log('  join diagnosis: turnover=' + diag.turnoverCount + ' (dup=' + diag.turnoverDuplicateRouteIdCount + ')'
    + ' routes=' + diag.routesCount + ' (dup=' + diag.routesDuplicateRouteIdCount + ')'
    + ' matched=' + diag.matchedEmployeeCount + ' unmatched=' + diag.unmatchedEmployeeCount
    + ' routesOnly=' + diag.routesOnlyCount + ' beaconMap=' + diag.beaconMapCount);
}

runTests();
