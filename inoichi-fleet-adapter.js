(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InoichiFleetAdapter = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INPUT_TYPE = 'fleet-capacity-canonical';

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && !isNaN(v); }
  function isStr(v) { return typeof v === 'string'; }
  function isDateStr(v) { return isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v); }

  function parseHours(v) {
    if (isNum(v)) return v;
    if (isStr(v)) {
      var n = parseFloat(v);
      return isNaN(n) ? NaN : n;
    }
    return NaN;
  }

  function parseCount(v) {
    if (isNum(v)) return v;
    if (isStr(v)) {
      var n = parseFloat(v);
      return isNaN(n) ? NaN : n;
    }
    return NaN;
  }

  function emptyDiagnostics() {
    return {
      inputMasterCount: 0,
      inputDateCount: 0,
      canonicalCount: 0,
      skippedCount: 0,
      missingDates: [],
      missingBlocks: [],
      missingHours: [],
      missingActuals: [],
      duplicates: [],
      invalidEntries: []
    };
  }

  function recordInvalid(diagnostics, entry, reason, context) {
    diagnostics.invalidEntries.push({
      entry: entry,
      reason: reason,
      context: context || null
    });
    diagnostics.skippedCount += 1;
  }

  function normalizeFleetMaster(master) {
    var out = {
      entries: [],
      byHours: {},
      hoursToBlock: {},
      diagnostics: emptyDiagnostics()
    };
    if (master === undefined || master === null) {
      return out;
    }
    if (!Array.isArray(master)) {
      recordInvalid(out.diagnostics, master, 'master-not-array', null);
      return out;
    }
    out.diagnostics.inputMasterCount = master.length;

    var duplicateHours = {};

    for (var i = 0; i < master.length; i++) {
      var raw = master[i];
      if (!isObj(raw)) {
        recordInvalid(out.diagnostics, raw, 'entry-not-object', { index: i });
        continue;
      }

      var block = raw.block;
      var hours = parseHours(raw.hours);
      var count = parseCount(raw.count);

      if (!isStr(block) || block.trim() === '') {
        out.diagnostics.missingBlocks.push({ index: i, entry: raw });
        recordInvalid(out.diagnostics, raw, 'missing-block', { index: i });
        continue;
      }

      if (!isNum(hours) || hours <= 0) {
        out.diagnostics.missingHours.push({ index: i, entry: raw });
        recordInvalid(out.diagnostics, raw, 'missing-or-invalid-hours', { index: i });
        continue;
      }

      if (!isNum(count) || count < 0) {
        recordInvalid(out.diagnostics, raw, 'missing-or-invalid-count', { index: i });
        continue;
      }

      var entry = {
        block: block,
        hours: hours,
        count: count,
        index: i
      };
      out.entries.push(entry);

      if (!out.byHours[hours]) {
        out.byHours[hours] = { count: 0, block: block, sources: [] };
        out.hoursToBlock[hours] = block;
      }
      if (!duplicateHours[hours]) {
        duplicateHours[hours] = 0;
      }
      duplicateHours[hours] += 1;
      out.byHours[hours].count += count;
      out.byHours[hours].sources.push({ index: i, block: block, count: count });
    }

    var dKeys = Object.keys(duplicateHours);
    for (var d = 0; d < dKeys.length; d++) {
      var h = parseFloat(dKeys[d]);
      if (duplicateHours[h] > 1) {
        out.diagnostics.duplicates.push({
          hours: h,
          occurrences: duplicateHours[h],
          sources: out.byHours[h].sources
        });
      }
    }

    return out;
  }

  function normalizeDateMap(dateMap) {
    var out = {
      dates: {},
      diagnostics: emptyDiagnostics()
    };
    if (dateMap === undefined || dateMap === null) {
      return out;
    }
    if (!isObj(dateMap)) {
      recordInvalid(out.diagnostics, dateMap, 'dateMap-not-object', null);
      return out;
    }

    var dateKeys = Object.keys(dateMap);
    out.diagnostics.inputDateCount = dateKeys.length;

    for (var i = 0; i < dateKeys.length; i++) {
      var dateStr = dateKeys[i];
      var actual = dateMap[dateStr];
      if (!isObj(actual)) {
        recordInvalid(out.diagnostics, actual, 'actual-not-object', { date: dateStr });
        out.diagnostics.missingDates.push({ date: dateStr, reason: 'actual-not-object' });
        continue;
      }
      if (!isDateStr(dateStr)) {
        recordInvalid(out.diagnostics, dateStr, 'invalid-date-format', { date: dateStr });
        continue;
      }
      if (!out.dates[dateStr]) out.dates[dateStr] = {};
      var hourKeys = Object.keys(actual);
      for (var j = 0; j < hourKeys.length; j++) {
        var hk = hourKeys[j];
        var hours = parseHours(hk);
        if (actual[hk] === undefined || actual[hk] === null) {
          continue;
        }
        var count = parseCount(actual[hk]);
        if (!isNum(hours) || hours <= 0) {
          out.diagnostics.missingHours.push({ date: dateStr, hours: hk });
          recordInvalid(out.diagnostics, { date: dateStr, hours: hk, count: actual[hk] }, 'actual-invalid-hours', { date: dateStr, hours: hk });
          continue;
        }
        if (!isNum(count) || count < 0) {
          recordInvalid(out.diagnostics, { date: dateStr, hours: hk, count: actual[hk] }, 'actual-invalid-count', { date: dateStr, hours: hk });
          continue;
        }
        if (!out.dates[dateStr][hours]) out.dates[dateStr][hours] = 0;
        out.dates[dateStr][hours] += count;
      }
      if (Object.keys(out.dates[dateStr]).length === 0) {
        out.diagnostics.missingDates.push({ date: dateStr, reason: 'no-valid-hours' });
      }
    }

    return out;
  }

  function validateFleetCanonicalInput(input) {
    var errors = [];
    if (!isObj(input)) {
      errors.push('input is not an object');
      return { ok: false, errors: errors };
    }
    if (input.inputType !== INPUT_TYPE) errors.push('inputType must be ' + INPUT_TYPE);
    if (!isDateStr(input.localDate)) errors.push('localDate must be YYYY-MM-DD');
    if (!isStr(input.block) || input.block === '') errors.push('block is required');
    if (!isNum(input.hours) || input.hours <= 0) errors.push('hours must be a positive number');
    if (!isNum(input.expected) || input.expected < 0) errors.push('expected must be a non-negative number');
    if (input.actual !== undefined && input.actual !== null && (!isNum(input.actual) || input.actual < 0)) {
      errors.push('actual must be null/undefined or a non-negative number');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function filterDateRange(dates, now) {
    if (!now) return dates.slice().sort();
    var pastLimit = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    var futureLimit = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
    var out = [];
    for (var i = 0; i < dates.length; i++) {
      var parts = dates[i].split('-');
      var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      if (d >= pastLimit && d <= futureLimit) out.push(dates[i]);
    }
    return out.sort();
  }

  function buildFleetCanonicalInputs(master, dateMap, opts) {
    opts = opts || {};
    var diagnostics = emptyDiagnostics();

    if (master === undefined || master === null) {
      diagnostics.inputMasterCount = 0;
      diagnostics.invalidEntries.push({
        entry: master,
        reason: 'master-missing',
        context: null
      });
      diagnostics.skippedCount += 1;
      var nDateMap = normalizeDateMap(dateMap);
      diagnostics.inputDateCount = nDateMap.diagnostics.inputDateCount;
      mergeDiagnostics(diagnostics, nDateMap.diagnostics);
      return {
        inputs: [],
        diagnostics: diagnostics,
        normalizedMaster: normalizeFleetMaster(master),
        normalizedDateMap: nDateMap
      };
    }

    var normalizedMaster = normalizeFleetMaster(master);
    mergeDiagnostics(diagnostics, normalizedMaster.diagnostics);

    var normalizedDateMap = normalizeDateMap(dateMap);
    mergeDiagnostics(diagnostics, normalizedDateMap.diagnostics);

    var now = opts.now ? new Date(opts.now) : null;
    var dates = filterDateRange(Object.keys(normalizedDateMap.dates), now);

    var inputs = [];
    var masterLookup = normalizedMaster.byHours;
    var hoursToBlock = normalizedMaster.hoursToBlock;

    for (var d = 0; d < dates.length; d++) {
      var dt = dates[d];
      var actual = normalizedDateMap.dates[dt];
      var allHours = {};
      var mKeys = Object.keys(masterLookup);
      for (var k = 0; k < mKeys.length; k++) {
        allHours[parseFloat(mKeys[k])] = true;
      }
      var aKeys = Object.keys(actual);
      for (var k = 0; k < aKeys.length; k++) {
        allHours[parseFloat(aKeys[k])] = true;
      }

      var sortedHours = Object.keys(allHours).sort(function (a, b) { return parseFloat(b) - parseFloat(a); });
      for (var ki = 0; ki < sortedHours.length; ki++) {
        var h = parseFloat(sortedHours[ki]);
        var expected = masterLookup[h] ? masterLookup[h].count : 0;
        var got;
        if (actual.hasOwnProperty(h)) got = actual[h];
        else got = undefined;

        var block = hoursToBlock[h] || '-';
        var input = {
          inputType: INPUT_TYPE,
          localDate: dt,
          block: block,
          hours: h,
          expected: expected,
          actual: got
        };

        var validation = validateFleetCanonicalInput(input);
        if (validation.ok) {
          inputs.push(input);
          diagnostics.canonicalCount += 1;
          if (got === undefined) {
            diagnostics.missingActuals.push({ localDate: dt, hours: h, block: block });
          }
        } else {
          diagnostics.invalidEntries.push({
            entry: input,
            reason: 'canonical-validation-failed',
            errors: validation.errors
          });
          diagnostics.skippedCount += 1;
        }
      }
    }

    diagnostics.inputMasterCount = normalizedMaster.diagnostics.inputMasterCount;
    diagnostics.inputDateCount = normalizedDateMap.diagnostics.inputDateCount;

    return {
      inputs: inputs,
      diagnostics: diagnostics,
      normalizedMaster: normalizedMaster,
      normalizedDateMap: normalizedDateMap
    };
  }

  function mergeDiagnostics(target, source) {
    var arrays = ['missingDates', 'missingBlocks', 'missingHours', 'missingActuals', 'duplicates', 'invalidEntries'];
    for (var i = 0; i < arrays.length; i++) {
      var key = arrays[i];
      if (Array.isArray(source[key])) {
        for (var j = 0; j < source[key].length; j++) {
          target[key].push(source[key][j]);
        }
      }
    }
    target.skippedCount += source.skippedCount || 0;
  }

  function getComparisonView(canonicalInputs) {
    if (!Array.isArray(canonicalInputs)) return { dates: [] };
    var byDate = {};
    for (var i = 0; i < canonicalInputs.length; i++) {
      var inp = canonicalInputs[i];
      if (!isObj(inp) || !isDateStr(inp.localDate)) continue;
      if (!byDate[inp.localDate]) byDate[inp.localDate] = [];
      var got = inp.actual === undefined || inp.actual === null ? 0 : inp.actual;
      byDate[inp.localDate].push({
        hours: inp.hours,
        block: inp.block,
        expected: inp.expected,
        actual: got,
        diff: got - inp.expected
      });
    }
    var dates = Object.keys(byDate).sort();
    var results = [];
    for (var d = 0; d < dates.length; d++) {
      var dt = dates[d];
      var rows = byDate[dt].sort(function (a, b) { return b.hours - a.hours; });
      var hasAlert = false;
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].diff !== 0) hasAlert = true;
      }
      results.push({ date: dt, rows: rows, hasAlert: hasAlert });
    }
    return { dates: results };
  }

  return {
    INPUT_TYPE: INPUT_TYPE,
    normalizeFleetMaster: normalizeFleetMaster,
    normalizeDateMap: normalizeDateMap,
    buildFleetCanonicalInputs: buildFleetCanonicalInputs,
    validateFleetCanonicalInput: validateFleetCanonicalInput,
    getComparisonView: getComparisonView
  };
}));
