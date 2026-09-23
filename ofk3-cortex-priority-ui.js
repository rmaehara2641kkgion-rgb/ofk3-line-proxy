/**
 * OFK3 Cortex 13:00 priority UI.
 * Dashboard card + 時間指定タブ一覧. Independent render, no body watch, no init rewrite.
 */
(function () {
  'use strict';

  var DASH_ID = 'ofk3-cortex13-dash-card';
  var TW_ID = 'ofk3-cortex13-tw-panel';
  var MAP_ID = 'ofk3-cortex13-ui';
  var state = {
    entry: null,
    stops: [],
    routeStops: [],
    packageSequenceIndex: [],
    packageSequenceDiagnostics: null,
    error: null,
    fallback: false,
    fetched: false,
    loading: false,
    map: null
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function today() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  function group(packages) {
    var m = {};
    (packages || []).forEach(function (p) {
      var k = String(p.routeCode || '') + '#' + String(p.stop == null ? '' : p.stop);
      if (!m[k]) {
        m[k] = {
          routeCode: p.routeCode || '',
          routeId: p.routeId || '',
          stop: p.stop,
          driverName: p.driverName || '',
          plannedEndClock: p.plannedEndClock || '',
          address: p.address || '',
          latitude: p.latitude,
          longitude: p.longitude,
          trackingIds: []
        };
      }
      if (p.trackingId) m[k].trackingIds.push(p.trackingId);
      if (!m[k].address && p.address) m[k].address = p.address;
      if (m[k].latitude == null && p.latitude != null) m[k].latitude = p.latitude;
      if (m[k].longitude == null && p.longitude != null) m[k].longitude = p.longitude;
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) {
      var r = String(a.routeCode).localeCompare(String(b.routeCode), 'en', { numeric: true });
      return r || Number(a.stop || 0) - Number(b.stop || 0);
    });
  }

  function routeSummaries(stops) {
    var m = {};
    (stops || []).forEach(function (s) {
      var k = String(s.routeCode || '-');
      if (!m[k]) m[k] = { routeCode: k, stopCount: 0 };
      m[k].stopCount += 1;
    });
    return Object.keys(m).sort(function (a, b) {
      return a.localeCompare(b, 'en', { numeric: true });
    }).map(function (k) { return m[k]; });
  }

  function lastPlannedClock(stops) {
    var max = '';
    (stops || []).forEach(function (s) {
      var c = String(s.plannedEndClock || '');
      if (c && c > max) max = c;
    });
    return max || '13:00:00';
  }

  function dateLabel() {
    var e = state.entry;
    if (!e) return '';
    if (state.fallback) return 'データ日付: ' + e.localDate + '（本日分なし・最新）';
    return 'データ日付: ' + e.localDate;
  }

  function emptyMessage() {
    return state.error || '本日のデータなし';
  }

  function actionButtons(prefix) {
    return ''
      + '<div class="flex flex-wrap gap-2">'
      + '<button type="button" data-' + prefix + '="map" class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700">MAP表示</button>'
      + '<button type="button" data-' + prefix + '="csv" class="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-bold hover:bg-green-700">詳細CSV</button>'
      + '<button type="button" data-' + prefix + '="reload" class="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-bold hover:bg-amber-700">更新</button>'
      + '</div>';
  }

  function bindActions(host, attr) {
    if (!host) return;
    host.onclick = function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var a = t.getAttribute(attr);
      if (!a) return;
      ev.preventDefault();
      if (a === 'reload') load();
      else if (a === 'csv') exportCsv();
      else if (a === 'map') openMap();
    };
  }

  function hideLegacyPocCard() {
    var card = document.getElementById('cortex13-card');
    if (card) card.classList.add('hidden');
  }

  function paintLoading(host) {
    if (!host) return;
    var title = host.id === TW_ID ? '⚡ Cortex 13:00必達' : '⚡ Cortex 13:00必達';
    host.innerHTML = '<p class="text-sm font-medium">' + title + '</p>'
      + '<p class="text-xs text-ink-lighter mt-1">読込中…</p>';
  }

  function renderCortexPriorityDashboard() {
    var host = document.getElementById(DASH_ID);
    if (!host) return;
    if (state.loading && !state.fetched) {
      paintLoading(host);
      bindActions(host, 'data-c13-dash');
      return;
    }
    if (!state.entry) {
      host.innerHTML = ''
        + '<div class="flex items-start justify-between gap-3 flex-wrap">'
        + '<div><p class="text-sm font-medium">⚡ Cortex 13:00必達</p>'
        + '<p class="text-xs text-ink-lighter mt-1">' + esc(emptyMessage()) + '</p></div>'
        + actionButtons('c13-dash')
        + '</div>';
      bindActions(host, 'data-c13-dash');
      return;
    }
    var e = state.entry;
    var n = e.stopCount != null ? e.stopCount : state.stops.length;
    var p = e.packageCount != null ? e.packageCount : (e.packages || []).length;
    var routes = routeSummaries(state.stops);
    var chips = routes.map(function (r) {
      return '<span class="text-xs px-2 py-1 rounded bg-surface-secondary text-ink">'
        + esc(r.routeCode) + '　' + r.stopCount + ' Stops</span>';
    }).join('');
    host.innerHTML = ''
      + '<div class="flex items-start justify-between gap-3 flex-wrap">'
      + '<div>'
      + '<p class="text-sm font-medium">⚡ Cortex 13:00必達</p>'
      + '<p class="text-2xl font-bold font-mono mt-1">' + n + ' Stops / ' + p + ' Packages</p>'
      + '<p class="text-xs text-ink-lighter mt-1">対象Route: ' + routes.length
      + '　最終予定: ' + esc(lastPlannedClock(state.stops))
      + '　' + esc(dateLabel()) + '</p>'
      + '</div>'
      + actionButtons('c13-dash')
      + '</div>'
      + (chips ? '<div class="flex flex-wrap gap-2 mt-3">' + chips + '</div>' : '');
    bindActions(host, 'data-c13-dash');
  }

  function renderTimeWindowPanel() {
    var host = document.getElementById(TW_ID);
    if (!host) return;
    if (state.loading && !state.fetched) {
      paintLoading(host);
      bindActions(host, 'data-c13-tw');
      return;
    }
    var html = ''
      + '<div class="flex items-center justify-between gap-3 flex-wrap mb-2">'
      + '<div class="flex items-center gap-2 flex-wrap">'
      + '<h3 class="text-sm font-bold">⚡ Cortex 13:00必達</h3>';
    if (state.entry) {
      html += '<span class="text-sm font-bold text-blue-600">'
        + (state.entry.stopCount != null ? state.entry.stopCount : state.stops.length)
        + ' Stops / '
        + (state.entry.packageCount != null ? state.entry.packageCount : (state.entry.packages || []).length)
        + ' Packages</span>'
        + '<span class="text-xs text-ink-lighter">' + esc(dateLabel()) + '</span>';
    } else {
      html += '<span class="text-xs text-ink-lighter">' + esc(emptyMessage()) + '</span>';
    }
    html += '</div>' + actionButtons('c13-tw') + '</div>';
    if (state.entry) {
      html += '<div class="overflow-x-auto" style="max-height:420px;overflow-y:auto;">'
        + '<table class="w-full text-xs"><thead class="sticky top-0 bg-surface">'
        + '<tr class="text-left text-ink-lighter border-b border-gray-700">'
        + '<th class="p-2">No.</th><th class="p-2">ルート</th><th class="p-2">ドライバー</th>'
        + '<th class="p-2">予定到着</th><th class="p-2">個数</th><th class="p-2">住所</th><th class="p-2">Stop</th>'
        + '</tr></thead><tbody>';
      state.stops.forEach(function (s, i) {
        html += '<tr class="border-t border-border">'
          + '<td class="p-2">' + (i + 1) + '</td>'
          + '<td class="p-2">' + esc(s.routeCode) + '</td>'
          + '<td class="p-2">' + esc(s.driverName || '-') + '</td>'
          + '<td class="p-2 font-mono">' + esc(s.plannedEndClock || '-') + '</td>'
          + '<td class="p-2 text-center">' + s.trackingIds.length + '</td>'
          + '<td class="p-2">' + esc(s.address || '-') + '</td>'
          + '<td class="p-2 text-center">' + esc(s.stop) + '</td>'
          + '</tr>';
      });
      html += '</tbody></table></div>';
    }
    host.innerHTML = html;
    bindActions(host, 'data-c13-tw');
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    try {
      renderCortexPriorityDashboard();
      renderTimeWindowPanel();
      var d = today();
      var r = await fetch('/cortex-priority?localDate=' + encodeURIComponent(d), { cache: 'no-store' });
      var j = {};
      try { j = await r.json(); } catch (e) { j = {}; }
      var usedFallback = false;
      if (!r.ok || j.status !== 'ok') {
        r = await fetch('/cortex-priority?localDate=' + encodeURIComponent(d) + '&latest=1', { cache: 'no-store' });
        try { j = await r.json(); } catch (e) { j = {}; }
        usedFallback = true;
      }
      if (!r.ok || j.status !== 'ok') {
        state.entry = null;
        state.stops = [];
        state.routeStops = [];
        state.packageSequenceIndex = [];
        state.packageSequenceDiagnostics = null;
        state.fallback = false;
        state.error = '本日のデータなし';
      } else {
        state.entry = j;
        state.stops = group(j.packages);
        state.routeStops = Array.isArray(j.routeStops) ? j.routeStops : [];
        state.packageSequenceIndex = Array.isArray(j.packageSequenceIndex) ? j.packageSequenceIndex : [];
        state.packageSequenceDiagnostics = j.packageSequenceDiagnostics || null;
        state.fallback = usedFallback && String(j.localDate || '') !== d;
        state.error = null;
      }
    } catch (e) {
      state.entry = null;
      state.stops = [];
      state.routeStops = [];
      state.packageSequenceIndex = [];
      state.packageSequenceDiagnostics = null;
      state.fallback = false;
      state.error = '本日のデータなし';
    }
    state.fetched = true;
    state.loading = false;
    try {
      renderCortexPriorityDashboard();
      renderTimeWindowPanel();
    } catch (e) {}
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    if (!state.entry) {
      alert('Cortex 13:00データがありません');
      return;
    }
    var head = ['日付', 'Route', 'Stop', 'Driver', '予定到着', '住所', 'Tracking ID', 'Stop内個数', '緯度', '経度'];
    var counts = {};
    state.stops.forEach(function (s) {
      counts[s.routeCode + '#' + s.stop] = s.trackingIds.length;
    });
    var rows = [head].concat((state.entry.packages || []).map(function (p) {
      return [
        state.entry.localDate, p.routeCode, p.stop, p.driverName, p.plannedEndClock, p.address, p.trackingId,
        counts[String(p.routeCode || '') + '#' + String(p.stop)] || 1, p.latitude, p.longitude
      ];
    }));
    var text = '\uFEFF' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = 'OFK3_Cortex_13時必達詳細_' + state.entry.localDate + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  async function geocodeStop(s) {
    var lat = Number(s.latitude), lng = Number(s.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) return s;
    if (!s.address) return s;
    try {
      var r = await fetch('/geocode?address=' + encodeURIComponent(s.address));
      var j = await r.json();
      if (j.status === 'ok') {
        s.latitude = Number(j.lat);
        s.longitude = Number(j.lng);
      }
    } catch (e) {}
    return s;
  }

  async function ensureCoords() {
    var pending = state.stops.filter(function (s) {
      var a = Number(s.latitude), b = Number(s.longitude);
      return !(Number.isFinite(a) && Number.isFinite(b) && !(a === 0 && b === 0)) && s.address;
    });
    for (var i = 0; i < pending.length; i++) await geocodeStop(pending[i]);
  }

  function popup(s) {
    return '<div>'
      + '<b>Route</b> ' + esc(s.routeCode)
      + '<br><b>Driver</b> ' + esc(s.driverName || '-')
      + '<br><b>Stop</b> ' + esc(s.stop)
      + '<br><b>予定到着</b> ' + esc(s.plannedEndClock || '-')
      + '<br><b>Package数</b> ' + s.trackingIds.length
      + '<br><b>住所</b> ' + esc(s.address || '-')
      + '</div>';
  }

  function ensureMapOverlay() {
    var root = document.getElementById(MAP_ID);
    if (root) return root;
    root = document.createElement('section');
    root.id = MAP_ID;
    root.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:99998;width:min(900px,calc(100vw - 28px));max-height:75vh;overflow:auto;background:#fff;color:#111;border:1px solid #aaa;border-radius:10px;padding:12px;box-shadow:0 4px 20px rgba(0,0,0,.25);display:none';
    root.innerHTML = ''
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<b>Cortex 13:00必達 MAP</b>'
      + '<button type="button" data-c13-map="close" style="margin-left:auto">閉じる</button>'
      + '</div>'
      + '<div id="c13-map" style="height:430px;margin-top:8px;border:1px solid #ccc;border-radius:6px"></div>';
    document.body.appendChild(root);
    root.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-c13-map');
      if (a === 'close') root.style.display = 'none';
    });
    return root;
  }

  async function renderMap() {
    var host = document.getElementById('c13-map');
    if (!host) return;
    host.innerHTML = '<div style="padding:12px">座標を準備中…</div>';
    await ensureCoords();
    var pts = state.stops.filter(function (s) {
      var a = Number(s.latitude), b = Number(s.longitude);
      return Number.isFinite(a) && Number.isFinite(b) && !(a === 0 && b === 0);
    });
    if (!pts.length) {
      host.innerHTML = '<div style="padding:12px">地図化できる住所・座標がありません</div>';
      return;
    }
    host.innerHTML = '';
    if (state.map && typeof state.map.remove === 'function') {
      try { state.map.remove(); } catch (e) {}
      state.map = null;
    }
    if (window.L && typeof window.L.map === 'function') {
      state.map = window.L.map(host);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(state.map);
      var bounds = [];
      pts.forEach(function (s) {
        var ll = [Number(s.latitude), Number(s.longitude)];
        bounds.push(ll);
        window.L.marker(ll).addTo(state.map).bindPopup(popup(s));
      });
      state.map.fitBounds(bounds, { padding: [20, 20] });
      return;
    }
    host.innerHTML = '<div style="padding:12px">既存MAPライブラリを検出できません。座標取得 ' + pts.length + ' / ' + state.stops.length + ' Stops</div>';
  }

  function openMap() {
    try {
      if (window.OFK3DeliveryMap && typeof window.OFK3DeliveryMap.open === 'function') {
        window.OFK3DeliveryMap.open('routeSequence');
        return;
      }
      if (!state.entry) {
        alert('Cortex 13:00データがありません');
        return;
      }
      var root = ensureMapOverlay();
      root.style.display = 'block';
      renderMap();
    } catch (e) {}
  }

  function onTab(tab) {
    try {
      if (tab === 'dashboard') renderCortexPriorityDashboard();
      if (tab === 'tw-extract') renderTimeWindowPanel();
    } catch (e) {}
  }

  function boot() {
    try {
      hideLegacyPocCard();
      renderCortexPriorityDashboard();
      renderTimeWindowPanel();
      load();
    } catch (e) {}
  }

  window.OFK3Cortex13 = {
    open: openMap,
    load: load,
    exportCsv: exportCsv,
    onTab: onTab,
    renderCortexPriorityDashboard: renderCortexPriorityDashboard,
    renderDashboardCard: renderCortexPriorityDashboard,
    renderTimeWindowPanel: renderTimeWindowPanel,
    getStops: function () { return state.stops || []; },
    getRouteStops: function () { return state.routeStops || []; },
    getPackageSequenceIndex: function () { return state.packageSequenceIndex || []; },
    getPackageSequenceDiagnostics: function () { return state.packageSequenceDiagnostics; },
    getPackages: function () {
      return (state.entry && Array.isArray(state.entry.packages)) ? state.entry.packages : [];
    },
    getEntry: function () { return state.entry; },
    ensureStopCoords: geocodeStop
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
