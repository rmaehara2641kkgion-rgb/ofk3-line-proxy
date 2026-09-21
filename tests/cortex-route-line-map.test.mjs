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

var previewNoImage = Seq.buildLinePreview(dcx36, {
  ok: true, userId: 'U36', displayName: '宮原 義', driverKey: 'Miyahara'
});
assert(previewNoImage.canSend === false, 'text-only LINE payload is not treated as success');
assert(!previewNoImage.messages || previewNoImage.messages.length === 0, 'text-only payload has no LINE messages');
assert(previewNoImage.text.indexOf('DCX36') >= 0 && previewNoImage.text.indexOf('DCX_TEST') < 0, 'LINE text does not mention other routes');
assert(previewNoImage.text.indexOf('Cortex巡回順') >= 0, 'LINE text names Cortex visit order');

var dataUrlBlocked = Seq.buildLinePreview(dcx36, {
  ok: true, userId: 'U36', displayName: '宮原 義', driverKey: 'Miyahara'
}, { imageUrl: 'data:image/png;base64,AAAA' });
assert(dataUrlBlocked.canSend === false, 'data URL is not sent to LINE Messaging API');

var httpBlocked = Seq.buildLinePreview(dcx36, {
  ok: true, userId: 'U36', displayName: '宮原 義', driverKey: 'Miyahara'
}, { imageUrl: 'http://127.0.0.1:3016/map-image/abc' });
assert(httpBlocked.canSend === false, 'non-HTTPS image URL is rejected');

var preview36 = Seq.buildLinePreview(dcx36, {
  ok: true, userId: 'U36', displayName: '宮原 義', driverKey: 'Miyahara'
}, { imageUrl: 'https://ofk3-line-proxy-1.onrender.com/map-image/dcx36test' });
assert(preview36.canSend === true, 'resolved driver + HTTPS map image can send');
assert(preview36.routeCode === 'DCX36', 'LINE preview is the selected route only');
assert(preview36.imageUrl && preview36.imageUrl.indexOf('https://') === 0, 'image URL is not empty');
assert(Array.isArray(preview36.messages) && preview36.messages.length === 2, 'LINE payload is text + image');
assert(preview36.messages[0].type === 'text' && preview36.messages[1].type === 'image', 'message types are text then image');
assert(preview36.messages[1].originalContentUrl === preview36.imageUrl, 'image message has originalContentUrl');
assert(preview36.messages[1].previewImageUrl === preview36.imageUrl, 'image message has previewImageUrl');
assert(preview36.messages.every(function (m) {
  return !m.text || (m.text.indexOf('DCX36') >= 0 && m.text.indexOf('DCX_TEST') < 0);
}), 'LINE payload stays on DCX36');
assert(Seq.lineImagePins(dcx36).every(function (p) { return p.routeCode === 'DCX36'; }), 'LINE image pins stay on selected route');
assert(Seq.lineImagePins(single).every(function (p) { return p.routeCode === 'DCX_TEST'; }), 'DCX_TEST image pins exclude DCX36');

var failPublish = Seq.buildLinePreview(dcx36, {
  ok: true, userId: 'U36', displayName: '宮原 義'
}, { imageUrl: '' });
assert(failPublish.canSend === false, 'image publish failure aborts LINE send');

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
assert(Seq.isPublicHttpsImageUrl('https://ofk3-line-proxy-1.onrender.com/map-image/abc') === true, 'https map-image URL is accepted');
assert(Seq.isPublicHttpsImageUrl('data:image/png;base64,xx') === false, 'data URL is not a LINE image URL');
assert(html.indexOf('function publishCortexLineMapImage') >= 0, 'Cortex LINE send publishes MAP image');
assert(html.indexOf("fetch('/map-image'") >= 0, 'Cortex LINE send uses existing Render upload pattern');
assert(html.indexOf('originalContentUrl: imageUrl') >= 0 || html.indexOf('preview.messages') >= 0, 'Cortex LINE send uses image message payload');
assert(html.indexOf("messages: preview.messages") >= 0, 'Cortex LINE send posts preview.messages including image');
assert(html.indexOf("messages: [{ type: 'text', text: preview.text }]") < 0, 'Cortex LINE send no longer posts text-only');
assert(html.indexOf("imageUrl = ''; // 画像URLは後で実装") >= 0, 'existing cycle MAP LINE send is unchanged');
assert(html.indexOf('function twRenderMapAsync') >= 0, 'twRenderMapAsync remains');
var serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');
assert(serverSrc.indexOf("app.post('/map-image'") >= 0 && serverSrc.indexOf("app.get('/map-image/:id'") >= 0, 'Render map-image upload/download exists');
assert(serverSrc.indexOf("app.post('/pdf-upload'") >= 0, 'existing pdf-upload path remains');
assert(serverSrc.indexOf("app.get('/static-map'") >= 0, 'existing static-map path remains');

var centerView = Seq.googleStaticMapView([
  { latitude: 33.575, longitude: 130.335, routeCode: 'DCX36' }
], 640, 400);
assert(centerView && centerView.zoom >= 1, 'google static view has zoom');
var cpt = centerView.project(33.575, 130.335);
assert(Math.abs(cpt.x - 320) < 0.6 && Math.abs(cpt.y - 200) < 0.6, 'center coordinate maps to canvas center');
var east = centerView.project(33.575, 130.335 + 0.01);
assert(east.x > cpt.x && Math.abs(east.y - cpt.y) < 8, 'east is to the right on Google mercator');
var north = centerView.project(33.575 + 0.01, 130.335);
assert(north.y < cpt.y && Math.abs(north.x - cpt.x) < 8, 'north is upward on Google mercator');

var twoView = Seq.googleStaticMapView([
  { latitude: 33.57, longitude: 130.33, routeCode: 'DCX36' },
  { latitude: 33.58, longitude: 130.34, routeCode: 'DCX36' }
], 640, 400);
var p1 = twoView.project(33.57, 130.33);
var p2 = twoView.project(33.58, 130.34);
assert(p1.x > 40 && p1.x < 600 && p1.y > 40 && p1.y < 360, 'south-west pin stays inside padded viewport');
assert(p2.x > 40 && p2.x < 600 && p2.y > 40 && p2.y < 360, 'north-east pin stays inside padded viewport');
assert(p2.x > p1.x && p2.y < p1.y, 'relative pin order matches geography');
assert(html.indexOf('googleStaticMapView') >= 0, 'LINE canvas uses Google Static Maps projection');
assert(html.indexOf('cortexFitLinePins') < 0, 'bbox-fit projection is no longer used for LINE images');
assert(html.indexOf('blob.size < 8000') >= 0, 'tiny placeholder static-map images are rejected');
assert(html.indexOf('size:tiny|color:0xCCCCCC|') >= 0, 'static-map background includes pin markers like existing LINE maps');

console.log('ok cortex-route-line-map');
