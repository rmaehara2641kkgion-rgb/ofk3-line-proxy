import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const AssignSupportCore = require('../assign-support-core.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runTests() {
  var headers = ['TransportID', 'driverName', 'area', 'experienceDays', 'lastVisitDate'];
  var rows = [
    headers,
    ['A123', '山田太郎', '姪浜', '18', '2026-08-15'],
    ['A123', '山田太郎', '愛宕', '9', '2026-08-12'],
    ['A456', '佐藤次郎', '前原', '12', '2026-08-14'],
    ['UNKNOWN99', '不明', '姪浜', '1', '2026-08-01'],
  ];
  var known = new Set(['A123', 'A456']);
  var parsed = AssignSupportCore.parseExperienceRows(rows, { knownTransportIds: known });
  assert(parsed.ok, 'parse ok');
  assert(parsed.stats.drivers === 3, 'all transport ids in file');
  assert(parsed.stats.records === 4, 'records');
  assert(parsed.stats.unknownTids.length === 1, 'unknown tid warning');

  var areas = AssignSupportCore.extractAreaLabelsFromAddresses([
    '西区姪浜3丁目, 福岡市, 福岡',
    '西区姪浜5丁目, 福岡市, 福岡',
    '西区愛宕浜1丁目, 福岡市, 福岡',
  ]);
  assert(areas[0].label === '姪浜', 'primary area');
  assert(areas.length >= 2, 'multiple areas');

  var expDb = parsed;
  var manifestRoutes = [
    {
      routeCode: 'DCX03',
      packages: 100,
      stops: 80,
      areas: areas,
    },
  ];
  var shiftWorkers = [
    { name: '山田太郎', driverName: '山田太郎', transportId: 'A123', shiftCode: 'C1' },
    { name: '佐藤次郎', driverName: '佐藤次郎', transportId: 'A456', shiftCode: 'C1' },
    { name: '鈴木一郎', driverName: '鈴木一郎', transportId: 'A999', shiftCode: 'C1' },
  ];

  var suggestions = AssignSupportCore.buildAssignSuggestions(manifestRoutes, shiftWorkers, expDb, {
    rescueReserveCount: 2,
  });
  assert(suggestions.length === 1, 'one route suggestion');
  assert(suggestions[0].recommended.length === 1, 'yamada only full experience');
  assert(suggestions[0].recommended[0].transportId === 'A123', 'top recommended');
  assert(suggestions[0].noExperiencedDriver === false, 'has experienced driver');

  var noExpRoute = [
    {
      routeCode: 'DCX99',
      packages: 10,
      stops: 8,
      areas: [{ label: '存在しないエリア', role: 'primary' }],
    },
  ];
  var none = AssignSupportCore.buildAssignSuggestions(noExpRoute, shiftWorkers, expDb, {});
  assert(none[0].noExperiencedDriver, 'no experienced driver stops recommendation');

  assert(AssignSupportCore.areasMatch('早良区姪浜', '姪浜'), 'area fuzzy match');

  var rebuilt = AssignSupportCore.buildExperienceDbFromRecords(parsed.records, { knownTransportIds: known });
  assert(rebuilt.ok && rebuilt.stats.drivers === 3, 'rebuild from records');

  assert(AssignSupportCore.getExperienceStatusLabel(0) === '未経験', 'status none');
  assert(AssignSupportCore.getExperienceStatusLabel(18) === '熟練', 'status skilled');

  var filtered = AssignSupportCore.filterExperienceDrivers(expDb, '姪浜');
  assert(filtered.length >= 1, 'area search');

  assert(AssignSupportCore.formatAreaSummary(expDb.byTransportId.A123).indexOf('姪浜') >= 0, 'area summary');

  console.log('assign-support tests passed');
}

runTests();
