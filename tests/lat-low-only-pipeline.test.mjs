// LOW/LAT single-file pipeline integration test (no DSP).
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
  sandbox.alert = function () {};
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
      var text = Buffer.from(data).toString('utf8').replace(/^\uFEFF/, '');
      var rows = text.trim().split(/\r?\n/).filter(Boolean).map(function (l) { return l.split(','); });
      return { SheetNames: ['Sheet1'], Sheets: { Sheet1: { __rows: rows } } };
    },
    utils: { sheet_to_json: function (ws) { return ws.__rows; } }
  };

  return { sandbox, input, zone, elements };
}

function runTests() {
  var ctx = buildSandbox();
  var sandbox = ctx.sandbox;
  vm.runInContext(coreSource, vm.createContext(sandbox), { filename: 'lat-departure-core.js' });

  var dnrStub = 'var dnrResultData = []; function getTodayJst(){ return "2026-08-23"; } var driverJapaneseNames = {}; function updateQualitySummary(){} function buildTeamQualitySnapshot(){} function latFormatDate(d){ return d||""; }\n';
  vm.runInContext(dnrStub + latSource, vm.createContext(sandbox), { filename: 'index.html#LAT block' });

  assert(sandbox.__latLowUiWired === true, 'LOW upload UI wired on init');

  var csv = readFileSync(join(repoRoot, 'tests/fixtures/lat-verify/low-lat-gds.csv'), 'utf8');
  var file = { name: 'low-lat-gds.csv', __buffer: Buffer.from(csv, 'utf8') };

  // change event path
  ctx.input.files = [file];
  ctx.input.dispatch('change', { target: ctx.input, preventDefault: function () {} });

  assert(sandbox.__latLowLoadDiagnosis && sandbox.__latLowLoadDiagnosis.count === 3, 'LOW parse count');
  assert(sandbox.latResultData && sandbox.latResultData.length === 3, 'latResultData rows');

  var target = sandbox.latResultData.find(function (r) { return r.routeId === '2789048-15'; });
  assert(target, 'route 2789048-15 present');
  assert(target.wave === 'CYCLE_3', 'wave CYCLE_3');
  assert(target.routeCode === 'DSX15', 'routeCode DSX15');
  assert(target.actualDeparture === '18:31:02', 'actualDeparture from beacon_departure');
  assert(target.plannedDeparture === '', 'no plannedDeparture in LOW');
  assert(target.plannedDepartureDisplay === '予定時刻未設定', 'plannedDeparture display reason');
  assert(target.judgment === '', 'judgment empty without planned source');
  assert(target.judgmentDisplay === '予定時刻未設定', 'judgment display reason');
  assert(target.loadingMin === 15, 'loadingMin 15min');
  assert(target.stayMin === 42.5, 'stayMin from turnover');

  // drop event path
  sandbox.latBeaconMap = {};
  sandbox.latResultData = [];
  ctx.zone.dispatch('drop', {
    preventDefault: function () {},
    dataTransfer: { files: [file] }
  });
  assert(sandbox.latResultData.length === 3, 'drop path loads LOW file');

  console.log('lat-low-only-pipeline.test.mjs: all tests passed');
  console.log('  2789048-15 wave=' + target.wave + ' actualDeparture=' + target.actualDeparture + ' judgment=' + target.judgmentDisplay);
}

runTests();
