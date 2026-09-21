import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = readFileSync(join(root, 'ofk3-time-window-board.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');
const injectSrc = readFileSync(join(root, 'inject-tenko-audit.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

// ===== Static safety assertions (mirrors tests/cortex-dashboard-card.test.mjs conventions) =====
assert(src.indexOf('new MutationObserver') < 0, 'must not construct MutationObserver');
assert(!/observe\s*\(\s*document\.body/.test(src), 'must not observe document.body');
assert(src.indexOf('setInterval(') < 0, 'must not poll DOM with setInterval');
assert(src.indexOf('`') < 0, 'no template literals (project rule: string concatenation only, Edge IE-mode compat)');
assert(src.indexOf('function buildBoard') >= 0, 'independent buildBoard aggregator exists');
assert(src.indexOf('function openBoard') >= 0, 'independent openBoard renderer exists');
assert(src.indexOf("ANCHOR_ID = 'ofk3-cortex13-dash-card'") >= 0, 'anchors to existing fixed dashboard card id, not a new DOM scan');
assert(src.indexOf('twExtractedData') < 0, 'must not read/reuse twExtract()\'s filtered output (different filter scope: 13:00/11am/handoff)');
assert(src.indexOf('getStops') >= 0, 'reuses window.OFK3Cortex13.getStops() (already-judged data only)');
assert(!/<=\s*780\b/.test(src) && !/780\s*>=/.test(src), 'must not hardcode a new 13:00(=780min) cutoff comparison; only reuses Cortex-provided results');
assert(src.indexOf('A4 landscape') >= 0, 'print output declares A4 landscape');
assert(src.indexOf('document.write') >= 0, 'print uses the existing popup-window + document.write pattern');
assert(src.indexOf('window.print()') >= 0, 'print window calls window.print()');
assert(src.indexOf("localDate || '') !== todayIso()") >= 0, 'Cortex data is only trusted when localDate matches today (stale data not silently reused)');
assert(src.indexOf('未取得') >= 0, 'has a distinct "not fetched" label, not conflated with 0-count');
assert(src.indexOf('ALL_DAY_SPAN_MIN') < 0, 'must not import twExtract()\'s unsubstantiated "all-day window excluded" (>=720min) rule: no evidence found that a wide window is a "no time window" system default rather than a genuine commitment');
assert(src.indexOf('.address') < 0, 'never reads the .address field (no address/PII rendered on the posted board)');
assert(src.indexOf('esc(g.stop)') >= 0 && src.indexOf('esc(it.trackingId)') < 0, 'trackingId is used only for internal Cortex matching, never rendered');

assert(html.indexOf('OFK3TimeWindowBoard.onDashboardRender') >= 0, 'renderDashboard() refreshes the board button via the same try/catch pattern as Cortex');
assert(serverSrc.indexOf('/ofk3-time-window-board.js') >= 0, 'server injects the new script tag (same pattern as ofk3-cortex-priority-ui.js)');
assert(injectSrc.indexOf('/ofk3-time-window-board.js') >= 0, 'inject-tenko-audit.js (production entrypoint) also injects the new script tag');
assert(serverSrc.indexOf("app.post('/cortex-priority/import'") >= 0, 'existing cortex-priority import API left untouched');
assert(html.indexOf('function twExtract()') >= 0, 'existing twExtract() function body left in place (untouched)');
assert(html.indexOf("id=\"tw-end-filter\"") >= 0, 'existing 時間指定タブ filter UI left in place (untouched)');

// ===== Behavioral test: run the module in a simulated browser-like vm context =====
function makeEl(id) {
  return {
    id: id || '',
    style: {},
    innerHTML: '',
    addEventListener: function () {},
    appendChild: function () {},
    insertAdjacentHTML: function () {},
    getAttribute: function () { return null; },
    classList: { add: function () {}, remove: function () {} }
  };
}

function todayIsoJst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function makeContext(extra) {
  var anchor = makeEl('ofk3-cortex13-dash-card');
  var elements = { 'ofk3-cortex13-dash-card': anchor };
  var doc = {
    readyState: 'complete',
    getElementById: function (id) { return elements[id] || null; },
    createElement: function (tag) { return makeEl('created-' + tag); },
    addEventListener: function () {},
    body: { appendChild: function () {} }
  };
  var ctx = {
    console: console,
    Intl: Intl,
    Math: Math,
    Date: Date,
    Object: Object,
    Array: Array,
    JSON: JSON,
    parseInt: parseInt,
    isFinite: isFinite,
    String: String,
    alert: function () {},
    window: {},
    document: doc
  };
  Object.assign(ctx, extra || {});
  vm.createContext(ctx);
  return ctx;
}

// --- Scenario 1: no Cortex data available at all (module must still work; "未取得" not "0件") ---
(function () {
  var ctx = makeContext({
    assignmentData: [
      { routeCode: 'DCX36', driverName: '宮原 義' },
      { routeCode: 'DCX41', driverName: '○○ ○○' },
      { routeCode: 'DCX99', driverName: 'ノーウィンド' } // has cycle data but no qualifying time windows
    ],
    cycleDetailData: {
      DCX36: [
        { trackingId: 'DA0000000001', address: 'addrA', timeWindow: '9:00-13:00', stop: '1' },
        { trackingId: 'DA0000000002', address: 'addrA2', timeWindow: '9:00-13:00', stop: '1' }, // same Stop + same window -> 1 row, count 2
        { trackingId: 'DA0000000003', address: 'addrB', timeWindow: '14:00-16:00', stop: '5' },
        { trackingId: 'DA0000000004', address: 'addrC', timeWindow: '', stop: '7' }, // no time window -> excluded (empty string only)
        { trackingId: 'DA0000000005', address: 'addrD', timeWindow: '08:00-20:00', stop: '9' } // wide window -> included (no unsubstantiated all-day exclusion)
      ],
      DCX41: [
        { trackingId: 'DA0000000010', address: 'addrE', timeWindow: '18:00-20:00', stop: '2' }
      ],
      DCX99: [
        { trackingId: 'DA0000000099', address: 'addrX', timeWindow: '', stop: '1' }
      ]
    },
    routeAreas: { DCX36: '別府 / 城西団地', DCX41: '' }
  });
  vm.runInContext(src, ctx);
  var api = ctx.window.OFK3TimeWindowBoard;
  assert(api && typeof api.buildBoard === 'function', 'module exposes buildBoard via window.OFK3TimeWindowBoard');

  var board = api.buildBoard();
  assert(board.cortexAvailable === false, 'no Cortex module present -> cortexAvailable false');
  assert(board.routeList.length === 2, 'DCX99 excluded (no qualifying time-window items); got ' + board.routeList.length);

  var dcx36 = board.routeList.filter(function (r) { return r.routeCode === 'DCX36'; })[0];
  assert(dcx36, 'DCX36 present');
  assert(dcx36.stopCount === 3, 'DCX36 stopCount counts distinct stops (1, 5 and 9 - wide window included), not packages; got ' + dcx36.stopCount);
  assert(dcx36.packageCount === 4, 'DCX36 packageCount counts all qualifying DA rows (2+1+1=4), not stops; got ' + dcx36.packageCount);
  assert(dcx36.groups.length === 3, 'DCX36 has 3 groups (Stop1@9-13, Stop5@14-16, Stop9@08:00-20:00); got ' + dcx36.groups.length);
  var stop1Group = dcx36.groups.filter(function (g) { return g.stop === '1'; })[0];
  assert(stop1Group && stop1Group.count === 2, 'same Stop + same time window collapses into one row with count=2 (no meaningless duplicate rows)');
  var stop9Group = dcx36.groups.filter(function (g) { return g.stop === '9'; })[0];
  assert(stop9Group && stop9Group.count === 1 && stop9Group.label === '08:00〜20:00', 'a wide (>=12h) window is NOT excluded: no evidence it is a "no time window" system default rather than a genuine commitment');
  assert(dcx36.area === '別府 / 城西団地', 'area comes from routeAreas[routeCode] as-is, no new address parsing');
  assert(dcx36.cortexStopCount === null, 'Cortex not fetched -> cortexStopCount is null, never coerced to 0');

  var dcx41 = board.routeList.filter(function (r) { return r.routeCode === 'DCX41'; })[0];
  assert(dcx41.area === '-', 'empty routeAreas value falls back to "-" (safe fallback, no address-based guess)');

  var reportHtml = ctx.window.OFK3TimeWindowBoard.print && true; // print() opens window.open which is undefined in vm; just sanity that fn exists
  assert(typeof api.print === 'function', 'print function exists');
  console.log('ok: scenario 1 (no Cortex data) - Stop/Package counts correct, area fallback correct, cortexStopCount=null');
})();

// --- Scenario 2: Cortex data available for today, including a route with genuinely zero matches ---
(function () {
  var today = todayIsoJst();
  var ctx = makeContext({
    assignmentData: [
      { routeCode: 'DCX36', driverName: '宮原 義' },
      { routeCode: 'DCX41', driverName: '○○ ○○' }
    ],
    cycleDetailData: {
      DCX36: [
        { trackingId: 'DA0000000001', address: 'addrA', timeWindow: '9:00-13:00', stop: '1' },
        { trackingId: 'DA0000000003', address: 'addrB', timeWindow: '14:00-16:00', stop: '5' }
      ],
      DCX41: [
        { trackingId: 'DA0000000010', address: 'addrE', timeWindow: '18:00-20:00', stop: '2' }
      ]
    },
    routeAreas: { DCX36: '別府', DCX41: '鳥飼' }
  });
  ctx.window.OFK3Cortex13 = {
    getEntry: function () { return { localDate: today }; },
    getStops: function () {
      return [
        { routeCode: 'DCX36', stop: '1', trackingIds: ['DA0000000001'] }
      ];
    }
  };
  vm.runInContext(src, ctx);
  var api = ctx.window.OFK3TimeWindowBoard;
  var board = api.buildBoard();
  assert(board.cortexAvailable === true, 'Cortex entry matches today -> cortexAvailable true');

  var dcx36 = board.routeList.filter(function (r) { return r.routeCode === 'DCX36'; })[0];
  assert(dcx36.cortexStopCount === 1, 'DCX36 has 1 Cortex-confirmed stop; got ' + dcx36.cortexStopCount);
  var stop1Group = dcx36.groups.filter(function (g) { return g.stop === '1'; })[0];
  assert(stop1Group.cortexHit === true, 'Stop1 row is flagged via existing Cortex trackingId match (no new 13:00 judgment)');
  var stop5Group = dcx36.groups.filter(function (g) { return g.stop === '5'; })[0];
  assert(stop5Group.cortexHit === false, 'Stop5 not in Cortex results -> not flagged');

  var dcx41 = board.routeList.filter(function (r) { return r.routeCode === 'DCX41'; })[0];
  assert(dcx41.cortexStopCount === 0, 'DCX41: Cortex fetched but genuinely 0 matches -> 0 (distinct from null/not-fetched)');

  console.log('ok: scenario 2 (Cortex available) - per-route Stop counts and per-row trackingId match correct, fetched-0 != not-fetched');
})();

// --- Scenario 3: zero time-window data anywhere today -> "no data" state, not an error ---
(function () {
  var ctx = makeContext({
    assignmentData: [{ routeCode: 'DCX50', driverName: 'X' }],
    cycleDetailData: { DCX50: [{ trackingId: 'DA1', address: 'a', timeWindow: '', stop: '1' }] },
    routeAreas: {}
  });
  vm.runInContext(src, ctx);
  var board = ctx.window.OFK3TimeWindowBoard.buildBoard();
  assert(board.routeList.length === 0, 'no qualifying time windows anywhere -> empty routeList (rendered as "no data today", not an error)');
  console.log('ok: scenario 3 (zero time-window data) - empty routeList, no throw');
})();

// --- Scenario 4: boot() must not throw even with a minimal/partial DOM (app startup must never be blocked) ---
(function () {
  var ctx = makeContext({ assignmentData: [], cycleDetailData: {}, routeAreas: {} });
  ctx.document.readyState = 'complete';
  var threw = null;
  try {
    vm.runInContext(src, ctx);
  } catch (e) {
    threw = e;
  }
  assert(!threw, 'module must not throw during boot even with empty data: ' + (threw && threw.message));
  console.log('ok: scenario 4 (boot safety) - module loads without throwing');
})();

console.log('ok time-window-print-board');
