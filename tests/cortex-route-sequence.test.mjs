import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Seq = require('../cortex-route-sequence.js');
const Core = require('../cortex-13-priority-core.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const seqSrc = readFileSync(join(root, 'cortex-route-sequence.js'), 'utf8');
const mapSrc = readFileSync(join(root, 'ofk3-delivery-map.js'), 'utf8');
const runnerSrc = readFileSync(join(root, 'cortex-capture-extension/phase1-runner.js'), 'utf8');
const serverSrc = readFileSync(join(root, 'render-webhook-server.js'), 'utf8');
const coreSrc = readFileSync(join(root, 'cortex-13-priority-core.js'), 'utf8');

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
    routeId: 'RTEST',
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
var packages = [
  { routeCode: 'DCX_TEST', stop: 2, trackingId: 'DA2' },
  { routeCode: 'DCX_TEST', stop: 4, trackingId: 'DA4' }
];

var model = Seq.buildRouteSequenceModel(routeStops, packages);
assert(model.complete === true, 'DCX_TEST model is complete');
assert(model.pins.length === 5, 'DCX_TEST has 5 pins');
assert(flags(model.pins) === '1通常,2必達,3通常,4必達,5通常', 'DCX_TEST sequence 2 and 4 are 13:00');
assert(model.pins[1].isPriority1300 && model.pins[3].isPriority1300, 'pins 2 and 4 flagged');
assert(!model.pins[0].isPriority1300 && !model.pins[2].isPriority1300 && !model.pins[4].isPriority1300, 'other pins not flagged');

var popup2 = Seq.sequencePopup(model.pins[1]);
assert(popup2.indexOf('🔴 13:00必達') >= 0, 'priority popup shows 13:00 badge');
assert(popup2.indexOf('YES') >= 0 && popup2.indexOf('巡回順') >= 0 && popup2.indexOf('Cortex Stop') >= 0, 'priority popup fields');
assert(popup2.indexOf('Yamada Taro') >= 0 && popup2.indexOf('福岡2') >= 0, 'priority popup driver/address');
var popup1 = Seq.sequencePopup(model.pins[0]);
assert(popup1.indexOf('NO') >= 0 && popup1.indexOf('🔴 13:00必達') < 0, 'normal popup is not 13:00');

var selected = Seq.summarizeSelectedRoute(model.pins, packages, 'DCX_TEST');
assert(selected.allStopCount === 5 && selected.priorityStopCount === 2 && selected.priorityPackageCount === 2, 'selected route stats');
assert(selected.driverName === 'Yamada Taro', 'selected route driver');

var missingSeq = Seq.buildRouteSequenceModel([
  { routeCode: 'DCX_TEST', sequenceNumber: 1, latitude: 33.5, longitude: 130.4 },
  { routeCode: 'DCX_TEST', address: 'no-seq', latitude: 33.6, longitude: 130.5 }
], []);
assert(missingSeq.pins.length === 2 && missingSeq.pins[0].sequenceNumber === 1 && missingSeq.pins[1].sequenceNumber == null, 'missing sequence sorts last and does not crash');

var dup = Seq.buildRouteSequenceModel([
  { routeCode: 'DCX_TEST', sequenceNumber: 1, address: 'a' },
  { routeCode: 'DCX_TEST', sequenceNumber: 1, address: 'b' }
], []);
assert(dup.pins.length === 2 && dup.pins[0].sequenceNumber === 1 && dup.pins[1].sequenceNumber === 1, 'duplicate sequence kept');

var noAddr = Seq.buildRouteSequenceModel([
  { routeCode: 'DCX_TEST', sequenceNumber: 1, latitude: 33.5, longitude: 130.4 },
  { routeCode: 'DCX_TEST', sequenceNumber: 2 }
], []);
assert(noAddr.pins.length === 2 && noAddr.pins[1].address === '' && noAddr.pins[1].latitude == null, 'missing address/coords kept');

var none = Seq.buildRouteSequenceModel(routeStops, []);
assert(none.pins.every(function (p) { return !p.isPriority1300; }), 'zero 13:00 stays all normal');

var allPri = Seq.buildRouteSequenceModel(routeStops, routeStops.map(function (s) {
  return { routeCode: s.routeCode, stop: s.sequenceNumber, trackingId: 'X' + s.sequenceNumber };
}));
assert(allPri.pins.every(function (p) { return p.isPriority1300; }), 'all stops can be 13:00');

var multi = Seq.buildRouteSequenceModel(
  routeStops.concat([{ routeCode: 'DCX_OTHER', sequenceNumber: 1, driverName: 'Sato' }]),
  [{ routeCode: 'DCX_OTHER', stop: 1, trackingId: 'Z1' }]
);
assert(multi.routeCount === 2, 'multiple routes counted');
assert(multi.pins.filter(function (p) { return p.routeCode === 'DCX_OTHER'; })[0].isPriority1300, 'second route join works');

var wide = Seq.buildRouteSequenceModel([
  { routeCode: 'DCX_TEST', sequenceNumber: 12, address: 'two' },
  { routeCode: 'DCX_TEST', sequenceNumber: 105, address: 'three' }
], [{ routeCode: 'DCX_TEST', stop: 105, trackingId: 'DA105' }]);
assert(String(wide.pins[0].sequenceNumber) === '12' && String(wide.pins[1].sequenceNumber) === '105', '2 and 3 digit sequence kept');
assert(wide.pins[1].isPriority1300, '3 digit sequence still joins 13:00');

assert(Seq.buildRouteSequenceModel(null, null).pins.length === 0, 'null input does not crash');
assert(Seq.buildRouteSequenceModel(undefined, undefined).complete === false, 'missing routeStops is incomplete');

assert(seqSrc.indexOf('new MutationObserver') < 0, 'sequence model has no MutationObserver');
assert(mapSrc.indexOf('sequenceLayer') >= 0, 'MAP has sequence layer');
assert(mapSrc.indexOf('isPriority1300') >= 0, 'MAP uses 13:00 ring flag');
assert(runnerSrc.indexOf('routeStops: routeStops') >= 0, 'extension sends routeStops');
assert(runnerSrc.indexOf('packageSequenceIndex: packageSequenceIndex') >= 0, 'extension sends packageSequenceIndex');
assert(serverSrc.indexOf('function sanitizeCortexRouteStop') >= 0, 'server stores routeStops');
assert(serverSrc.indexOf('sanitizeCortexPackageSequenceIndexRow') >= 0, 'server stores packageSequenceIndex');
assert(coreSrc.indexOf('function extractPackageSequenceIndex') >= 0, 'core extracts packageSequenceIndex');
assert(coreSrc.indexOf('function isExact1300Clock') >= 0 && coreSrc.indexOf('function isOnOrBeforeCutoff') >= 0, '13:00 judgment functions remain');
assert(/taskType !== 'DROP_OFF'/.test(coreSrc), 'DROP_OFF filter remains');

console.log('ok cortex-route-sequence');
