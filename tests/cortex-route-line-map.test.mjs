import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Seq = require('../cortex-route-sequence.js');
const MapApi = require('../ofk3-delivery-map.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const mapSrc = readFileSync(join(root, 'ofk3-delivery-map.js'), 'utf8');
const seqSrc = readFileSync(join(root, 'cortex-route-sequence.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function flags(pins) {
  return pins.map(function (p) {
    return p.sequenceNumber + (p.isPriority1300 ? '必達' : '通常');
  }).join(',');
}

var routeStops = [1, 2, 3, 4, 5].map(function (n) {
  return {
    routeCode: 'DCX_TEST',
    driverName: 'Yamada Taro',
    sequenceNumber: n,
    stop: n,
    plannedEndClock: '12:0' + n + ':00',
    address: '福岡' + n,
    latitude: 33.5 + n * 0.01,
    longitude: 130.4 + n * 0.01,
    packageCount: 1
  };
});
var otherStops = [1, 2].map(function (n) {
  return {
    routeCode: 'DCX36',
    driverName: 'Miyahara',
    sequenceNumber: n,
    latitude: 33.56 + n * 0.01,
    longitude: 130.32 + n * 0.01,
    address: '西区' + n,
    packageCount: 1
  };
});
var packages = [
  { routeCode: 'DCX_TEST', stop: 2, trackingId: 'DA2' },
  { routeCode: 'DCX_TEST', stop: 4, trackingId: 'DA4' },
  { routeCode: 'DCX36', stop: 1, trackingId: 'DX1' }
];

var model = Seq.buildRouteSequenceModel(routeStops.concat(otherStops), packages);
assert(model.pins.length === 7, 'multi-route model keeps all stops');

var single = Seq.buildSingleRouteView(model, 'DCX_TEST', { packages: packages, departure: '11:12' });
assert(single.ok === true, 'DCX_TEST single-route view opens');
assert(single.singleRoute === true, 'single-route view contains only the selected route');
assert(flags(single.pins) === '1通常,2必達,3通常,4必達,5通常', 'individual MAP keeps Cortex sequence 1-5');
assert(single.pins.every(function (p) { return p.routeCode === 'DCX_TEST'; }), 'DCX_TEST view excludes DCX36');
assert(single.stats.priorityStopCount === 2 && single.stats.priorityPackageCount === 2, '13:00 flags stay on 2 and 4');
assert(single.stats.departure === '11:12', 'departure is passed through when known');

var dcx36 = Seq.buildSingleRouteView(model, 'DCX36', { packages: packages });
assert(dcx36.ok && dcx36.pins.length === 2, 'DCX36 individual view is 2 stops');
assert(dcx36.pins.every(function (p) { return p.routeCode === 'DCX36'; }), 'DCX36 view excludes DCX_TEST');
assert(Seq.pinsStayOnRoute(dcx36.pins, 'DCX36'), 'LINE payload cannot include other routes');

var preview36 = Seq.buildLinePreview(dcx36, {
  ok: true, userId: 'U36', displayName: '宮原 義', driverKey: 'Miyahara'
});
assert(preview36.canSend === true, 'resolved driver can build LINE preview');
assert(preview36.routeCode === 'DCX36', 'LINE preview is the selected route only');
assert(preview36.text.indexOf('DCX36') >= 0 && preview36.text.indexOf('DCX_TEST') < 0, 'LINE text does not mention other routes');
assert(preview36.text.indexOf('Cortex巡回順') >= 0, 'LINE text names Cortex visit order');

var noSeq = Seq.buildSingleRouteView({ complete: false, pins: [] }, 'DCX36', {});
assert(noSeq.ok === false && noSeq.reason === 'NO_SEQUENCE', 'missing routeStops refuses individual MAP');
assert(noSeq.message.indexOf('v1.6.3') >= 0, 'missing sequence tells user to recapture with Extension v1.6.3');
var noSeqPreview = Seq.buildLinePreview(noSeq, { ok: true, userId: 'U36' });
assert(noSeqPreview.canSend === false, 'LINE send is blocked without sequence');

var missingCoordStops = routeStops.map(function (s, i) {
  if (i !== 4) return s;
  return Object.assign({}, s, { latitude: null, longitude: null });
});
var missingModel = Seq.buildRouteSequenceModel(missingCoordStops, packages);
var missingView = Seq.buildSingleRouteView(missingModel, 'DCX_TEST', { packages: packages });
assert(missingView.ok === true && missingView.coverage.missing === 1 && missingView.coverage.plotted === 4, 'coord gap is counted');
assert(Seq.coverageLabel(missingView.coverage).indexOf('座標未取得1件') >= 0, 'coord gap is labeled');
assert(missingView.plottedPins.length === 4, 'unplottable pin is not silently treated as complete');

var unresolved = Seq.resolveLineSendTarget({
  assignmentDriverName: 'Unknown Driver',
  cortexDriverName: 'Yamada Taro',
  lineMapping: {},
  driverJapaneseNames: {},
  resolveDriverKey: function (n) { return n; }
});
assert(unresolved.ok === false && unresolved.reason === 'UNRESOLVED_DRIVER', 'unknown driver does not auto-send');
var blocked = Seq.buildLinePreview(single, unresolved);
assert(blocked.canSend === false, 'unresolved driver blocks LINE preview');

var resolved = Seq.resolveLineSendTarget({
  assignmentDriverName: 'MIYAHARA YOSHI',
  cortexDriverName: 'Yamada Taro',
  lineMapping: { 'MIYAHARA YOSHI': 'U-MIYA' },
  driverJapaneseNames: { 'MIYAHARA YOSHI': '宮原 義' },
  resolveDriverKey: function (n) { return n; }
});
assert(resolved.ok && resolved.userId === 'U-MIYA' && resolved.displayName === '宮原 義', 'assignment LINE mapping is reused');

assert(MapApi.modes.indexOf('routeSequence') >= 0 && MapApi.defaultMode('dashboard') === 'routeSequence', 'overview routeSequence remains default');
assert(MapApi.defaultMode('tw-extract') === 'allTimeWindow', 'time-window MAP default is unchanged');
assert(mapSrc.indexOf('data-dmap="route-map"') >= 0, 'overview MAP has 個別MAP button');
assert(mapSrc.indexOf('openCortexRouteDeliveryMap') >= 0, 'overview MAP opens existing individual modal');
assert(mapSrc.indexOf('new MutationObserver') < 0 && mapSrc.indexOf('setInterval(') < 0, 'unified MAP still has no observers/polling');
assert(html.indexOf('function openDeliveryMap') >= 0, 'legacy Excel individual MAP remains');
assert(html.indexOf('function sendMapToLine') >= 0, 'legacy LINE send remains');
assert(html.indexOf('function sendCortexRouteMapToLine') >= 0, 'Cortex LINE send reuses map-modal button');
assert(html.indexOf('currentMapSource === \'cortex\'') >= 0, 'LINE send branches without replacing cycle MAP');
assert(html.indexOf('function twRenderMapAsync') >= 0, 'twRenderMapAsync remains');
assert(html.indexOf('id="splash-screen"') >= 0, 'splash remains');
assert(html.indexOf('function isExact1300Clock') < 0, 'index.html does not duplicate 13:00 judgment');
assert(seqSrc.indexOf('buildSingleRouteView') >= 0, 'single-route view lives on the sequence model');

console.log('ok cortex-route-line-map');
