import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Api = require('../ofk3-tw-bulletin-print.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = readFileSync(join(root, 'ofk3-tw-bulletin-print.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

assert(typeof Api.buildBulletinModel === 'function', 'buildBulletinModel exported');
assert(typeof Api.buildBulletinHtml === 'function', 'buildBulletinHtml exported');
assert(typeof Api.open === 'function', 'open exported');
assert(typeof Api.print === 'function', 'print exported');

assert(src.indexOf('new MutationObserver') < 0, 'bulletin has no MutationObserver');
assert(src.indexOf('setInterval(') < 0, 'bulletin has no setInterval');
assert(src.indexOf('windowEndTime') < 0, 'does not reimplement windowEndTime judgment');
assert(src.indexOf('plannedEndTime') < 0, 'does not reimplement plannedEndTime judgment');
assert(src.indexOf('@page{size:A4 landscape') >= 0 || src.indexOf('A4 landscape') >= 0, 'A4 landscape print');

var allDay = Api.parseTimeWindow('08:00-20:00');
assert(allDay && Api.isAllDayWindow(allDay) === true, 'all-day (>=720min) skipped like twExtract');
var tw = Api.parseTimeWindow('09:00-13:00');
assert(tw && tw.endMin === 13 * 60 && Api.isAllDayWindow(tw) === false, '09:00-13:00 is valid TW');

var empty = Api.buildBulletinModel({
  assignmentData: [{ routeCode: 'DCX01', driverName: 'A' }],
  cycleDetailData: {},
  localDate: '2026-09-21'
});
assert(empty.empty === true && empty.message.indexOf('時間指定はありません') >= 0, 'no cycle → empty normal');

var emptyTw = Api.buildBulletinModel({
  assignmentData: [{ routeCode: 'DCX01', driverName: '宮原 義' }],
  cycleDetailData: {
    DCX01: [{ address: '福岡市中央区天神1-1', timeWindow: '08:00-20:00', stop: 1 }]
  },
  localDate: '2026-09-21'
});
assert(emptyTw.empty === true, 'all-day only → empty normal');

function areaFn(addr) {
  if (!addr) return '';
  var m = String(addr).replace(/福岡市\s*/g, '').match(/([\u4e00-\u9fff]+区)([\u4e00-\u9fff]+?)[\d]/);
  return m ? m[2] : '';
}

var model = Api.buildBulletinModel({
  assignmentData: [
    { routeCode: 'DCX36', driverName: '宮原 義' },
    { routeCode: 'DCX41', driverName: '山田 太郎' }
  ],
  cycleDetailData: {
    DCX36: [
      { address: '福岡市中央区天神1-1-1', timeWindow: '09:00-13:00', stop: 2, trackingId: 'TID-SECRET-1' },
      { address: '福岡市中央区天神2-2-2', timeWindow: '09:00-13:00', stop: 2 },
      { address: '福岡市早良区西新3-3', timeWindow: '14:00-16:00', stop: 5 }
    ],
    DCX41: [
      { address: '福岡市西区姪浜1-1', timeWindow: '10:00-12:00', stop: 1 }
    ]
  },
  priorityPackages: [
    { routeCode: 'DCX36', stop: 2, trackingId: 'P1' },
    { routeCode: 'DCX36', stop: 2, trackingId: 'P2' }
  ],
  routeStops: [
    { routeCode: 'DCX36', stop: 2, sequenceNumber: 7 },
    { routeCode: 'DCX36', stop: 5, sequenceNumber: 12 },
    { routeCode: 'DCX41', stop: 1, sequenceNumber: 3 }
  ],
  extractAreaName: areaFn,
  localDate: '2026-09-21'
});

assert(model.empty === false, 'has TW rows');
assert(model.totalRoutes === 2, 'two routes');
assert(model.totalPackages === 4, 'four packages aggregated');
assert(model.hasCortexPriority === true, 'cortex priority flag');
assert(model.hasSequence === true, 'sequence available');

var r36 = model.routes.find(function (r) { return r.routeCode === 'DCX36'; });
assert(r36 && r36.driverName === '宮原 義', 'driver from assignment');
assert(r36.packageCount === 3, 'DCX36 package count');
assert(r36.priorityPackageCount === 2, 'reuses Cortex package count for 13:00');

var htmlOut = Api.buildBulletinHtml(model);
assert(htmlOut.indexOf('OFK3　本日の時間指定一覧') >= 0, 'header title');
assert(htmlOut.indexOf('2026/09/21') >= 0, 'date label');
assert(htmlOut.indexOf('積み込み前に必ず確認してください') >= 0, 'notice');
assert(htmlOut.indexOf('DCX36') >= 0 && htmlOut.indexOf('宮原 義') >= 0, 'route summary');
assert(htmlOut.indexOf('13:00必達') >= 0, 'priority badge');
assert(htmlOut.indexOf('TID-SECRET-1') < 0, 'no tracking id in board');
assert(htmlOut.indexOf('天神1-1-1') < 0, 'no full address');
assert(htmlOut.indexOf('天神') >= 0 || htmlOut.indexOf('西新') >= 0 || htmlOut.indexOf('姪浜') >= 0, 'area only');

var noCortex = Api.buildBulletinModel({
  assignmentData: [{ routeCode: 'DCX10', driverName: '佐藤' }],
  cycleDetailData: {
    DCX10: [{ address: '福岡市中央区天神1', timeWindow: '11:00-15:00', stop: 1 }]
  },
  extractAreaName: areaFn,
  localDate: '2026-09-21'
});
assert(noCortex.empty === false && noCortex.hasCortexPriority === false, 'works without Cortex');
var noCortexHtml = Api.buildBulletinHtml(noCortex);
assert(noCortexHtml.indexOf('13:00必達') < 0, 'no priority badge without Cortex');

var fromTw = Api.buildBulletinModel({
  assignmentData: [{ routeCode: 'DCX99', driverName: 'X' }],
  cycleDetailData: {},
  twExtractedData: [
    { routeCode: 'DCX99', driverName: 'X', timeWindow: '08:00-12:00', address: '福岡市中央区天神1', stop: 4 }
  ],
  extractAreaName: areaFn,
  localDate: '2026-09-21'
});
assert(fromTw.empty === false && fromTw.totalPackages === 1, 'twExtractedData fallback works');

assert(html.indexOf('openTwBulletinBoard()') >= 0, 'dashboard button wired');
assert(html.indexOf('時間指定 詳細・印刷') >= 0, 'button label');
assert(html.indexOf('id="tw-bulletin-modal"') >= 0, 'modal host');
assert(html.indexOf('id="tw-bulletin-content"') >= 0, 'content host');
assert(html.indexOf('/ofk3-tw-bulletin-print.js') >= 0, 'script included');
assert(html.indexOf('function openTwBulletinBoard') >= 0, 'bridge function');
assert(!/new MutationObserver/.test(html.match(/openTwBulletinBoard[\s\S]{0,800}/)[0]), 'bridge has no MutationObserver');

console.log('ok tw-bulletin-print');
