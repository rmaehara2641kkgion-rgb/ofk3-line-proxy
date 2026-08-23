(function () {
  'use strict';

  var state = {
    loaded: false,
    drivers: [],
    schedule: [],
    routes: [],
    experiences: [],
    timeWindows: [],
    summary: null,
    assignResult: null,
    map: null,
    markers: [],
    mapFilter: 'all',
    mapDriverId: 'all',
    selectedShareDriverId: '',
    story: {
      sample: false,
      drivers: false,
      schedule: false,
      assign: false,
      map: false,
      line: false
    }
  };

  var WINDOWS = ['10:00〜12:00', '14:00〜16:00', '16:00〜18:00', '18:00〜20:00'];
  var WINDOW_COLORS = {
    '10:00〜12:00': '#2b6cb0',
    '14:00〜16:00': '#1a7a6d',
    '16:00〜18:00': '#b7791f',
    '18:00〜20:00': '#d4573c'
  };

  function $(id) { return document.getElementById(id); }

  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(function () { el.style.display = 'none'; }, 2200);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function driverById(id) {
    for (var i = 0; i < state.drivers.length; i++) {
      if (state.drivers[i].id === id) return state.drivers[i];
    }
    return null;
  }

  function routeById(id) {
    for (var i = 0; i < state.routes.length; i++) {
      if (state.routes[i].id === id) return state.routes[i];
    }
    return null;
  }

  function assignedName(route) {
    if (state.assignResult) {
      for (var i = 0; i < state.assignResult.assignments.length; i++) {
        var row = state.assignResult.assignments[i];
        if (row.routeId === route.id && row.recommended) return row.recommended.driverName;
      }
    }
    var driver = driverById(route.assignedDriverId);
    return driver ? driver.name : '未アサイン';
  }

  function resetDemoState() {
    state.loaded = false;
    state.drivers = [];
    state.schedule = [];
    state.routes = [];
    state.experiences = [];
    state.timeWindows = [];
    state.summary = null;
    state.assignResult = null;
    state.mapFilter = 'all';
    state.mapDriverId = 'all';
    state.selectedShareDriverId = '';
    state.story = {
      sample: false,
      drivers: false,
      schedule: false,
      assign: false,
      map: false,
      line: false
    };
  }

  function updateStartNotice() {
    var notice = $('demo-start-notice');
    var counts = $('demo-start-counts');
    if (!notice || !counts) return;
    if (!state.loaded || !state.summary) {
      notice.hidden = true;
      return;
    }
    counts.textContent = 'ドライバー：' + state.drivers.length + '名　配送ルート：' + state.routes.length + '件　時間指定：' + state.timeWindows.length + '件';
    notice.hidden = false;
  }

  function loadSample() {
    var data = DeliverySampleData.createSampleDataset();
    state.loaded = true;
    state.drivers = data.drivers;
    state.schedule = data.schedule;
    state.routes = data.routes;
    state.experiences = data.experiences;
    state.timeWindows = data.timeWindows;
    state.summary = data.summary;
    state.assignResult = null;
    state.story.sample = true;
    renderAll();
    updateStartNotice();
    toast('デモデータを読み込みました');
  }

  function startDemo() {
    resetDemoState();
    loadSample();
    showPage('dashboard');
  }

  function ensureLoaded() {
    if (!state.loaded) loadSample();
  }

  function showPage(name) {
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) pages[i].classList.remove('active');
    var navs = document.querySelectorAll('.nav button');
    for (var n = 0; n < navs.length; n++) navs[n].classList.toggle('active', navs[n].getAttribute('data-page') === name);
    var page = $('page-' + name);
    if (page) page.classList.add('active');
    if (name === 'drivers' || name === 'schedule' || name === 'assign' || name === 'map' || name === 'line') {
      ensureLoaded();
    }
    if (name === 'drivers') state.story.drivers = true;
    if (name === 'schedule') state.story.schedule = true;
    if (name === 'map') {
      state.story.map = true;
      setTimeout(renderMap, 80);
    }
    if (name === 'line') state.story.line = true;
    renderStory();
  }

  function renderStory() {
    var labels = [
      ['sample', '① 今日の状況', 'dashboard'],
      ['drivers', '② ドライバー', 'drivers'],
      ['schedule', '③ 勤務', 'schedule'],
      ['assign', '④ アサイン', 'assign'],
      ['map', '⑤ 時間指定MAP', 'map'],
      ['line', '⑥ LINE共有', 'line']
    ];
    var html = '';
    for (var i = 0; i < labels.length; i++) {
      html += '<button class="' + (state.story[labels[i][0]] ? 'done' : '') + '" onclick="DemoApp.go(\'' + labels[i][2] + '\')">';
      html += '<strong>' + labels[i][1] + '</strong><span>タップして進む</span></button>';
    }
    $('story').innerHTML = html;
  }

  function renderDashboard() {
    var s = state.summary;
    if (!s) {
      $('stats').innerHTML = '';
      $('dash-empty').style.display = 'block';
      return;
    }
    $('dash-empty').style.display = 'none';
    var unassigned = state.assignResult ? state.assignResult.unassignedCount : s.unassignedRoutes;
    var cards = [
      ['稼働ドライバー', s.workingDrivers + '名'],
      ['配送ルート', s.routes + 'ルート'],
      ['配送予定', s.packages.toLocaleString() + '個'],
      ['時間指定', s.timeWindows + '件'],
      ['未アサイン', unassigned + 'ルート'],
      ['18時指定', s.eveningWindows + '件']
    ];
    var html = '';
    for (var i = 0; i < cards.length; i++) {
      html += '<div class="stat"><span>' + cards[i][0] + '</span><b>' + cards[i][1] + '</b></div>';
    }
    $('stats').innerHTML = html;
  }

  function areaText(driver) {
    return (driver.areas || []).join(' / ') || '—';
  }

  function renderDrivers() {
    var html = '';
    for (var i = 0; i < state.drivers.length; i++) {
      var d = state.drivers[i];
      html += '<tr>';
      html += '<td>' + escapeHtml(d.name) + '</td>';
      html += '<td>' + escapeHtml(d.id) + '</td>';
      html += '<td>' + escapeHtml(d.department) + '</td>';
      html += '<td><span class="badge ' + (d.vehicle === 'Bike' ? 'badge-bike' : 'badge-van') + '">' + escapeHtml(d.vehicle) + '</span></td>';
      html += '<td>' + Number(d.capability).toFixed(1) + '個/h</td>';
      html += '<td><span class="badge ' + (d.status === '稼働' ? 'badge-ok' : 'badge-off') + '">' + escapeHtml(d.status) + '</span></td>';
      html += '<td>' + escapeHtml(areaText(d)) + '</td>';
      html += '</tr>';
    }
    $('driver-body').innerHTML = html;
  }

  function renderSchedule() {
    var html = '';
    for (var i = 0; i < state.schedule.length; i++) {
      var s = state.schedule[i];
      html += '<tr>';
      html += '<td>' + escapeHtml(s.name) + '</td>';
      html += '<td>' + escapeHtml(s.start) + '〜' + escapeHtml(s.end) + '</td>';
      html += '<td><span class="badge ' + (s.vehicle === 'Bike' ? 'badge-bike' : 'badge-van') + '">' + escapeHtml(s.vehicle) + '</span></td>';
      html += '<td><span class="badge ' + (s.status === '稼働' ? 'badge-ok' : 'badge-off') + '">' + escapeHtml(s.status) + '</span></td>';
      html += '</tr>';
    }
    $('schedule-body').innerHTML = html;
  }

  function runAssign() {
    ensureLoaded();
    state.assignResult = DeliveryAssign.runAutoAssign({
      drivers: state.drivers,
      routes: state.routes,
      experiences: state.experiences
    });
    for (var i = 0; i < state.assignResult.assignments.length; i++) {
      var row = state.assignResult.assignments[i];
      var route = routeById(row.routeId);
      if (route) route.assignedDriverId = row.recommended ? row.recommended.driverId : null;
    }
    applyAssignmentToWindows();
    state.summary = Object.assign({}, state.summary, { unassignedRoutes: state.assignResult.unassignedCount });
    state.story.assign = true;
    renderAssign();
    renderDashboard();
    renderLine();
    renderStory();
    toast('おすすめアサインを作成しました');
  }

  function applyAssignmentToWindows() {
    if (!state.assignResult) return;
    var byRoute = {};
    state.assignResult.assignments.forEach(function (row) {
      if (row.recommended) byRoute[row.routeId] = row.recommended.driverId;
    });
    state.timeWindows.forEach(function (item) {
      if (byRoute[item.routeId]) item.driverId = byRoute[item.routeId];
    });
  }

  function confClass(label) {
    if (label === '高') return 'badge-high';
    if (label === '中') return 'badge-mid';
    return 'badge-low';
  }

  function renderAssign() {
    var result = state.assignResult;
    if (!result) {
      $('assign-grid').innerHTML = '<div class="panel">勤務スケジュール・配送ルート・エリア経験・能力から、おすすめ担当を作成します。</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < result.assignments.length; i++) {
      var row = result.assignments[i];
      var rec = row.recommended;
      html += '<article class="assign-card card">';
      html += '<h3>' + escapeHtml(row.routeId) + '　' + escapeHtml(row.routeName) + '</h3>';
      html += '<p class="sub" style="margin:0 0 8px">' + escapeHtml(row.area) + ' / ' + escapeHtml(row.vehicle) + ' / ' + row.packages + '個</p>';
      if (rec) {
        html += '<p><strong>おすすめ：</strong>' + escapeHtml(rec.driverName) + '</p>';
        html += '<p>信頼度：<span class="badge ' + confClass(rec.confidence) + '">' + escapeHtml(rec.confidence) + '</span></p>';
        html += '<ul class="reason-list">';
        rec.reasons.forEach(function (reason) {
          html += '<li>' + escapeHtml(reason) + '</li>';
        });
        html += '</ul>';
      } else {
        html += '<p>未アサイン</p>';
      }
      html += '</article>';
    }
    $('assign-grid').innerHTML = html;
  }

  function filteredWindows() {
    return state.timeWindows.filter(function (item) {
      if (state.mapFilter !== 'all' && item.window !== state.mapFilter) return false;
      if (state.mapDriverId !== 'all' && item.driverId !== state.mapDriverId) return false;
      return true;
    });
  }

  function renderMapFilters() {
    var html = '<button class="' + (state.mapFilter === 'all' ? 'active' : '') + '" onclick="DemoApp.setMapFilter(\'all\')">すべて</button>';
    WINDOWS.forEach(function (slot) {
      html += '<button class="' + (state.mapFilter === slot ? 'active' : '') + '" onclick="DemoApp.setMapFilter(\'' + slot + '\')">' + slot + '</button>';
    });
    $('map-filters').innerHTML = html;

    var ids = [];
    state.timeWindows.forEach(function (item) {
      if (ids.indexOf(item.driverId) < 0) ids.push(item.driverId);
    });
    var select = '<option value="all">担当ドライバー：全員</option>';
    ids.forEach(function (id) {
      var d = driverById(id);
      select += '<option value="' + escapeHtml(id) + '"' + (state.mapDriverId === id ? ' selected' : '') + '>' + escapeHtml(d ? d.name : id) + '</option>';
    });
    $('map-driver-filter').innerHTML = select;
  }

  function renderMap() {
    if (typeof L === 'undefined') return;
    renderMapFilters();
    var items = filteredWindows();
    if (!state.map) {
      state.map = L.map('map').setView([33.59, 130.40], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 18
      }).addTo(state.map);
    }
    state.markers.forEach(function (m) { state.map.removeLayer(m); });
    state.markers = [];
    var bounds = [];
    var list = '';
    items.forEach(function (item, index) {
      var color = WINDOW_COLORS[item.window] || '#12263a';
      var driver = driverById(item.driverId);
      var icon = L.divIcon({
        className: 'tw-pin',
        html: '<div style="background:' + color + ';color:#fff;width:22px;height:22px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.25)">' + (index + 1) + '</div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      var marker = L.marker([item.lat, item.lng], { icon: icon }).addTo(state.map);
      marker.bindPopup(
        '<strong>配送先</strong><br>' + escapeHtml(item.address) +
        '<br><strong>時間指定</strong> ' + escapeHtml(item.window) +
        '<br><strong>Route</strong> ' + escapeHtml(item.routeId) +
        '<br><strong>Driver</strong> ' + escapeHtml(driver ? driver.name : '未設定')
      );
      state.markers.push(marker);
      bounds.push([item.lat, item.lng]);
      list += '<button class="pin-item" onclick="DemoApp.openPin(' + index + ')">';
      list += '<strong>' + escapeHtml(item.window) + '</strong><br>' + escapeHtml(item.address);
      list += '<br><span>' + escapeHtml(item.routeId) + ' / ' + escapeHtml(driver ? driver.name : '') + '</span></button>';
    });
    $('pin-list').innerHTML = list || '<div class="panel">この条件の時間指定はありません。</div>';
    $('map-count').textContent = items.length + '件';
    if (bounds.length) {
      state.map.fitBounds(bounds, { padding: [28, 28] });
    }
    setTimeout(function () { if (state.map) state.map.invalidateSize(); }, 120);
  }

  function openPin(index) {
    if (state.markers[index]) state.markers[index].openPopup();
  }

  function setMapFilter(slot) {
    state.mapFilter = slot;
    renderMap();
  }

  function setMapDriver(id) {
    state.mapDriverId = id;
    renderMap();
  }

  function windowsForDriver(driverId) {
    return state.timeWindows.filter(function (item) { return item.driverId === driverId; });
  }

  function buildLineMessage(driverId) {
    var driver = driverById(driverId);
    var tw = windowsForDriver(driverId);
    var routeIds = [];
    tw.forEach(function (item) {
      if (routeIds.indexOf(item.routeId) < 0) routeIds.push(item.routeId);
    });
    if (!routeIds.length && state.assignResult) {
      state.assignResult.assignments.forEach(function (row) {
        if (row.recommended && row.recommended.driverId === driverId) routeIds.push(row.routeId);
      });
    }
    var evening = tw.filter(function (item) { return item.note === '18時指定'; }).length;
    var routeLabel = routeIds[0] || '未設定';
    var route = routeById(routeLabel);
    var lines = [
      '【本日の配送】',
      '',
      '担当：',
      route ? (routeLabel + ' / ' + route.name) : routeLabel,
      '',
      '時間指定：',
      tw.length + '件',
      '',
      'MAP：',
      '[MAPを開く]',
      '',
      '注意事項：',
      evening ? ('18時指定 ' + evening + '件') : '特記なし'
    ];
    if (driver) {
      lines.unshift(driver.name);
      lines.splice(1, 0, '本日の時間指定MAPです', '');
    }
    return lines.join('\n');
  }

  function renderLine() {
    var ids = state.drivers
      .filter(function (d) { return d.status === '稼働' && windowsForDriver(d.id).length > 0; })
      .sort(function (a, b) { return windowsForDriver(b.id).length - windowsForDriver(a.id).length; })
      .map(function (d) { return d.id; });
    if (!state.selectedShareDriverId) state.selectedShareDriverId = ids[0] || '';
    var html = '';
    ids.forEach(function (id) {
      var d = driverById(id);
      var tw = windowsForDriver(id);
      html += '<article class="share-card card">';
      html += '<h3>' + escapeHtml(d.name) + '</h3>';
      html += '<p>時間指定：' + tw.length + '件</p>';
      html += '<div class="toolbar">';
      html += '<button class="btn btn-ghost" onclick="DemoApp.go(\'map\'); DemoApp.setMapDriver(\'' + id + '\')">MAP表示</button>';
      html += '<button class="btn btn-secondary" onclick="DemoApp.previewLine(\'' + id + '\')">LINE共有プレビュー</button>';
      html += '</div></article>';
    });
    $('line-cards').innerHTML = html || '<div class="panel">先にサンプルデータを読み込んでください。</div>';
    if (state.selectedShareDriverId) previewLine(state.selectedShareDriverId);
  }

  function previewLine(driverId) {
    state.selectedShareDriverId = driverId;
    state.story.line = true;
    $('line-preview').textContent = buildLineMessage(driverId);
    renderStory();
  }

  function renderAll() {
    renderDashboard();
    renderDrivers();
    renderSchedule();
    renderAssign();
    renderLine();
    renderStory();
    if (document.getElementById('page-map').classList.contains('active')) renderMap();
  }

  function readFile(file, callback) {
    var reader = new FileReader();
    reader.onload = function (e) { callback(String(e.target.result || '')); };
    reader.readAsText(file);
  }

  function handleUpload(kind, input) {
    var file = input.files && input.files[0];
    if (!file) return;
    ensureLoaded();
    readFile(file, function (text) {
      if (kind === 'drivers') {
        var drivers = DeliveryCsv.parseDrivers(text);
        if (drivers.length) state.drivers = drivers;
      } else if (kind === 'schedule') {
        var schedule = DeliveryCsv.parseSchedule(text);
        if (schedule.length) state.schedule = schedule;
      } else if (kind === 'routes') {
        var routes = DeliveryCsv.parseRoutes(text);
        if (routes.length) state.routes = routes;
      }
      state.summary = {
        workingDrivers: state.drivers.filter(function (d) { return d.status === '稼働'; }).length,
        routes: state.routes.length,
        packages: state.routes.reduce(function (sum, r) { return sum + (Number(r.packages) || 0); }, 0),
        timeWindows: state.timeWindows.length,
        unassignedRoutes: state.routes.filter(function (r) { return !r.assignedDriverId; }).length,
        eveningWindows: state.timeWindows.filter(function (t) { return t.window === '18:00〜20:00'; }).length
      };
      state.assignResult = null;
      renderAll();
      toast(file.name + ' を読み込みました');
    });
    input.value = '';
  }

  window.DemoApp = {
    go: showPage,
    startDemo: startDemo,
    loadSample: loadSample,
    runAssign: runAssign,
    setMapFilter: setMapFilter,
    setMapDriver: setMapDriver,
    openPin: openPin,
    previewLine: previewLine,
    handleUpload: handleUpload
  };

  document.addEventListener('DOMContentLoaded', function () {
    renderStory();
    renderDashboard();
    showPage('dashboard');
  });
})();
