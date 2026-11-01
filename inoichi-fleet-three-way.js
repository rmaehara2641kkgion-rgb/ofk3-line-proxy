/**
 * INO-1 車両台数の3点照合。
 *
 * 比較するのは次の3ソースだけ。
 *   amazon_input     Amazonの車両台数入力サイト
 *   amazon_schedule  Amazonのスケジュール画面
 *   internal_excel   社内Excel InputFile
 *
 * 正解の固定台数は持たない。同じ日付・サイクル・車種・数え方の台数が
 * 3ソースとも揃い、かつ同じ数値のときだけ一致とする。
 * 1ソースでも欠けていれば一致にしない。数値は足したり置き換えたりしない。
 *
 * Bikeは人数とコース台数を別の数え方として扱う。
 * 「1人で2コース」は注記であり、人数を2倍してコース台数へ換算しない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InoichiFleetThreeWay = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SOURCES = ['amazon_input', 'amazon_schedule', 'internal_excel'];

  var VEHICLE_ALIASES = {
    '8B': '8B', '8': '8B', 'EIGHTB': '8B', '8時間': '8B',
    '6.5B': '6.5B', '6.5': '6.5B', '6B30S': '6.5B', 'BLOCK6_5': '6.5B', '6時間30分': '6.5B',
    '4.5B': '4.5B', '4.5': '4.5B', '4B30S': '4.5B', 'BLOCK4_5': '4.5B', '4時間30分': '4.5B',
    'BIKE2H': 'BIKE_2H', 'BIKE_2H': 'BIKE_2H', '2B': 'BIKE_2H', '2': 'BIKE_2H', '2時間': 'BIKE_2H',
    'BIKE3H': 'BIKE_3H', 'BIKE_3H': 'BIKE_3H', '3B': 'BIKE_3H', '3': 'BIKE_3H', '3時間': 'BIKE_3H'
  };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function normalizeDate(raw) {
    if (typeof raw === 'number' && raw >= 40000 && raw <= 60000) {
      var utcDays = Math.floor(raw - 25569);
      var d = new Date(utcDays * 86400 * 1000);
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    var s = String(raw == null ? '' : raw).trim();
    var m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!m) return '';
    return m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]));
  }

  function normalizeCycle(raw) {
    var s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/[\s_-]/g, '');
    if (!s) return '';
    var named = s.match(/^CYCLE(\d+)$/);
    if (named) return 'CYCLE_' + String(Number(named[1]));
    var short = s.match(/^C(\d+)$/);
    if (short) return 'CYCLE_' + String(Number(short[1]));
    if (/^\d+$/.test(s)) return 'CYCLE_' + String(Number(s));
    return '';
  }

  function normalizeVehicle(raw) {
    var s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
    if (Object.prototype.hasOwnProperty.call(VEHICLE_ALIASES, s)) return VEHICLE_ALIASES[s];
    var lower = String(raw == null ? '' : raw).trim();
    if (Object.prototype.hasOwnProperty.call(VEHICLE_ALIASES, lower)) return VEHICLE_ALIASES[lower];
    return '';
  }

  function normalizeMeasure(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (s === 'people' || s === 'headcount' || s === '人数' || s === '出勤') return 'people';
    if (s === 'courses' || s === 'course' || s === '台数' || s === 'ルート' || s === 'コース') return 'courses';
    return '';
  }

  function normalizeSource(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (SOURCES.indexOf(s) >= 0) return s;
    return '';
  }

  function isBike(vehicle) {
    return vehicle === 'BIKE_2H' || vehicle === 'BIKE_3H';
  }

  // 運用メモ。照合には使わない。
  function bikePeopleToCoursesNote(peopleCount) {
    return {
      rule: '1人で2コースを担当する場合がある',
      applied: false,
      people: peopleCount,
      coursesIfConverted: Number(peopleCount) * 2
    };
  }

  function normalizeObservation(raw) {
    var source = normalizeSource(raw && raw.source);
    var date = normalizeDate(raw && raw.date);
    var cycle = normalizeCycle(raw && raw.cycle);
    var vehicle = normalizeVehicle(raw && raw.vehicle);
    var measure = normalizeMeasure(raw && raw.measure);
    var count = raw && raw.count;
    var countOk = typeof count === 'number' && isFinite(count);
    var fetchedAt = raw && raw.fetchedAt ? String(raw.fetchedAt) : '';
    var problems = [];
    if (!source) problems.push('source');
    if (!date) problems.push('date');
    if (!cycle) problems.push('cycle');
    if (!vehicle) problems.push('vehicle');
    if (!measure) problems.push('measure');
    if (!countOk) problems.push('count');
    return {
      ok: problems.length === 0,
      problems: problems,
      source: source,
      date: date,
      cycle: cycle,
      vehicle: vehicle,
      measure: measure,
      count: countOk ? count : null,
      fetchedAt: fetchedAt
    };
  }

  function groupKey(row) {
    return [row.date, row.cycle, row.vehicle, row.measure].join('|');
  }

  function emptyCounts() {
    return { amazon_input: null, amazon_schedule: null, internal_excel: null };
  }

  function compareThreeWay(observations) {
    var list = Array.isArray(observations) ? observations : [];
    var rejected = [];
    var groups = {};
    list.forEach(function (raw) {
      var row = normalizeObservation(raw);
      if (!row.ok) {
        rejected.push(row);
        return;
      }
      var key = groupKey(row);
      if (!groups[key]) {
        groups[key] = {
          date: row.date,
          cycle: row.cycle,
          vehicle: row.vehicle,
          measure: row.measure,
          bySource: {}
        };
      }
      var bucket = groups[key].bySource[row.source] || { values: [], fetchedAt: [] };
      bucket.values.push(row.count);
      if (row.fetchedAt) bucket.fetchedAt.push(row.fetchedAt);
      groups[key].bySource[row.source] = bucket;
    });

    var rows = Object.keys(groups).sort().map(function (key) {
      var group = groups[key];
      var counts = emptyCounts();
      var fetchedAt = { amazon_input: null, amazon_schedule: null, internal_excel: null };
      var missingSources = [];
      var status = 'match';
      var note = '';
      SOURCES.forEach(function (source) {
        var bucket = group.bySource[source];
        if (!bucket) {
          missingSources.push(source);
          return;
        }
        var unique = bucket.values.filter(function (value, index) {
          return bucket.values.indexOf(value) === index;
        });
        if (unique.length > 1) {
          status = 'source_conflict';
          counts[source] = bucket.values.slice();
          note = source + ' の二重取得で数値が違う';
        } else {
          counts[source] = unique[0];
        }
        fetchedAt[source] = bucket.fetchedAt.length ? bucket.fetchedAt[bucket.fetchedAt.length - 1] : null;
      });
      if (status !== 'source_conflict') {
        if (missingSources.length) {
          status = 'missing';
          note = '未取得: ' + missingSources.join(', ');
        } else {
          var values = SOURCES.map(function (source) { return counts[source]; });
          var same = values.every(function (value) { return value === values[0]; });
          status = same ? 'match' : 'mismatch';
          if (!same) note = '3ソースの台数が一致しない';
        }
      }
      if (isBike(group.vehicle) && group.measure === 'people') {
        note = (note ? note + ' / ' : '') + 'Bike人数。コース台数へは換算しない';
      }
      return {
        date: group.date,
        cycle: group.cycle,
        vehicle: group.vehicle,
        measure: group.measure,
        counts: counts,
        fetchedAt: fetchedAt,
        status: status,
        missingSources: missingSources,
        note: note,
        bikeRule: isBike(group.vehicle) ? bikePeopleToCoursesNote(group.measure === 'people' ? counts.amazon_input : null) : null
      };
    });

    var measureSplits = findMeasureSplits(rows);
    var summary = { total: rows.length, match: 0, mismatch: 0, missing: 0, source_conflict: 0, measure_mismatch: measureSplits.length };
    rows.forEach(function (row) {
      if (Object.prototype.hasOwnProperty.call(summary, row.status)) summary[row.status] += 1;
    });
    return {
      rows: rows,
      measureSplits: measureSplits,
      rejected: rejected,
      summary: summary
    };
  }

  function findMeasureSplits(rows) {
    var byVehicle = {};
    rows.forEach(function (row) {
      if (!isBike(row.vehicle)) return;
      var key = row.date + '|' + row.cycle + '|' + row.vehicle;
      if (!byVehicle[key]) byVehicle[key] = {};
      byVehicle[key][row.measure] = true;
    });
    return Object.keys(byVehicle).sort().filter(function (key) {
      return byVehicle[key].people && byVehicle[key].courses;
    }).map(function (key) {
      var parts = key.split('|');
      return {
        date: parts[0],
        cycle: parts[1],
        vehicle: parts[2],
        status: 'measure_mismatch',
        note: 'Bikeの出勤人数とコース台数は別件数。2倍換算はしない'
      };
    });
  }

  function listMismatches(result) {
    var rows = (result && result.rows) || [];
    var splits = (result && result.measureSplits) || [];
    return rows.filter(function (row) { return row.status !== 'match'; }).concat(splits);
  }

  function parseInputFileObservations(rows, fetchedAt) {
    var headerIndex = -1;
    for (var r = 0; r < Math.min(rows.length, 10); r++) {
      var header = (rows[r] || []).map(function (cell) { return String(cell == null ? '' : cell).trim(); });
      if (header.indexOf('Node') >= 0 && header.indexOf('Block') >= 0 && header.indexOf('Cycle') >= 0) {
        headerIndex = r;
        break;
      }
    }
    if (headerIndex < 0) return { ok: false, error: 'InputFileのNode/Block/Cycle列が見つかりません', observations: [] };
    var headerRow = rows[headerIndex];
    var col = {};
    headerRow.forEach(function (cell, index) {
      var key = String(cell == null ? '' : cell).trim();
      if (key && !(key in col)) col[key] = index;
    });
    var dateCols = [];
    headerRow.forEach(function (cell, index) {
      if (typeof cell === 'number' && cell >= 40000 && cell <= 60000) {
        dateCols.push({ index: index, date: normalizeDate(cell) });
      }
    });
    var observations = [];
    for (var i = headerIndex + 1; i < rows.length; i++) {
      var row = rows[i] || [];
      if (String(row[col.Node] == null ? '' : row[col.Node]).trim().toUpperCase() !== 'OFK3') continue;
      var vehicle = normalizeVehicle(row[col.Block]);
      var cycle = normalizeCycle(row[col.Cycle]);
      if (!vehicle || !cycle) continue;
      dateCols.forEach(function (dateCol) {
        var cell = row[dateCol.index];
        if (cell === '' || cell == null) return;
        var count = Number(cell);
        if (!isFinite(count)) return;
        observations.push({
          source: 'internal_excel',
          date: dateCol.date,
          cycle: cycle,
          vehicle: vehicle,
          measure: 'courses',
          count: count,
          fetchedAt: fetchedAt || ''
        });
      });
    }
    return { ok: true, error: null, observations: observations };
  }

  return {
    SOURCES: SOURCES,
    normalizeDate: normalizeDate,
    normalizeCycle: normalizeCycle,
    normalizeVehicle: normalizeVehicle,
    normalizeMeasure: normalizeMeasure,
    bikePeopleToCoursesNote: bikePeopleToCoursesNote,
    compareThreeWay: compareThreeWay,
    listMismatches: listMismatches,
    parseInputFileObservations: parseInputFileObservations
  };
}));
