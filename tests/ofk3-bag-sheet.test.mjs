import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

const Sheet = require('../ofk3-bag-sheet.js');
const Core = require('../cortex-capture-extension/phase1-core.js');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const runner = readFileSync(join(root, 'cortex-capture-extension', 'phase1-runner.js'), 'utf8');
const board = readFileSync(join(root, 'ofk3-time-window-board.js'), 'utf8');
const server = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');
const background = readFileSync(join(root, 'cortex-capture-extension', 'background.js'), 'utf8');
const manifestJson = readFileSync(join(root, 'cortex-capture-extension', 'manifest.json'), 'utf8');

assert(html.indexOf('data-ofk3-bag-driver') >= 0, 'dashboard row opens bag sheet');
assert(html.indexOf('/ofk3-bag-sheet.js?v=20261014-bag2') >= 0, 'bag sheet script');
assert(html.indexOf('id="ofk3-bag-dashboard-import"') >= 0, 'dashboard import button');
assert(html.indexOf('OFK3TimeWindowBoard.onDashboardRender') >= 0, 'time window hook remains');
assert(html.indexOf('function twExtract()') >= 0, 'twExtract remains');
assert(board.indexOf('END_LIMIT_MIN = 780') >= 0, '13:00 board cutoff unchanged');
assert(server.indexOf('cortexPriorityStore[localDate] =') >= 0, 'cycle 1 store assignment remains');
assert(server.indexOf('ofk3-cycle-bag') < 0, 'server has no cycle bag endpoint');
assert(background.indexOf('startCycleBagCapture') < 0, 'background.js untouched by cycle bag');
assert(manifestJson.indexOf('ofk3-bag-sheet') < 0, 'manifest.json has no bag sheet registration');
assert(Sheet.buildPrintHtml.toString().indexOf('cortex-priority') < 0, 'print does not call the priority store');

const sheetSrc = readFileSync(join(root, 'ofk3-bag-sheet.js'), 'utf8');
assert(sheetSrc.indexOf('daNumberMap') < 0, 'does not join on DA alone');
assert(sheetSrc.indexOf('fetch(') < 0, 'print path does not fetch');
assert(sheetSrc.indexOf('A4 portrait') >= 0, 'A4 portrait');
assert(sheetSrc.indexOf('page-break-after:always') >= 0, 'route page break');
assert(sheetSrc.indexOf('荷物詳細を印刷') >= 0, 'print button label');

function da(id) { return { trackingId: id }; }

const assignment = [
  { routeCode: 'DMX1', driverName: '山田 太郎' },
  { routeCode: 'DMX2', driverName: '山田 太郎' },
  { routeCode: 'DSX1', driverName: '山田 太郎' },
  { routeCode: 'DCX9', driverName: '山田 太郎' },
  { routeCode: 'DMX9', driverName: '佐藤 花' }
];
const manifest = {
  DMX1: [da('DA-IN'), da('DA-NULL'), da('DA-OUT'), da('DA-DONE'), da('DA-SAME'), da('DA-<b>')],
  DMX2: [da('DA-SAME')],
  DSX1: [da('DA-LATE')],
  DCX9: [da('DA-C1')],
  DMX9: [da('DA-OTHER')]
};

function sampleDoc() {
  return {
    kind: 'ofk3-cycle-bag',
    version: 1,
    localDate: '2026-10-14',
    routes: [
      {
        routeCode: 'DMX1',
        cycle: 'C2',
        fetched: true,
        packages: [
          { routeCode: 'DMX1', trackingId: 'DA-IN', bagNumber: '4635', bagColor: 'Green', bagColorCode: 'GRN', bagDisplay: 'Green 4635', bagStatus: 'captured', bagSource: 'trDetails' },
          { routeCode: 'DMX1', trackingId: 'DA-NULL', bagStatus: 'captured_null', bagSource: 'trDetails', looseConfirmed: true, packageBlockRead: false },
          { routeCode: 'DMX1', trackingId: 'DA-OUT', bagStatus: 'captured_null', bagSource: 'trDetails', looseConfirmed: true, packageBlockRead: true, stopComplete: false },
          { routeCode: 'DMX1', trackingId: 'DA-DONE', bagStatus: 'captured_null', bagSource: 'trDetails', looseConfirmed: true, packageBlockRead: true, stopComplete: true },
          { routeCode: 'DMX2', trackingId: 'DA-SAME', bagNumber: '9999', bagStatus: 'captured', bagSource: 'trDetails' }
        ]
      },
      {
        routeCode: 'DMX2',
        cycle: 'C2',
        fetched: true,
        packages: [
          { routeCode: 'DMX2', trackingId: 'DA-SAME', bagNumber: '7777', bagColor: 'Yellow', bagStatus: 'captured', bagSource: 'trDetails' }
        ]
      },
      { routeCode: 'DSX1', cycle: 'C3', fetched: false, packages: [] },
      { routeCode: 'DCX9', cycle: 'C1', fetched: true, packages: [{ routeCode: 'DCX9', trackingId: 'DA-C1', bagNumber: '1', bagStatus: 'captured', bagSource: 'trDetails' }] }
    ]
  };
}

Sheet.clearBagSnapshot();
assert(Sheet.classifyPlacement({ bagStatus: 'captured_null', bagSource: 'trDetails', looseConfirmed: true }) === 'unknown', 'captured_null without a package read stays unknown');
assert(Sheet.classifyPlacement({ bagStatus: 'captured_null', looseConfirmed: false, packageBlockRead: true }) === 'unknown', 'captured_null alone stays unknown');
assert(Sheet.classifyPlacement({ bagStatus: 'captured_null', looseConfirmed: true, packageBlockRead: true, stopComplete: true }) === 'unknown', 'completed stop stays unknown');
assert(Sheet.classifyPlacement({ bagStatus: 'captured_null', looseConfirmed: true, packageBlockRead: true, stopComplete: false }) === 'outside', 'explicit unfinished read can be outside');
assert(Sheet.classifyPlacement({ bagStatus: 'captured', bagSource: 'trDetails', bagNumber: '12', looseConfirmed: true, packageBlockRead: true }) === 'in_bag', 'bag number stays in bag');
assert(Sheet.classifyPlacement({ bagStatus: 'not_attempted' }) === 'not_fetched', 'not attempted is not fetched');
assert(Sheet.classifyPlacement({ bagStatus: 'route_aborted' }) === 'not_fetched', 'route abort is not fetched');
assert(Sheet.classifyPlacement({ bagStatus: 'captured_null', bagSource: 'trDetails' }) === 'unknown', 'captured_null is unknown');

const missingAssign = Sheet.buildDriverSheet({
  localDate: '2026-10-14',
  driverName: '山田 太郎',
  assignment: [],
  manifestByRoute: manifest
});
assert(missingAssign.state === 'assignment_missing', 'empty assignment state');
assert(missingAssign.notices[0].indexOf('アサイン未読込') >= 0, 'assignment notice');
assert(Sheet.buildPrintHtml(missingAssign).indexOf('DA-IN') < 0, 'missing assignment prints no DA');

const missingManifest = Sheet.buildDriverSheet({
  localDate: '2026-10-14',
  driverName: '山田 太郎',
  assignment: assignment,
  manifestByRoute: {}
});
assert(missingManifest.state === 'manifest_missing', 'empty manifest state');
assert(missingManifest.notices.join('').indexOf('マニフェスト未読込') >= 0, 'manifest notice');
assert(Sheet.buildPrintHtml(missingManifest).indexOf('DA-IN') < 0, 'missing manifest prints no DA');

const loaded = Sheet.loadBagSnapshot(sampleDoc());
assert(loaded.ok && loaded.routeCount === 3, 'C1 route is not stored, got ' + loaded.routeCount);
const again = Sheet.loadBagSnapshot({
  kind: 'ofk3-cycle-bag',
  version: 1,
  localDate: '2026-10-15',
  routes: [{ routeCode: 'DMX9', cycle: 'C2', fetched: false, packages: [] }]
});
assert(again.ok, 'second date loads');

const sheet = Sheet.buildDriverSheet({
  localDate: '2026-10-14',
  driverName: '山田 太郎',
  assignment: assignment,
  manifestByRoute: manifest
});
assert(sheet.state === 'ok', 'sheet ok');
assert(sheet.routes.map(function (r) { return r.routeCode; }).join(',') === 'DCX9,DMX1,DMX2,DSX1', 'driver routes only');
const dmx1 = sheet.routes.filter(function (r) { return r.routeCode === 'DMX1'; })[0];
assert(dmx1.bagState === 'fetched', 'DMX1 fetched');
assert(dmx1.bags.length === 1 && dmx1.bags[0].bagNumber === '4635', 'DMX1 bag number');
assert(dmx1.bags[0].das.join(',') === 'DA-IN', 'in-bag DA');
assert(dmx1.outside.join(',') === 'DA-OUT', 'outside list ' + dmx1.outside.join(','));
assert(dmx1.undetermined.indexOf('DA-NULL') >= 0, 'null without read is unknown');
assert(dmx1.undetermined.indexOf('DA-DONE') >= 0, 'completed null is unknown');
assert(dmx1.notFetched.indexOf('DA-SAME') >= 0, 'other route bag does not satisfy this route');
assert(dmx1.notFetched.indexOf('DA-<b>') >= 0, 'manifest DA with no bag row is not fetched');
assert(dmx1.undetermined.indexOf('DA-SAME') < 0, 'missing row is not unknown');
assert(dmx1.outside.indexOf('DA-NULL') < 0 && dmx1.outside.indexOf('DA-SAME') < 0, 'outside stays strict');
assert(dmx1.bagCount === 1 && dmx1.itemCount === 6, 'counts');
const dmx2 = sheet.routes.filter(function (r) { return r.routeCode === 'DMX2'; })[0];
assert(dmx2.bags.length === 1 && dmx2.bags[0].bagNumber === '7777', 'DMX2 keeps its own bag');
assert(dmx2.bags[0].das.join(',') === 'DA-SAME', 'same DA stays on DMX2');
const dsx = sheet.routes.filter(function (r) { return r.routeCode === 'DSX1'; })[0];
assert(dsx.bagState === 'not_fetched' && dsx.notice === '未取得', 'unfetched route says 未取得');
assert(dsx.undetermined.length === 0 && dsx.outside.length === 0, 'unfetched is not classified as outside');
const dcx = sheet.routes.filter(function (r) { return r.routeCode === 'DCX9'; })[0];
assert(dcx.bagState === 'out_of_scope' && dcx.notice.indexOf('サイクル1') >= 0, 'cycle 1 stays out of this sheet');

const printed = Sheet.buildPrintHtml(sheet);
assert(printed.indexOf('配送日 2026-10-14') >= 0, 'print date');
assert(printed.indexOf('担当ドライバー 山田 太郎') >= 0, 'print driver');
assert(printed.indexOf('サイクル DMX / C2') >= 0, 'print cycle 2');
assert(printed.indexOf('サイクル DSX / C3') >= 0, 'print cycle 3');
assert(printed.indexOf('BAG数 1 / 商品数 6') >= 0, 'print totals');
assert(printed.indexOf('DA-&lt;b&gt;') >= 0 && printed.indexOf('DA-<b>') < 0, 'DA text is escaped');
var dmx1At = printed.indexOf('<h2>DMX1</h2>');
var dmx2At = printed.indexOf('<h2>DMX2</h2>');
var dmx1Html = printed.slice(dmx1At, dmx2At);
assert(dmx1Html.indexOf('9999') < 0 && dmx1Html.indexOf('7777') < 0, 'DMX1 does not show DMX2 bag numbers');
var outAt = dmx1Html.indexOf('<h3>BAG外</h3>');
var undAt = dmx1Html.indexOf('<h3>不明</h3>');
var missAt = dmx1Html.indexOf('<h3>未取得</h3>');
assert(outAt >= 0 && undAt > outAt && missAt > undAt, 'outside, unknown, and not fetched are separate');
assert(dmx1Html.slice(outAt, undAt).indexOf('DA-OUT') >= 0, 'outside section');
assert(dmx1Html.slice(outAt, undAt).indexOf('DA-NULL') < 0, 'null is not in the outside section');
assert(dmx1Html.slice(undAt, missAt).indexOf('DA-NULL') >= 0, 'null is unknown');
assert(dmx1Html.slice(missAt).indexOf('DA-SAME') >= 0, 'unmatched DA is not fetched');
assert((printed.match(/class="bag-route"/g) || []).length === 4, 'one section per assigned route');
assert(Sheet.printCss().indexOf('A4 portrait') >= 0, 'print css portrait');
assert(Sheet.printCss().indexOf('page-break-after:always') >= 0, 'print css page break');
assert(printed.indexOf('佐藤 花') < 0 && printed.indexOf('DMX9') < 0, 'other driver is absent');

const otherDay = Sheet.buildDriverSheet({
  localDate: '2026-10-13',
  driverName: '山田 太郎',
  assignment: assignment,
  manifestByRoute: manifest,
  bagDocumentDate: '2026-10-14'
});
const otherDmx = otherDay.routes.filter(function (r) { return r.routeCode === 'DMX1'; })[0];
assert(otherDmx.bagState === 'not_fetched' && otherDmx.notice === '未取得', 'other date is not fetched');
assert(otherDay.notices.join('').indexOf('2026-10-14') >= 0, 'other date is named');

const latest = assignment.map(function (row) {
  if (row.routeCode === 'DMX1') return { routeCode: 'DMX1', driverName: '佐藤 花' };
  return row;
});
const afterChange = Sheet.buildDriverSheet({
  localDate: '2026-10-14',
  driverName: '山田 太郎',
  assignment: latest,
  manifestByRoute: manifest
});
assert(afterChange.routes.map(function (r) { return r.routeCode; }).join(',').indexOf('DMX1') < 0, 'reassignment drops the old driver');
const sato = Sheet.buildDriverSheet({
  localDate: '2026-10-14',
  driverName: '佐藤 花',
  assignment: latest,
  manifestByRoute: manifest
});
assert(sato.routes.some(function (r) { return r.routeCode === 'DMX1' && r.bagNumber !== '7777'; }) ||
  sato.routes.filter(function (r) { return r.routeCode === 'DMX1'; })[0].bags[0].bagNumber === '4635', 'new driver sees the route bag');

assert(Sheet.loadBagSnapshot({ kind: 'other' }).ok === false, 'bad file rejected');

const eleven = Core.selectElevenOClockRoutes({
  rmsRouteSummaries: [
    { routeId: 'a', routeCode: 'DCX47', plannedDepartureTime: Date.parse('2026-10-14T11:00:00+09:00') },
    { routeId: 'b', routeCode: 'DMX3', plannedDepartureTime: Date.parse('2026-10-14T09:30:00+09:00') },
    { routeId: 'c', routeCode: 'DSX2', plannedDepartureTime: Date.parse('2026-10-14T14:10:00+09:00') }
  ]
});
assert(eleven.routes.map(function (r) { return r.routeCode; }).join(',') === 'DCX47', '11:00 filter unchanged');
const cycles = Core.selectRoutesByCycle({
  rmsRouteSummaries: [
    { routeId: 'a', routeCode: 'DCX47', plannedDepartureTime: Date.parse('2026-10-14T11:00:00+09:00') },
    { routeId: 'b', routeCode: 'DMX3', plannedDepartureTime: Date.parse('2026-10-14T09:30:00+09:00') },
    { routeId: 'c', routeCode: 'DSX2', plannedDepartureTime: Date.parse('2026-10-14T14:10:00+09:00') },
    { routeId: 'd', routeCode: 'DMMRA1', plannedDepartureTime: Date.parse('2026-10-14T09:00:00+09:00') }
  ]
}, ['C2', 'C3']);
assert(cycles.ok, 'cycle select ok');
assert(cycles.routes.map(function (r) { return r.routeCode; }).join(',') === 'DMX3,DSX2', 'cycle select is DMX/DSX only');

function dropoff(routeCode, ref, da, windowEnd) {
  return {
    rmsRouteDetails: {
      routeId: 'id-' + routeCode,
      routeCode: routeCode,
      localDate: [2026, 10, 14],
      stops: [{
        sequenceNumber: 1,
        status: 'NOT_STARTED',
        tasks: [{
          taskType: 'DROP_OFF',
          referenceId: ref,
          domainMap: { scannableId: da },
          windowStartTime: 1,
          windowEndTime: windowEnd
        }]
      }]
    }
  };
}
const dmx = dropoff('DMX3', 'tr-in', 'DA-IN', 1);
const dcxDetails = dropoff('DCX1', 'tr-c1', 'DA-C1', 1);
assert(Core.selectBagTargets([dmx], {}).targets.length === 0, '13:00 bag targets ignore a non-13:00 DMX stop');
assert(Core.selectCycleBagTargets([dmx, dcxDetails], {}).targets.map(function (t) { return t.referenceId; }).join(',') === 'tr-in', 'cycle targets keep DMX and skip DCX');
const snap = Core.buildCycleBagSnapshot({
  localDate: '2026-10-14',
  routes: [
    { routeId: 'b', routeCode: 'DMX3', cycle: 'C2' },
    { routeId: 'missing', routeCode: 'DSX8', cycle: 'C3' },
    { routeId: 'a', routeCode: 'DCX47', cycle: 'C1' }
  ],
  detailsList: [dmx, dcxDetails],
  trDetailsByTrId: {
    'tr-in': { trId: 'tr-in', bagName: 'JP_OB-AT-4635_GRN' },
    'tr-c1': { trId: 'tr-c1', bagName: 'JP_OB-AT-1_RED' }
  }
});
assert(snap.kind === 'ofk3-cycle-bag', 'snapshot kind');
assert(snap.routes.map(function (r) { return r.routeCode; }).join(',') === 'DMX3,DSX8', 'snapshot omits cycle 1');
assert(snap.routes[0].fetched === true && snap.routes[0].packages[0].bagNumber === '4635', 'snapshot bag number');
assert(snap.routes[0].packages[0].looseConfirmed === false && snap.routes[0].packages[0].packageBlockRead === false, 'capture does not confirm outside');
assert(snap.routes[1].fetched === false && snap.routes[1].packages.length === 0, 'planned route without details stays unfetched');
const merged = Core.mergeCycleBagDocuments(Core.mergeCycleBagDocuments({ byDate: {} }, snap), {
  kind: 'ofk3-cycle-bag',
  localDate: '2026-10-15',
  routes: [{ routeCode: 'DMX1', cycle: 'C2', fetched: false, packages: [] }]
});
assert(merged.byDate['2026-10-14'].routes.DMX3 && merged.byDate['2026-10-15'].routes.DMX1, 'dates stay separate');
assert(!merged.byDate['2026-10-14'].routes.DCX47, 'merge has no cycle 1 route');
const bundle = Core.buildCaptureBundle(Core.createCaptureStore(), { localDate: '2026-10-14' });
assert(!Object.prototype.hasOwnProperty.call(bundle, 'kind'), 'cycle 1 bundle is not a cycle bag document');

const cycleFn = runner.slice(runner.indexOf('  function ensureCycleRouteList('), runner.indexOf('  function onReady('));
assert(cycleFn.indexOf('selectRoutesByCycle') >= 0, 'cycle capture uses the cycle selector');
assert(cycleFn.indexOf('extensionImport') < 0 && cycleFn.indexOf('sendPriorityToOfk3') < 0, 'cycle capture does not send');
assert(cycleFn.indexOf('/cortex-priority/import') < 0, 'cycle capture does not post the priority import');
assert(cycleFn.indexOf('ensureCycleRouteList') >= 0, 'cycle bag returns to the route list');
assert(cycleFn.indexOf('currentPage: false') >= 0, 'cycle bag visits every route');
assert(cycleFn.indexOf('routes = [only]') < 0, 'cycle bag does not keep only the open route');
assert(runner.indexOf('tour.routes = store.summaries ? Core.tourRoutesFromSummaries(store.summaries) : [];') >= 0, '11:00 tour entry remains');
assert(runner.indexOf("mk('取得開始'") >= 0 && runner.indexOf("mk('Bag取得'") >= 0 && runner.indexOf("mk('OFK3へ送信'") >= 0, 'existing buttons remain');

console.log('ofk3-bag-sheet.test.mjs OK');
