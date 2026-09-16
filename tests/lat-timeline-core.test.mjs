import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Core = require('../lat-timeline-core.js');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function day(s) {
  return Core.latParseDateToDayNumber(s);
}

// mm:ss.tenths detection
assert(Core.latLooksLikeBeaconMmSs('57:46.8') === true, 'detect 57:46.8');
assert(Core.latLooksLikeBeaconMmSs('35:42') === false, '35:42 without tenths is not mmss');
assert(Core.latLooksLikeBeaconMmSs('2026/9/11 11:20') === false, 'datetime is not mmss');
assert(Core.latLooksLikeBeaconMmSs('18:55') === false, 'bare HH:mm is not mmss');

const d = day('2026/9/11');
const planned = '2026/9/11 11:20';

const normal = Core.normalizeLatTimeline({
  routeDayNumber: d,
  plannedDeparture: planned,
  arrival: '53:34.3',
  entrance: '53:34.3',
  firstScan: '54:02.7',
  lastScan: '55:19.8',
  departure: '57:46.8',
  exit: '57:46.8',
});
assert(Math.abs((normal.departureAbs - normal.plannedDepartureAbs) - (-22.2)) < 0.3, 'CYCLE_1 amazon -22.2 got ' + (normal.departureAbs - normal.plannedDepartureAbs));
assert(normal.isTimelineSuspicious === false, 'normal W37 not suspicious: ' + normal.timelineWarningReason);
assert(normal.fieldMeta.departure.source === 'beacon-mmss', 'departure inferred from mmss');
assert(normal.fieldMeta.departure.confidence === 'inferred', 'inferred confidence');

const skipped = Core.normalizeLatTimeline({
  routeDayNumber: d,
  plannedDeparture: '2026/9/11 15:00',
  arrival: '30:40.0',
  entrance: '30:40.0',
  firstScan: '',
  lastScan: '',
  departure: '42:38.0',
  exit: '42:38.0',
});
assert(Math.abs((skipped.departureAbs - skipped.plannedDepartureAbs) - (-17.4)) < 0.3, 'skipped scans amazon -17.4');
assert(skipped.isTimelineSuspicious === false, 'skipped scans not adjacent-120: ' + skipped.timelineWarningReason);

const overflow = Core.normalizeLatTimeline({
  routeDayNumber: d,
  plannedDeparture: '18:50',
  departure: '35:42',
});
assert(overflow.isTimelineSuspicious === true, '35:42 without tenths remains suspicious');
assert((overflow.timelineWarningCodes || []).indexOf('departure_diff_over_180') >= 0 || overflow.timelineWarningReason.indexOf('出発差分') >= 0, 'overflow reason is departure diff');

const longLoad = Core.normalizeLatTimeline({
  routeDayNumber: d,
  firstScan: '35:07',
  lastScan: '44:00',
});
assert(longLoad.isTimelineSuspicious === true, '35:07-44:00 not accepted as normal loading');

const early = Core.normalizeLatTimeline({
  routeDayNumber: d,
  plannedDeparture: '18:50',
  departure: '18:45',
});
assert(Math.round(early.departureAbs - early.plannedDepartureAbs) === -5, 'early -5');
assert(early.isTimelineSuspicious === false, 'normal early not flagged');

const ontime = Core.normalizeLatTimeline({
  routeDayNumber: d,
  plannedDeparture: '18:50',
  departure: '18:55',
});
assert(Math.round(ontime.departureAbs - ontime.plannedDepartureAbs) === 5, 'ontime +5');
assert(ontime.isTimelineSuspicious === false, 'normal +5 not flagged');

const hourWrap = Core.normalizeLatTimeline({
  routeDayNumber: d,
  plannedDeparture: '2026/9/10 11:20',
  arrival: '34:55.4',
  entrance: '34:55.4',
  firstScan: '',
  lastScan: '',
  departure: '07:22.2',
  exit: '07:22.2',
});
assert(Math.abs((hourWrap.departureAbs - hourWrap.plannedDepartureAbs) - (-12.6)) < 0.3, 'hour-wrap amazon -12.6 got ' + (hourWrap.departureAbs - hourWrap.plannedDepartureAbs));
assert(hourWrap.arrivalAbs < hourWrap.departureAbs, 'hour-wrap arrival before departure');
assert(Math.abs((hourWrap.departureAbs - hourWrap.entranceAbs) - 32.5) < 0.3, 'hour-wrap stay ~32.5');
assert(hourWrap.isTimelineSuspicious === false, 'hour-wrap not suspicious: ' + hourWrap.timelineWarningReason);

const scanOutsideStay = Core.normalizeLatTimeline({
  routeDayNumber: d,
  plannedDeparture: '2026/9/9 18:50',
  arrival: '22:53.8',
  entrance: '22:53.8',
  firstScan: '26:05.0',
  lastScan: '45:32.1',
  departure: '33:47.6',
  exit: '33:47.6',
});
assert(scanOutsideStay.isTimelineSuspicious === true, 'lastScan after short stay remains isolated');
assert((scanOutsideStay.timelineWarningCodes || []).indexOf('event_order_invalid') >= 0, 'outside-stay reason is order');

const wrapInsideStay = Core.normalizeLatTimeline({
  routeDayNumber: d,
  plannedDeparture: '2026/9/10 18:50',
  arrival: '38:06.1',
  entrance: '38:06.1',
  firstScan: '38:19.9',
  lastScan: '32:53.8',
  departure: '35:42.0',
  exit: '35:42.0',
});
assert(wrapInsideStay.firstScanAbs < wrapInsideStay.lastScanAbs, 'scans inside stay keep first<last');
assert(wrapInsideStay.lastScanAbs <= wrapInsideStay.departureAbs + 5, 'lastScan inside stay window');
assert(wrapInsideStay.isTimelineSuspicious === false, 'hour-wrap inside 57min stay is reconstructable: ' + wrapInsideStay.timelineWarningReason);

console.log('lat-timeline-core.test.mjs: all tests passed');
