/**
 * OFK3 LAT — 出発判定・差分表示（UI非依存 + 本番DSP CSV互換ローダー）
 * 差分 = 実績出発 - 予定出発（分）
 */
(function (global) {
  'use strict';

  function latTimeToMin(t) {
    if (!t) return null;
    var m = String(t).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function latMinDiff(t1, t2) {
    var a = latTimeToMin(t1);
    var b = latTimeToMin(t2);
    if (a === null || b === null) return null;
    return a - b;
  }

  function latParseDiffMins(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '' || s === '-' || /^n\/a$/i.test(s)) return null;
    var n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  function latResolveDiffMin(dspDiffMins, actualDep, plannedDep) {
    var parsed = latParseDiffMins(dspDiffMins);
    if (parsed !== null) return parsed;
    return latMinDiff(actualDep, plannedDep);
  }

  function latResolveJudgment(diffMin) {
    if (!Number.isFinite(diffMin)) return '';
    if (diffMin < -10) return '早着出発';
    if (diffMin <= 5) return '定刻';
    return '遅延';
  }

  function latFormatDepDiffText(diffMin) {
    if (!Number.isFinite(diffMin)) return '';
    var rounded = Math.round(diffMin);
    if (rounded === 0) return '定刻';
    if (rounded < 0) return Math.abs(rounded) + '分早';
    return rounded + '分遅';
  }

  function latRoundDiffMin(diffMin) {
    if (!Number.isFinite(diffMin)) return '';
    return Math.round(diffMin * 10) / 10;
  }

  /** タイムラインX軸ラベル間隔（分）。バー位置計算には使わない。 */
  function latAxisLabelStep(rangeMin) {
    if (rangeMin > 720) return 60;
    return 30;
  }

  // ===== 本番DSP CSV向けの堅牢パーサー =====
  // index.html 内の旧/段階的 parser に依存せず、handleDspFile を安全に差し替える。
  function normalizeLatDspHeader(h) {
    return String(h == null ? '' : h)
      .replace(/^\ufeff/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .trim()
      .replace(/[\u3000\s\-\/\.()\[\]]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  function buildLatDspColMap(row) {
    var map = {};
    for (var i = 0; i < (row || []).length; i++) {
      var k = normalizeLatDspHeader(row[i]);
      if (k && map[k] === undefined) map[k] = i;
    }
    return map;
  }

  function findExactCol(map, aliases) {
    for (var i = 0; i < aliases.length; i++) {
      if (map[aliases[i]] !== undefined) return map[aliases[i]];
    }
    return -1;
  }

  function findSemanticCol(map, groups) {
    var keys = Object.keys(map);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      for (var g = 0; g < groups.length; g++) {
        var tokens = groups[g];
        var ok = true;
        for (var t = 0; t < tokens.length; t++) {
          if (key.indexOf(tokens[t]) < 0) { ok = false; break; }
        }
        if (ok) return map[key];
      }
    }
    return -1;
  }

  function resolveRouteIdx(map) {
    var idx = findExactCol(map, ['route_id', 'routeid', 'route_identifier', 'route_identifier_id']);
    if (idx >= 0) return idx;
    return findSemanticCol(map, [['route', 'id']]);
  }

  function resolveEmployeeIdx(map) {
    var idx = findExactCol(map, [
      'employee_id', 'employeeid', 'transporter_id', 'transporterid',
      'transport_id', 'transportid', 'driver_id', 'driverid'
    ]);
    if (idx >= 0) return idx;
    return findSemanticCol(map, [['employee', 'id'], ['transporter', 'id'], ['transport', 'id'], ['driver', 'id']]);
  }

  function resolvePlannedArrivalIdx(map) {
    var idx = findExactCol(map, [
      'planned_arrival', 'planned_arrival_time', 'plan_arrival',
      'scheduled_arrival', 'scheduled_arrival_time', 'arrival_planned',
      'planned_ds_arrival', 'planned_station_arrival'
    ]);
    if (idx >= 0) return idx;
    return findSemanticCol(map, [['planned', 'arrival'], ['plan', 'arrival'], ['scheduled', 'arrival']]);
  }

  function resolvePlannedDepartureIdx(map) {
    var idx = findExactCol(map, [
      'planned_departure', 'planned_departure_time', 'plan_departure',
      'scheduled_departure', 'scheduled_departure_time', 'departure_planned',
      'planned_ds_departure', 'planned_station_departure',
      'departure_plan', 'departure_schedule'
    ]);
    if (idx >= 0) return idx;
    return findSemanticCol(map, [['planned', 'departure'], ['plan', 'departure'], ['scheduled', 'departure'], ['departure', 'plan']]);
  }

  function resolveActualDepartureIdx(map) {
    var idx = findExactCol(map, [
      'route_actual_departure', 'actual_departure', 'actual_departure_time',
      'route_departure_actual', 'departure_actual', 'actual_ds_departure'
    ]);
    if (idx >= 0) return idx;
    return findSemanticCol(map, [['actual', 'departure'], ['route', 'departure', 'actual']]);
  }

  function resolveDateIdx(map) {
    return findExactCol(map, ['date', 'route_date', 'service_date', 'delivery_date', 'operation_date']);
  }

  function resolveBeaconEntranceIdx(map) {
    var idx = findExactCol(map, ['beacon_entrance', 'beacon_entrance_time']);
    if (idx >= 0) return idx;
    return findSemanticCol(map, [['beacon', 'entrance']]);
  }

  function resolveDiffIdx(map) {
    var idx = findExactCol(map, [
      'diff_plan_vs_actual_mins', 'diff_planned_vs_actual_mins',
      'planned_vs_actual_departure_mins', 'departure_diff_mins',
      'departure_difference_mins', 'departure_variance_mins'
    ]);
    if (idx >= 0) return idx;
    return findSemanticCol(map, [['diff', 'plan', 'actual'], ['departure', 'diff'], ['departure', 'variance']]);
  }

  function resolveOnTimeIdx(map) {
    var idx = findExactCol(map, ['on_time_departure', 'ontime_departure', 'departure_on_time']);
    if (idx >= 0) return idx;
    return findSemanticCol(map, [['on', 'time', 'departure']]);
  }

  function scoreHeaderMap(map) {
    var score = 0;
    if (resolveRouteIdx(map) >= 0) score += 10;
    if (resolveEmployeeIdx(map) >= 0) score += 2;
    if (resolvePlannedDepartureIdx(map) >= 0) score += 6;
    if (resolvePlannedArrivalIdx(map) >= 0) score += 2;
    if (resolveActualDepartureIdx(map) >= 0) score += 3;
    if (resolveDiffIdx(map) >= 0) score += 1;
    return score;
  }

  function findBestHeaderRow(rows) {
    var limit = Math.min((rows || []).length, 100);
    var best = { row: -1, score: -1, map: {} };
    for (var r = 0; r < limit; r++) {
      if (!rows[r] || !rows[r].length) continue;
      var map = buildLatDspColMap(rows[r]);
      var score = scoreHeaderMap(map);
      if (score > best.score) best = { row: r, score: score, map: map };
    }
    return best;
  }

  function nonEmptyCell(row, idx) {
    if (idx < 0 || !row) return '';
    var v = row[idx];
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function parseLatDspRows(rows) {
    if (!rows || rows.length < 2) {
      return { map: {}, count: 0, plannedDepartureCount: 0, error: 'no_data', headers: [], headerRowIdx: -1 };
    }

    var best = findBestHeaderRow(rows);
    var headerRowIdx = best.row;
    var colMap = best.map;
    var headers = headerRowIdx >= 0 ? (rows[headerRowIdx] || []) : [];
    var routeIdx = resolveRouteIdx(colMap);
    if (headerRowIdx < 0 || routeIdx < 0) {
      return { map: {}, count: 0, plannedDepartureCount: 0, error: 'no_route_id', headers: headers, headerRowIdx: headerRowIdx };
    }

    var empIdx = resolveEmployeeIdx(colMap);
    var dateIdx = resolveDateIdx(colMap);
    var paIdx = resolvePlannedArrivalIdx(colMap);
    var pdIdx = resolvePlannedDepartureIdx(colMap);
    var adIdx = resolveActualDepartureIdx(colMap);
    var beIdx = resolveBeaconEntranceIdx(colMap);
    var diffIdx = resolveDiffIdx(colMap);
    var otIdx = resolveOnTimeIdx(colMap);

    var map = {};
    var plannedDepartureCount = 0;
    var plannedArrivalCount = 0;
    for (var i = headerRowIdx + 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.length) continue;
      var rid = nonEmptyCell(row, routeIdx);
      if (!rid) continue;

      var rawPd = nonEmptyCell(row, pdIdx);
      var rawPa = nonEmptyCell(row, paIdx);
      var pd = rawPd && typeof global.latExtractTime === 'function' ? global.latExtractTime(rawPd) : rawPd;
      var pa = rawPa && typeof global.latExtractTime === 'function' ? global.latExtractTime(rawPa) : rawPa;
      var rawAd = nonEmptyCell(row, adIdx);
      var ad = rawAd && typeof global.latExtractTime === 'function' ? global.latExtractTime(rawAd) : rawAd;
      var rawBe = nonEmptyCell(row, beIdx);
      var be = rawBe && typeof global.latExtractTime === 'function' ? global.latExtractTime(rawBe) : rawBe;
      if (pd) plannedDepartureCount++;
      if (pa) plannedArrivalCount++;

      map[rid] = {
        employeeId: nonEmptyCell(row, empIdx),
        date: nonEmptyCell(row, dateIdx),
        plannedArrival: pa || '',
        plannedDeparture: pd || '',
        actualDeparture: ad || '',
        beaconEntrance: be || '',
        diffMins: diffIdx >= 0 ? latParseDiffMins(row[diffIdx]) : null,
        onTime: nonEmptyCell(row, otIdx)
      };
    }

    return {
      map: map,
      count: Object.keys(map).length,
      plannedDepartureCount: plannedDepartureCount,
      plannedArrivalCount: plannedArrivalCount,
      headers: headers,
      normalizedHeaders: headers.map(normalizeLatDspHeader),
      headerRowIdx: headerRowIdx,
      headerScore: best.score,
      routeIdx: routeIdx,
      empIdx: empIdx,
      plannedArrivalIdx: paIdx,
      plannedDepartureIdx: pdIdx,
      actualDepartureIdx: adIdx,
      diffIdx: diffIdx,
      error: Object.keys(map).length ? '' : 'no_routes'
    };
  }

  /** index.html の lexical dspRouteMap と window.dspRouteMap を同一オブジェクトのまま更新する */
  function latAssignDspRouteMap(host, map) {
    if (!host || typeof host !== 'object') return {};
    var target = host.dspRouteMap;
    if (!target || typeof target !== 'object') {
      target = {};
      host.dspRouteMap = target;
    }
    for (var k in target) {
      if (Object.prototype.hasOwnProperty.call(target, k)) delete target[k];
    }
    map = map || {};
    for (var rid in map) {
      if (Object.prototype.hasOwnProperty.call(map, rid)) target[rid] = map[rid];
    }
    return target;
  }

  function installProductionDspLoader() {
    if (!global.document || !global.FileReader || !global.XLSX) return;

    global.handleDspFile = function (file) {
      if (!file) return;
      global.__latDspInvocation = {
        source: 'production-loader',
        fileName: file.name,
        invokedAt: Date.now()
      };
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var data = new Uint8Array(e.target.result);
          var wb = XLSX.read(data, { type: 'array' });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
          var parsed = parseLatDspRows(rows);
          global.__latDspLoadDiagnosis = parsed;

          if (parsed.error === 'no_data') {
            alert('DSPファイルにデータがありません');
            return;
          }
          if (parsed.error === 'no_route_id') {
            alert('DSPのroute_id列を特定できません。\n検出ヘッダー: ' + (parsed.headers || []).join(', '));
            return;
          }
          if (!parsed.count) {
            alert('DSPルートを1件も読み込めませんでした。\n検出ヘッダー: ' + (parsed.headers || []).join(', '));
            return;
          }

          latAssignDspRouteMap(global, parsed.map);

          var msg = document.getElementById('dsp-loaded-msg');
          if (msg) {
            msg.classList.remove('hidden');
            msg.textContent = '✅ ' + parsed.count + 'ルート読込済';
            if (parsed.plannedDepartureCount === 0) {
              msg.textContent += ' ⚠ 出発予定列を特定できません';
            }
          }
          var zone = document.getElementById('dsp-drop-zone');
          if (zone) zone.style.borderColor = parsed.plannedDepartureCount > 0 ? '#22c55e' : '#f59e0b';

          if (parsed.plannedDepartureCount === 0) {
            console.warn('[LAT] DSP routes loaded but planned departure was not detected.', parsed);
          }

          if (typeof global.mergeAndRender === 'function') global.mergeAndRender();
        } catch (err) {
          console.error('[LAT] DSP parse failed', err);
          global.__latDspLoadDiagnosis = { error: 'exception', message: String(err && err.message ? err.message : err) };
          alert('DSPファイルの読込に失敗しました: ' + (err && err.message ? err.message : err));
        }
      };
      reader.readAsArrayBuffer(file);
    };

    global.__latProductionDspLoaderInstalled = true;
  }

  var LatDepartureCore = {
    latTimeToMin: latTimeToMin,
    latMinDiff: latMinDiff,
    latParseDiffMins: latParseDiffMins,
    latResolveDiffMin: latResolveDiffMin,
    latResolveJudgment: latResolveJudgment,
    latFormatDepDiffText: latFormatDepDiffText,
    latRoundDiffMin: latRoundDiffMin,
    latAxisLabelStep: latAxisLabelStep,
    normalizeLatDspHeader: normalizeLatDspHeader,
    parseLatDspRows: parseLatDspRows,
    latAssignDspRouteMap: latAssignDspRouteMap,
    installProductionDspLoader: installProductionDspLoader
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LatDepartureCore;
  }
  global.LatDepartureCore = LatDepartureCore;

  // 差し替えタイミング: window 'load' は画像/動画/外部リソースの完了まで待つため、
  // 本番ページ（数MB画像+複数CDN scriptを同期読込）ではDOMContentLoadedより数秒〜
  // 大幅に遅れうる。その間 index.html 側の素の handleDspFile（重複実装・try/catch無し・
  // ヘッダー検出が簡易）がユーザー操作を先取りし、強化loaderへの差し替え前にDSPを
  // 読み込んでしまう競合状態を生む。inline <script> はasync/defer無しの同期実行なので、
  // DOMContentLoaded の時点で必ずinline側のhandleDspFile宣言は完了済み。
  // load ではなく DOMContentLoaded を使い、この競合窓を実質ゼロまで縮める。
  if (global.document) {
    if (global.document.readyState === 'interactive' || global.document.readyState === 'complete') {
      installProductionDspLoader();
    } else if (global.document.addEventListener) {
      global.document.addEventListener('DOMContentLoaded', function () {
        installProductionDspLoader();
      }, { once: true });
    } else if (global.addEventListener) {
      global.addEventListener('load', function () {
        installProductionDspLoader();
      }, { once: true });
    }
  }
})(typeof window !== 'undefined' ? window : global);
