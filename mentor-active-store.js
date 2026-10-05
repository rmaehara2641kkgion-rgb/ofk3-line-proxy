/**
 * Mentor Active Snapshot store.
 * Keeps the latest allowlisted snapshot in memory.
 * Does not read credentials and does not call Mentor.
 */
'use strict';

var MAX_DRIVERS = 300;

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

function sanitizeDriver(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  var driver = {
    driverId: cleanText(row.driverId, 80),
    realStaffNumber: cleanText(row.realStaffNumber, 80),
    firstName: cleanText(row.firstName, 80),
    lastName: cleanText(row.lastName, 80),
    shiftStartTime: cleanStart(row.shiftStartTime),
    vehicleIdentifier: cleanVehicle(row.vehicleIdentifier)
  };
  if (!driver.driverId && !driver.realStaffNumber) return null;
  return driver;
}

function sanitizeMentorActiveSnapshot(body, nowIso) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!body || body.source !== 'mentor' || !Array.isArray(body.drivers)) {
    return { ok: false, message: 'mentor snapshot required' };
  }
  var drivers = [];
  for (var i = 0; i < body.drivers.length && drivers.length < MAX_DRIVERS; i++) {
    var driver = sanitizeDriver(body.drivers[i]);
    if (driver) drivers.push(driver);
  }
  var capturedAt = cleanText(body.capturedAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(capturedAt)) capturedAt = nowIso || new Date().toISOString();
  return {
    ok: true,
    snapshot: {
      capturedAt: capturedAt,
      source: 'mentor',
      activeCount: drivers.length,
      drivers: drivers
    }
  };
}

function createMentorActiveStore() {
  var latest = null;
  return {
    save: function (body, nowIso) {
      var saved = sanitizeMentorActiveSnapshot(body, nowIso);
      if (!saved.ok) return saved;
      latest = {
        capturedAt: saved.snapshot.capturedAt,
        source: 'mentor',
        activeCount: saved.snapshot.activeCount,
        drivers: saved.snapshot.drivers,
        receivedAt: nowIso || new Date().toISOString()
      };
      return { ok: true, snapshot: latest };
    },
    read: function () {
      return latest;
    }
  };
}

module.exports = {
  MAX_DRIVERS: MAX_DRIVERS,
  sanitizeDriver: sanitizeDriver,
  sanitizeMentorActiveSnapshot: sanitizeMentorActiveSnapshot,
  createMentorActiveStore: createMentorActiveStore
};
