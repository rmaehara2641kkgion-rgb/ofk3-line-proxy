/**
 * Auto Assign: Amazon Schedule as sole worker source (no shift file upload)
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AssignSupportCore = require('../assign-support-core.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

var tidMap = { 山田: 'A111', 佐藤: 'A222', 鈴木: 'A333' };
var targetDate = '2026-08-23';

function sched(name, extra) {
  return Object.assign(
    {
      name: name,
      transportId: tidMap[name] || '',
      shiftCode: '〇',
      arrivalTime: '11:00',
      arrivalMinutes: 660,
      assignRole: 'regular',
      vehicleHint: 'standard',
    },
    extra || {}
  );
}

function runTests() {
  // Case 1: loaded schedule, matching date → candidates
  var case1 = AssignSupportCore.buildAssignWorkersFromAmazonSchedule({
    scheduleEntries: [sched('山田'), sched('佐藤')],
    scheduleMeta: { targetDate: targetDate },
    assignTargetDate: targetDate,
    transportIDs: tidMap,
  });
  assert(case1.stats.error === null, 'case1 no error');
  assert(case1.workers.length === 2, 'case1 two candidates');
  assert(case1.workers[0].transportId === 'A111', 'case1 TID join');

  // Case 2: different date → empty
  var case2 = AssignSupportCore.buildAssignWorkersFromAmazonSchedule({
    scheduleEntries: [sched('山田')],
    scheduleMeta: { targetDate: '2026-08-20' },
    assignTargetDate: targetDate,
    transportIDs: tidMap,
  });
  assert(case2.stats.dateMismatch === true, 'case2 date mismatch');
  assert(case2.workers.length === 0, 'case2 no candidates');

  // Case 3: reserve / non-working excluded
  var case3 = AssignSupportCore.buildAssignWorkersFromAmazonSchedule({
    scheduleEntries: [
      sched('山田'),
      sched('佐藤', { assignRole: 'reserve' }),
      sched('鈴木', { shiftCode: '', arrivalTime: '' }),
    ],
    scheduleMeta: { targetDate: targetDate },
    assignTargetDate: targetDate,
    transportIDs: tidMap,
  });
  assert(case3.workers.length === 1, 'case3 only regular worker');
  assert(case3.stats.excludedReserve >= 1, 'case3 reserve counted');

  // Case 4: no TransportID → excluded (no name-only assign)
  var case4 = AssignSupportCore.buildAssignWorkersFromAmazonSchedule({
    scheduleEntries: [sched('未知ドライバー', { transportId: '' })],
    scheduleMeta: { targetDate: targetDate },
    assignTargetDate: targetDate,
    transportIDs: {},
  });
  assert(case4.workers.length === 0, 'case4 no TID excluded');
  assert(case4.stats.excludedNoTransportId === 1, 'case4 TID missing stat');

  // Case 5: not loaded
  var case5 = AssignSupportCore.buildAssignWorkersFromAmazonSchedule({
    scheduleEntries: [],
    scheduleMeta: null,
    assignTargetDate: targetDate,
    transportIDs: tidMap,
  });
  assert(case5.stats.error === 'not_loaded', 'case5 not loaded');

  // Case 6: area experience via TransportID
  var headers = [
    'TransportID',
    'driverName',
    'area',
    'experienceDays',
    'lastVisitDate',
    'primaryCount',
    'splitCount',
    'confidence',
  ];
  var expRows = [headers, ['A111', '山田', '原', '20', '2026-08-20', '5', '0', 'high']];
  var expDb = AssignSupportCore.parseExperienceRows(expRows, {
    knownTransportIds: AssignSupportCore.buildKnownTransportIdSet(tidMap),
  });
  assert(expDb.ok, 'case6 exp parse');
  var workers6 = case1.workers;
  var expEntry = expDb.db.byTransportId['A111'];
  var eval6 = AssignSupportCore.evaluateDriverForRoute(
    workers6[0],
    [{ label: '原', role: 'primary' }],
    expEntry
  );
  assert(eval6.areaResults[0].experienceDays === 20, 'case6 experience by TID');

  // Case 7: ability via existing getPackagesPerHour pattern
  var pph = AssignSupportCore.getPackagesPerHour('山田', 'A111', function (n) {
    return n === '山田' ? { packagesPerHour: 22 } : null;
  }, tidMap);
  assert(pph === 22, 'case7 ability lookup');

  console.log('auto-assign-amazon-schedule.test.mjs: all tests passed');
}

runTests();
