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
  });
  assert(adminPlan.routes[0].needsAdminReview, 'admin review when no eligible');

  assert(AssignSupportCore.getPrimaryExperienceTier(20) === 'A', 'tier A at 20');
  assert(AssignSupportCore.getPrimaryExperienceTier(19) === 'B', 'tier B below expert');

  assert(AssignSupportCore.getExperienceStatusLabel(20) === '熟練', 'status skilled');
  assert(AssignSupportCore.getExperienceStatusLabel(0).indexOf('確認なし') >= 0, 'zero days is unknown not inexperienced');
  assert(AssignSupportCore.getExperienceStatusLabel(0).indexOf('未経験') < 0, 'zero days label avoids 未経験');
  assert(AssignSupportCore.experienceSpeedFactor({ primaryExperienceDays: 0 }) === 1, 'zero days does not penalize PPH');
  assert(AssignSupportCore.experienceSpeedFactor({ primaryExperienceDays: 1 }) > 1, '1 day is a small bonus');
  assert(
    AssignSupportCore.experienceSpeedFactor({ primaryExperienceDays: 10 }) >
      AssignSupportCore.experienceSpeedFactor({ primaryExperienceDays: 6 }),
    'more observed days increases bonus only'
  );
  assert(AssignSupportCore.AREA_EXPERIENCE_OBSERVATION.START_WEEK === 'W31', 'observation start week');
  assert(AssignSupportCore.AREA_EXPERIENCE_SPEED_BONUS.maxFactor === 1.1, 'max experience speed factor');
  assert(
    AssignSupportCore.experienceSpeedFactor({
      primaryExperienceDays: 30,
      primaryCount: 20,
      primaryConfidence: 'high',
      primaryStops: 2000,
      primaryPackages: 2000,
    }) <= 1.1,
    'experience factor never exceeds max'
  );

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
    { routeCode: 'DMX20', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
  ];
  var cycle2Workers = [
    { name: '高経験', driverName: '高経験', transportId: 'A789', shiftCode: 'C1' },
    { name: '低経験', driverName: '低経験', transportId: 'A999', shiftCode: '❽' },
  ];
  var cycle2Eval = AssignSupportCore.buildAmazonAssignEvaluationPlan(cycle2Route, cycle2Workers, tierExp, {
    cycle: 2,
    amazonAssignments: [stdAmazon('DMX20', '低経験', 'A999')],
    getPackagesPerHour: function (_n, tid) {
      return pphMap[tid] || null;
    },
  });
  assert(cycle2Eval.mode === 'evaluate', 'cycle2 evaluate mode');
  assert(cycle2Eval.routes.length === 1, 'cycle2 dmx route kept');
  assert(cycle2Eval.routes[0].evaluationStatus === 'ok', 'single dmx route stays when no swap partner');
  assert((cycle2Eval.swaps || []).length === 0, 'no swap without a partner route');

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
    { cycle: 3 }
  );
  assert(
    c3StdPlan.routes[0].firstRecommendation.transportId === 'A999',
    'cycle3 standard route picks maru not bike'
  );
  assert(c3StdPlan.routes[0].routeVehicleType === 'standard', 'cycle3 route is standard by OFK3 rule');
  assert(c3StdPlan.routes[0].firstRecommendation, 'cycle3 first pick without assignmentData');

  var c3BikeOnly = AssignSupportCore.filterWorkersByCycleEligibility(
    [{ name: 'Bike', driverName: 'Bike', transportId: 'A789', shiftCode: 'bike' }],
    3
  );
  assert(c3BikeOnly.eligible.length === 0, 'bike driver not cycle3 eligible');

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
  assert(nurseryEval.summary.totalRoutes === 0, 'non-DCX nursery excluded from optimize');
  assert((nurseryEval.swaps || []).length === 0, 'non-DCX nursery has no swaps');

  assert(AssignSupportCore.isDcxRouteCode('DCX20') === true, 'DCX20 is dcx');
  assert(AssignSupportCore.isDcxRouteCode('DCMRA1') === false, 'DCMRA1 is not dcx');
  assert(AssignSupportCore.isDcxRouteCode('DCMRB1') === false, 'DCMRB1 is not dcx');
  assert(AssignSupportCore.isOptimizationRoute('DCX20', 1) === true, 'test1: cycle1 DCX is target');
  assert(AssignSupportCore.isOptimizationRoute('DCMRA1', 1) === false, 'test2: cycle1 DCMRA excluded');
  assert(AssignSupportCore.isOptimizationRoute('DCMRB1', 1) === false, 'test2: cycle1 DCMRB excluded');
  assert(AssignSupportCore.isOptimizationRoute('DMX20', 2) === true, 'test3: cycle2 DMX is target');
  assert(AssignSupportCore.isOptimizationRoute('DMMRA1', 2) === false, 'test4: cycle2 DMMRA excluded');
  assert(AssignSupportCore.isOptimizationRoute('DMMRB1', 2) === false, 'test4: cycle2 DMMRB excluded');
  assert(AssignSupportCore.isOptimizationRoute('DCX20', 2) === false, 'cycle2 DCX is not target');
  assert(AssignSupportCore.isOptimizationRoute('DMX20', 1) === false, 'cycle1 DMX is not target');

  var mixedCodesEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX01', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
      { routeCode: 'DCMRA1', packages: 20, stops: 10, areas: [{ label: '原', role: 'primary' }] },
      { routeCode: 'DCMRB1', packages: 20, stops: 10, areas: [{ label: '原', role: 'primary' }] },
      { routeCode: 'DSX99', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
    ],
    [{ name: '山田', driverName: '山田', transportId: 'A789', shiftCode: '〇' }],
    tierExp,
    {
      cycle: 1,
      amazonAssignments: [
        stdAmazon('DCX01', '山田', 'A789'),
        stdAmazon('DCMRA1', '山田', 'A789'),
        stdAmazon('DCMRB1', '山田', 'A789'),
        stdAmazon('DSX99', '山田', 'A789'),
      ],
    }
  );
  assert(mixedCodesEval.summary.totalRoutes === 1, 'only DCX remains in optimize set');
  assert(mixedCodesEval.routes[0].routeCode === 'DCX01', 'kept route is DCX01');
  assert(
    mixedCodesEval.routes.every(function (r) {
      return String(r.routeCode).startsWith('DCX');
    }),
    'no DCMRA/DCMRB/DSX in results'
  );

  var swapParseHeaders = [
    'TransportID',
    'driverName',
    'area',
    'experienceDays',
    'lastVisitDate',
    'primaryCount',
    'splitCount',
    'confidence',
    'stops',
    'packages',
  ];
  var swapExp = AssignSupportCore.parseExperienceRows(
    [
      swapParseHeaders,
      ['TA', 'DriverA', '西新', '1', '2026-08-10', '1', '0', 'high', '10', '20'],
      ['TA', 'DriverA', '樋井川', '8', '2026-08-15', '6', '0', 'high', '80', '120'],
      ['TB', 'DriverB', '樋井川', '2', '2026-08-11', '1', '0', 'high', '20', '30'],
      ['TB', 'DriverB', '西新', '7', '2026-08-14', '5', '0', 'high', '70', '100'],
    ],
    { knownTransportIds: new Set(['TA', 'TB']) }
  );
  var swapWorkers = [
    { name: 'DriverA', driverName: 'DriverA', transportId: 'TA', shiftCode: '〇' },
    { name: 'DriverB', driverName: 'DriverB', transportId: 'TB', shiftCode: '〇' },
  ];
  var swapRoutes = [
    { routeCode: 'DCX20', packages: 90, stops: 70, areas: [{ label: '西新', role: 'primary' }] },
    { routeCode: 'DCX40', packages: 90, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
  ];
  var swapEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(swapRoutes, swapWorkers, swapExp, {
    cycle: 1,
    amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
    getPackagesPerHour: function () {
      return 18;
    },
  });
  assert((swapEval.swaps || []).length === 1, 'mismatched area pair yields one swap');
  assert(swapEval.summary.swapPairCount === 1, 'summary swap pair count');
  assert(swapEval.swaps[0].routeCodeA === 'DCX20' && swapEval.swaps[0].routeCodeB === 'DCX40', 'DCX20 ⇄ DCX40');
  assert(swapEval.swaps[0].totalImprovementMinutes >= 8, 'swap saves at least threshold minutes');
  assert(swapEval.swaps[0].driverA.toArea === '樋井川', 'A moves to 樋井川');
  assert(swapEval.swaps[0].driverB.toArea === '西新', 'B moves to 西新');
  assert(swapEval.swaps[0].driverA.toExperienceDays === 8, 'A after days 8');
  assert(swapEval.swaps[0].driverB.toExperienceDays === 7, 'B after days 7');
  assert(swapEval.summary.okCount === 0, 'both routes are in the swap');
  assert(swapEval.swaps[0].reason.indexOf('経験') >= 0, 'mismatched areas cite experience in reason');

  var zeroExp = AssignSupportCore.parseExperienceRows(
    [
      swapParseHeaders,
      ['TA', 'DriverA', '西新', '0', '2026-08-10', '0', '0', '', '0', '0'],
      ['TA', 'DriverA', '樋井川', '10', '2026-08-15', '6', '0', 'high', '80', '120'],
      ['TB', 'DriverB', '樋井川', '0', '2026-08-11', '0', '0', '', '0', '0'],
      ['TB', 'DriverB', '西新', '9', '2026-08-14', '5', '0', 'high', '70', '100'],
    ],
    { knownTransportIds: new Set(['TA', 'TB']) }
  );
  var zeroEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(swapRoutes, swapWorkers, zeroExp, {
    cycle: 1,
    amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
    getPackagesPerHour: function () {
      return 18;
    },
  });
  assert((zeroEval.swaps || []).length === 1, '0-day current can swap when destination has confirmed experience and time improves');
  assert(zeroEval.routes.every(function (r) { return r.evaluationStatus !== 'ok'; }), 'confirmed better area is proposed, not auto-ok');
  assert(
    zeroEval.swaps[0].driverA.fromExperienceLabel.indexOf('確認なし') >= 0,
    '0-day current labeled as unobserved'
  );
  assert(zeroEval.swaps[0].driverA.toExperienceDays === 10, 'swap grounded in destination 10-day evidence');
  assert(zeroEval.swaps[0].reason.indexOf('経験') >= 0, 'test2: 0→8 with time gain cites experience');
  assert(
    zeroEval.swaps[0].driverA.fromDeliveryDurationMinutes != null &&
      zeroEval.swaps[0].driverA.fromPredictedFinishTime,
    'delivery duration is separate from predicted finish'
  );

  var bothUnknownExp = AssignSupportCore.parseExperienceRows(
    [
      swapParseHeaders,
      ['TA', 'DriverA', '西新', '0', '2026-08-10', '0', '0', '', '0', '0'],
      ['TB', 'DriverB', '樋井川', '0', '2026-08-11', '0', '0', '', '0', '0'],
    ],
    { knownTransportIds: new Set(['TA', 'TB']) }
  );
  var bothUnknownEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(swapRoutes, swapWorkers, bothUnknownExp, {
    cycle: 1,
    amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
    getPackagesPerHour: function () {
      return 18;
    },
  });
  assert((bothUnknownEval.swaps || []).length === 0, '0→0 with same PPH has no time gain so no swap');

  var zeroZeroPphExp = AssignSupportCore.parseExperienceRows(
    [
      swapParseHeaders,
      ['TA', 'DriverA', '西新', '0', '2026-08-10', '0', '0', '', '0', '0'],
      ['TB', 'DriverB', '樋井川', '0', '2026-08-11', '0', '0', '', '0', '0'],
    ],
    { knownTransportIds: new Set(['TA', 'TB']) }
  );
  var zeroZeroPphEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX20', packages: 100, stops: 80, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 93, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
    ],
    swapWorkers,
    zeroZeroPphExp,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
      getPackagesPerHour: function (_n, tid) {
        return tid === 'TA' ? 8 : 30;
      },
    }
  );
  assert((zeroZeroPphEval.swaps || []).length === 1, 'test1: 0→0 still swaps when PPH load improves 20+ min');
  assert(zeroZeroPphEval.swaps[0].totalImprovementMinutes >= 20, 'test1: 20+ minute finish improvement');
  assert(
    zeroZeroPphEval.swaps[0].reason.indexOf('PPH') >= 0,
    'test1: reason is PPH/load based'
  );

  var alreadyGood = AssignSupportCore.parseExperienceRows(
    [
      swapParseHeaders,
      ['TA', 'DriverA', '西新', '12', '2026-08-15', '8', '0', 'high', '80', '120'],
      ['TA', 'DriverA', '樋井川', '1', '2026-08-10', '1', '0', 'high', '10', '20'],
      ['TB', 'DriverB', '樋井川', '11', '2026-08-14', '7', '0', 'high', '70', '110'],
      ['TB', 'DriverB', '西新', '1', '2026-08-11', '1', '0', 'high', '10', '20'],
    ],
    { knownTransportIds: new Set(['TA', 'TB']) }
  );
  var goodEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(swapRoutes, swapWorkers, alreadyGood, {
    cycle: 1,
    amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
    getPackagesPerHour: function () {
      return 18;
    },
  });
  assert((goodEval.swaps || []).length === 0, 'already-fit amazon assign is not shuffled');
  assert(goodEval.summary.okCount === 2, 'both routes unchanged');

  var unknownEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(swapRoutes, swapWorkers, swapExp, {
    cycle: 1,
    amazonAssignments: [
      {
        routeCode: 'DCX20',
        driverName: 'DriverA',
        serviceType: '',
        transportId: 'TA',
      },
      {
        routeCode: 'DCX40',
        driverName: 'DriverB',
        serviceType: '',
        transportId: 'TB',
      },
    ],
    getPackagesPerHour: function () {
      return 18;
    },
  });
  assert(unknownEval.routes.every(function (r) { return r.evaluationStatus !== 'admin_review'; }), 'unknown type is not admin review');
  assert((unknownEval.swaps || []).length === 1, 'unknown type still evaluates area swap');

  var bikeSwapEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX20', packages: 90, stops: 70, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 90, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
    ],
    [
      { name: 'DriverA', driverName: 'DriverA', transportId: 'TA', shiftCode: 'bike' },
      { name: 'DriverB', driverName: 'DriverB', transportId: 'TB', shiftCode: '〇' },
    ],
    swapExp,
    {
      cycle: 1,
      amazonAssignments: [
        { routeCode: 'DCX20', driverName: 'DriverA', serviceType: 'Biker', transportId: 'TA' },
        stdAmazon('DCX40', 'DriverB', 'TB'),
      ],
      getPackagesPerHour: function () {
        return 18;
      },
    }
  );
  assert((bikeSwapEval.swaps || []).length === 0, 'test6: bike and standard are not swapped even if time would improve');

  var loseStrongExp = AssignSupportCore.parseExperienceRows(
    [
      swapParseHeaders,
      ['TA', 'DriverA', '西新', '8', '2026-08-15', '6', '0', 'high', '80', '120'],
      ['TB', 'DriverB', '樋井川', '0', '2026-08-11', '0', '0', '', '0', '0'],
    ],
    { knownTransportIds: new Set(['TA', 'TB']) }
  );
  var loseStrongEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX20', packages: 100, stops: 80, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 70, stops: 50, areas: [{ label: '樋井川', role: 'primary' }] },
    ],
    swapWorkers,
    loseStrongExp,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
      getPackagesPerHour: function (_n, tid) {
        return tid === 'TA' ? 18 : 22;
      },
    }
  );
  assert((loseStrongEval.swaps || []).length === 0, 'test3: 8→0 with only slight time gain keeps Amazon assign');

  var expOnlyExp = AssignSupportCore.parseExperienceRows(
    [
      swapParseHeaders,
      ['TA', 'DriverA', '西新', '1', '2026-08-10', '1', '0', 'high', '10', '20'],
      ['TA', 'DriverA', '樋井川', '8', '2026-08-15', '6', '0', 'high', '80', '120'],
      ['TB', 'DriverB', '樋井川', '2', '2026-08-11', '1', '0', 'high', '20', '30'],
      ['TB', 'DriverB', '西新', '7', '2026-08-14', '5', '0', 'high', '70', '100'],
    ],
    { knownTransportIds: new Set(['TA', 'TB']) }
  );
  var expOnlyEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX20', packages: 20, stops: 15, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 20, stops: 15, areas: [{ label: '樋井川', role: 'primary' }] },
    ],
    swapWorkers,
    expOnlyExp,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
      getPackagesPerHour: function () {
        return 18;
      },
    }
  );
  assert((expOnlyEval.swaps || []).length === 0, 'test4: experience-only gain without 8+ min finish improvement does not swap');

  var sameExpPph = AssignSupportCore.parseExperienceRows(
    [
      swapParseHeaders,
      ['TA', 'DriverA', '西新', '8', '2026-08-15', '6', '0', 'high', '80', '120'],
      ['TA', 'DriverA', '樋井川', '8', '2026-08-14', '6', '0', 'high', '80', '120'],
      ['TB', 'DriverB', '樋井川', '8', '2026-08-15', '6', '0', 'high', '80', '120'],
      ['TB', 'DriverB', '西新', '8', '2026-08-14', '6', '0', 'high', '80', '120'],
    ],
    { knownTransportIds: new Set(['TA', 'TB']) }
  );
  var sameExpPphEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX20', packages: 100, stops: 80, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 93, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
    ],
    swapWorkers,
    sameExpPph,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
      getPackagesPerHour: function (_n, tid) {
        return tid === 'TA' ? 8 : 30;
      },
    }
  );
  assert((sameExpPphEval.swaps || []).length === 1, 'test5: same experience still swaps on large PPH/load gain');
  assert(sameExpPphEval.swaps[0].totalImprovementMinutes >= 20, 'test5: large finish improvement');
  assert(sameExpPphEval.swaps[0].reason.indexOf('PPH') >= 0, 'test5: reason is PPH/load');

  var missingDriverEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [{ routeCode: 'DCX50', packages: 80, stops: 60, areas: [{ label: '西新', role: 'primary' }] }],
    swapWorkers,
    swapExp,
    {
      cycle: 1,
      amazonAssignments: [{ routeCode: 'DCX50', driverName: '', serviceType: 'Standard Parcel', transportId: '' }],
    }
  );
  assert(missingDriverEval.summary.inputMissingCount === 1, 'missing driver is input missing');
  assert(missingDriverEval.summary.adminReviewCount === 0, 'missing driver is not admin review');
  assert(missingDriverEval.inputMissingRoutes[0].inputMissingReason === 'ドライバー特定不能', 'driver unknown reason');

  var missingAreaEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [{ routeCode: 'DCX51', packages: 80, stops: 60, areas: [] }],
    swapWorkers,
    swapExp,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DCX51', 'DriverA', 'TA')],
    }
  );
  assert(missingAreaEval.summary.inputMissingCount === 1, 'missing area is input missing');
  assert(missingAreaEval.summary.adminReviewCount === 0, 'missing area is not admin review');

  var changeExpRows = [
    headers,
    ['A789', '山田', '七隈', '18', '2026-08-15', '10', '0', 'high'],
    ['A999', '佐藤', '原', '8', '2026-08-14', '2', '0', 'shared'],
  ];
  var changeExp = AssignSupportCore.parseExperienceRows(changeExpRows, { knownTransportIds: known });
  var changeEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [{ routeCode: 'DCX30', packages: 80, stops: 60, areas: [{ label: '七隈', role: 'primary' }] }],
    [
      { name: '山田', driverName: '山田', transportId: 'A789', shiftCode: '〇' },
      { name: '佐藤', driverName: '佐藤', transportId: 'A999', shiftCode: '〇' },
    ],
    changeExp,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DCX30', '佐藤', 'A999')],
    }
  );
  assert((changeEval.swaps || []).length === 0, 'no one-way steal without a swap partner');
  assert(changeEval.routes[0].evaluationStatus === 'ok', 'single route stays on amazon assign');

  var okEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [{ routeCode: 'DCX10', packages: 84, stops: 70, areas: [{ label: '原', role: 'primary' }] }],
    tierWorkersC3,
    tierExp,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DCX10', '山田', 'A789')],
    }
  );
  assert(okEval.routes[0].evaluationStatus === 'ok', 'ok when amazon assign tier A and no swap');

  var globalExpRows = [
    headers,
    ['A789', '山田', '原', '30', '2026-08-15', '10', '0', 'high'],
    ['A789', '山田', '今宿', '20', '2026-08-14', '5', '0', 'high'],
    ['A999', '佐藤', '原', '25', '2026-08-14', '8', '0', 'high'],
  ];
  var globalWorkers = [
    { name: '山田', driverName: '山田', transportId: 'A789', shiftCode: '〇' },
    { name: '佐藤', driverName: '佐藤', transportId: 'A999', shiftCode: '〇' },
  ];
  var globalExp = AssignSupportCore.parseExperienceRows(globalExpRows, { knownTransportIds: known });
  var routeEasy = {
    routeCode: 'DSX01',
    packages: 80,
    stops: 60,
    areas: [{ label: '原', role: 'primary' }],
  };
  var routeScarce = {
    routeCode: 'DSX02',
    packages: 60,
    stops: 50,
    areas: [{ label: '今宿', role: 'primary' }],
  };
  var scarceFirstPlan = AssignSupportCore.buildFirstAssignPlan(
    [routeEasy, routeScarce],
    globalWorkers,
    globalExp,
    { cycle: 3 }
  );
  var byCode = {};
  for (var gi = 0; gi < scarceFirstPlan.routes.length; gi++) {
    var gr = scarceFirstPlan.routes[gi];
    byCode[gr.routeCode] = gr;
  }
  assert(
    byCode.DSX02 && byCode.DSX02.firstRecommendation.transportId === 'A789',
    'scarce 今宿 route keeps unique experienced driver'
  );
  assert(
    byCode.DSX01 && byCode.DSX01.firstRecommendation.transportId === 'A999',
    'easy route does not consume scarce driver'
  );
  var processing = scarceFirstPlan.routes
    .slice()
    .sort(function (a, b) {
      return a.processingOrder - b.processingOrder;
    });
  assert(processing[0].routeCode === 'DSX02', 'scarce route processed first');

  var lookaheadExp = AssignSupportCore.parseExperienceRows(
    [
      headers,
      ['A789', '山田', '原', '30', '2026-08-15', '10', '0', 'high'],
      ['A789', '山田', '今宿', '20', '2026-08-14', '5', '0', 'high'],
      ['A999', '佐藤', '原', '25', '2026-08-14', '8', '0', 'high'],
      ['A888', '鈴木', '今宿', '20', '2026-08-12', '6', '0', 'high'],
    ],
    { knownTransportIds: known }
  );
  var lookaheadWorkers = [
    { name: '山田', driverName: '山田', transportId: 'A789', shiftCode: '〇' },
    { name: '佐藤', driverName: '佐藤', transportId: 'A999', shiftCode: '〇' },
    { name: '鈴木', driverName: '鈴木', transportId: 'A888', shiftCode: 'C3' },
  ];
  var lookaheadRoutes = [
    { routeCode: 'DSX01', packages: 110, stops: 70, areas: [{ label: '原', role: 'primary' }] },
    { routeCode: 'DSX02', packages: 80, stops: 70, areas: [{ label: '今宿', role: 'primary' }] },
  ];
  var lookaheadPlan = AssignSupportCore.buildFirstAssignPlan(
    lookaheadRoutes,
    lookaheadWorkers,
    lookaheadExp,
    {
      cycle: 3,
    }
  );
  var lk = {};
  for (var li = 0; li < lookaheadPlan.routes.length; li++) {
    lk[lookaheadPlan.routes[li].routeCode] = lookaheadPlan.routes[li];
  }
  assert(
    lk.DSX01.firstRecommendation.transportId === 'A999',
    'look-ahead preserves scarce driver for other route'
  );
  assert(lk.DSX01.firstRecommendation.displacedCandidate, 'displaced top candidate recorded');
  assert(
    lk.DSX02.firstRecommendation.transportId === 'A789',
    'scarce driver assigned to route that needs them'
  );

  var highPkgPlan = AssignSupportCore.buildFirstAssignPlan(
    [{ routeCode: 'DSX90', packages: 90, stops: 70, areas: [{ label: '原', role: 'primary' }] }],
    [
      { name: 'A', driverName: 'A', transportId: 'A789', shiftCode: '〇' },
      { name: 'B', driverName: 'B', transportId: 'A999', shiftCode: '〇' },
    ],
    AssignSupportCore.parseExperienceRows(
      [
        headers,
        ['A789', 'A', '原', '20', '2026-08-15', '8', '0', 'high'],
        ['A999', 'B', '原', '20', '2026-08-14', '8', '0', 'high'],
      ],
      { knownTransportIds: known }
    ),
    {
      cycle: 3,
      getPackagesPerHour: function (_n, tid) {
        return tid === 'A999' ? 25 : 18;
      },
    }
  );
  assert(
    highPkgPlan.routes[0].firstRecommendation.transportId === 'A789',
    'tier A not beaten by higher capability alone'
  );

  var det1 = AssignSupportCore.buildFirstAssignPlan(lookaheadRoutes, globalWorkers, globalExp, { cycle: 3 });
  var det2 = AssignSupportCore.buildFirstAssignPlan(lookaheadRoutes, globalWorkers, globalExp, { cycle: 3 });
  assert(
    det1.routes.map(function (r) {
      return r.firstRecommendation && r.firstRecommendation.transportId;
    }).join(',') ===
      det2.routes
        .map(function (r) {
          return r.firstRecommendation && r.firstRecommendation.transportId;
        })
        .join(','),
    'deterministic plan on repeated runs'
  );

  var cycle2Mixed = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DMX01', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
      { routeCode: 'DMMRA1', packages: 20, stops: 10, areas: [{ label: '原', role: 'primary' }] },
      { routeCode: 'DMMRB1', packages: 20, stops: 10, areas: [{ label: '原', role: 'primary' }] },
      { routeCode: 'DCX01', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
    ],
    [{ name: '山田', driverName: '山田', transportId: 'A789', shiftCode: '〇' }],
    tierExp,
    {
      cycle: 2,
      amazonAssignments: [
        stdAmazon('DMX01', '山田', 'A789'),
        stdAmazon('DMMRA1', '山田', 'A789'),
        stdAmazon('DMMRB1', '山田', 'A789'),
        stdAmazon('DCX01', '山田', 'A789'),
      ],
    }
  );
  assert(cycle2Mixed.summary.totalRoutes === 1, 'cycle2 only DMX remains');
  assert(cycle2Mixed.routes[0].routeCode === 'DMX01', 'kept route is DMX01');
  assert(
    cycle2Mixed.routes.every(function (r) {
      return String(r.routeCode).indexOf('DMX') === 0 && String(r.routeCode).indexOf('DMMR') !== 0;
    }),
    'no DMMRA/DMMRB/DCX in cycle2 results'
  );

  var dualTidWorkers = [
    { name: 'DriverA', driverName: 'DriverA', transportId: 'TA', shiftCode: '〇' },
    { name: 'DriverB', driverName: 'DriverB', transportId: 'TB', shiftCode: '〇' },
    { name: 'DriverC', driverName: 'DriverC', transportId: 'TC', shiftCode: '〇' },
  ];
  var dualTidEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX33', packages: 100, stops: 80, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 93, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
      { routeCode: 'DCX43', packages: 100, stops: 80, areas: [{ label: '鳥飼', role: 'primary' }] },
      { routeCode: 'DCX50', packages: 93, stops: 70, areas: [{ label: '別府', role: 'primary' }] },
    ],
    dualTidWorkers,
    bothUnknownExp,
    {
      cycle: 1,
      amazonAssignments: [
        stdAmazon('DCX33', 'DriverA', 'TA'),
        stdAmazon('DCX40', 'DriverB', 'TB'),
        stdAmazon('DCX43', 'DriverA', 'TA'),
        stdAmazon('DCX50', 'DriverC', 'TC'),
      ],
      getPackagesPerHour: function (_n, tid) {
        return tid === 'TA' ? 8 : 30;
      },
    }
  );
  assert((dualTidEval.swaps || []).length === 1, 'test5: same transportId only used in one swap');
  var dualUsedTids = {};
  dualTidEval.swaps.forEach(function (sw) {
    dualUsedTids[sw.driverA.transportId] = (dualUsedTids[sw.driverA.transportId] || 0) + 1;
    dualUsedTids[sw.driverB.transportId] = (dualUsedTids[sw.driverB.transportId] || 0) + 1;
  });
  assert(dualUsedTids.TA === 1, 'test5: TA appears in exactly one swap');
  assert(
    dualTidEval.routes.filter(function (r) {
      return r.routeCode === 'DCX43' || r.routeCode === 'DCX33';
    }).some(function (r) {
      return r.evaluationStatus === 'ok';
    }),
    'test5: the other TA slot stays unswapped'
  );

  var nurseryStdEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX20', packages: 100, stops: 80, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 93, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
    ],
    [
      { name: 'DriverA', driverName: 'DriverA', transportId: 'TA', shiftCode: '〇' },
      { name: 'DriverB', driverName: 'DriverB', transportId: 'TB', shiftCode: '〇' },
    ],
    bothUnknownExp,
    {
      cycle: 1,
      amazonAssignments: [
        {
          routeCode: 'DCX20',
          driverName: 'DriverA',
          serviceType: 'Nursery Route Level 1',
          transportId: 'TA',
        },
        stdAmazon('DCX40', 'DriverB', 'TB'),
      ],
      getPackagesPerHour: function (_n, tid) {
        return tid === 'TA' ? 8 : 30;
      },
    }
  );
  assert(AssignSupportCore.VEHICLE_SWAP_CONFIG.NURSERY_COMPATIBLE_WITH_STANDARD === true, 'nursery compat constant default true');
  assert((nurseryStdEval.swaps || []).length === 1, 'test6: nursery ⇄ standard allowed when constant true');
  assert(
    (nurseryStdEval.swaps[0].vehicleKindA === 'nursery' && nurseryStdEval.swaps[0].vehicleKindB === 'standard') ||
      (nurseryStdEval.swaps[0].vehicleKindA === 'standard' && nurseryStdEval.swaps[0].vehicleKindB === 'nursery'),
    'test6: vehicle kinds are nursery and standard'
  );

  var bikeNurseryEval = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX20', packages: 100, stops: 80, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 93, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
    ],
    [
      { name: 'DriverA', driverName: 'DriverA', transportId: 'TA', shiftCode: 'bike' },
      { name: 'DriverB', driverName: 'DriverB', transportId: 'TB', shiftCode: '〇' },
    ],
    bothUnknownExp,
    {
      cycle: 1,
      amazonAssignments: [
        { routeCode: 'DCX20', driverName: 'DriverA', serviceType: 'Biker', transportId: 'TA' },
        {
          routeCode: 'DCX40',
          driverName: 'DriverB',
          serviceType: 'Nursery Route Level 1',
          transportId: 'TB',
        },
      ],
      getPackagesPerHour: function (_n, tid) {
        return tid === 'TA' ? 8 : 30;
      },
    }
  );
  assert((bikeNurseryEval.swaps || []).length === 0, 'test7: bike ⇄ nursery is not swapped');

  var bikeStdEval2 = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [
      { routeCode: 'DCX20', packages: 100, stops: 80, areas: [{ label: '西新', role: 'primary' }] },
      { routeCode: 'DCX40', packages: 93, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
    ],
    [
      { name: 'DriverA', driverName: 'DriverA', transportId: 'TA', shiftCode: 'bike' },
      { name: 'DriverB', driverName: 'DriverB', transportId: 'TB', shiftCode: '〇' },
    ],
    bothUnknownExp,
    {
      cycle: 1,
      amazonAssignments: [
        { routeCode: 'DCX20', driverName: 'DriverA', serviceType: 'Biker', transportId: 'TA' },
        stdAmazon('DCX40', 'DriverB', 'TB'),
      ],
      getPackagesPerHour: function (_n, tid) {
        return tid === 'TA' ? 8 : 30;
      },
    }
  );
  assert((bikeStdEval2.swaps || []).length === 0, 'test7: bike ⇄ standard is not swapped');

  function makeTimeSlot(routeCode, driver, tid, finishMinutes, predictedEnd, vehicleKind) {
    var kind = vehicleKind || 'standard';
    var score = {
      driverName: driver,
      transportId: tid,
      primaryArea: '原',
      primaryExperienceDays: 0,
      packagesPerHour: 18,
    };
    return {
      route: {
        routeCode: routeCode,
        packages: 0,
        stops: 10,
        areas: [{ label: '原', role: 'primary' }],
        routeVehicleType: kind,
        amazonAssignment: {
          driverName: driver,
          transportId: tid,
          predictedEnd: predictedEnd,
          totalDeliveries: 0,
          serviceType: kind === 'nursery' ? 'Nursery Route' : 'Standard Parcel',
        },
      },
      worker: { driverName: driver, name: driver, transportId: tid, shiftCode: '〇' },
      amz: { driverName: driver, transportId: tid, predictedEnd: predictedEnd },
      score: score,
      scoreOnPartner: score,
      finishMinutes: finishMinutes,
      finishTime: predictedEnd,
      areaScore: 0,
      vehicleKind: kind,
      vehicleGroup: 'standard',
    };
  }

  var warn11 = AssignSupportCore.classifySwapWorsenWarning(11, -19);
  assert(warn11 && warn11.level === 'worsen_10plus', 'test8: 11 min worsen is 10+ warning');
  var pair11 = AssignSupportCore.evaluateSwapPair(
    makeTimeSlot('DCX20', 'DriverA', 'TA', 840, '16:19'),
    makeTimeSlot('DCX40', 'DriverB', 'TB', 1020, '14:11')
  );
  assert(pair11.accepted === true, 'test8: 11 min worsen still accepted');
  assert(pair11.timeImprovement === 30, 'test8: total 30 min improvement');
  assert(pair11.worsenAMinutes === 11 || pair11.worsenBMinutes === 11, 'test8: one side worsens 11');
  assert(pair11.worsenWarning && pair11.worsenWarning.level === 'worsen_10plus', 'test8: warning displayed not rejected');

  var warn15 = AssignSupportCore.classifySwapWorsenWarning(15, -55);
  assert(warn15 && warn15.level === 'near_limit', 'test9: 15 min worsen is near-limit warning');
  var pair15 = AssignSupportCore.evaluateSwapPair(
    makeTimeSlot('DCX20', 'DriverA', 'TA', 840, '16:05'),
    makeTimeSlot('DCX40', 'DriverB', 'TB', 1020, '14:15')
  );
  assert(pair15.accepted === true, 'test9: 15 min worsen still accepted');
  assert(pair15.timeImprovement === 40, 'test9: total 40 min improvement');
  assert(pair15.worsenAMinutes === 15 || pair15.worsenBMinutes === 15, 'test9: one side worsens 15');
  assert(pair15.worsenWarning && pair15.worsenWarning.level === 'near_limit', 'test9: near-limit warning');

  var pair16 = AssignSupportCore.evaluateSwapPair(
    makeTimeSlot('DCX20', 'DriverA', 'TA', 840, '16:04'),
    makeTimeSlot('DCX40', 'DriverB', 'TB', 1020, '14:16')
  );
  assert(pair16.accepted === false, 'test10: 16 min worsen is rejected');
  assert(pair16.rejectedReason === 'one_side_worsens', 'test10: rejected as one_side_worsens');

  var anomaly = AssignSupportCore.detectRouteDataAnomaly(
    { packages: 3, stops: 92, routeVehicleType: 'unknown' },
    { totalDeliveries: 3 }
  );
  assert(anomaly.hasAnomaly === true, 'stops>>packages is flagged');
  assert(anomaly.warningLabel.indexOf('routeデータ異常') >= 0, 'anomaly label is set');

  function makeStationRoutes(prefix, count) {
    var list = [];
    for (var n = 1; n <= count; n++) {
      list.push({
        routeCode: prefix + n,
        packages: 80,
        stops: 60,
        areas: [{ label: '原', role: 'primary' }],
      });
    }
    return list;
  }
  function makeGdsAssign(prefix, fromN, toN) {
    var list = [];
    for (var n = fromN; n <= toN; n++) {
      list.push(stdAmazon(prefix + n, 'Driver' + n, 'T' + n));
    }
    return list;
  }
  var gdsPopWorkers = [];
  for (var wi = 1; wi <= 60; wi++) {
    gdsPopWorkers.push({
      name: 'Driver' + wi,
      driverName: 'Driver' + wi,
      transportId: 'T' + wi,
      shiftCode: '〇',
    });
  }

  var cycle1GdsPop = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    makeStationRoutes('DCX', 60),
    gdsPopWorkers,
    bothUnknownExp,
    { cycle: 1, amazonAssignments: makeGdsAssign('DCX', 35, 60) }
  );
  assert(cycle1GdsPop.summary.stationRouteCount === 60, 'test-gds1: station DCX is 60');
  assert(cycle1GdsPop.summary.gdsAssignmentCount === 26, 'test-gds1: GDS assign is 26');
  assert(cycle1GdsPop.summary.evaluableCount === 26, 'test-gds1: evaluable is 26');
  assert(cycle1GdsPop.summary.gdsOutOfScopeCount === 34, 'test-gds1: 34 are GDS out of scope');
  assert(cycle1GdsPop.summary.inputMissingCount === 0, 'test-gds1: not input_missing 34');
  assert(cycle1GdsPop.summary.adminReviewCount === 0, 'test-gds1: out of scope is not admin review');
  assert(cycle1GdsPop.summary.assignmentIncomplete === false, 'test-gds1: GDS gap is not incomplete assign');

  var outOfScopeCodes = (cycle1GdsPop.gdsOutOfScopeRoutes || []).map(function (r) {
    return r.routeCode;
  });
  assert(outOfScopeCodes.indexOf('DCX1') >= 0, 'test-gds2: DCX1 is GDS out of scope');
  assert(
    (cycle1GdsPop.routes || []).every(function (r) {
      return r.routeCode !== 'DCX1';
    }),
    'test-gds2: DCX1 is not in swap/admin/input-missing routes'
  );
  assert(
    (cycle1GdsPop.adminReviewRoutes || []).every(function (r) {
      return r.routeCode !== 'DCX1';
    }),
    'test-gds2: DCX1 is not admin review'
  );

  var missingDriverStillBroken = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    [{ routeCode: 'DCX50', packages: 80, stops: 60, areas: [{ label: '西新', role: 'primary' }] }],
    gdsPopWorkers,
    bothUnknownExp,
    {
      cycle: 1,
      amazonAssignments: [{ routeCode: 'DCX50', driverName: '', serviceType: 'Standard Parcel', transportId: '' }],
    }
  );
  assert(missingDriverStillBroken.summary.gdsAssignmentCount === 1, 'test-gds3: GDS row exists');
  assert(missingDriverStillBroken.summary.inputMissingCount === 1, 'test-gds3: driver missing is real input missing');
  assert(missingDriverStillBroken.inputMissingRoutes[0].inputMissingReason === 'ドライバー特定不能', 'test-gds3: reason');

  var cycle2GdsPop = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    makeStationRoutes('DMX', 47),
    gdsPopWorkers,
    bothUnknownExp,
    { cycle: 2, amazonAssignments: makeGdsAssign('DMX', 31, 47) }
  );
  assert(cycle2GdsPop.summary.stationRouteCount === 47, 'test-gds4: station DMX is 47');
  assert(cycle2GdsPop.summary.gdsAssignmentCount === 17, 'test-gds4: GDS assign is 17');
  assert(cycle2GdsPop.summary.evaluableCount === 17, 'test-gds4: evaluable is 17');
  assert(cycle2GdsPop.summary.gdsOutOfScopeCount === 30, 'test-gds4: 30 are not errors');
  assert(cycle2GdsPop.summary.inputMissingCount === 0, 'test-gds4: remainder is not input missing');
  assert(cycle2GdsPop.summary.adminReviewCount === 0, 'test-gds4: remainder is not admin review');

  var station60ForSwap = makeStationRoutes('DCX', 60).map(function (r) {
    if (r.routeCode === 'DCX20') {
      return { routeCode: 'DCX20', packages: 100, stops: 80, areas: [{ label: '西新', role: 'primary' }] };
    }
    if (r.routeCode === 'DCX40') {
      return { routeCode: 'DCX40', packages: 93, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] };
    }
    return r;
  });
  var gdsOnlySwap = AssignSupportCore.buildAmazonAssignEvaluationPlan(
    station60ForSwap,
    swapWorkers,
    sameExpPph,
    {
      cycle: 1,
      amazonAssignments: [stdAmazon('DCX20', 'DriverA', 'TA'), stdAmazon('DCX40', 'DriverB', 'TB')],
      getPackagesPerHour: function (_n, tid) {
        return tid === 'TA' ? 8 : 30;
      },
    }
  );
  assert((gdsOnlySwap.swaps || []).length === (sameExpPphEval.swaps || []).length, 'test-gds5: extra station routes do not add swaps');
  assert(gdsOnlySwap.swaps[0].routeCodeA === sameExpPphEval.swaps[0].routeCodeA, 'test-gds5: pair A unchanged');
  assert(gdsOnlySwap.swaps[0].routeCodeB === sameExpPphEval.swaps[0].routeCodeB, 'test-gds5: pair B unchanged');
  assert(
    gdsOnlySwap.swaps[0].totalImprovementMinutes === sameExpPphEval.swaps[0].totalImprovementMinutes,
    'test-gds5: improvement minutes unchanged'
  );
  assert(gdsOnlySwap.summary.gdsOutOfScopeCount === 58, 'test-gds5: 58 station DCX are GDS out of scope');
  assert(AssignSupportCore.SWAP_OPTIMIZE_CONFIG.MAX_SWAP_PAIRS === 10, 'max pairs unchanged');
  assert(AssignSupportCore.VEHICLE_SWAP_CONFIG.NURSERY_COMPATIBLE_WITH_STANDARD === true, 'nursery compat unchanged');
  assert(AssignSupportCore.AREA_EXPERIENCE_SPEED_BONUS.maxFactor === 1.1, 'maxFactor unchanged');

  console.log('assign-support tests passed');
}

runTests();
