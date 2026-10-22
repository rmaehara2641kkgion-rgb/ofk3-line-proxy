/**
 * デイリー実績の自動保管。
 * 原本は読み取るだけとし、ローカル領域へコピーする。
 * ファイル名の日付と Report5 の最大稼働日が一致する当日分だけを保管する。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestDailyArchive = api;
})(this, function () {
  'use strict';

  var crypto = require('crypto');
  var DAILY_NAME = /^Daily_AMZL_JP_Working_Hour_(\d{4}-\d{2}-\d{2})_/i;
  var INTERVALS = { 5: true, 10: true, 15: true, 30: true, 60: true };
  var SHEET = 'Report5_Daily_Data';

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function baseName(name) {
    return String(name || '').split(/[/\\]/).pop();
  }

  function addDays(iso, days) {
    var parts = String(iso || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(function (part) { return !isFinite(part); })) return '';
    var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
  }

  function defaultSettings() {
    return { version: 1, hour: 8, minute: 0, intervalMinutes: 15 };
  }

  function emptyState() {
    return {
      version: 1,
      revisions: [],
      status: 'waiting',
      reason: 'idle',
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: '',
    };
  }

  function normalizeSettings(input) {
    var hour = Number(input && input.hour);
    var minute = Number(input && input.minute);
    var interval = Number(input && input.intervalMinutes);
    if (!isFinite(hour) || hour < 0 || hour > 23 || Math.floor(hour) !== hour) {
      return { ok: false, reason: 'invalid-hour' };
    }
    if (!isFinite(minute) || minute < 0 || minute > 59 || Math.floor(minute) !== minute) {
      return { ok: false, reason: 'invalid-minute' };
    }
    if (!INTERVALS[interval]) return { ok: false, reason: 'invalid-interval' };
    return {
      ok: true,
      settings: { version: 1, hour: hour, minute: minute, intervalMinutes: interval },
    };
  }

  function tokyoDate(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  }

  function tokyoHourMinute(date) {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    var hour = 0;
    var minute = 0;
    parts.forEach(function (part) {
      if (part.type === 'hour') hour = Number(part.value);
      if (part.type === 'minute') minute = Number(part.value);
    });
    if (hour === 24) hour = 0;
    return { hour: hour, minute: minute };
  }

  function filenameDate(name) {
    var matched = DAILY_NAME.exec(baseName(name));
    return matched ? matched[1] : '';
  }

  function readJson(fs, filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  function writeJson(fs, pathMod, filePath, value) {
    var dir = pathMod.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    var tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, filePath);
  }

  function hashFile(fs, filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  function datesOf(rows, rolling) {
    if (!rolling || typeof rolling.parseAmazonDailyRows !== 'function') return [];
    var parsed = rolling.parseAmazonDailyRows(rows, { stationFilter: 'OFK3', allowHeaderlessFallback: false });
    var seen = {};
    (parsed.records || []).forEach(function (record) {
      if (record && record.date) seen[record.date] = true;
    });
    return Object.keys(seen).sort();
  }

  function judge(fileDate, internalDates, targetDate) {
    if (!fileDate) return { ok: false, reason: 'not-daily-file' };
    if (fileDate !== targetDate) {
      return { ok: false, reason: fileDate > targetDate ? 'future-file' : 'other-day', waiting: true };
    }
    if (!internalDates.length || internalDates[internalDates.length - 1] !== fileDate || internalDates.indexOf(fileDate) < 0) {
      var maxDate = internalDates.length ? internalDates[internalDates.length - 1] : '';
      if (maxDate && maxDate === addDays(fileDate, 1)) return { ok: false, reason: 'next-day' };
      return { ok: false, reason: 'date-mismatch' };
    }
    return {
      ok: true,
      filenameDate: fileDate,
      minDate: internalDates[0],
      maxDate: internalDates[internalDates.length - 1],
    };
  }

  function create(options) {
    options = options || {};
    var fs = options.fs;
    var pathMod = options.path;
    var xlsx = options.xlsx;
    var rolling = options.rolling;
    var sourceDir = options.sourceDir || '';
    var root = options.root;
    var clock = typeof options.now === 'function' ? options.now : function () { return new Date(); };
    var settings = defaultSettings();
    var state = emptyState();
    var timer = null;
    var settingsFile = root && pathMod ? pathMod.join(root, 'settings.json') : '';
    var stateFile = root && pathMod ? pathMod.join(root, 'state.json') : '';

    function loadSettings() {
      var saved = normalizeSettings(readJson(fs, settingsFile));
      settings = saved.ok ? saved.settings : defaultSettings();
      return {
        hour: settings.hour,
        minute: settings.minute,
        intervalMinutes: settings.intervalMinutes,
      };
    }

    function loadState() {
      var saved = readJson(fs, stateFile);
      if (!saved || saved.version !== 1 || !Array.isArray(saved.revisions)) {
        state = emptyState();
        return;
      }
      state = saved;
    }

    function persistState() {
      if (!fs || !pathMod || !stateFile) return;
      writeJson(fs, pathMod, stateFile, state);
    }

    function publicState() {
      var latest = null;
      (state.revisions || []).forEach(function (revision) {
        if (revision && revision.maxDate === revision.filenameDate) latest = revision;
      });
      return {
        ok: true,
        settings: {
          hour: settings.hour,
          minute: settings.minute,
          intervalMinutes: settings.intervalMinutes,
        },
        status: state.status || 'waiting',
        reason: state.reason || 'idle',
        lastSuccessAt: state.lastSuccessAt || null,
        lastFailureAt: state.lastFailureAt || null,
        lastFailureReason: state.lastFailureReason || '',
        archivedDate: latest ? latest.filenameDate : null,
        revisionCount: (state.revisions || []).length,
      };
    }

    function saveSettings(input) {
      var normalized = normalizeSettings(input);
      if (!normalized.ok) return { ok: false, reason: normalized.reason, settings: publicState().settings };
      settings = normalized.settings;
      if (fs && pathMod && settingsFile) writeJson(fs, pathMod, settingsFile, settings);
      if (timer) start();
      return { ok: true, reason: 'saved', settings: publicState().settings };
    }

    function latestRevision(date) {
      var found = null;
      (state.revisions || []).forEach(function (revision) {
        if (!revision || revision.filenameDate !== date || revision.maxDate !== date) return;
        found = revision;
      });
      return found;
    }

    function remember(sourcePath, meta, contentHash) {
      var destDir = pathMod.join(root, 'files', meta.filenameDate);
      var dest = pathMod.join(destDir, contentHash + '.xlsx');
      fs.mkdirSync(destDir, { recursive: true });
      if (!fs.existsSync(dest)) fs.copyFileSync(sourcePath, dest);
      if (hashFile(fs, dest) !== contentHash) {
        try { fs.unlinkSync(dest); } catch (e) {}
        return false;
      }
      state.revisions.push({
        filenameDate: meta.filenameDate,
        sourceName: baseName(sourcePath),
        contentHash: contentHash,
        byteSize: fs.statSync(dest).size,
        archivedAt: clock().toISOString(),
        minDate: meta.minDate,
        maxDate: meta.maxDate,
      });
      state.status = 'ok';
      state.reason = 'archived';
      state.lastSuccessAt = clock().toISOString();
      persistState();
      return true;
    }

    function readReport(filePath) {
      var book = xlsx.readFile(filePath, { cellDates: true });
      var names = book.SheetNames || [];
      var sheet = '';
      for (var i = 0; i < names.length; i++) {
        if (names[i] === SHEET) sheet = names[i];
      }
      if (!sheet) return { ok: false, reason: 'report5-missing' };
      return {
        ok: true,
        sheet: sheet,
        rows: xlsx.utils.sheet_to_json(book.Sheets[sheet], { header: 1, raw: true, defval: null }),
      };
    }

    function fail(reason, now) {
      state.status = 'error';
      state.reason = reason;
      state.lastFailureAt = now.toISOString();
      state.lastFailureReason = reason;
      try { persistState(); } catch (e) {}
      return publicState();
    }

    function wait(reason) {
      state.status = 'waiting';
      state.reason = reason;
      try { persistState(); } catch (e) {}
      return publicState();
    }

    function tick() {
      try {
        var now = clock();
        var targetDate = tokyoDate(now);
        var hm = tokyoHourMinute(now);
        if (hm.hour < settings.hour || (hm.hour === settings.hour && hm.minute < settings.minute)) {
          return wait('before-time');
        }
        if (!sourceDir || !fs.existsSync(sourceDir)) return wait('file-absent');
        var names = fs.readdirSync(sourceDir).filter(function (name) {
          return filenameDate(name) && baseName(name).indexOf('~$') !== 0;
        });
        var eligible = names.filter(function (name) { return filenameDate(name) <= targetDate; });
        if (!eligible.length) return wait('file-absent');
        var latestDate = '';
        eligible.forEach(function (name) {
          var fileDate = filenameDate(name);
          if (fileDate > latestDate) latestDate = fileDate;
        });
        var chosen = eligible.filter(function (name) { return filenameDate(name) === latestDate; });
        if (chosen.length > 1) return fail('ambiguous-latest', now);
        var sourcePath = pathMod.join(sourceDir, chosen[0]);
        var report = readReport(sourcePath);
        if (!report.ok) return fail(report.reason || 'read-failed', now);
        var verdict = judge(latestDate, datesOf(report.rows, rolling), latestDate);
        if (!verdict.ok) return verdict.waiting ? wait(verdict.reason) : fail(verdict.reason, now);
        var contentHash = hashFile(fs, sourcePath);
        var current = latestRevision(latestDate);
        if (current && current.contentHash === contentHash) {
          state.status = 'ok';
          state.reason = 'unchanged';
          persistState();
          return publicState();
        }
        if (!remember(sourcePath, verdict, contentHash)) return fail('copy-failed', now);
        return publicState();
      } catch (e) {
        try { return fail('read-failed', clock()); } catch (e2) {
          return { ok: false, status: 'error', reason: 'read-failed' };
        }
      }
    }

    function rowsForDate(date) {
      try {
        var revision = latestRevision(date);
        if (!revision) return { ok: false, reason: 'not-archived' };
        var filePath = pathMod.join(root, 'files', revision.filenameDate, revision.contentHash + '.xlsx');
        var report = readReport(filePath);
        if (!report.ok) return report;
        var verdict = judge(date, datesOf(report.rows, rolling), date);
        if (!verdict.ok) return { ok: false, reason: verdict.reason };
        return {
          ok: true,
          file: revision.sourceName,
          sheet: report.sheet,
          rows: report.rows,
          date: date,
        };
      } catch (e) {
        return { ok: false, reason: 'read-failed' };
      }
    }

    function start() {
      stop();
      var delay = settings.intervalMinutes * 60 * 1000;
      timer = setInterval(function () {
        try { tick(); } catch (e) {}
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try { tick(); } catch (e2) {}
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    try { loadSettings(); } catch (e) { settings = defaultSettings(); }
    try { loadState(); } catch (e2) { state = emptyState(); }

    return {
      settings: function () {
        return { hour: settings.hour, minute: settings.minute, intervalMinutes: settings.intervalMinutes };
      },
      saveSettings: saveSettings,
      publicState: publicState,
      tick: tick,
      rowsForDate: rowsForDate,
      start: start,
      stop: stop,
    };
  }

  return {
    INTERVALS: [5, 10, 15, 30, 60],
    defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings,
    filenameDate: filenameDate,
    judge: judge,
    addDays: addDays,
    create: create,
  };
});
