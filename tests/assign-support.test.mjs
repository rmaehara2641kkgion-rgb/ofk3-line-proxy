import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const AssignSupportCore = require('../assign-support-core.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runTests() {
  var headers = ['TransportID', 'driverName', 'area', 'experienceDays', 'lastVisitDate', 'primaryCount', 'splitCount', 'confidence'];
  var rows = [
    headers,
    ['A123', '山田太郎', '姪浜', '18', '2026-08-15', '5', '0', 'high'],
    ['A123', '山田太郎', '愛宕', '9', '2026-08-12', '2', '0', 'high'],
    ['A456', '佐藤次郎', '前原', '12', '2026-08-14', '3', '0', 'high'],
    ['A789', '鈴木一郎', '姪浜', '24', '2026-08-16', '8', '0', 'high'],
    ['A999', '高速太郎', '姪浜', '8', '2026-08-10', '1', '0', 'shared'],
    ['UNKNOWN99', '不明', '姪浜', '1', '2026-08-01', '0', '1', 'shared'],
  ];
  var known = new Set(['A123', 'A456', 'A789', 'A999']);
  var parsed = AssignSupportCore.parseExperienceRows(rows, { knownTransportIds: known });
  assert(parsed.ok, 'parse ok');
  assert(parsed.stats.drivers === 5, 'all transport ids in file');

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

  assert(AssignSupportCore.isShiftNonDriverRow('必要台数'), '必要台数 is non-driver');
  assert(!AssignSupportCore.isShiftNonDriverRow('小野'), 'real name is driver');
  var withFooter = [
    { name: '小野', rawName: '小野', transportId: '', shiftCode: 'C1' },
    { name: '必要台数', rawName: '必要台数', transportId: '', shiftCode: 'C1' },
  ];
  var filtered = AssignSupportCore.filterShiftWorkers(withFooter);
  assert(filtered.length === 1 && filtered[0].name === '小野', 'filter non-driver row');

  var pphMap = {
    A789: 18.2,
    A999: 25.0,
  };
  var tierRoute = [
    {
      routeCode: 'DSX10',
      packages: 84,
      stops: 70,
      areas: [{ label: '原', role: 'primary' }],
    },
  ];
  var tierWorkers = [
    { name: '山田', driverName: '山田', transportId: 'A789', shiftCode: 'C1' },
    { name: '佐藤', driverName: '佐藤', transportId: 'A999', shiftCode: 'C1' },
  ];
  var tierExpRows = [
    headers,
    ['A789', '山田', '原', '24', '2026-08-15', '10', '0', 'high'],
    ['A999', '佐藤', '原', '8', '2026-08-14', '2', '0', 'shared'],
  ];
  var tierExp = AssignSupportCore.parseExperienceRows(tierExpRows, { knownTransportIds: known });
  var tierPlan = AssignSupportCore.buildFirstAssignPlan(tierRoute, tierWorkers, tierExp, {
    getPackagesPerHour: function (_n, tid) {
      return pphMap[tid] || null;
    },
  });
  assert(tierPlan.routes[0].firstRecommendation.transportId === 'A789', 'tier A beats faster tier C');

  var multiRoutes = [
    { routeCode: 'DSX10', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
    { routeCode: 'DSX11', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
  ];
  var multiPlan = AssignSupportCore.buildFirstAssignPlan(multiRoutes, tierWorkers, tierExp, {
    getPackagesPerHour: function (_n, tid) {
      return pphMap[tid] || null;
    },
  });
  var assigned = multiPlan.routes.map(function (r) {
    return r.firstRecommendation && r.firstRecommendation.transportId;
  });
  assert(assigned[0] !== assigned[1], 'no duplicate first recommendation');
  assert(multiPlan.summary.confirmedCount === 2, 'two confirmed when two routes two drivers');

  var noExpRoute = [
    {
      routeCode: 'DCX99',
      packages: 10,
      stops: 8,
      areas: [{ label: '存在しないエリア', role: 'primary' }],
    },
  ];
  var adminPlan = AssignSupportCore.buildFirstAssignPlan(noExpRoute, tierWorkers, tierExp, {});
  assert(adminPlan.routes[0].needsAdminReview, 'admin review when no eligible');

  assert(AssignSupportCore.getPrimaryExperienceTier(20) === 'A', 'tier A at 20');
  assert(AssignSupportCore.getPrimaryExperienceTier(19) === 'B', 'tier B below expert');

  assert(AssignSupportCore.getExperienceStatusLabel(20) === '熟練', 'status skilled');

  var mockResolve = function (name) {
    var aliases = { 'Taro Yamada': '山田 太郎', 'JIRO SATO': '佐藤 次郎' };
    if (aliases[name]) return aliases[name];
    return name;
  };
  var mockTids = {
    '山田 太郎': 'A123',
    '山田太郎': 'A123',
    '佐藤 次郎': 'A456',
    'JIRO SATO': 'A456',
  };
  assert(
    AssignSupportCore.resolveTransportIdForName('Taro Yamada', mockTids, mockResolve) === 'A123',
    'roman alias via resolveDriverKey'
  );

  var rawWorkers = [{ name: 'Taro Yamada', rawName: 'Taro Yamada', shiftCode: 'C1' }];
  var enriched = AssignSupportCore.enrichShiftWorkersWithTransportIds(rawWorkers, mockTids, mockResolve);
  assert(enriched.mappedCount === 1, 'enrich mapped count');

  var masterRows = [
    { name: '長野', rawName: '長野', transportId: '', shiftCode: 'C1' },
    { name: '必要台数', rawName: '必要台数', transportId: '', shiftCode: 'C1' },
  ];
  var fromMaster = AssignSupportCore.extractShiftWorkersFromMaster(masterRows, {}, null);
  assert(fromMaster.length === 1 && fromMaster[0].name === '長野', 'master extract skips footer');

  console.log('assign-support tests passed');
}

runTests();
