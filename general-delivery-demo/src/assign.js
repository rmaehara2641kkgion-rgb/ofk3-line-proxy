/**
 * Deterministic auto-assign for the general delivery demo.
 * Input: working schedule + routes + area experience + capability
 * Output: one recommended driver per route, with reasons and confidence.
 * No randomness. Same input always yields the same output.
 */
(function (root) {
  'use strict';

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : (fallback || 0);
  }

  function norm(value) {
    return String(value || '').replace(/\s+/g, '').toLowerCase();
  }

  function vehicleOk(driverVehicle, routeVehicle) {
    var d = norm(driverVehicle);
    var r = norm(routeVehicle);
    if (!r || r === 'any') return true;
    if (!d) return false;
    if (d === r) return true;
    if (d === 'both' || d === 'van/bike') return true;
    return false;
  }

  function findExperience(experiences, driverId, area) {
    var targetArea = norm(area);
    var best = null;
    for (var i = 0; i < experiences.length; i++) {
      var row = experiences[i];
      if (String(row.driverId) !== String(driverId)) continue;
      if (norm(row.area) !== targetArea) continue;
      if (!best || num(row.days) > num(best.days)) best = row;
    }
    return best;
  }

  function isWorking(driver) {
    var status = norm(driver.status || driver.workStatus);
    return status === 'active' || status === '稼働' || status === 'on' || status === '';
  }

  function confidenceOf(expDays, capability, vehicleMatched) {
    if (vehicleMatched && expDays >= 12 && capability >= 16) return '高';
    if (vehicleMatched && (expDays >= 5 || capability >= 14)) return '中';
    return '低';
  }

  function scoreCandidate(driver, route, experiences, schedule) {
    if (!isWorking(driver)) return null;
    if (!vehicleOk(driver.vehicle, route.vehicle)) return null;

    var exp = findExperience(experiences, driver.id, route.area);
    var expDays = exp ? num(exp.days) : 0;
    var expLastDate = exp ? (exp.lastDate || '') : '';
    var capability = num(driver.capability);
    var vehicleMatched = norm(driver.vehicle) === norm(route.vehicle) || norm(driver.vehicle) === 'both';
    var score = expDays * 10 + capability * 3;
    if (vehicleMatched) score += 20;
    if (norm(driver.vehicle) === 'van' && num(route.packages) >= 80) score += 8;
    if (norm(driver.vehicle) === 'bike' && num(route.packages) <= 70) score += 8;

    var reasons = [];
    if (expDays > 0) reasons.push(route.area + '経験 ' + expDays + '日');
    if (capability > 0) reasons.push('能力 ' + capability.toFixed(1) + '個/h');
    if (driver.vehicle) reasons.push('本日' + driver.vehicle + '勤務');
    if (!expDays) reasons.push('エリア経験は少なめ');

    var shift = findShift(schedule, driver.id);

    return {
      driverId: driver.id,
      driverName: driver.name,
      vehicle: driver.vehicle,
      department: driver.department || '',
      experienceDays: expDays,
      capability: capability,
      score: Math.round(score * 10) / 10,
      confidence: confidenceOf(expDays, capability, vehicleMatched),
      reasons: reasons,
      evidence: {
        area: route.area || '',
        areaVisits: expDays,
        areaLastDate: expLastDate,
        capability: capability,
        vehicle: driver.vehicle || '',
        vehicleMatched: vehicleMatched,
        workStart: shift ? shift.start : '',
        workEnd: shift ? shift.end : ''
      }
    };
  }

  function findShift(schedule, driverId) {
    if (!schedule) return null;
    for (var i = 0; i < schedule.length; i++) {
      if (String(schedule[i].driverId) === String(driverId)) return schedule[i];
    }
    return null;
  }

  function compareCandidates(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.experienceDays !== a.experienceDays) return b.experienceDays - a.experienceDays;
    if (b.capability !== a.capability) return b.capability - a.capability;
    return String(a.driverId).localeCompare(String(b.driverId));
  }

  function runAutoAssign(input) {
    var drivers = (input && input.drivers) || [];
    var routes = (input && input.routes) || [];
    var experiences = (input && input.experiences) || [];
    var schedule = (input && input.schedule) || [];
    var used = {};
    var assignments = [];

    var sortedRoutes = routes.slice().sort(function (a, b) {
      return String(a.id).localeCompare(String(b.id));
    });

    for (var i = 0; i < sortedRoutes.length; i++) {
      var route = sortedRoutes[i];
      var pool = [];
      for (var d = 0; d < drivers.length; d++) {
        var candidate = scoreCandidate(drivers[d], route, experiences, schedule);
        if (candidate) pool.push(candidate);
      }
      pool.sort(compareCandidates);

      var pick = null;
      var alternates = [];
      for (var p = 0; p < pool.length; p++) {
        if (!used[pool[p].driverId] && !pick) {
          pick = pool[p];
          used[pick.driverId] = true;
        } else if (alternates.length < 2) {
          alternates.push(pool[p]);
        }
      }

      assignments.push({
        routeId: route.id,
        routeName: route.name || route.id,
        area: route.area,
        vehicle: route.vehicle,
        packages: num(route.packages),
        stops: num(route.stops),
        assigned: !!pick,
        recommended: pick,
        alternates: alternates,
        candidateCount: pool.length
      });
    }

    var assignedCount = assignments.filter(function (row) { return row.assigned; }).length;
    return {
      assignments: assignments,
      assignedCount: assignedCount,
      unassignedCount: assignments.length - assignedCount
    };
  }

  var api = {
    runAutoAssign: runAutoAssign,
    scoreCandidate: scoreCandidate,
    vehicleOk: vehicleOk,
    findExperience: findExperience
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.DeliveryAssign = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
