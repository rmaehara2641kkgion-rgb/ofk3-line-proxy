/**
 * 保管済みデイリー実績から、FRIDAYが既に読んでいる通知応答を作る。
 * 音声エンジンは持たない。原本フォルダは読まない。
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
        date: today
      });
    } catch (e) {
      archive = { ok: false, blocksByTransportId: {} };
    }
    if (!archive.ok) return Dispatch.fridayPayload(null, checkedAt);
    var drivers = Object.keys(archive.blocksByTransportId).map(function (transportId) {
      return {
        transportId: transportId,
        name: transportId,
        actualBlocksByDate: {},
        rosterBlocksByDate: {},
        archiveBlocksByDate: archive.blocksByTransportId[transportId]
      };
    });
    var board = Dispatch.assess({ today: today, drivers: drivers, limitHours: 60 });
    var payload = Dispatch.fridayPayload(board, checkedAt);
    payload.archiveReason = archive.reason;
    return payload;
  }

  return { read: read, tokyoDate: tokyoDate };
});
