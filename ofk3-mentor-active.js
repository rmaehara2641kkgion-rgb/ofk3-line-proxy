/**
 * OFK3 page client for the stored Mentor Active Snapshot.
 * Reads only /mentor-active. Does not call Mentor.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OFK3MentorActive = api;
})(this, function () {
  'use strict';

  var snapshot = null;
  var loadError = '';

  function cleanText(value, max) {
    if (typeof value === 'number' && isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    var text = value.trim();
    if (!text) return '';
    if (text.length > max) text = text.slice(0, max);
    if (/bearer|cookie|password/i.test(text)) return '';
    return text;
  }

  function cleanStart(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && /^-?\d{1,16}$/.test(value.trim())) {
      var n = Number(value.trim());
      if (isFinite(n)) return n;
    }
    return null;
  }

  function cleanVehicle(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text || text.length > 80) return null;
    if (/bearer|cookie|password/i.test(text)) return null;
    return text;
  }

  function sanitizeSnapshot(body) {
    if (!body || body.source !== 'mentor' || !Array.isArray(body.drivers)) return null;
    var drivers = [];
    body.drivers.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      var driver = {
        driverId: cleanText(row.driverId, 80),
        realStaffNumber: cleanText(row.realStaffNumber, 80),
        firstName: cleanText(row.firstName, 80),
        lastName: cleanText(row.lastName, 80),
        shiftStartTime: cleanStart(row.shiftStartTime),
        vehicleIdentifier: cleanVehicle(row.vehicleIdentifier)
      };
      if (!driver.driverId && !driver.realStaffNumber) return;
      drivers.push(driver);
    });
    return {
      capturedAt: cleanText(body.capturedAt, 40) || null,
      receivedAt: cleanText(body.receivedAt, 40) || null,
      source: 'mentor',
      activeCount: drivers.length,
      drivers: drivers
    };
  }

  function load() {
    loadError = '';
    return fetch('/mentor-active', { cache: 'no-store' }).then(function (res) {
      if (res.status === 404) {
        snapshot = null;
        return null;
      }
      return res.json().then(function (body) {
        if (!res.ok || !body || body.status !== 'ok') {
          snapshot = null;
          loadError = 'empty';
          return null;
        }
        snapshot = sanitizeSnapshot(body);
        if (!snapshot) loadError = 'empty';
        return snapshot;
      });
    }).catch(function () {
      snapshot = null;
      loadError = 'load-failed';
      return null;
    });
  }

  function getSnapshot() {
    return snapshot;
  }

  function getLoadError() {
    return loadError;
  }

  return {
    load: load,
    getSnapshot: getSnapshot,
    getLoadError: getLoadError,
    sanitizeSnapshot: sanitizeSnapshot
  };
});
