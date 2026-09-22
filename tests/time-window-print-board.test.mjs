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

// ===== Static safety =====
assert(src.indexOf('new MutationObserver') < 0, 'must not construct MutationObserver');
assert(!/observe\s*\(\s*document\.body/.test(src), 'must not observe document.body');
assert(src.indexOf('setInterval(') < 0, 'must not poll DOM with setInterval');
assert(src.indexOf('`') < 0, 'no template literals');
assert(src.indexOf('function buildBoard') >= 0, 'buildBoard exists');
assert(src.indexOf('function openBoard') >= 0, 'openBoard exists');
assert(src.indexOf("ANCHOR_ID = 'ofk3-cortex13-dash-card'") >= 0, 'anchors to fixed cortex card id');
assert(!/\btwExtractedData\b/.test(src), 'must not reference twExtractedData');
assert(!/\btwExtract\s*\(/.test(src), 'must not call twExtract()');
assert(src.indexOf('ALL_DAY_SPAN_MIN') < 0, 'no ALL_DAY_SPAN_MIN');
assert(src.indexOf('isAllDayWindow') < 0, 'no isAllDayWindow');
assert(!/endMin\s*-\s*startMin\s*>=\s*720/.test(src) && !/>=\s*720/.test(src), 'must not exclude by span >=720');
assert(src.indexOf('END_LIMIT_MIN = 780') >= 0, '13:00 cutoff = 780 minutes');
assert(src.indexOf('parsed.endMin <= END_LIMIT_MIN') >= 0, 'filters by endMin <= 780');
assert(src.indexOf('OFK3Cortex13') < 0, 'must not use Cortex for this board');
assert(src.indexOf('getStops') < 0, 'must not read Cortex stops');
assert(src.indexOf('.address') < 0, 'never reads .address (no PII)');
assert(src.indexOf('esc(it.trackingId)') < 0, 'trackingId never escaped into HTML');
assert(!/\.trackingId\b/.test(src), 'does not read trackingId fields');
assert(src.indexOf('A4 landscape') >= 0, 'A4 landscape');
assert(src.indexOf('repeat(3,') >= 0, '3-column grid');
assert(src.indexOf('page-break-inside:avoid') >= 0, 'card page-break avoid');
assert(src.indexOf('13:00までの時間指定があるRouteのみ掲載') >= 0, 'header note for filtered routes');
assert(src.indexOf('totalDeliveries') >= 0 && src.indexOf('allDestinations') >= 0, 'uses assignment totals');

assert(html.indexOf('OFK3TimeWindowBoard.onDashboardRender') >= 0, 'dashboard calls onDashboardRender');
assert(serverSrc.indexOf('/ofk3-time-window-board.js') >= 0, 'server injects script');
assert(injectSrc.indexOf('/ofk3-time-window-board.js') >= 0, 'inject-tenko-audit injects script');
assert(html.indexOf('function twExtract()') >= 0, 'twExtract untouched');
assert(html.indexOf("id=\"tw-end-filter\"") >= 0, 'tw filter UI untouched');

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
    Number: Number,
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

function loadApi(extra) {
  var ctx = makeContext(extra);
  vm.runInContext(src, ctx);
  return { ctx: ctx, api: ctx.window.OFK3TimeWindowBoard };
}

// --- Window filter cases ---
(function () {
  var api = loadApi({
    assignmentData: [{ routeCode: 'DCX10', driverName: 'A', totalDeliveries: 50, allDestinations: 40, area: '城南区' }],
    cycleDetailData: {
      DCX10: [
        { trackingId: 'T1', timeWindow: '05:00-13:00', stop: '' },
        { trackingId: 'T2', timeWindow: '08:00-12:00', stop: '' },
        { trackingId: 'T3', timeWindow: '09:00-13:00', stop: '' },
        { trackingId: 'T4', timeWindow: '12:00-13:00', stop: '' },
        { trackingId: 'T5', timeWindow: '08:00-22:00', stop: '' },
        { trackingId: 'T6', timeWindow: '09:00-17:00', stop: '' },
        { trackingId: 'T7', timeWindow: '12:30-20:30', stop: '' },
        // 720分ちょうどだが終了は12:00 → endMin<=780 なので含む（720除外しない）
        { trackingId: 'T8', timeWindow: '00:00-12:00', stop: '' }
      ]
    },
    routeAreas: {}
  }).api;

  assert(api.isUntil1300(api.parseWindow('05:00-13:00')) === true, '05:00-13:00 included');
  assert(api.isUntil1300(api.parseWindow('08:00-12:00')) === true, '08:00-12:00 included');
  assert(api.isUntil1300(api.parseWindow('09:00-13:00')) === true, '09:00-13:00 included');
  assert(api.isUntil1300(api.parseWindow('08:00-22:00')) === false, '08:00-22:00 excluded');
  assert(api.isUntil1300(api.parseWindow('09:00-17:00')) === false, '09:00-17:00 excluded');

  var board = api.buildBoard();
  assert(board.routeList.length === 1, 'one route with matches');
  assert(board.routeList[0].until1300Count === 5, '5 matching rows (T1-T4 + T8); got ' + board.routeList[0].until1300Count);
  console.log('ok: window filter cases');
})();

// --- Aggregate + totals + hide zero routes + HTML ---
(function () {
  var api = loadApi({
    assignmentData: [
      { routeCode: 'DCX46', driverName: '互 中川', totalDeliveries: 54, allDestinations: 45, area: '城南区神松寺・片江・七隈' },
      { routeCode: 'DCX41', driverName: '山田', totalDeliveries: 30, allDestinations: 28, area: '' },
      { routeCode: 'DCX99', driverName: 'ゼロ', totalDeliveries: 10, allDestinations: 9, area: '西区' }
    ],
    cycleDetailData: {
      DCX46: [
        { trackingId: 'A', timeWindow: '09:00-13:00', stop: '' },
        { trackingId: 'B', timeWindow: '09:00-13:00', stop: '' },
        { trackingId: 'C', timeWindow: '08:00-12:00', stop: '' },
        { trackingId: 'D', timeWindow: '14:00-16:00', stop: '' }
      ],
      DCX41: [
        { trackingId: 'E', timeWindow: '18:00-20:00', stop: '' }
      ],
      DCX99: [
        { trackingId: 'F', timeWindow: '15:00-18:00', stop: '' },
        { trackingId: 'G', timeWindow: '', stop: '' }
      ]
    },
    routeAreas: { DCX41: '鳥飼' }
  }).api;

  var board = api.buildBoard();
  assert(board.routeList.length === 1, 'only DCX46 (until>0); DCX41/99 hidden; got ' + board.routeList.length);
  var r = board.routeList[0];
  assert(r.routeCode === 'DCX46', 'DCX46');
  assert(r.until1300Count === 3, '3 packages until 13:00; got ' + r.until1300Count);
  assert(r.totalDeliveries === 54 && r.allDestinations === 45, 'route totals from assignment');
  assert(r.area === '城南区神松寺・片江・七隈', 'area from assignmentData.area');
  assert(r.driverName === '互 中川', 'driver');

  var htmlOut = api.buildReportHtml(board);
  assert(htmlOut.indexOf('DCX46') >= 0, 'renders route');
  assert(htmlOut.indexOf('13:00まで') >= 0, 'until label');
  assert(htmlOut.indexOf('3') >= 0 && htmlOut.indexOf('個') >= 0, 'count units');
  assert(htmlOut.indexOf('全体 54個 / 45件') >= 0, 'totals line');
  assert(htmlOut.indexOf('※13:00までの時間指定があるRouteのみ掲載') >= 0, 'filter note');
  assert(htmlOut.indexOf('積み込み前に必ず確認してください') >= 0, 'notice');
  assert(htmlOut.indexOf('tw-board-card') >= 0 && htmlOut.indexOf('tw-board-grid') >= 0, 'card grid');
  assert(htmlOut.indexOf('時間帯') < 0, 'no time-band table header');
  assert(htmlOut.indexOf('13:00必達') < 0, 'no cortex badge');
  assert(htmlOut.indexOf('DA') < 0 || htmlOut.indexOf('Tracking') >= 0, 'no tracking ids in body (footer may say Tracking)');
  assert(htmlOut.indexOf('addr') < 0, 'no addresses');
  assert(!/\d+\s*Stop/.test(htmlOut), 'no Stop counts displayed');
  console.log('ok: aggregate / hide zero / html cards');
})();

// --- Area fallback from routeAreas when assignment.area empty ---
(function () {
  var api = loadApi({
    assignmentData: [
      { routeCode: 'DCX01', driverName: 'X', totalDeliveries: 1, allDestinations: 1, area: '' }
    ],
    cycleDetailData: {
      DCX01: [{ trackingId: 'Z', timeWindow: '10:00-12:00', stop: '' }]
    },
    routeAreas: { DCX01: '早良区原' }
  }).api;
  var board = api.buildBoard();
  assert(board.routeList[0].area === '早良区原', 'falls back to routeAreas');
  console.log('ok: routeAreas fallback');
})();

// --- NEED_DATA vs NO_TW empty messages ---
(function () {
  var need = loadApi({
    assignmentData: [],
    cycleDetailData: {},
    routeAreas: {}
  }).api.buildBoard();
  assert(need.emptyReason === 'NEED_DATA', 'missing data reason');
  var needHtml = loadApi({ assignmentData: [], cycleDetailData: {}, routeAreas: {} }).api.buildReportHtml(need);
  assert(needHtml.indexOf('読み込んで') >= 0, 'need-data message');
  assert(needHtml.indexOf('0件') < 0 || needHtml.indexOf('断定') >= 0, 'does not assert zero count');

  var none = loadApi({
    assignmentData: [{ routeCode: 'DCX50', driverName: 'X', totalDeliveries: 5, allDestinations: 4 }],
    cycleDetailData: { DCX50: [{ trackingId: '1', timeWindow: '14:00-16:00', stop: '' }] },
    routeAreas: {}
  }).api;
  var board = none.buildBoard();
  assert(board.emptyReason === 'NO_TW' && board.routeList.length === 0, 'no matching TW');
  var htmlOut = none.buildReportHtml(board);
  assert(htmlOut.indexOf('本日の時間指定（13:00まで）はありません') >= 0, 'empty TW message');
  console.log('ok: empty states');
})();

// --- Cortex presence must not affect counts (module ignores Cortex) ---
(function () {
  var ctx = makeContext({
    assignmentData: [
      { routeCode: 'DCX36', driverName: 'Y', totalDeliveries: 20, allDestinations: 18, area: '別府' }
    ],
    cycleDetailData: {
      DCX36: [
        { trackingId: 'DA1', timeWindow: '09:00-13:00', stop: '1' },
        { trackingId: 'DA2', timeWindow: '15:00-17:00', stop: '2' }
      ]
    },
    routeAreas: {}
  });
  ctx.window.OFK3Cortex13 = {
    getEntry: function () { return { localDate: '2099-01-01', packages: [{}, {}, {}] }; },
    getStops: function () { return [{ routeCode: 'DCX36' }, { routeCode: 'DCX36' }]; }
  };
  vm.runInContext(src, ctx);
  var board = ctx.window.OFK3TimeWindowBoard.buildBoard();
  assert(board.routeList[0].until1300Count === 1, 'Cortex ignored; only Excel TW count');
  var htmlOut = ctx.window.OFK3TimeWindowBoard.buildReportHtml(board);
  assert(htmlOut.indexOf('13:00必達') < 0, 'no cortex UI');
  console.log('ok: cortex ignored');
})();

// --- Boot safety ---
(function () {
  var threw = null;
  try {
    loadApi({ assignmentData: [], cycleDetailData: {}, routeAreas: {} });
  } catch (e) {
    threw = e;
  }
  assert(!threw, 'boot must not throw: ' + (threw && threw.message));
  console.log('ok: boot safety');
})();

console.log('ok time-window-print-board');
