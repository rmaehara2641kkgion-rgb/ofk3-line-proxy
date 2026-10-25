/**
 * PR #57 が書いた local/harvest-daily-archive を読むだけ。
 * 原本も保管ファイルも削除・移動・上書きしない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Rolling60hArchiveReader = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var crypto = require('crypto');
  var SHEET = 'Report5_Daily_Data';

  function readJson(fs, file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }

  function read(options) {
    options = options || {};
    var fs = options.fs;
    var pathMod = options.path;
    var xlsx = options.xlsx;
    var rolling = options.rolling;
    var root = options.root;
    var date = options.date;
    if (!fs || !pathMod || !xlsx || !rolling || !root || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return { ok: false, reason: 'not-archived', blocksByTransportId: {} };
    }
    var state = readJson(fs, pathMod.join(root, 'state.json'));
    if (!state || state.version !== 1 || !Array.isArray(state.revisions)) {
      return { ok: false, reason: 'not-archived', blocksByTransportId: {} };
    }
    var found = null;
    state.revisions.forEach(function (revision) {
      if (!revision || revision.filenameDate !== date || revision.maxDate !== date || !revision.contentHash) return;
      found = revision;
    });
    if (!found) return { ok: false, reason: 'not-archived', blocksByTransportId: {} };
    var filePath = pathMod.join(root, 'files', found.filenameDate, found.contentHash + '.xlsx');
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'not-archived', blocksByTransportId: {} };
    var hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (hash !== found.contentHash) return { ok: false, reason: 'hash-mismatch', blocksByTransportId: {} };
    var book = xlsx.readFile(filePath, { cellDates: true });
    var names = book.SheetNames || [];
    if (names.indexOf(SHEET) < 0) return { ok: false, reason: 'report5-missing', blocksByTransportId: {} };
    var rows = xlsx.utils.sheet_to_json(book.Sheets[SHEET], { header: 1, raw: true, defval: null });
    var parsed = rolling.parseAmazonDailyRows(rows, { stationFilter: 'OFK3' });
    var maxDate = '';
    (parsed.records || []).forEach(function (record) {
      if (record && record.date && record.date > maxDate) maxDate = record.date;
    });
    if (maxDate !== date) return { ok: false, reason: 'date-mismatch', blocksByTransportId: {} };
    return {
      ok: true,
      reason: 'archived',
      file: found.sourceName || '',
      blocksByTransportId: rolling.groupActualRecordsByTransportId(parsed.records)
    };
  }

  return { read: read };
});
