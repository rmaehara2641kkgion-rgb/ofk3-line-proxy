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

  function extractShiftWorkersFromExecData(execShiftData, targetDay, resolveNameFn, transportIDs) {
    if (!execShiftData || !execShiftData.days) return [];
    var entries = execShiftData.days[targetDay] || [];
    var workers = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var name = e.name;
      var key = resolveNameFn ? resolveNameFn(name) : name;
      var tid = (transportIDs && transportIDs[key]) || '';
      workers.push({
        name: name,
        driverName: name,
        transportId: tid,
        shiftCode: e.type || '',
        dept: e.dept || '',
      });
    }
    return workers;
  }

  function extractShiftWorkersFromMaster(shiftMasterData) {
    if (!shiftMasterData || !shiftMasterData.length) return [];
    return shiftMasterData.map(function (s) {
      return {
        name: s.name,
        driverName: s.name,
        transportId: s.transportId || '',
        shiftCode: s.shiftCode || '',
        company: s.company || '',
      };
    });
  }

  var AssignSupportCore = {
    COLUMN_ALIASES: COLUMN_ALIASES,
    mapColumns: mapColumns,
    parseExperienceRows: parseExperienceRows,
    extractAreaLabelsFromAddresses: extractAreaLabelsFromAddresses,
    areasMatch: areasMatch,
    evaluateDriverForRoute: evaluateDriverForRoute,
    buildAssignSuggestions: buildAssignSuggestions,
    buildKnownTransportIdSet: buildKnownTransportIdSet,
    parseManifestWorkbook: parseManifestWorkbook,
    extractShiftWorkersFromExecData: extractShiftWorkersFromExecData,
    extractShiftWorkersFromMaster: extractShiftWorkersFromMaster,
  };

  global.AssignSupportCore = AssignSupportCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AssignSupportCore;
  }
})(typeof window !== 'undefined' ? window : global);
