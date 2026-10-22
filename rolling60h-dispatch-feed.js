/**
 * 保管済みデイリー実績から、FRIDAYが既に読んでいる通知応答を作る。
 * 音声エンジンは持たない。デイリー原本は読まず、渡されたシフトフォルダだけを読む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Rolling60hDispatchFeed = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function tokyoDate(now) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now);
    var year = '';
    var month = '';
    var day = '';
    parts.forEach(function (part) {
      if (part.type === 'year') year = part.value;
      if (part.type === 'month') month = part.value;
      if (part.type === 'day') day = part.value;
    });
    return year + '-' + month + '-' + day;
  }

  function datesPresent(blocksByTransportId) {
    var dates = {};
    Object.keys(blocksByTransportId || {}).forEach(function (transportId) {
      Object.keys(blocksByTransportId[transportId] || {}).forEach(function (date) { dates[date] = true; });
    });
    return Object.keys(dates).sort();
  }

  function missingPast(dates, start, end) {
    var missing = [];
    var cursor = start;
    var guard = 0;
    while (cursor && cursor <= end && guard < 40) {
      if (dates.indexOf(cursor) < 0) missing.push(cursor);
      if (cursor === end) break;
      cursor = require('./rolling60h-core.js').addDays(cursor, 1);
      guard += 1;
    }
    return missing;
  }

  function coverConfirmedRest(blocks, coveredDates, actualThrough) {
    var out = {};
    Object.keys(blocks || {}).forEach(function (date) { out[date] = blocks[date]; });
    (coveredDates || []).forEach(function (date) {
      if (actualThrough && date > actualThrough) return;
      if (!Object.prototype.hasOwnProperty.call(out, date)) out[date] = [];
    });
    return out;
  }

  function futureRoster(blocks, today, actualThrough) {
    var out = {};
    Object.keys(blocks || {}).forEach(function (date) {
      if (date < today) return;
      if (actualThrough && date <= actualThrough) return;
      out[date] = blocks[date];
    });
    return out;
  }

  function annotate(payload, today, rolling, extra) {
    payload.actualThrough = extra.actualThrough || '';
    payload.shiftReference = extra.shiftReference || '';
    payload.shiftMin = extra.shiftMin || '';
    payload.shiftMax = extra.shiftMax || '';
    payload.forecastDates = [today, rolling.addDays(today, 1)];
    payload.gap = extra.gap || '';
    if (extra.gap) payload.safe = false;
    if (extra.gap === 'update-stopped' || extra.gap === 'not-archived') payload.stale = true;
    else if (extra.gap) payload.stale = false;
    return payload;
  }

  function read(options) {
    options = options || {};
    var rolling = options.rolling;
    var Dispatch = require('./rolling60h-dispatch.js').bindCore(rolling);
    var today = options.today || tokyoDate(options.now ? options.now() : new Date());
    var checkedAt = (options.now ? options.now() : new Date()).toISOString();
    var archive = { ok: false, blocksByTransportId: {} };
    try {
      archive = require('./rolling60h-archive-reader.js').read({
        fs: options.fs,
        path: options.path,
        xlsx: options.xlsx,
        rolling: rolling,
        root: options.root,
        date: today,
        latest: true
      });
    } catch (e) {
      archive = { ok: false, blocksByTransportId: {} };
    }
    if (!archive.ok) return Dispatch.fridayPayload(null, checkedAt);
    var yesterday = rolling.addDays(today, -1);
    var actualDates = archive.dates && archive.dates.length ? archive.dates : datesPresent(archive.blocksByTransportId);
    var actualThrough = archive.actualThrough || actualDates[actualDates.length - 1] || '';
    var meta = {
      actualThrough: actualThrough,
      shiftReference: '',
      shiftMin: '',
      shiftMax: '',
      gap: ''
    };
    if (actualThrough && actualThrough < yesterday) {
      meta.gap = 'update-stopped';
      return annotate(Dispatch.fridayPayload(null, checkedAt), today, rolling, meta);
    }
    var requiredEnd = actualThrough < yesterday ? actualThrough : yesterday;
    if (missingPast(actualDates, rolling.addDays(today, -6), requiredEnd).length) {
      meta.gap = 'actuals-insufficient';
      return annotate(Dispatch.fridayPayload(null, checkedAt), today, rolling, meta);
    }
    var roster = { ok: false, byTid: {}, dates: [] };
    if (options.rosterByTid) {
      var rosterDates = {};
      Object.keys(options.rosterByTid).forEach(function (transportId) {
        Object.keys(options.rosterByTid[transportId] || {}).forEach(function (date) { rosterDates[date] = true; });
      });
      var rosterList = Object.keys(rosterDates).sort();
      roster = { ok: true, byTid: options.rosterByTid, file: options.shiftReference || 'fixture', min: rosterList[0] || '', max: rosterList[rosterList.length - 1] || '', dates: rosterList };
    } else if (options.shiftDir) {
      try {
        roster = require('./harvest-rolling60h-run.js').loadRoster({
          fs: options.fs,
          path: options.path,
          xlsx: options.xlsx,
          rolling: rolling,
          shiftDir: options.shiftDir
        });
      } catch (shiftErr) {
        roster = { ok: false, reason: 'shift-missing', byTid: {}, dates: [] };
      }
    }
    if (options.shiftDir || options.rosterByTid) {
      meta.shiftReference = roster.file || '';
      meta.shiftMin = roster.min || '';
      meta.shiftMax = roster.max || '';
      var tomorrow = rolling.addDays(today, 1);
      var needToday = !actualThrough || actualThrough < today;
      if (!roster.ok || (needToday && roster.dates.indexOf(today) < 0) || roster.dates.indexOf(tomorrow) < 0) {
        meta.gap = roster.reason === 'ambiguous-shift' ? 'ambiguous-shift' : 'shift-missing';
        return annotate(Dispatch.fridayPayload(null, checkedAt), today, rolling, meta);
      }
    }
    var drivers = Object.keys(archive.blocksByTransportId).map(function (transportId) {
      var rosterDays = roster.byTid ? futureRoster(roster.byTid[transportId], today, actualThrough) : {};
      return {
        transportId: transportId,
        name: transportId,
        actualBlocksByDate: {},
        rosterBlocksByDate: rosterDays,
        archiveBlocksByDate: coverConfirmedRest(archive.blocksByTransportId[transportId], actualDates, actualThrough)
      };
    });
    if ((options.shiftDir || options.rosterByTid) && !drivers.some(function (driver) { return Object.keys(driver.rosterBlocksByDate).length; })) {
      meta.gap = 'shift-unmatched';
      return annotate(Dispatch.fridayPayload(null, checkedAt), today, rolling, meta);
    }
    var board = Dispatch.assess({ today: today, drivers: drivers, limitHours: 60 });
    var payload = Dispatch.fridayPayload(board, checkedAt);
    payload.archiveReason = archive.reason;
    return annotate(payload, today, rolling, meta);
  }

  return { read: read, tokyoDate: tokyoDate };
});
