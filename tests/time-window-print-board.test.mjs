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
const cortexUiSrc = readFileSync(join(root, 'ofk3-cortex-priority-ui.js'), 'utf8');

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
assert(src.indexOf('getPackageSequenceIndex') >= 0, 'joins packageSequenceIndex');
assert(src.indexOf('getPriorityPackages') >= 0, 'reads Cortex priority packages');
assert(src.indexOf('getStops') < 0, 'must not read Cortex stops');
assert(src.indexOf('buildBulletinTableHtml') >= 0, 'bulletin table');
assert(src.indexOf('buildDetailHtml') >= 0, 'detail sheet');
assert(src.indexOf('A4 landscape') >= 0, 'A4 landscape');
assert(src.indexOf('totalDeliveries') >= 0 && src.indexOf('allDestinations') >= 0, 'uses assignment totals');
assert(src.indexOf('未取得') >= 0, 'not-captured label');
assert(src.indexOf('照合不可') >= 0, 'no-match label');
assert(src.indexOf('順番なし') >= 0, 'no-seq label');
assert(cortexUiSrc.indexOf('getPackages:') >= 0, 'OFK3Cortex13.getPackages exported');

assert(html.indexOf('OFK3TimeWindowBoard.onDashboardRender') >= 0, 'dashboard calls onDashboardRender');
assert(serverSrc.indexOf('/ofk3-time-window-board.js') >= 0, 'server injects script');
assert(injectSrc.indexOf('/ofk3-time-window-board.js') >= 0, 'inject-tenko-audit injects script');
assert(serverSrc.indexOf('?v=20260923-driveraid') >= 0, 'cache bust driver aid');
assert(injectSrc.indexOf('?v=20260923-driveraid') >= 0, 'inject cache bust driver aid');
assert(src.indexOf('Driver Aid') >= 0, 'detail sheet has Driver Aid column');
assert(src.indexOf('getPackageAssistIndex') >= 0, 'reads packageAssistIndex');
assert(src.indexOf('bagInnerNumber') < 0, 'no bagInnerNumber naming');
assert(cortexUiSrc.indexOf('getPackageAssistIndex') >= 0, 'OFK3Cortex13.getPackageAssistIndex exported');
assert(src.indexOf('BULLETIN_ROWS_PER_PAGE') < 0, 'no artificial bulletin row pagination');
assert(src.indexOf('buildBulletinPrintHeaderHtml') >= 0, 'compact print header');
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

// A. CYCLE window helper (still used for uncaptured routes)
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

// Captured route: Cortex priority is authoritative; CYCLE-only extras excluded
(function () {
  var ctx = makeContext({
    assignmentData: [
      { routeCode: 'DCX47', driverName: '昌巧 金子', totalDeliveries: 100, allDestinations: 80, area: '西区' },
      { routeCode: 'DCX99', driverName: '未取得太郎', totalDeliveries: 30, allDestinations: 28, area: '西区' },
      { routeCode: 'DCX50', driverName: '照合不可花子', totalDeliveries: 20, allDestinations: 18, area: '中央区' }
    ],
    cycleDetailData: {
      DCX47: [
        { trackingId: 'DA-P1', timeWindow: '05:00-13:00', address: '福岡市秘密A' },
        { trackingId: 'DA-P2', timeWindow: '05:00-13:00', address: '福岡市秘密B' },
        { trackingId: 'DA-P2b', timeWindow: '05:00-13:00', address: '福岡市秘密B2' },
        { trackingId: 'DA-CYCLE-ONLY', timeWindow: '08:00-12:00', address: 'CYCLEのみ過剰' },
        { trackingId: 'DA-CYCLE-13', timeWindow: '09:00-13:00', address: 'CYCLE13だがpriority外' },
        { trackingId: 'DA-LATE', timeWindow: '14:00-16:00', address: '対象外' }
      ],
      DCX99: [
        { trackingId: 'DA-X', timeWindow: '10:00-12:00', address: '未取得住所' }
      ],
      DCX50: [
        { trackingId: 'DA-MISS', timeWindow: '09:00-13:00', address: '照合不可住所' },
        { trackingId: 'DA-NOSEQ', timeWindow: '08:00-12:00', address: '順番なし住所' }
      ]
    },
    routeAreas: {}
  });
  ctx.window.OFK3Cortex13 = {
    getPackageSequenceIndex: function () {
      return [
        { routeCode: 'DCX47', trackingId: 'DA-P1', sequenceNumber: 9 },
        { routeCode: 'DCX47', trackingId: 'DA-P2', sequenceNumber: 25 },
        { routeCode: 'DCX47', trackingId: 'DA-P2b', sequenceNumber: 25 },
        { routeCode: 'DCX47', trackingId: 'DA-CYCLE-ONLY', sequenceNumber: 40 },
        { routeCode: 'DCX47', trackingId: 'DA-CYCLE-13', sequenceNumber: 50 },
        { routeCode: 'DCX50', trackingId: 'DA-OTHER', sequenceNumber: 1 },
        { routeCode: 'DCX50', trackingId: 'DA-NOSEQ', sequenceNumber: null }
      ];
    },
    getPackages: function () {
      // Simulated Cortex priority: exact 13:00 windowEnd + plannedEnd <= 13:00
      return [
        { routeCode: 'DCX47', trackingId: 'DA-P1' },
        { routeCode: 'DCX47', trackingId: 'DA-P2' },
        { routeCode: 'DCX47', trackingId: 'DA-P2b' }
      ];
    }
  };
  vm.runInContext(src, ctx);
  var api = ctx.window.OFK3TimeWindowBoard;
  var board = api.buildBoard();

  var r47 = board.routeList.find(function (r) { return r.routeCode === 'DCX47'; });
  assert(r47, 'DCX47 present');
  assert(r47.until1300Count === 3, 'captured uses priority count=3, got ' + r47.until1300Count);
  assert(r47.packages.every(function (p) {
    return p.trackingId === 'DA-P1' || p.trackingId === 'DA-P2' || p.trackingId === 'DA-P2b';
  }), 'CYCLE-only / priority-out excluded');
  assert(r47.sequenceLabel === '#9 #25', 'unique sequences; got ' + r47.sequenceLabel);
  assert(r47.packages.filter(function (p) { return p.sequenceNumber === 25; }).length === 2, 'same stop 2 packages');

  var bulletin = api.buildBulletinTableHtml(board);
  var detail = api.buildDetailHtml(board, 'DCX47');
  assert(bulletin.indexOf('DA-P1') < 0 && bulletin.indexOf('福岡市秘密') < 0, 'bulletin no PII');
  assert(detail.indexOf('DA-P1') >= 0 && detail.indexOf('福岡市秘密A') >= 0, 'detail has PII');
  assert(detail.indexOf('DA-CYCLE-ONLY') < 0, 'detail excludes non-priority');
  assert(detail.indexOf('DA-P2b') >= 0, 'detail includes both same-stop packages');

  // bulletin count text and detail share same package set size
  assert(bulletin.indexOf('>3個<') >= 0 || bulletin.indexOf('3個') >= 0, 'bulletin shows 3');
  assert(detail.indexOf('13:00まで:') >= 0 && detail.indexOf('3個') >= 0, 'detail count matches board');

  var r99 = board.routeList.find(function (r) { return r.routeCode === 'DCX99'; });
  assert(r99.until1300Count === 1, 'uncaptured keeps CYCLE end<=13:00 count');
  assert(r99.sequenceLabel === '未取得', 'uncaptured label');

  var r50 = board.routeList.find(function (r) { return r.routeCode === 'DCX50'; });
  assert(!r50, 'captured route with zero priority packages hidden (not 0件混同)');

  console.log('ok: priority filter / multi-stop / PII / uncaptured fallback');
})();

// windowEnd 14:00 / non-priority never included on captured route
(function () {
  var ctx = makeContext({
    assignmentData: [{ routeCode: 'DCX40', driverName: 'A', totalDeliveries: 10, allDestinations: 8 }],
    cycleDetailData: {
      DCX40: [
        { trackingId: 'IN', timeWindow: '05:00-13:00', address: 'a' },
        { trackingId: 'OUT14', timeWindow: '14:00-16:00', address: 'b' },
        { trackingId: 'OUT12', timeWindow: '08:00-12:00', address: 'c' }
      ]
    },
    routeAreas: {}
  });
  ctx.window.OFK3Cortex13 = {
    getPackageSequenceIndex: function () {
      return [
        { routeCode: 'DCX40', trackingId: 'IN', sequenceNumber: 3 },
        { routeCode: 'DCX40', trackingId: 'OUT14', sequenceNumber: 90 },
        { routeCode: 'DCX40', trackingId: 'OUT12', sequenceNumber: 91 }
      ];
    },
    getPackages: function () {
      return [{ routeCode: 'DCX40', trackingId: 'IN' }];
    }
  };
  vm.runInContext(src, ctx);
  var board = ctx.window.OFK3TimeWindowBoard.buildBoard();
  assert(board.routeList[0].until1300Count === 1, 'only priority IN');
  assert(board.routeList[0].packages[0].trackingId === 'IN', 'IN only');
  console.log('ok: exclude non-priority on captured');
})();

// NEED_DATA / empty cortex store: uncaptured CYCLE path still works
(function () {
  var api = loadApi({
    assignmentData: [
      { routeCode: 'DCX46', driverName: '互 中川', totalDeliveries: 54, allDestinations: 45, area: '城南区' },
      { routeCode: 'DCX41', driverName: '山田', totalDeliveries: 30, allDestinations: 28, area: '' }
    ],
    cycleDetailData: {
      DCX46: [
        { trackingId: 'A', timeWindow: '09:00-13:00', address: 'addr1' },
        { trackingId: 'B', timeWindow: '09:00-13:00', address: 'addr2' },
        { trackingId: 'C', timeWindow: '08:00-12:00', address: 'addr3' },
        { trackingId: 'D', timeWindow: '14:00-16:00', address: 'addr4' }
      ],
      DCX41: [{ trackingId: 'E', timeWindow: '18:00-20:00', address: 'x' }]
    },
    routeAreas: { DCX41: '鳥飼' }
  }).api;
  var board = api.buildBoard();
  assert(board.routeList.length === 1, 'only DCX46');
  assert(board.routeList[0].until1300Count === 3, 'no cortex → CYCLE provisional count');
  assert(board.routeList[0].sequenceLabel === '未取得', 'no cortex → 未取得');
  console.log('ok: empty cortex provisional CYCLE');
})();

(function () {
  var api = loadApi({
    assignmentData: [{ routeCode: 'DCX01', driverName: 'X', totalDeliveries: 1, allDestinations: 1 }],
    cycleDetailData: {},
    routeAreas: {}
  }).api;
  var board = api.buildBoard();
  assert(board.emptyReason === 'NEED_DATA', 'need data');
  assert(api.buildBulletinTableHtml(board).indexOf('CYCLEデータ未読込') >= 0, 'cycle missing message');
  console.log('ok: empty cycle message');
})();

(function () {
  var threw = null;
  try {
    loadApi({ assignmentData: [], cycleDetailData: {}, routeAreas: {} });
  } catch (e) { threw = e; }
  assert(!threw, 'boot must not throw: ' + (threw && threw.message));
  console.log('ok: boot safety');
})();

// Print layout: continuous table, single title, no forced page-break chunks
(function () {
  var assignmentData = [];
  var cycleDetailData = {};
  var i;
  for (i = 1; i <= 22; i++) {
    var code = 'DCX' + (40 + i);
    assignmentData.push({
      routeCode: code,
      driverName: 'Driver' + i,
      totalDeliveries: 50 + i,
      allDestinations: 40 + i,
      area: '西区'
    });
    cycleDetailData[code] = [
      { trackingId: 'T' + i + 'a', timeWindow: '05:00-13:00', address: 'addr-secret-' + i },
      { trackingId: 'T' + i + 'b', timeWindow: '08:00-12:00', address: 'addr-secret-b-' + i }
    ];
  }
  var api = loadApi({
    assignmentData: assignmentData,
    cycleDetailData: cycleDetailData,
    routeAreas: {}
  }).api;
  var board = api.buildBoard();
  assert(board.routeList.length === 22, '22 routes for print sample');
  var printHtml = api.buildBulletinPrintHtml(board);
  assert(printHtml.indexOf('tw-bulletin-print') >= 0, 'print root class');
  assert(printHtml.indexOf('tw-board-print-header') >= 0, 'compact print header present');
  assert((printHtml.match(/tw-board-print-header/g) || []).length === 1, 'title block once only');
  assert(printHtml.indexOf('tw-board-page') < 0, 'no artificial print pages');
  assert((printHtml.match(/<table class="tw-bulletin-table">/g) || []).length === 1, 'single continuous table');
  assert((printHtml.match(/<tbody>/g) || []).length === 1, 'single tbody');
  assert((printHtml.match(/<\/tr>/g) || []).length >= 23, 'thead + 22 data rows');
  assert(printHtml.indexOf('addr-secret') < 0, 'print bulletin no address PII');
  assert(printHtml.indexOf('T1a') < 0, 'print bulletin no tracking PII');
  board.routeList.forEach(function (r) {
    assert(printHtml.indexOf(r.routeCode) >= 0, 'route present: ' + r.routeCode);
    assert(printHtml.indexOf(r.sequenceLabel) >= 0, 'sequence present for ' + r.routeCode);
  });

  // printBulletin CSS must not force page-break after artificial pages
  var cssSrc = src.slice(src.indexOf('function printBulletin'), src.indexOf('function printCards'));
  assert(cssSrc.indexOf('break-after:page') < 0, 'bulletin print CSS no forced page break');
  assert(cssSrc.indexOf('page-break-after:always') < 0, 'bulletin print CSS no always page-break');
  assert(cssSrc.indexOf('A4 landscape') >= 0, 'A4 landscape kept');
  assert(cssSrc.indexOf('thead{display:table-header-group;}') >= 0, 'thead repeats across pages');
  assert(cssSrc.indexOf('break-inside:avoid') >= 0, 'rows avoid split');

  // cards path still uses page chunks (untouched)
  assert(src.indexOf("buildPageHeaderHtml(board, 'カード掲示')") >= 0, 'card print header kept');
  assert(src.indexOf('printCards') >= 0 && src.indexOf('break-after:page') >= 0, 'card print page-break kept');
  console.log('ok: print continuous table / single header / no forced break');
})();

// F–I: personal detail sheet Driver Aid / bag from packageAssistIndex
(function () {
  var ctx = makeContext({
    assignmentData: [
      { routeCode: 'DCX40', driverName: 'Aid太郎', totalDeliveries: 40, allDestinations: 30, area: '西区' }
    ],
    cycleDetailData: {
      DCX40: [
        { trackingId: 'DA0012408732', timeWindow: '05:00-13:00', address: '福岡市Aid' },
        { trackingId: 'DA0012405022', timeWindow: '05:00-13:00', address: '福岡市Bag' },
        { trackingId: 'DA-NOASSIST', timeWindow: '05:00-13:00', address: '福岡市なし' }
      ]
    },
    routeAreas: {}
  });
  ctx.window.OFK3Cortex13 = {
    getPackageSequenceIndex: function () {
      return [
        { routeCode: 'DCX40', trackingId: 'DA0012408732', sequenceNumber: 16 },
        { routeCode: 'DCX40', trackingId: 'DA0012405022', sequenceNumber: 17 },
        { routeCode: 'DCX40', trackingId: 'DA-NOASSIST', sequenceNumber: 18 }
      ];
    },
    getPackages: function () {
      return [
        { routeCode: 'DCX40', trackingId: 'DA0012408732' },
        { routeCode: 'DCX40', trackingId: 'DA0012405022' },
        { routeCode: 'DCX40', trackingId: 'DA-NOASSIST' }
      ];
    },
    getPackageAssistIndex: function () {
      return [
        {
          routeCode: 'DCX40',
          trackingId: 'DA0012408732',
          referenceId: 'tr-aid',
          driverAid: '649',
          bagDisplay: null
        },
        {
          routeCode: 'DCX40',
          trackingId: 'DA0012405022',
          referenceId: 'tr-bag',
          driverAid: '652',
          bagDisplay: '黄色 1956'
        }
      ];
    }
  };
  vm.runInContext(src, ctx);
  var api = ctx.window.OFK3TimeWindowBoard;
  var board = api.buildBoard();
  assert(board.routeList.length === 1 && board.routeList[0].until1300Count === 3, 'priority count unchanged with assist');
  var pkgs = board.routeList[0].packages;
  var aidOnly = pkgs.find(function (p) { return p.trackingId === 'DA0012408732'; });
  var withBag = pkgs.find(function (p) { return p.trackingId === 'DA0012405022'; });
  var none = pkgs.find(function (p) { return p.trackingId === 'DA-NOASSIST'; });
  assert(aidOnly && aidOnly.driverAid === '649' && aidOnly.bagDisplay == null, 'F: driverAid joined');
  assert(withBag && withBag.driverAid === '652' && withBag.bagDisplay === '黄色 1956', 'H: bag joined');
  assert(none && none.driverAid == null && none.bagDisplay == null, 'missing assist → null fields');

  var detail = api.buildDetailHtml(board, 'DCX40');
  assert(detail.indexOf('Driver Aid') >= 0 && detail.indexOf('バッグ') >= 0, 'detail columns present');
  assert(detail.indexOf('649') >= 0, 'F: Driver Aid shown');
  assert(detail.indexOf('黄色 1956') >= 0, 'H: bag display shown');
  // G: bag missing → "-" (not N/A)
  assert(detail.indexOf('N/A') < 0, 'G: no N/A label');
  assert(detail.indexOf('>−<') >= 0 || detail.indexOf('>-</') >= 0 || detail.indexOf('>-</td>') >= 0 ||
    /DA-NOASSIST[\s\S]{0,200}>-</.test(detail) || detail.indexOf('-</td>') >= 0,
    'G: dash for missing bag/aid');

  var bulletin = api.buildBulletinTableHtml(board);
  assert(bulletin.indexOf('649') < 0 && bulletin.indexOf('黄色') < 0 && bulletin.indexOf('DA001240') < 0,
    'bulletin has no DA/Driver Aid/bag');
  assert(bulletin.indexOf('Driver Aid') < 0 && bulletin.indexOf('バッグ') < 0, 'bulletin no assist headers');

  // I: old payload — no getPackageAssistIndex
  var ctx2 = makeContext({
    assignmentData: [
      { routeCode: 'DCX40', driverName: '旧', totalDeliveries: 10, allDestinations: 8, area: '西区' }
    ],
    cycleDetailData: {
      DCX40: [{ trackingId: 'DA-OLD', timeWindow: '05:00-13:00', address: '旧住所' }]
    },
    routeAreas: {}
  });
  ctx2.window.OFK3Cortex13 = {
    getPackageSequenceIndex: function () {
      return [{ routeCode: 'DCX40', trackingId: 'DA-OLD', sequenceNumber: 1 }];
    },
    getPackages: function () {
      return [{ routeCode: 'DCX40', trackingId: 'DA-OLD' }];
    }
  };
  vm.runInContext(src, ctx2);
  var api2 = ctx2.window.OFK3TimeWindowBoard;
  var board2 = api2.buildBoard();
  assert(board2.routeList[0].packages[0].driverAid == null, 'I: no assist → null driverAid');
  var detail2 = api2.buildDetailHtml(board2, 'DCX40');
  assert(detail2.indexOf('DA-OLD') >= 0 && detail2.indexOf('旧住所') >= 0, 'I: detail still renders');
  assert(detail2.indexOf('Driver Aid') >= 0, 'I: columns present');
  console.log('ok: detail Driver Aid / bag / old payload');
})();

console.log('ok time-window-print-board');
