/**
 * HARVEST rolling60h 一括実行。
 * 既存の harvest-daily-manifest / rolling60h-core / inoichi-rolling-dryrun だけを使う。
 * 返すのはファイル名と人数だけ。氏名・Transport ID・明細は含めない。
 * G: 上のファイルは読むだけで、書き込まない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarvestRolling60hRun = api;
})(this, function () {
  'use strict';

  var DAILY_DIR = 'G:\\マイドライブ\\マニフェスト';
  var SHIFT_DIR = 'G:\\マイドライブ\\大坪逝く19ファイル';
  var SHIFT_NAME = /DAシフト.*\.xlsx$/i;
  var ROSTER_SKIP = { '貼付': true, 'WH60': true, '点呼表': true, 'Export': true, 'システム': true, 'メイン': true };

  function baseName(name) {
    return String(name || '').split(/[/\\]/).pop();
  }

  function todayJst() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
    } catch (e) {
      return '1970-01-01';
    }
  }

  function emptySummary(extra) {
    var out = {
      ok: false,
      checkedAt: new Date().toISOString(),
      dailyFile: '',
      shiftFile: '',
      dailyReason: '',
      shiftReason: '',
      previousMonthShiftReason: '',
      fileSuccess: 0,
      fileFailure: 2,
      driverCount: 0,
      clearCount: 0,
      exceedCount: 0,
      approachCount: 0,
      partialCount: 0,
      partialExceedCount: 0,
      partialApproachCount: 0,
      partialKnownOverCount: 0,
      undeterminedCount: 0,
      unmatchedCount: 0,
      blankUnconfirmedPersonDays: 0,
      blankRestPersonDays: 0,
      shiftFiles: [],
      shiftMonths: [],
      shiftMissingMonths: [],
      shiftCoverageWarnings: [],
      shiftConflictDays: 0,
      otherStationCount: 0,
      partialOtherStationCount: 0,
      outsidePeriodDateCount: 0,
      outsidePeriodKeptByDailyDays: 0,
      knownOverWindows: 0,
      blankFilledWindows: 0,
      blankFilledPersons: 0,
      blankFilledToAlertWindows: 0,
      normalToExceedWindows: 0,
      normalToExceedBySchedule: 0,
      normalToExceedByDaily: 0,
      resolvedBySchedule: 0,
      resolvedByDaily: 0,
      resolvedByBoth: 0,
      resolvedCauseUnknown: 0,
      stillAlert: 0,
      verifyUndetermined: 0,
      resolvedWithFuture: 0,
      futureOpenWindows: 0,
      estimateCoveredWindows: 0,
      reusedArchiveDays: 0,
      historyRuns: 0,
      historyCreated: 0,
      historySaved: false,
      historyDuplicate: false,
      confirmedActual: false,
      logicVersion: 'rolling60h-predict-4',
      sent: false,
      channel: 'dry-run',
    };
    if (extra) Object.keys(extra).forEach(function (key) { out[key] = extra[key]; });
    return out;
  }

  function selectLatestShift(entries) {
    var matched = (entries || []).filter(function (entry) {
      return SHIFT_NAME.test(baseName(entry.name)) && baseName(entry.name).indexOf('~$') !== 0;
    });
    if (!matched.length) return { ok: false, reason: 'no-shift-file' };
    var max = null;
    matched.forEach(function (entry) {
      if (max == null || entry.mtimeMs > max) max = entry.mtimeMs;
    });
    var tops = matched.filter(function (entry) { return entry.mtimeMs === max; });
    if (tops.length > 1) return { ok: false, reason: 'ambiguous-shift' };
    return { ok: true, name: tops[0].name };
  }

  // 前月のシフトファイル。ファイル名に「N月」を含み、最新ファイルの月の前月（1月の前は12月）のもの。
  // 月が名前から分からない場合は探さない（推測しない）。複数あれば更新日時が新しいもの、同時刻なら選ばない。
  function monthOfName(name) {
    var m = /(\d{1,2})月/.exec(baseName(name));
    var n = m ? Number(m[1]) : 0;
    return n >= 1 && n <= 12 ? n : 0;
  }

  function selectPreviousMonthShift(entries, latestName) {
    var month = monthOfName(latestName);
    if (!month) return { ok: false, reason: 'month-unknown' };
    var prev = month === 1 ? 12 : month - 1;
    var matched = (entries || []).filter(function (entry) {
      var name = baseName(entry.name);
      return SHIFT_NAME.test(name) && name.indexOf('~$') !== 0 && name !== baseName(latestName) && monthOfName(name) === prev;
    });
    if (!matched.length) return { ok: false, reason: 'no-previous-month-file' };
    var max = matched.reduce(function (acc, entry) { return acc == null || entry.mtimeMs > acc ? entry.mtimeMs : acc; }, null);
    var tops = matched.filter(function (entry) { return entry.mtimeMs === max; });
    if (tops.length > 1) return { ok: false, reason: 'ambiguous-previous-month' };
    return { ok: true, name: tops[0].name };
  }

  function listShiftEntries(dir, fs, pathMod) {
    if (!dir || !fs.existsSync(dir)) return null;
    return fs.readdirSync(dir).map(function (name) {
      var full = pathMod.join(dir, name);
      var stat = null;
      try { stat = fs.statSync(full); } catch (e) { stat = null; }
      return { name: name, mtimeMs: stat ? stat.mtimeMs : 0 };
    });
  }

  /**
   * 読み込み済みのシフトブック（複数月）→ Transport ID別の {date: blocks[]}。
   * 解析は画面のRolling60hと同じ buildRosterTimelineFromSources を使う
   * （月またぎ: 助走列の除外・定数日番号見出しの復元・読込順に依存しないマージ）。
   * 同じ日付が複数ファイルにある場合の優先順位は mergeRosterBlocksByDateAcrossSourcesStrict に従う。
   *
   * @param {Array<{name:string, workbook:Object}>} books 同名は後のものを採用（再読込で重複計上しない）
   */
  function rosterBlocks(books, rolling, options) {
    options = options || {};
    var byName = {};
    var order = [];
    (books || []).forEach(function (book) {
      if (!book || !book.workbook) return;
      var key = book.name || 'shift';
      if (!byName[key]) order.push(key);
      byName[key] = book;
    });
    var sources = order.map(function (key) {
      var wb = byName[key].workbook;
      var sheetsData = {};
      (wb.SheetNames || []).forEach(function (sheetName) {
        if (ROSTER_SKIP[sheetName] || sheetName === 'Report5_Daily_Data') return;
        sheetsData[sheetName] = requireRows(wb, sheetName);
      });
      return { label: key, sheetsData: sheetsData };
    });
    var built = rolling.buildRosterTimelineFromSources(sources, {});
    var unmatched = {};
    var extraSymbolDates = {};
    var out = {};
    var names = {};
    Object.keys(built.rosterBlocksByDriver).forEach(function (key) {
      var meta = built.driverMeta[key] || {};
      var byDate = built.rosterBlocksByDriver[key] || {};
      if (!meta.transportId || key.indexOf('NAME:') === 0) {
        unmatched[key] = true;
        // 突合できない行でも、勤務記号が入っている日付列の証拠にはする。
        Object.keys(byDate).forEach(function (date) {
          if ((byDate[date] || []).length > 0) extraSymbolDates[date] = true;
        });
        return;
      }
      out[meta.transportId] = byDate;
      if (meta.name) names[meta.transportId] = meta.name;
    });
    var resolved = rolling.resolveRosterBlanks(out, { extraSymbolDates: extraSymbolDates, blankAsRest: options.blankAsRest !== false });
    return {
      byTid: resolved.byTid,
      names: names,
      unmatchedCount: Object.keys(unmatched).length,
      outsideDates: resolved.outsideDates,
      unconfirmedPersonDays: resolved.unconfirmedPersonDays,
      blankRestPersonDays: resolved.blankRestPersonDays,
      files: order,
      months: rolling.describeRosterMonths(built.sourceMonths),
      conflicts: built.conflicts || [],
    };
  }

  function requireRows(wb, sheetName) {
    var XLSX = requireRows.xlsx;
    return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
  }

  function dateSpan(maps) {
    var min = null;
    var max = null;
    maps.forEach(function (map) {
      Object.keys(map || {}).forEach(function (date) {
        if (!min || date < min) min = date;
        if (!max || date > max) max = date;
      });
    });
    return min && max ? { min: min, max: max } : null;
  }

  // 同じTransport IDの他局実績の日付（シリーズの期間内）。時間は合算も0扱いもしない。
  function otherDatesFor(item, span) {
    if (!item || !span) return null;
    var dates = Object.keys(item.dates).filter(function (date) { return date >= span.min && date <= span.max; }).sort();
    if (!dates.length) return null;
    return { dates: dates, stations: Object.keys(item.stations).sort() };
  }

  function windowGap(window) {
    return window.judgment === 'undetermined' || window.complete === false || window.hasUndefinedHours;
  }

  function classify(drivers, dryRun) {
    var dry = dryRun.fromDrivers(drivers);
    if (dry.sent !== false || dry.channel !== 'dry-run') {
      throw new Error('dry-run contract broken');
    }
    var clear = 0;
    var exceed = 0;
    var approach = 0;
    var partial = 0;
    var partialExceed = 0;
    var partialApproach = 0;
    var partialKnownOver = 0;
    var undetermined = 0;
    var otherStationCount = 0;
    var partialOtherStation = 0;
    (drivers || []).forEach(function (driver) {
      var windows = driver.windows || [];
      var hasExceed = windows.some(function (window) { return window.judgment === 'exceed'; });
      var hasApproach = windows.some(function (window) { return window.judgment === 'approach'; });
      var hasWithin = windows.some(function (window) { return window.judgment === 'within'; });
      var hasKnownOver = windows.some(function (window) { return window.knownOver; });
      var hasGap = windows.length === 0 || driver.judgment === 'undetermined' || windows.some(windowGap);
      var hasOther = !!(driver.otherStation && driver.otherStation.dates && driver.otherStation.dates.length);
      if (hasOther) otherStationCount++;
      // 確定済みの時間だけで60時間超の窓がある人は、完全判定不能にせず部分欠損として危険内訳を残す。
      if (hasGap && (hasExceed || hasApproach || hasWithin || hasKnownOver)) {
        partial++;
        if (hasKnownOver) partialKnownOver++;
        if (hasExceed) partialExceed++;
        else if (hasApproach) partialApproach++;
        return;
      }
      if (hasGap || (!hasExceed && !hasApproach && !hasWithin)) {
        undetermined++;
        return;
      }
      if (hasExceed) exceed++;
      else if (hasApproach) approach++;
      else if (hasOther) {
        // 他局の実績が同じTransport IDにある。OFK3の実績だけで「正常」とは言えないので要確認（部分扱い）。
        partial++;
        partialOtherStation++;
      } else clear++;
    });
    if (clear + exceed + approach + partial + undetermined !== (drivers || []).length) {
      throw new Error('classification is not exclusive');
    }
    return {
      driverCount: (drivers || []).length,
      partialKnownOverCount: partialKnownOver,
      otherStationCount: otherStationCount,
      partialOtherStationCount: partialOtherStation,
      clearCount: clear,
      exceedCount: exceed,
      approachCount: approach,
      partialCount: partial,
      partialExceedCount: partialExceed,
      partialApproachCount: partialApproach,
      undeterminedCount: undetermined,
    };
  }

  function archiveBlock(hours) {
    return [{
      code: 'AMAZON_ESTIMATE',
      rawCode: '(archived estimated_working_hour)',
      source: 'actual',
      hours: hours,
      defined: true,
      hoursKind: 'estimated_working_hour',
      archived: true,
    }];
  }

  function daySnapshot(day, referenceDate) {
    if (!day || day.noData) {
      return { date: day ? day.date : '', hours: null, origin: 'missing', future: false };
    }
    if (day.hasUndefinedHours) {
      return { date: day.date, hours: null, origin: 'undefined', future: false };
    }
    if (day.hasUnconfirmed) {
      return { date: day.date, hours: null, origin: 'roster-unconfirmed', future: day.date >= referenceDate };
    }
    var blocks = day.blocks || [];
    var archived = blocks.some(function (block) { return block && block.archived; });
    var source = blocks[0] && blocks[0].source;
    var origin = archived ? 'archived-daily' : (source === 'roster' ? 'roster-plan' : 'daily-estimate');
    var snap = {
      date: day.date,
      hours: day.dailyTotalHours,
      origin: origin,
      future: origin === 'roster-plan' && day.date >= referenceDate,
    };
    // シフト表の空白＝休み(0h)として確定した日（実績で置き換わった日は対象外）。
    if (origin === 'roster-plan' && blocks.length && blocks.every(function (block) { return block && block.blankRest; })) snap.rest = 'blank';
    return snap;
  }

  function snapshotDateOf(rows, rolling) {
    if (!rows || !rows.length || !rolling || typeof rolling.parseExcelDateFlexible !== 'function') return '';
    var header = rows[0] || [];
    var column = -1;
    for (var i = 0; i < header.length; i++) {
      if (String(header[i] || '').toLowerCase().trim() === 'snapshot_date') column = i;
    }
    if (column < 0) return '';
    var seen = {};
    for (var rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      var raw = rows[rowIndex] && rows[rowIndex][column];
      if (raw == null || raw === '') continue;
      var iso = rolling.parseExcelDateFlexible(raw);
      if (iso) seen[iso] = true;
    }
    var values = Object.keys(seen).sort();
    return values.length === 1 ? values[0] : '';
  }

  function blockHours(blocks) {
    if (!blocks) return null;
    var total = 0;
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (!block || block.defined === false || typeof block.hours !== 'number') return null;
      total += block.hours;
    }
    return total;
  }

  function execute(options) {
    options = options || {};
    var fs = options.fs;
    var pathMod = options.path;
    var XLSX = options.xlsx;
    var rolling = options.rolling;
    var harvest = options.harvest;
    var dryRun = options.dryRun;
    // OFK3画面など、読み込み済みのブックを直接渡す場合（ファイル探索・履歴保存は行わない）。
    var injectedBooks = options.shiftBooks && options.shiftBooks.length ? options.shiftBooks : null;
    var injected = options.dailyRows !== undefined || options.shiftBook !== undefined || options.shiftBooks !== undefined;
    if ((!injected && (!fs || !pathMod)) || !XLSX || !rolling || !harvest || !dryRun) {
      return { summary: emptySummary({ reason: 'runner-missing' }), stats: null };
    }
    requireRows.xlsx = XLSX;

    var dailyDir = options.dailyDir || DAILY_DIR;
    var shiftDir = options.shiftDir || SHIFT_DIR;
    var dailyFile = '';
    var shiftFile = '';
    var fileSuccess = 0;
    var dailyRows = null;
    var shiftBooks = [];
    var previousMonthReason = '';
    var previousMonthFile = '';

    // 失敗理由はコードだけを残す（パス・氏名は含めない）。
    var dailyReason = '';
    var shiftReason = '';
    if (injected) {
      if (options.dailyRows && options.dailyRows.length) {
        fileSuccess++;
        dailyFile = baseName(options.dailyFileName);
        dailyRows = options.dailyRows;
        dailyReason = 'ok';
      } else {
        dailyReason = 'not-provided';
      }
      if (injectedBooks) {
        // 複数月のシフト表を同時に受け取る。同名は後勝ち（再読込）。
        injectedBooks.forEach(function (book) {
          if (book && book.workbook) shiftBooks.push({ name: baseName(book.name), workbook: book.workbook });
        });
      } else if (options.shiftBook) {
        shiftBooks.push({ name: baseName(options.shiftFileName), workbook: options.shiftBook });
      }
      if (shiftBooks.length) {
        fileSuccess++;
        shiftFile = shiftBooks.map(function (book) { return book.name; }).join(' + ');
        shiftReason = 'ok';
      } else {
        shiftReason = 'not-provided';
      }
    } else {
      var loadedDaily = null;
      try {
        loadedDaily = harvest.loadFromDirectory(dailyDir, { fs: fs, path: pathMod, xlsx: XLSX, rolling: rolling });
      } catch (dailyErr) {
        loadedDaily = { ok: false, reason: 'read-failed' };
      }
      if (loadedDaily && loadedDaily.ok && loadedDaily.sheet === 'Report5_Daily_Data') {
        fileSuccess++;
        dailyFile = baseName(loadedDaily.file);
        dailyRows = loadedDaily.rows;
        dailyReason = 'ok';
      } else {
        dailyReason = (loadedDaily && loadedDaily.reason) || 'report5-missing';
      }
      var shiftEntries = null;
      try { shiftEntries = listShiftEntries(shiftDir, fs, pathMod); } catch (listErr) { shiftEntries = null; shiftReason = 'read-failed'; }
      var pickedShift = shiftEntries ? selectLatestShift(shiftEntries) : { ok: false, reason: shiftReason || 'source-unavailable' };
      if (pickedShift.ok) {
        try {
          shiftBooks.push({ name: baseName(pickedShift.name), workbook: XLSX.readFile(pathMod.join(shiftDir, baseName(pickedShift.name)), { cellDates: true }) });
          fileSuccess++;
          // 月またぎの判定には前月のシフトが要る。見つからない・読めない場合は黙って進めず理由を残す（最新だけで続行）。
          var prevPick = selectPreviousMonthShift(shiftEntries, pickedShift.name);
          if (prevPick.ok) {
            try {
              shiftBooks.unshift({ name: baseName(prevPick.name), workbook: XLSX.readFile(pathMod.join(shiftDir, baseName(prevPick.name)), { cellDates: true }) });
              previousMonthReason = 'ok';
              previousMonthFile = baseName(prevPick.name);
            } catch (prevErr) {
              previousMonthReason = 'read-failed';
            }
          } else {
            previousMonthReason = prevPick.reason;
          }
          shiftFile = baseName(pickedShift.name);
          shiftReason = 'ok';
        } catch (e) {
          shiftBooks = [];
          shiftReason = 'read-failed';
        }
      } else {
        shiftReason = pickedShift.reason || 'source-unavailable';
      }
    }

    var parsed = dailyRows ? rolling.parseAmazonDailyRows(dailyRows, { stationFilter: 'OFK3', allowHeaderlessFallback: false }) : { records: [] };
    var actualByTid = harvest.recordedDailyBlocks(parsed.records || []);
    var roster = shiftBooks.length ? rosterBlocks(shiftBooks, rolling, { blankAsRest: options.blankAsRest }) : { byTid: {}, unmatchedCount: 0, files: [], months: [] };
    var otherByTid = {};
    (parsed.otherStation || []).forEach(function (rec) {
      var item = otherByTid[rec.transportId] = otherByTid[rec.transportId] || { dates: {}, stations: {} };
      item.dates[rec.date] = true;
      item.stations[rec.station] = true;
    });
    var rosterByTid = roster.byTid || {};
    var tids = {};
    Object.keys(actualByTid).forEach(function (tid) { tids[tid] = true; });
    Object.keys(rosterByTid).forEach(function (tid) { tids[tid] = true; });

    var referenceDate = options.referenceDate || todayJst();
    // 基準日の7日窓に必要な月のシフト表が読み込まれているか。足りなければ警告（該当日は未取得のまま＝判定不能）。
    var coverage = shiftBooks.length ? rolling.checkRosterCoverage(roster.months || [], referenceDate) : { missing: [], warnings: [] };
    var dayValues = (parsed.records || []).map(function (rec) { return rec.date; }).filter(Boolean).sort();
    var coverageMin = dayValues[0] || '';
    var coverageMax = dayValues.length ? dayValues[dayValues.length - 1] : '';
    var historyFile = options.historyFile;
    if (injected && historyFile == null) historyFile = false;
    if (historyFile == null && typeof __dirname === 'string') {
      historyFile = pathMod.join(__dirname, 'local', 'rolling60h-history.json');
    }
    var persistHistory = !!historyFile;
    var History = null;
    var archive = {};
    if (persistHistory) {
      try { History = require('./harvest-rolling60h-history.js'); } catch (e) { History = null; }
      if (History) {
        var loadedHistory = History.load(fs, historyFile);
        if (loadedHistory && !loadedHistory.corrupt) archive = loadedHistory.dailyArchive || {};
      }
    }
    var drivers = [];
    var predictions = [];
    var observations = [];
    var futureOpenWindows = 0;
    var estimateCoveredWindows = 0;
    var reusedArchiveDays = 0;
    var overlapPersonDays = 0;
    var overlapKeptDaily = 0;
    var overlapSummed = 0;
    var futureRosterPersonDays = 0;
    var partialNoData = 0;
    var partialUndefined = 0;
    var partialUnknownSymbol = 0;
    var partialDuplicateHours = 0;
    var partialInvalidDaily = 0;
    var unknownSymbolDays = 0;
    var duplicateHourDays = 0;
    var invalidDailyDays = 0;
    var windowWithin = 0;
    var windowApproach = 0;
    var windowExceed = 0;
    var windowUndetermined = 0;
    var knownOverWindows = 0;
    var outsideSet = {};
    (roster.outsideDates || []).forEach(function (date) { outsideSet[date] = true; });
    var outsideKeptByDaily = 0;
    Object.keys(actualByTid).forEach(function (tid) {
      Object.keys(actualByTid[tid] || {}).forEach(function (date) {
        var hours = blockHours(actualByTid[tid][date]);
        if (hours == null) return;
        observations.push({ subjectId: tid, date: date, hours: hours });
      });
    });
    Object.keys(tids).forEach(function (tid) {
      var sourceActual = actualByTid[tid] || {};
      var sourcePlanned = rosterByTid[tid] || {};
      var actual = {};
      var planned = {};
      Object.keys(sourceActual).forEach(function (date) { actual[date] = sourceActual[date]; });
      Object.keys(sourcePlanned).forEach(function (date) { planned[date] = sourcePlanned[date]; });
      if (coverageMin) {
        Object.keys(archive).forEach(function (key) {
          var parts = key.split('\t');
          if (parts[0] !== tid || !parts[1] || parts[1] >= coverageMin || actual[parts[1]]) return;
          var entry = archive[key];
          if (!entry || entry.conflict || typeof entry.hours !== 'number') return;
          actual[parts[1]] = archiveBlock(entry.hours);
          reusedArchiveDays++;
        });
      }
      Object.keys(outsideSet).forEach(function (date) {
        if (blockHours(actual[date]) != null) outsideKeptByDaily++;
      });
      var span = dateSpan([actual, planned]);
      if (!span) return;
      var blended = rolling.mergeActualAndRoster(actual, planned, referenceDate);
      Object.keys(actual).forEach(function (date) {
        if (!planned[date]) return;
        overlapPersonDays++;
        var actualHours = blockHours(actual[date]);
        var plannedHours = blockHours(planned[date]);
        var mergedHours = blockHours(blended[date]);
        if (date < referenceDate && mergedHours != null && actualHours != null && mergedHours === actualHours) overlapKeptDaily++;
        if (actualHours != null && plannedHours != null && mergedHours != null && plannedHours !== 0 && Math.abs(mergedHours - (actualHours + plannedHours)) < 1e-6) {
          overlapSummed++;
        }
      });
      Object.keys(planned).forEach(function (date) {
        if (date >= referenceDate && blended[date] === planned[date]) futureRosterPersonDays++;
      });
      var series = rolling.buildContinuousDailySeries(blended, span.min, span.max);
      var windows = series.length >= 7 ? rolling.computeRolling60h(series, { limitHours: 60, warningHours: 60 }) : [];
      var sawNoData = false;
      var sawUndefined = false;
      var personUnknown = false;
      var personDuplicate = false;
      var personInvalidDaily = false;
      Object.keys(actual).forEach(function (date) {
        (actual[date] || []).forEach(function (block) {
          if (block && block.defined === false) {
            invalidDailyDays++;
            personInvalidDaily = true;
          }
        });
      });
      Object.keys(planned).forEach(function (date) {
        (planned[date] || []).forEach(function (block) {
          if (!block || block.defined !== false || block.blank) return;
          if (block.rawCode === 'duplicate' || block.conflict) {
            duplicateHourDays++;
            personDuplicate = true;
          } else {
            unknownSymbolDays++;
            personUnknown = true;
          }
        });
      });
      var dayByDate = {};
      series.forEach(function (day) { dayByDate[day.date] = daySnapshot(day, referenceDate); });
      windows.forEach(function (window) {
        if (window.judgment === 'within') windowWithin++;
        else if (window.judgment === 'approach') windowApproach++;
        else if (window.judgment === 'exceed') windowExceed++;
        else windowUndetermined++;
        if (window.knownOver) knownOverWindows++;
        if (window.noDataDates && window.noDataDates.length) sawNoData = true;
        if (window.undefinedDates && window.undefinedDates.length) sawUndefined = true;
        var windowDays = [];
        var cursor = window.startDate;
        for (var step = 0; step < 7; step++) {
          windowDays.push(dayByDate[cursor] || { date: cursor, hours: null, origin: 'missing', future: false });
          cursor = rolling.addDays(cursor, 1);
        }
        var hasFuture = windowDays.some(function (day) { return day.future; });
        var covered = windowDays.every(function (day) {
          return day.origin === 'daily-estimate' || day.origin === 'archived-daily';
        });
        if (hasFuture) futureOpenWindows++;
        if (covered) estimateCoveredWindows++;
        predictions.push({
          subjectId: tid,
          start: window.startDate,
          end: window.endDate,
          predictedTotal: window.totalHours,
          level: window.judgment,
          knownOver: !!window.knownOver,
          knownOverBy: window.knownOverBy || 0,
          unconfirmedDates: window.unconfirmedDates || [],
          future: hasFuture,
          days: windowDays,
        });
      });
      var hasExceed = windows.some(function (window) { return window.judgment === 'exceed'; });
      var hasApproach = windows.some(function (window) { return window.judgment === 'approach'; });
      var hasWithin = windows.some(function (window) { return window.judgment === 'within'; });
      var hasGap = windows.length === 0 || windows.some(windowGap);
      if (hasGap && (hasExceed || hasApproach || hasWithin)) {
        if (sawNoData) partialNoData++;
        if (sawUndefined) partialUndefined++;
        if (personUnknown) partialUnknownSymbol++;
        if (personDuplicate) partialDuplicateHours++;
        if (personInvalidDaily) partialInvalidDaily++;
      }
      drivers.push({
        transportId: tid,
        hoursKind: 'estimated_working_hour',
        judgment: series.length >= 7 ? 'evaluated' : 'undetermined',
        windows: windows,
        otherStation: otherDatesFor(otherByTid[tid], span),
      });
    });

    var counts = classify(drivers, dryRun);
    var summary = {
      ok: fileSuccess > 0,
      checkedAt: new Date().toISOString(),
      dailyFile: dailyFile,
      shiftFile: shiftFile,
      dailyReason: dailyReason,
      shiftReason: shiftReason,
      previousMonthShiftReason: previousMonthReason,
      fileSuccess: fileSuccess,
      fileFailure: 2 - fileSuccess,
      driverCount: counts.driverCount,
      exceedCount: counts.exceedCount,
      approachCount: counts.approachCount,
      undeterminedCount: counts.undeterminedCount,
      clearCount: counts.clearCount,
      partialCount: counts.partialCount,
      partialExceedCount: counts.partialExceedCount,
      partialApproachCount: counts.partialApproachCount,
      partialKnownOverCount: counts.partialKnownOverCount,
      unmatchedCount: roster.unmatchedCount || 0,
      blankUnconfirmedPersonDays: roster.unconfirmedPersonDays || 0,
      blankRestPersonDays: roster.blankRestPersonDays || 0,
      shiftFiles: roster.files || [],
      shiftMonths: roster.months || [],
      shiftMissingMonths: coverage.missing,
      shiftCoverageWarnings: coverage.warnings,
      shiftConflictDays: (roster.conflicts || []).length,
      otherStationCount: counts.otherStationCount,
      partialOtherStationCount: counts.partialOtherStationCount,
      outsidePeriodDateCount: (roster.outsideDates || []).length,
      outsidePeriodKeptByDailyDays: outsideKeptByDaily,
      knownOverWindows: knownOverWindows,
      blankFilledWindows: 0,
      blankFilledPersons: 0,
      blankFilledToAlertWindows: 0,
      normalToExceedWindows: 0,
      normalToExceedBySchedule: 0,
      normalToExceedByDaily: 0,
      resolvedBySchedule: 0,
      resolvedByDaily: 0,
      resolvedByBoth: 0,
      resolvedCauseUnknown: 0,
      stillAlert: 0,
      verifyUndetermined: 0,
      resolvedWithFuture: 0,
      futureOpenWindows: futureOpenWindows,
      estimateCoveredWindows: estimateCoveredWindows,
      reusedArchiveDays: reusedArchiveDays,
      historyRuns: 0,
      historyCreated: 0,
      historySaved: false,
      historyDuplicate: false,
      confirmedActual: false,
      logicVersion: 'rolling60h-predict-4',
      sent: false,
      channel: 'dry-run',
    };
    if (persistHistory && History) {
      var dailyFull = dailyFile ? pathMod.join(dailyDir, dailyFile) : '';
      var shiftFull = shiftFile ? pathMod.join(shiftDir, shiftFile) : '';
      var verdict = History.commit({
        fs: fs,
        path: pathMod,
        file: historyFile,
        logicId: History.logicIdentity(rolling.SHIFT_HOUR_TABLE),
        logicVersion: History.RULE_VERSION,
        referenceDate: referenceDate,
        dailyHash: dailyFull ? History.hashFile(fs, dailyFull) : '',
        shiftHash: (shiftFull ? History.hashFile(fs, shiftFull) : '') + (previousMonthFile ? '+' + History.hashFile(fs, pathMod.join(shiftDir, previousMonthFile)) : ''),
        dailyFile: dailyFile,
        shiftFile: shiftFile,
        snapshotDate: snapshotDateOf(dailyRows, rolling),
        workingDayMin: coverageMin,
        workingDayMax: coverageMax,
        predictedAt: summary.checkedAt,
        predictions: predictions,
        observations: observations,
      });
      Object.keys(verdict).forEach(function (key) { summary[key] = verdict[key]; });
    }
    return {
      summary: summary,
      drivers: drivers,
      predictions: predictions,
      historyFile: historyFile,
      stats: {
        referenceDate: referenceDate,
        overlapPersonDays: overlapPersonDays,
        overlapKeptDaily: overlapKeptDaily,
        overlapSummed: overlapSummed,
        futureRosterPersonDays: futureRosterPersonDays,
        partialNoData: partialNoData,
        partialUndefined: partialUndefined,
        partialUnknownSymbol: partialUnknownSymbol,
        partialDuplicateHours: partialDuplicateHours,
        partialInvalidDaily: partialInvalidDaily,
        unknownSymbolDays: unknownSymbolDays,
        duplicateHourDays: duplicateHourDays,
        invalidDailyDays: invalidDailyDays,
        windowWithin: windowWithin,
        windowApproach: windowApproach,
        windowExceed: windowExceed,
        windowUndetermined: windowUndetermined,
        ofk3Rows: (parsed.records || []).length,
        workingDayMin: dayValues[0] || '',
        workingDayMax: dayValues[dayValues.length - 1] || '',
        distinctWorkingDays: dayValues.filter(function (date, index) { return dayValues.indexOf(date) === index; }).length,
      },
    };
  }

  function run(options) {
    return execute(options).summary;
  }

  function capture(options) {
    var executed = execute(options);
    return {
      summary: executed.summary,
      drivers: executed.drivers || [],
      predictions: executed.predictions || [],
      historyFile: executed.historyFile,
    };
  }

  function audit(options) {
    var copy = {};
    Object.keys(options || {}).forEach(function (key) { copy[key] = options[key]; });
    copy.historyFile = false;
    return execute(copy).stats;
  }

  function loadRoster(options) {
    options = options || {};
    var fs = options.fs;
    var pathMod = options.path;
    var XLSX = options.xlsx;
    var rolling = options.rolling;
    var shiftDir = options.shiftDir || SHIFT_DIR;
    if (!fs || !pathMod || !XLSX || !rolling) return { ok: false, reason: 'reader-missing', byTid: {}, dates: [] };
    requireRows.xlsx = XLSX;
    var entries = listShiftEntries(shiftDir, fs, pathMod);
    if (!entries) return { ok: false, reason: 'shift-missing', byTid: {}, dates: [] };
    var picked = selectLatestShift(entries);
    if (!picked.ok) {
      return { ok: false, reason: picked.reason === 'no-shift-file' ? 'shift-missing' : picked.reason, byTid: {}, dates: [] };
    }
    var books = [{ name: baseName(picked.name), workbook: XLSX.readFile(pathMod.join(shiftDir, baseName(picked.name)), { cellDates: true }) }];
    var prevPick = selectPreviousMonthShift(entries, picked.name);
    if (prevPick.ok) {
      try { books.unshift({ name: baseName(prevPick.name), workbook: XLSX.readFile(pathMod.join(shiftDir, baseName(prevPick.name)), { cellDates: true }) }); } catch (e) { /* 最新だけで続行 */ }
    }
    var roster = rosterBlocks(books, rolling);
    var dates = {};
    Object.keys(roster.byTid || {}).forEach(function (transportId) {
      Object.keys(roster.byTid[transportId] || {}).forEach(function (date) { dates[date] = true; });
    });
    var list = Object.keys(dates).sort();
    return {
      ok: true,
      reason: 'roster',
      file: baseName(picked.name),
      byTid: roster.byTid,
      names: roster.names || {},
      min: list[0] || '',
      max: list[list.length - 1] || '',
      dates: list,
    };
  }

  return {
    DAILY_DIR: DAILY_DIR,
    SHIFT_DIR: SHIFT_DIR,
    selectLatestShift: selectLatestShift,
    selectPreviousMonthShift: selectPreviousMonthShift,
    loadRoster: loadRoster,
    ROSTER_SKIP: ROSTER_SKIP,
    run: run,
    capture: capture,
    audit: audit,
    emptySummary: emptySummary,
  };
});
