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
              isReserve: !!amz.isReserve,
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

  /**
   * Phase 1.7: Cycle 1/2 — Amazon既存アサインを経験DBで評価し変更提案
   */
  function buildAmazonAssignEvaluationPlan(manifestRoutes, shiftWorkers, experienceDb, options) {
    options = options || {};
    var cycle = Number(options.cycle);
    if (cycle !== 1 && cycle !== 2) {
      return {
        mode: 'evaluate',
        cycleError: 'INVALID_CYCLE_FOR_EVAL',
        routes: [],
        summary: { okCount: 0, changeCandidateCount: 0, adminReviewCount: 0, totalRoutes: 0 },
      };
    }
    if (!options.amazonAssignments || !options.amazonAssignments.length) {
      return {
        mode: 'evaluate',
        assignmentError: 'AMAZON_ASSIGNMENT_REQUIRED',
        routes: [],
        summary: { okCount: 0, changeCandidateCount: 0, adminReviewCount: 0, totalRoutes: 0 },
        cycle: cycle,
      };
    }

    var config = Object.assign({}, ASSIGN_EXPERIENCE_CONFIG, options.experienceConfig || {});
    var workers = filterShiftWorkers(shiftWorkers);
    var cycleFilter = filterWorkersByCycleEligibility(workers, cycle);
    var cycleEligibleWorkers = cycleFilter.eligible;
    var enrichedRoutes = enrichManifestRoutesWithAssignment(manifestRoutes, options.amazonAssignments);
    var planOptions = {
      experienceConfig: config,
      getPackagesPerHour: options.getPackagesPerHour,
      cycle: cycle,
    };

    var routesOut = [];
    var okCount = 0;
    var changeCount = 0;
    var adminCount = 0;

    for (var ri = 0; ri < enrichedRoutes.length; ri++) {
      var route = enrichedRoutes[ri];
      if (!route.areas || !route.areas.length) continue;

      var vehicleType = route.routeVehicleType || 'unknown';
      if (vehicleType === 'unknown') {
        routesOut.push({
          routeCode: route.routeCode,
          packages: route.packages,
          stops: route.stops,
          areas: route.areas,
          routeVehicleType: vehicleType,
          amazonAssignment: route.amazonAssignment,
          evaluationStatus: 'admin_review',
          evaluationReasons: buildAmazonEvaluationReasons(null, null, 'admin_review', route, config, cycle),
        });
        adminCount++;
        continue;
      }

      var vehicleWorkers = filterWorkersByVehicleType(cycleEligibleWorkers, vehicleType);
      var regularWorkers = vehicleWorkers.filter(function (w) {
        return w.assignRole !== 'reserve';
      });

      var scored = [];
      for (var wi = 0; wi < regularWorkers.length; wi++) {
        var worker = regularWorkers[wi];
        if (!worker.transportId) continue;
        scored.push(
          buildDriverRouteScore(worker, route, experienceDb.byTransportId[worker.transportId], planOptions)
        );
      }
      scored.sort(compareDriverRouteScores);

      var amz = route.amazonAssignment;
      var currentScore = null;
      if (amz && amz.driverName) {
        for (var ci = 0; ci < vehicleWorkers.length; ci++) {
          var cw = vehicleWorkers[ci];
          if (!cw.transportId) continue;
          if ((cw.driverName || cw.name) === amz.driverName || cw.transportId === amz.transportId) {
            currentScore = buildDriverRouteScore(
              cw,
              route,
              experienceDb.byTransportId[cw.transportId],
              planOptions
            );
            break;
          }
        }
        if (!currentScore && amz.transportId) {
          currentScore = buildDriverRouteScore(
            { driverName: amz.driverName, transportId: amz.transportId, shiftCode: '' },
            route,
            experienceDb.byTransportId[amz.transportId],
            planOptions
          );
        }
      }

      var bestAlt = null;
      for (var bi = 0; bi < scored.length; bi++) {
        if (!isEligibleForFirstRecommendation(scored[bi], config)) continue;
        if (currentScore && scored[bi].transportId === currentScore.transportId) continue;
        bestAlt = scored[bi];
        break;
      }

      var evalStatus = evaluateAmazonAssignmentStatus(currentScore, bestAlt, config);
      if (evalStatus === 'ok') okCount++;
      else if (evalStatus === 'change_candidate') changeCount++;
      else adminCount++;

      routesOut.push({
        routeCode: route.routeCode,
        packages: route.packages,
        stops: route.stops,
        areas: route.areas,
        routeVehicleType: vehicleType,
        amazonAssignment: amz,
        evaluationStatus: evalStatus,
        currentEvaluation: currentScore,
        suggestedChange: evalStatus === 'change_candidate' ? bestAlt : null,
        alternativeCandidates: scored.slice(0, 8),
        evaluationReasons: buildAmazonEvaluationReasons(currentScore, bestAlt, evalStatus, route, config, cycle),
      });
    }

    routesOut.sort(function (a, b) {
      return String(a.routeCode).localeCompare(b.routeCode);
    });

    return {
      mode: 'evaluate',
      cycle: cycle,
      routes: routesOut,
      summary: {
        okCount: okCount,
        changeCandidateCount: changeCount,
        adminReviewCount: adminCount,
        totalRoutes: routesOut.length,
      },
      cycleEligibility: cycleFilter.stats,
      experienceConfig: config,
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
    if (days <= 0) return '未経験';
    if (days < thresholds.shallow) return '経験浅い';
    if (days < thresholds.experienced) return '経験あり';
    if (days < thresholds.skilled) return '経験あり';
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
      parts.push(ar.area + ' ' + ar.experienceDays + '日');
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
    getAssignModeForCycle: getAssignModeForCycle,
    classifyRouteVehicleType: classifyRouteVehicleType,
    filterWorkersByVehicleType: filterWorkersByVehicleType,
    mergeScheduleIntoShiftWorkers: mergeScheduleIntoShiftWorkers,
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
