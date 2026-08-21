// Production LAT pipeline integration test.
//
// This does NOT reimplement the LAT logic. It extracts the actual
// "// ===== LAT分析 =====" .. "// ===== DNR分析 =====" .. "// ===== 品質統合サマリー ====="
// block verbatim from root/index.html (the production entrypoint served by
// render-webhook-server.js), and the real lat-departure-core.js source, and
// runs both inside a Node `vm` context that stubs only the browser primitives
// the code touches (document, FileReader, XLSX, localStorage, alert).
//
// It reproduces the real production script-execution order:
//   1. lat-departure-core.js runs first (as in <head>), while
//      document.readyState is still 'loading' -> it only registers a
//      window 'load' listener, it does NOT install the loader yet.
//   2. The big inline <script> runs next (as in <body>) and declares the
//      original window.handleDspFile / dspRouteMap / mergeAndRender.
//   3. The window 'load' event fires last (after images/CDN scripts), at
//      which point installProductionDspLoader() overwrites
//      window.handleDspFile with the hardened production loader.
//   4. Only then does the test simulate the user dropping the DSP/LAT
//      fixture files, exactly like a real user interacting with the page
//      after it has finished loading.
//
// Fixtures: tests/fixtures/lat-verify/{dsp,lat}-lat-verify.csv

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

// ---- Extract the real LAT/DNR/quality-summary block from index.html ----
function extractBlock(html, startMarker, endMarker) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  assert(startIdx >= 0, 'start marker found in index.html: ' + startMarker);
  assert(endIdx > startIdx, 'end marker found after start marker: ' + endMarker);
  return html.slice(startIdx, endIdx);
}

const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8');
const latSource = extractBlock(
  indexHtml,
  '// ===== LAT分析 =====',
  '// ===== 協力会社ダッシュボード ====='
);
// Sanity: this must be the block that actually declares the production
// functions we are about to exercise (fails loudly if index.html is
// restructured and the markers drift).
for (const fn of ['handleDspFile', 'handleDspDrop', 'handleLatFile', 'mergeAndRender', 'renderLatResults']) {
  assert(latSource.includes('function ' + fn), 'index.html LAT block still defines ' + fn + '()');
}

const coreSource = readFileSync(join(repoRoot, 'lat-departure-core.js'), 'utf8');

// ---- Minimal browser stubs ----
function makeFakeElement() {
  return {
    _classes: new Set(),
    classList: {
      add(c) { this.owner._classes.add(c); },
      remove(c) { this.owner._classes.delete(c); },
      contains(c) { return this.owner._classes.has(c); }
    },
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false
  };
}
// wire classList.owner without exposing it via JSON etc.
function newElement() {
  const el = makeFakeElement();
  el.classList.owner = el;
  return el;
}

function buildSandbox() {
  const elements = new Map();
  const alerts = [];
  const domContentLoadedListeners = [];
  const loadListeners = [];
  const localStorageStore = {};

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.alert = (msg) => alerts.push(String(msg));
  sandbox.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  sandbox.Blob = function Blob() {};
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null),
    setItem: (k, v) => { localStorageStore[k] = String(v); },
    removeItem: (k) => { delete localStorageStore[k]; }
  };
  sandbox.document = {
    readyState: 'loading',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, newElement());
      return elements.get(id);
    },
    createElement() { return newElement(); },
    addEventListener(type, cb) {
      if (type === 'DOMContentLoaded') domContentLoadedListeners.push(cb);
    }
  };
  // window 'load' kept only as a legacy fallback path to exercise/prove it is
  // no longer what production actually relies on (see race-condition test).
  sandbox.addEventListener = (type, cb) => {
    if (type === 'load') loadListeners.push(cb);
  };

  // Minimal FileReader: synchronous for test determinism (real browsers are
  // async, but the callback ordering/content is identical).
  sandbox.FileReader = function FileReader() {
    this.onload = null;
    this.onerror = null;
  };
  sandbox.FileReader.prototype.readAsArrayBuffer = function (file) {
    const self = this;
    try {
      const result = file.__buffer;
      if (self.onload) self.onload({ target: { result } });
    } catch (err) {
      if (self.onerror) self.onerror(err);
      else throw err;
    }
  };

  // Minimal XLSX stub: the fixtures are CSV, so we only need CSV-in ->
  // rows-out semantics matching XLSX.utils.sheet_to_json({header:1}).
  sandbox.XLSX = {
    read(data) {
      const text = Buffer.from(data).toString('utf8').replace(/^\uFEFF/, '');
      const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
      const rows = lines.map((l) => l.split(','));
      return { SheetNames: ['Sheet1'], Sheets: { Sheet1: { __rows: rows } } };
    },
    utils: {
      sheet_to_json(ws) {
        return ws.__rows;
      }
    }
  };

  return { sandbox, elements, alerts, loadListeners, domContentLoadedListeners };
}

function makeFakeFile(name, csvText) {
  return { name, __buffer: Buffer.from(csvText, 'utf8') };
}

function loadScripts() {
  const { sandbox, elements, alerts, loadListeners, domContentLoadedListeners } = buildSandbox();
  const context = vm.createContext(sandbox);

  // 1) lat-departure-core.js loads first, in <head>, before the DOM/body
  //    script runs — document.readyState is 'loading', so it must NOT
  //    install the loader yet, only arm the DOMContentLoaded listener.
  vm.runInContext(coreSource, context, { filename: 'lat-departure-core.js' });
  assert(sandbox.__latProductionDspLoaderInstalled !== true, 'loader must not install before DOMContentLoaded');
  assert(domContentLoadedListeners.length === 1, 'core.js registered exactly one DOMContentLoaded listener');
  assert(loadListeners.length === 0, 'core.js must not depend on window load to install the loader');

  // 2) The big inline <script> runs next, declaring the original
  //    handleDspFile/dspRouteMap/mergeAndRender/etc. (still synchronous,
  //    still runs to completion before parsing/DOMContentLoaded can finish).
  const dnrStub = 'var dnrResultData = []; function getTodayJst(){ return "2026-08-21"; } var driverJapaneseNames = {};\n';
  vm.runInContext(dnrStub + latSource, context, { filename: 'index.html#LAT block' });
  assert(typeof sandbox.handleDspFile === 'function', 'inline script defines handleDspFile');
  assert(typeof sandbox.mergeAndRender === 'function', 'inline script defines mergeAndRender');
  const legacyHandleDspFile = sandbox.handleDspFile;

  return { sandbox, elements, alerts, loadListeners, domContentLoadedListeners, legacyHandleDspFile };
}

function runPipeline() {
  const { sandbox, elements, alerts, domContentLoadedListeners } = loadScripts();

  // 3) DOMContentLoaded fires as soon as HTML parsing (incl. running the
  //    synchronous inline <script>) is done — well before window 'load',
  //    which additionally waits for the multi-MB images/video on this page.
  //    This is what installs the hardened production loader in the fixed
  //    code (see lat-departure-core.js, was previously gated on 'load').
  sandbox.document.readyState = 'interactive';
  for (const cb of domContentLoadedListeners) cb();
  assert(sandbox.__latProductionDspLoaderInstalled === true, 'production loader installed at DOMContentLoaded');
  assert(sandbox.handleDspFile !== undefined, 'handleDspFile replaced by production loader');

  // 4) User drops the DSP fixture, then the LAT fixture — via the exact
  //    onchange/ondrop entrypoints used in index.html
  //    (`window.handleDspFile(this.files[0])` / `handleLatFile(file)`).
  const dspCsv = readFileSync(join(repoRoot, 'tests/fixtures/lat-verify/dsp-lat-verify.csv'), 'utf8');
  const latCsv = readFileSync(join(repoRoot, 'tests/fixtures/lat-verify/lat-lat-verify.csv'), 'utf8');

  sandbox.handleDspFile(makeFakeFile('dsp-lat-verify.csv', dspCsv));
  sandbox.handleLatFile(makeFakeFile('lat-lat-verify.csv', latCsv));

  return { sandbox, elements, alerts };
}

// Regression test for the closed race condition: on a slow page (large
// images still downloading), window 'load' has NOT fired yet. Before this
// fix, a DSP upload at this point would still hit the fragile legacy
// handleDspFile (no try/catch, weaker header detection, duplicate parser).
// After this fix, DOMContentLoaded alone is enough to have already swapped
// in the hardened production loader, so the legacy path is unreachable in
// practice.
function runRaceConditionRegressionTest() {
  const { sandbox, domContentLoadedListeners, legacyHandleDspFile } = loadScripts();

  sandbox.document.readyState = 'interactive';
  for (const cb of domContentLoadedListeners) cb();

  assert(sandbox.__latProductionDspLoaderInstalled === true, 'loader installed at DOMContentLoaded (before window load)');
  assert(sandbox.handleDspFile !== legacyHandleDspFile, 'handleDspFile no longer the fragile legacy implementation once DOMContentLoaded has fired, even though window "load" never fired (images still pending)');

  console.log('lat-production-pipeline.test.mjs: race-condition regression test passed (DOMContentLoaded closes the window-load race)');
}

function runTests() {
  const { sandbox, elements, alerts } = runPipeline();

  // handleLatFile always alerts a success count ("LATファイル読込完了: N件");
  // only treat alerts mentioning an error/missing-column condition as failures.
  const errorAlerts = alerts.filter((a) => !/読込完了/.test(a));
  assert(errorAlerts.length === 0, 'no error alerts fired during load: ' + JSON.stringify(alerts));

  // ---- map population ----
  const diag = sandbox.__latDspLoadDiagnosis;
  assert(diag && diag.error === '', 'DSP diagnosis has no error: ' + JSON.stringify(diag && diag.error));
  assert(diag.count === 5, 'DSP diagnosis parsed 5 routes, got ' + (diag && diag.count));
  assert(Object.keys(sandbox.dspRouteMap).length === 5, 'window.dspRouteMap has 5 routes, got ' + Object.keys(sandbox.dspRouteMap).length);

  // ---- latResultData: computed values ----
  const byId = {};
  for (const r of sandbox.latResultData) byId[r.routeId] = r;

  assert(sandbox.latResultData.length === 5, 'latResultData has 5 merged rows, got ' + sandbox.latResultData.length);

  const r001 = byId.R001;
  assert(r001, 'R001 present in latResultData');
  assert(r001.plannedDeparture === '09:00', 'R001 plannedDeparture, got ' + r001.plannedDeparture);
  assert(r001.actualDeparture === '08:55', 'R001 actualDeparture, got ' + r001.actualDeparture);
  assert(r001.diffMin === -5, 'R001 diffMin, got ' + r001.diffMin);
  assert(r001.judgment === '定刻', 'R001 judgment, got ' + JSON.stringify(r001.judgment));

  const r005 = byId.R005;
  assert(r005, 'R005 present in latResultData');
  assert(r005.plannedDeparture === '10:30', 'R005 plannedDeparture, got ' + r005.plannedDeparture);
  assert(r005.actualDeparture === '10:45', 'R005 actualDeparture, got ' + r005.actualDeparture);
  assert(r005.diffMin === 15, 'R005 diffMin, got ' + r005.diffMin);
  assert(r005.judgment === '遅延', 'R005 judgment, got ' + JSON.stringify(r005.judgment));

  // ---- "computed but not rendered" check: DOM actually reflects judgment ----
  const tbody = elements.get('lat-detail-tbody');
  assert(tbody && tbody.innerHTML.length > 0, 'lat-detail-tbody innerHTML populated');
  assert(tbody.innerHTML.indexOf('定刻') >= 0, 'rendered table contains 定刻 badge');
  assert(tbody.innerHTML.indexOf('遅延') >= 0, 'rendered table contains 遅延 badge');
  const totalEl = elements.get('lat-total');
  assert(totalEl.textContent === 5, 'lat-total DOM text reflects 5 rows, got ' + totalEl.textContent);

  console.log('lat-production-pipeline.test.mjs: all tests passed');
  console.log('  R001: plannedDeparture=' + r001.plannedDeparture + ' actualDeparture=' + r001.actualDeparture + ' diffMin=' + r001.diffMin + ' judgment=' + r001.judgment);
  console.log('  R005: plannedDeparture=' + r005.plannedDeparture + ' actualDeparture=' + r005.actualDeparture + ' diffMin=' + r005.diffMin + ' judgment=' + r005.judgment);
}

runTests();
runRaceConditionRegressionTest();
