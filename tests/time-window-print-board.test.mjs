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
assert(src.indexOf('getPackageSequenceIndex') >= 0, 'joins packageSequenceIndex');
assert(src.indexOf('getStops') < 0, 'must not read Cortex stops');
assert(src.indexOf('buildBulletinTableHtml') >= 0, 'bulletin table');
assert(src.indexOf('buildDetailHtml') >= 0, 'detail sheet');
assert(src.indexOf('A4 landscape') >= 0, 'A4 landscape');
assert(src.indexOf('totalDeliveries') >= 0 && src.indexOf('allDestinations') >= 0, 'uses assignment totals');
assert(src.indexOf('未取得') >= 0, 'not-captured label');
assert(src.indexOf('照合不可') >= 0, 'no-match label');
assert(src.indexOf('順番なし') >= 0, 'no-seq label');

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

// A. 13:00判定
(function () {
  var api = loadApi({ assignmentData: [], cycleDetailData: {}, routeAreas: {} }).api;
  assert(api.isUntil1300(api.parseWindow('05:00-13:00')) === true, '05:00-13:00');
  assert(api.isUntil1300(api.parseWindow('08:00-12:00')) === true, '08:00-12:00');
  assert(api.isUntil1300(api.parseWindow('09:00-12:30')) === true, '09:00-12:30');
  assert(api.isUntil1300(api.parseWindow('12:00-13:00')) === true, '12:00-13:00');
  assert(api.isUntil1300(api.parseWindow('08:00-22:00')) === false, '08:00-22:00');
  assert(api.isUntil1300(api.parseWindow('12:30-20:30')) === false, '12:30-20:30');
  console.log('ok: 13:00 window cases');
})();

// B+C+D+E+F JOIN / multi-stop / not captured / no match / no seq
(function () {
  var ctx = makeContext({
    assignmentData: [
      { routeCode: 'DCX27', driverName: '勝幸 矢野', totalDeliveries: 54, allDestinations: 45, area: '早良区荒江・原' },
      { routeCode: 'DCX99', driverName: '未取得太郎', totalDeliveries: 30, allDestinations: 28, area: '西区' },
      { routeCode: 'DCX50', driverName: '照合不可花子', totalDeliveries: 20, allDestinations: 18, area: '中央区' }
    ],
    cycleDetailData: {
      DCX27: [
        { trackingId: 'DA-A', timeWindow: '05:00-13:00', address: '福岡市秘密A', stop: '' },
        { trackingId: 'DA-B', timeWindow: '09:00-13:00', address: '福岡市秘密B', stop: '' },
        { trackingId: 'DA-C', timeWindow: '08:00-12:00', address: '福岡市秘密C', stop: '' },
        { trackingId: 'DA-SKIP', timeWindow: '14:00-16:00', address: '対象外', stop: '' }
      ],
      DCX99: [
        { trackingId: 'DA-X', timeWindow: '10:00-12:00', address: '未取得住所', stop: '' }
      ],
      DCX50: [
        { trackingId: 'DA-MISS', timeWindow: '09:00-13:00', address: '照合不可住所', stop: '' },
        { trackingId: 'DA-NOSEQ', timeWindow: '08:00-12:00', address: '順番なし住所', stop: '' }
      ]
    },
    routeAreas: {}
  });
  ctx.window.OFK3Cortex13 = {
    getPackageSequenceIndex: function () {
      return [
        { routeCode: 'DCX27', trackingId: 'DA-A', sequenceNumber: 4 },
        { routeCode: 'DCX27', trackingId: 'DA-B', sequenceNumber: 12 },
        { routeCode: 'DCX27', trackingId: 'DA-C', sequenceNumber: 12 },
        { routeCode: 'DCX50', trackingId: 'DA-OTHER', sequenceNumber: 1 },
        { routeCode: 'DCX50', trackingId: 'DA-NOSEQ', sequenceNumber: null }
      ];
    }
  };
  vm.runInContext(src, ctx);
  var api = ctx.window.OFK3TimeWindowBoard;
  var board = api.buildBoard();
  assert(board.routeList.length === 3, '3 routes with until1300');

  var r27 = board.routeList.find(function (r) { return r.routeCode === 'DCX27'; });
  assert(r27.until1300Count === 3, 'DCX27 packages=3 (skip 14:00)');
  assert(r27.totalDeliveries === 54 && r27.allDestinations === 45, 'assignment totals');
  assert(r27.sequenceLabel === '#4 #12', 'unique sequences sorted; got ' + r27.sequenceLabel);
  assert(r27.packages.filter(function (p) { return p.sequenceNumber === 12; }).length === 2, 'same stop 2 packages');

  var r99 = board.routeList.find(function (r) { return r.routeCode === 'DCX99'; });
  assert(r99.until1300Count === 1, 'not-captured keeps count');
  assert(r99.sequenceLabel === '未取得', 'not captured label');
  assert(r99.packages[0].sequenceLabel === '未取得', 'package not captured');

  var r50 = board.routeList.find(function (r) { return r.routeCode === 'DCX50'; });
  var miss = r50.packages.find(function (p) { return p.trackingId === 'DA-MISS'; });
  var noseq = r50.packages.find(function (p) { return p.trackingId === 'DA-NOSEQ'; });
  assert(miss.sequenceLabel === '照合不可', 'no match');
  assert(noseq.sequenceLabel === '順番なし', 'no seq');

  // G. bulletin HTML has no PII
  var bulletin = api.buildBulletinTableHtml(board);
  assert(bulletin.indexOf('DCX27') >= 0, 'bulletin has route');
  assert(bulletin.indexOf('全体掲示表') >= 0, 'bulletin title');
  assert(bulletin.indexOf('個人詳細票') >= 0, 'detail button');
  assert(bulletin.indexOf('DA-A') < 0, 'bulletin no trackingId');
  assert(bulletin.indexOf('福岡市秘密') < 0, 'bulletin no address');
  assert(bulletin.indexOf('未取得') >= 0, 'bulletin shows 未取得');

  var printBull = api.buildBulletinPrintHtml(board);
  assert(printBull.indexOf('DA-A') < 0 && printBull.indexOf('福岡市秘密') < 0, 'print bulletin no PII');
  assert(printBull.indexOf('tw-board-page') >= 0, 'print pages');

  // H. detail sheet has PII + fields
  var detail = api.buildDetailHtml(board, 'DCX27');
  assert(detail.indexOf('DA-A') >= 0, 'detail DA');
  assert(detail.indexOf('福岡市秘密A') >= 0, 'detail address');
  assert(detail.indexOf('05:00-13:00') >= 0, 'detail timeWindow');
  assert(detail.indexOf('#4') >= 0 && detail.indexOf('#12') >= 0, 'detail sequences');
  assert(detail.indexOf('13:00まで 時間指定詳細') >= 0, 'detail header');

  var cards = api.buildReportHtml(board);
  assert(cards.indexOf('tw-board-card') >= 0, 'cards still available');
  assert(cards.indexOf('DA-A') < 0, 'cards no trackingId');

  console.log('ok: JOIN / multi-stop / labels / PII split');
})();

// NEED_DATA cycle missing message
(function () {
  var api = loadApi({
    assignmentData: [{ routeCode: 'DCX01', driverName: 'X', totalDeliveries: 1, allDestinations: 1 }],
    cycleDetailData: {},
    routeAreas: {}
  }).api;
  var board = api.buildBoard();
  assert(board.emptyReason === 'NEED_DATA', 'need data');
  var htmlOut = api.buildBulletinTableHtml(board);
  assert(htmlOut.indexOf('CYCLEデータ未読込') >= 0, 'cycle missing message');
  console.log('ok: empty cycle message');
})();

// Aggregate hide zero + totals (regression)
(function () {
  var api = loadApi({
    assignmentData: [
      { routeCode: 'DCX46', driverName: '互 中川', totalDeliveries: 54, allDestinations: 45, area: '城南区神松寺・片江・七隈' },
      { routeCode: 'DCX41', driverName: '山田', totalDeliveries: 30, allDestinations: 28, area: '' }
    ],
    cycleDetailData: {
      DCX46: [
        { trackingId: 'A', timeWindow: '09:00-13:00', address: 'addr1', stop: '' },
        { trackingId: 'B', timeWindow: '09:00-13:00', address: 'addr2', stop: '' },
        { trackingId: 'C', timeWindow: '08:00-12:00', address: 'addr3', stop: '' },
        { trackingId: 'D', timeWindow: '14:00-16:00', address: 'addr4', stop: '' }
      ],
      DCX41: [{ trackingId: 'E', timeWindow: '18:00-20:00', address: 'x', stop: '' }]
    },
    routeAreas: { DCX41: '鳥飼' }
  }).api;
  var board = api.buildBoard();
  assert(board.routeList.length === 1, 'only DCX46');
  assert(board.routeList[0].until1300Count === 3, '3 packages');
  assert(board.routeList[0].sequenceLabel === '未取得', 'no cortex → 未取得');
  console.log('ok: aggregate / hide zero');
})();

// Boot safety
(function () {
  var threw = null;
  try {
    loadApi({ assignmentData: [], cycleDetailData: {}, routeAreas: {} });
  } catch (e) { threw = e; }
  assert(!threw, 'boot must not throw: ' + (threw && threw.message));
  console.log('ok: boot safety');
})();

console.log('ok time-window-print-board');
