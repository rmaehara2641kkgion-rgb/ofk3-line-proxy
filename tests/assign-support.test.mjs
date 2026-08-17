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
  var stdAmazon = function (routeCode, driverName, tid) {
    return {
      routeCode: routeCode,
      driverName: driverName,
      serviceType: 'Standard Parcel',
      transportId: tid,
    };
  };
  var tierWorkersC3 = [
    { name: '山田', driverName: '山田', transportId: 'A789', shiftCode: '〇' },
    { name: '佐藤', driverName: '佐藤', transportId: 'A999', shiftCode: '〇' },
  ];
  var tierPlan = AssignSupportCore.buildFirstAssignPlan(tierRoute, tierWorkersC3, tierExp, {
    cycle: 3,
    amazonAssignments: [stdAmazon('DSX10', '山田', 'A789')],
    getPackagesPerHour: function (_n, tid) {
      return pphMap[tid] || null;
    },
  });
  assert(tierPlan.routes[0].firstRecommendation.transportId === 'A789', 'tier A beats faster tier C');

  var multiRoutes = [
    { routeCode: 'DSX10', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
    { routeCode: 'DSX11', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
  ];
  var multiPlan = AssignSupportCore.buildFirstAssignPlan(multiRoutes, tierWorkersC3, tierExp, {
    cycle: 3,
    amazonAssignments: [stdAmazon('DSX10', 'x', 'A789'), stdAmazon('DSX11', 'y', 'A999')],
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
  var adminPlan = AssignSupportCore.buildFirstAssignPlan(noExpRoute, tierWorkersC3, tierExp, {
    cycle: 3,
    amazonAssignments: [stdAmazon('DCX99', '山田', 'A789')],
  });
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

  assert(AssignSupportCore.normalizeAssignShiftToken('11B') === 'maru', '11B -> maru');
  assert(AssignSupportCore.normalizeAssignShiftToken('8B') === 'hachi', '8B -> hachi');
  assert(AssignSupportCore.normalizeAssignShiftToken('B1') === 'b1', 'B1 -> b1');
  assert(AssignSupportCore.normalizeAssignShiftToken('biker') === 'bike', 'biker -> bike');

  var cycleDetect = AssignSupportCore.detectManifestCycleFromSources([
    { fileName: 'OFK3_CYCLE_2_2026-08-18.xlsx' },
  ]);
  assert(cycleDetect.cycle === 2, 'detect cycle 2 from filename');

  var cycleAmbiguous = AssignSupportCore.detectManifestCycleFromSources([
    { fileName: 'OFK3_CYCLE_1_a.xlsx' },
    { fileName: 'OFK3_CYCLE_3_b.xlsx' },
  ]);
  assert(cycleAmbiguous.cycle === null && cycleAmbiguous.ambiguous, 'ambiguous cycle files');

  var cycleWorkers = [
    { name: 'A', driverName: 'A', transportId: 'T1', shiftCode: '〇' },
    { name: 'B', driverName: 'B', transportId: 'T2', shiftCode: '❽' },
    { name: 'C', driverName: 'C', transportId: 'T3', shiftCode: 'b1' },
    { name: 'D', driverName: 'D', transportId: 'T4', shiftCode: 'b2' },
    { name: 'E', driverName: 'E', transportId: 'T5', shiftCode: 'bike' },
    { name: 'F', driverName: 'F', transportId: 'T6', shiftCode: 'C1' },
    { name: 'G', driverName: 'G', transportId: 'T7', shiftCode: 'C3' },
    { name: 'H', driverName: 'H', transportId: 'T8', shiftCode: '研修' },
  ];

  var c1Filter = AssignSupportCore.filterWorkersByCycleEligibility(cycleWorkers, 1);
  assert(c1Filter.eligible.length === 4, 'cycle1 eligible count');
  assert(
    c1Filter.eligible.every(function (w) {
      return ['T1', 'T3', 'T5', 'T6'].indexOf(w.transportId) >= 0;
    }),
    'cycle1 eligible shifts'
  );
  assert(c1Filter.stats.nonAssignableCount === 1, 'cycle1 excludes training');

  var c2Filter = AssignSupportCore.filterWorkersByCycleEligibility(cycleWorkers, 2);
  assert(c2Filter.eligible.length === 3, 'cycle2 eligible count');
  assert(
    c2Filter.eligible.every(function (w) {
      return ['T2', 'T4', 'T5'].indexOf(w.transportId) >= 0;
    }),
    'cycle2 hachi b2 bike'
  );

  var c3Filter = AssignSupportCore.filterWorkersByCycleEligibility(cycleWorkers, 3);
  assert(c3Filter.eligible.length === 2, 'cycle3 eligible count');
  assert(
    c3Filter.eligible.every(function (w) {
      return ['T1', 'T7'].indexOf(w.transportId) >= 0;
    }),
    'cycle3 maru c3 only'
  );

  var cycle2Route = [
    { routeCode: 'DSX20', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
  ];
  var cycle2Workers = [
    { name: '高経験', driverName: '高経験', transportId: 'A789', shiftCode: 'C1' },
    { name: '低経験', driverName: '低経験', transportId: 'A999', shiftCode: '❽' },
  ];
  var cycle2Eval = AssignSupportCore.buildAmazonAssignEvaluationPlan(cycle2Route, cycle2Workers, tierExp, {
    cycle: 2,
    amazonAssignments: [stdAmazon('DSX20', '低経験', 'A999')],
    getPackagesPerHour: function (_n, tid) {
      return pphMap[tid] || null;
    },
  });
  assert(cycle2Eval.mode === 'evaluate', 'cycle2 evaluate mode');
  assert(cycle2Eval.routes[0].evaluationStatus === 'ok', 'cycle2 amazon assign ok when experienced');

  var noCyclePlan = AssignSupportCore.buildAssignPlan(cycle2Route, cycle2Workers, tierExp, {});
  assert(noCyclePlan.cycleError === 'CYCLE_UNKNOWN', 'no cycle stops plan');

  var bikeAssign = [
    { routeCode: 'DSX1', driverName: 'Bike', serviceType: 'Biker', transportId: 'A789' },
  ];
  var mixedWorkers = [
    { name: 'Bike', driverName: 'Bike', transportId: 'A789', shiftCode: 'bike' },
    { name: 'Std', driverName: 'Std', transportId: 'A999', shiftCode: '〇' },
  ];
  var c1BikePlan = AssignSupportCore.buildFirstAssignPlan(
    [{ routeCode: 'DSX1', packages: 50, stops: 40, areas: [{ label: '原', role: 'primary' }] }],
    mixedWorkers,
    tierExp,
    { cycle: 1, amazonAssignments: bikeAssign }
  );
  assert(
    c1BikePlan.routes[0].firstRecommendation.transportId === 'A789',
    'bike route never picks standard worker'
  );

  var c3StdPlan = AssignSupportCore.buildFirstAssignPlan(
    [{ routeCode: 'DSX1', packages: 50, stops: 40, areas: [{ label: '原', role: 'primary' }] }],
    mixedWorkers,
    tierExp,
    { cycle: 3, amazonAssignments: [stdAmazon('DSX1', 'Std', 'A999')] }
  );
  assert(
    c3StdPlan.routes[0].firstRecommendation.transportId === 'A999',
    'cycle3 standard route picks maru not bike'
  );

  assert(AssignSupportCore.getAssignModeForCycle(1) === 'evaluate', 'cycle1 evaluate mode');
  assert(AssignSupportCore.getAssignModeForCycle(3) === 'first_pick', 'cycle3 first pick mode');
  assert(AssignSupportCore.classifyRouteVehicleType('Biker') === 'bike', 'biker route type');
  assert(AssignSupportCore.classifyRouteVehicleType('Nursery Route') === 'nursery', 'nursery route type');

  var nurseryWorkers = [
    { name: 'NurseryDriver', driverName: 'NurseryDriver', transportId: 'A999', shiftCode: '〇' },
  ];
  var nurseryEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [{ routeCode: 'NSX1', packages: 40, stops: 30, areas: [{ label: '原', role: 'primary' }] }],
    nurseryWorkers,
    tierExp,
    {
      cycle: 1,
      amazonAssignments: [
        {
          routeCode: 'NSX1',
          driverName: 'NurseryDriver',
          serviceType: 'Nursery Route Level 1',
          transportId: 'A999',
        },
      ],
    }
  );
  assert(nurseryEval.routes[0].routeVehicleType === 'nursery', 'nursery route not excluded');

  var changeExpRows = [
    headers,
    ['A789', '山田', '七隈', '18', '2026-08-15', '10', '0', 'high'],
    ['A999', '佐藤', '原', '8', '2026-08-14', '2', '0', 'shared'],
  ];
  var changeExp = AssignSupportCore.parseExperienceRows(changeExpRows, { knownTransportIds: known });
  var changeEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [{ routeCode: 'DSX30', packages: 80, stops: 60, areas: [{ label: '七隈', role: 'primary' }] }],
    [
      { name: '山田', driverName: '山田', transportId: 'A789', shiftCode: '〇' },
      { name: '佐藤', driverName: '佐藤', transportId: 'A999', shiftCode: '〇' },
    ],
    changeExp,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DSX30', '佐藤', 'A999')],
    }
  );
  assert(changeEval.routes[0].evaluationStatus === 'change_candidate', 'change candidate on clear exp gap');

  var okEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [{ routeCode: 'DSX10', packages: 84, stops: 70, areas: [{ label: '原', role: 'primary' }] }],
    tierWorkersC3,
    tierExp,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DSX10', '山田', 'A789')],
    }
  );
  assert(okEval.routes[0].evaluationStatus === 'ok', 'ok when amazon assign tier A');

  console.log('assign-support tests passed');
}

runTests();
