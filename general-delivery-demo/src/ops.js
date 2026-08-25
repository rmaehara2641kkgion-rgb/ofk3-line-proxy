/**
 * Deterministic operations snapshot for the public demo.
 * Same sample input always yields the same progress and finish times.
 * Uses the same driver.capability / experiences that Auto Assign reads.
 */
(function (root) {
  'use strict';

  var DEMO_NOW = '16:00';
  var PACE_RATIO = 0.52;
  var STATUS_THRESHOLDS = {
    onTimeBand: 0.05,
    slightDelay: 0.15
  };
  var STATUS = {
    done: { id: 'done', label: '完了', tone: 'done' },
    ok: { id: 'ok', label: '正常', tone: 'ok' },
    warn: { id: 'warn', label: 'やや遅れ気味', tone: 'warn' },
    late: { id: 'late', label: '遅延', tone: 'late' },
    idle: { id: 'idle', label: '未出発', tone: 'idle' }
  };

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : (fallback || 0);
  }

  function pad(value) {
    return String(value).length < 2 ? '0' + value : String(value);
  }

  function parseMinutes(hhmm) {
    var parts = String(hhmm || '09:00').split(':');
    return num(parts[0]) * 60 + num(parts[1]);
  }

  function formatTime(totalMinutes) {
    var mins = Math.round(num(totalMinutes));
    if (mins < 0) mins = 0;
    var day = Math.floor(mins / (24 * 60));
    var clock = mins % (24 * 60);
    var h = Math.floor(clock / 60);
    var m = clock % 60;
    return (day > 0 ? '翌' : '') + pad(h) + ':' + pad(m);
  }

  function clockMinutes(clock) {
    if (clock == null) return parseMinutes(DEMO_NOW);
    if (typeof clock === 'number' && isFinite(clock)) return clock;
    if (typeof clock === 'string') return parseMinutes(clock);
    var d = clock instanceof Date ? clock : new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function formatRemain(mins) {
    var n = Math.round(num(mins));
    if (n >= 0) {
      var h = Math.floor(n / 60);
      var m = n % 60;
      if (h <= 0) return 'あと ' + m + '分';
      if (m === 0) return 'あと ' + h + '時間';
      return 'あと ' + h + '時間' + m + '分';
    }
    return '予定より +' + Math.abs(n) + '分';
  }

  function expectedProgress(startMin, endMin, nowMin) {
    var span = Math.max(1, endMin - startMin);
    if (nowMin <= startMin) return 0;
    if (nowMin >= endMin) return 1;
    return (nowMin - startMin) / span;
  }

  function classifyStatus(actual, expected, flags) {
    flags = flags || {};
    if (flags.complete || actual >= 0.999) return STATUS.done;
    if (flags.notStarted) return STATUS.idle;
    var delay = expected - actual;
    if (delay <= STATUS_THRESHOLDS.onTimeBand) return STATUS.ok;
    if (delay < STATUS_THRESHOLDS.slightDelay) return STATUS.warn;
    return STATUS.late;
  }

  function progressPct(done, total) {
    if (!total) return 0;
    return Math.round(done / total * 1000) / 10;
  }

  function buildDriverBoard(input, clock) {
    var nowMin = clockMinutes(clock);
    var drivers = (input && input.drivers) || [];
    var routes = (input && input.routes) || [];
    var schedule = (input && input.schedule) || [];
    var byDriver = {};

    for (var r = 0; r < routes.length; r++) {
      var route = routes[r];
      if (!route.assignedDriverId) continue;
      var id = String(route.assignedDriverId);
      if (!byDriver[id]) {
        byDriver[id] = { packagesTotal: 0, stopsTotal: 0, neighborhood: '', routeIds: [] };
      }
      var slot = byDriver[id];
      slot.packagesTotal += num(route.packages);
      slot.stopsTotal += num(route.stops);
      if (!slot.neighborhood) slot.neighborhood = route.neighborhood || route.area || '';
      slot.routeIds.push(route.id);
    }

    var rows = [];
    for (var i = 0; i < drivers.length; i++) {
      var driver = drivers[i];
      if (driver.status !== '稼働') continue;
      var agg = byDriver[driver.id];
      if (!agg || (!agg.packagesTotal && !agg.stopsTotal)) continue;
      var shift = byId(schedule, driver.id, 'driverId');
      var startMin = parseMinutes(shift && shift.start ? shift.start : '09:00');
      var endMin = parseMinutes(shift && shift.end ? shift.end : '20:00');
      var expected = expectedProgress(startMin, endMin, nowMin);
      var complete = driver.boardComplete === true;
      var notStarted = !complete && nowMin < startMin;
      var offset = num(driver.boardOffset, 0);
      var actual = 0;
      if (complete) actual = 1;
      else if (notStarted) actual = 0;
      else actual = Math.max(0, Math.min(0.995, expected + offset));

      var status = classifyStatus(actual, expected, {
        complete: complete,
        notStarted: notStarted
      });

      var packagesDone = complete ? agg.packagesTotal : Math.round(agg.packagesTotal * actual);
      var stopRate = complete ? 1 : (notStarted ? 0 : Math.max(0, Math.min(0.995, actual * 0.92 + 0.01)));
      var stopsDone = complete ? agg.stopsTotal : Math.round(agg.stopsTotal * stopRate);
      if (notStarted) {
        packagesDone = 0;
        stopsDone = 0;
      }

      var remain = endMin - nowMin;
      var delayRatio = Math.max(0, expected - actual);
      var extraMin = Math.round(delayRatio * Math.max(1, endMin - startMin));
      var predictedMin = endMin + extraMin;
      var delayed = status.id === 'late' || status.id === 'warn';

      rows.push({
        driverId: driver.id,
        driverName: driver.name,
        lineConnected: !!driver.lineConnected,
        neighborhood: agg.neighborhood,
        routeIds: agg.routeIds.slice(),
        routeLabel: agg.routeIds.join(' / '),
        packagesDone: packagesDone,
        packagesTotal: agg.packagesTotal,
        stopsDone: stopsDone,
        stopsTotal: agg.stopsTotal,
        progress: progressPct(packagesDone, agg.packagesTotal),
        plannedReturn: formatTime(endMin),
        remainLabel: status.id === 'done' ? '配送完了' : formatRemain(remain),
        remainMinutes: remain,
        predictedReturn: delayed && extraMin > 0 ? formatTime(predictedMin) : '',
        delayLabel: delayed && extraMin > 0 ? '予定より +' + extraMin + '分' : '',
        status: status,
        expectedProgress: Math.round(expected * 1000) / 10
      });
    }

    var order = { late: 0, warn: 1, ok: 2, idle: 3, done: 4 };
    rows.sort(function (a, b) {
      var da = order[a.status.id] != null ? order[a.status.id] : 9;
      var db = order[b.status.id] != null ? order[b.status.id] : 9;
      if (da !== db) return da - db;
      return String(a.driverName).localeCompare(String(b.driverName), 'ja');
    });
    return rows;
  }

  function detailAreasOf(route) {
    if (!route) return [];
    if (route.neighborhoods && route.neighborhoods.length) return route.neighborhoods.slice();
    if (route.detailAreas && route.detailAreas.length) return route.detailAreas.slice();
    var raw = String(route.detailAreaLabel || route.neighborhood || '');
    if (raw) {
      return raw.split(/[・、,]/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return route.area ? [route.area] : [];
  }

  var PIN_COLORS = {
    regular: '#6b7280',
    windows: {
      '10:00〜12:00': '#2b6cb0',
      '14:00〜16:00': '#2f9e44',
      '16:00〜18:00': '#e67700',
      '18:00〜20:00': '#c92a2a'
    }
  };
  var FICTIONAL_STREETS = ['デモ通り', 'サンプル小路', '架空台', 'デモ丘', 'サンプル橋', '架空野'];

  function seedFrom(text) {
    var s = 0;
    var str = String(text || '');
    for (var i = 0; i < str.length; i++) {
      s = (s * 31 + str.charCodeAt(i)) % 1000003;
    }
    return s;
  }

  function round5(value) {
    return Math.round(num(value) * 100000) / 100000;
  }

  function pinCountFor(route) {
    var n = num(route && route.stops);
    if (n > 0) return n;
    return 60 + (seedFrom(route && route.id) % 11);
  }

  function pinStyle(pin) {
    var windowLabel = pin && pin.window ? String(pin.window) : '';
    if (windowLabel && PIN_COLORS.windows[windowLabel]) {
      return { kind: 'timed', color: PIN_COLORS.windows[windowLabel], window: windowLabel };
    }
    return { kind: 'regular', color: PIN_COLORS.regular, window: '' };
  }

  function summarizePins(pins) {
    var timed = 0;
    var byWindow = {};
    (pins || []).forEach(function (pin) {
      if (!pin || !pin.window) return;
      timed += 1;
      byWindow[pin.window] = (byWindow[pin.window] || 0) + 1;
    });
    var total = (pins || []).length;
    return {
      total: total,
      timed: timed,
      regular: Math.max(0, total - timed),
      byWindow: byWindow
    };
  }

  function pinOffset(index, seed) {
    var ring = Math.floor(Math.max(0, index) / 8);
    var slot = Math.max(0, index) % 8;
    var angle = ((slot * 45) + ((seed + ring * 11) % 30)) * Math.PI / 180;
    var dist = 0.00105 + ring * 0.00082 + ((index * 13 + seed) % 6) * 0.00011;
    return {
      lat: Math.cos(angle) * dist,
      lng: Math.sin(angle) * dist * 1.15
    };
  }

  function neighborhoodCenter(base, name, nIndex, routeSeed) {
    var local = seedFrom(name);
    var angle = ((nIndex * 90 + (routeSeed % 50) + (local % 40)) % 360) * Math.PI / 180;
    var dist = 0.0054 + (nIndex % 3) * 0.0021 + (local % 5) * 0.00035;
    return {
      lat: base.lat + Math.cos(angle) * dist,
      lng: base.lng + Math.sin(angle) * dist * 1.18
    };
  }

  function fictionalAddress(ward, neighborhood, index) {
    var street = FICTIONAL_STREETS[index % FICTIONAL_STREETS.length];
    var chome = 1 + (index % 9);
    var ban = 1 + ((index * 3 + String(neighborhood || '').length) % 19);
    var go = 1 + ((index * 7) % 14);
    return '福岡市' + (ward || '') + (neighborhood || '') + street + chome + '-' + ban + '-' + go;
  }

  function timedIndexMap(total, twCount, seed) {
    var map = {};
    if (twCount <= 0 || total <= 0) return map;
    var used = {};
    var t;
    for (t = 0; t < twCount; t++) {
      var idx = Math.floor((t + 1) * (total - 1) / (twCount + 1));
      idx = (idx + (seed % 5)) % total;
      var guard = 0;
      while (used[idx] && guard < total) {
        idx = (idx + 7) % total;
        guard += 1;
      }
      used[idx] = true;
      map[idx] = t;
    }
    return map;
  }

  function buildRoutePins(route, timeWindows, areaCoords) {
    var routeId = route && route.id ? String(route.id) : '';
    var ward = (route && route.area) || '博多区';
    var areas = detailAreasOf(route);
    if (!areas.length) areas = [ward];
    var coords = areaCoords || {};
    var base = coords[ward] || coords['博多区'] || { lat: 33.59, lng: 130.40 };
    var seed = seedFrom(routeId);
    var tws = (timeWindows || []).filter(function (tw) {
      return String(tw.routeId) === routeId;
    });
    var total = pinCountFor(route);
    if (tws.length > total) total = tws.length;
    var timedAt = timedIndexMap(total, tws.length, seed);
    var pins = [];
    var i;
    for (i = 0; i < total; i++) {
      var nIndex = i % areas.length;
      var neighborhood = areas[nIndex];
      var center = neighborhoodCenter(base, neighborhood, nIndex, seed);
      var localIndex = Math.floor(i / areas.length);
      var off = pinOffset(localIndex, seed + nIndex * 19);
      var tw = timedAt[i] != null ? tws[timedAt[i]] : null;
      var lat = round5(center.lat + off.lat);
      var lng = round5(center.lng + off.lng);
      if (tw) {
        pins.push({
          id: tw.id || (routeId + '-TW-' + pad(i + 1)),
          lat: lat,
          lng: lng,
          label: tw.address || tw.window || routeId,
          address: tw.address || fictionalAddress(ward, neighborhood, i),
          window: tw.window || '',
          timed: true,
          routeId: routeId,
          areaName: tw.area || neighborhood,
          neighborhood: neighborhood,
          seq: i + 1
        });
      } else {
        var address = fictionalAddress(ward, neighborhood, i);
        pins.push({
          id: routeId + '-P-' + pad(i + 1),
          lat: lat,
          lng: lng,
          label: address,
          address: address,
          window: '',
          timed: false,
          routeId: routeId,
          areaName: neighborhood,
          neighborhood: neighborhood,
          seq: i + 1
        });
      }
    }
    return pins;
  }

  function describeStop(pin) {
    pin = pin || {};
    var timed = !!pin.window;
    return {
      seq: num(pin.seq, 0),
      address: pin.address || pin.label || '',
      timed: timed,
      kindLabel: timed ? '時間指定' : '通常配送',
      windowLabel: timed ? String(pin.window) : '時間指定なし'
    };
  }

  function nextStopIndex(index, total) {
    var n = num(total);
    if (n <= 0) return null;
    if (index == null || index < 0) return 0;
    if (index >= n - 1) return n - 1;
    return index + 1;
  }

  function prevStopIndex(index) {
    if (index == null || index < 0) return null;
    if (index <= 0) return 0;
    return index - 1;
  }

  function canPrevStop(index) {
    return index != null && index > 0;
  }

  function canNextStop(index, total) {
    var n = num(total);
    if (n <= 0) return false;
    if (index == null || index < 0) return true;
    return index < n - 1;
  }

  function byId(list, id, key) {
    key = key || 'id';
    for (var i = 0; i < list.length; i++) {
      if (String(list[i][key]) === String(id)) return list[i];
    }
    return null;
  }

  function experiencesFor(experiences, driverId) {
    return (experiences || []).filter(function (row) {
      return String(row.driverId) === String(driverId);
    }).slice().sort(function (a, b) {
      return num(b.days) - num(a.days);
    });
  }

  function estimateRoute(route, driver, schedule) {
    var packages = num(route.packages);
    if (!driver || driver.status !== '稼働') {
      return {
        routeId: route.id,
        routeName: route.name || route.id,
        area: route.area || '',
        driverId: '',
        driverName: '未アサイン',
        packages: packages,
        completed: 0,
        remaining: packages,
        progress: 0,
        eta: '—',
        etaMinutes: null,
        lineConnected: false,
        capability: 0
      };
    }

    var start = schedule && schedule.start ? schedule.start : '09:00';
    var elapsedH = Math.max(0, (parseMinutes(DEMO_NOW) - parseMinutes(start)) / 60);
    var capability = num(driver.capability || driver.abilityPerHour);
    var completed = Math.min(packages, Math.round(elapsedH * capability * PACE_RATIO));
    var remaining = Math.max(0, packages - completed);
    var progress = packages ? Math.round(completed / packages * 100) : 0;
    var etaMinutes = parseMinutes(DEMO_NOW) + (capability > 0 ? (remaining / capability) * 60 : 0);

    return {
      routeId: route.id,
      routeName: route.name || route.id,
      area: route.area || '',
      driverId: driver.id,
      driverName: driver.name,
      packages: packages,
      completed: completed,
      remaining: remaining,
      progress: progress,
      eta: remaining === 0 ? DEMO_NOW : formatTime(etaMinutes),
      etaMinutes: etaMinutes,
      lineConnected: !!driver.lineConnected,
      capability: capability
    };
  }

  function estimate(input) {
    var drivers = (input && input.drivers) || [];
    var routes = (input && input.routes) || [];
    var schedule = (input && input.schedule) || [];
    var experiences = (input && input.experiences) || [];
    var rows = [];
    var completed = 0;
    var packages = 0;
    var latestEta = null;

    for (var i = 0; i < routes.length; i++) {
      var route = routes[i];
      var driver = route.assignedDriverId ? byId(drivers, route.assignedDriverId) : null;
      var shift = route.assignedDriverId ? byId(schedule, route.assignedDriverId, 'driverId') : null;
      var row = estimateRoute(route, driver, shift);
      rows.push(row);
      completed += row.completed;
      packages += row.packages;
      if (row.etaMinutes != null && (latestEta == null || row.etaMinutes > latestEta)) {
        latestEta = row.etaMinutes;
      }
    }

    rows.sort(function (a, b) {
      return String(a.routeId).localeCompare(String(b.routeId));
    });

    var byDriver = {};
    rows.forEach(function (row) {
      if (!row.driverId) return;
      if (!byDriver[row.driverId]) {
        byDriver[row.driverId] = { packagesToday: 0, completed: 0, remaining: 0, etaMinutes: null, progress: 0 };
      }
      var slot = byDriver[row.driverId];
      slot.packagesToday += row.packages;
      slot.completed += row.completed;
      slot.remaining += row.remaining;
      if (row.etaMinutes != null && (slot.etaMinutes == null || row.etaMinutes > slot.etaMinutes)) {
        slot.etaMinutes = row.etaMinutes;
      }
    });
    Object.keys(byDriver).forEach(function (id) {
      var slot = byDriver[id];
      slot.progress = slot.packagesToday ? Math.round(slot.completed / slot.packagesToday * 100) : 0;
      slot.estimatedFinish = slot.etaMinutes == null ? '—' : formatTime(slot.etaMinutes);
    });

    drivers.forEach(function (driver) {
      var slot = byDriver[driver.id] || { packagesToday: 0, completed: 0, remaining: 0, progress: 0, estimatedFinish: '—' };
      driver.abilityPerHour = num(driver.capability);
      driver.packagesToday = slot.packagesToday;
      driver.progress = slot.progress;
      driver.estimatedFinish = slot.estimatedFinish;
      if (!driver.areaExperience) driver.areaExperience = experiencesFor(experiences, driver.id);
    });

    return {
      now: DEMO_NOW,
      routes: rows,
      completedPackages: completed,
      packages: packages,
      remainingPackages: Math.max(0, packages - completed),
      progress: packages ? Math.round(completed / packages * 100) : 0,
      estimatedFinish: latestEta == null ? '—' : formatTime(latestEta),
      byDriver: byDriver,
      driverBoard: buildDriverBoard(input, input && input.clock)
    };
  }

  var api = {
    DEMO_NOW: DEMO_NOW,
    PACE_RATIO: PACE_RATIO,
    STATUS: STATUS,
    STATUS_THRESHOLDS: STATUS_THRESHOLDS,
    estimate: estimate,
    estimateRoute: estimateRoute,
    buildDriverBoard: buildDriverBoard,
    PIN_COLORS: PIN_COLORS,
    pinStyle: pinStyle,
    pinCountFor: pinCountFor,
    summarizePins: summarizePins,
    describeStop: describeStop,
    nextStopIndex: nextStopIndex,
    prevStopIndex: prevStopIndex,
    canPrevStop: canPrevStop,
    canNextStop: canNextStop,
    buildRoutePins: buildRoutePins,
    detailAreasOf: detailAreasOf,
    classifyStatus: classifyStatus,
    experiencesFor: experiencesFor,
    formatTime: formatTime,
    formatRemain: formatRemain,
    parseMinutes: parseMinutes
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.DeliveryOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
