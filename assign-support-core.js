/**
 * OFK3 アサイン支援 — 純粋ロジック（UI非依存）
 * TransportID を主キーとしたエリア経験DB + マニフェスト/シフト突合
 */
(function (global) {
  'use strict';

  var COLUMN_ALIASES = {
    transportId: ['transportid', 'transport_id', 'tid', 'transport id', 'トランスポートid'],
    driverName: ['drivername', 'driver_name', 'name', '氏名', 'ドライバー名', 'driver'],
    area: ['area', 'エリア', 'area_name', '地区'],
    experienceDays: ['experiencedays', 'experience_days', 'days', '走行日数', '経験日数', 'experience days'],
    lastVisitDate: ['lastvisitdate', 'last_visit_date', '最終走行日', 'lastvisit', 'last visit'],
    stops: ['stops', '件数', '配送件数'],
    packages: ['packages', '個口', '個口数'],
    primaryCount: ['primarycount', 'primary_count'],
    splitCount: ['splitcount', 'split_count'],
    rescueCount: ['rescuecount', 'rescue_count'],
    confidence: ['confidence', '信頼度'],
  };

  function normalizeHeader(h) {
    return String(h || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_\-　]/g, '');
  }

  function mapColumns(headers) {
    var mapped = {};
    var used = {};
    for (var field in COLUMN_ALIASES) {
      for (var i = 0; i < headers.length; i++) {
        var norm = normalizeHeader(headers[i]);
        if (!norm || used[i]) continue;
        var aliases = COLUMN_ALIASES[field];
        for (var a = 0; a < aliases.length; a++) {
          if (norm === normalizeHeader(aliases[a])) {
            mapped[field] = i;
            used[i] = true;
            break;
          }
        }
        if (mapped[field] !== undefined) break;
      }
    }
    return mapped;
  }

  function parseExperienceRows(rows, options) {
    options = options || {};
    if (!rows || rows.length < 2) {
      return { ok: false, error: 'データ行が不足しています' };
    }
    var headers = rows[0].map(function (h) {
      return String(h || '').trim();
    });
    var cols = mapColumns(headers);
    if (cols.transportId === undefined) {
      return { ok: false, error: 'TransportID列が見つかりません（必須）' };
    }
    if (cols.area === undefined) {
      return { ok: false, error: 'area列が見つかりません（必須）' };
    }
    if (cols.experienceDays === undefined) {
      return { ok: false, error: 'experienceDays列が見つかりません（必須）' };
    }

    var knownTids = options.knownTransportIds || new Set();
    var records = [];
    var byTransportId = {};
    var areaSet = {};
  var unknownTids = [];
  var unknownTidSet = {};
    var lastDate = '';

    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row) continue;
      var tid = String(row[cols.transportId] || '').trim();
      var area = String(row[cols.area] || '').trim();
      if (!tid || !area) continue;

      var daysRaw = row[cols.experienceDays];
      var experienceDays = Number(daysRaw);
      if (!isFinite(experienceDays) || experienceDays < 0) continue;

      var driverName =
        cols.driverName !== undefined ? String(row[cols.driverName] || '').trim() : '';
      var lastVisitDate =
        cols.lastVisitDate !== undefined ? String(row[cols.lastVisitDate] || '').trim() : '';

      if (lastVisitDate && (!lastDate || lastVisitDate > lastDate)) lastDate = lastVisitDate;

      var rec = {
        transportId: tid,
        driverName: driverName,
        area: area,
        experienceDays: experienceDays,
        lastVisitDate: lastVisitDate,
        stops: cols.stops !== undefined ? Number(row[cols.stops]) || 0 : 0,
        packages: cols.packages !== undefined ? Number(row[cols.packages]) || 0 : 0,
        primaryCount: cols.primaryCount !== undefined ? Number(row[cols.primaryCount]) || 0 : 0,
        splitCount: cols.splitCount !== undefined ? Number(row[cols.splitCount]) || 0 : 0,
        rescueCount: cols.rescueCount !== undefined ? Number(row[cols.rescueCount]) || 0 : 0,
        confidence: cols.confidence !== undefined ? String(row[cols.confidence] || '').trim() : '',
      };

      records.push(rec);
      areaSet[area] = true;

      if (!byTransportId[tid]) {
        byTransportId[tid] = {
          transportId: tid,
          driverName: driverName,
          areas: {},
          areaCount: 0,
        };
      }
      if (driverName && !byTransportId[tid].driverName) {
        byTransportId[tid].driverName = driverName;
      }
      byTransportId[tid].areas[area] = rec;

      if (knownTids.size > 0 && !knownTids.has(tid) && !unknownTidSet[tid]) {
        unknownTidSet[tid] = true;
        unknownTids.push({ transportId: tid, driverName: driverName, area: area });
      }
    }

    var drivers = Object.keys(byTransportId);
    for (var d = 0; d < drivers.length; d++) {
      byTransportId[drivers[d]].areaCount = Object.keys(byTransportId[drivers[d]].areas).length;
    }

    return {
      ok: true,
      records: records,
      byTransportId: byTransportId,
      stats: {
        drivers: drivers.length,
        areas: Object.keys(areaSet).length,
        records: records.length,
        lastDate: lastDate,
        unknownTids: unknownTids,
        unknownTidCount: Object.keys(unknownTidSet).length,
      },
    };
  }

  /** 住所からエリアラベル一覧（既存 extractAreaFromAddresses と同じ町名抽出） */
  function extractAreaLabelsFromAddresses(addresses) {
    if (!addresses || !addresses.length) return [];
    var neighborhoodCounts = {};
    for (var i = 0; i < addresses.length; i++) {
      var addr = addresses[i];
      if (!addr) continue;
      var normalized = String(addr).replace(/福岡市\s*/g, '');
      var match = normalized.match(/([\u4e00-\u9fff]+区)([\u4e00-\u9fff]+?)[\d丁,\s]/);
      if (match) {
        var ku = match[1];
        var machi = match[2];
        var key = ku + '|' + machi;
        if (!neighborhoodCounts[key]) {
          neighborhoodCounts[key] = { label: machi, ku: ku, count: 0 };
        }
        neighborhoodCounts[key].count++;
      }
    }
    var list = Object.keys(neighborhoodCounts)
      .map(function (k) {
        return neighborhoodCounts[k];
      })
      .sort(function (a, b) {
        return b.count - a.count;
      });
    for (var j = 0; j < list.length; j++) {
      list[j].role = j === 0 ? 'primary' : 'secondary';
    }
    return list;
  }

  function normalizeAreaToken(s) {
    return String(s || '')
      .replace(/福岡市/g, '')
      .replace(/[・\s　]/g, '')
      .trim();
  }

  function areasMatch(manifestArea, experienceArea) {
    var a = normalizeAreaToken(manifestArea);
    var b = normalizeAreaToken(experienceArea);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    return false;
  }

  function findExperienceForArea(byTransportIdEntry, manifestAreaLabel) {
    if (!byTransportIdEntry || !byTransportIdEntry.areas) return null;
    var keys = Object.keys(byTransportIdEntry.areas);
    for (var i = 0; i < keys.length; i++) {
      var rec = byTransportIdEntry.areas[keys[i]];
      if (areasMatch(manifestAreaLabel, rec.area)) return rec;
    }
    return null;
  }

  function evaluateDriverForRoute(driver, routeAreas, experienceEntry) {
    var areaResults = [];
    var allExperienced = true;
    var anyExperience = false;

    for (var i = 0; i < routeAreas.length; i++) {
      var manifestArea = routeAreas[i].label;
      var exp = experienceEntry ? findExperienceForArea(experienceEntry, manifestArea) : null;
      var experienced = !!(exp && exp.experienceDays > 0);
      if (!experienced) allExperienced = false;
      if (experienced) anyExperience = true;
      areaResults.push({
        area: manifestArea,
        experienced: experienced,
        experienceDays: exp ? exp.experienceDays : 0,
        lastVisitDate: exp ? exp.lastVisitDate : '',
      });
    }

    var minDays = Infinity;
    var latestDate = '';
    for (var j = 0; j < areaResults.length; j++) {
      if (areaResults[j].experienced) {
        minDays = Math.min(minDays, areaResults[j].experienceDays);
        if (areaResults[j].lastVisitDate > latestDate) latestDate = areaResults[j].lastVisitDate;
      }
    }
    if (!isFinite(minDays)) minDays = 0;

    var status;
    if (allExperienced) status = 'recommended';
    else if (anyExperience) status = 'partial';
    else status = 'unexperienced';

    return {
      transportId: driver.transportId,
      driverName: driver.driverName || driver.name,
      shiftCode: driver.shiftCode || '',
      areaResults: areaResults,
      status: status,
      minExperienceDays: minDays,
      latestVisitDate: latestDate,
      experiencedAreaCount: experienceEntry ? experienceEntry.areaCount : 0,
    };
  }

  function buildAssignSuggestions(manifestRoutes, shiftWorkers, experienceDb, options) {
    options = options || {};
    var reserveCount = Number(options.rescueReserveCount) || 0;
    var suggestions = [];

    for (var ri = 0; ri < manifestRoutes.length; ri++) {
      var route = manifestRoutes[ri];
      var routeAreas = route.areas || [];
      if (!routeAreas.length) continue;

      var candidates = [];
      var partial = [];
      var unexperienced = [];

      for (var wi = 0; wi < shiftWorkers.length; wi++) {
        var worker = shiftWorkers[wi];
        if (!worker.transportId) continue;
        if (worker.assignRole === 'reserve') continue;
        if (route.routeVehicleType && route.routeVehicleType !== 'unknown') {
          var pool = filterWorkersByVehicleType([worker], route.routeVehicleType);
          if (!pool.length) continue;
        }
        var expEntry = experienceDb.byTransportId[worker.transportId];
        var evalResult = evaluateDriverForRoute(worker, routeAreas, expEntry);

        if (evalResult.status === 'recommended') candidates.push(evalResult);
        else if (evalResult.status === 'partial') partial.push(evalResult);
        else unexperienced.push(evalResult);
      }

      candidates.sort(function (a, b) {
        if (b.minExperienceDays !== a.minExperienceDays) return b.minExperienceDays - a.minExperienceDays;
        return (b.latestVisitDate || '').localeCompare(a.latestVisitDate || '');
      });
      partial.sort(function (a, b) {
        var aExp = a.areaResults.filter(function (x) {
          return x.experienced;
        }).length;
        var bExp = b.areaResults.filter(function (x) {
          return x.experienced;
        }).length;
        if (bExp !== aExp) return bExp - aExp;
        return b.minExperienceDays - a.minExperienceDays;
      });

      suggestions.push({
        routeCode: route.routeCode,
        packages: route.packages,
        stops: route.stops,
        areas: routeAreas,
        recommended: candidates,
        partial: partial,
        unexperienced: unexperienced,
        noExperiencedDriver: candidates.length === 0,
        rescueReserveCount: reserveCount,
      });
    }

    return suggestions;
  }

  /** DAシフト表の非ドライバー行（集計行など） */
  var SHIFT_NON_DRIVER_NAME_EXACT = ['必要台数', '合計', '計', '小計'];

  function isShiftNonDriverRow(name) {
    var n = String(name || '').trim();
    if (!n) return true;
    for (var i = 0; i < SHIFT_NON_DRIVER_NAME_EXACT.length; i++) {
      if (n === SHIFT_NON_DRIVER_NAME_EXACT[i]) return true;
    }
    return false;
  }

  function filterShiftWorkers(workers) {
    if (!workers || !workers.length) return [];
    return workers.filter(function (w) {
      return !isShiftNonDriverRow(w.rawName || w.name || w.driverName);
    });
  }

  /** Cycle × シフト適格性（Phase 1.7 運用モデル） */
  var CYCLE_SHIFT_ELIGIBILITY = {
    1: ['maru', 'b1', 'bike', 'c1'],
    2: ['hachi', 'b2', 'bike'],
    3: ['maru', 'c3'],
  };

  /** DSP Initiated Work 等・予備枠判定（serviceType / Schedule cell 文字列） */
  var RESERVE_ASSIGN_PATTERNS = [/DSP\s*Initiated/i, /Initiated\s*Work/i];

  /** 通常アサイン候補から除外するシフト記号 */
  var NON_ASSIGNABLE_SHIFT_TYPES = ['研修'];

  var SHIFT_TOKEN_LABELS = {
    maru: '〇',
    hachi: '❽',
    b1: 'b1',
    b2: 'b2',
    bike: 'bike',
    c1: 'C1',
    c3: 'C3',
  };

  /**
   * シフト記号正規化（index.html の normalizeShiftCode + normalizeExecCourseType + 11B/8B 表記）
   * 戻り値は CYCLE_SHIFT_ELIGIBILITY 用トークン、または「研修」等
   */
  function normalizeAssignShiftToken(rawCode) {
    if (rawCode === undefined || rawCode === null) return '';
    var s = String(rawCode).trim();
    if (!s) return '';

    s = s
      .replace(/ｂ/g, 'b')
      .replace(/Ｃ/g, 'C')
      .replace(/０/g, '0')
      .replace(/１/g, '1')
      .replace(/２/g, '2')
      .replace(/３/g, '3')
      .replace(/[○◯〇Ｏ]/g, '〇');

    if (s === '研修' || s.indexOf('研修') >= 0) return '研修';

    var compact = s.replace(/[\s　]/g, '');
    if (/^11[BbＢ]?$/i.test(compact)) return 'maru';
    if (/^8[BbＢ]?$/i.test(compact)) return 'hachi';

    s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });

    if (s === '〇') return 'maru';

    var lower = s.toLowerCase().replace(/[\s　]/g, '');
    if (lower === 'o' || lower === '0' || lower === 'maru') return 'maru';
    if (s === '❽' || s === '⑧' || lower === '8' || lower === '8b' || lower === 'hachi') return 'hachi';
    if (lower === 'c1') return 'c1';
    if (lower === 'c3') return 'c3';
    if (lower === 'bike' || lower === 'biker' || s === 'バイク' || lower === 'ﾊﾞｲｸ') return 'bike';
    if (lower === 'b1') return 'b1';
    if (lower === 'b2') return 'b2';
    if (lower === 'training') return '研修';

    return lower;
  }

  function formatShiftTokenLabel(token) {
    return SHIFT_TOKEN_LABELS[token] || '';
  }

  function getCyclesForShiftToken(token) {
    var cycles = [];
    for (var c = 1; c <= 3; c++) {
      var allowed = CYCLE_SHIFT_ELIGIBILITY[c] || [];
      if (allowed.indexOf(token) >= 0) cycles.push(c);
    }
    return cycles;
  }

  function formatCycleEligibleLabel(token, currentCycle) {
    var label = formatShiftTokenLabel(token) || token;
    var cycles = getCyclesForShiftToken(token);
    if (cycles.length > 1) {
      return label + '（' + cycles.map(function (c) { return 'Cycle ' + c; }).join(' / ') + '対応）';
    }
    if (currentCycle) return label + '（Cycle ' + currentCycle + '対象）';
    return label;
  }

  function isNonAssignableShift(rawCode) {
    var raw = String(rawCode || '').trim();
    if (!raw) return true;
    for (var i = 0; i < NON_ASSIGNABLE_SHIFT_TYPES.length; i++) {
      if (raw === NON_ASSIGNABLE_SHIFT_TYPES[i]) return true;
    }
    return normalizeAssignShiftToken(raw) === '研修';
  }

  function isShiftEligibleForCycle(token, cycle) {
    var cycleNum = Number(cycle);
    var allowed = CYCLE_SHIFT_ELIGIBILITY[cycleNum];
    if (!allowed) return false;
    return allowed.indexOf(token) >= 0;
  }

  function getEligibleShiftLabelsForCycle(cycle) {
    var tokens = CYCLE_SHIFT_ELIGIBILITY[Number(cycle)] || [];
    return tokens.map(function (t) {
      return SHIFT_TOKEN_LABELS[t] || t;
    });
  }

  function filterWorkersByCycleEligibility(workers, cycle) {
    var eligible = [];
    var excluded = {
      nonAssignable: [],
      cycleIneligible: [],
      noShiftCode: [],
    };
    var cycleNum = Number(cycle);

    for (var i = 0; i < (workers || []).length; i++) {
      var w = workers[i];
      var shift = w.shiftCode || '';
      if (!String(shift).trim()) {
        excluded.noShiftCode.push(w);
        continue;
      }
      if (isNonAssignableShift(shift)) {
        excluded.nonAssignable.push(w);
        continue;
      }
      var token = normalizeAssignShiftToken(shift);
      if (!isShiftEligibleForCycle(token, cycleNum)) {
        excluded.cycleIneligible.push(w);
        continue;
      }
      eligible.push(
        Object.assign({}, w, {
          normalizedShiftToken: token,
          shiftCodeDisplay: formatShiftTokenLabel(token) || shift,
        })
      );
    }

    return {
      eligible: eligible,
      excluded: excluded,
      stats: {
        totalWorkers: (workers || []).length,
        eligibleCount: eligible.length,
        nonAssignableCount: excluded.nonAssignable.length,
        cycleIneligibleCount: excluded.cycleIneligible.length,
        noShiftCodeCount: excluded.noShiftCode.length,
        cycle: cycleNum,
        eligibleShiftLabels: getEligibleShiftLabelsForCycle(cycleNum),
      },
    };
  }

  function detectCycleFromFileName(name) {
    var n = String(name || '');
    var m =
      n.match(/OFK3[_\-\s]*CYCLE[_\-\s]*([123])/i) || n.match(/CYCLE[_\-\s]*([123])/i);
    if (m) return Number(m[1]);
    return null;
  }

  function getAssignModeForCycle(cycle) {
    var c = Number(cycle);
    if (c === 3) return 'first_pick';
    if (c === 1 || c === 2) return 'evaluate';
    return null;
  }

  function parseScheduleCellWorkHint(cellText) {
    var t = String(cellText || '');
    if (!t) return {};
    var hints = {};
    if (/DSP\s*Initiated|Initiated\s*Work/i.test(t)) hints.assignRole = 'reserve';
    if (/Nursery/i.test(t)) hints.workTypeHint = 'nursery';
    if (/Bike|Biker|バイク|ﾊﾞｲｸ/i.test(t)) hints.vehicleHint = 'bike';
    if (/Standard/i.test(t)) hints.vehicleHint = 'standard';
    return hints;
  }

  function isReserveServiceType(serviceType) {
    var st = String(serviceType || '');
    for (var i = 0; i < RESERVE_ASSIGN_PATTERNS.length; i++) {
      if (RESERVE_ASSIGN_PATTERNS[i].test(st)) return true;
    }
    return false;
  }

  /** Amazon assignment の serviceType から route vehicle type（routeCode 推測禁止） */
  function classifyRouteVehicleType(serviceType) {
    var st = String(serviceType || '');
    if (!st) return 'unknown';
    if (st.indexOf('Biker') >= 0) return 'bike';
    if (st.indexOf('Nursery') >= 0) return 'nursery';
    if (st.indexOf('Standard') >= 0) return 'standard';
    return 'unknown';
  }

  function filterWorkersByVehicleType(workers, routeVehicleType) {
    if (!routeVehicleType || routeVehicleType === 'unknown') return [];
    return (workers || []).filter(function (w) {
      var token = w.normalizedShiftToken || normalizeAssignShiftToken(w.shiftCode || '');
      if (routeVehicleType === 'bike') return token === 'bike';
      if (routeVehicleType === 'standard' || routeVehicleType === 'nursery') return token !== 'bike';
      return false;
    });
  }

  function normalizeAssignTargetDate(dateStr) {
    if (!dateStr) return '';
    var s = String(dateStr).trim();
    var m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) {
      return (
        m[1] +
        '-' +
        String(m[2]).padStart(2, '0') +
        '-' +
        String(m[3]).padStart(2, '0')
      );
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s;
  }

  /** Amazon Schedule (tenkoSchedule) 1件 → Auto Assign worker 行 */
  function extractShiftWorkersFromSchedule(scheduleEntries, transportIDs, resolveDriverKeyFn) {
    scheduleEntries = scheduleEntries || [];
    var workers = [];
    for (var i = 0; i < scheduleEntries.length; i++) {
      var se = scheduleEntries[i];
      var name = String(se.name || '').trim();
      if (!name || isShiftNonDriverRow(name)) continue;
      if (se.assignRole === 'reserve') continue;
      if (!se.shiftCode && !se.arrivalTime) continue;
      var tid = se.transportId ? String(se.transportId).trim() : '';
      if (!tid) {
        tid = resolveTransportIdForName(name, transportIDs || {}, resolveDriverKeyFn);
      }
      var driverName = resolveDriverKeyFn ? resolveDriverKeyFn(name) : name;
      workers.push({
        name: name,
        rawName: name,
        driverName: driverName,
        transportId: tid,
        shiftCode: se.shiftCode || '',
        arrivalTime: se.arrivalTime || '',
        assignRole: se.assignRole || 'regular',
        vehicleHint: se.vehicleHint || '',
        workerSource: 'amazon_schedule',
      });
    }
    return workers;
  }

  /**
   * Auto Assign 用: Amazon Schedule から対象日稼働者を抽出（TransportID必須）
   * shift file / DAシフト表は使用しない
   */
  function buildAssignWorkersFromAmazonSchedule(options) {
    options = options || {};
    var scheduleEntries = options.scheduleEntries || [];
    var scheduleMeta = options.scheduleMeta || null;
    var assignTargetDate = normalizeAssignTargetDate(options.assignTargetDate || '');
    var transportIDs = options.transportIDs || {};
    var resolveDriverKeyFn = options.resolveDriverKeyFn || null;

    var stats = {
      scheduleTotal: scheduleEntries.length,
      assignTargetDate: assignTargetDate,
      scheduleDate: scheduleMeta && scheduleMeta.targetDate ? normalizeAssignTargetDate(scheduleMeta.targetDate) : '',
      dateMismatch: false,
      excludedReserve: 0,
      excludedNoShift: 0,
      excludedNoTransportId: 0,
      candidateCount: 0,
      error: null,
    };

    if (!scheduleEntries.length) {
      stats.error = 'not_loaded';
      return {
        workers: [],
        stats: stats,
        linkStats: { mappedCount: 0, unmappedNames: [] },
      };
    }

    if (stats.scheduleDate && assignTargetDate && stats.scheduleDate !== assignTargetDate) {
      stats.dateMismatch = true;
      stats.error = 'date_mismatch';
      return {
        workers: [],
        stats: stats,
        linkStats: { mappedCount: 0, unmappedNames: [] },
      };
    }

    for (var ri = 0; ri < scheduleEntries.length; ri++) {
      var row = scheduleEntries[ri];
      if (row.assignRole === 'reserve') stats.excludedReserve++;
      else if (!row.shiftCode && !row.arrivalTime) stats.excludedNoShift++;
    }

    var rawWorkers = extractShiftWorkersFromSchedule(
      scheduleEntries,
      transportIDs,
      resolveDriverKeyFn
    );
    var enriched = enrichShiftWorkersWithTransportIds(rawWorkers, transportIDs, resolveDriverKeyFn);
    var filtered = filterShiftWorkers(enriched.workers);

    var candidates = [];
    var excludedNames = [];
    for (var wi = 0; wi < filtered.length; wi++) {
      var w = filtered[wi];
      if (!w.transportId) {
        stats.excludedNoTransportId++;
        excludedNames.push(w.driverName || w.name || '');
        continue;
      }
      candidates.push(w);
    }

    stats.candidateCount = candidates.length;
    return {
      workers: candidates,
      stats: stats,
      linkStats: {
        mappedCount: candidates.length,
        unmappedNames: excludedNames,
      },
    };
  }

  function mergeScheduleIntoShiftWorkers(shiftWorkers, scheduleEntries, transportIDs, resolveDriverKeyFn) {
    shiftWorkers = shiftWorkers || [];
    scheduleEntries = scheduleEntries || [];
    if (!scheduleEntries.length) return shiftWorkers.slice();

    var byName = {};
    for (var si = 0; si < scheduleEntries.length; si++) {
      var se = scheduleEntries[si];
      var key = String(se.name || '').trim();
      if (!key) continue;
      byName[key] = se;
    }

    var merged = [];
    var seen = {};
    for (var wi = 0; wi < shiftWorkers.length; wi++) {
      var w = shiftWorkers[wi];
      var name = String(w.driverName || w.name || '').trim();
      var sched = byName[name];
      var out = Object.assign({}, w);
      if (sched) {
        if (sched.shiftCode) out.shiftCode = sched.shiftCode;
        if (sched.transportId) out.transportId = sched.transportId;
        if (sched.arrivalTime) out.arrivalTime = sched.arrivalTime;
        if (sched.assignRole) out.assignRole = sched.assignRole;
        if (sched.vehicleHint) out.vehicleHint = sched.vehicleHint;
        out.workerSource = 'schedule+shift';
        seen[name] = true;
      } else {
        out.workerSource = out.workerSource || 'shift';
      }
      merged.push(out);
    }

    for (var sj = 0; sj < scheduleEntries.length; sj++) {
      var se2 = scheduleEntries[sj];
      var n2 = String(se2.name || '').trim();
      if (!n2 || seen[n2]) continue;
      var tid = se2.transportId || resolveTransportIdForName(n2, transportIDs || {}, resolveDriverKeyFn);
      merged.push({
        name: n2,
        driverName: n2,
        rawName: n2,
        transportId: tid,
        shiftCode: se2.shiftCode || '',
        arrivalTime: se2.arrivalTime || '',
        assignRole: se2.assignRole || 'regular',
        vehicleHint: se2.vehicleHint || '',
        workerSource: 'schedule',
      });
    }
    return merged;
  }

  /** Cycle3 は OFK3 運用ルールにより Standard のみ（assignmentData 不要） */
  function applyCycle3StandardRouteTypes(manifestRoutes) {
    return (manifestRoutes || []).map(function (route) {
      return Object.assign({}, route, {
        routeVehicleType: 'standard',
        amazonAssignment: null,
      });
    });
  }

  function enrichManifestRoutesWithAssignment(manifestRoutes, amazonAssignments) {
    var byRoute = {};
    for (var i = 0; i < (amazonAssignments || []).length; i++) {
      var a = amazonAssignments[i];
      if (a && a.routeCode) byRoute[a.routeCode] = a;
    }
    return (manifestRoutes || []).map(function (route) {
      var amz = byRoute[route.routeCode];
      var vehicleType = amz ? classifyRouteVehicleType(amz.serviceType) : 'unknown';
      return Object.assign({}, route, {
        routeVehicleType: vehicleType,
        amazonAssignment: amz
          ? {
              driverName: amz.driverName || '',
              serviceType: amz.serviceType || '',
              transportId: amz.transportId || '',
              amazonDaId: amz.amazonDaId || amz.daId || '',
              isReserve: !!amz.isReserve,
              departure: amz.departure || '',
              predictedEnd: amz.predictedEnd || '',
              totalDeliveries: amz.totalDeliveries != null ? amz.totalDeliveries : amz.packages,
              allDestinations: amz.allDestinations != null ? amz.allDestinations : amz.stops,
              capability: amz.capability,
              routeDuration: amz.routeDuration,
            }
          : null,
      });
    });
  }

  function evaluateAmazonAssignmentStatus(currentScore, bestAlternative, config) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    if (!currentScore || !currentScore.transportId) return 'admin_review';

    var currentTier = tierRank(currentScore.primaryTier);
    var currentDays = Number(currentScore.primaryExperienceDays) || 0;

    if (currentTier >= tierRank('B')) return 'ok';
    if (currentTier >= tierRank('C') && currentScore.primaryConfidence === 'high') return 'ok';
    if (
      currentDays >= config.TIER_D_MIN_DAYS &&
      currentScore.primaryConfidence === 'high' &&
      (!bestAlternative || tierRank(bestAlternative.primaryTier) < tierRank('B'))
    ) {
      return 'ok';
    }

    if (bestAlternative && isEligibleForFirstRecommendation(bestAlternative, config)) {
      var altTier = tierRank(bestAlternative.primaryTier);
      var altDays = Number(bestAlternative.primaryExperienceDays) || 0;
      if (currentDays === 0 && altDays >= config.TIER_B_MIN_DAYS) return 'change_candidate';
      if (currentTier <= tierRank('D') && altTier >= tierRank('B') && altDays - currentDays >= 10) {
        return 'change_candidate';
      }
      if (currentTier <= tierRank('C') && altTier >= tierRank('A') && altDays >= config.EXPERT_EXPERIENCE_DAYS) {
        return 'change_candidate';
      }
    }

    if (currentDays >= config.TIER_D_MIN_DAYS) return 'ok';
    if (!bestAlternative) return 'admin_review';
    if (currentDays <= 0) return 'admin_review';
    return 'ok';
  }

  function buildAmazonEvaluationReasons(currentScore, suggested, status, route, config, cycle) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    var reasons = [];
    reasons.push('Cycle：Cycle ' + cycle);
    if (route.routeVehicleType && route.routeVehicleType !== 'unknown') {
      reasons.push('Route種別：' + route.routeVehicleType);
    }
    if (route.amazonAssignment && route.amazonAssignment.driverName) {
      reasons.push('Amazonアサイン：' + route.amazonAssignment.driverName);
    }
    if (currentScore && currentScore.primaryArea) {
      reasons.push(
        '現在担当 主エリア：' +
          currentScore.primaryArea +
          ' ' +
          (currentScore.primaryExperienceDays || 0) +
          '日'
      );
      if (currentScore.primaryConfidence) reasons.push('confidence：' + currentScore.primaryConfidence);
    }
    if (status === 'change_candidate' && suggested) {
      reasons.push(
        '推奨変更：' +
          suggested.driverName +
          '（主' +
          (suggested.primaryExperienceDays || 0) +
          '日/Tier' +
          suggested.primaryTier +
          '）'
      );
      reasons.push('理由：主エリア経験差が明確');
    } else if (status === 'ok') {
      reasons.push('判定：Amazonアサイン良好・変更不要');
    } else {
      reasons.push('判定：管理者確認（適性評価不能または候補不足）');
    }
    return reasons;
  }

  function detectManifestCycleFromSources(sources) {
    sources = sources || [];
    var detected = [];
    for (var i = 0; i < sources.length; i++) {
      var src = sources[i] || {};
      var fromName = detectCycleFromFileName(src.fileName || src.name || src);
      if (fromName) detected.push(fromName);
      if (src.workbook && src.workbook.Props) {
        var meta = String(src.workbook.Props.Title || src.workbook.Props.Subject || '');
        var fromMeta = detectCycleFromFileName(meta);
        if (fromMeta) detected.push(fromMeta);
      }
    }
    if (!detected.length) return { cycle: null, ambiguous: false, source: null };
    var first = detected[0];
    for (var j = 1; j < detected.length; j++) {
      if (detected[j] !== first) return { cycle: null, ambiguous: true, source: 'filename' };
    }
    return { cycle: first, ambiguous: false, source: 'filename' };
  }

  /** 第一推奨アサイン用・経験Tier閾値（1か所で調整） */
  var ASSIGN_EXPERIENCE_CONFIG = {
    EXPERT_EXPERIENCE_DAYS: 20,
    TIER_B_MIN_DAYS: 10,
    TIER_C_MIN_DAYS: 5,
    TIER_D_MIN_DAYS: 1,
    MIN_SECONDARY_DAYS_FOR_WEAK_PRIMARY: 5,
  };

  /** コース交換最適化：僅差は変更不要。index.html の終了予測パラメータを再利用 */
  var SWAP_OPTIMIZE_CONFIG = {
    MIN_TOTAL_FINISH_IMPROVEMENT_MINUTES: 8,
    MAX_SINGLE_FINISH_WORSEN_MINUTES: 15,
    WORSEN_WARNING_MINUTES: 10,
    MIN_TIME_TO_OVERRIDE_EXPERIENCE_LOSS: 20,
    DEFAULT_PACKAGES_PER_HOUR: 16,
    DEFAULT_LOADING_MINUTES: 15,
    DEFAULT_TRAVEL_OUTBOUND: 20,
    DEFAULT_TRAVEL_RETURN: 20,
    DEFAULT_DEPARTURE: '09:00',
    MAX_SWAP_PAIRS: 10,
  };

  /** nursery ⇄ standard を許可するか。false にすると nursery は nursery 同士のみ */
  var VEHICLE_SWAP_CONFIG = {
    NURSERY_COMPATIBLE_WITH_STANDARD: true,
  };

  /**
   * エリア経験による実効速度のプラス補正。1.0未満にはしない。
   * 本番で強すぎる場合はこの定数だけ調整する。
   */
  var AREA_EXPERIENCE_SPEED_BONUS = {
    unknown: 1.0,
    weak: 1.02,
    medium: 1.04,
    strong: 1.06,
    veryStrong: 1.08,
    highConfidenceBonus: 0.02,
    primaryCountMediumBonus: 0.01,
    primaryCountStrongBonus: 0.02,
    volumeBonus: 0.01,
    maxBonus: 1.1,
    maxFactor: 1.1,
  };

  /**
   * エリア経験マスタの観測開始。現時点は W31 以降の蓄積のみ。
   * 過去データ復元時は START_WEEK / START_LABEL を更新する。
   */
  var AREA_EXPERIENCE_OBSERVATION = {
    START_WEEK: 'W31',
    START_LABEL: 'W31以降',
  };

  function normalizeRouteCode(routeCode) {
    return String(routeCode || '')
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  function isDcxRouteCode(routeCode) {
    return normalizeRouteCode(routeCode).indexOf('DCX') === 0;
  }

  function isDmxRouteCode(routeCode) {
    return normalizeRouteCode(routeCode).indexOf('DMX') === 0;
  }

  /**
   * Cycle 1 = DCX*（DCMRA/DCMRB除外）
   * Cycle 2 = DMX*（DMMRA/DMMRB除外）
   */
  function isOptimizationRoute(routeCode, cycle) {
    var code = normalizeRouteCode(routeCode);
    var c = Number(cycle);
    if (!code) return false;
    if (c === 1) {
      if (code.indexOf('DCMRA') === 0 || code.indexOf('DCMRB') === 0) return false;
      return code.indexOf('DCX') === 0;
    }
    if (c === 2) {
      if (code.indexOf('DMMRA') === 0 || code.indexOf('DMMRB') === 0) return false;
      return code.indexOf('DMX') === 0;
    }
    return false;
  }

  function optimizationRoutePrefixLabel(cycle) {
    if (Number(cycle) === 2) return 'DMX';
    return 'DCX';
  }

  /**
   * 最適化母集団：Amazonアサインxlsxに存在する GDS 担当route。
   * マニフェストのステーション全routeは件数把握とroute詳細取得に使う。
   */
  function collectGdsOptimizationPopulation(manifestRoutes, amazonAssignments, cycle) {
    var stationRoutes = [];
    var manifestByCode = {};
    for (var i = 0; i < (manifestRoutes || []).length; i++) {
      var route = manifestRoutes[i];
      if (!route || !isOptimizationRoute(route.routeCode, cycle)) continue;
      stationRoutes.push(route);
      manifestByCode[route.routeCode] = route;
    }

    var gdsByCode = {};
    for (var j = 0; j < (amazonAssignments || []).length; j++) {
      var a = amazonAssignments[j];
      if (!a || !a.routeCode) continue;
      if (!isOptimizationRoute(a.routeCode, cycle)) continue;
      gdsByCode[a.routeCode] = a;
    }

    var gdsRouteCodes = Object.keys(gdsByCode);
    var gdsAssignments = [];
    for (var k = 0; k < gdsRouteCodes.length; k++) {
      gdsAssignments.push(gdsByCode[gdsRouteCodes[k]]);
    }

    var gdsOutOfScopeRoutes = [];
    for (var s = 0; s < stationRoutes.length; s++) {
      var stationRoute = stationRoutes[s];
      if (gdsByCode[stationRoute.routeCode]) continue;
      gdsOutOfScopeRoutes.push({
        routeCode: stationRoute.routeCode,
        evaluationStatus: 'gds_out_of_scope',
        gdsScopeReason: 'GDSアサイン対象外',
        packages: stationRoute.packages,
        stops: stationRoute.stops,
        areas: stationRoute.areas || [],
      });
    }

    return {
      stationRoutes: stationRoutes,
      manifestByCode: manifestByCode,
      gdsByCode: gdsByCode,
      gdsAssignments: gdsAssignments,
      gdsOutOfScopeRoutes: gdsOutOfScopeRoutes,
      stationRouteCount: stationRoutes.length,
      gdsAssignmentCount: gdsRouteCodes.length,
      gdsOutOfScopeCount: gdsOutOfScopeRoutes.length,
    };
  }

  function normalizeSwapDriverName(name) {
    return String(name || '')
      .replace(/[\s\u3000]/g, '')
      .toLowerCase();
  }

  /** 同一人物の識別。TransportID → Amazon DA ID → 正規化氏名 */
  function swapDriverIdentityKey(slot) {
    if (!slot) return '';
    var tid = '';
    if (slot.score && slot.score.transportId) tid = String(slot.score.transportId).trim();
    if (!tid && slot.amz && slot.amz.transportId) tid = String(slot.amz.transportId).trim();
    if (!tid && slot.worker && slot.worker.transportId) tid = String(slot.worker.transportId).trim();
    if (tid) return 'tid:' + tid.toUpperCase();
    var da =
      (slot.amz && (slot.amz.amazonDaId || slot.amz.daId || slot.amz.associateId)) ||
      (slot.worker && slot.worker.amazonDaId) ||
      '';
    if (da) return 'da:' + String(da).trim().toUpperCase();
    var name = normalizeSwapDriverName(
      (slot.score && slot.score.driverName) ||
        (slot.amz && slot.amz.driverName) ||
        (slot.worker && (slot.worker.driverName || slot.worker.name)) ||
        ''
    );
    if (name) return 'name:' + name;
    return 'route:' + String((slot.route && slot.route.routeCode) || '');
  }

  function detectRouteDataAnomaly(route, amz) {
    var pkgs = routePackageCount({ amazonAssignment: amz, packages: route && route.packages });
    var stops = Number(route && route.stops);
    if (!(stops > 0) && amz && Number(amz.allDestinations) > 0) stops = Number(amz.allDestinations);
    var flags = [];
    if (pkgs > 0 && stops >= 10 && stops >= pkgs * 5) flags.push('stops_vs_packages');
    var vt = (route && route.routeVehicleType) || 'unknown';
    if (vt === 'unknown') flags.push('vehicle_unknown');
    return {
      hasAnomaly: flags.length > 0,
      flags: flags,
      warningLabel: flags.length ? '⚠️ routeデータ異常の可能性' : '',
    };
  }

  function getPrimaryExperienceTier(days, config) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    var d = Number(days) || 0;
    if (d >= config.EXPERT_EXPERIENCE_DAYS) return 'A';
    if (d >= config.TIER_B_MIN_DAYS) return 'B';
    if (d >= config.TIER_C_MIN_DAYS) return 'C';
    if (d >= config.TIER_D_MIN_DAYS) return 'D';
    return 'E';
  }

  function tierRank(tier) {
    var ranks = { A: 5, B: 4, C: 3, D: 2, E: 1 };
    return ranks[tier] || 0;
  }

  function confidenceRank(conf) {
    if (conf === 'high') return 2;
    if (conf === 'shared') return 1;
    return 0;
  }

  function resolveRouteAreaRoles(routeAreas) {
    var areas = routeAreas || [];
    var primary = null;
    var secondary = [];
    for (var i = 0; i < areas.length; i++) {
      if (areas[i].role === 'primary' && !primary) primary = areas[i];
      else secondary.push(areas[i]);
    }
    if (!primary && areas.length) primary = areas[0];
    if (primary && secondary.length === 0) {
      secondary = areas.filter(function (a) {
        return a !== primary;
      });
    }
    return { primary: primary, secondary: secondary };
  }

  function buildDriverRouteScore(worker, route, experienceEntry, options) {
    options = options || {};
    var config = options.experienceConfig || ASSIGN_EXPERIENCE_CONFIG;
    var routeAreas = route.areas || [];
    var roles = resolveRouteAreaRoles(routeAreas);
    var primaryLabel = roles.primary ? roles.primary.label : '';
    var primaryExp = primaryLabel && experienceEntry ? findExperienceForArea(experienceEntry, primaryLabel) : null;
    var primaryDays = primaryExp ? Number(primaryExp.experienceDays) || 0 : 0;
    var primaryTier = getPrimaryExperienceTier(primaryDays, config);
    var primaryConf = primaryExp ? String(primaryExp.confidence || '').trim() : '';
    if (!primaryConf && primaryExp) {
      if ((primaryExp.primaryCount || 0) > 0) primaryConf = 'high';
      else if ((primaryExp.splitCount || 0) > 0) primaryConf = 'shared';
    }

    var secondaryDetails = [];
    var secondaryDaysSum = 0;
    var secondaryExperiencedCount = 0;
    for (var si = 0; si < roles.secondary.length; si++) {
      var secLabel = roles.secondary[si].label;
      var secExp = experienceEntry ? findExperienceForArea(experienceEntry, secLabel) : null;
      var secDays = secExp ? Number(secExp.experienceDays) || 0 : 0;
      var secConf = secExp ? String(secExp.confidence || '').trim() : '';
      if (!secConf && secExp) {
        if ((secExp.primaryCount || 0) > 0) secConf = 'high';
        else if ((secExp.splitCount || 0) > 0) secConf = 'shared';
      }
      if (secDays > 0) {
        secondaryExperiencedCount++;
        secondaryDaysSum += secDays;
      }
      secondaryDetails.push({
        area: secLabel,
        experienceDays: secDays,
        confidence: secConf,
        lastVisitDate: secExp ? secExp.lastVisitDate || '' : '',
      });
    }

    var evalResult = evaluateDriverForRoute(worker, routeAreas, experienceEntry);
    var packages = Number(route.packages) || 0;
    var pph = null;
    if (typeof options.getPackagesPerHour === 'function') {
      pph = options.getPackagesPerHour(worker.driverName || worker.name, worker.transportId);
    }
    var estimatedDeliveryHours =
      pph != null && pph > 0 && packages > 0 ? packages / pph : null;
    var shiftToken =
      worker.normalizedShiftToken || normalizeAssignShiftToken(worker.shiftCode || '');

    return {
      transportId: worker.transportId,
      driverName: worker.driverName || worker.name,
      shiftCode: worker.shiftCode || '',
      shiftCodeDisplay: worker.shiftCodeDisplay || formatShiftTokenLabel(shiftToken) || worker.shiftCode || '',
      normalizedShiftToken: shiftToken,
      cycleEligibleLabel: options.cycle ? formatCycleEligibleLabel(shiftToken, options.cycle) : '',
      primaryArea: primaryLabel,
      primaryExperienceDays: primaryDays,
      primaryTier: primaryTier,
      primaryConfidence: primaryConf,
      experienceStatus: classifyExperienceEvidence(primaryDays).status,
      primaryCount: primaryExp ? Number(primaryExp.primaryCount) || 0 : 0,
      primarySplitCount: primaryExp ? Number(primaryExp.splitCount) || 0 : 0,
      primaryRescueCount: primaryExp ? Number(primaryExp.rescueCount) || 0 : 0,
      primaryStops: primaryExp ? Number(primaryExp.stops) || 0 : 0,
      primaryPackages: primaryExp ? Number(primaryExp.packages) || 0 : 0,
      primaryLastVisit: primaryExp ? primaryExp.lastVisitDate || '' : '',
      secondaryDetails: secondaryDetails,
      secondaryExperienceDays: secondaryDaysSum,
      secondaryExperiencedCount: secondaryExperiencedCount,
      packagesPerHour: pph,
      estimatedDeliveryHours: estimatedDeliveryHours,
      capabilityKnown: pph != null && isFinite(pph),
      areaResults: evalResult.areaResults,
      evalStatus: evalResult.status,
      latestVisitDate: evalResult.latestVisitDate || '',
    };
  }

  function isEligibleForFirstRecommendation(score, config) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    if (!score || !score.transportId) return false;
    if (tierRank(score.primaryTier) >= tierRank('D')) return true;
    if (score.secondaryExperienceDays >= config.MIN_SECONDARY_DAYS_FOR_WEAK_PRIMARY) return true;
    if (score.evalStatus === 'partial' && score.secondaryExperiencedCount > 0) return true;
    return false;
  }

  function compareDriverRouteScores(a, b) {
    var tierDiff = tierRank(b.primaryTier) - tierRank(a.primaryTier);
    if (tierDiff !== 0) return tierDiff;

    if (b.primaryExperienceDays !== a.primaryExperienceDays) {
      return b.primaryExperienceDays - a.primaryExperienceDays;
    }

    var confDiff = confidenceRank(b.primaryConfidence) - confidenceRank(a.primaryConfidence);
    if (confDiff !== 0) return confDiff;

    if (b.secondaryExperienceDays !== a.secondaryExperienceDays) {
      return b.secondaryExperienceDays - a.secondaryExperienceDays;
    }

    var visitCmp = (b.latestVisitDate || '').localeCompare(a.latestVisitDate || '');
    if (visitCmp !== 0) return visitCmp;

    var aCap = a.capabilityKnown ? 1 : 0;
    var bCap = b.capabilityKnown ? 1 : 0;
    if (bCap !== aCap) return bCap - aCap;

    if (a.capabilityKnown && b.capabilityKnown && b.packagesPerHour !== a.packagesPerHour) {
      return b.packagesPerHour - a.packagesPerHour;
    }
    return 0;
  }

  function countScarceTierCandidates(scored, tier) {
    var n = 0;
    for (var i = 0; i < scored.length; i++) {
      if (isEligibleForFirstRecommendation(scored[i]) && scored[i].primaryTier === tier) n++;
    }
    return n;
  }

  function countEligibleTierAtLeast(scored, minTier, config) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    var minRank = tierRank(minTier);
    var n = 0;
    for (var i = 0; i < scored.length; i++) {
      if (
        isEligibleForFirstRecommendation(scored[i], config) &&
        tierRank(scored[i].primaryTier) >= minRank
      ) {
        n++;
      }
    }
    return n;
  }

  function countPrimaryExperiencedEligible(scored, config) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    var n = 0;
    for (var i = 0; i < scored.length; i++) {
      if (
        isEligibleForFirstRecommendation(scored[i], config) &&
        (Number(scored[i].primaryExperienceDays) || 0) >= config.TIER_D_MIN_DAYS
      ) {
        n++;
      }
    }
    return n;
  }

  /** Cycle3 全体配車: コースの配車難易度（候補希少性中心） */
  function buildRouteDifficultyStats(scored, route, config) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    var secondaryExp = 0;
    for (var i = 0; i < scored.length; i++) {
      if (
        isEligibleForFirstRecommendation(scored[i], config) &&
        (Number(scored[i].secondaryExperiencedCount) || 0) > 0
      ) {
        secondaryExp++;
      }
    }
    return {
      tierACount: countScarceTierCandidates(scored, 'A'),
      tierBPlusCount: countEligibleTierAtLeast(scored, 'B', config),
      primaryExperiencedCount: countPrimaryExperiencedEligible(scored, config),
      secondaryExperiencedCount: secondaryExp,
      packages: Number(route.packages) || 0,
      eligibleCount: scored.filter(function (s) {
        return isEligibleForFirstRecommendation(s, config);
      }).length,
    };
  }

  function compareRouteAssignmentPriority(a, b) {
    var da = a.difficulty || {};
    var db = b.difficulty || {};
    if (da.tierACount !== db.tierACount) return da.tierACount - db.tierACount;
    if (da.tierBPlusCount !== db.tierBPlusCount) return da.tierBPlusCount - db.tierBPlusCount;
    if (da.primaryExperiencedCount !== db.primaryExperiencedCount) {
      return da.primaryExperiencedCount - db.primaryExperiencedCount;
    }
    if (da.packages !== db.packages) return db.packages - da.packages;
    return String(a.route.routeCode).localeCompare(String(b.route.routeCode));
  }

  function compareDriverRouteScoresWithTieBreak(a, b, route) {
    var cmp = compareDriverRouteScores(a, b);
    if (cmp !== 0) return cmp;
    var pkgs = route ? Number(route.packages) || 0 : 0;
    if (
      pkgs >= 70 &&
      a.capabilityKnown &&
      b.capabilityKnown &&
      a.estimatedDeliveryHours != null &&
      b.estimatedDeliveryHours != null &&
      a.estimatedDeliveryHours !== b.estimatedDeliveryHours
    ) {
      return a.estimatedDeliveryHours - b.estimatedDeliveryHours;
    }
    return String(a.transportId || '').localeCompare(String(b.transportId || ''));
  }

  function getUnassignedEligibleCandidates(scored, assignedTids, config) {
    return (scored || []).filter(function (c) {
      return (
        c.transportId &&
        !assignedTids[c.transportId] &&
        isEligibleForFirstRecommendation(c, config)
      );
    });
  }

  function findScarceReservationForCandidate(cand, currentRouteCode, pendingRouteWork, assignedTids, config) {
    if (!cand || !cand.transportId) return null;
    for (var i = 0; i < pendingRouteWork.length; i++) {
      var other = pendingRouteWork[i];
      if (other.vehicleUnknown) continue;
      if (other.route.routeCode === currentRouteCode) continue;
      var candOnOther = null;
      for (var j = 0; j < other.scored.length; j++) {
        if (other.scored[j].transportId === cand.transportId) candOnOther = other.scored[j];
      }
      if (!candOnOther || !isEligibleForFirstRecommendation(candOnOther, config)) continue;

      var pool = getUnassignedEligibleCandidates(other.scored, assignedTids, config);
      var tierAOnOther = pool.filter(function (c) {
        return c.primaryTier === 'A';
      });
      var tierBPlusOnOther = pool.filter(function (c) {
        return tierRank(c.primaryTier) >= tierRank('B');
      });

      if (candOnOther.primaryTier === 'A' && tierAOnOther.length === 1) {
        return {
          routeCode: other.route.routeCode,
          primaryArea: candOnOther.primaryArea || '',
          kind: 'only_tier_a',
        };
      }
      if (
        tierRank(candOnOther.primaryTier) >= tierRank('B') &&
        tierBPlusOnOther.length <= 2 &&
        (other.difficulty || {}).tierACount <= 2
      ) {
        return {
          routeCode: other.route.routeCode,
          primaryArea: candOnOther.primaryArea || '',
          kind: 'scarce_tier_b_plus',
        };
      }
    }
    return null;
  }

  function isViableLookaheadAlternative(top, alt, config) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    if (!alt || !top) return false;
    var tierGap = tierRank(top.primaryTier) - tierRank(alt.primaryTier);
    if (tierGap >= 2) return false;
    var dayGap = (Number(top.primaryExperienceDays) || 0) - (Number(alt.primaryExperienceDays) || 0);
    if (tierGap === 1 && dayGap > 10) return false;
    if (tierGap === 0 && dayGap > 6) return false;
    return tierRank(alt.primaryTier) >= tierRank('B') || (Number(alt.primaryExperienceDays) || 0) >= config.TIER_C_MIN_DAYS;
  }

  function selectFirstPickCycle3(rw, pendingRouteWork, assignedTids, config) {
    var pool = getUnassignedEligibleCandidates(rw.scored, assignedTids, config);
    pool.sort(function (a, b) {
      return compareDriverRouteScoresWithTieBreak(a, b, rw.route);
    });
    if (!pool.length) {
      return { pick: null, displacedCandidate: null, selectionReason: '', reservationReason: null };
    }

    var top = pool[0];
    var reservation = findScarceReservationForCandidate(
      top,
      rw.route.routeCode,
      pendingRouteWork,
      assignedTids,
      config
    );

    if (reservation) {
      for (var i = 1; i < pool.length; i++) {
        if (isViableLookaheadAlternative(top, pool[i], config)) {
          return {
            pick: pool[i],
            displacedCandidate: top,
            selectionReason:
              '上位候補' +
              top.driverName +
              'は' +
              reservation.routeCode +
              (reservation.primaryArea ? '（' + reservation.primaryArea + '）' : '') +
              'の希少熟練候補のため温存し、十分な経験を持つ本候補を推奨',
            reservationReason: reservation,
          };
        }
      }
    }

    var diff = rw.difficulty || {};
    var selectionReason =
      diff.tierACount <= 2
        ? 'このコースはTier A候補が' + diff.tierACount + '名のみのため優先確定'
        : '全体配車上、経験適合の最良候補を配置';

    return {
      pick: top,
      displacedCandidate: null,
      selectionReason: selectionReason,
      reservationReason: null,
    };
  }

  function buildUnusedWorkerDetails(eligibleWorkers, assignedTids, experienceDb, config, getPackagesPerHour) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    var details = [];
    for (var i = 0; i < (eligibleWorkers || []).length; i++) {
      var w = eligibleWorkers[i];
      if (!w.transportId || assignedTids[w.transportId]) continue;
      var expEntry = experienceDb.byTransportId[w.transportId];
      var tierAAreas = [];
      if (expEntry && expEntry.areas) {
        var keys = Object.keys(expEntry.areas);
        for (var k = 0; k < keys.length; k++) {
          var rec = expEntry.areas[keys[k]];
          var days = Number(rec.experienceDays) || 0;
          if (days >= config.EXPERT_EXPERIENCE_DAYS) tierAAreas.push(rec.area);
        }
      }
      var pph = null;
      if (typeof getPackagesPerHour === 'function') {
        pph = getPackagesPerHour(w.driverName || w.name, w.transportId);
      }
      details.push({
        driverName: w.driverName || w.name,
        transportId: w.transportId,
        tierAAreas: tierAAreas.slice(0, 4),
        packagesPerHour: pph,
      });
    }
    details.sort(function (a, b) {
      return String(a.transportId).localeCompare(String(b.transportId));
    });
    return details;
  }

  function buildFirstRecommendationReasons(pick, route, config, cycleOptions) {
    config = config || ASSIGN_EXPERIENCE_CONFIG;
    cycleOptions = cycleOptions || {};
    var reasons = [];
    var judgment = [];

    if (cycleOptions.cycle) {
      reasons.push('Cycle：Cycle ' + cycleOptions.cycle);
    }
    if (pick.shiftCodeDisplay || pick.shiftCode) {
      reasons.push('今日のシフト：' + (pick.shiftCodeDisplay || pick.shiftCode));
    }
    if (pick.cycleEligibleLabel) {
      reasons.push('Cycle適格：' + pick.cycleEligibleLabel);
    }

    if (pick.primaryArea) {
      reasons.push('主エリア：' + pick.primaryArea + ' ' + pick.primaryExperienceDays + '日');
    }
    if (pick.primaryConfidence) {
      reasons.push('confidence：' + pick.primaryConfidence);
    }
    if (pick.capabilityKnown) {
      reasons.push('能力：' + Number(pick.packagesPerHour).toFixed(1) + '個/h');
    }
    reasons.push('物量：' + (Number(route.packages) || 0) + '個');
    if (pick.estimatedDeliveryHours != null) {
      reasons.push('単純配送時間目安：約' + Number(pick.estimatedDeliveryHours).toFixed(1) + '時間');
    }

    var secParts = [];
    for (var i = 0; i < pick.secondaryDetails.length; i++) {
      var sd = pick.secondaryDetails[i];
      if (sd.experienceDays > 0) {
        secParts.push(sd.area + ' ' + sd.experienceDays + '日');
      }
    }
    if (secParts.length) {
      reasons.push('副エリア経験：' + secParts.join(' / '));
    }

    if (cycleOptions.cycle) {
      judgment.push('Cycle ' + cycleOptions.cycle + '適格');
    }
    if (pick.primaryExperienceDays >= config.EXPERT_EXPERIENCE_DAYS) {
      judgment.push('主エリア熟練（' + config.EXPERT_EXPERIENCE_DAYS + '日以上）');
    } else if (pick.primaryExperienceDays >= config.TIER_B_MIN_DAYS) {
      judgment.push('主エリア経験あり（' + config.TIER_B_MIN_DAYS + '日以上）');
    } else if (pick.primaryExperienceDays >= config.TIER_D_MIN_DAYS) {
      judgment.push('主エリア経験浅い');
    }
    if (secParts.length) judgment.push('主要副エリア経験あり');
    if (pick.capabilityKnown) judgment.push('物量に対する能力適合（参考）');

    reasons.push('判定：' + (judgment.length ? judgment.join('＋') : '経験・能力から適合'));
    if (cycleOptions.selectionReason) {
      reasons.push('全体配車判断：' + cycleOptions.selectionReason);
    }
    if (cycleOptions.displacedCandidate && cycleOptions.displacedCandidate.driverName) {
      reasons.push('通常1位候補：' + cycleOptions.displacedCandidate.driverName + '（温存）');
    }
    return reasons;
  }

  /**
   * Phase 1.5: 経験優先 + greedy 全体配分で第一推奨を1名ずつ決定（Cycle 3）
   */
  function buildFirstAssignPlan(manifestRoutes, shiftWorkers, experienceDb, options) {
    options = options || {};
    var cycle = Number(options.cycle);
    if (!cycle || cycle < 1 || cycle > 3) {
      return {
        mode: 'first_pick',
        cycleError: 'CYCLE_UNKNOWN',
        routes: [],
        summary: {
          confirmedCount: 0,
          adminReviewCount: 0,
          unusedWorkerCount: 0,
          unusedWorkers: [],
          totalRoutes: 0,
        },
        cycleEligibility: null,
        experienceConfig: Object.assign({}, ASSIGN_EXPERIENCE_CONFIG, options.experienceConfig || {}),
      };
    }

    var config = Object.assign({}, ASSIGN_EXPERIENCE_CONFIG, options.experienceConfig || {});
    var workers = filterShiftWorkers(shiftWorkers);
    var cycleFilter = filterWorkersByCycleEligibility(workers, cycle);
    var eligibleWorkers = cycleFilter.eligible;
    var enrichedRoutes =
      cycle === 3
        ? applyCycle3StandardRouteTypes(manifestRoutes)
        : options.amazonAssignments && options.amazonAssignments.length
          ? enrichManifestRoutesWithAssignment(manifestRoutes, options.amazonAssignments)
          : manifestRoutes;
    var planOptions = {
      rescueReserveCount: options.rescueReserveCount,
      experienceConfig: config,
      getPackagesPerHour: options.getPackagesPerHour,
      cycle: cycle,
    };

    var suggestions = buildAssignSuggestions(enrichedRoutes, eligibleWorkers, experienceDb, planOptions);
    var suggestionByRoute = {};
    for (var si = 0; si < suggestions.length; si++) {
      suggestionByRoute[suggestions[si].routeCode] = suggestions[si];
    }

    var routeWork = [];
    for (var ri = 0; ri < enrichedRoutes.length; ri++) {
      var route = enrichedRoutes[ri];
      if (!route.areas || !route.areas.length) continue;
      var routeVehicleType = route.routeVehicleType || 'unknown';
      if (routeVehicleType === 'unknown') {
        routeWork.push({
          route: route,
          scored: [],
          vehicleUnknown: true,
          tierACount: 0,
          tierBCount: 0,
          eligibleCount: 0,
        });
        continue;
      }
      var vehicleWorkers = filterWorkersByVehicleType(eligibleWorkers, routeVehicleType).filter(function (w) {
        return w.assignRole !== 'reserve';
      });
      var scored = [];
      for (var wi = 0; wi < vehicleWorkers.length; wi++) {
        var worker = vehicleWorkers[wi];
        if (!worker.transportId) continue;
        var expEntry = experienceDb.byTransportId[worker.transportId];
        scored.push(buildDriverRouteScore(worker, route, expEntry, planOptions));
      }
      scored.sort(function (a, b) {
        return compareDriverRouteScoresWithTieBreak(a, b, route);
      });
      var difficulty =
        cycle === 3 ? buildRouteDifficultyStats(scored, route, config) : buildRouteDifficultyStats(scored, route, config);
      routeWork.push({
        route: route,
        scored: scored,
        difficulty: difficulty,
        tierACount: difficulty.tierACount,
        tierBCount: countScarceTierCandidates(scored, 'B'),
        tierBPlusCount: difficulty.tierBPlusCount,
        eligibleCount: difficulty.eligibleCount,
      });
    }

    routeWork.sort(function (a, b) {
      if (cycle === 3) return compareRouteAssignmentPriority(a, b);
      if (a.tierACount !== b.tierACount) return a.tierACount - b.tierACount;
      if (a.tierBCount !== b.tierBCount) return a.tierBCount - b.tierBCount;
      if (a.eligibleCount !== b.eligibleCount) return a.eligibleCount - b.eligibleCount;
      return String(a.route.routeCode).localeCompare(b.route.routeCode);
    });

    var assignedTids = {};
    var routesOut = [];
    var confirmedCount = 0;
    var adminReviewCount = 0;
    var tierAssignmentCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    var unexperiencedPlacements = 0;
    var sharedConfidenceOnly = 0;

    for (var rwi = 0; rwi < routeWork.length; rwi++) {
      var rw = routeWork[rwi];
      var routeCode = rw.route.routeCode;
      var base = suggestionByRoute[routeCode] || {
        routeCode: routeCode,
        packages: rw.route.packages,
        stops: rw.route.stops,
        areas: rw.route.areas,
        recommended: [],
        partial: [],
        unexperienced: [],
        noExperiencedDriver: true,
      };

      var firstPick = null;
      var selectionMeta = {
        displacedCandidate: null,
        selectionReason: '',
        reservationReason: null,
      };
      var needsAdminReview = !!rw.vehicleUnknown;
      var adminReviewReason = rw.vehicleUnknown ? 'Bike/Standard判定不能' : '';

      if (!rw.vehicleUnknown) {
        if (cycle === 3) {
          var pendingRoutes = routeWork.slice(rwi + 1);
          var picked = selectFirstPickCycle3(rw, pendingRoutes, assignedTids, config);
          firstPick = picked.pick;
          selectionMeta = picked;
          if (!firstPick) {
            needsAdminReview = true;
            adminReviewReason = '安全な候補を特定できない';
          }
        } else {
          for (var pi = 0; pi < rw.scored.length; pi++) {
            var cand = rw.scored[pi];
            if (assignedTids[cand.transportId]) continue;
            if (!isEligibleForFirstRecommendation(cand, config)) continue;
            firstPick = cand;
            break;
          }
          if (!firstPick) {
            needsAdminReview = true;
            adminReviewReason = '主エリア経験者なし';
          }
        }
        if (firstPick) assignedTids[firstPick.transportId] = true;
      }

      if (firstPick) confirmedCount++;
      else adminReviewCount++;

      if (firstPick) {
        var pt = firstPick.primaryTier || 'E';
        if (tierAssignmentCounts[pt] !== undefined) tierAssignmentCounts[pt]++;
        if ((Number(firstPick.primaryExperienceDays) || 0) < config.TIER_D_MIN_DAYS) unexperiencedPlacements++;
        if (firstPick.primaryConfidence === 'shared') sharedConfidenceOnly++;
      }

      var otherCandidates = [];
      for (var oi = 0; oi < rw.scored.length; oi++) {
        var oc = rw.scored[oi];
        if (firstPick && oc.transportId === firstPick.transportId) continue;
        if (oc.evalStatus === 'recommended' || oc.evalStatus === 'partial') {
          otherCandidates.push({
            transportId: oc.transportId,
            driverName: oc.driverName,
            primaryTier: oc.primaryTier,
            primaryExperienceDays: oc.primaryExperienceDays,
          });
        }
      }

      routesOut.push({
        routeCode: base.routeCode,
        packages: base.packages,
        stops: base.stops,
        areas: base.areas,
        routeVehicleType: rw.route.routeVehicleType || 'unknown',
        routeDifficulty: rw.difficulty || null,
        recommended: base.recommended,
        partial: base.partial,
        unexperienced: base.unexperienced,
        noExperiencedDriver: base.noExperiencedDriver,
        rescueReserveCount: base.rescueReserveCount,
        firstRecommendation: firstPick
          ? {
              transportId: firstPick.transportId,
              driverName: firstPick.driverName,
              shiftCode: firstPick.shiftCode,
              primaryArea: firstPick.primaryArea,
              primaryExperienceDays: firstPick.primaryExperienceDays,
              primaryTier: firstPick.primaryTier,
              primaryConfidence: firstPick.primaryConfidence,
              packagesPerHour: firstPick.packagesPerHour,
              estimatedDeliveryHours: firstPick.estimatedDeliveryHours,
              secondaryDetails: firstPick.secondaryDetails,
              displacedCandidate: selectionMeta.displacedCandidate
                ? {
                    transportId: selectionMeta.displacedCandidate.transportId,
                    driverName: selectionMeta.displacedCandidate.driverName,
                    primaryTier: selectionMeta.displacedCandidate.primaryTier,
                    primaryExperienceDays: selectionMeta.displacedCandidate.primaryExperienceDays,
                  }
                : null,
              selectionReason: selectionMeta.selectionReason || '',
              reservationReason: selectionMeta.reservationReason,
              reasons: buildFirstRecommendationReasons(firstPick, rw.route, config, {
                cycle: cycle,
                selectionReason: selectionMeta.selectionReason,
                displacedCandidate: selectionMeta.displacedCandidate,
              }),
            }
          : null,
        needsAdminReview: needsAdminReview,
        adminReviewReason: needsAdminReview ? adminReviewReason : '',
        vehicleUnknown: !!rw.vehicleUnknown,
        otherCandidates: otherCandidates,
        candidateCount: rw.difficulty ? rw.difficulty.eligibleCount : rw.eligibleCount,
        processingOrder: rwi + 1,
      });
    }

    routesOut.sort(function (a, b) {
      return String(a.routeCode).localeCompare(b.routeCode);
    });

    var unusedWorkerDetails = buildUnusedWorkerDetails(
      eligibleWorkers,
      assignedTids,
      experienceDb,
      config,
      planOptions.getPackagesPerHour
    );

    return {
      mode: 'first_pick',
      routes: routesOut,
      summary: {
        confirmedCount: confirmedCount,
        adminReviewCount: adminReviewCount,
        unusedWorkerCount: unusedWorkerDetails.length,
        unusedWorkers: unusedWorkerDetails.map(function (u) {
          return u.driverName;
        }),
        unusedWorkerDetails: unusedWorkerDetails,
        totalRoutes: routesOut.length,
        tierAAssignments: tierAssignmentCounts.A,
        tierBAssignments: tierAssignmentCounts.B,
        tierCOrLowerAssignments:
          tierAssignmentCounts.C + tierAssignmentCounts.D + tierAssignmentCounts.E,
        unexperiencedPlacements: unexperiencedPlacements,
        sharedConfidenceOnly: sharedConfidenceOnly,
      },
      cycle: cycle,
      cycleEligibility: cycleFilter.stats,
      experienceConfig: config,
    };
  }

  function parseTimeToMinutes(hhmm) {
    var m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
    if (!m) return -1;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function formatMinutesToTime(totalMin) {
    var n = Math.round(Number(totalMin) || 0);
    if (n < 0) n = 0;
    var h = Math.floor(n / 60);
    var mm = n % 60;
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  /** index.html calculateEndTime と同じ能力補正（終了予測用） */
  function adjustCapabilityForFinishEstimate(capability) {
    var cap = Number(capability);
    if (!(cap > 0)) return 0;
    if (cap >= 30) return cap;
    if (cap >= 25) return cap + 1;
    if (cap >= 20) return cap + 2.5;
    if (cap >= 15) return cap + 3;
    if (cap >= 10) return cap + 3.5;
    if (cap >= 5) return cap + 4;
    return cap;
  }

  /**
   * 主エリア経験による実効速度係数。
   * experienceDays=0 は未経験ではなく観測なし（neutral）。マイナス補正しない。
   * 1日以上の観測実績のみプラス方向の根拠として使う。
   */
  function classifyExperienceEvidence(days) {
    var n = Number(days) || 0;
    var start = AREA_EXPERIENCE_OBSERVATION.START_LABEL;
    if (n <= 0) {
      return { status: 'unknown', band: 0, days: 0, label: '確認なし（' + start + '）' };
    }
    if (n <= 2) return { status: 'weak', band: 1, days: n, label: n + '日' };
    if (n <= 5) return { status: 'clear', band: 2, days: n, label: n + '日' };
    if (n <= 9) return { status: 'strong', band: 3, days: n, label: n + '日' };
    return { status: 'very_strong', band: 4, days: n, label: n + '日' };
  }

  function formatExperienceDaysDisplay(days) {
    return classifyExperienceEvidence(days).label;
  }

  function formatExperienceEvidenceLine(area, days) {
    var ev = classifyExperienceEvidence(days);
    var areaLabel = area || '?';
    if (ev.status === 'unknown') return areaLabel + '　経験確認なし（' + AREA_EXPERIENCE_OBSERVATION.START_LABEL + '）';
    return areaLabel + '　' + ev.days + '日';
  }

  function experienceSpeedFactor(score) {
    var bonus = AREA_EXPERIENCE_SPEED_BONUS;
    var days = Number(score && score.primaryExperienceDays) || 0;
    var evidence = classifyExperienceEvidence(days);
    var factor = bonus.unknown;
    if (evidence.band === 1) factor = bonus.weak;
    else if (evidence.band === 2) factor = bonus.medium;
    else if (evidence.band === 3) factor = bonus.strong;
    else if (evidence.band >= 4) factor = bonus.veryStrong;

    if (evidence.band > 0) {
      var primaryCount = Number(score && score.primaryCount) || 0;
      var conf = confidenceRank(score && score.primaryConfidence);
      var volume = (Number(score && score.primaryStops) || 0) + (Number(score && score.primaryPackages) || 0);
      if (primaryCount >= 8) factor += bonus.primaryCountStrongBonus;
      else if (primaryCount >= 3) factor += bonus.primaryCountMediumBonus;
      if (conf >= 2) factor += bonus.highConfidenceBonus;
      if (volume >= 500) factor += bonus.volumeBonus;
    }
    if (factor < bonus.unknown) factor = bonus.unknown;
    if (factor > bonus.maxFactor) factor = bonus.maxFactor;
    return factor;
  }

  function areaFitScore(score) {
    var days = Number(score && score.primaryExperienceDays) || 0;
    if (days <= 0) return 0;
    var primaryCount = Number(score && score.primaryCount) || 0;
    var conf = confidenceRank(score && score.primaryConfidence);
    var volume = Math.log(
      1 + (Number(score && score.primaryStops) || 0) + (Number(score && score.primaryPackages) || 0)
    );
    var secondary = Number(score && score.secondaryExperienceDays) || 0;
    return days * 10 + primaryCount * 3 + conf * 4 + volume + secondary * 0.3;
  }

  function resolvePackagesPerHour(score, options) {
    var pph = score && score.packagesPerHour;
    if (pph > 0) return pph;
    return (options && options.defaultPackagesPerHour) || SWAP_OPTIMIZE_CONFIG.DEFAULT_PACKAGES_PER_HOUR;
  }

  /** 純粋な配送処理時間（分）。積込・往復は含まない。 */
  function estimateDeliveryDurationMinutes(score, packages, options) {
    options = options || {};
    var pkgs = Number(packages) || 0;
    if (pkgs <= 0) return 0;
    var pph = resolvePackagesPerHour(score, options);
    var factor = experienceSpeedFactor(score);
    var adjusted = adjustCapabilityForFinishEstimate(pph) * factor;
    if (!(adjusted > 0)) return 0;
    return (pkgs / adjusted) * 60;
  }

  function estimateDeliveryMinutes(score, packages, options) {
    return estimateDeliveryDurationMinutes(score, packages, options);
  }

  function effectivePackagesPerHour(score, options) {
    var pph = resolvePackagesPerHour(score, options);
    return adjustCapabilityForFinishEstimate(pph) * experienceSpeedFactor(score);
  }

  function routePackageCount(route) {
    var amz = route && route.amazonAssignment;
    if (amz && amz.totalDeliveries != null && Number(amz.totalDeliveries) > 0) {
      return Number(amz.totalDeliveries);
    }
    return Number(route && route.packages) || 0;
  }

  function estimatePredictedFinishMinutes(route, score, options) {
    options = options || {};
    var cfg = SWAP_OPTIMIZE_CONFIG;
    var loading = Number(options.loadingTime);
    if (!isFinite(loading)) loading = cfg.DEFAULT_LOADING_MINUTES;
    var outbound = Number(options.travelOutbound);
    if (!isFinite(outbound)) outbound = cfg.DEFAULT_TRAVEL_OUTBOUND;
    var ret = Number(options.travelReturn);
    if (!isFinite(ret)) ret = cfg.DEFAULT_TRAVEL_RETURN;
    var amz = route && route.amazonAssignment;
    var packages = routePackageCount(route);
    var dep = (amz && amz.departure) || options.defaultDeparture || cfg.DEFAULT_DEPARTURE;
    var depMin = parseTimeToMinutes(dep);
    if (depMin < 0) depMin = parseTimeToMinutes(cfg.DEFAULT_DEPARTURE);
    var deliveryDurationMinutes = estimateDeliveryDurationMinutes(score, packages, options);
    if (!(deliveryDurationMinutes > 0) && amz && Number(amz.routeDuration) > 0) {
      deliveryDurationMinutes = Number(amz.routeDuration);
    }
    return depMin + loading + outbound + deliveryDurationMinutes + ret;
  }

  function finishMinutesForPairing(route, currentScore, newScore, options) {
    var amz = route && route.amazonAssignment;
    var baseline = amz ? parseTimeToMinutes(amz.predictedEnd) : -1;
    var packages = routePackageCount(route);
    if (baseline >= 0 && currentScore) {
      var curDel = estimateDeliveryDurationMinutes(currentScore, packages, options);
      var newDel = estimateDeliveryDurationMinutes(newScore, packages, options);
      return baseline + (newDel - curDel);
    }
    return estimatePredictedFinishMinutes(route, newScore, options);
  }

  function resolveVehicleKind(route, worker) {
    var vt = route && route.routeVehicleType;
    if (vt === 'bike' || vt === 'standard' || vt === 'nursery') return vt;
    var token = '';
    if (worker) {
      token = worker.normalizedShiftToken || normalizeAssignShiftToken(worker.shiftCode || '');
    }
    if (token === 'bike') return 'bike';
    if (token) return 'standard';
    return 'unknown';
  }

  function vehicleKindToSwapGroup(kind, vehicleConfig) {
    var cfg = Object.assign({}, VEHICLE_SWAP_CONFIG, vehicleConfig || {});
    if (kind === 'bike') return 'bike';
    if (kind === 'standard') return 'standard';
    if (kind === 'nursery') {
      return cfg.NURSERY_COMPATIBLE_WITH_STANDARD ? 'standard' : 'nursery';
    }
    return 'unknown';
  }

  function resolveVehicleSwapGroup(route, worker, vehicleConfig) {
    return vehicleKindToSwapGroup(resolveVehicleKind(route, worker), vehicleConfig);
  }

  function canSwapVehicleGroups(groupA, groupB) {
    if (!groupA || !groupB || groupA === 'unknown' || groupB === 'unknown') return false;
    if (groupA === 'bike' && groupB === 'bike') return true;
    if (groupA === 'standard' && groupB === 'standard') return true;
    if (groupA === 'nursery' && groupB === 'nursery') return true;
    return false;
  }

  function classifySwapWorsenWarning(worsenA, worsenB, cfg) {
    cfg = cfg || SWAP_OPTIMIZE_CONFIG;
    var maxWorsen = Math.max(Number(worsenA) || 0, Number(worsenB) || 0, 0);
    var warnAt = cfg.WORSEN_WARNING_MINUTES || 10;
    var limit = cfg.MAX_SINGLE_FINISH_WORSEN_MINUTES || 15;
    if (maxWorsen < warnAt) return null;
    if (maxWorsen >= limit) {
      return {
        level: 'near_limit',
        message: '⚠️ 悪化上限に近い交換です',
        maxWorsenMinutes: maxWorsen,
      };
    }
    return {
      level: 'worsen_10plus',
      message: '⚠️ 一方のドライバーが10分以上悪化します',
      maxWorsenMinutes: maxWorsen,
    };
  }

  function findAssignedWorker(workers, amz) {
    if (!amz) return null;
    workers = workers || [];
    var i;
    if (amz.transportId) {
      for (i = 0; i < workers.length; i++) {
        if (workers[i].transportId && workers[i].transportId === amz.transportId) return workers[i];
      }
    }
    var target = String(amz.driverName || '').replace(/\s+/g, '');
    if (target) {
      for (i = 0; i < workers.length; i++) {
        var n = String(workers[i].driverName || workers[i].name || '').replace(/\s+/g, '');
        if (n && n === target) return workers[i];
      }
    }
    return null;
  }

  function losesStrongObservedExperience(fromScore, toScore) {
    var from = classifyExperienceEvidence(fromScore && fromScore.primaryExperienceDays);
    var to = classifyExperienceEvidence(toScore && toScore.primaryExperienceDays);
    return from.band >= 3 && to.band === 0;
  }

  function buildSwapReason(evalResult, slotA, slotB) {
    var expGain = (evalResult.experienceImprovement || 0) > 0.5;
    var fromA = classifyExperienceEvidence(slotA.score.primaryExperienceDays);
    var toA = classifyExperienceEvidence(slotA.scoreOnPartner && slotA.scoreOnPartner.primaryExperienceDays);
    var fromB = classifyExperienceEvidence(slotB.score.primaryExperienceDays);
    var toB = classifyExperienceEvidence(slotB.scoreOnPartner && slotB.scoreOnPartner.primaryExperienceDays);
    var bothUnknown =
      fromA.status === 'unknown' &&
      toA.status === 'unknown' &&
      fromB.status === 'unknown' &&
      toB.status === 'unknown';
    if (expGain) return '終了時間短縮 + エリア経験適合';
    if (bothUnknown) return 'ドライバー能力・PPHとroute負荷による終了時間短縮';
    return 'ドライバー能力・PPHとroute負荷による終了時間短縮';
  }

  function evaluateSwapPair(slotA, slotB, options) {
    options = options || {};
    var cfg = Object.assign({}, SWAP_OPTIMIZE_CONFIG, options.swapConfig || {});
    var afterAonB = Math.round(finishMinutesForPairing(slotB.route, slotB.score, slotA.scoreOnPartner, options));
    var afterBonA = Math.round(finishMinutesForPairing(slotA.route, slotA.score, slotB.scoreOnPartner, options));
    var beforeSum = slotA.finishMinutes + slotB.finishMinutes;
    var afterSum = afterAonB + afterBonA;
    var timeImprovement = beforeSum - afterSum;
    var worsenA = afterAonB - slotA.finishMinutes;
    var worsenB = afterBonA - slotB.finishMinutes;
    var expBefore = slotA.areaScore + slotB.areaScore;
    var expAfter = areaFitScore(slotA.scoreOnPartner) + areaFitScore(slotB.scoreOnPartner);
    var beforeMax = Math.max(slotA.finishMinutes, slotB.finishMinutes);
    var afterMax = Math.max(afterAonB, afterBonA);
    var loseStrong =
      losesStrongObservedExperience(slotA.score, slotA.scoreOnPartner) ||
      losesStrongObservedExperience(slotB.score, slotB.scoreOnPartner);
    var overrideMin = cfg.MIN_TIME_TO_OVERRIDE_EXPERIENCE_LOSS || 20;

    var rejectedReason = '';
    if (!canSwapVehicleGroups(slotA.vehicleGroup, slotB.vehicleGroup)) {
      rejectedReason = 'vehicle_mismatch';
    } else if (
      worsenA > cfg.MAX_SINGLE_FINISH_WORSEN_MINUTES ||
      worsenB > cfg.MAX_SINGLE_FINISH_WORSEN_MINUTES
    ) {
      rejectedReason = 'one_side_worsens';
    } else if (timeImprovement < cfg.MIN_TOTAL_FINISH_IMPROVEMENT_MINUTES) {
      rejectedReason = 'below_threshold';
    } else if (loseStrong && timeImprovement < overrideMin) {
      rejectedReason = 'experience_loss_for_slight_gain';
    }

    var evalResult = {
      accepted: !rejectedReason,
      rejectedReason: rejectedReason,
      timeImprovement: timeImprovement,
      maxFinishImprovement: beforeMax - afterMax,
      experienceImprovement: expAfter - expBefore,
      beforeScore: beforeSum,
      afterScore: afterSum,
      improvement: timeImprovement,
      afterFinishAMinutes: afterAonB,
      afterFinishBMinutes: afterBonA,
      afterFinishATime: formatMinutesToTime(afterAonB),
      afterFinishBTime: formatMinutesToTime(afterBonA),
      driverAImprovement: slotA.finishMinutes - afterAonB,
      driverBImprovement: slotB.finishMinutes - afterBonA,
    };
    evalResult.reason = buildSwapReason(evalResult, slotA, slotB);
    evalResult.worsenAMinutes = worsenA;
    evalResult.worsenBMinutes = worsenB;
    evalResult.worsenWarning = classifySwapWorsenWarning(worsenA, worsenB, cfg);
    return evalResult;
  }

  function buildDriverSwapSide(slot, partnerSlot, scoreOnPartner, afterFinishTime, improvementMinutes, options) {
    var pkgsFrom = routePackageCount(slot.route);
    var pkgsTo = routePackageCount(partnerSlot.route);
    var pph = resolvePackagesPerHour(slot.score, options);
    var fromFactor = experienceSpeedFactor(slot.score);
    var toFactor = experienceSpeedFactor(scoreOnPartner);
    return {
      driverName: slot.score.driverName,
      transportId: slot.score.transportId,
      fromRouteCode: slot.route.routeCode,
      toRouteCode: partnerSlot.route.routeCode,
      fromArea: slot.score.primaryArea || '',
      toArea: partnerSlot.score.primaryArea || '',
      fromExperienceDays: slot.score.primaryExperienceDays || 0,
      toExperienceDays: (scoreOnPartner && scoreOnPartner.primaryExperienceDays) || 0,
      fromExperienceLabel: formatExperienceDaysDisplay(slot.score.primaryExperienceDays || 0),
      toExperienceLabel: formatExperienceDaysDisplay((scoreOnPartner && scoreOnPartner.primaryExperienceDays) || 0),
      fromExperienceLine: formatExperienceEvidenceLine(
        slot.score.primaryArea || '',
        slot.score.primaryExperienceDays || 0
      ),
      toExperienceLine: formatExperienceEvidenceLine(
        partnerSlot.score.primaryArea || '',
        (scoreOnPartner && scoreOnPartner.primaryExperienceDays) || 0
      ),
      fromPrimaryCount: slot.score.primaryCount || 0,
      toPrimaryCount: (scoreOnPartner && scoreOnPartner.primaryCount) || 0,
      fromFinishTime: slot.finishTime,
      toFinishTime: afterFinishTime,
      fromPredictedFinishTime: slot.finishTime,
      toPredictedFinishTime: afterFinishTime,
      improvementMinutes: improvementMinutes,
      packagesPerHour: pph,
      fromExperienceSpeedFactor: fromFactor,
      toExperienceSpeedFactor: toFactor,
      fromDeliveryDurationMinutes: Math.round(estimateDeliveryDurationMinutes(slot.score, pkgsFrom, options)),
      toDeliveryDurationMinutes: Math.round(estimateDeliveryDurationMinutes(scoreOnPartner, pkgsTo, options)),
      routePackagesFrom: pkgsFrom,
      routePackagesTo: pkgsTo,
      routeStopsFrom: Number(slot.route.stops) || 0,
      routeStopsTo: Number(partnerSlot.route.stops) || 0,
      primaryConfidence: slot.score.primaryConfidence || '',
      toPrimaryConfidence: (scoreOnPartner && scoreOnPartner.primaryConfidence) || '',
      vehicleKind: slot.vehicleKind || resolveVehicleKind(slot.route, slot.worker),
    };
  }

  function buildSwapProposal(slotA, slotB, evalResult, pairIndex, options) {
    return {
      pairIndex: pairIndex,
      routeCodeA: slotA.route.routeCode,
      routeCodeB: slotB.route.routeCode,
      reason: evalResult.reason || buildSwapReason(evalResult, slotA, slotB),
      driverA: buildDriverSwapSide(
        slotA,
        slotB,
        slotA.scoreOnPartner,
        evalResult.afterFinishATime,
        evalResult.driverAImprovement,
        options
      ),
      driverB: buildDriverSwapSide(
        slotB,
        slotA,
        slotB.scoreOnPartner,
        evalResult.afterFinishBTime,
        evalResult.driverBImprovement,
        options
      ),
      totalImprovementMinutes: evalResult.timeImprovement,
      beforeScore: evalResult.beforeScore,
      afterScore: evalResult.afterScore,
      improvement: evalResult.improvement,
      judgment: 'swap_recommended',
      vehicleGroup: slotA.vehicleGroup,
      vehicleKindA: slotA.vehicleKind || resolveVehicleKind(slotA.route, slotA.worker),
      vehicleKindB: slotB.vehicleKind || resolveVehicleKind(slotB.route, slotB.worker),
      worsenWarning: evalResult.worsenWarning || null,
      driverAImprovement: evalResult.driverAImprovement,
      driverBImprovement: evalResult.driverBImprovement,
      routeDataAnomaly:
        (slotA.baseRow && slotA.baseRow.routeDataAnomaly) ||
        (slotB.baseRow && slotB.baseRow.routeDataAnomaly) ||
        null,
    };
  }

  /**
   * Phase 1.7: Cycle 1/2 — GDS Amazonアサインを母集団とし、
   * 同一CycleのGDS担当ルート同士のコース交換で終了時間短縮が見込める組だけ提案する。
   * マニフェストはroute詳細（荷物・stops・エリア）の取得に使う。
   * Cycle 1 = GDS DCX* / Cycle 2 = GDS DMX*
   */
  function buildAmazonAssignEvaluationPlan(manifestRoutes, shiftWorkers, experienceDb, options) {
    options = options || {};
    var emptySummary = {
      okCount: 0,
      changeCandidateCount: 0,
      adminReviewCount: 0,
      inputMissingCount: 0,
      totalRoutes: 0,
      targetRouteCount: 0,
      stationRouteCount: 0,
      gdsAssignmentCount: 0,
      gdsOutOfScopeCount: 0,
      linkedAssignmentCount: 0,
      unlinkedCount: 0,
      evaluableCount: 0,
      swapPairCount: 0,
      totalFinishImprovementMinutes: 0,
      assignmentIncomplete: false,
    };
    var cycle = Number(options.cycle);
    if (cycle !== 1 && cycle !== 2) {
      return {
        mode: 'evaluate',
        cycleError: 'INVALID_CYCLE_FOR_EVAL',
        routes: [],
        swaps: [],
        summary: emptySummary,
      };
    }
    if (!options.amazonAssignments || !options.amazonAssignments.length) {
      return {
        mode: 'evaluate',
        assignmentError: 'AMAZON_ASSIGNMENT_REQUIRED',
        routes: [],
        swaps: [],
        summary: emptySummary,
        cycle: cycle,
      };
    }

    var config = Object.assign({}, ASSIGN_EXPERIENCE_CONFIG, options.experienceConfig || {});
    var swapConfig = Object.assign({}, SWAP_OPTIMIZE_CONFIG, options.swapConfig || {});
    var vehicleConfig = Object.assign({}, VEHICLE_SWAP_CONFIG, options.vehicleSwapConfig || {});
    var workers = filterShiftWorkers(shiftWorkers);
    var cycleFilter = filterWorkersByCycleEligibility(workers, cycle);
    var lookupWorkers = (cycleFilter.eligible || []).concat(workers);
    var population = collectGdsOptimizationPopulation(
      manifestRoutes,
      options.amazonAssignments,
      cycle
    );
    var gdsManifestRoutes = [];
    var gdsCodes = Object.keys(population.gdsByCode).sort(function (a, b) {
      return String(a).localeCompare(String(b));
    });
    for (var gi = 0; gi < gdsCodes.length; gi++) {
      var gdsManifest = population.manifestByCode[gdsCodes[gi]];
      if (gdsManifest) gdsManifestRoutes.push(gdsManifest);
    }
    var enrichedRoutes = enrichManifestRoutesWithAssignment(
      gdsManifestRoutes,
      options.amazonAssignments
    );
    var enrichedByCode = {};
    for (var ei = 0; ei < enrichedRoutes.length; ei++) {
      if (enrichedRoutes[ei] && enrichedRoutes[ei].routeCode) {
        enrichedByCode[enrichedRoutes[ei].routeCode] = enrichedRoutes[ei];
      }
    }
    var planOptions = {
      experienceConfig: config,
      getPackagesPerHour: options.getPackagesPerHour,
      cycle: cycle,
      loadingTime: options.loadingTime,
      travelOutbound: options.travelOutbound,
      travelReturn: options.travelReturn,
      defaultPackagesPerHour: options.defaultPackagesPerHour || swapConfig.DEFAULT_PACKAGES_PER_HOUR,
      defaultDeparture: options.defaultDeparture,
      swapConfig: swapConfig,
      vehicleSwapConfig: vehicleConfig,
    };
    var expDb = experienceDb && experienceDb.byTransportId ? experienceDb.byTransportId : {};

    var adminSlots = [];
    var inputMissingSlots = [];
    var swapSlots = [];
    var stationRouteCount = population.stationRouteCount;
    var gdsAssignmentCount = population.gdsAssignmentCount;
    var gdsOutOfScopeRoutes = population.gdsOutOfScopeRoutes;
    var linkedAssignmentCount = 0;

    for (var ri = 0; ri < gdsCodes.length; ri++) {
      var gdsCode = gdsCodes[ri];
      var amzRaw = population.gdsByCode[gdsCode];
      var route = enrichedByCode[gdsCode];
      var amz = route && route.amazonAssignment ? route.amazonAssignment : amzRaw;
      var roles = route ? resolveRouteAreaRoles(route.areas || []) : { primary: null };
      var primaryLabel = roles.primary ? roles.primary.label : '';
      var inputMissingReason = '';
      var adminReason = '';
      var anomaly = detectRouteDataAnomaly(route || { routeCode: gdsCode }, amz);

      if (!amz) {
        inputMissingReason = '必須データなし';
      } else if (!amz.driverName && !amz.transportId) {
        inputMissingReason = 'ドライバー特定不能';
      } else {
        linkedAssignmentCount++;
        if (!route) {
          inputMissingReason = 'マニフェスト側routeとの対応不能';
        } else if (!route.areas || !route.areas.length || !primaryLabel) {
          inputMissingReason = '必須データなし';
        }
      }

      var worker = null;
      var currentScore = null;
      if (!inputMissingReason) {
        worker = findAssignedWorker(lookupWorkers, amz);
        if (worker && !worker.normalizedShiftToken) {
          worker = Object.assign({}, worker, {
            normalizedShiftToken: normalizeAssignShiftToken(worker.shiftCode || ''),
          });
        }
        if (!worker) {
          if (amz.transportId || amz.driverName) {
            worker = {
              driverName: amz.driverName || '',
              name: amz.driverName || '',
              transportId: amz.transportId || '',
              shiftCode: '',
              assignRole: 'regular',
            };
          }
        }
        if (!worker || (!worker.transportId && !worker.driverName)) {
          inputMissingReason = 'ドライバー特定不能';
        } else {
          currentScore = buildDriverRouteScore(
            worker,
            route,
            worker.transportId ? expDb[worker.transportId] : null,
            planOptions
          );
        }
      }

      var safeRoute = route || {
        routeCode: gdsCode,
        packages: 0,
        stops: 0,
        areas: [],
        routeVehicleType: amz ? classifyRouteVehicleType(amz.serviceType) : 'unknown',
      };
      var vehicleKind = resolveVehicleKind(safeRoute, worker);
      var vehicleType = safeRoute.routeVehicleType || vehicleKind || 'unknown';
      var baseRow = {
        routeCode: gdsCode,
        packages: route ? routePackageCount(route) || route.packages : 0,
        stops: route ? route.stops : 0,
        areas: (route && route.areas) || [],
        routeVehicleType: vehicleType,
        vehicleKind: vehicleKind,
        amazonAssignment: amz,
        currentEvaluation: currentScore,
        suggestedChange: null,
        alternativeCandidates: [],
        routeDataAnomaly: anomaly.hasAnomaly ? anomaly : null,
      };

      if (inputMissingReason) {
        inputMissingSlots.push(
          Object.assign({}, baseRow, {
            evaluationStatus: 'input_missing',
            inputMissingReason: inputMissingReason,
            evaluationReasons: [
              'Cycle：Cycle ' + cycle,
              '判定：入力不足（' + inputMissingReason + '）',
            ],
          })
        );
        continue;
      }

      if (adminReason) {
        adminSlots.push(
          Object.assign({}, baseRow, {
            evaluationStatus: 'admin_review',
            adminReviewReason: adminReason,
            evaluationReasons: [
              'Cycle：Cycle ' + cycle,
              '判定：管理者確認（' + adminReason + '）',
            ],
          })
        );
        continue;
      }

      var finishMinutes = Math.round(finishMinutesForPairing(route, currentScore, currentScore, planOptions));
      var deliveryDurationMinutes = Math.round(
        estimateDeliveryDurationMinutes(currentScore, routePackageCount(route), planOptions)
      );
      swapSlots.push({
        route: route,
        worker: worker,
        amz: amz,
        score: currentScore,
        finishMinutes: finishMinutes,
        finishTime: formatMinutesToTime(finishMinutes),
        predictedFinishTime: formatMinutesToTime(finishMinutes),
        deliveryDurationMinutes: deliveryDurationMinutes,
        areaScore: areaFitScore(currentScore),
        vehicleKind: vehicleKind,
        vehicleGroup: vehicleKindToSwapGroup(vehicleKind, vehicleConfig),
        driverKey: swapDriverIdentityKey({
          route: route,
          worker: worker,
          amz: amz,
          score: currentScore,
        }),
        baseRow: baseRow,
      });
    }

    var candidates = [];
    for (var i = 0; i < swapSlots.length; i++) {
      for (var j = i + 1; j < swapSlots.length; j++) {
        var slotA = swapSlots[i];
        var slotB = swapSlots[j];
        if (slotA.driverKey && slotA.driverKey === slotB.driverKey) continue;
        var scoreAonB = buildDriverRouteScore(
          slotA.worker,
          slotB.route,
          slotA.worker.transportId ? expDb[slotA.worker.transportId] : null,
          planOptions
        );
        var scoreBonA = buildDriverRouteScore(
          slotB.worker,
          slotA.route,
          slotB.worker.transportId ? expDb[slotB.worker.transportId] : null,
          planOptions
        );
        var evalSlotA = Object.assign({}, slotA, { scoreOnPartner: scoreAonB });
        var evalSlotB = Object.assign({}, slotB, { scoreOnPartner: scoreBonA });
        var ev = evaluateSwapPair(evalSlotA, evalSlotB, planOptions);
        if (!ev.accepted) continue;
        candidates.push({ slotA: evalSlotA, slotB: evalSlotB, eval: ev, indexA: i, indexB: j });
      }
    }

    candidates.sort(function (a, b) {
      if (b.eval.timeImprovement !== a.eval.timeImprovement) {
        return b.eval.timeImprovement - a.eval.timeImprovement;
      }
      if (b.eval.maxFinishImprovement !== a.eval.maxFinishImprovement) {
        return b.eval.maxFinishImprovement - a.eval.maxFinishImprovement;
      }
      if (b.eval.experienceImprovement !== a.eval.experienceImprovement) {
        return b.eval.experienceImprovement - a.eval.experienceImprovement;
      }
      return String(a.slotA.route.routeCode).localeCompare(String(b.slotA.route.routeCode));
    });

    var usedDrivers = {};
    var selected = [];
    for (var ci = 0; ci < candidates.length; ci++) {
      var cand = candidates[ci];
      var keyA = cand.slotA.driverKey || swapDriverIdentityKey(cand.slotA);
      var keyB = cand.slotB.driverKey || swapDriverIdentityKey(cand.slotB);
      if (!keyA || !keyB || usedDrivers[keyA] || usedDrivers[keyB]) continue;
      usedDrivers[keyA] = true;
      usedDrivers[keyB] = true;
      selected.push(cand);
      if (selected.length >= swapConfig.MAX_SWAP_PAIRS) break;
    }

    var swaps = [];
    var swapByRoute = {};
    var totalImprovement = 0;
    for (var si = 0; si < selected.length; si++) {
      var pick = selected[si];
      var proposal = buildSwapProposal(pick.slotA, pick.slotB, pick.eval, si + 1, planOptions);
      swaps.push(proposal);
      totalImprovement += proposal.totalImprovementMinutes;
      swapByRoute[proposal.routeCodeA] = proposal;
      swapByRoute[proposal.routeCodeB] = proposal;
    }

    var routesOut = [];
    var unchangedRoutes = [];
    var okCount = 0;
    var changeCount = 0;

    for (var s = 0; s < swapSlots.length; s++) {
      var slot = swapSlots[s];
      var proposalForRoute = swapByRoute[slot.route.routeCode];
      var row;
      if (proposalForRoute) {
        changeCount++;
        var partnerCode =
          proposalForRoute.routeCodeA === slot.route.routeCode
            ? proposalForRoute.routeCodeB
            : proposalForRoute.routeCodeA;
        var side =
          proposalForRoute.routeCodeA === slot.route.routeCode
            ? proposalForRoute.driverA
            : proposalForRoute.driverB;
        row = Object.assign({}, slot.baseRow, {
          evaluationStatus: 'swap_recommended',
          swapProposal: proposalForRoute,
          suggestedChange: {
            driverName: side.driverName,
            transportId: side.transportId,
            fromRouteCode: side.fromRouteCode,
            toRouteCode: side.toRouteCode,
          },
          predictedFinishCurrent: slot.finishTime,
          predictedFinishAfter: side.toFinishTime,
          evaluationReasons: [
            'Cycle：Cycle ' + cycle,
            '判定：🔄 コース交換推奨',
            slot.route.routeCode + ' ⇄ ' + partnerCode,
            '現在：' + formatExperienceEvidenceLine(side.fromArea, side.fromExperienceDays),
            '変更後：' + formatExperienceEvidenceLine(side.toArea, side.toExperienceDays),
            '予測終了：' + side.fromFinishTime + ' → ' + side.toFinishTime,
            '組全体の短縮：' + proposalForRoute.totalImprovementMinutes + '分',
            '推奨理由：' + (proposalForRoute.reason || ''),
            '車種/種別：' +
              (proposalForRoute.vehicleKindA || slot.vehicleKind || '?') +
              ' ⇄ ' +
              (proposalForRoute.vehicleKindB || '?'),
          ].concat(
            proposalForRoute.worsenWarning ? [proposalForRoute.worsenWarning.message] : [],
            (slot.baseRow.routeDataAnomaly && slot.baseRow.routeDataAnomaly.warningLabel
              ? [slot.baseRow.routeDataAnomaly.warningLabel]
              : [])
          ),
        });
      } else {
        okCount++;
        row = Object.assign({}, slot.baseRow, {
          evaluationStatus: 'ok',
          predictedFinishCurrent: slot.finishTime,
          evaluationReasons: [
            'Cycle：Cycle ' + cycle,
            'Amazonアサイン：' + ((slot.amz && slot.amz.driverName) || slot.score.driverName || ''),
            '現在担当 主エリア：' +
              (slot.score.primaryArea || '?') +
              ' ' +
              formatExperienceDaysDisplay(slot.score.primaryExperienceDays || 0),
            '予測終了：' + slot.finishTime,
            '配送処理時間：約' + (slot.deliveryDurationMinutes || 0) + '分',
            '判定：明確な交換改善なし（変更不要）',
          ],
        });
        unchangedRoutes.push(row);
      }
      routesOut.push(row);
    }

    for (var ai = 0; ai < adminSlots.length; ai++) {
      routesOut.push(adminSlots[ai]);
    }
    for (var mi = 0; mi < inputMissingSlots.length; mi++) {
      routesOut.push(inputMissingSlots[mi]);
    }

    routesOut.sort(function (a, b) {
      var rank = { swap_recommended: 0, admin_review: 1, input_missing: 2, ok: 3 };
      var ra = rank[a.evaluationStatus] != null ? rank[a.evaluationStatus] : 9;
      var rb = rank[b.evaluationStatus] != null ? rank[b.evaluationStatus] : 9;
      if (ra !== rb) return ra - rb;
      return String(a.routeCode).localeCompare(String(b.routeCode));
    });

    var realInputMissingCount = inputMissingSlots.length;
    var assignmentIncomplete =
      gdsAssignmentCount > 0 &&
      (realInputMissingCount >= 10 || realInputMissingCount / gdsAssignmentCount >= 0.25);

    return {
      mode: 'evaluate',
      cycle: cycle,
      routes: routesOut,
      swaps: swaps,
      unchangedRoutes: unchangedRoutes,
      adminReviewRoutes: adminSlots,
      inputMissingRoutes: inputMissingSlots,
      gdsOutOfScopeRoutes: gdsOutOfScopeRoutes,
      summary: {
        okCount: okCount,
        changeCandidateCount: changeCount,
        adminReviewCount: adminSlots.length,
        inputMissingCount: realInputMissingCount,
        totalRoutes: routesOut.length,
        targetRouteCount: gdsAssignmentCount,
        stationRouteCount: stationRouteCount,
        gdsAssignmentCount: gdsAssignmentCount,
        gdsOutOfScopeCount: gdsOutOfScopeRoutes.length,
        linkedAssignmentCount: linkedAssignmentCount,
        unlinkedCount: realInputMissingCount,
        evaluableCount: swapSlots.length,
        swapPairCount: swaps.length,
        totalFinishImprovementMinutes: totalImprovement,
        assignmentIncomplete: assignmentIncomplete,
        optimizationPrefix: optimizationRoutePrefixLabel(cycle),
      },
      cycleEligibility: cycleFilter.stats,
      experienceConfig: config,
      swapConfig: swapConfig,
      vehicleSwapConfig: vehicleConfig,
    };
  }

  /** Cycle に応じて evaluate / first_pick を切替 */
  function buildAssignPlan(manifestRoutes, shiftWorkers, experienceDb, options) {
    options = options || {};
    var cycle = Number(options.cycle);
    var mode = getAssignModeForCycle(cycle);
    if (mode === 'evaluate') {
      return buildAmazonAssignEvaluationPlan(manifestRoutes, shiftWorkers, experienceDb, options);
    }
    if (mode === 'first_pick') {
      return buildFirstAssignPlan(manifestRoutes, shiftWorkers, experienceDb, options);
    }
    return buildFirstAssignPlan(manifestRoutes, shiftWorkers, experienceDb, options);
  }

  function buildKnownTransportIdSet(transportIDs) {
    var set = new Set();
    if (!transportIDs) return set;
    var keys = Object.keys(transportIDs);
    for (var i = 0; i < keys.length; i++) {
      var v = String(transportIDs[keys[i]] || '').trim();
      if (v) set.add(v);
    }
    return set;
  }

  /** フラット records から経験DBを再構築（GAS読込用） */
  function buildExperienceDbFromRecords(records, options) {
    options = options || {};
    if (!records || !records.length) {
      return { ok: false, error: 'records が空です' };
    }
    var knownTids = options.knownTransportIds || new Set();
    var byTransportId = {};
    var areaSet = {};
    var unknownTids = [];
    var unknownTidSet = {};
    var lastDate = '';

    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec) continue;
      var tid = String(rec.transportId || '').trim();
      var area = String(rec.area || '').trim();
      if (!tid || !area) continue;
      var experienceDays = Number(rec.experienceDays);
      if (!isFinite(experienceDays) || experienceDays < 0) continue;
      var driverName = String(rec.driverName || '').trim();
      var lastVisitDate = String(rec.lastVisitDate || '').trim();
      if (lastVisitDate && (!lastDate || lastVisitDate > lastDate)) lastDate = lastVisitDate;

      areaSet[area] = true;
      if (!byTransportId[tid]) {
        byTransportId[tid] = {
          transportId: tid,
          driverName: driverName,
          areas: {},
          areaCount: 0,
        };
      }
      if (driverName && !byTransportId[tid].driverName) {
        byTransportId[tid].driverName = driverName;
      }
      byTransportId[tid].areas[area] = rec;

      if (knownTids.size > 0 && !knownTids.has(tid) && !unknownTidSet[tid]) {
        unknownTidSet[tid] = true;
        unknownTids.push({ transportId: tid, driverName: driverName, area: area });
      }
    }

    var drivers = Object.keys(byTransportId);
    for (var d = 0; d < drivers.length; d++) {
      byTransportId[drivers[d]].areaCount = Object.keys(byTransportId[drivers[d]].areas).length;
    }

    return {
      ok: true,
      records: records,
      byTransportId: byTransportId,
      stats: {
        drivers: drivers.length,
        areas: Object.keys(areaSet).length,
        records: records.length,
        lastDate: lastDate,
        unknownTids: unknownTids,
        unknownTidCount: Object.keys(unknownTidSet).length,
      },
    };
  }

  var EXPERIENCE_STATUS_THRESHOLDS = {
    shallow: 3,
    experienced: 10,
    skilled: 20,
  };

  function getExperienceStatusLabel(experienceDays, thresholds) {
    thresholds = thresholds || EXPERIENCE_STATUS_THRESHOLDS;
    var days = Number(experienceDays) || 0;
    if (days <= 0) return '確認なし（' + AREA_EXPERIENCE_OBSERVATION.START_LABEL + '）';
    if (days <= 2) return '弱い経験実績';
    if (days <= 5) return '明確な経験実績';
    if (days <= 9) return '強い経験実績';
    if (days < thresholds.skilled) return '非常に強い経験実績';
    return '熟練';
  }

  function resolveDriverNameByTransportId(transportId, transportIDs, resolveDriverKeyFn) {
    if (!transportId || !transportIDs) return '';
    var tid = String(transportId).trim();
    var keys = Object.keys(transportIDs);
    for (var i = 0; i < keys.length; i++) {
      if (String(transportIDs[keys[i]] || '').trim() === tid) {
        return resolveDriverKeyFn ? resolveDriverKeyFn(keys[i]) : keys[i];
      }
    }
    return '';
  }

  function getPackagesPerHour(driverName, transportId, findDriverFn, transportIDs, resolveDriverKeyFn) {
    if (typeof findDriverFn !== 'function') return null;
    if (driverName) {
      var info = findDriverFn(driverName);
      if (info && info.packagesPerHour != null) return info.packagesPerHour;
    }
    var resolved = resolveDriverNameByTransportId(transportId, transportIDs, resolveDriverKeyFn);
    if (resolved) {
      var info2 = findDriverFn(resolved);
      if (info2 && info2.packagesPerHour != null) return info2.packagesPerHour;
    }
    return null;
  }

  function formatShortDate(isoDate) {
    if (!isoDate) return '-';
    var m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Number(m[2]) + '/' + Number(m[3]);
    return String(isoDate).slice(0, 10);
  }

  function formatAreaSummary(entry, maxAreas) {
    maxAreas = maxAreas || 3;
    if (!entry || !entry.areas) return '-';
    var keys = Object.keys(entry.areas).sort(function (a, b) {
      return (entry.areas[b].experienceDays || 0) - (entry.areas[a].experienceDays || 0);
    });
    var parts = [];
    for (var i = 0; i < Math.min(keys.length, maxAreas); i++) {
      var ar = entry.areas[keys[i]];
      parts.push(ar.area + ' ' + formatExperienceDaysDisplay(ar.experienceDays));
    }
    if (keys.length > maxAreas) parts.push('…');
    return parts.join(' / ');
  }

  function getDriverLatestVisit(entry) {
    if (!entry || !entry.areas) return '';
    var latest = '';
    var keys = Object.keys(entry.areas);
    for (var i = 0; i < keys.length; i++) {
      var d = entry.areas[keys[i]].lastVisitDate || '';
      if (d > latest) latest = d;
    }
    return latest;
  }

  function filterExperienceDrivers(experienceDb, query) {
    if (!experienceDb || !experienceDb.byTransportId) return [];
    query = String(query || '').trim().toLowerCase();
    var tids = Object.keys(experienceDb.byTransportId).sort(function (a, b) {
      var na = experienceDb.byTransportId[a].driverName || a;
      var nb = experienceDb.byTransportId[b].driverName || b;
      return na.localeCompare(nb, 'ja');
    });
    if (!query) {
      return tids.map(function (tid) {
        return experienceDb.byTransportId[tid];
      });
    }
    var matched = [];
    for (var i = 0; i < tids.length; i++) {
      var tid = tids[i];
      var entry = experienceDb.byTransportId[tid];
      var name = (entry.driverName || '').toLowerCase();
      if (name.indexOf(query) >= 0 || tid.toLowerCase().indexOf(query) >= 0) {
        matched.push(entry);
        continue;
      }
      var areaKeys = Object.keys(entry.areas || {});
      for (var j = 0; j < areaKeys.length; j++) {
        var areaName = areaKeys[j].toLowerCase();
        if (areaName.indexOf(query) >= 0 || normalizeAreaToken(areaKeys[j]).toLowerCase().indexOf(query) >= 0) {
          matched.push(entry);
          break;
        }
      }
    }
    return matched;
  }

  function serializeExperienceForSave(experienceDb) {
    if (!experienceDb || !experienceDb.records) return null;
    return {
      updatedAt: new Date().toISOString().slice(0, 10),
      records: experienceDb.records,
      stats: experienceDb.stats,
    };
  }

  function parseManifestWorkbook(workbook) {
    var routes = [];
    if (!workbook || !workbook.SheetNames) return routes;

    for (var si = 0; si < workbook.SheetNames.length; si++) {
      var sheetName = workbook.SheetNames[si];
      var sheet = workbook.Sheets[sheetName];
      var json = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      var routeCode = '';
      var sheetRouteMatch = sheetName.match(/sequencedRoute_(\w+)/);
      if (sheetRouteMatch) routeCode = sheetRouteMatch[1].trim();
      if (!routeCode) {
        var directMatch = sheetName.trim().match(/^([A-Za-z]*\d+)$/);
        if (directMatch) routeCode = directMatch[1].trim();
      }
      if (!routeCode && json.length > 0 && json[0] && json[0][0]) {
        var routeMatch = String(json[0][0]).match(/Route for\s+(\w+)/);
        if (routeMatch) routeCode = routeMatch[1].trim();
      }
      if (!routeCode && sheetName.trim() && !sheetName.match(/summary|合計|total|sheet/i)) {
        var cleaned = sheetName.replace(/[^A-Za-z0-9]/g, '');
        if (cleaned.length >= 2 && cleaned.length <= 10) routeCode = cleaned;
      }
      if (!routeCode) continue;

      var packages = 0;
      var addresses = [];
      var seen = {};
      for (var i = 1; i < json.length; i++) {
        var row = json[i];
        if (!row || !row[1]) continue;
        var da = String(row[1]).trim();
        if (da === 'Tracking ID' || da === 'DA' || !da) continue;
        packages++;
        if (row[5] && String(row[5]).trim()) {
          var addr = String(row[5]).trim();
          if (addr.indexOf('OFK') < 0 && !seen[addr]) {
            seen[addr] = true;
            addresses.push(addr);
          }
        }
      }

      if (packages > 0) {
        routes.push({
          routeCode: routeCode,
          packages: packages,
          stops: addresses.length,
          areas: extractAreaLabelsFromAddresses(addresses),
        });
      }
    }
    return routes;
  }

  /** 既存 transportIDs + resolveDriverKey と同じ名寄せで TransportID を解決 */
  function resolveTransportIdForName(name, transportIDs, resolveDriverKeyFn) {
    if (!name || !transportIDs) return '';
    var raw = String(name).trim();
    if (!raw) return '';

    var keysToTry = [];
    if (resolveDriverKeyFn) {
      try {
        keysToTry.push(resolveDriverKeyFn(raw));
      } catch (e) {
        /* resolveDriverKey 未初期化時 */
      }
    }
    keysToTry.push(raw);

    var norm = raw.replace(/\s+/g, ' ').trim();
    if (norm !== raw) keysToTry.push(norm);

    var noSpace = raw.replace(/[\s\u3000]/g, '');
    keysToTry.push(noSpace);

    var parts = norm.split(/\s+/);
    if (parts.length === 2) {
      keysToTry.push(parts[1] + ' ' + parts[0]);
      keysToTry.push(parts[1] + parts[0]);
    }

    var seen = {};
    for (var i = 0; i < keysToTry.length; i++) {
      var k = keysToTry[i];
      if (!k || seen[k]) continue;
      seen[k] = true;
      if (transportIDs[k]) return String(transportIDs[k]).trim();
      if (resolveDriverKeyFn) {
        var resolved = resolveDriverKeyFn(k);
        if (resolved && resolved !== k && transportIDs[resolved]) {
          return String(transportIDs[resolved]).trim();
        }
      }
    }

    if (resolveDriverKeyFn) {
      var canonical = resolveDriverKeyFn(raw);
      var canonicalNoSpace = canonical.replace(/[\s\u3000]/g, '');
      for (var tidKey in transportIDs) {
        if (!transportIDs[tidKey]) continue;
        if (resolveDriverKeyFn(tidKey) === canonical) return String(transportIDs[tidKey]).trim();
        if (tidKey.replace(/[\s\u3000]/g, '') === canonicalNoSpace) {
          return String(transportIDs[tidKey]).trim();
        }
        if (resolveDriverKeyFn(tidKey).replace(/[\s\u3000]/g, '') === canonicalNoSpace) {
          return String(transportIDs[tidKey]).trim();
        }
      }
    }

    return '';
  }

  function enrichShiftWorkersWithTransportIds(workers, transportIDs, resolveDriverKeyFn) {
    if (!workers || !workers.length) {
      return { workers: [], mappedCount: 0, unmappedNames: [] };
    }
    var mappedCount = 0;
    var unmappedNames = [];
    for (var i = 0; i < workers.length; i++) {
      var w = workers[i];
      var displayName = w.name || w.driverName || '';
      var tid = w.transportId ? String(w.transportId).trim() : '';
      if (!tid) {
        tid = resolveTransportIdForName(displayName, transportIDs, resolveDriverKeyFn);
      }
      if (!tid && w.rawName) {
        tid = resolveTransportIdForName(w.rawName, transportIDs, resolveDriverKeyFn);
      }
      w.transportId = tid;
      if (resolveDriverKeyFn) {
        try {
          w.driverName = resolveDriverKeyFn(displayName) || displayName;
        } catch (e2) {
          w.driverName = displayName;
        }
      } else {
        w.driverName = displayName;
      }
      if (tid) mappedCount++;
      else unmappedNames.push(w.driverName || displayName);
    }
    return { workers: workers, mappedCount: mappedCount, unmappedNames: unmappedNames };
  }

  /** シフト TransportID 紐付の原因調査用（fuzzy match 追加なし・ログ専用） */
  function diagnoseTransportIdLinking(options) {
    options = options || {};
    var workers = options.workers || [];
    var transportIDs = options.transportIDs || {};
    var resolveDriverKeyFn = options.resolveDriverKeyFn;
    var driverDB = options.driverDB || {};
    var driverJapaneseNames = options.driverJapaneseNames || {};
    var sampleLimit = options.sampleLimit || 10;

    var keys = Object.keys(transportIDs);
    var nonEmptyKeys = keys.filter(function (k) {
      return String(transportIDs[k] || '').trim();
    });

    function firstEntries(map, limit) {
      var out = [];
      var mapKeys = Object.keys(map);
      for (var i = 0; i < mapKeys.length && i < limit; i++) {
        out.push({ key: mapKeys[i], value: map[mapKeys[i]] });
      }
      return out;
    }

    function fmtDirectMatches(matches) {
      if (!matches || !matches.length) return '(なし)';
      return matches
        .map(function (m) {
          return m.key + '=' + m.value;
        })
        .join('; ');
    }

    function fmtReverseCandidates(list) {
      if (!list || !list.length) return '(なし)';
      return list
        .map(function (m) {
          return m.key + '=' + m.value;
        })
        .join('; ');
    }

    function fmtJapaneseCandidates(list) {
      if (!list || !list.length) return '(なし)';
      return list
        .map(function (m) {
          return m.masterKey + '(' + m.japaneseName + ')=' + (m.transportId || '-');
        })
        .join('; ');
    }

    function fmtDriverDbMatches(list) {
      if (!list || !list.length) return '(なし)';
      return list.join('; ');
    }

    function inspectName(rawName, displayName) {
      var raw = String(rawName || '').trim();
      var resolved = raw;
      if (resolveDriverKeyFn) {
        try {
          resolved = resolveDriverKeyFn(raw);
        } catch (e1) {
          resolved = '[resolveDriverKey error: ' + e1.message + ']';
        }
      }

      var norm = raw.replace(/\s+/g, ' ').trim();
      var noSpace = raw.replace(/[\s\u3000]/g, '');
      var parts = norm.split(/\s+/);
      var reversed = parts.length === 2 ? parts[1] + ' ' + parts[0] : '';
      var reversedNoSpace = parts.length === 2 ? parts[1] + parts[0] : '';

      var candidateKeys = [resolved, raw, norm, noSpace, reversed, reversedNoSpace];
      var uniqueCandidates = [];
      var seenCand = {};
      for (var ci = 0; ci < candidateKeys.length; ci++) {
        var ck = candidateKeys[ci];
        if (!ck || seenCand[ck]) continue;
        seenCand[ck] = true;
        uniqueCandidates.push(ck);
      }

      var exactKeyMatches = [];
      for (var ei = 0; ei < keys.length; ei++) {
        var ek = keys[ei];
        if (ek === raw || ek === resolved || ek === norm || ek === noSpace || ek === reversed) {
          exactKeyMatches.push({ key: ek, value: transportIDs[ek] });
        }
      }

      var japaneseNameCandidates = [];
      for (var jpKey in driverJapaneseNames) {
        var jpVal = String(driverJapaneseNames[jpKey] || '').trim();
        if (!jpVal) continue;
        var jpValNoSpace = jpVal.replace(/[\s\u3000]/g, '');
        if (jpVal === raw || jpVal === norm || jpValNoSpace === noSpace || jpVal === resolved) {
          japaneseNameCandidates.push({
            masterKey: jpKey,
            japaneseName: jpVal,
            transportId: transportIDs[jpKey] || null,
          });
        }
      }

      var reverseCandidates = [];
      if (resolveDriverKeyFn && resolved && resolved.indexOf('error:') < 0) {
        for (var ri = 0; ri < keys.length && reverseCandidates.length < 8; ri++) {
          var rk = keys[ri];
          try {
            if (resolveDriverKeyFn(rk) === resolved) {
              reverseCandidates.push({ key: rk, value: transportIDs[rk] });
            }
          } catch (e2) {
            /* skip */
          }
        }
      }

      var driverDbMatches = [];
      for (var di = 0; di < uniqueCandidates.length; di++) {
        if (driverDB[uniqueCandidates[di]]) driverDbMatches.push(uniqueCandidates[di]);
      }
      if (!driverDbMatches.length && resolved && driverDB[resolved]) {
        driverDbMatches.push(resolved);
      }

      var finalTransportId = resolveTransportIdForName(raw, transportIDs, resolveDriverKeyFn) || null;

      return {
        rawName: raw,
        displayName: displayName || raw,
        normalized: norm,
        resolveDriverKey: resolved,
        reversedCandidate: reversed || reversedNoSpace || '(なし)',
        japaneseNameCandidates: japaneseNameCandidates,
        transportIdsDirectMatch: exactKeyMatches,
        transportIdsReverseCandidates: reverseCandidates,
        driverDbMatches: driverDbMatches,
        finalTransportId: finalTransportId,
        tableRow: {
          rawName: raw,
          normalize後: norm,
          resolveDriverKey: resolved,
          姓名反転候補: reversed || reversedNoSpace || '(なし)',
          japaneseName候補: fmtJapaneseCandidates(japaneseNameCandidates),
          transportIDs直接一致結果: fmtDirectMatches(exactKeyMatches),
          transportIDs逆引き一致候補: fmtReverseCandidates(reverseCandidates),
          driverDB一致候補: fmtDriverDbMatches(driverDbMatches),
          finalTransportId: finalTransportId || '(未紐付)',
        },
      };
    }

    var samples = [];
    for (var wi = 0; wi < workers.length && wi < sampleLimit; wi++) {
      var w = workers[wi];
      samples.push(inspectName(w.rawName || w.name, w.name || w.driverName));
    }

    var totalKeys = keys.length;
    var localStorageCount = options.localStorageCount || 0;
    var globalCount = options.globalTransportIDsCount || 0;
    var windowCount = options.windowTransportIDsCount || 0;
    var inferredCase = 'unknown';

    if (totalKeys === 0 && localStorageCount === 0 && windowCount === 0) {
      inferredCase = 'A';
    } else if (totalKeys === 0 && (localStorageCount >= 80 || windowCount >= 80)) {
      inferredCase = 'B';
    } else if (totalKeys >= 1 && samples.length > 0) {
      var allNull = true;
      for (var si = 0; si < samples.length; si++) {
        if (samples[si].finalTransportId) {
          allNull = false;
          break;
        }
      }
      if (allNull) inferredCase = 'C';
    }

    return {
      at: new Date().toISOString(),
      inferredCase: inferredCase,
      inferredCaseLabel:
        inferredCase === 'A'
          ? 'ケースA: マスタロード順・GAS未完了'
          : inferredCase === 'B'
            ? 'ケースB: 外部JSスコープ参照問題'
            : inferredCase === 'C'
              ? 'ケースC: キー形式名寄せ問題'
              : '判定不能（要Console確認）',
      meta: {
        transportIDsSource: options.transportIDsSource || 'unknown',
        globalTransportIDsDefined: !!options.globalTransportIDsDefined,
        globalTransportIDsCount: globalCount,
        globalTransportIDsSample: options.globalTransportIDsSample || [],
        windowTransportIDsDefined: !!options.windowTransportIDsDefined,
        windowTransportIDsCount: windowCount,
        windowTransportIDsSample: options.windowTransportIDsSample || [],
        localStorageCount: localStorageCount,
        localStorageSample: options.localStorageSample || [],
        mapUsedCount: totalKeys,
        resolveDriverKeyAvailable: typeof resolveDriverKeyFn === 'function',
        driverDBCount: Object.keys(driverDB).length,
        driverJapaneseNamesCount: Object.keys(driverJapaneseNames).length,
        masterLoadStatus: options.masterLoadStatus || null,
        shiftProcessedAt: options.shiftProcessedAt || null,
      },
      transportIDs: {
        totalKeys: totalKeys,
        nonEmptyValues: nonEmptyKeys.length,
        first10: firstEntries(transportIDs, 10),
      },
      shift: {
        attendanceCount: options.attendanceCount || workers.length,
        mappedCount: options.mappedCount || 0,
        unmappedCount: options.unmappedCount || 0,
        unmappedNames: options.unmappedNames || [],
      },
      workerCount: workers.length,
      samples: samples,
      representativeTable: samples.map(function (s) {
        return s.tableRow;
      }),
      representative3: samples.slice(0, 3).map(function (s) {
        var tidKey =
          (s.transportIdsDirectMatch[0] && s.transportIdsDirectMatch[0].key) ||
          (s.transportIdsReverseCandidates[0] && s.transportIdsReverseCandidates[0].key) ||
          (s.japaneseNameCandidates[0] && s.japaneseNameCandidates[0].masterKey) ||
          '-';
        return {
          シフト氏名: s.rawName,
          resolveDriverKey: s.resolveDriverKey,
          transportIDsキー: tidKey,
          TransportID: s.finalTransportId || '(未紐付)',
        };
      }),
    };
  }

  function extractShiftWorkersFromExecData(execShiftData, targetDay, resolveNameFn, transportIDs) {
    if (!execShiftData || !execShiftData.days) return [];
    var entries = execShiftData.days[targetDay] || [];
    var workers = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var name = e.name;
      if (isShiftNonDriverRow(name)) continue;
      var driverName = resolveNameFn ? resolveNameFn(name) : name;
      var tid = resolveTransportIdForName(name, transportIDs, resolveNameFn);
      workers.push({
        name: name,
        rawName: name,
        driverName: driverName,
        transportId: tid,
        shiftCode: e.type || '',
        dept: e.dept || '',
      });
    }
    return workers;
  }

  function extractShiftWorkersFromMaster(shiftMasterData, transportIDs, resolveDriverKeyFn) {
    if (!shiftMasterData || !shiftMasterData.length) return [];
    return shiftMasterData
      .filter(function (s) {
        return !isShiftNonDriverRow(s.rawName || s.name);
      })
      .map(function (s) {
      var tid = s.transportId ? String(s.transportId).trim() : '';
      if (!tid) {
        tid = resolveTransportIdForName(s.name, transportIDs, resolveDriverKeyFn);
      }
      if (!tid && s.rawName) {
        tid = resolveTransportIdForName(s.rawName, transportIDs, resolveDriverKeyFn);
      }
      var driverName = resolveDriverKeyFn ? resolveDriverKeyFn(s.name) : s.name;
      return {
        name: s.name,
        rawName: s.rawName || s.name,
        driverName: driverName,
        transportId: tid,
        shiftCode: s.shiftCode || '',
        company: s.company || '',
      };
    });
  }

  var AssignSupportCore = {
    COLUMN_ALIASES: COLUMN_ALIASES,
    mapColumns: mapColumns,
    parseExperienceRows: parseExperienceRows,
    buildExperienceDbFromRecords: buildExperienceDbFromRecords,
    serializeExperienceForSave: serializeExperienceForSave,
    getExperienceStatusLabel: getExperienceStatusLabel,
    EXPERIENCE_STATUS_THRESHOLDS: EXPERIENCE_STATUS_THRESHOLDS,
    resolveDriverNameByTransportId: resolveDriverNameByTransportId,
    getPackagesPerHour: getPackagesPerHour,
    formatShortDate: formatShortDate,
    formatAreaSummary: formatAreaSummary,
    getDriverLatestVisit: getDriverLatestVisit,
    filterExperienceDrivers: filterExperienceDrivers,
    extractAreaLabelsFromAddresses: extractAreaLabelsFromAddresses,
    areasMatch: areasMatch,
    evaluateDriverForRoute: evaluateDriverForRoute,
    buildAssignSuggestions: buildAssignSuggestions,
    buildFirstAssignPlan: buildFirstAssignPlan,
    buildAmazonAssignEvaluationPlan: buildAmazonAssignEvaluationPlan,
    buildAssignPlan: buildAssignPlan,
    isDcxRouteCode: isDcxRouteCode,
    isDmxRouteCode: isDmxRouteCode,
    isOptimizationRoute: isOptimizationRoute,
    optimizationRoutePrefixLabel: optimizationRoutePrefixLabel,
    collectGdsOptimizationPopulation: collectGdsOptimizationPopulation,
    SWAP_OPTIMIZE_CONFIG: SWAP_OPTIMIZE_CONFIG,
    VEHICLE_SWAP_CONFIG: VEHICLE_SWAP_CONFIG,
    AREA_EXPERIENCE_OBSERVATION: AREA_EXPERIENCE_OBSERVATION,
    AREA_EXPERIENCE_SPEED_BONUS: AREA_EXPERIENCE_SPEED_BONUS,
    classifyExperienceEvidence: classifyExperienceEvidence,
    formatExperienceDaysDisplay: formatExperienceDaysDisplay,
    formatExperienceEvidenceLine: formatExperienceEvidenceLine,
    evaluateSwapPair: evaluateSwapPair,
    experienceSpeedFactor: experienceSpeedFactor,
    estimateDeliveryDurationMinutes: estimateDeliveryDurationMinutes,
    estimatePredictedFinishMinutes: estimatePredictedFinishMinutes,
    adjustCapabilityForFinishEstimate: adjustCapabilityForFinishEstimate,
    canSwapVehicleGroups: canSwapVehicleGroups,
    resolveVehicleSwapGroup: resolveVehicleSwapGroup,
    resolveVehicleKind: resolveVehicleKind,
    vehicleKindToSwapGroup: vehicleKindToSwapGroup,
    classifySwapWorsenWarning: classifySwapWorsenWarning,
    swapDriverIdentityKey: swapDriverIdentityKey,
    detectRouteDataAnomaly: detectRouteDataAnomaly,
    getAssignModeForCycle: getAssignModeForCycle,
    classifyRouteVehicleType: classifyRouteVehicleType,
    filterWorkersByVehicleType: filterWorkersByVehicleType,
    mergeScheduleIntoShiftWorkers: mergeScheduleIntoShiftWorkers,
    normalizeAssignTargetDate: normalizeAssignTargetDate,
    extractShiftWorkersFromSchedule: extractShiftWorkersFromSchedule,
    buildAssignWorkersFromAmazonSchedule: buildAssignWorkersFromAmazonSchedule,
    enrichManifestRoutesWithAssignment: enrichManifestRoutesWithAssignment,
    buildRouteDifficultyStats: buildRouteDifficultyStats,
    compareRouteAssignmentPriority: compareRouteAssignmentPriority,
    selectFirstPickCycle3: selectFirstPickCycle3,
    compareDriverRouteScoresWithTieBreak: compareDriverRouteScoresWithTieBreak,
    parseScheduleCellWorkHint: parseScheduleCellWorkHint,
    evaluateAmazonAssignmentStatus: evaluateAmazonAssignmentStatus,
    buildDriverRouteScore: buildDriverRouteScore,
    compareDriverRouteScores: compareDriverRouteScores,
    isShiftNonDriverRow: isShiftNonDriverRow,
    filterShiftWorkers: filterShiftWorkers,
    CYCLE_SHIFT_ELIGIBILITY: CYCLE_SHIFT_ELIGIBILITY,
    NON_ASSIGNABLE_SHIFT_TYPES: NON_ASSIGNABLE_SHIFT_TYPES,
    normalizeAssignShiftToken: normalizeAssignShiftToken,
    isNonAssignableShift: isNonAssignableShift,
    isReserveServiceType: isReserveServiceType,
    isShiftEligibleForCycle: isShiftEligibleForCycle,
    filterWorkersByCycleEligibility: filterWorkersByCycleEligibility,
    detectManifestCycleFromSources: detectManifestCycleFromSources,
    detectCycleFromFileName: detectCycleFromFileName,
    getEligibleShiftLabelsForCycle: getEligibleShiftLabelsForCycle,
    formatCycleEligibleLabel: formatCycleEligibleLabel,
    getPrimaryExperienceTier: getPrimaryExperienceTier,
    isEligibleForFirstRecommendation: isEligibleForFirstRecommendation,
    ASSIGN_EXPERIENCE_CONFIG: ASSIGN_EXPERIENCE_CONFIG,
    buildKnownTransportIdSet: buildKnownTransportIdSet,
    parseManifestWorkbook: parseManifestWorkbook,
    resolveTransportIdForName: resolveTransportIdForName,
    enrichShiftWorkersWithTransportIds: enrichShiftWorkersWithTransportIds,
    diagnoseTransportIdLinking: diagnoseTransportIdLinking,
    extractShiftWorkersFromExecData: extractShiftWorkersFromExecData,
    extractShiftWorkersFromMaster: extractShiftWorkersFromMaster,
  };

  global.AssignSupportCore = AssignSupportCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AssignSupportCore;
  }
})(typeof window !== 'undefined' ? window : global);
