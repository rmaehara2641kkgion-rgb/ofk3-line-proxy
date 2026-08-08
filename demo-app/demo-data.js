// ===== DEMO DATA - 架空データ =====
// 本番の実名データは一切含まない。すべて架空。
var DEMO_MODE = true;

var DEMO_DRIVERS = [
  {name:'山田 太郎',driverName:'Yamada Taro',id:'D001',phone:'090-1000-0001',dept:'GDSダイレクト',tid:'A000000001',pph:28.5,mis:0.05,del:97.2,wd:45,tp:6800,dist:2100,inc:1},
  {name:'佐藤 花子',driverName:'Sato Hanako',id:'D002',phone:'090-1000-0002',dept:'GDSダイレクト',tid:'A000000002',pph:26.1,mis:0.08,del:95.8,wd:38,tp:5200,dist:1800,inc:2},
  {name:'鈴木 一郎',driverName:'Suzuki Ichiro',id:'D003',phone:'090-1000-0003',dept:'GDSダイレクト',tid:'A000000003',pph:24.3,mis:0.12,del:93.5,wd:42,tp:5900,dist:1950,inc:3},
  {name:'高橋 美咲',driverName:'Takahashi Misaki',id:'D004',phone:'090-1000-0004',dept:'GDSダイレクト',tid:'A000000004',pph:22.7,mis:0.03,del:98.1,wd:50,tp:7100,dist:2300,inc:0},
  {name:'田中 健太',driverName:'Tanaka Kenta',id:'D005',phone:'090-1000-0005',dept:'GDSダイレクト',tid:'A000000005',pph:21.0,mis:0.15,del:91.2,wd:35,tp:4500,dist:1600,inc:4},
  {name:'渡辺 翔太',driverName:'Watanabe Shota',id:'D006',phone:'090-1000-0006',dept:'GDS管理',tid:'A000000006',pph:25.8,mis:0.04,del:96.9,wd:40,tp:6200,dist:2000,inc:1},
  {name:'伊藤 さくら',driverName:'Ito Sakura',id:'D007',phone:'090-1000-0007',dept:'GDS管理',tid:'A000000007',pph:23.4,mis:0.09,del:94.3,wd:33,tp:4800,dist:1700,inc:2},
  {name:'中村 大輝',driverName:'Nakamura Daiki',id:'D008',phone:'090-1000-0008',dept:'GDS管理',tid:'A000000008',pph:20.5,mis:0.11,del:92.7,wd:28,tp:3900,dist:1400,inc:3},
  {name:'小林 裕子',driverName:'Kobayashi Yuko',id:'D009',phone:'090-1000-0009',dept:'GDS管理',tid:'A000000009',pph:19.2,mis:0.06,del:95.5,wd:44,tp:5600,dist:1850,inc:1},
  {name:'加藤 拓海',driverName:'Kato Takumi',id:'D010',phone:'090-1000-0010',dept:'GDSパート',tid:'A000000010',pph:18.5,mis:0.02,del:98.8,wd:20,tp:2800,dist:900,inc:0},
  {name:'松本 彩花',driverName:'Matsumoto Ayaka',id:'D011',phone:'090-1000-0011',dept:'GDSパート',tid:'A000000011',pph:17.1,mis:0.07,del:96.1,wd:22,tp:3100,dist:1000,inc:1},
  {name:'吉田 蓮',driverName:'Yoshida Ren',id:'D012',phone:'090-1000-0012',dept:'GDSパート',tid:'A000000012',pph:16.3,mis:0.14,del:90.5,wd:18,tp:2400,dist:800,inc:2},
  {name:'山口 真由',driverName:'Yamaguchi Mayu',id:'D013',phone:'090-1000-0013',dept:'JHS',tid:'A000000013',pph:27.2,mis:0.03,del:97.8,wd:48,tp:7500,dist:2400,inc:1},
  {name:'石田 陽介',driverName:'Ishida Yosuke',id:'D014',phone:'090-1000-0014',dept:'JHS',tid:'A000000014',pph:25.0,mis:0.10,del:93.9,wd:41,tp:6000,dist:1900,inc:3},
  {name:'森 優衣',driverName:'Mori Yui',id:'D015',phone:'090-1000-0015',dept:'JHS',tid:'A000000015',pph:23.8,mis:0.05,del:96.4,wd:36,tp:5300,dist:1750,inc:1},
  {name:'池田 悠真',driverName:'Ikeda Yuma',id:'D016',phone:'090-1000-0016',dept:'JHS',tid:'A000000016',pph:22.1,mis:0.08,del:95.0,wd:30,tp:4200,dist:1500,inc:2},
  {name:'前田 結衣',driverName:'Maeda Yui',id:'D017',phone:'090-1000-0017',dept:'JHS',tid:'A000000017',pph:20.6,mis:0.02,del:98.5,wd:25,tp:3500,dist:1200,inc:0},
  {name:'藤田 海斗',driverName:'Fujita Kaito',id:'D018',phone:'090-1000-0018',dept:'AE物流',tid:'A000000018',pph:24.5,mis:0.06,del:96.2,wd:39,tp:5800,dist:1850,inc:2},
  {name:'岡田 千尋',driverName:'Okada Chihiro',id:'D019',phone:'090-1000-0019',dept:'AE物流',tid:'A000000019',pph:22.8,mis:0.09,del:94.1,wd:34,tp:4700,dist:1600,inc:1},
  {name:'後藤 涼太',driverName:'Goto Ryota',id:'D020',phone:'090-1000-0020',dept:'AE物流',tid:'A000000020',pph:21.3,mis:0.13,del:92.0,wd:29,tp:3800,dist:1350,inc:3},
  {name:'長谷川 美月',driverName:'Hasegawa Mizuki',id:'D021',phone:'090-1000-0021',dept:'AE物流',tid:'A000000021',pph:19.7,mis:0.04,del:97.3,wd:43,tp:6100,dist:2050,inc:0},
  {name:'村上 颯太',driverName:'Murakami Sota',id:'D022',phone:'090-1000-0022',dept:'ファンタジスタ',tid:'A000000022',pph:26.4,mis:0.07,del:95.6,wd:46,tp:7200,dist:2250,inc:2},
  {name:'近藤 心愛',driverName:'Kondo Kokoa',id:'D023',phone:'090-1000-0023',dept:'ファンタジスタ',tid:'A000000023',pph:24.0,mis:0.11,del:93.2,wd:37,tp:5400,dist:1800,inc:3},
  {name:'坂本 大和',driverName:'Sakamoto Yamato',id:'D024',phone:'090-1000-0024',dept:'ファンタジスタ',tid:'A000000024',pph:21.8,mis:0.03,del:97.9,wd:32,tp:4400,dist:1450,inc:0},
  {name:'遠藤 桃花',driverName:'Endo Momoka',id:'D025',phone:'090-1000-0025',dept:'ファンタジスタ',tid:'A000000025',pph:20.2,mis:0.08,del:95.3,wd:27,tp:3600,dist:1250,inc:1},
  {name:'青木 大翔',driverName:'Aoki Hiroto',id:'D026',phone:'090-1000-0026',dept:'LINGｓ',tid:'A000000026',pph:23.6,mis:0.05,del:96.7,wd:44,tp:6500,dist:2100,inc:1},
  {name:'藤井 琴音',driverName:'Fujii Kotone',id:'D027',phone:'090-1000-0027',dept:'LINGｓ',tid:'A000000027',pph:21.9,mis:0.10,del:93.8,wd:38,tp:5100,dist:1700,inc:2},
  {name:'三浦 陸斗',driverName:'Miura Rikuto',id:'D028',phone:'090-1000-0028',dept:'LINGｓ',tid:'A000000028',pph:20.0,mis:0.06,del:95.9,wd:31,tp:4100,dist:1380,inc:1},
  {name:'野田 美緒',driverName:'Noda Mio',id:'D029',phone:'090-1000-0029',dept:'LINGｓ',tid:'A000000029',pph:18.8,mis:0.12,del:91.8,wd:26,tp:3400,dist:1150,inc:3},
  {name:'松田 隼人',driverName:'Matsuda Hayato',id:'D030',phone:'090-1000-0030',dept:'OFK6',tid:'A000000030',pph:25.3,mis:0.04,del:97.0,wd:47,tp:7000,dist:2200,inc:1},
  {name:'原田 七海',driverName:'Harada Nanami',id:'D031',phone:'090-1000-0031',dept:'OFK6',tid:'A000000031',pph:23.1,mis:0.07,del:95.4,wd:40,tp:5700,dist:1900,inc:2},
  {name:'小川 蒼空',driverName:'Ogawa Sora',id:'D032',phone:'090-1000-0032',dept:'OFK6',tid:'A000000032',pph:21.5,mis:0.09,del:94.5,wd:35,tp:4900,dist:1650,inc:1},
  {name:'岩崎 咲良',driverName:'Iwasaki Sakura',id:'D033',phone:'090-1000-0033',dept:'OFK6',tid:'A000000033',pph:19.4,mis:0.02,del:98.3,wd:23,tp:3200,dist:1050,inc:0},
  {name:'中島 春樹',driverName:'Nakajima Haruki',id:'D034',phone:'090-1000-0034',dept:'GDSダイレクト',tid:'A000000034',pph:20.1,mis:0.16,del:89.5,wd:31,tp:4300,dist:1500,inc:5},
  {name:'木村 葵',driverName:'Kimura Aoi',id:'D035',phone:'090-1000-0035',dept:'GDS管理',tid:'A000000035',pph:22.6,mis:0.05,del:96.3,wd:36,tp:5100,dist:1700,inc:1},
  {name:'宮崎 大地',driverName:'Miyazaki Daichi',id:'D036',phone:'090-1000-0036',dept:'JHS',tid:'A000000036',pph:18.9,mis:0.18,del:88.7,wd:24,tp:3300,dist:1100,inc:6},
  {name:'清水 柚希',driverName:'Shimizu Yuzuki',id:'D037',phone:'090-1000-0037',dept:'AE物流',tid:'A000000037',pph:26.7,mis:0.01,del:99.1,wd:52,tp:8000,dist:2500,inc:0},
  {name:'福田 空',driverName:'Fukuda Sora',id:'D038',phone:'090-1000-0038',dept:'ファンタジスタ',tid:'A000000038',pph:15.2,mis:0.20,del:87.3,wd:19,tp:2200,dist:750,inc:4},
  {name:'西村 花音',driverName:'Nishimura Kanon',id:'D039',phone:'090-1000-0039',dept:'LINGｓ',tid:'A000000039',pph:24.8,mis:0.06,del:96.0,wd:42,tp:6300,dist:2050,inc:1},
  {name:'太田 湊',driverName:'Ota Minato',id:'D040',phone:'090-1000-0040',dept:'OFK6',tid:'A000000040',pph:17.5,mis:0.11,del:93.0,wd:21,tp:2900,dist:950,inc:2}
];

var DEMO_FTDS_REASONS = ['不在','配達未試行','荷物紛失','住所不明','お届け先アクセス不可','配達日変更','営業所保管','受取拒否','持戻り（その他）','天候不良'];
var DEMO_CC_REASONS = ['不在','住所不明','お届け先アクセス不可','時間指定変更','配達日変更','再配達依頼','その他'];
var DEMO_DNR_REASONS = ['Carrier - Loss/Stolen','Damaged - Carrier','Delivered Not Received','Missing from Bag','Undeliverable'];
var DEMO_AREAS = ['東区','博多区','中央区','南区','西区','城南区','早良区'];
var DEMO_COORDS = [
  {lat:33.650,lng:130.430},{lat:33.590,lng:130.420},{lat:33.592,lng:130.398},
  {lat:33.560,lng:130.415},{lat:33.585,lng:130.335},{lat:33.565,lng:130.370},
  {lat:33.580,lng:130.360},{lat:33.635,lng:130.435},{lat:33.605,lng:130.428},
  {lat:33.583,lng:130.402},{lat:33.570,lng:130.410},{lat:33.575,lng:130.380}
];

var demoDashboardLoaded = false;
var demoFtdsLoaded = false;
var demoCcLoaded = false;
var demoQualityLoaded = false;
var demoLatLoaded = false;
var demoAddrLoaded = false;

// ===== 起動時 =====
function initDemoEnvironment() {
  _populateDemoDrivers();
  _showDemoBanner();
  // マスタは起動時にseed（0名防止）
  if (typeof renderMasterTable === 'function') {
    try { renderMasterTable(); } catch(e) { console.log('Demo: renderMasterTable error', e.message); }
  }
  // 能力DBテーブル
  if (typeof renderDriverTable === 'function') {
    try { renderDriverTable(); } catch(e) { console.log('Demo: renderDriverTable error', e.message); }
  }
  // 点呼
  if (typeof renderTenkoTable === 'function') {
    try { renderTenkoTable(); } catch(e) {}
  }
  // 協力会社（snapshotは_populateDemoDriversで構築済み）
  if (typeof renderTeamQualityDashboard === 'function') {
    try { renderTeamQualityDashboard(); } catch(e) {}
  }
  // 点呼ショーケース
  setTimeout(_addTenkoShowcase, 300);
  // アップロード枠をデモ化
  setTimeout(_setupAllDemoZones, 400);
  // 住所検索デモUI（即時＋遅延の二重保険）
  _setupAddrSearchDemoUI();
  setTimeout(_setupAddrSearchDemoUI, 500);
  setTimeout(_setupAddrSearchDemoUI, 1500);
  setTimeout(_patchDemoLineFeatures, 600);
}

// ===== 住所検索デモUI =====
var DEMO_ADDR_DA = {
  da: 'TBA300000050',
  route: 'C001',
  address: '福岡県福岡市東区香椎1-2-3',
  lat: 33.650,
  lng: 130.430
};
var DEMO_ADDR_FREE = {
  address: '福岡県福岡市西区姪浜駅南1-1-1',
  lat: 33.583,
  lng: 130.326
};

function _setupAddrSearchDemoUI() {
  var dropzone = document.getElementById('addr-search-dropzone');
  if (dropzone) dropzone.style.display = 'none';
  var sampleWrap = document.getElementById('addr-sample-map-wrap');
  if (sampleWrap) sampleWrap.style.display = 'none';
  var ready = document.getElementById('addr-search-ready');
  if (ready) ready.classList.remove('hidden');

  var daZone = document.getElementById('addr-demo-da-zone');
  if (daZone && !daZone._demoBound) {
    daZone._demoBound = true;
    daZone.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      startDemoAddrSearchDa();
    };
  }
  var freeZone = document.getElementById('addr-demo-free-zone');
  if (freeZone && !freeZone._demoBound) {
    freeZone._demoBound = true;
    freeZone.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      startDemoAddrSearchFree();
    };
  }
}

function _renderDemoAddrMap(mapId, containerId, lat, lng, address, popupExtra) {
  var container = document.getElementById(containerId);
  if (container) container.classList.remove('hidden');
  setTimeout(function() {
    if (typeof L === 'undefined') {
      _demoToast('地図ライブラリの読込を待っています…');
      return;
    }
    var mapKey = mapId + '_demo_instance';
    if (window[mapKey]) { try { window[mapKey].remove(); } catch(e) {} window[mapKey] = null; }
    if (mapId === 'addr-search-map' && typeof addrSearchMap !== 'undefined' && addrSearchMap) {
      try { addrSearchMap.remove(); } catch(e) {}
      addrSearchMap = null;
    }
    var mapEl = document.getElementById(mapId);
    if (!mapEl) return;
    mapEl.innerHTML = '';
    var map = L.map(mapId, { scrollWheelZoom: true }).setView([lat, lng], 16);
    window[mapKey] = map;
    if (mapId === 'addr-search-map') addrSearchMap = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19
    }).addTo(map);
    L.marker([lat, lng]).addTo(map)
      .bindPopup('<b>' + address + '</b>' + (popupExtra || ''))
      .openPopup();
    setTimeout(function() { map.invalidateSize(); }, 100);
    setTimeout(function() { map.invalidateSize(); }, 400);
    setTimeout(function() { map.invalidateSize(); }, 900);
  }, 200);
}

function _renderDemoTwMap(items) {
  if (typeof L === 'undefined' || !items || !items.length) return;
  var container = document.getElementById('tw-map-container');
  if (container) container.classList.remove('hidden');
  setTimeout(function() {
    var mapKey = 'tw_map_demo_instance';
    if (window[mapKey]) { try { window[mapKey].remove(); } catch(e) {} window[mapKey] = null; }
    var mapEl = document.getElementById('tw-map');
    if (!mapEl) return;
    mapEl.innerHTML = '';
    var map = L.map('tw-map', { scrollWheelZoom: true }).setView([33.59, 130.40], 12);
    window[mapKey] = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19
    }).addTo(map);
    var bounds = [];
    var colorList = ['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316'];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var geo = (typeof inMemoryAddrMaster !== 'undefined') ? inMemoryAddrMaster[item.address] : null;
      if (!geo || !geo.lat) continue;
      var color = colorList[i % colorList.length];
      var icon = L.divIcon({
        className: 'demo-tw-pin',
        html: '<div style="background:' + color + ';color:#fff;width:24px;height:24px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;box-shadow:0 1px 4px rgba(0,0,0,0.3);">' + (item.seqNo || (i+1)) + '</div>',
        iconSize: [24, 24], iconAnchor: [12, 12]
      });
      L.marker([geo.lat, geo.lng], { icon: icon }).addTo(map)
        .bindPopup('<b>' + item.routeCode + ' #' + item.stop + '</b><br>' + item.timeWindow + '<br>' + item.address);
      bounds.push([geo.lat, geo.lng]);
    }
    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [40, 40] });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 14);
    }
    setTimeout(function() { map.invalidateSize(); }, 150);
    setTimeout(function() { map.invalidateSize(); }, 500);
    setTimeout(function() { map.invalidateSize(); }, 1000);
    if (container && container.scrollIntoView) {
      setTimeout(function() { container.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 300);
    }
  }, 250);
}

function startDemoAddrSearchDa() {
  var zone = document.getElementById('addr-demo-da-zone');
  if (zone) zone.style.display = 'none';
  var d = DEMO_ADDR_DA;
  if (typeof inMemoryAddrMaster !== 'undefined') {
    inMemoryAddrMaster[d.address] = { lat: d.lat, lng: d.lng };
  }
  if (typeof addrSearchCurrentAddress !== 'undefined') addrSearchCurrentAddress = d.address;
  if (typeof addrSearchCurrentRoute !== 'undefined') addrSearchCurrentRoute = d.route;
  if (typeof addrSearchCurrentDA !== 'undefined') addrSearchCurrentDA = d.da;

  var resultEl = document.getElementById('addr-search-result');
  var notFoundEl = document.getElementById('addr-search-not-found');
  if (notFoundEl) notFoundEl.classList.add('hidden');
  if (resultEl) {
    resultEl.classList.remove('hidden');
    var routeEl = document.getElementById('addr-search-route');
    var addrEl = document.getElementById('addr-search-address');
    var daEl = document.getElementById('addr-search-da-label');
    if (routeEl) routeEl.textContent = d.route;
    if (addrEl) addrEl.textContent = d.address;
    if (daEl) daEl.textContent = 'DA: ' + d.da;
  }
  _renderDemoAddrMap('addr-search-map', 'addr-search-map-container', d.lat, d.lng, d.address, '<br>DA: ' + d.da);
  _demoToast('デモ：DA番号検索 — 1件表示');
}
window.startDemoAddrSearchDa = startDemoAddrSearchDa;

function startDemoAddrSearchFree() {
  var zone = document.getElementById('addr-demo-free-zone');
  if (zone) zone.style.display = 'none';
  var d = DEMO_ADDR_FREE;
  if (typeof inMemoryAddrMaster !== 'undefined') {
    inMemoryAddrMaster[d.address] = { lat: d.lat, lng: d.lng };
  }
  if (typeof addrFreeCurrentAddress !== 'undefined') addrFreeCurrentAddress = d.address;
  var statusEl = document.getElementById('addr-free-status');
  if (statusEl) statusEl.textContent = d.address;
  var inputEl = document.getElementById('addr-free-input');
  if (inputEl) inputEl.value = d.address;
  _renderDemoAddrMap('addr-free-map', 'addr-free-map-container', d.lat, d.lng, d.address, '');
  _demoToast('デモ：住所直接検索 — 別の1件を表示');
}
window.startDemoAddrSearchFree = startDemoAddrSearchFree;

// ===== ドライバー・品質データ投入 =====
function _clearDemoMap(obj) {
  if (!obj) return;
  for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k]; }
}

function _populateDemoDrivers() {
  if (typeof driverDB === 'undefined') return;
  _clearDemoMap(driverDB);
  _clearDemoMap(typeof driverDepartments !== 'undefined' ? driverDepartments : null);
  _clearDemoMap(typeof driverJapaneseNames !== 'undefined' ? driverJapaneseNames : null);
  _clearDemoMap(typeof transportIDs !== 'undefined' ? transportIDs : null);
  _clearDemoMap(typeof lineMapping !== 'undefined' ? lineMapping : null);
  _clearDemoMap(typeof phoneMapping !== 'undefined' ? phoneMapping : null);

  for (var i = 0; i < DEMO_DRIVERS.length; i++) {
    var d = DEMO_DRIVERS[i];
    var key = d.driverName;
    driverDB[key] = {
      driverId: d.id, workDays: d.wd, totalHours: Math.round(d.wd * 6.5 * 10) / 10,
      totalPackages: d.tp, packagesPerHour: d.pph,
      totalPackagesAll: d.tp + Math.floor(d.tp * 0.12),
      distanceKm: d.dist, incidents: d.inc,
      misdeliveryRate: d.mis, deliveryRate: d.del,
      lastUpdated: 'W22-W31'
    };

    // driverDepartments
    if (typeof driverDepartments !== 'undefined') driverDepartments[key] = d.dept;
    // driverJapaneseNames: 日本語名 ≠ ドライバー名（英語）
    if (typeof driverJapaneseNames !== 'undefined') driverJapaneseNames[key] = d.name;
    // transportIDs
    if (typeof transportIDs !== 'undefined') transportIDs[key] = d.tid;
    // lineMapping（デモバッジ用）
    if (typeof lineMapping !== 'undefined') lineMapping[key] = i < 20 ? ('Udemo' + String(i + 1).padStart(28, '0')) : '';
    // phoneMapping
    if (typeof phoneMapping !== 'undefined') phoneMapping[key] = d.phone;
  }

  // localStorage にも保存（renderMasterTable がlocalStorage読むケースの保険）
  try {
    var deptObj = {}; var tidObj = {}; var jnObj = {}; var phoneObj = {}; var lineObj = {};
    for (var j = 0; j < DEMO_DRIVERS.length; j++) {
      var dd = DEMO_DRIVERS[j];
      deptObj[dd.driverName] = dd.dept;
      tidObj[dd.driverName] = dd.tid;
      jnObj[dd.driverName] = dd.name;
      phoneObj[dd.driverName] = dd.phone;
      if (j < 20) lineObj[dd.driverName] = 'Udemo' + String(j + 1).padStart(28, '0');
    }
    localStorage.setItem('driverDepartments', JSON.stringify(deptObj));
    localStorage.setItem('transportIDs', JSON.stringify(tidObj));
    localStorage.setItem('driverJapaneseNames', JSON.stringify(jnObj));
    localStorage.setItem('phoneMapping', JSON.stringify(phoneObj));
    localStorage.setItem('lineMapping', JSON.stringify(lineObj));
  } catch(e) {}

  // 点呼スケジュール seed
  if (typeof tenkoSchedule !== 'undefined') {
    tenkoSchedule.length = 0;
    for (var tk = 0; tk < 12; tk++) {
      var arrH = 7 + Math.floor(tk / 4);
      var arrM = 15 * (tk % 4);
      tenkoSchedule.push({
        name: DEMO_DRIVERS[tk].name,
        arrivalTime: String(arrH).padStart(2,'0') + ':' + String(arrM).padStart(2,'0'),
        arrivalMinutes: arrH * 60 + arrM,
        licenseAuth: tk < 7,
        mentorAuth: tk < 5,
        shiftCode: 'AM',
        temporary: false
      });
    }
  }

  // FTDS / CC seed（協力会社ダッシュボード用）
  _seedFtdsData();
  _seedCcData();
  // DNR/LAT は各デモ枠クリック時に投入
  _buildDemoSnapshot();
}

function _seedFtdsData() {
  if (typeof ftdsResultData === 'undefined') return;
  ftdsResultData.length = 0;
  for (var f = 0; f < 60; f++) {
    var driver = DEMO_DRIVERS[f % DEMO_DRIVERS.length];
    ftdsResultData.push({
      date: '2026-07-' + String(10 + (f % 18)).padStart(2,'0'),
      driverName: driver.driverName,
      transporterId: driver.tid,
      cycle: 'OFK3_CYCLE_2026-07-' + String(10 + (f % 18)).padStart(2,'0'),
      route: 'C' + String((f % 15) + 1).padStart(3,'0'),
      tracking: 'TBA' + String(300000000 + f),
      zip: '81' + String(2000 + f),
      reason: DEMO_FTDS_REASONS[f % DEMO_FTDS_REASONS.length]
    });
  }
}

function _seedCcData() {
  if (typeof ccResultData === 'undefined') return;
  ccResultData.length = 0;
  var ccCallPatterns = [
    {contactType:'Call Required - Customer',duration:0},
    {contactType:'Call Required - Customer',duration:45},
    {contactType:'Call Required - Customer',duration:0},
    {contactType:'Call Required - Customer',duration:32},
    {contactType:'',duration:0},
    {contactType:'Call Required - Customer',duration:0},
    {contactType:'Call Required - Customer',duration:60},
    {contactType:'',duration:0},
    {contactType:'Call Required - Customer',duration:0},
    {contactType:'Call Required - Customer',duration:28}
  ];
  for (var c = 0; c < 40; c++) {
    var cDriver = DEMO_DRIVERS[c % DEMO_DRIVERS.length];
    var pattern = ccCallPatterns[c % ccCallPatterns.length];
    ccResultData.push({
      date: '2026-07-' + String(10 + (c % 18)).padStart(2,'0'),
      driverName: cDriver.driverName,
      transporterId: cDriver.tid,
      tracking: 'TBA' + String(600000000 + c),
      reason: DEMO_CC_REASONS[c % DEMO_CC_REASONS.length],
      method: 'Front Door',
      contactType: pattern.contactType,
      duration: pattern.duration
    });
  }
}

function _seedDnrData() {
  if (typeof dnrResultData === 'undefined') return;
  dnrResultData.length = 0;
  var dnrIdxs = [0,2,4,8,13,15,19,22,25,29,33,35,37,1,6];
  var costs = [1200,2500,800,3000,1500,0,4200,900,1800,2000,0,3500,1100,2800,600];
  for (var dn = 0; dn < 15; dn++) {
    var dnD = DEMO_DRIVERS[dnrIdxs[dn]];
    var coord = DEMO_COORDS[dn % DEMO_COORDS.length];
    dnrResultData.push({
      driverName: dnD.driverName,
      delivery_date_jst: '2026-07-' + String(12 + (dn % 15)).padStart(2,'0'),
      delivery_station_code: 'DNG3',
      provider_company_name: dnD.dept,
      tracking_id: 'TBA' + String(400000000 + dn),
      shipment_reason: DEMO_DNR_REASONS[dn % DEMO_DNR_REASONS.length],
      address: '福岡市' + DEMO_AREAS[dn % DEMO_AREAS.length] + 'サンプル' + (dn + 1) + '丁目',
      state: '福岡県',
      _units: 1,
      _cost: costs[dn],
      _lat: coord.lat + (dn * 0.003),
      _lng: coord.lng + (dn * 0.002)
    });
  }
}

function _seedLatData() {
  if (typeof latResultData === 'undefined') return;
  var latSamples = [
    { route: 'C001', arr: '08:30', ent: '08:22', fs: '08:35', ls: '08:48', dep: '09:00', act: '08:52', exit: '08:55', diff: -8, load: 13, stay: 33, judge: '早着出発' },
    { route: 'C002', arr: '08:45', ent: '08:40', fs: '08:50', ls: '09:02', dep: '09:15', act: '09:14', exit: '09:18', diff: -1, load: 12, stay: 38, judge: '定刻' },
    { route: 'C003', arr: '09:00', ent: '08:55', fs: '09:05', ls: '09:18', dep: '09:30', act: '09:28', exit: '09:32', diff: -2, load: 13, stay: 37, judge: '定刻' },
    { route: 'C004', arr: '09:15', ent: '09:08', fs: '09:20', ls: '09:35', dep: '09:45', act: '09:38', exit: '09:42', diff: -7, load: 15, stay: 34, judge: '早着出発' },
    { route: 'C005', arr: '09:30', ent: '09:25', fs: '09:35', ls: '09:50', dep: '10:00', act: '10:05', exit: '10:08', diff: 5, load: 15, stay: 43, judge: '定刻' },
    { route: 'C006', arr: '10:00', ent: '09:55', fs: '10:05', ls: '10:20', dep: '10:30', act: '10:45', exit: '10:50', diff: 15, load: 15, stay: 55, judge: '遅延' },
    { route: 'C007', arr: '10:15', ent: '10:10', fs: '10:18', ls: '10:32', dep: '10:45', act: '10:40', exit: '10:44', diff: -5, load: 14, stay: 34, judge: '定刻' },
    { route: 'C008', arr: '10:30', ent: '10:22', fs: '10:35', ls: '10:48', dep: '11:00', act: '10:50', exit: '10:54', diff: -10, load: 13, stay: 32, judge: '早着出発' },
    { route: 'C009', arr: '11:00', ent: '10:58', fs: '11:05', ls: '11:18', dep: '11:30', act: '11:29', exit: '11:33', diff: -1, load: 13, stay: 35, judge: '定刻' },
    { route: 'C010', arr: '11:15', ent: '11:10', fs: '11:20', ls: '11:35', dep: '11:45', act: '11:50', exit: '11:55', diff: 5, load: 15, stay: 45, judge: '定刻' },
    { route: 'C011', arr: '11:30', ent: '11:25', fs: '11:35', ls: '11:48', dep: '12:00', act: '11:55', exit: '12:00', diff: -5, load: 13, stay: 35, judge: '定刻' },
    { route: 'C012', arr: '12:00', ent: '11:52', fs: '12:05', ls: '12:18', dep: '12:30', act: '12:15', exit: '12:20', diff: -15, load: 13, stay: 28, judge: '早着出発' }
  ];
  latResultData.length = 0;
  for (var li = 0; li < latSamples.length; li++) {
    var s = latSamples[li];
    var drv = DEMO_DRIVERS[li % DEMO_DRIVERS.length];
    var jName = (typeof driverJapaneseNames !== 'undefined' && driverJapaneseNames[drv.driverName]) ? driverJapaneseNames[drv.driverName] : drv.name;
    latResultData.push({
      routeId: s.route,
      employeeId: drv.tid,
      driverName: jName + ' (' + drv.driverName + ')',
      date: '2026/07/' + String(15 + (li % 10)).padStart(2, '0'),
      plannedArrival: s.arr,
      dsEntrance: s.ent,
      firstScan: s.fs,
      lastScan: s.ls,
      plannedDeparture: s.dep,
      actualDeparture: s.act,
      dsExit: s.exit,
      diffMin: s.diff,
      loadingMin: s.load,
      stayMin: s.stay,
      judgment: s.judge
    });
  }
}

function _buildDemoSnapshot() {
  var snapDrivers = {};
  for (var si = 0; si < DEMO_DRIVERS.length; si++) {
    var sd = DEMO_DRIVERS[si];
    var dFtds = 0; var dFtdsReasons = {};
    if (typeof ftdsResultData !== 'undefined') {
      for (var sf = 0; sf < ftdsResultData.length; sf++) {
        if (ftdsResultData[sf].driverName === sd.driverName) {
          dFtds++;
          var r = ftdsResultData[sf].reason || ftdsResultData[sf].shipment_reason || '';
          dFtdsReasons[r] = (dFtdsReasons[r] || 0) + 1;
        }
      }
    }
    var dCcReq = 0; var dCcAct = 0;
    if (typeof ccResultData !== 'undefined') {
      for (var sc = 0; sc < ccResultData.length; sc++) {
        if (ccResultData[sc].driverName === sd.driverName) {
          var ct = ccResultData[sc].contactType || '';
          if (ct.toLowerCase().indexOf('call') >= 0) dCcReq++;
          if ((ccResultData[sc].duration || 0) > 0) dCcAct++;
        }
      }
    }
    var dDnr = 0; var dDnrCost = 0;
    if (typeof dnrResultData !== 'undefined') {
      for (var sdn = 0; sdn < dnrResultData.length; sdn++) {
        if (dnrResultData[sdn].driverName === sd.driverName) {
          dDnr++;
          dDnrCost += dnrResultData[sdn]._cost || 0;
        }
      }
    }
    snapDrivers[sd.driverName] = {
      dept: sd.dept,
      packagesPerHour: sd.pph, misdeliveryRate: sd.mis, deliveryRate: sd.del,
      workDays: sd.wd, totalPackages: sd.tp,
      dnrCount: dDnr, dnrCost: dDnrCost,
      ftdsCount: dFtds, ftdsTopReasons: dFtdsReasons,
      ccRequired: dCcReq, ccActual: dCcAct
    };
  }
  if (typeof teamQualitySnapshot !== 'undefined') {
    teamQualitySnapshot = {
      periodLabel: 'W27-W31', abilityPeriod: 'W22-W31',
      updatedAt: new Date().toISOString(),
      sources: { dnr: true, ftds: true, cc: true, ability: true },
      drivers: snapDrivers
    };
    try { localStorage.setItem('teamQualitySnapshot', JSON.stringify(teamQualitySnapshot)); } catch(e) {}
  }
}

// ===== アップロード枠のデモ化（全タブ） =====
function _setupAllDemoZones() {
  // ダッシュボード枠
  _demoifyZone('upload-zone-cycle', function() { startDemoFromUpload('cycle'); });
  _demoifyZone('upload-zone-assign', function() { startDemoFromUpload('assign'); });
  // ファイルinputも無効化
  _disableInput('cycle-file-input');
  _disableInput('file-input');

  // FTDS/CC枠
  _demoifyDropZone('ftds-drop-zone', function() { startDemoFtds(); }, '👆 クリックするとFTDSデモデータが表示されます');
  _demoifyDropZone('cc-drop-zone', function() { startDemoCc(); }, '👆 クリックするとCCデモデータが表示されます');

  // 品質管理枠
  _demoifyDropZone('dnr-drop-zone', function() { startDemoQuality(); }, '👆 クリックするとDNRデモデータが表示されます');
  _demoifyDropZone('lat-drop-zone', function() { startDemoLat(); }, '👆 クリックするとLATデモデータが表示されます');

  // DSPルート枠（デモでは非表示）
  var dspZone = document.getElementById('dsp-drop-zone');
  if (dspZone) dspZone.style.display = 'none';
  _disableInput('dsp-file-input');

  // 住所検索のドロップ枠（非表示化のみ — クリックデモは _setupAddrSearchDemoUI）
  _disableInput('addr-search-file-input');
  _disableInput('addr-search-file-input2');
}

function _demoifyZone(id, handler) {
  var el = document.getElementById(id);
  if (!el) return;
  // inline onclick を上書き
  el.onclick = function(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    handler();
  };
  // capture phase でファイルダイアログを阻止
  el.addEventListener('click', function(e) {
    var target = e.target;
    if (target && target.tagName === 'INPUT' && target.type === 'file') {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

function _demoifyDropZone(id, handler, hint) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.cursor = 'pointer';
  el.onclick = function(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    handler();
  };
  el.ondragover = function(e) { if (e) e.preventDefault(); };
  el.ondrop = function(e) { if (e) { e.preventDefault(); e.stopPropagation(); } handler(); };
  // ヒント追加
  if (hint && !el.querySelector('.demo-hint')) {
    var p = document.createElement('p');
    p.className = 'demo-hint text-sm font-bold text-amber-600 mt-2';
    p.textContent = hint;
    el.appendChild(p);
  }
}

function _demoifyElement(el, handler, hint) {
  if (!el) return;
  el.style.cursor = 'pointer';
  el.onclick = function(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    handler();
  };
  if (hint && !el.querySelector('.demo-hint')) {
    var p = document.createElement('p');
    p.className = 'demo-hint text-sm font-bold text-amber-600 mt-2';
    p.textContent = hint;
    el.appendChild(p);
  }
}

function _disableInput(id) {
  var inp = document.getElementById(id);
  if (inp) { inp.disabled = true; inp.style.display = 'none'; }
}

// ===== タブ別デモ開始関数 =====

// 1. ダッシュボード
function startDemoFromUpload(source) {
  if (!demoDashboardLoaded) {
    loadDemoDashboardData();
    demoDashboardLoaded = true;
  }
  if (typeof renderDashboard === 'function') {
    try { renderDashboard(); } catch(e) { console.log('Demo: renderDashboard error', e.message); }
  }
  var uploadSec = document.getElementById('upload-section');
  if (uploadSec) uploadSec.classList.add('hidden');
}
window.startDemoFromUpload = startDemoFromUpload;

function loadDemoDashboardData() {
  var routeCodes = ['C001','C002','C003','C004','C005','C006','C007','C008','C009','C010','C011','C012','C013','C014','C015'];
  var areas = ['福岡市東区','福岡市博多区','福岡市中央区','福岡市南区','福岡市西区','福岡市城南区','福岡市早良区','福岡市東区','福岡市博多区','福岡市中央区','福岡市南区','福岡市西区','福岡市城南区','福岡市早良区','福岡市東区'];
  var departures = ['08:15','08:18','08:21','08:24','08:27','08:30','08:33','08:36','08:39','08:42','08:45','08:48','08:51','08:54','08:57'];
  var ends = ['17:30','17:45','18:00','18:15','17:20','18:30','17:55','18:10','19:05','17:40','18:20','17:35','18:45','17:50','19:15'];
  var statuses = ['ok','ok','ok','warning','ok','ok','warning','ok','risk','ok','ok','warning','ok','ok','warning'];

  if (typeof assignmentData !== 'undefined') {
    assignmentData.length = 0;
    for (var r = 0; r < 15; r++) {
      var rDriver = DEMO_DRIVERS[r];
      var pkg = 120 + (r * 7) % 80;
      assignmentData.push({
        routeCode: routeCodes[r],
        driverName: rDriver.driverName,
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

  // cycleData（MAP用座標）
  if (typeof cycleData !== 'undefined') {
    for (var rc = 0; rc < routeCodes.length; rc++) {
      var code = routeCodes[rc];
      var addrs = [];
      var pinCount = 8 + (rc % 5);
      for (var pi = 0; pi < pinCount; pi++) {
        var bc = DEMO_COORDS[(rc + pi) % DEMO_COORDS.length];
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
  var cycleStatusEl = document.getElementById('cycle-status');
  if (cycleStatusEl && typeof cycleData !== 'undefined') {
    var routeCount = Object.keys(cycleData).length;
    var daCount = 0;
    for (var ck in cycleData) {
      if (cycleData[ck]) daCount += cycleData[ck].length;
    }
    cycleStatusEl.textContent = routeCount + 'ルート / DA ' + daCount + '件 読込済み';
    cycleStatusEl.className = 'text-xs text-emerald-600 mt-1 font-medium';
  }
}

function ensureDemoCycleForRoute(routeCode) {
  if (!demoDashboardLoaded) loadDemoDashboardData();
  if (typeof cycleData !== 'undefined' && (!cycleData[routeCode] || cycleData[routeCode].length === 0)) {
    loadDemoDashboardData();
  }
}

// 2. 時間指定
function demoShowTwExtract() {
  var banner = document.getElementById('tw-demo-banner');
  if (banner) banner.style.display = 'none';
  if (typeof twExtractedData === 'undefined') return;
  twExtractedData.length = 0;
  var twSlots = ['08:00-12:00','12:00-14:00','14:00-16:00','16:00-18:00','18:00-20:00','19:00-21:00'];
  var twEndMins = [720,840,960,1080,1200,1260];
  for (var tw = 0; tw < 30; tw++) {
    var twDriver = DEMO_DRIVERS[tw % 15];
    var slotIdx = tw % twSlots.length;
    twExtractedData.push({
      seqNo: tw + 1,
      trackingId: 'TBA' + String(500000000 + tw),
      driverName: twDriver.driverName,
      routeCode: 'C' + String((tw % 15) + 1).padStart(3,'0'),
      departure: '08:' + String(15 + (tw % 15) * 3).padStart(2,'0'),
      address: '福岡市' + DEMO_AREAS[tw % DEMO_AREAS.length] + 'サンプル' + (tw + 1) + '丁目',
      timeWindow: twSlots[slotIdx],
      timeWindowParsed: { endMin: twEndMins[slotIdx] },
      stop: (tw % 40) + 1
    });
  }
  // twExtract のレンダリング部分を直接実行
  // サマリー更新
  var routeSet = {};
  for (var rs = 0; rs < twExtractedData.length; rs++) {
    routeSet[twExtractedData[rs].routeCode] = true;
  }
  var routeKeys = Object.keys(routeSet);
  var el;
  el = document.getElementById('tw-total-routes'); if (el) el.textContent = '15';
  el = document.getElementById('tw-total-packages'); if (el) el.textContent = twExtractedData.length;
  el = document.getElementById('tw-routes-with-tw'); if (el) el.textContent = routeKeys.length;
  el = document.getElementById('tw-avg-per-route'); if (el) el.textContent = routeKeys.length > 0 ? (twExtractedData.length / routeKeys.length).toFixed(1) : '0';
  // テーブル描画
  var tbody = document.getElementById('tw-tbody');
  var emptyEl = document.getElementById('tw-empty');
  if (tbody) {
    if (emptyEl) emptyEl.classList.add('hidden');
    var html = '';
    var prevRoute = '';
    for (var ti = 0; ti < twExtractedData.length; ti++) {
      var item = twExtractedData[ti];
      var rowClass = item.routeCode !== prevRoute ? 'border-t border-gray-600' : '';
      var twColor = item.timeWindowParsed.endMin <= 780 ? 'text-red-400 font-bold' : 'text-yellow-400';
      html += '<tr class="' + rowClass + ' hover:bg-surface-secondary">';
      html += '<td class="p-2 text-center"><span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#3b82f6;color:#fff;font-size:11px;font-weight:bold;">' + item.seqNo + '</span></td>';
      html += '<td class="p-2 font-mono">' + item.routeCode + '</td>';
      html += '<td class="p-2">' + item.driverName + '</td>';
      html += '<td class="p-2">' + item.departure + '</td>';
      html += '<td class="p-2 font-mono text-xs">' + item.trackingId + '</td>';
      html += '<td class="p-2 ' + twColor + '">' + item.timeWindow + '</td>';
      html += '<td class="p-2 text-xs">' + item.address + '</td>';
      html += '<td class="p-2 text-center">' + item.stop + '</td>';
      html += '</tr>';
      prevRoute = item.routeCode;
    }
    tbody.innerHTML = html;
  }
  // MAP用座標をseed（ジオコーディング不要）
  if (typeof inMemoryAddrMaster !== 'undefined') {
    for (var tm = 0; tm < twExtractedData.length; tm++) {
      var twItem = twExtractedData[tm];
      var twBase = DEMO_COORDS[tm % DEMO_COORDS.length];
      inMemoryAddrMaster[twItem.address] = {
        lat: twBase.lat + (tm * 0.0012) - 0.006,
        lng: twBase.lng + (tm * 0.0009) - 0.004
      };
    }
  }
  // MAP表示（demo-data.js内で完結 — twRenderMapAsyncに依存しない）
  _renderDemoTwMap(twExtractedData);
  _demoToast('デモ：サンプル30件を表示しています');
}
window.demoShowTwExtract = demoShowTwExtract;

// 4. 住所検索（後方互換）
function startDemoAddrSearch() { startDemoAddrSearchDa(); }
window.startDemoAddrSearch = startDemoAddrSearch;

function setQualityActiveView(view) {
  var dnrIds = ['dnr-dashboard', 'dnr-map-section', 'dnr-detail-section'];
  var latIds = ['lat-summary', 'lat-driver-summary', 'lat-timeline-visual'];
  var qi, el;
  for (qi = 0; qi < dnrIds.length; qi++) {
    el = document.getElementById(dnrIds[qi]);
    if (el) el.classList.toggle('hidden', view !== 'dnr');
  }
  for (qi = 0; qi < latIds.length; qi++) {
    el = document.getElementById(latIds[qi]);
    if (el) el.classList.toggle('hidden', view !== 'lat');
  }
}

// 6. 品質管理
function startDemoQuality() {
  if (!demoQualityLoaded) {
    demoQualityLoaded = true;
    _seedDnrData();
    _buildDemoSnapshot();
  }
  setQualityActiveView('dnr');
  var hero = document.getElementById('quality-hero');
  if (hero) hero.style.display = 'none';
  if (typeof renderDnrResults === 'function') {
    try { renderDnrResults(); } catch(e) { console.log('Demo: renderDnrResults error', e.message); }
  }
  if (typeof updateQualitySummary === 'function') {
    try { updateQualitySummary(); } catch(e) {}
  }
  var dnrSec = document.getElementById('dnr-dashboard');
  if (dnrSec && dnrSec.scrollIntoView) {
    setTimeout(function() { dnrSec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300);
  }
  _demoToast('デモ：DNR 15件を表示しています');
}
window.startDemoQuality = startDemoQuality;

function startDemoLat() {
  if (!demoLatLoaded) {
    demoLatLoaded = true;
    _seedLatData();
  }
  setQualityActiveView('lat');
  var hero = document.getElementById('quality-hero');
  if (hero) hero.style.display = 'none';
  if (typeof renderLatResults === 'function') {
    try { renderLatResults(); } catch(e) { console.log('Demo: renderLatResults error', e.message); }
  }
  if (typeof updateQualitySummary === 'function') {
    try { updateQualitySummary(); } catch(e) {}
  }
  var latSection = document.getElementById('lat-summary');
  if (latSection && latSection.scrollIntoView) {
    setTimeout(function() { latSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300);
  }
  _demoToast('デモ：LAT 12件を表示しています');
}
window.startDemoLat = startDemoLat;

// 5. FTDS
function startDemoFtds() {
  if (!demoFtdsLoaded) {
    demoFtdsLoaded = true;
    _seedFtdsData();
  }
  var hero = document.getElementById('ftds-hero');
  if (hero) hero.style.display = 'none';
  if (typeof renderFtdsResultsUI === 'function') {
    try { renderFtdsResultsUI(); } catch(e) { console.log('Demo: renderFtdsResultsUI error', e.message); }
  }
  _demoToast('デモ：FTDS 60件を表示しています');
}
window.startDemoFtds = startDemoFtds;

// 5. CC
function startDemoCc() {
  if (!demoCcLoaded) {
    demoCcLoaded = true;
    _seedCcData();
  }
  if (typeof renderCcResultsUI === 'function') {
    try { renderCcResultsUI(); } catch(e) { console.log('Demo: renderCcResultsUI error', e.message); }
  }
  if (typeof setFtdsCcActiveView === 'function') {
    try { setFtdsCcActiveView('cc'); } catch(e) {}
  }
  _demoToast('デモ：CC 40件を表示しています');
}
window.startDemoCc = startDemoCc;

// ===== ユーティリティ =====
function _demoToast(msg) {
  var toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1F2937;color:white;padding:10px 20px;border-radius:8px;font-size:13px;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(function() { toast.remove(); }, 2500);
}

function _showDemoBanner() {
  if (document.getElementById('demo-banner')) return;
  var banner = document.createElement('div');
  banner.id = 'demo-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#F59E0B;color:#1a1a1a;text-align:center;padding:8px 16px;font-weight:bold;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.15);';
  banner.innerHTML = '⚠ デモモード — 架空データです。送信・保存は行われません。';
  document.body.insertBefore(banner, document.body.firstChild);
  document.body.style.paddingTop = '40px';
}

// 点呼ショーケース（HTMLに静的配置済みならスキップ）
function _addTenkoShowcase() {
  if (document.getElementById('demo-tenko-showcase')) return;
  var panel = document.getElementById('panel-tenko');
  if (!panel) return;
  var showcase = document.createElement('div');
  showcase.id = 'demo-tenko-showcase';
  showcase.className = 'mt-8 space-y-6';
  showcase.innerHTML = ''
    + '<div class="border-t-2 border-blue-200 pt-6"><h3 class="text-lg font-bold text-ink mb-4">📸 点呼管理の仕組み</h3></div>'
    + '<div class="grid grid-cols-1 md:grid-cols-2 gap-6">'
    + '<div class="bg-white rounded-xl shadow p-4 text-center"><img src="/demo-tenko-qr.png" alt="点呼QR認証" class="mx-auto mb-3" style="max-height:240px;border-radius:12px"><p class="text-sm font-bold text-ink">点呼QR認証</p><p class="text-xs text-ink-lighter mt-1">ドライバーがQRコードをスキャンして出勤登録</p></div>'
    + '<div class="bg-white rounded-xl shadow p-4 text-center"><img src="/demo-tenko-mentor.png" alt="メンターアプリ" class="mx-auto mb-3" style="max-height:240px;border-radius:12px"><p class="text-sm font-bold text-ink">メンターアプリ（FICO安全運転スコア）</p><p class="text-xs text-ink-lighter mt-1">Solera/eDriving提供。起動確認で安全運転を担保</p></div>'
    + '</div>'
    + '<div class="bg-white rounded-xl shadow p-6"><h4 class="text-sm font-bold text-ink mb-4">💬 LINE通知プレビュー（自動送信イメージ）</h4>'
    + '<div style="max-width:380px;margin:0 auto;background:#7494C0;border-radius:16px;padding:16px;font-family:sans-serif">'
    + '<div style="text-align:center;color:white;font-size:12px;margin-bottom:12px">点呼管理 BOT</div>'
    + '<div style="display:flex;align-items:flex-start;margin-bottom:10px"><div style="width:36px;height:36px;border-radius:50%;background:#06C755;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;flex-shrink:0;margin-right:8px">B</div><div style="background:white;border-radius:0 16px 16px 16px;padding:12px 14px;max-width:280px;font-size:13px;line-height:1.6;box-shadow:0 1px 2px rgba(0,0,0,0.1)"><div style="font-weight:bold;color:#D94032;margin-bottom:6px">🚨 点呼未完了通知</div><div style="color:#333">着車時間 09:00 を過ぎましたが、以下のドライバーの点呼が完了していません。</div><div style="margin-top:8px;color:#333">・山田 太郎 🪪❌ 👔❌<br>・佐藤 花子 🪪❌ 👔❌</div><div style="margin-top:8px;color:#666;font-size:11px">未完了: 2名</div></div></div>'
    + '<div style="display:flex;align-items:flex-start;margin-bottom:10px"><div style="width:36px;height:36px;border-radius:50%;background:#06C755;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;flex-shrink:0;margin-right:8px">B</div><div style="background:white;border-radius:0 16px 16px 16px;padding:12px 14px;max-width:280px;font-size:13px;line-height:1.6;box-shadow:0 1px 2px rgba(0,0,0,0.1)"><div style="font-weight:bold;color:#06C755;margin-bottom:6px">✅ 点呼完了通知</div><div style="color:#333">09:05 山田 太郎 の点呼が完了しました。</div><div style="margin-top:6px;color:#333">🪪 QR認証 ✅<br>👔 メンター確認 ✅</div></div></div>'
    + '<div style="text-align:center;color:rgba(255,255,255,0.6);font-size:10px;margin-top:4px">09:05</div></div>'
    + '<p class="text-xs text-ink-lighter mt-3 text-center">※ デモ表示です。実際のLINE送信は行われません。</p></div>';
  panel.appendChild(showcase);
}

// デモ用アイコン（写真風・UIアバター・イニシャルを織り交ぜ）
var DEMO_ICON_COLORS = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#EC4899','#14B8A6','#F97316'];
var DEMO_AVATAR_PHOTOS = [11, 12, 15, 22, 28, 32, 38, 44, 51, 58, 63, 67];

function _demoDriverIndex(name) {
  var lookup = name;
  if (typeof resolveDriverKey === 'function') {
    try { lookup = resolveDriverKey(name); } catch(e) {}
  }
  for (var i = 0; i < DEMO_DRIVERS.length; i++) {
    if (DEMO_DRIVERS[i].driverName === lookup || DEMO_DRIVERS[i].name === lookup || DEMO_DRIVERS[i].name === name) return i;
  }
  var h = 0;
  for (var c = 0; c < (name || '').length; c++) h += name.charCodeAt(c);
  return h % DEMO_DRIVERS.length;
}

function _demoDriverDisplayName(name, idx) {
  var d = DEMO_DRIVERS[idx];
  if (!d) return name || '?';
  if (typeof driverJapaneseNames !== 'undefined' && driverJapaneseNames[d.driverName]) return driverJapaneseNames[d.driverName];
  return d.name || name;
}

function _demoIconFallbackHtml(name, sizeClass) {
  var idx = _demoDriverIndex(name);
  var label = _demoDriverDisplayName(name, idx);
  var initial = label.charAt(0);
  var bg = DEMO_ICON_COLORS[idx % DEMO_ICON_COLORS.length];
  return '<div class="' + sizeClass + ' rounded-full flex-shrink-0 flex items-center justify-center relative" style="background:' + bg + ';border:2px solid #06C755;color:white;font-weight:bold;font-size:14px">'
    + initial
    + '<div style="position:absolute;bottom:-1px;right:-1px;width:10px;height:10px;background:#06C755;border-radius:50%;border:1.5px solid white"></div>'
    + '</div>';
}

function getDemoDriverIcon(name, sizeClass) {
  sizeClass = sizeClass || 'w-8 h-8';
  var idx = _demoDriverIndex(name);
  var style = idx % 5;
  var safeName = (name || '?').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  var label = _demoDriverDisplayName(name, idx);
  var encLabel = encodeURIComponent(label);

  if (style === 0 || style === 1) {
    var imgNum = DEMO_AVATAR_PHOTOS[idx % DEMO_AVATAR_PHOTOS.length];
    return '<img src="https://i.pravatar.cc/150?img=' + imgNum + '" class="' + sizeClass + ' rounded-full border-2 border-[#06C755] object-cover flex-shrink-0" alt="LINE" loading="lazy" onerror="this.outerHTML=_demoIconFallbackHtml(\'' + safeName + '\',\'' + sizeClass + '\')">';
  }
  if (style === 2) {
    var bg = DEMO_ICON_COLORS[idx % DEMO_ICON_COLORS.length].replace('#', '');
    return '<img src="https://ui-avatars.com/api/?name=' + encLabel + '&background=' + bg + '&color=fff&size=128" class="' + sizeClass + ' rounded-full border-2 border-[#06C755] object-cover flex-shrink-0" alt="LINE" loading="lazy" onerror="this.outerHTML=_demoIconFallbackHtml(\'' + safeName + '\',\'' + sizeClass + '\')">';
  }
  if (style === 3) {
    return _demoIconFallbackHtml(name, sizeClass);
  }
  return '<div class="' + sizeClass + ' rounded-full flex-shrink-0 flex items-center justify-center relative" style="background:#E2E8F0;border:2px solid #06C755">'
    + '<svg viewBox="0 0 24 24" fill="#94A3B8" style="width:65%;height:65%"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>'
    + '<div style="position:absolute;bottom:-1px;right:-1px;width:10px;height:10px;background:#06C755;border-radius:50%;border:1.5px solid white"></div>'
    + '</div>';
}
window._demoIconFallbackHtml = _demoIconFallbackHtml;

function _seedDemoLineProfiles() {
  if (typeof lineProfileCache === 'undefined' || typeof lineMapping === 'undefined') return;
  for (var i = 0; i < DEMO_DRIVERS.length && i < 20; i++) {
    var d = DEMO_DRIVERS[i];
    var lid = lineMapping[d.driverName];
    if (!lid) continue;
    var style = i % 5;
    var pic = '';
    if (style === 0 || style === 1) {
      pic = 'https://i.pravatar.cc/150?img=' + DEMO_AVATAR_PHOTOS[i % DEMO_AVATAR_PHOTOS.length];
    } else if (style === 2) {
      var bg = DEMO_ICON_COLORS[i % DEMO_ICON_COLORS.length].replace('#', '');
      pic = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(d.name) + '&background=' + bg + '&color=fff&size=128';
    }
    lineProfileCache[lid] = {
      userId: lid,
      displayName: d.name,
      pictureUrl: pic,
      statusMessage: 'デモドライバー',
      fetchedAt: Date.now()
    };
  }
  try {
    if (typeof saveProfileCache === 'function') saveProfileCache();
    else localStorage.setItem('lineProfileCache', JSON.stringify(lineProfileCache));
  } catch(e) {}
}

function _patchDemoLineFeatures() {
  _seedDemoLineProfiles();

  if (typeof geocodeDmAddress === 'function') {
    window.geocodeDmAddress = async function(type) {
      var addrInput = document.getElementById('dm-' + type + '-addr');
      var statusEl = document.getElementById('dm-' + type + '-status');
      var previewEl = document.getElementById('dm-' + type + '-preview');
      var mapDiv = document.getElementById('dm-' + type + '-map');
      if (!addrInput || !statusEl || !previewEl || !mapDiv) return;
      var address = addrInput.value.trim();
      if (!address) {
        statusEl.textContent = '';
        previewEl.classList.add('hidden');
        if (typeof dmGeoCache !== 'undefined') dmGeoCache[type] = null;
        return;
      }
      statusEl.innerHTML = '<span class="text-blue-500">座標検索中...</span>';
      var geo = null;
      if (typeof inMemoryAddrMaster !== 'undefined') {
        geo = inMemoryAddrMaster[address];
        if (!geo && typeof normalizeAddress === 'function') geo = inMemoryAddrMaster[normalizeAddress(address)];
      }
      if (!geo && address.indexOf('香椎') >= 0) geo = { lat: DEMO_ADDR_DA.lat, lng: DEMO_ADDR_DA.lng };
      if (!geo && address.indexOf('姪浜') >= 0) geo = { lat: DEMO_ADDR_FREE.lat, lng: DEMO_ADDR_FREE.lng };
      if (!geo) geo = { lat: 33.59, lng: 130.40 };
      if (typeof dmGeoCache !== 'undefined') dmGeoCache[type] = { lat: geo.lat, lng: geo.lng, address: address };
      statusEl.innerHTML = '<span class="text-green-600">✓ 座標取得OK（デモ）</span>';
      previewEl.classList.remove('hidden');
      if (typeof dmLeafletMaps !== 'undefined' && dmLeafletMaps[type]) { try { dmLeafletMaps[type].remove(); } catch(e) {} }
      if (typeof L === 'undefined') return;
      var map = L.map(mapDiv).setView([geo.lat, geo.lng], 17);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 19 }).addTo(map);
      var markerColor = type === 'gohai' ? 'red' : 'green';
      var iconHtml = '<div style="background:' + markerColor + ';width:12px;height:12px;border-radius:50%;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>';
      L.marker([geo.lat, geo.lng], { icon: L.divIcon({ html: iconHtml, className: 'demo-dm-pin', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map);
      if (typeof dmLeafletMaps !== 'undefined') dmLeafletMaps[type] = map;
      setTimeout(function() { map.invalidateSize(); }, 200);
    };
  }

  if (typeof sendDmMessage === 'function') {
    window.sendDmMessage = async function() {
      if (!dmTargetDriver) { alert('送信先ドライバーを選択してください'); return; }
      var lineId = lineMapping[dmTargetDriver];
      if (!lineId) {
        alert(dmTargetDriver + ' はLINE未連携です。');
        return;
      }
      var resultEl = document.getElementById('dm-send-result');
      if (resultEl) {
        resultEl.innerHTML = '<span class="text-green-600 font-bold">✅ デモ：LINE送信をシミュレートしました</span><br><span class="text-xs text-ink-lighter">宛先: ' + dmTargetDriver + '</span>';
      }
      _demoToast('デモ：LINE送信完了（実際には送信されません）');
    };
  }

  if (typeof fetchLineProfile === 'function') {
    window.fetchLineProfile = async function(userId) {
      if (userId && lineProfileCache[userId]) return lineProfileCache[userId];
      return null;
    };
  }
}

// 後方互換
function seedDemoData() { initDemoEnvironment(); }
function _setupDemoUploadZones() { _setupAllDemoZones(); }
