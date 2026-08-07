// ===== DEMO DATA - 架空データ =====
// 本番の実名データは一切含まない。すべて架空。
var DEMO_MODE = true;

var DEMO_DRIVERS = [
  {name:'山田 太郎',dept:'GDSダイレクト',tid:'A000000001',pph:28.5,mis:0.05,del:97.2,wd:45,tp:6800,dist:2100,inc:1},
  {name:'佐藤 花子',dept:'GDSダイレクト',tid:'A000000002',pph:26.1,mis:0.08,del:95.8,wd:38,tp:5200,dist:1800,inc:2},
  {name:'鈴木 一郎',dept:'GDSダイレクト',tid:'A000000003',pph:24.3,mis:0.12,del:93.5,wd:42,tp:5900,dist:1950,inc:3},
  {name:'高橋 美咲',dept:'GDSダイレクト',tid:'A000000004',pph:22.7,mis:0.03,del:98.1,wd:50,tp:7100,dist:2300,inc:0},
  {name:'田中 健太',dept:'GDSダイレクト',tid:'A000000005',pph:21.0,mis:0.15,del:91.2,wd:35,tp:4500,dist:1600,inc:4},
  {name:'渡辺 翔太',dept:'GDS管理',tid:'A000000006',pph:25.8,mis:0.04,del:96.9,wd:40,tp:6200,dist:2000,inc:1},
  {name:'伊藤 さくら',dept:'GDS管理',tid:'A000000007',pph:23.4,mis:0.09,del:94.3,wd:33,tp:4800,dist:1700,inc:2},
  {name:'中村 大輝',dept:'GDS管理',tid:'A000000008',pph:20.5,mis:0.11,del:92.7,wd:28,tp:3900,dist:1400,inc:3},
  {name:'小林 裕子',dept:'GDS管理',tid:'A000000009',pph:19.2,mis:0.06,del:95.5,wd:44,tp:5600,dist:1850,inc:1},
  {name:'加藤 拓海',dept:'GDSパート',tid:'A000000010',pph:18.5,mis:0.02,del:98.8,wd:20,tp:2800,dist:900,inc:0},
  {name:'松本 彩花',dept:'GDSパート',tid:'A000000011',pph:17.1,mis:0.07,del:96.1,wd:22,tp:3100,dist:1000,inc:1},
  {name:'吉田 蓮',dept:'GDSパート',tid:'A000000012',pph:16.3,mis:0.14,del:90.5,wd:18,tp:2400,dist:800,inc:2},
  {name:'山口 真由',dept:'JHS',tid:'A000000013',pph:27.2,mis:0.03,del:97.8,wd:48,tp:7500,dist:2400,inc:1},
  {name:'石田 陽介',dept:'JHS',tid:'A000000014',pph:25.0,mis:0.10,del:93.9,wd:41,tp:6000,dist:1900,inc:3},
  {name:'森 優衣',dept:'JHS',tid:'A000000015',pph:23.8,mis:0.05,del:96.4,wd:36,tp:5300,dist:1750,inc:1},
  {name:'池田 悠真',dept:'JHS',tid:'A000000016',pph:22.1,mis:0.08,del:95.0,wd:30,tp:4200,dist:1500,inc:2},
  {name:'前田 結衣',dept:'JHS',tid:'A000000017',pph:20.6,mis:0.02,del:98.5,wd:25,tp:3500,dist:1200,inc:0},
  {name:'藤田 海斗',dept:'AE物流',tid:'A000000018',pph:24.5,mis:0.06,del:96.2,wd:39,tp:5800,dist:1850,inc:2},
  {name:'岡田 千尋',dept:'AE物流',tid:'A000000019',pph:22.8,mis:0.09,del:94.1,wd:34,tp:4700,dist:1600,inc:1},
  {name:'後藤 涼太',dept:'AE物流',tid:'A000000020',pph:21.3,mis:0.13,del:92.0,wd:29,tp:3800,dist:1350,inc:3},
  {name:'長谷川 美月',dept:'AE物流',tid:'A000000021',pph:19.7,mis:0.04,del:97.3,wd:43,tp:6100,dist:2050,inc:0},
  {name:'村上 颯太',dept:'ファンタジスタ',tid:'A000000022',pph:26.4,mis:0.07,del:95.6,wd:46,tp:7200,dist:2250,inc:2},
  {name:'近藤 心愛',dept:'ファンタジスタ',tid:'A000000023',pph:24.0,mis:0.11,del:93.2,wd:37,tp:5400,dist:1800,inc:3},
  {name:'坂本 大和',dept:'ファンタジスタ',tid:'A000000024',pph:21.8,mis:0.03,del:97.9,wd:32,tp:4400,dist:1450,inc:0},
  {name:'遠藤 桃花',dept:'ファンタジスタ',tid:'A000000025',pph:20.2,mis:0.08,del:95.3,wd:27,tp:3600,dist:1250,inc:1},
  {name:'青木 大翔',dept:'LINGｓ',tid:'A000000026',pph:23.6,mis:0.05,del:96.7,wd:44,tp:6500,dist:2100,inc:1},
  {name:'藤井 琴音',dept:'LINGｓ',tid:'A000000027',pph:21.9,mis:0.10,del:93.8,wd:38,tp:5100,dist:1700,inc:2},
  {name:'三浦 陸斗',dept:'LINGｓ',tid:'A000000028',pph:20.0,mis:0.06,del:95.9,wd:31,tp:4100,dist:1380,inc:1},
  {name:'野田 美緒',dept:'LINGｓ',tid:'A000000029',pph:18.8,mis:0.12,del:91.8,wd:26,tp:3400,dist:1150,inc:3},
  {name:'松田 隼人',dept:'OFK6',tid:'A000000030',pph:25.3,mis:0.04,del:97.0,wd:47,tp:7000,dist:2200,inc:1},
  {name:'原田 七海',dept:'OFK6',tid:'A000000031',pph:23.1,mis:0.07,del:95.4,wd:40,tp:5700,dist:1900,inc:2},
  {name:'小川 蒼空',dept:'OFK6',tid:'A000000032',pph:21.5,mis:0.09,del:94.5,wd:35,tp:4900,dist:1650,inc:1},
  {name:'岩崎 咲良',dept:'OFK6',tid:'A000000033',pph:19.4,mis:0.02,del:98.3,wd:23,tp:3200,dist:1050,inc:0},
  {name:'中島 春樹',dept:'GDSダイレクト',tid:'A000000034',pph:20.1,mis:0.16,del:89.5,wd:31,tp:4300,dist:1500,inc:5},
  {name:'木村 葵',dept:'GDS管理',tid:'A000000035',pph:22.6,mis:0.05,del:96.3,wd:36,tp:5100,dist:1700,inc:1},
  {name:'宮崎 大地',dept:'JHS',tid:'A000000036',pph:18.9,mis:0.18,del:88.7,wd:24,tp:3300,dist:1100,inc:6},
  {name:'清水 柚希',dept:'AE物流',tid:'A000000037',pph:26.7,mis:0.01,del:99.1,wd:52,tp:8000,dist:2500,inc:0},
  {name:'福田 空',dept:'ファンタジスタ',tid:'A000000038',pph:15.2,mis:0.20,del:87.3,wd:19,tp:2200,dist:750,inc:4},
  {name:'西村 花音',dept:'LINGｓ',tid:'A000000039',pph:24.8,mis:0.06,del:96.0,wd:42,tp:6300,dist:2050,inc:1},
  {name:'太田 湊',dept:'OFK6',tid:'A000000040',pph:17.5,mis:0.11,del:93.0,wd:21,tp:2900,dist:950,inc:2}
];

// FTDS理由リスト
var DEMO_FTDS_REASONS = [
  '不在', '配達未試行', '荷物紛失', '住所不明', 'お届け先アクセス不可',
  '配達日変更', '営業所保管', '受取拒否', '持戻り（その他）', '天候不良'
];

// CC理由リスト
var DEMO_CC_REASONS = [
  '不在', '住所不明', 'お届け先アクセス不可', '時間指定変更',
  '配達日変更', '再配達依頼', 'その他'
];

// DNR理由リスト
var DEMO_DNR_REASONS = [
  '配達遅延', '荷物破損', '誤配達', '紛失', '未配達'
];

var demoDashboardLoaded = false;

// 起動時：ドライバー・品質データのみ（ダッシュボードはクリックまで表示しない）
function initDemoEnvironment() {
  _populateDemoDrivers();
  _setupDemoUploadZones();
  _showDemoBanner();
  setTimeout(function() {
    if (typeof renderDriverTable === 'function') {
      try { renderDriverTable(); } catch(e) {}
    }
    if (typeof renderFtdsTable === 'function') {
      try { renderFtdsTable(); } catch(e) {}
    }
    if (typeof renderDnrResults === 'function') {
      try { renderDnrResults(); } catch(e) {}
    }
    if (typeof updateQualitySummary === 'function') {
      try { updateQualitySummary(); } catch(e) {}
    }
    if (typeof renderTeamQualityDashboard === 'function') {
      try { renderTeamQualityDashboard(); } catch(e) {}
    }
    if (typeof renderTenkoTable === 'function') {
      try { renderTenkoTable(); } catch(e) {}
    }
    _addTenkoShowcase();
  }, 200);
}

// アップロード枠クリック → サンプルデータ読込 → ダッシュボード表示
function startDemoFromUpload(source) {
  if (!demoDashboardLoaded) {
    loadDemoDashboardData();
    demoDashboardLoaded = true;
  }
  var cycleStatus = document.getElementById('cycle-status');
  var assignStatus = document.getElementById('assign-status');
  if (cycleStatus) {
    cycleStatus.textContent = '✓ デモ：住所データ読込済み';
    cycleStatus.className = 'text-xs text-emerald-600 mt-1 font-medium';
  }
  if (assignStatus) {
    assignStatus.textContent = '✓ デモ：' + (typeof assignmentData !== 'undefined' ? assignmentData.length : 0) + 'ルート読込済み';
    assignStatus.className = 'text-xs text-emerald-600 mt-1 font-medium';
  }
  if (typeof renderDashboard === 'function') {
    renderDashboard();
  }
  var uploadSec = document.getElementById('upload-section');
  if (uploadSec) uploadSec.classList.add('hidden');
}

function _setupDemoUploadZones() {
  var cycleZone = document.getElementById('upload-zone-cycle');
  var assignZone = document.getElementById('upload-zone-assign');
  var cycleInput = document.getElementById('cycle-file-input');
  var assignInput = document.getElementById('file-input');

  if (cycleZone) {
    cycleZone.onclick = function(e) {
      if (e && e.preventDefault) e.preventDefault();
      startDemoFromUpload('cycle');
    };
    var cycleHint = cycleZone.querySelector('.demo-upload-hint');
    if (!cycleHint) {
      cycleHint = document.createElement('p');
      cycleHint.className = 'demo-upload-hint text-sm font-bold text-blue-600 mt-3';
      cycleHint.textContent = '👆 クリックするとデモがはじまります';
      cycleZone.appendChild(cycleHint);
    }
    var cycleSub = cycleZone.querySelector('.demo-upload-sub');
    if (!cycleSub) {
      cycleSub = document.createElement('p');
      cycleSub.className = 'demo-upload-sub text-xs text-ink-lighter mt-1';
      cycleSub.textContent = 'サンプル住所データ → ダッシュボード表示';
      cycleZone.appendChild(cycleSub);
    }
  }
  if (assignZone) {
    assignZone.onclick = function(e) {
      if (e && e.preventDefault) e.preventDefault();
      startDemoFromUpload('assign');
    };
    var assignHint = assignZone.querySelector('.demo-upload-hint');
    if (!assignHint) {
      assignHint = document.createElement('p');
      assignHint.className = 'demo-upload-hint text-sm font-bold text-blue-600 mt-3';
      assignHint.textContent = '👆 クリックするとデモがはじまります';
      assignZone.appendChild(assignHint);
    }
    var assignSub = assignZone.querySelector('.demo-upload-sub');
    if (!assignSub) {
      assignSub = document.createElement('p');
      assignSub.className = 'demo-upload-sub text-xs text-ink-lighter mt-1';
      assignSub.textContent = 'サンプルアサインデータ → ルート表が表示されます';
      assignZone.appendChild(assignSub);
    }
  }
  if (cycleInput) cycleInput.onchange = function(ev) { if (ev) ev.preventDefault(); startDemoFromUpload('cycle'); };
  if (assignInput) assignInput.onchange = function(ev) { if (ev) ev.preventDefault(); startDemoFromUpload('assign'); };
}

function loadDemoDashboardData() {
  _populateDemoDrivers();

  var routeCodes = ['C001','C002','C003','C004','C005','C006','C007','C008','C009','C010','C011','C012','C013','C014','C015'];
  var areas = ['福岡市東区','福岡市博多区','福岡市中央区','福岡市南区','福岡市西区','福岡市城南区','福岡市早良区','福岡市東区','福岡市博多区','福岡市中央区','福岡市南区','福岡市西区','福岡市城南区','福岡市早良区','福岡市東区'];
  var departures = ['08:15','08:18','08:21','08:24','08:27','08:30','08:33','08:36','08:39','08:42','08:45','08:48','08:51','08:54','08:57'];
  var ends = ['17:30','17:45','18:00','18:15','17:20','18:30','17:55','18:10','19:05','17:40','18:20','17:35','18:45','17:50','19:15'];
  var statuses = ['ok','ok','ok','warning','ok','ok','warning','ok','risk','ok','ok','warning','ok','ok','warning'];
  var baseCoords = [
    { lat: 33.650, lng: 130.430 }, { lat: 33.590, lng: 130.420 }, { lat: 33.592, lng: 130.398 },
    { lat: 33.560, lng: 130.415 }, { lat: 33.585, lng: 130.335 }, { lat: 33.565, lng: 130.370 },
    { lat: 33.580, lng: 130.360 }, { lat: 33.635, lng: 130.435 }, { lat: 33.605, lng: 130.428 },
    { lat: 33.583, lng: 130.402 }, { lat: 33.570, lng: 130.410 }, { lat: 33.575, lng: 130.380 }
  ];

  if (typeof assignmentData !== 'undefined') {
    assignmentData.length = 0;
    for (var r = 0; r < 15; r++) {
      var rDriver = DEMO_DRIVERS[r];
      var pkg = 120 + (r * 7) % 80;
      assignmentData.push({
        routeCode: routeCodes[r],
        driverName: rDriver.name,
        area: areas[r],
        serviceType: 'Standard',
        totalDeliveries: pkg,
        allDestinations: Math.max(1, Math.floor(pkg * 0.85)),
        capability: rDriver.pph,
        departure: departures[r],
        predictedEnd: ends[r],
        status: statuses[r]
      });
    }
  }

  if (typeof cycleData !== 'undefined') {
    for (var rc = 0; rc < routeCodes.length; rc++) {
      var code = routeCodes[rc];
      var addrs = [];
      var pinCount = 8 + (rc % 5);
      for (var pi = 0; pi < pinCount; pi++) {
        var bc = baseCoords[(rc + pi) % baseCoords.length];
        var addrStr = '福岡県' + areas[rc] + 'サンプル' + (pi + 1) + '丁目' + (pi + 2) + '-' + (pi + 3);
        addrs.push(addrStr);
        if (typeof inMemoryAddrMaster !== 'undefined') {
          inMemoryAddrMaster[addrStr] = {
            lat: bc.lat + (pi * 0.002) - 0.004,
            lng: bc.lng + (pi * 0.001) - 0.002
          };
        }
      }
      cycleData[code] = addrs;
    }
  }

  if (typeof routeAreas !== 'undefined') {
    for (var ra = 0; ra < routeCodes.length; ra++) {
      routeAreas[routeCodes[ra]] = areas[ra];
    }
  }
}

function ensureDemoCycleForRoute(routeCode) {
  if (!demoDashboardLoaded) loadDemoDashboardData();
  if (typeof cycleData !== 'undefined' && (!cycleData[routeCode] || cycleData[routeCode].length === 0)) {
    loadDemoDashboardData();
  }
}

function _populateDemoDrivers() {
  if (typeof driverDB === 'undefined') return;
  // 1. driverDB を架空データに置換
  for (var _k in driverDB) { delete driverDB[_k]; }
  var demoDepartments = {};
  for (var i = 0; i < DEMO_DRIVERS.length; i++) {
    var d = DEMO_DRIVERS[i];
    driverDB[d.name] = {
      workDays: d.wd, totalHours: Math.round(d.wd * 6.5 * 10) / 10,
      totalPackages: d.tp, packagesPerHour: d.pph,
      totalPackagesAll: d.tp + Math.floor(d.tp * 0.12),
      distanceKm: d.dist, incidents: d.inc,
      misdeliveryRate: d.mis, deliveryRate: d.del,
      lastUpdated: 'W22-W31'
    };
    demoDepartments[d.name] = d.dept;
  }

  // 2. driverDepartments を架空データに
  try {
    localStorage.setItem('driverDepartments', JSON.stringify(demoDepartments));
  } catch(e) {}

  // 3. transportIDs を設定
  var tids = {};
  for (var j = 0; j < DEMO_DRIVERS.length; j++) {
    tids[DEMO_DRIVERS[j].name] = DEMO_DRIVERS[j].tid;
  }
  try {
    localStorage.setItem('transportIDs', JSON.stringify(tids));
  } catch(e) {}

  // 4. マスタデータ seed
  var masterEntries = {};
  for (var m = 0; m < DEMO_DRIVERS.length; m++) {
    var dd = DEMO_DRIVERS[m];
    masterEntries[dd.name] = {
      name: dd.name,
      tid: dd.tid,
      lineUserId: '',
      group: dd.dept,
      registeredAt: '2026-06-01'
    };
  }
  try {
    localStorage.setItem('driverMaster', JSON.stringify(masterEntries));
  } catch(e) {}

  // 5. FTDS seed data (60件)
  var ftdsData = [];
  for (var f = 0; f < 60; f++) {
    var driver = DEMO_DRIVERS[f % DEMO_DRIVERS.length];
    ftdsData.push({
      driverName: driver.name,
      transportId: driver.tid,
      trackingId: 'TBA' + String(300000000 + f),
      failure_reason: DEMO_FTDS_REASONS[f % DEMO_FTDS_REASONS.length],
      date: '2026-07-' + String(10 + (f % 18)).padStart(2, '0'),
      stationCode: 'DNG3'
    });
  }

  // 6. CC seed data (40件)
  var ccData = [];
  for (var c = 0; c < 40; c++) {
    var cDriver = DEMO_DRIVERS[c % DEMO_DRIVERS.length];
    ccData.push({
      driverName: cDriver.name,
      transportId: cDriver.tid,
      reason: DEMO_CC_REASONS[c % DEMO_CC_REASONS.length],
      callRequired: (c % 3 === 0) ? 1 : 0,
      callMade: (c % 5 === 0) ? 1 : 0,
      date: '2026-07-' + String(10 + (c % 18)).padStart(2, '0')
    });
  }

  // 7. DNR seed data (15件)
  var dnrData = [];
  var dnrDriverIdxs = [0, 2, 4, 8, 13, 15, 19, 22, 25, 29, 33, 35, 37, 1, 6];
  for (var dn = 0; dn < 15; dn++) {
    var dnDriver = DEMO_DRIVERS[dnrDriverIdxs[dn]];
    dnrData.push({
      driverName: dnDriver.name,
      transportId: dnDriver.tid,
      trackingId: 'TBA' + String(400000000 + dn),
      reason: DEMO_DNR_REASONS[dn % DEMO_DNR_REASONS.length],
      cost: [1200, 2500, 800, 3000, 1500, 0, 4200, 900, 1800, 2000, 0, 3500, 1100, 2800, 600][dn],
      date: '2026-07-' + String(12 + (dn % 15)).padStart(2, '0')
    });
  }

  // 8. 点呼スケジュール (12行) → tenkoSchedule
  if (typeof tenkoSchedule !== 'undefined') {
    tenkoSchedule.length = 0;
    for (var tk = 0; tk < 12; tk++) {
      var arrH = 7 + Math.floor(tk / 4);
      var arrM = 15 * (tk % 4);
      var arrTime = String(arrH).padStart(2, '0') + ':' + String(arrM).padStart(2, '0');
      tenkoSchedule.push({
        name: DEMO_DRIVERS[tk].name,
        arrivalTime: arrTime,
        arrivalMinutes: arrH * 60 + arrM,
        licenseAuth: tk < 7,
        mentorAuth: tk < 5,
        shiftCode: 'AM',
        temporary: false
      });
    }
  }

  // 9. 時間指定荷物 (30件) — twExtractedData 等は将来拡張用に保持
  var twAreas = ['東区','博多区','中央区','南区','西区','城南区','早良区'];
  if (typeof twExtractedData !== 'undefined') {
    twExtractedData.length = 0;
    var twSlots = ['08-12','12-14','14-16','16-18','18-20','19-21'];
    for (var tw = 0; tw < 30; tw++) {
      var twDriver = DEMO_DRIVERS[tw % 15];
      twExtractedData.push({
        trackingId: 'TBA' + String(500000000 + tw),
        driverName: twDriver.name,
        routeCode: 'C' + String((tw % 15) + 1).padStart(3, '0'),
        address: '福岡市' + twAreas[tw % twAreas.length] + 'サンプル' + (tw + 1) + '丁目',
        timeWindow: twSlots[tw % twSlots.length],
        status: tw < 20 ? 'done' : (tw < 25 ? 'active' : 'pending')
      });
    }
  }

  // グローバル変数にセット（ダッシュボード assignment は loadDemoDashboardData で別途）
  if (typeof ftdsResultData !== 'undefined') {
    ftdsResultData.length = 0;
    for (var fi = 0; fi < ftdsData.length; fi++) ftdsResultData.push(ftdsData[fi]);
  }

  if (typeof ccResultData !== 'undefined') {
    ccResultData.length = 0;
    for (var ci = 0; ci < ccData.length; ci++) ccResultData.push(ccData[ci]);
  }

  if (typeof dnrResultData !== 'undefined') {
    dnrResultData.length = 0;
    for (var di = 0; di < dnrData.length; di++) dnrResultData.push(dnrData[di]);
  }

  // teamQualitySnapshot を構築
  var snapDrivers = {};
  for (var si = 0; si < DEMO_DRIVERS.length; si++) {
    var sd = DEMO_DRIVERS[si];
    var dFtds = 0; var dFtdsReasons = {};
    for (var sf = 0; sf < ftdsData.length; sf++) {
      if (ftdsData[sf].driverName === sd.name) {
        dFtds++;
        var reason = ftdsData[sf].failure_reason;
        dFtdsReasons[reason] = (dFtdsReasons[reason] || 0) + 1;
      }
    }
    var dCc = 0; var dCcCalls = 0;
    for (var sc = 0; sc < ccData.length; sc++) {
      if (ccData[sc].driverName === sd.name) {
        dCc++;
        dCcCalls += ccData[sc].callMade || 0;
      }
    }
    var dDnr = 0; var dDnrCost = 0;
    for (var sdn = 0; sdn < dnrData.length; sdn++) {
      if (dnrData[sdn].driverName === sd.name) {
        dDnr++;
        dDnrCost += dnrData[sdn].cost || 0;
      }
    }
    snapDrivers[sd.name] = {
      dept: sd.dept,
      packagesPerHour: sd.pph,
      misdeliveryRate: sd.mis,
      deliveryRate: sd.del,
      workDays: sd.wd,
      totalPackages: sd.tp,
      dnrCount: dDnr,
      dnrCost: dDnrCost,
      ftdsCount: dFtds,
      ftdsTopReasons: dFtdsReasons,
      ccCount: dCc,
      ccCalls: dCcCalls
    };
  }

  teamQualitySnapshot = {
    periodLabel: 'W27-W31',
    abilityPeriod: 'W22-W31',
    updatedAt: new Date().toISOString(),
    sources: { dnr: true, ftds: true, cc: true, ability: true },
    drivers: snapDrivers
  };

  // Store
  try {
    localStorage.setItem('teamQualitySnapshot', JSON.stringify(teamQualitySnapshot));
  } catch(e) {}
}

// 後方互換
function seedDemoData() { initDemoEnvironment(); }

// 点呼テーブル seed（旧関数・未使用）
function _seedTenkoTable(data) {
  var tbody = document.getElementById('tenko-tbody');
  if (!tbody) return;
  var html = '';
  for (var i = 0; i < data.length; i++) {
    var t = data[i];
    var statusColor = t.status.indexOf('完了') >= 0 ? 'bg-green-50' : (t.status.indexOf('未完了') >= 0 ? 'bg-yellow-50' : 'bg-red-50');
    html += '<tr class="' + statusColor + '">'
      + '<td class="px-3 py-2 text-sm">' + (i + 1) + '</td>'
      + '<td class="px-3 py-2 text-sm font-medium">' + t.name + '</td>'
      + '<td class="px-3 py-2 text-sm">' + t.tid + '</td>'
      + '<td class="px-3 py-2 text-sm">' + t.arrivalTime + '</td>'
      + '<td class="px-3 py-2 text-sm text-center">' + (t.qrStatus === '済' ? '✅' : '❌') + '</td>'
      + '<td class="px-3 py-2 text-sm text-center">' + (t.mentorStatus === '済' ? '✅' : '❌') + '</td>'
      + '<td class="px-3 py-2 text-sm font-bold">' + t.status + '</td>'
      + '</tr>';
  }
  tbody.innerHTML = html;

  // サマリーカード更新
  var completed = data.filter(function(x) { return x.status.indexOf('完了') >= 0 && x.status.indexOf('未完了') < 0; }).length;
  var pending = data.filter(function(x) { return x.status.indexOf('未完了') >= 0; }).length;
  var notStarted = data.filter(function(x) { return x.status.indexOf('未着手') >= 0; }).length;
  var el;
  el = document.getElementById('tenko-total'); if (el) el.textContent = data.length + '名';
  el = document.getElementById('tenko-completed'); if (el) el.textContent = completed + '名';
  el = document.getElementById('tenko-pending'); if (el) el.textContent = pending + '名';
  el = document.getElementById('tenko-not-started'); if (el) el.textContent = notStarted + '名';
}

// デモバナー
function _showDemoBanner() {
  if (document.getElementById('demo-banner')) return;
  var banner = document.createElement('div');
  banner.id = 'demo-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#F59E0B;color:#1a1a1a;text-align:center;padding:8px 16px;font-weight:bold;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.15);';
  banner.innerHTML = '⚠ デモモード — 架空データです。送信・保存は行われません。';
  document.body.insertBefore(banner, document.body.firstChild);
  // body padding-top 調整
  document.body.style.paddingTop = '40px';
}

// 点呼ショーケース（画像ギャラリー + LINE通知プレビュー）
function _addTenkoShowcase() {
  var panel = document.getElementById('panel-tenko');
  if (!panel || document.getElementById('demo-tenko-showcase')) return;

  var showcase = document.createElement('div');
  showcase.id = 'demo-tenko-showcase';
  showcase.className = 'mt-8 space-y-6';
  showcase.innerHTML = ''
    // セクションタイトル
    + '<div class="border-t-2 border-blue-200 pt-6">'
    + '<h3 class="text-lg font-bold text-ink mb-4">📸 点呼管理の仕組み</h3>'
    + '</div>'

    // 画像ギャラリー（2枚横並び）
    + '<div class="grid grid-cols-1 md:grid-cols-2 gap-6">'
    // QR画像
    + '<div class="bg-white rounded-xl shadow p-4 text-center">'
    + '<img src="demo-tenko-qr.png" alt="点呼QR認証" class="mx-auto mb-3" style="max-height:240px;border-radius:12px">'
    + '<p class="text-sm font-bold text-ink">点呼QR認証</p>'
    + '<p class="text-xs text-ink-lighter mt-1">ドライバーがQRコードをスキャンして出勤登録</p>'
    + '</div>'
    // Mentor画像
    + '<div class="bg-white rounded-xl shadow p-4 text-center">'
    + '<img src="demo-tenko-mentor.png" alt="メンターアプリ" class="mx-auto mb-3" style="max-height:240px;border-radius:12px">'
    + '<p class="text-sm font-bold text-ink">メンターアプリ（FICO安全運転スコア）</p>'
    + '<p class="text-xs text-ink-lighter mt-1">Solera/eDriving提供。起動確認で安全運転を担保</p>'
    + '</div>'
    + '</div>'

    // LINE通知プレビュー
    + '<div class="bg-white rounded-xl shadow p-6">'
    + '<h4 class="text-sm font-bold text-ink mb-4">💬 LINE通知プレビュー（自動送信イメージ）</h4>'
    + '<div style="max-width:380px;margin:0 auto;background:#7494C0;border-radius:16px;padding:16px;font-family:sans-serif">'
    // ヘッダー
    + '<div style="text-align:center;color:white;font-size:12px;margin-bottom:12px">点呼管理 BOT</div>'
    // バブル1（ボットメッセージ）
    + '<div style="display:flex;align-items:flex-start;margin-bottom:10px">'
    + '<div style="width:36px;height:36px;border-radius:50%;background:#06C755;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;flex-shrink:0;margin-right:8px">B</div>'
    + '<div style="background:white;border-radius:0 16px 16px 16px;padding:12px 14px;max-width:280px;font-size:13px;line-height:1.6;box-shadow:0 1px 2px rgba(0,0,0,0.1)">'
    + '<div style="font-weight:bold;color:#D94032;margin-bottom:6px">🚨 点呼未完了通知</div>'
    + '<div style="color:#333">着車時間 09:00 を過ぎましたが、以下のドライバーの点呼が完了していません。</div>'
    + '<div style="margin-top:8px;color:#333">・山田 太郎 🪪❌ 👔❌<br>・佐藤 花子 🪪❌ 👔❌</div>'
    + '<div style="margin-top:8px;color:#666;font-size:11px">未完了: 2名</div>'
    + '</div>'
    + '</div>'
    // バブル2（完了通知）
    + '<div style="display:flex;align-items:flex-start;margin-bottom:10px">'
    + '<div style="width:36px;height:36px;border-radius:50%;background:#06C755;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;flex-shrink:0;margin-right:8px">B</div>'
    + '<div style="background:white;border-radius:0 16px 16px 16px;padding:12px 14px;max-width:280px;font-size:13px;line-height:1.6;box-shadow:0 1px 2px rgba(0,0,0,0.1)">'
    + '<div style="font-weight:bold;color:#06C755;margin-bottom:6px">✅ 点呼完了通知</div>'
    + '<div style="color:#333">09:05 山田 太郎 の点呼が完了しました。</div>'
    + '<div style="margin-top:6px;color:#333">🪪 QR認証 ✅<br>👔 メンター確認 ✅</div>'
    + '</div>'
    + '</div>'
    // タイムスタンプ
    + '<div style="text-align:center;color:rgba(255,255,255,0.6);font-size:10px;margin-top:4px">09:05</div>'
    + '</div>'
    + '<p class="text-xs text-ink-lighter mt-3 text-center">※ デモ表示です。実際のLINE送信は行われません。</p>'
    + '</div>';

  panel.appendChild(showcase);
}

// デモ用 getDriverIcon（イニシャル + カラフル背景）
var DEMO_ICON_COLORS = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#EC4899','#14B8A6','#F97316'];

function getDemoDriverIcon(name, sizeClass) {
  sizeClass = sizeClass || 'w-8 h-8';
  var initial = (name || '?').charAt(0);
  var colorIdx = 0;
  for (var ci = 0; ci < name.length; ci++) { colorIdx += name.charCodeAt(ci); }
  var bg = DEMO_ICON_COLORS[colorIdx % DEMO_ICON_COLORS.length];
  return '<div class="' + sizeClass + ' rounded-full flex-shrink-0 flex items-center justify-center" style="background:' + bg + ';border:2px solid #06C755;color:white;font-weight:bold;font-size:14px">'
    + initial
    + '<div style="position:absolute;bottom:-1px;right:-1px;width:10px;height:10px;background:#06C755;border-radius:50%;border:1.5px solid white"></div>'
    + '</div>';
}
