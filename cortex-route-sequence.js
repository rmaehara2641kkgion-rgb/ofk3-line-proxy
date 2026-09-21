/**
 * Cortex route-sequence MAP model (Phase 2A).
 * Visit order comes from captured rmsRouteDetails.stops[].sequenceNumber.
 * 13:00 flags are joined from the existing priority packages; judgment is not duplicated here.
 * Phase 2B LINE send can reuse buildRouteSequenceModel / sequencePopup without changing this file's meaning.
 */
(function (root) {
  'use strict';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function sequenceKey(routeCode, seq) {
    return String(routeCode || '') + '#' + String(seq);
  }

  function toSeq(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function buildRouteSequenceModel(routeStops, packages) {
    var list = Array.isArray(routeStops) ? routeStops : [];
    var pkgs = Array.isArray(packages) ? packages : [];
    var priorityKeys = {};
    var priorityPkgCount = {};
    pkgs.forEach(function (p) {
      if (!p || p.routeCode == null || p.stop == null) return;
      var k = sequenceKey(p.routeCode, p.stop);
      priorityKeys[k] = true;
      priorityPkgCount[k] = (priorityPkgCount[k] || 0) + 1;
    });

    var pins = [];
    list.forEach(function (s, idx) {
      if (!s) return;
      var seq = toSeq(s.sequenceNumber != null ? s.sequenceNumber : s.stop);
      var code = String(s.routeCode || '');
      var k = sequenceKey(code, seq);
      var isPriority = seq != null && !!priorityKeys[k];
      pins.push({
        routeCode: code,
        routeId: s.routeId || '',
        driverName: s.driverName || '',
        sequenceNumber: seq,
        stop: seq,
        sortIndex: idx,
        address: s.address || '',
        latitude: s.latitude,
        longitude: s.longitude,
        plannedEndTime: s.plannedEndTime,
        plannedEndClock: s.plannedEndClock || '',
        packageCount: s.packageCount == null ? 0 : Number(s.packageCount) || 0,
        priorityPackageCount: isPriority ? (priorityPkgCount[k] || 0) : 0,
        isPriority1300: isPriority
      });
    });

    pins.sort(function (a, b) {
      var rc = String(a.routeCode).localeCompare(String(b.routeCode), 'en', { numeric: true });
      if (rc) return rc;
      if (a.sequenceNumber == null && b.sequenceNumber == null) return a.sortIndex - b.sortIndex;
      if (a.sequenceNumber == null) return 1;
      if (b.sequenceNumber == null) return -1;
      if (a.sequenceNumber !== b.sequenceNumber) return a.sequenceNumber - b.sequenceNumber;
      return a.sortIndex - b.sortIndex;
    });

    var routes = {};
    pins.forEach(function (p) { routes[p.routeCode || '-'] = true; });
    return {
      complete: list.length > 0,
      pins: pins,
      stopCount: pins.length,
      routeCount: Object.keys(routes).length
    };
  }

  function summarizeSelectedRoute(pins, packages, routeCode) {
    var code = String(routeCode || '');
    var routePins = (pins || []).filter(function (p) { return String(p.routeCode) === code; });
    var priorityStopCount = 0;
    routePins.forEach(function (p) { if (p.isPriority1300) priorityStopCount += 1; });
    var priorityPackageCount = 0;
    (packages || []).forEach(function (p) {
      if (String(p.routeCode || '') === code) priorityPackageCount += 1;
    });
    return {
      routeCode: code,
      driverName: (routePins[0] && routePins[0].driverName) || '',
      allStopCount: routePins.length,
      priorityStopCount: priorityStopCount,
      priorityPackageCount: priorityPackageCount
    };
  }

  function sequencePopup(pin) {
    pin = pin || {};
    var yes = !!pin.isPriority1300;
    return '<div>'
      + (yes ? '<div style="color:#b91c1c;font-weight:700;">🔴 13:00必達</div>' : '')
      + '<b>Route</b> ' + esc(pin.routeCode)
      + '<br><b>Driver</b> ' + esc(pin.driverName || '-')
      + '<br><b>巡回順</b> ' + esc(pin.sequenceNumber == null ? '-' : pin.sequenceNumber)
      + '<br><b>Cortex Stop</b> ' + esc(pin.stop == null ? '-' : pin.stop)
      + '<br><b>予定時刻</b> ' + esc(pin.plannedEndClock || '-')
      + '<br><b>13:00必達</b> ' + (yes ? 'YES' : 'NO')
      + '<br><b>Package数</b> ' + (pin.packageCount || 0)
      + '<br><b>住所</b> ' + esc(pin.address || '-')
      + '</div>';
  }

  var api = {
    buildRouteSequenceModel: buildRouteSequenceModel,
    summarizeSelectedRoute: summarizeSelectedRoute,
    sequencePopup: sequencePopup
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OFK3RouteSequence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
