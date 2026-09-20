import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const MapApi = require('../ofk3-delivery-map.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const mapSrc = readFileSync(join(root, 'ofk3-delivery-map.js'), 'utf8');
const cortexSrc = readFileSync(join(root, 'ofk3-cortex-priority-ui.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

assert(MapApi.modes.indexOf('priority') >= 0 && MapApi.modes.indexOf('allTimeWindow') >= 0, 'two modes exist');
assert(MapApi.defaultMode('dashboard') === 'priority', 'dashboard MAP defaults to priority');
assert(MapApi.defaultMode('priority') === 'priority', 'explicit priority stays priority');
assert(MapApi.defaultMode('tw-extract') === 'allTimeWindow', 'time-window tab defaults to allTimeWindow');
assert(MapApi.defaultMode('allTimeWindow') === 'allTimeWindow', 'explicit allTimeWindow stays allTimeWindow');

var emptyP = MapApi.summarizePriority(null, []);
assert(emptyP.empty === true, 'priority empty does not throw');
var emptyT = MapApi.summarizeTimeWindow([]);
assert(emptyT.empty === true && emptyT.itemCount === 0, 'time-window empty does not throw');

var filled = MapApi.summarizePriority({ stopCount: 108, packageCount: 112 }, [
  { routeCode: 'DCX38' }, { routeCode: 'DCX38' }, { routeCode: 'DCX39' }
]);
assert(filled.stopCount === 108 && filled.packageCount === 112 && filled.routeCount === 2, 'priority counts come from data');

var cache = {};
assert(MapApi.routeColor('DCX38', cache) === MapApi.routeColor('DCX38', cache), 'same route keeps color');
assert(MapApi.routeColor('DCX38', cache) !== MapApi.routeColor('DCX39', cache), 'different routes get different colors');

var popup = MapApi.priorityPopup({
  routeCode: 'DCX38', driverName: '山田', stop: 2, plannedEndClock: '12:40:00',
  trackingIds: ['A', 'B'], address: '福岡市'
});
assert(popup.indexOf('Route') >= 0 && popup.indexOf('DCX38') >= 0, 'priority popup keeps Route');
assert(popup.indexOf('Driver') >= 0 && popup.indexOf('山田') >= 0, 'priority popup keeps Driver');
assert(popup.indexOf('Stop') >= 0 && popup.indexOf('2') >= 0, 'priority popup keeps Stop');
assert(popup.indexOf('予定到着') >= 0 && popup.indexOf('12:40:00') >= 0, 'priority popup keeps planned time');
assert(popup.indexOf('Package数') >= 0 && popup.indexOf('2') >= 0, 'priority popup keeps package count');
assert(popup.indexOf('住所') >= 0 && popup.indexOf('福岡市') >= 0, 'priority popup keeps address');

var twPopup = MapApi.timeWindowPopup({
  seqNo: 1, label: 'DCX10 #3', timeWindow: '08:00-13:00', driver: '佐藤',
  trackingId: 'DA1', address: '西区'
});
assert(twPopup.indexOf('DCX10 #3') >= 0 && twPopup.indexOf('08:00-13:00') >= 0, 'legacy time-window popup keeps route/window');
assert(twPopup.indexOf('佐藤') >= 0 && twPopup.indexOf('DA1') >= 0 && twPopup.indexOf('西区') >= 0, 'legacy time-window popup keeps driver/id/address');

assert(mapSrc.indexOf('new MutationObserver') < 0, 'unified MAP has no MutationObserver');
assert(!/observe\s*\(\s*document\.body/.test(mapSrc), 'unified MAP does not observe body');
assert(mapSrc.indexOf('setInterval(') < 0, 'unified MAP has no setInterval');
assert(cortexSrc.indexOf('new MutationObserver') < 0, 'Cortex UI still has no MutationObserver');
assert(cortexSrc.indexOf('OFK3DeliveryMap.open') >= 0, 'dashboard MAP delegates to unified MAP');
assert(html.indexOf('OFK3DeliveryMap.open(\'allTimeWindow\')') >= 0, 'time-window MAP button opens allTimeWindow');
assert(html.indexOf('id="ofk3-delivery-map-overlay"') >= 0, 'fixed overlay host exists');
assert(html.indexOf('id="ofk3-dmap-canvas"') >= 0, 'single canvas host exists');
assert(html.indexOf('function twRenderMapAsync') >= 0, 'legacy twRenderMapAsync remains for LINE preview');
assert(html.indexOf('id="splash-screen"') >= 0, 'splash markup remains');
assert(html.indexOf('住所マスターJSON読込') >= 0, 'non-Cortex JSON loader remains');
assert(html.indexOf('/ofk3-delivery-map.js') >= 0, 'unified MAP script is loaded');

console.log('ok unified-delivery-map');
