/**
 * HARVEST — マニフェストフォルダの Amazon デイリーを正とする。
 * Report5_Daily_Data の estimated_working_hour だけを読む。
 * シフトブックの「貼付」は旧方式のため選ばない。Drive 原本は変更しない。
 * ディレクトリが無い、最新ファイルが特定できない、7日が揃わない場合は判定不能。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestDailyManifest = api;
})(this, function () {
  'use strict';

  var DAILY_NAME = /^Daily_AMZL_JP_Working_Hour_(\d{4}-\d{2}-\d{2})_/i;

  function baseName(name) {
    return String(name || '').split(/[/\\]/).pop();
  }

  function selectLatestDailyName(names) {
    var dated = [];
    (names || []).forEach(function (name) {
      var m = DAILY_NAME.exec(baseName(name));
      if (!m) return;
      dated.push({ name: name, date: m[1] });
    });
    if (!dated.length) {
      return { ok: false, reason: 'no-daily-file', judgment: 'undetermined', status: 'awaiting-data' };
    }
    var byDate = {};
    dated.forEach(function (item) {
      if (!byDate[item.date]) byDate[item.date] = [];
      byDate[item.date].push(item.name);
    });
    var max = dated.map(function (item) { return item.date; }).sort().pop();
    if (byDate[max].length > 1) {
      return { ok: false, reason: 'ambiguous-latest', date: max, judgment: 'undetermined', status: 'awaiting-data' };
    }
    return { ok: true, name: byDate[max][0], date: max };
  }

  function unavailable(reason, extra) {
    var out = { ok: false, reason: reason, judgment: 'undetermined', status: 'awaiting-data', hoursKind: 'estimated_working_hour' };
    if (extra) {
      Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    }
    return out;
  }

  function loadFromDirectory(dir, deps) {
    deps = deps || {};
    var fs = deps.fs;
    var pathMod = deps.path;
    var XLSX = deps.xlsx;
    if (!fs || !pathMod || !XLSX) return unavailable('reader-missing');
    if (!dir || typeof fs.existsSync !== 'function' || !fs.existsSync(dir)) {
      return unavailable('source-unavailable');
    }
    var names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      return unavailable('source-unavailable');
    }
    var picked = selectLatestDailyName(names);
    if (!picked.ok) return picked;
    var full = pathMod.join(dir, baseName(picked.name));
    var wb = XLSX.readFile(full, { cellDates: true });
    var sheetNames = wb.SheetNames || [];
    var rolling = deps.rolling;
    var sheet = rolling && rolling.pickReport5Sheet ? rolling.pickReport5Sheet(sheetNames) : null;
    if (!sheet) {
      for (var i = 0; i < sheetNames.length; i++) {
        if (sheetNames[i] === 'Report5_Daily_Data') sheet = sheetNames[i];
      }
    }
    if (!sheet) {
      return unavailable('report5-missing', {
        file: baseName(full),
        pasteIgnored: sheetNames.indexOf('貼付') !== -1,
      });
    }
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: null });
    return {
      ok: true,
      status: 'ok',
      file: baseName(full),
      sheet: sheet,
      date: picked.date,
      rows: rows,
      hoursKind: 'estimated_working_hour',
      pasteIgnored: sheetNames.indexOf('貼付') !== -1,
    };
  }

  function addDays(rolling, iso, n) {
    if (rolling && rolling.addDays) return rolling.addDays(iso, n);
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    function pad(v) { return v < 10 ? '0' + v : String(v); }
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function eachDate(rolling, start, end, visit) {
    var cursor = start;
    var guard = 0;
    while (cursor && guard < 4000) {
      visit(cursor);
      if (cursor === end) return;
      cursor = addDays(rolling, cursor, 1);
      guard++;
    }
  }

  function estimateBlock(hours, defined) {
    return {
      code: 'AMAZON_ESTIMATE',
      rawCode: '(estimated_working_hour)',
      source: 'actual',
      hours: defined ? hours : null,
      defined: !!defined,
      hoursKind: 'estimated_working_hour',
    };
  }

  function blocksForDailyList(list) {
    var defined = (list || []).filter(function (rec) { return rec.hoursOk && typeof rec.hours === 'number'; });
    var conflict = defined.length !== list.length;
    if (!conflict && defined.length > 1) {
      for (var i = 1; i < defined.length; i++) {
        if (defined[i].hours !== defined[0].hours) conflict = true;
      }
    }
    if (conflict || !defined.length) return [estimateBlock(null, false)];
    return [estimateBlock(defined[0].hours, true)];
  }

  function recordedDailyBlocks(records) {
    var byTid = {};
    (records || []).forEach(function (rec) {
      if (!rec || !rec.transportId || !rec.date) return;
      if (!byTid[rec.transportId]) byTid[rec.transportId] = {};
      if (!byTid[rec.transportId][rec.date]) byTid[rec.transportId][rec.date] = [];
      byTid[rec.transportId][rec.date].push(rec);
    });
    var out = {};
    Object.keys(byTid).forEach(function (tid) {
      out[tid] = {};
      Object.keys(byTid[tid]).forEach(function (date) {
        out[tid][date] = blocksForDailyList(byTid[tid][date]);
      });
    });
    return out;
  }

  function evaluateRows(rows, rolling, options) {
    options = options || {};
    if (!rolling || typeof rolling.parseAmazonDailyRows !== 'function' || typeof rolling.computeRolling60h !== 'function') {
      return unavailable('rolling-missing');
    }
    var parsed = rolling.parseAmazonDailyRows(rows, {
      stationFilter: options.stationFilter === undefined ? 'OFK3' : options.stationFilter,
      allowHeaderlessFallback: false,
    });
    if (!parsed.records || !parsed.records.length) {
      return unavailable('no-rows', { warnings: parsed.warnings || [] });
    }
    var min = null;
    var max = null;
    parsed.records.forEach(function (rec) {
      if (!min || rec.date < min) min = rec.date;
      if (!max || rec.date > max) max = rec.date;
    });
    var duplicateDays = [];
    var recorded = recordedDailyBlocks(parsed.records);
    var drivers = [];
    Object.keys(recorded).forEach(function (tid) {
      var blocksByDate = {};
      eachDate(rolling, min, max, function (iso) {
        if (!recorded[tid][iso]) {
          blocksByDate[iso] = [];
          return;
        }
        blocksByDate[iso] = recorded[tid][iso];
        if (recorded[tid][iso].some(function (block) { return !block.defined; })) {
          duplicateDays.push({ transportId: tid, date: iso });
        }
      });
      var series = rolling.buildContinuousDailySeries(blocksByDate, min, max);
      var windows = series.length >= 7
        ? rolling.computeRolling60h(series, {
          limitHours: options.limitHours != null ? options.limitHours : 60,
          warningHours: options.warningHours != null ? options.warningHours : 60,
        })
        : [];
      drivers.push({
        transportId: tid,
        hoursKind: 'estimated_working_hour',
        coverage: { start: min, end: max },
        judgment: series.length >= 7 ? 'evaluated' : 'undetermined',
        windows: windows,
      });
    });

    return {
      ok: true,
      status: 'ok',
      judgment: 'evaluated',
      hoursKind: 'estimated_working_hour',
      coverage: { start: min, end: max },
      drivers: drivers,
      duplicateDays: duplicateDays,
      warnings: parsed.warnings || [],
    };
  }

  function loadAndEvaluate(dir, deps, options) {
    var loaded = loadFromDirectory(dir, deps);
    if (!loaded.ok) return loaded;
    var evaluated = evaluateRows(loaded.rows, deps.rolling, options);
    evaluated.file = loaded.file;
    evaluated.sheet = loaded.sheet;
    evaluated.fileDate = loaded.date;
    evaluated.pasteIgnored = loaded.pasteIgnored;
    return evaluated;
  }

  return {
    selectLatestDailyName: selectLatestDailyName,
    loadFromDirectory: loadFromDirectory,
    recordedDailyBlocks: recordedDailyBlocks,
    evaluateRows: evaluateRows,
    loadAndEvaluate: loadAndEvaluate,
  };
});
