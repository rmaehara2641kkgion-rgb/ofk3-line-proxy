/**
 * Deterministic operations snapshot for the public demo.
 * Same sample input always yields the same progress and finish times.
 * Uses the same driver.capability / experiences that Auto Assign reads.
 */
(function (root) {
  'use strict';

  var DEMO_NOW = '16:00';
  var PACE_RATIO = 0.52;

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
      byDriver: byDriver
    };
  }

  var api = {
    DEMO_NOW: DEMO_NOW,
    PACE_RATIO: PACE_RATIO,
    estimate: estimate,
    estimateRoute: estimateRoute,
    experiencesFor: experiencesFor,
    formatTime: formatTime,
    parseMinutes: parseMinutes
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.DeliveryOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
