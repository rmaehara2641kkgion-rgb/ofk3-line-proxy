/**
 * Unified delivery MAP: one Leaflet instance, three marker layers.
 * Modes: routeSequence (Cortex visit order + 13:00 ring), priority, allTimeWindow.
 * Sequence numbers come from OFK3RouteSequence (captured sequenceNumber). Do not invent order.
 * No body MutationObserver. No setInterval DOM polling. No boot-time map create.
 */
(function (root) {
  'use strict';

  var MODES = ['routeSequence', 'priority', 'allTimeWindow'];
  var OVERLAY_ID = 'ofk3-delivery-map-overlay';
  var CANVAS_ID = 'ofk3-dmap-canvas';
  var ROUTE_COLORS = ['#b91c1c', '#c2410c', '#166534', '#1d4ed8', '#6d28d9', '#0f766e', '#9d174d', '#334155', '#0369a1', '#a16207'];

  var runtime = {
    mode: 'routeSequence',
    map: null,
    tile: null,
    sequenceLayer: null,
    priorityLayer: null,
    timeWindowLayer: null,
    selectedRoute: '',
    routeColorCache: {},
    bound: false
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function defaultMode(source) {
    if (source === 'tw-extract' || source === 'allTimeWindow') return 'allTimeWindow';
    if (source === 'priority') return 'priority';
    return 'routeSequence';
  }

  function normalizeMode(mode) {
    if (mode === 'allTimeWindow') return 'allTimeWindow';
    if (mode === 'priority') return 'priority';
    return 'routeSequence';
  }

  function sequenceApi() {
    return root.OFK3RouteSequence || {};
  }

  function routeColor(routeCode, cache) {
    cache = cache || {};
    var key = String(routeCode || '-');
    if (!cache[key]) cache[key] = ROUTE_COLORS[Object.keys(cache).length % ROUTE_COLORS.length];
    return cache[key];
  }

  function summarizePriority(entry, stops) {
    var list = stops || [];
    var routes = {};
    list.forEach(function (s) { routes[String(s.routeCode || '-')] = true; });
    var stopCount = entry && entry.stopCount != null ? entry.stopCount : list.length;
    var packageCount = entry && entry.packageCount != null ? entry.packageCount : 0;
    return {
      empty: !entry,
      stopCount: stopCount,
      packageCount: packageCount,
      routeCount: Object.keys(routes).length
    };
  }

  function summarizeTimeWindow(items) {
    var list = items || [];
    var routes = {};
    list.forEach(function (it) { routes[String(it.routeCode || '-')] = true; });
    return { empty: list.length === 0, itemCount: list.length, routeCount: Object.keys(routes).length };
  }

  function priorityPopup(s) {
    return '<div>'
      + '<b>Route</b> ' + esc(s.routeCode)
      + '<br><b>Driver</b> ' + esc(s.driverName || '-')
      + '<br><b>Stop</b> ' + esc(s.stop)
      + '<br><b>予定到着</b> ' + esc(s.plannedEndClock || '-')
      + '<br><b>Package数</b> ' + ((s.trackingIds && s.trackingIds.length) || 0)
      + '<br><b>住所</b> ' + esc(s.address || '-')
      + '</div>';
  }

  function timeWindowPopup(pin) {
    return '<b>' + esc(pin.seqNo || '') + ' ' + esc(pin.label) + '</b><br>🕐 '
      + esc(pin.timeWindow) + '<br>🚗 ' + esc(pin.driver) + '<br>📦 '
      + esc(pin.trackingId) + '<br>📍 ' + esc(pin.address);
  }

  function getPriorityStops() {
    try {
      if (root.OFK3Cortex13 && typeof root.OFK3Cortex13.getStops === 'function') {
        return root.OFK3Cortex13.getStops() || [];
      }
    } catch (e) {}
    return [];
  }

  function getPriorityEntry() {
    try {
      if (root.OFK3Cortex13 && typeof root.OFK3Cortex13.getEntry === 'function') {
        return root.OFK3Cortex13.getEntry();
      }
    } catch (e) {}
    return null;
  }

  function getTimeWindowItems() {
    try {
      if (typeof root.twExtractedData !== 'undefined' && Array.isArray(root.twExtractedData)) {
        return root.twExtractedData;
      }
    } catch (e) {}
    return [];
  }

  function getRouteStops() {
    try {
      if (root.OFK3Cortex13 && typeof root.OFK3Cortex13.getRouteStops === 'function') {
        return root.OFK3Cortex13.getRouteStops() || [];
      }
    } catch (e) {}
    return [];
  }

  function getPriorityPackages() {
    var entry = getPriorityEntry();
    return (entry && Array.isArray(entry.packages)) ? entry.packages : [];
  }

  function getSequenceModel() {
    var api = sequenceApi();
    if (typeof api.buildRouteSequenceModel === 'function') {
      return api.buildRouteSequenceModel(getRouteStops(), getPriorityPackages());
    }
    return { complete: false, pins: [], stopCount: 0, routeCount: 0 };
  }

  function hasFiniteCoord(lat, lng) {
    var a = Number(lat), b = Number(lng);
    return Number.isFinite(a) && Number.isFinite(b) && !(a === 0 && b === 0);
  }

  function lookupMasterGeo(address) {
    if (!address) return null;
    try {
      var master = root.inMemoryAddrMaster || {};
      var norm = typeof root.normalizeAddress === 'function' ? root.normalizeAddress(address) : address;
      var geo = master[address] || master[norm];
      if (geo && hasFiniteCoord(geo.lat, geo.lng)) return { lat: Number(geo.lat), lng: Number(geo.lng) };
    } catch (e) {}
    return null;
  }

  function markerIcon(color, label, faded) {
    var opacity = faded ? '0.35' : '1';
    var ring = faded ? '#d1d5db' : '#fff';
    return root.L.divIcon({
      className: 'ofk3-dmap-pin',
      html: '<div style="opacity:' + opacity + ';background:' + color + ';color:#fff;min-width:28px;height:22px;padding:0 5px;border-radius:11px;border:2px solid ' + ring + ';display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.35);white-space:nowrap;">' + esc(label) + '</div>',
      iconSize: [36, 22],
      iconAnchor: [18, 11]
    });
  }

  function sequenceIcon(color, seq, isPriority, faded) {
    var label = seq == null ? '-' : String(seq);
    var digits = label.length;
    var minW = digits >= 3 ? 34 : (digits >= 2 ? 28 : 24);
    var font = digits >= 3 ? '10px' : '11px';
    var opacity = faded ? '0.28' : '1';
    var border = isPriority ? '3px solid #b91c1c' : '2px solid #fff';
    var glow = isPriority && !faded ? '0 0 0 2px #fecaca, 0 1px 3px rgba(0,0,0,.35)' : '0 1px 3px rgba(0,0,0,.35)';
    var size = Math.max(minW + 8, 32);
    return root.L.divIcon({
      className: 'ofk3-dmap-pin ofk3-dmap-seq',
      html: '<div style="opacity:' + opacity + ';background:' + color + ';color:#fff;min-width:' + minW + 'px;height:24px;padding:0 5px;border-radius:12px;border:' + border + ';display:flex;align-items:center;justify-content:center;font-size:' + font + ';font-weight:700;box-shadow:' + glow + ';white-space:nowrap;letter-spacing:0;">' + esc(label) + '</div>',
      iconSize: [size, 24],
      iconAnchor: [size / 2, 12]
    });
  }

  function addSequenceMarkers(layer) {
    var model = getSequenceModel();
    var selected = runtime.selectedRoute;
    (model.pins || []).forEach(function (pin) {
      if (!hasFiniteCoord(pin.latitude, pin.longitude)) return;
      var code = String(pin.routeCode || '-');
      var color = routeColor(code, runtime.routeColorCache);
      var faded = !!(selected && selected !== code);
      var marker = root.L.marker([Number(pin.latitude), Number(pin.longitude)], {
        icon: sequenceIcon(color, pin.sequenceNumber, pin.isPriority1300, faded),
        zIndexOffset: pin.isPriority1300 ? 600 : 0
      });
      var popupHtml = typeof sequenceApi().sequencePopup === 'function'
        ? sequenceApi().sequencePopup(pin)
        : '';
      if (popupHtml) marker.bindPopup(popupHtml);
      marker.addTo(layer);
    });
  }

  function addPriorityMarkers(layer) {
    var stops = getPriorityStops();
    var selected = runtime.selectedRoute;
    stops.forEach(function (s) {
      if (!hasFiniteCoord(s.latitude, s.longitude)) return;
      var code = String(s.routeCode || '-');
      var color = routeColor(code, runtime.routeColorCache);
      var faded = !!(selected && selected !== code);
      var marker = root.L.marker([Number(s.latitude), Number(s.longitude)], {
        icon: markerIcon(color, s.stop != null ? s.stop : code, faded)
      });
      marker.bindPopup(priorityPopup(s));
      marker.addTo(layer);
    });
  }

  function addTimeWindowMarkers(layer, items) {
    (items || []).forEach(function (item) {
      var geo = lookupMasterGeo(item.address);
      if (!geo && hasFiniteCoord(item.latitude, item.longitude)) {
        geo = { lat: Number(item.latitude), lng: Number(item.longitude) };
      }
      if (!geo) return;
      var code = String(item.routeCode || '-');
      var color = routeColor(code, runtime.routeColorCache);
      var faded = !!(runtime.selectedRoute && runtime.selectedRoute !== code);
      var pin = {
        label: code + ' #' + item.stop,
        timeWindow: item.timeWindow,
        address: item.address,
        trackingId: item.trackingId,
        driver: item.driverName || '',
        seqNo: item.seqNo || ''
      };
      var marker = root.L.marker([geo.lat, geo.lng], {
        icon: markerIcon(color, pin.seqNo || item.stop || code, faded)
      });
      marker.bindPopup(timeWindowPopup(pin));
      marker.addTo(layer);
    });
  }

  function ensureMap() {
    if (typeof document === 'undefined' || !root.L || typeof root.L.map !== 'function') return null;
    var canvas = document.getElementById(CANVAS_ID);
    if (!canvas) return null;
    if (runtime.map) return runtime.map;
    runtime.map = root.L.map(canvas);
    runtime.tile = root.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(runtime.map);
    runtime.sequenceLayer = root.L.layerGroup();
    runtime.priorityLayer = root.L.layerGroup();
    runtime.timeWindowLayer = root.L.layerGroup();
    return runtime.map;
  }

  function activeLayer() {
    if (runtime.mode === 'allTimeWindow') return runtime.timeWindowLayer;
    if (runtime.mode === 'priority') return runtime.priorityLayer;
    return runtime.sequenceLayer;
  }

  function fitVisible() {
    if (!runtime.map) return;
    var layer = activeLayer();
    if (!layer) return;
    var latlngs = [];
    layer.eachLayer(function (m) {
      if (m.getLatLng) latlngs.push(m.getLatLng());
    });
    if (latlngs.length) runtime.map.fitBounds(root.L.latLngBounds(latlngs), { padding: [24, 24] });
    else runtime.map.setView([33.58, 130.34], 12);
    setTimeout(function () {
      try { if (runtime.map) runtime.map.invalidateSize(); } catch (e) {}
    }, 200);
  }

  function paintChrome() {
    if (typeof document === 'undefined') return;
    var overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    var entry = getPriorityEntry();
    var pSum = summarizePriority(entry, getPriorityStops());
    var tSum = summarizeTimeWindow(getTimeWindowItems());
    var seqModel = getSequenceModel();
    var sBtn = document.getElementById('ofk3-dmap-btn-sequence');
    var pBtn = document.getElementById('ofk3-dmap-btn-priority');
    var aBtn = document.getElementById('ofk3-dmap-btn-all');
    if (sBtn) {
      sBtn.className = runtime.mode === 'routeSequence'
        ? 'px-3 py-1.5 rounded-lg text-xs font-bold text-white'
        : 'px-3 py-1.5 rounded-lg text-xs font-bold';
      sBtn.style.background = runtime.mode === 'routeSequence' ? '#0f766e' : '#e5e7eb';
      sBtn.style.color = runtime.mode === 'routeSequence' ? '#fff' : '#111';
      sBtn.textContent = '🗺 巡回順' + (seqModel.complete ? ' ' + seqModel.stopCount : '');
    }
    if (pBtn) {
      pBtn.className = runtime.mode === 'priority'
        ? 'px-3 py-1.5 rounded-lg text-xs font-bold text-white'
        : 'px-3 py-1.5 rounded-lg text-xs font-bold';
      pBtn.style.background = runtime.mode === 'priority' ? '#b91c1c' : '#e5e7eb';
      pBtn.style.color = runtime.mode === 'priority' ? '#fff' : '#111';
      pBtn.textContent = '🔴 13:00必達' + (pSum.empty ? '' : ' ' + pSum.stopCount);
    }
    if (aBtn) {
      aBtn.className = runtime.mode === 'allTimeWindow'
        ? 'px-3 py-1.5 rounded-lg text-xs font-bold text-white'
        : 'px-3 py-1.5 rounded-lg text-xs font-bold';
      aBtn.style.background = runtime.mode === 'allTimeWindow' ? '#1d4ed8' : '#e5e7eb';
      aBtn.style.color = runtime.mode === 'allTimeWindow' ? '#fff' : '#111';
      aBtn.textContent = '🔵 全時間指定' + (tSum.empty ? '' : ' ' + tSum.itemCount);
    }
    var status = document.getElementById('ofk3-dmap-status');
    if (status) {
      if (runtime.mode === 'routeSequence') {
        status.textContent = seqModel.complete
          ? (seqModel.stopCount + ' Stops / ' + seqModel.routeCount + ' Routes（赤枠 = 13:00必達）')
          : '全Stop巡回データなし（必達Stopのみ）。🔴 13:00必達へ切替できます';
      } else if (runtime.mode === 'priority') {
        status.textContent = pSum.empty
          ? '13:00必達データがありません'
          : (pSum.stopCount + ' Stops / ' + pSum.packageCount + ' Packages / ' + pSum.routeCount + ' Routes');
      } else {
        status.textContent = tSum.empty
          ? '全時間指定データがありません'
          : (tSum.itemCount + ' 件 / ' + tSum.routeCount + ' Routes');
      }
    }
    var info = document.getElementById('ofk3-dmap-route-info');
    if (info) {
      if (runtime.mode === 'routeSequence' && runtime.selectedRoute) {
        var sumFn = sequenceApi().summarizeSelectedRoute;
        var sel = typeof sumFn === 'function'
          ? sumFn(seqModel.pins, getPriorityPackages(), runtime.selectedRoute)
          : { routeCode: runtime.selectedRoute, driverName: '', allStopCount: 0, priorityStopCount: 0, priorityPackageCount: 0 };
        info.style.display = 'block';
        info.innerHTML = esc(sel.routeCode)
          + '　Driver ' + esc(sel.driverName || '-')
          + '　全Stop ' + sel.allStopCount
          + '　13:00必達Stop ' + sel.priorityStopCount
          + '　13:00必達Package ' + sel.priorityPackageCount
          + ' <button type="button" data-dmap="route-map" class="px-2 py-1 rounded text-xs font-bold" style="background:#0f766e;color:#fff;margin-left:8px;">個別MAP</button>';
      } else {
        info.style.display = 'none';
        info.textContent = '';
      }
    }
    var legend = document.getElementById('ofk3-dmap-legend');
    if (legend) {
      var routes = [];
      var seen = {};
      if (runtime.mode === 'routeSequence') {
        (seqModel.pins || []).forEach(function (s) {
          var c = String(s.routeCode || '-');
          if (!seen[c]) { seen[c] = true; routes.push(c); }
        });
      } else if (runtime.mode === 'priority') {
        getPriorityStops().forEach(function (s) {
          var c = String(s.routeCode || '-');
          if (!seen[c]) { seen[c] = true; routes.push(c); }
        });
      } else {
        getTimeWindowItems().forEach(function (it) {
          var c = String(it.routeCode || '-');
          if (!seen[c]) { seen[c] = true; routes.push(c); }
        });
      }
      legend.innerHTML = routes.map(function (code) {
        var color = routeColor(code, runtime.routeColorCache);
        var on = !runtime.selectedRoute || runtime.selectedRoute === code;
        return '<button type="button" data-dmap-route="' + esc(code) + '" style="border:1px solid #d1d5db;border-radius:999px;padding:2px 8px;font-size:11px;background:' + (on ? '#fff' : '#f3f4f6') + ';opacity:' + (on ? '1' : '.55') + '"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';margin-right:4px;"></span>' + esc(code) + '</button>';
      }).join('');
    }
  }

  function rebuildLayers() {
    if (!runtime.map || !root.L) return;
    if (runtime.sequenceLayer) runtime.sequenceLayer.clearLayers();
    else runtime.sequenceLayer = root.L.layerGroup();
    if (runtime.priorityLayer) runtime.priorityLayer.clearLayers();
    else runtime.priorityLayer = root.L.layerGroup();
    if (runtime.timeWindowLayer) runtime.timeWindowLayer.clearLayers();
    else runtime.timeWindowLayer = root.L.layerGroup();
    addSequenceMarkers(runtime.sequenceLayer);
    addPriorityMarkers(runtime.priorityLayer);
    addTimeWindowMarkers(runtime.timeWindowLayer, getTimeWindowItems());
    if (runtime.map.hasLayer(runtime.sequenceLayer)) runtime.map.removeLayer(runtime.sequenceLayer);
    if (runtime.map.hasLayer(runtime.priorityLayer)) runtime.map.removeLayer(runtime.priorityLayer);
    if (runtime.map.hasLayer(runtime.timeWindowLayer)) runtime.map.removeLayer(runtime.timeWindowLayer);
    var layer = activeLayer();
    if (layer) layer.addTo(runtime.map);
  }

  function setMode(mode) {
    runtime.mode = normalizeMode(mode);
    runtime.selectedRoute = '';
    paintChrome();
    rebuildLayers();
    fitVisible();
  }

  function openIndividualRouteMap() {
    var code = runtime.selectedRoute;
    if (!code) return;
    if (typeof root.openCortexRouteDeliveryMap === 'function') {
      root.openCortexRouteDeliveryMap(code);
    }
  }

  function closeOverlay() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.style.display = 'none';
  }

  function bind() {
    if (runtime.bound || typeof document === 'undefined') return;
    var overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    runtime.bound = true;
    overlay.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var dmap = t.getAttribute('data-dmap');
      if (dmap === 'close') {
        ev.preventDefault();
        closeOverlay();
        return;
      }
      if (dmap === 'route-map') {
        ev.preventDefault();
        try { openIndividualRouteMap(); } catch (e) {}
        return;
      }
      var mode = t.getAttribute('data-dmap-mode');
      if (mode) {
        ev.preventDefault();
        try { setMode(mode); } catch (e) {}
        return;
      }
      var route = t.getAttribute('data-dmap-route') || (t.parentElement && t.parentElement.getAttribute && t.parentElement.getAttribute('data-dmap-route'));
      if (route) {
        ev.preventDefault();
        runtime.selectedRoute = runtime.selectedRoute === route ? '' : route;
        try { paintChrome(); rebuildLayers(); } catch (e) {}
      }
    });
  }

  async function geocodeMissing() {
    var pending = [];
    getPriorityStops().forEach(function (s) {
      if (!hasFiniteCoord(s.latitude, s.longitude) && s.address) pending.push(s);
    });
    getRouteStops().forEach(function (s) {
      if (!hasFiniteCoord(s.latitude, s.longitude) && s.address) pending.push(s);
    });
    for (var i = 0; i < pending.length; i++) {
      try {
        if (root.OFK3Cortex13 && typeof root.OFK3Cortex13.ensureStopCoords === 'function') {
          await root.OFK3Cortex13.ensureStopCoords(pending[i]);
        } else if (typeof root.fetch === 'function') {
          var r = await fetch('/geocode?address=' + encodeURIComponent(pending[i].address));
          var j = await r.json();
          if (j && j.status === 'ok') {
            pending[i].latitude = Number(j.lat);
            pending[i].longitude = Number(j.lng);
          }
        }
      } catch (e) {}
    }
    var twNeed = getTimeWindowItems().filter(function (it) {
      return it.address && !lookupMasterGeo(it.address) && !hasFiniteCoord(it.latitude, it.longitude);
    });
    for (var t = 0; t < twNeed.length; t++) {
      try {
        if (typeof root.getLatLng === 'function') {
          var coord = await root.getLatLng(twNeed[t].address);
          if (coord && hasFiniteCoord(coord.lat, coord.lng)) {
            twNeed[t].latitude = coord.lat;
            twNeed[t].longitude = coord.lng;
          }
        }
      } catch (e) {}
    }
  }

  function openUnified(mode) {
    if (typeof document === 'undefined') return;
    bind();
    var overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    runtime.mode = normalizeMode(mode);
    runtime.selectedRoute = '';
    overlay.style.display = 'block';
    paintChrome();
    var map = ensureMap();
    if (!map) {
      var status = document.getElementById('ofk3-dmap-status');
      if (status) status.textContent = '既存MAPライブラリを検出できません';
      return;
    }
    rebuildLayers();
    fitVisible();
    geocodeMissing().then(function () {
      try {
        rebuildLayers();
        fitVisible();
        paintChrome();
      } catch (e) {}
    }).catch(function () {});
  }

  function open(modeOrSource) {
    try { openUnified(defaultMode(modeOrSource)); } catch (e) {}
  }

  var api = {
    modes: MODES,
    defaultMode: defaultMode,
    normalizeMode: normalizeMode,
    routeColor: routeColor,
    summarizePriority: summarizePriority,
    summarizeTimeWindow: summarizeTimeWindow,
    priorityPopup: priorityPopup,
    timeWindowPopup: timeWindowPopup,
    getSequenceModel: getSequenceModel,
    open: open,
    openRouteMap: function (routeCode) {
      try {
        runtime.selectedRoute = String(routeCode || '');
        openIndividualRouteMap();
      } catch (e) {}
    },
    setMode: function (mode) { try { setMode(mode); } catch (e) {} },
    close: function () { try { closeOverlay(); } catch (e) {} }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OFK3DeliveryMap = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { try { bind(); } catch (e) {} });
    else try { bind(); } catch (e) {}
  }
})(typeof window !== 'undefined' ? window : globalThis);
