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
    selectedProfileId: '',
    profileQuery: '',
    story: {
      sample: false,
      drivers: false,
      profile: false,
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
    state.selectedProfileId = '';
    state.profileQuery = '';
    state.story = {
      sample: false,
      drivers: false,
      profile: false,
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
    if (name === 'drivers' || name === 'profile' || name === 'schedule' || name === 'assign' || name === 'map' || name === 'line') {
      ensureLoaded();
    }
    if (name === 'drivers') state.story.drivers = true;
    if (name === 'profile') {
      state.story.profile = true;
      renderProfile();
    }
    if (name === 'schedule') state.story.schedule = true;
    if (name === 'map') {
      state.story.map = true;
      renderMap();
      setTimeout(function () { if (state.map) state.map.invalidateSize(); }, 80);
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

  var boardTimer = null;

  function currentOps() {
    if (!state.loaded || typeof DeliveryOps === 'undefined') return null;
    return DeliveryOps.estimate({
      drivers: state.drivers,
      routes: state.routes,
      schedule: state.schedule,
      experiences: state.experiences,
      clock: new Date()
    });
  }

  function driverLink(id, name) {
    if (!id) return escapeHtml(name || '未アサイン');
    return '<button type="button" class="text-link" onclick="DemoApp.openProfile(\'' + escapeHtml(id) + '\')">' + escapeHtml(name) + '</button>';
  }

  function lineBadge(driver, clickable) {
    if (!driver) return '<span class="line-status off"><span class="dot"></span>未連携</span>';
    var on = !!driver.lineConnected;
    var label = on ? 'LINE連携済み' : '未連携';
    var cls = 'line-status ' + (on ? 'on' : 'off');
    if (clickable && on) {
      return '<button type="button" class="line-btn" onclick="DemoApp.openDriverLine(\'' + escapeHtml(driver.id) + '\')"><span class="' + cls + '"><span class="dot"></span>' + label + '</span></button>';
    }
    return '<span class="' + cls + '"><span class="dot"></span>' + label + '</span>';
  }

  function lineIconSvg() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 3C7.03 3 3 6.36 3 10.5c0 3.74 3.32 6.88 7.8 7.45V21l3.04-2.64c.38.04.77.07 1.16.07C16.97 18.43 21 15.07 21 10.5 21 6.36 16.97 3 12 3zm-3.1 9.15H7.6V8.7h1.3v3.45zm2.55 0h-1.3V8.7h1.3v3.45zm2.55 0h-1.3V8.7h1.3v3.45zm2.55 0h-1.3V8.7H16.55v3.45z"/></svg>';
  }

  function lineIconButton(driver) {
    if (!driver) return '';
    if (!driver.lineConnected) {
      return '<button type="button" class="line-icon-btn is-off" disabled title="未連携" aria-label="LINE未連携">' + lineIconSvg() + '</button>';
    }
    return '<button type="button" class="line-icon-btn" title="メッセージを開く" aria-label="' + escapeHtml(driver.name) + 'へLINE" onclick="DemoApp.openLineModal(\'' + escapeHtml(driver.id) + '\')">' + lineIconSvg() + '</button>';
  }

  function lineTextButton(driver) {
    if (!driver) return '';
    if (!driver.lineConnected) {
      return '<button type="button" class="btn btn-ghost btn-sm" disabled title="未連携">' + lineIconSvg() + ' LINE送信</button>';
    }
    return '<button type="button" class="btn btn-line btn-sm" onclick="DemoApp.openLineModal(\'' + escapeHtml(driver.id) + '\')">' + lineIconSvg() + ' LINE送信</button>';
  }

  function renderDashboard() {
    var board = $('ops-board');
    var s = state.summary;
    if (!s) {
      if (board) board.hidden = true;
      $('stats').innerHTML = '';
      $('ops-hero').innerHTML = '';
      if ($('driver-board')) $('driver-board').innerHTML = '';
      $('dash-empty').style.display = 'block';
      return;
    }
    $('dash-empty').style.display = 'none';
    if (board) board.hidden = false;
    var ops = currentOps();
    var unassigned = state.assignResult ? state.assignResult.unassignedCount : s.unassignedRoutes;
    $('ops-hero').innerHTML =
      '<div class="ops-feature"><span>予測配送終了</span><b>' + escapeHtml(ops ? ops.estimatedFinish : '—') + '</b><em>デモ時刻 ' + escapeHtml(ops ? ops.now : '') + ' 時点</em></div>' +
      '<div class="ops-feature alt"><span>配送進捗</span><b>' + (ops ? ops.progress : 0) + '%</b><em>参考予測</em></div>' +
      '<div class="ops-feature paper"><span>配送完了</span><b>' + (ops ? ops.completedPackages.toLocaleString() : '0') + ' / ' + s.packages.toLocaleString() + '個</b><em>予定 ' + s.packages.toLocaleString() + '個</em></div>';
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
    renderDriverBoard(ops);
    startBoardTimer();
  }

  function startBoardTimer() {
    if (boardTimer) return;
    boardTimer = setInterval(function () {
      if (!state.loaded) return;
      var page = $('page-dashboard');
      if (!page || !page.classList.contains('active')) return;
      renderDriverBoard(currentOps());
    }, 30000);
  }

  function renderDriverBoard(ops) {
    var el = $('driver-board');
    if (!el) return;
    var rows = ops && ops.driverBoard ? ops.driverBoard : [];
    if (!rows.length) {
      el.innerHTML = '<p class="sub" style="margin:0">稼働中の配送担当がいません。</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var driver = driverById(row.driverId);
      var tone = row.status && row.status.tone ? row.status.tone : 'idle';
      var pct = Number(row.progress) || 0;
      var driverForActions = driver || { id: row.driverId, name: row.driverName, lineConnected: row.lineConnected };
      var packagesRemain = Math.max(0, row.packagesTotal - row.packagesDone);
      var stopsRemain = Math.max(0, row.stopsTotal - row.stopsDone);
      html += '<article class="driver-card tone-' + tone + '">';
      html += '<div class="driver-card-top">';
      html += '<div class="driver-name-row">';
      html += driverLink(row.driverId, row.driverName);
      html += '<span class="driver-id">ID: ' + escapeHtml(row.driverId) + '</span>';
      html += '</div>';
      html += '<span class="status-badge tone-' + tone + '"><span class="mark"></span>' + escapeHtml(row.status.label) + '</span>';
      html += '</div>';
      html += '<p class="driver-area">📍 ' + escapeHtml(row.neighborhood || '—') + '　・　コース ' + escapeHtml(row.routeLabel || '—') + '</p>';
      html += '<div class="driver-metrics">';
      html += '<div><span>荷物</span><b>' + row.packagesDone + ' / ' + row.packagesTotal + '個</b></div>';
      html += '<div><span>配送先</span><b>' + row.stopsDone + ' / ' + row.stopsTotal + '件</b></div>';
      html += '</div>';
      html += '<div class="driver-progress-label"><span>配送進捗</span><span>' + pct + '%</span></div>';
      html += '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>';
      html += '<div class="driver-return">';
      html += '<span>帰庫予定 <strong>' + escapeHtml(row.plannedReturn) + '</strong></span>';
      html += '<span class="muted">' + escapeHtml(row.remainLabel) + '</span>';
      html += '<span>残数 ' + packagesRemain + '個 / ' + stopsRemain + '件</span>';
      if (row.predictedReturn) {
        html += '<span>予測帰庫 <strong>' + escapeHtml(row.predictedReturn) + '</strong></span>';
      }
      if (row.delayLabel) {
        html += '<span class="delay">' + escapeHtml(row.delayLabel) + '</span>';
      }
      html += '</div>';
      html += '<div class="driver-card-actions">';
      html += '<button type="button" class="btn btn-ghost btn-sm" onclick="DemoApp.openDriverMap(\'' + escapeHtml(row.driverId) + '\')">MAP表示</button>';
      html += lineTextButton(driverForActions);
      html += '</div>';
      html += '</article>';
    }
    el.innerHTML = html;
  }

  function areaText(driver) {
    return (driver.areas || []).join(' / ') || '—';
  }

  function renderDrivers() {
    var html = '';
    for (var i = 0; i < state.drivers.length; i++) {
      var d = state.drivers[i];
      html += '<tr>';
      html += '<td>' + driverLink(d.id, d.name) + '</td>';
      html += '<td>' + escapeHtml(d.id) + '</td>';
      html += '<td>' + escapeHtml(d.department) + '</td>';
      html += '<td><span class="badge ' + (d.vehicle === 'Bike' ? 'badge-bike' : 'badge-van') + '">' + escapeHtml(d.vehicle) + '</span></td>';
      html += '<td>' + Number(d.capability).toFixed(1) + '個/h</td>';
      html += '<td><span class="badge ' + (d.status === '稼働' ? 'badge-ok' : 'badge-off') + '">' + escapeHtml(d.status) + '</span></td>';
      html += '<td>' + lineBadge(d, true) + '</td>';
      html += '<td>' + escapeHtml(areaText(d)) + '</td>';
      html += '</tr>';
    }
    $('driver-body').innerHTML = html;
  }

  function profileMatches(driver, query) {
    var q = String(query || '').replace(/\s+/g, '').toLowerCase();
    if (!q) return true;
    var exp = (driver.areaExperience || state.experiences.filter(function (row) {
      return row.driverId === driver.id;
    })).map(function (row) { return row.area; }).join('');
    var hay = [driver.name, driver.id, driver.department, areaText(driver), exp].join('').replace(/\s+/g, '').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function setProfileQuery(value) {
    state.profileQuery = value;
    renderProfile();
  }

  function openProfile(driverId) {
    if (!driverId) return;
    ensureLoaded();
    state.selectedProfileId = driverId;
    state.story.profile = true;
    showPage('profile');
    renderProfile();
  }

  function openDriverMap(driverId) {
    ensureLoaded();
    state.mapDriverId = driverId || 'all';
    showPage('map');
  }

  function openAllDriversMap() {
    ensureLoaded();
    state.mapFilter = 'all';
    state.mapDriverId = 'all';
    showPage('map');
  }

  function openDriverLine(driverId) {
    if (!driverId) return;
    ensureLoaded();
    state.selectedShareDriverId = driverId;
    showPage('line');
    previewLine(driverId);
  }

  function openLineModal(driverId) {
    if (!driverId) return;
    ensureLoaded();
    var driver = driverById(driverId);
    var modal = $('line-modal');
    var title = $('line-modal-title');
    var preview = $('line-modal-preview');
    var openPage = $('line-modal-open-page');
    if (!modal || !title || !preview) return;
    title.textContent = (driver ? driver.name : 'ドライバー') + ' へメッセージ';
    preview.value = buildLineMessage(driverId);
    if (openPage) {
      openPage.onclick = function () {
        closeLineModal();
        openDriverLine(driverId);
      };
    }
    modal.hidden = false;
  }

  function closeLineModal() {
    var modal = $('line-modal');
    if (modal) modal.hidden = true;
  }

  function renderProfile() {
    var list = $('profile-list');
    var detail = $('profile-detail');
    if (!list || !detail) return;
    if (!state.loaded) {
      list.innerHTML = '';
      detail.innerHTML = '<p class="sub">先にデモを開始してください。</p>';
      return;
    }
    currentOps();
    var rows = state.drivers.filter(function (d) { return profileMatches(d, state.profileQuery); });
    if (!state.selectedProfileId && rows[0]) state.selectedProfileId = rows[0].id;
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      html += '<button type="button" class="' + (d.id === state.selectedProfileId ? 'active' : '') + '" onclick="DemoApp.openProfile(\'' + escapeHtml(d.id) + '\')">';
      html += '<strong>' + escapeHtml(d.name) + '</strong>';
      html += '<span>' + escapeHtml(d.id) + ' / ' + escapeHtml(d.department) + '</span></button>';
    }
    list.innerHTML = html || '<p class="sub">該当するドライバーがいません。</p>';

    var driver = driverById(state.selectedProfileId);
    if (!driver) {
      detail.innerHTML = '<p class="sub">ドライバーを選んでください。</p>';
      return;
    }
    var schedule = null;
    for (var s = 0; s < state.schedule.length; s++) {
      if (state.schedule[s].driverId === driver.id) schedule = state.schedule[s];
    }
    var experiences = driver.areaExperience || DeliveryOps.experiencesFor(state.experiences, driver.id);
    var lastDate = driver.lastRunDate || experiences.reduce(function (latest, row) {
      return !latest || row.lastDate > latest ? row.lastDate : latest;
    }, '');
    var areasHtml = '';
    if (experiences.length) {
      experiences.forEach(function (row) {
        areasHtml += '<li>' + escapeHtml(row.area) + '：' + Number(row.days) + '回' + (row.lastDate ? '　最終 ' + escapeHtml(row.lastDate) : '') + '</li>';
      });
    } else {
      areasHtml = '<li>経験データなし</li>';
    }
    detail.innerHTML =
      '<h3>' + escapeHtml(driver.name) + '</h3>' +
      '<p class="profile-meta">' + escapeHtml(driver.id) + '　／　' + escapeHtml(driver.department) + '　／　' + escapeHtml(driver.vehicle) + '</p>' +
      lineBadge(driver, true) +
      '<div class="toolbar" style="margin-top:14px">' +
        '<button class="btn btn-secondary" onclick="DemoApp.openDriverMap(\'' + escapeHtml(driver.id) + '\')">担当MAPを見る</button>' +
        '<button class="btn btn-secondary" onclick="DemoApp.openDriverLine(\'' + escapeHtml(driver.id) + '\')">LINE共有を見る</button>' +
      '</div>' +
      '<h4>基本情報</h4>' +
      '<p>本日の勤務状態：' + escapeHtml(driver.status) + (schedule ? '　' + escapeHtml(schedule.start) + '〜' + escapeHtml(schedule.end) : '') + '</p>' +
      '<h4>配送実績</h4>' +
      '<div class="profile-kpis">' +
        '<div><span>本日の配送</span><b>' + Number(driver.packagesToday || 0).toLocaleString() + '個</b></div>' +
        '<div><span>累計配送</span><b>' + Number(driver.packagesTotal || 0).toLocaleString() + '個</b></div>' +
        '<div><span>能力</span><b>' + Number(driver.capability).toFixed(1) + '個/h</b></div>' +
        '<div><span>配完率</span><b>' + Number(driver.completionRate).toFixed(1) + '%</b></div>' +
        '<div><span>誤配率</span><b>' + Number(driver.misdeliveryRate).toFixed(2) + '%</b></div>' +
        '<div><span>本日進捗</span><b>' + Number(driver.progress || 0) + '%</b></div>' +
      '</div>' +
      '<h4>エリア経験</h4>' +
      '<p>経験エリア数：' + experiences.length + '　／　主な経験：' + escapeHtml(experiences[0] ? experiences[0].area : '—') + '</p>' +
      '<ul class="area-list">' + areasHtml + '</ul>' +
      '<p>最終経験日：' + escapeHtml(lastDate || '—') + '</p>' +
      '<p class="sub">能力とエリア経験は Auto Assign と同じサンプルデータを参照しています。</p>';
  }

  function renderSchedule() {
    var html = '';
    for (var i = 0; i < state.schedule.length; i++) {
      var s = state.schedule[i];
      html += '<tr>';
      html += '<td>' + driverLink(s.driverId, s.name) + '</td>';
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
    renderProfile();
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
        html += '<p><strong>おすすめ：</strong>' + driverLink(rec.driverId, rec.driverName) + '</p>';
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

  function driverBoardRow(driverId) {
    var ops = currentOps();
    var board = ops && ops.driverBoard ? ops.driverBoard : [];
    for (var i = 0; i < board.length; i++) {
      if (board[i].driverId === driverId) return board[i];
    }
    return null;
  }

  function buildLineMessage(driverId) {
    var driver = driverById(driverId);
    var tw = windowsForDriver(driverId);
    var evening = tw.filter(function (item) { return item.note === '18時指定'; }).length;
    var row = driverBoardRow(driverId);
    var lines = [];
    if (driver) lines.push(driver.name + ' さん');
    lines.push('【本日の配送状況】');
    lines.push('');
    if (row) {
      var packagesRemain = Math.max(0, row.packagesTotal - row.packagesDone);
      var stopsRemain = Math.max(0, row.stopsTotal - row.stopsDone);
      lines.push('コース：' + (row.routeLabel || '未設定'));
      lines.push('配送エリア：' + (row.neighborhood || '—'));
      lines.push('個口数：' + row.packagesTotal + '個');
      lines.push('件数：' + row.stopsTotal + '件');
      lines.push('配送進捗：' + row.progress + '%');
      lines.push('残数：' + packagesRemain + '個 / ' + stopsRemain + '件');
      lines.push('終了予測時間：' + (row.predictedReturn || row.plannedReturn));
    } else {
      lines.push('現在、稼働中の配送データがありません。');
    }
    lines.push('');
    lines.push('時間指定：' + tw.length + '件');
    lines.push('');
    lines.push('注意事項：');
    lines.push(evening ? ('18時指定 ' + evening + '件') : '特記なし');
    return lines.join('\n');
  }

  function renderLine() {
    var ids = state.drivers
      .filter(function (d) { return d.status === '稼働' && windowsForDriver(d.id).length > 0; })
      .sort(function (a, b) { return windowsForDriver(b.id).length - windowsForDriver(a.id).length; })
      .map(function (d) { return d.id; });
    if (state.selectedShareDriverId && ids.indexOf(state.selectedShareDriverId) < 0) {
      ids.unshift(state.selectedShareDriverId);
    }
    if (!state.selectedShareDriverId) state.selectedShareDriverId = ids[0] || '';
    var html = '';
    ids.forEach(function (id) {
      var d = driverById(id);
      if (!d) return;
      var tw = windowsForDriver(id);
      html += '<article class="share-card card' + (id === state.selectedShareDriverId ? ' active-share' : '') + '">';
      html += '<h3>' + driverLink(d.id, d.name) + '</h3>';
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
    renderProfile();
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
        if (drivers.length) {
          state.drivers = drivers.map(function (d) {
            return Object.assign({
              abilityPerHour: d.capability,
              packagesTotal: d.packagesTotal || 0,
              completionRate: d.completionRate || 98.5,
              misdeliveryRate: d.misdeliveryRate || 0.10,
              lineConnected: d.lineConnected !== false,
              areaExperience: []
            }, d);
          });
        }
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
    openProfile: openProfile,
    openDriverMap: openDriverMap,
    openAllDriversMap: openAllDriversMap,
    openDriverLine: openDriverLine,
    openLineModal: openLineModal,
    closeLineModal: closeLineModal,
    setProfileQuery: setProfileQuery,
    handleUpload: handleUpload
  };

  document.addEventListener('DOMContentLoaded', function () {
    renderStory();
    renderDashboard();
    showPage('dashboard');
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeLineModal();
  });
})();
