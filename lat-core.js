/**
 * OFK3 LAT（Loading Area Turnover / 出発判定）— 判定・集計処理コア（DOM非依存の純粋関数のみ）
 *
 * index.html の既存LAT実装（normalizeLatDspHeader/latDetectInputFormat/latRawColIdx/
 * latParseRawTurnoverRows/latParseRawRoutesRows/latTryCombineRaw/handleLatFile内のLOW分岐/
 * latExtractTime/latFormatDate/mergeAndRender/renderLatResults/exportLatResult、
 * index.html内 17047-17961行付近）と、lat-departure-core.js（latTimeToMin/latMinDiff/
 * latParseDiffMins/latResolveDiffMin/latResolveJudgment/latResolvePlannedDepartureFromLow/
 * latFormatDepDiffText/latRoundDiffMin）から、DOM/ブラウザAPI（FileReader・document・
 * localStorage・alert・XLSX.writeFile・Blob等）に依存しない部分だけを抽出したもの。
 * 判定ロジック（早着出発<-10分・定刻<=5分・遅延>5分の3閾値、超過時間の算出方法）は
 * 一切変更していない。
 *
 * 対応する3入力形式（列名のみで判定。ファイル名・週番号・列位置・投入順には依存しない）:
 *   1. LOW形式        : loading_area_turnover あり + employee_id あり（単一ファイルで完結）
 *   2. RAW Turnover形式: loading_area_turnover あり + employee_id なし（実績時刻の主データ）
 *   3. RAW Routes形式  : loading_area_turnover なし + employee_id あり +
 *                        (planned_departure or planned_arrival) あり
 *                        （employee_id・planned_departureの供給元。route_id完全一致でJOIN）
 *
 * 【Excel時刻の重要な注意】実データ調査（Wk35 Total Number of DSP Routes.xlsx）で、
 * route_actual_departure列・beacon_entrance列は、Excelの書式設定が壊れており
 * raw:false（セルの表示テキスト）で読むと本来の時刻が"2629.3"のような無意味な文字列に
 * 化けることを実データで確認済み。生のシリアル値（raw:true）自体は正しい。
 * このコアの各parse関数は、呼び出し側が rows を「raw:true（数値シリアルのまま）」で
 * 渡すことを前提とし、時刻はすべて latExtractTime() でシリアル値から復元する。
 * フォーマット済みテキスト(raw:false)には一切依存しない。
 * 唯一の例外は date列で、これは元のhandleLatFileと同じく「日付のみのセルは表示テキストの
 * 方が安全」という既存仕様に合わせ、呼び出し側が date 列だけ raw:false のテキストへ
 * 差し替えた rows を渡すことを想定する（latOverlayDateColumnWithText() を用意した）。
 *
 * ドライバー名解決（TID=employee_id→氏名）はこのコアでは行わない。原本のmergeAndRenderは
 * ブラウザのグローバル変数transportIDs/driverJapaneseNamesに依存しているため、本コアは
 * DOM非依存の方針上、employeeIdのみを保持し driverName は空文字のプレースホルダのまま返す。
 * 呼び出し側がドライバーマスタ取得後に解決する（TWC/DNRの各APIと同じ設計。DNRと同じ
 * 「japaneseName (englishName)」形式を使う場合は dnr-core.js の dnrResolveDriverDisplayName()
 * を呼び出し側で再利用すればよい。本コアはdnr-core.jsに依存しない）。
 */
(function (global) {
  'use strict';

  // ===== 時刻/日付ユーティリティ =====

  // index.html: latExtractTime (17510-17546) を移植。文字列中のHH:MM(:SS)を最優先で抽出し、
  // 無ければExcelシリアル値（数値）から時刻を復元する。フォーマット済みテキストではなく
  // 生のシリアル値から独自に計算するため、Excel側の書式設定が壊れていても影響を受けない。
  function latExtractTime(str) {
    if (!str && str !== 0) return '';
    str = String(str).trim();
    if (!str) return '';
    var m = str.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (m) return m[1];
    var num = parseFloat(str);
    if (!isNaN(num) && str.match(/^-?\d+\.?\d*$/)) {
      if (num > 40000) {
        var timeFrac = num - Math.floor(num);
        var totalSec = Math.round(timeFrac * 86400);
        var hh = Math.floor(totalSec / 3600);
        var mm = Math.floor((totalSec % 3600) / 60);
        var ss = totalSec % 60;
        return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
      }
      if (num >= 0 && num < 1) {
        var totalSec2 = Math.round(num * 86400);
        var hh2 = Math.floor(totalSec2 / 3600);
        var mm2 = Math.floor((totalSec2 % 3600) / 60);
        var ss2 = totalSec2 % 60;
        return (hh2 < 10 ? '0' : '') + hh2 + ':' + (mm2 < 10 ? '0' : '') + mm2 + ':' + (ss2 < 10 ? '0' : '') + ss2;
      }
      if (num >= 1 && num < 86400) {
        var hh3 = Math.floor(num / 3600);
        var mm3 = Math.floor((num % 3600) / 60);
        var ss3 = Math.round(num % 60);
        return (hh3 < 10 ? '0' : '') + hh3 + ':' + (mm3 < 10 ? '0' : '') + mm3 + ':' + (ss3 < 10 ? '0' : '') + ss3;
      }
    }
    return str;
  }

  // index.html: latFormatDate (17549-17581) を移植。exportLatResult自体はこの関数を使わず
  // 生のdate文字列をそのままCSVへ出す（既存仕様どおり無変更）。画面表示用に忠実移植のみ行う。
  function latFormatDate(str) {
    if (!str) return '';
    str = String(str).trim();
    var m = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) return m[1] + '/' + (m[2].length < 2 ? '0' : '') + m[2] + '/' + (m[3].length < 2 ? '0' : '') + m[3];
    var num = parseFloat(str);
    if (!isNaN(num) && num > 40000) {
      var d = new Date((num - 25569) * 86400 * 1000);
      var yy = d.getUTCFullYear();
      var mm = d.getUTCMonth() + 1;
      var dd = d.getUTCDate();
      return yy + '/' + (mm < 10 ? '0' : '') + mm + '/' + (dd < 10 ? '0' : '') + dd;
    }
    var m6 = str.match(/^(\d{6})$/);
    if (m6) {
      var n = m6[1];
      var y = parseInt(n.substring(0, 2));
      var mo = parseInt(n.substring(2, 4));
      var da = parseInt(n.substring(4, 6));
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        var fullY = y < 50 ? 2000 + y : 1900 + y;
        return fullY + '/' + (mo < 10 ? '0' : '') + mo + '/' + (da < 10 ? '0' : '') + da;
      }
    }
    var m8 = str.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m8) return m8[1] + '/' + m8[2] + '/' + m8[3];
    return str;
  }

  // lat-departure-core.js: latTimeToMin を移植（無変更）
  function latTimeToMin(t) {
    if (!t) return null;
    var m = String(t).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  // lat-departure-core.js: latMinDiff を移植（無変更）
  function latMinDiff(t1, t2) {
    var a = latTimeToMin(t1);
    var b = latTimeToMin(t2);
    if (a === null || b === null) return null;
    return a - b;
  }

  // lat-departure-core.js: latParseDiffMins を移植（無変更）
  function latParseDiffMins(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '' || s === '-' || /^n\/a$/i.test(s)) return null;
    var n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // lat-departure-core.js: latResolveDiffMin を移植（無変更）
  function latResolveDiffMin(dspDiffMins, actualDep, plannedDep) {
    var parsed = latParseDiffMins(dspDiffMins);
    if (parsed !== null) return parsed;
    return latMinDiff(actualDep, plannedDep);
  }

  // lat-departure-core.js: latResolveJudgment を移植（無変更・3閾値）
  function latResolveJudgment(diffMin) {
    if (!Number.isFinite(diffMin)) return '';
    if (diffMin < -10) return '早着出発';
    if (diffMin <= 5) return '定刻';
    return '遅延';
  }

  // lat-departure-core.js: latResolvePlannedDepartureFromLow を移植（無変更）
  function latResolvePlannedDepartureFromLow(lowRow) {
    lowRow = lowRow || {};
    var pd = lowRow.plannedDeparture != null ? String(lowRow.plannedDeparture).trim() : '';
    if (pd) return { plannedDeparture: pd, unavailableReason: '' };
    return { plannedDeparture: '', unavailableReason: '予定時刻未設定' };
  }

  // lat-departure-core.js: latFormatDepDiffText を移植（無変更）
  function latFormatDepDiffText(diffMin) {
    if (!Number.isFinite(diffMin)) return '';
    var rounded = Math.round(diffMin);
    if (rounded === 0) return '定刻';
    if (rounded < 0) return Math.abs(rounded) + '分早';
    return rounded + '分遅';
  }

  // lat-departure-core.js: latRoundDiffMin を移植（無変更）
  function latRoundDiffMin(diffMin) {
    if (!Number.isFinite(diffMin)) return '';
    return Math.round(diffMin * 10) / 10;
  }

  // ===== 列マッピング・入力形式判定 =====

  // index.html: handleLatFile冒頭のcolMap構築（17413-17416）を移植。
  // 注意: lat-departure-core.jsのnormalizeLatDspHeader/buildLatDspColMap（空白・記号の畳み込み等、
  // 廃止運用のhandleDspFile専用）とは別物。実際に稼働しているLOW/RAWアダプター経路は
  // 「小文字化+trimのみ」の単純な完全一致マップを使っており、本コアもそれに合わせる
  // （実データのヘッダーは元々snake_caseのため、これで過不足なく機能することを確認済み）。
  function latBuildColMap(headerRow) {
    var colMap = {};
    for (var h = 0; h < (headerRow || []).length; h++) {
      colMap[String(headerRow[h] == null ? '' : headerRow[h]).toLowerCase().trim()] = h;
    }
    return colMap;
  }

  // index.html: handleLatFileの date列上書き処理（17398-17409）を移植。
  // rowsRaw（raw:trueで読んだ2次元配列。1行目はヘッダー）の date列（またはヘッダーが
  // "日付"の場合はそのまま素通し。原本と同じくdateIdx検索は'date'のみに限定 — この
  // 非対称性も既存の仕様のまま変更しない）を rowsText（raw:falseで読んだ同じ範囲）の
  // 値へ差し替えた新しい配列を返す。呼び出し側はraw:true/raw:falseの両方を
  // 用意してこの関数へ渡す。
  function latOverlayDateColumnWithText(rowsRaw, rowsText) {
    if (!rowsRaw || !rowsRaw.length || !rowsText || !rowsText.length) return rowsRaw;
    var hdr = rowsRaw[0] || [];
    var out = rowsRaw.slice();
    for (var ci = 0; ci < hdr.length; ci++) {
      var colName = String(hdr[ci] == null ? '' : hdr[ci]).toLowerCase().trim();
      if (colName === 'date' || colName === '日付') {
        for (var ri = 1; ri < out.length; ri++) {
          if (rowsText[ri] && rowsText[ri][ci] !== undefined && rowsText[ri][ci] !== '') {
            var newRow = out[ri].slice();
            newRow[ci] = rowsText[ri][ci];
            out[ri] = newRow;
          }
        }
        break;
      }
    }
    return out;
  }

  // index.html: latDetectInputFormat (17257-17266) を移植（無変更）。
  // ファイル名・週番号・列位置には一切依存せず、列名の組み合わせのみで判定する。
  function latDetectInputFormat(colMap) {
    if (colMap['route_id'] === undefined) return 'low'; // 既存のroute_idフォールバック探索・既存エラーメッセージへ委ねる
    var hasTurnover = colMap['loading_area_turnover'] !== undefined;
    var hasEmployee = colMap['employee_id'] !== undefined;
    var hasPlannedDep = colMap['planned_departure'] !== undefined;
    var hasPlannedArr = colMap['planned_arrival'] !== undefined;
    if (hasTurnover && !hasEmployee) return 'raw_turnover';
    if (!hasTurnover && hasEmployee && (hasPlannedDep || hasPlannedArr)) return 'raw_routes';
    return 'low';
  }

  function latRawColIdx(colMap, key) {
    return colMap[key] !== undefined ? colMap[key] : -1;
  }

  // ===== RAW Loading Area Turnover（route_id・loading_area_turnoverあり・employee_idなし）=====

  // index.html: latParseRawTurnoverRows (17273-17307) を移植（無変更）。
  // 重複route_idは最初の行を正とし、件数のみ診断情報として記録する（黙って上書き・展開しない）。
  function latParseRawTurnoverRows(rows, colMap) {
    var routeIdx = latRawColIdx(colMap, 'route_id');
    var dateIdx = latRawColIdx(colMap, 'date');
    var waveIdx = latRawColIdx(colMap, 'wave');
    var rcIdx = latRawColIdx(colMap, 'route_code');
    var toIdx = latRawColIdx(colMap, 'loading_area_turnover');
    var baIdx = latRawColIdx(colMap, 'beacon_arrival');
    var benIdx = latRawColIdx(colMap, 'beacon_entrance');
    var bdIdx = latRawColIdx(colMap, 'beacon_departure');
    var bexIdx = latRawColIdx(colMap, 'beacon_exit');
    var fsIdx = latRawColIdx(colMap, 'beacon_firstpackagescan');
    var lsIdx = latRawColIdx(colMap, 'beacon_lastpackagescan');

    var out = {};
    var duplicateCount = 0;
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var rid = row && row[routeIdx] ? String(row[routeIdx]).trim() : '';
      if (!rid) continue;
      if (out[rid]) { duplicateCount++; continue; }
      out[rid] = {
        date: dateIdx >= 0 && row[dateIdx] ? String(row[dateIdx]).trim() : '',
        wave: waveIdx >= 0 && row[waveIdx] ? String(row[waveIdx]).trim() : '',
        routeCode: rcIdx >= 0 && row[rcIdx] ? String(row[rcIdx]).trim() : '',
        turnover: toIdx >= 0 && row[toIdx] ? String(row[toIdx]).trim() : '',
        arrival: baIdx >= 0 && row[baIdx] ? latExtractTime(String(row[baIdx])) : '',
        entrance: benIdx >= 0 && row[benIdx] ? latExtractTime(String(row[benIdx])) : '',
        departure: bdIdx >= 0 && row[bdIdx] ? latExtractTime(String(row[bdIdx])) : '',
        exit: bexIdx >= 0 && row[bexIdx] ? latExtractTime(String(row[bexIdx])) : '',
        firstScan: fsIdx >= 0 && row[fsIdx] ? latExtractTime(String(row[fsIdx])) : '',
        lastScan: lsIdx >= 0 && row[lsIdx] ? latExtractTime(String(row[lsIdx])) : ''
      };
    }
    return { rows: out, count: Object.keys(out).length, duplicateRouteIdCount: duplicateCount };
  }

  // ===== RAW Total Number of DSP Routes（route_id・employee_id・planned_departure/arrivalあり）=====

  // index.html: latParseRawRoutesRows (17310-17328) を移植（無変更）。
  // employee_id と planned_departure のみを供給する（planned_arrival・route_actual_departure・
  // on_time_departure・diff_plan_vs_actual_mins等は原本同様このコアでも読まない。
  // route_actual_departure/beacon_entranceはExcel書式が壊れている実例があり、かつ
  // 実績時刻はTurnover側を正として使うため、そもそも参照する必要がない）。
  function latParseRawRoutesRows(rows, colMap) {
    var routeIdx = latRawColIdx(colMap, 'route_id');
    var empIdx = latRawColIdx(colMap, 'employee_id');
    var pdIdx = latRawColIdx(colMap, 'planned_departure');

    var out = {};
    var duplicateCount = 0;
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var rid = row && row[routeIdx] ? String(row[routeIdx]).trim() : '';
      if (!rid) continue;
      if (out[rid]) { duplicateCount++; continue; }
      out[rid] = {
        employeeId: empIdx >= 0 && row[empIdx] ? String(row[empIdx]).trim() : '',
        plannedDeparture: pdIdx >= 0 && row[pdIdx] != null && row[pdIdx] !== '' ? latExtractTime(String(row[pdIdx])) : ''
      };
    }
    return { rows: out, count: Object.keys(out).length, duplicateRouteIdCount: duplicateCount };
  }

  // ===== LOW（loading_area_turnover + employee_id を単一ファイルで持つ形式）=====

  // index.html: handleLatFileのLOW分岐（17439-17487）を移植（無変更）。
  // route_idが厳密一致で見つからない場合、原本と同じく「route」と「id」の両方を含む
  // 列名へフォールバックする（raw_turnover/raw_routesには無いこの緩いフォールバックは
  // LOW分岐だけの既存仕様）。
  //   { error: 'no_data' }      : 有効行なし（rows.length < 2）
  //   { error: 'no_route_id' }  : route_id列（フォールバック含む）が見つからない
  function latParseLowRows(rows, colMap) {
    if (!rows || rows.length < 2) {
      return { error: 'no_data', map: {}, count: 0 };
    }
    var routeIdx = colMap['route_id'] !== undefined ? colMap['route_id'] : -1;
    if (routeIdx < 0) {
      for (var k in colMap) { if (k.indexOf('route') >= 0 && k.indexOf('id') >= 0) { routeIdx = colMap[k]; break; } }
    }
    if (routeIdx < 0) {
      return { error: 'no_route_id', map: {}, count: 0 };
    }

    var baIdx = colMap['beacon_arrival'] !== undefined ? colMap['beacon_arrival'] : -1;
    var benIdx = colMap['beacon_entrance'] !== undefined ? colMap['beacon_entrance'] : -1;
    var bdIdx = colMap['beacon_departure'] !== undefined ? colMap['beacon_departure'] : -1;
    var bexIdx = colMap['beacon_exit'] !== undefined ? colMap['beacon_exit'] : -1;
    var fsIdx = colMap['beacon_firstpackagescan'] !== undefined ? colMap['beacon_firstpackagescan'] : -1;
    var lsIdx = colMap['beacon_lastpackagescan'] !== undefined ? colMap['beacon_lastpackagescan'] : -1;
    var toIdx = colMap['loading_area_turnover'] !== undefined ? colMap['loading_area_turnover'] : -1;
    var latEmpIdx = colMap['employee_id'] !== undefined ? colMap['employee_id'] : -1;
    var latDateIdx = colMap['date'] !== undefined ? colMap['date'] : -1;
    var latWaveIdx = colMap['wave'] !== undefined ? colMap['wave'] : -1;
    var latRcIdx = colMap['route_code'] !== undefined ? colMap['route_code'] : -1;
    var latPdIdx = colMap['planned_departure'] !== undefined ? colMap['planned_departure'] : -1;

    var map = {};
    var exitSameAsDepartureCount = 0;
    var emptyExitCount = 0;
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var rid = row && row[routeIdx] ? String(row[routeIdx]).trim() : '';
      if (!rid) continue;
      map[rid] = {
        arrival: baIdx >= 0 && row[baIdx] ? latExtractTime(String(row[baIdx])) : '',
        entrance: benIdx >= 0 && row[benIdx] ? latExtractTime(String(row[benIdx])) : '',
        departure: bdIdx >= 0 && row[bdIdx] ? latExtractTime(String(row[bdIdx])) : '',
        exit: bexIdx >= 0 && row[bexIdx] ? latExtractTime(String(row[bexIdx])) : '',
        firstScan: fsIdx >= 0 && row[fsIdx] ? latExtractTime(String(row[fsIdx])) : '',
        lastScan: lsIdx >= 0 && row[lsIdx] ? latExtractTime(String(row[lsIdx])) : '',
        turnover: toIdx >= 0 && row[toIdx] ? String(row[toIdx]).trim() : '',
        employeeId: latEmpIdx >= 0 && row[latEmpIdx] ? String(row[latEmpIdx]).trim() : '',
        date: latDateIdx >= 0 && row[latDateIdx] ? String(row[latDateIdx]).trim() : '',
        wave: latWaveIdx >= 0 && row[latWaveIdx] ? String(row[latWaveIdx]).trim() : '',
        routeCode: latRcIdx >= 0 && row[latRcIdx] ? String(row[latRcIdx]).trim() : '',
        plannedDeparture: latPdIdx >= 0 && row[latPdIdx] != null && row[latPdIdx] !== '' ? latExtractTime(String(row[latPdIdx])) : ''
      };
      if (!map[rid].exit) emptyExitCount++;
      else if (map[rid].exit === map[rid].departure) exitSameAsDepartureCount++;
    }

    return {
      map: map,
      count: Object.keys(map).length,
      hasPlannedDepartureCol: latPdIdx >= 0,
      emptyExitCount: emptyExitCount,
      exitSameAsDepartureCount: exitSameAsDepartureCount
    };
  }

  // ===== RAW 2ファイルJOIN（route_id完全一致。Turnoverが主、Routesはemployee/planned_departureのみ借用）=====

  // index.html: latTryCombineRaw (17332-17386) のJOINロジック本体を移植。
  // DOM操作（lat-loaded-msgへの表示・mergeAndRender呼出）は含まない。
  // 呼び出し側は turnoverRows/turnoverInfo と routesRows/routesInfo の両方が揃った時点で
  // これを呼ぶ（片方だけでは完成させない、という既存仕様の判断は呼び出し側の責務。
  // 原本のUIは「片方だけ保持して待つ」というセッション状態を持つが、それはブラウザの
  // 投入順・保留状態というUI固有の関心事のため、DOM非依存コアには含めない）。
  // fuzzy JOINは行わない（route_id文字列の完全一致のみ）。
  function latCombineRaw(turnoverRows, turnoverInfo, routesRows, routesInfo) {
    var beaconMap = {};
    var matchedEmployeeCount = 0;
    var unmatchedEmployeeCount = 0;
    for (var rid in turnoverRows) {
      var t = turnoverRows[rid];
      var r = routesRows[rid];
      if (r && r.employeeId) matchedEmployeeCount++; else unmatchedEmployeeCount++;
      beaconMap[rid] = {
        arrival: t.arrival, entrance: t.entrance, departure: t.departure, exit: t.exit,
        firstScan: t.firstScan, lastScan: t.lastScan, turnover: t.turnover,
        date: t.date, wave: t.wave, routeCode: t.routeCode,
        employeeId: r ? r.employeeId : '',
        plannedDeparture: r ? r.plannedDeparture : ''
      };
    }
    var routesOnlyCount = 0; // Total Number of DSP Routesには存在するがLoading Area Turnoverに無いroute_id
    for (var rid2 in routesRows) { if (!turnoverRows[rid2]) routesOnlyCount++; }

    return {
      beaconMap: beaconMap,
      diagnosis: {
        turnoverCount: turnoverInfo.count,
        routesCount: routesInfo.count,
        turnoverDuplicateRouteIdCount: turnoverInfo.duplicateRouteIdCount,
        routesDuplicateRouteIdCount: routesInfo.duplicateRouteIdCount,
        matchedEmployeeCount: matchedEmployeeCount,
        unmatchedEmployeeCount: unmatchedEmployeeCount,
        routesOnlyCount: routesOnlyCount,
        beaconMapCount: Object.keys(beaconMap).length
      }
    };
  }

  // ===== mergeAndRender相当（DOM非依存のデータ計算部分）=====

  // index.html: mergeAndRender (17599-17668) のデータ計算部分を移植。
  // DOM描画（renderLatResults/renderLatTimeline/updateQualitySummary呼出）は含まない。
  // driverNameは空文字のプレースホルダのまま返す（TID→氏名解決は呼び出し側の責務。
  // 原本はブラウザのグローバル変数transportIDs/driverJapaneseNamesに依存しているため
  // DOM非依存コアには含めない）。
  function latBuildResultRows(beaconMap) {
    var out = [];
    for (var rid in beaconMap) {
      var lat = beaconMap[rid] || {};
      var empId = lat.employeeId || '';

      var dsArrival = lat.arrival || '';
      var dsEntrance = lat.entrance || '';
      var plannedInfo = latResolvePlannedDepartureFromLow(lat);
      var plannedDep = plannedInfo.plannedDeparture || '';
      var plannedDepDisplay = plannedDep || '未設定';
      var actualDep = lat.departure || '';
      var firstScan = lat.firstScan || '';
      var lastScan = lat.lastScan || '';
      var dsExit = lat.exit || '';

      var loadingMin = latMinDiff(lastScan, firstScan);
      var stayMin = lat.turnover ? parseFloat(lat.turnover) : latMinDiff(dsExit, dsEntrance);

      // index.html mergeAndRenderと同じく、DSP側diffMins(dspDiffMins)は常にnull固定
      // （原本もLOW/RAW経路ではこの値を持たず、実測時刻からの差分計算のみを使う）
      var diffMin = latResolveDiffMin(null, actualDep, plannedDep);
      var judgment = latResolveJudgment(diffMin);
      var judgmentDisplay = judgment || '判定不可';

      out.push({
        routeId: rid,
        employeeId: empId,
        driverName: '', // TID→氏名の解決は呼び出し側（マスタ取得後）で行う
        date: lat.date || '',
        wave: lat.wave || '',
        routeCode: lat.routeCode || '',
        plannedArrival: '', // 原本のmergeAndRenderも常に空文字固定（Total Number of DSP Routesにplanned_arrival列があっても未使用）
        dsArrival: dsArrival,
        dsEntrance: dsEntrance,
        firstScan: firstScan,
        lastScan: lastScan,
        plannedDeparture: plannedDep,
        plannedDepartureDisplay: plannedDepDisplay,
        actualDeparture: actualDep,
        dsExit: dsExit,
        diffMin: latRoundDiffMin(diffMin),
        diffDisplay: Number.isFinite(diffMin) ? latFormatDepDiffText(diffMin) : '-',
        loadingMin: loadingMin !== null ? loadingMin : '',
        stayMin: stayMin !== null && !isNaN(stayMin) ? Math.round(stayMin * 10) / 10 : '',
        judgment: judgment,
        judgmentDisplay: judgmentDisplay
      });
    }
    return out;
  }

  // 新規: ドライバーマスタ配列（fetchFtdsDriverMaster()の戻り値と同じ
  // [{transportId, englishName, japaneseName, ...}, ...] 形状。FTDS/CC/DNR/TWCの各APIが
  // 共通で使っているものと同一）から、TID(TransportID)→englishName/japaneseNameのマップを
  // 構築する。表示名の組み立て（「japaneseName (englishName)」形式へのラップ）自体はここでは
  // 行わない（呼び出し側でdnr-core.jsのdnrResolveDriverDisplayName()を再利用する）。
  //
  // 実データ調査で、同一TransportIDがマスタ配列に複数回出現するケース（入れ替え・再登録等で
  // 一部フィールドが空の重複レコードが残っている）があることを確認済み（TWCの氏名重複調査でも
  // 同種のマスタ品質問題を確認済み）。単純に配列を先頭から辿って毎回上書きすると、後から
  // 出現した空文字が先に見つかった正しい氏名を消してしまうことがあるため、englishName・
  // japaneseNameそれぞれ独立に「最初に見つかった空でない値」を採用する（後勝ちにしない）。
  // TID完全一致ルールは維持し、fuzzy matchや氏名の新規合成は一切行わない。
  function latBuildTidNameMaps(master) {
    var tidToName = {};
    var tidToJapaneseName = {};
    for (var mi = 0; mi < (master || []).length; mi++) {
      var mtid = String((master[mi] && master[mi].transportId) || '').trim();
      if (!mtid) continue;
      var en = (master[mi].englishName || '');
      var ja = (master[mi].japaneseName || '');
      if (en && !tidToName[mtid]) tidToName[mtid] = en;
      if (ja && !tidToJapaneseName[mtid]) tidToJapaneseName[mtid] = ja;
    }
    return { tidToName: tidToName, tidToJapaneseName: tidToJapaneseName };
  }

  // 新規: 現行マスタのenglishName表記揺れ（例: "玲緒 山田 山" のように、姓の断片トークンが
  // 余計に付与されている）を、信頼できる情報源であるjapaneseNameの構成語（トークン）と
  // 照合することで安全に吸収する。マスタデータそのものは書き換えない（表示用の値だけを
  // 補正する）。
  //
  // ルール（一般化のみ。個別のTID・氏名の分岐は一切行わない）:
  //   1. englishName・japaneseNameを空白（半角/全角）でトークン分割する
  //   2. englishNameの各トークンについて、japaneseNameのトークン集合に完全一致するものだけを
  //      残す（重複トークンは最初の1回のみ採用）。部分一致・類似度判定は行わない
  //      （fuzzy matchではなく、トークンの完全一致比較のみ）
  //   3. 1つも一致しない場合（ローマ字表記等、той文字体系が異なりそもそも比較できない場合）や、
  //      全トークンが一致する場合（元から正常）は、englishNameを一切変更せず返す
  //      （安全側に倒す＝判定に自信が持てない時は手を加えない）
  //
  // 例: englishName="玲緒 山田 山"(3トークン), japaneseName="山田 玲緒"(2トークン)
  //     → "山" はjapaneseNameのどのトークンにも一致しないため除去 → "玲緒 山田"
  // 例: englishName="優人 小野", japaneseName="小野 優人" → 全トークン一致のため無変更
  // 例: englishName="yuusuke oki", japaneseName="沖 裕介" → 1つも一致しないため無変更
  function latNormalizeEnglishNameTokens(englishName, japaneseName) {
    var en = String(englishName || '').trim();
    var ja = String(japaneseName || '').trim();
    if (!en || !ja) return en;
    var enTokens = en.split(/[\s　]+/).filter(Boolean);
    if (enTokens.length <= 1) return en;
    var jaTokenSet = {};
    ja.split(/[\s　]+/).filter(Boolean).forEach(function (t) { jaTokenSet[t] = true; });
    var seen = {};
    var filtered = [];
    for (var i = 0; i < enTokens.length; i++) {
      var t = enTokens[i];
      if (jaTokenSet[t] && !seen[t]) { filtered.push(t); seen[t] = true; }
    }
    if (filtered.length === 0 || filtered.length === enTokens.length) return en;
    return filtered.join(' ');
  }

  // 新規: TID解決済みのenglishName/japaneseNameから、既存表示仕様（DNRと同じ
  // 「japaneseName (englishName)」形式）に沿った表示名を1件分組み立てる。
  //   - englishNameの表記揺れ吸収（TwcCore.twcDedupeDisplayNameによる自己重複除去は
  //     呼び出し側で適用済みの値を受け取る想定。ここではjapaneseNameとのトークン照合のみ行う）
  //   - japaneseNameが取得できていればenglishName側の異常だけを理由に空文字（＝(未特定)）へ
  //     落とさない（englishNameが空でもjapaneseNameだけで表示する）
  //   - 表示形式の組み立て自体はdnr-core.jsのdnrResolveDriverDisplayNameをそのまま利用する
  //     （呼び出し側から渡してもらう。lat-core.jsはdnr-core.jsに依存しない設計を維持するため）
  function latResolveDriverDisplayName(englishName, japaneseName, dnrResolveDriverDisplayNameFn) {
    var en = String(englishName || '').trim();
    var ja = String(japaneseName || '').trim();
    if (!en && !ja) return '';
    if (en && ja) {
      var cleanedEn = latNormalizeEnglishNameTokens(en, ja);
      return dnrResolveDriverDisplayNameFn(cleanedEn, ja);
    }
    return ja || en;
  }

  // index.html: latResultHasPlannedDepartureSource (17670-17675) を移植（無変更）
  function latResultHasPlannedDepartureSource(latResultData) {
    for (var i = 0; i < latResultData.length; i++) {
      if (latResultData[i].plannedDeparture) return true;
    }
    return false;
  }

  // ===== exportLatResult相当（CSV行生成。Blob/ダウンロードはUI側の責務）=====

  // index.html: exportLatResult (17933-17953) の行生成部分を移植（無変更）。
  // showPlannedColsがtrueの場合、出発予定列（10番目）と差分(分)/判定列（末尾）が
  // 動的に追加される既存仕様をそのまま維持する。
  function latBuildExportCsvRows(latResultData) {
    var showPlannedCols = latResultHasPlannedDepartureSource(latResultData);
    var header = ['日付', 'Wave', 'ドライバー名', 'TransportID', 'Route ID', 'Route Code', 'DS到着', 'DS入場', 'FirstScan', 'LastScan', '実出発', 'DS退出', '積込時間(分)', '滞在時間(分)'];
    if (showPlannedCols) {
      header.splice(10, 0, '出発予定');
      header.push('差分(分)', '判定');
    }
    var rows = [header];
    for (var i = 0; i < latResultData.length; i++) {
      var r = latResultData[i];
      var row = [r.date, r.wave || '', r.driverName || '(未特定)', r.employeeId, r.routeId, r.routeCode || '', r.dsArrival || '', r.dsEntrance || '', r.firstScan || '', r.lastScan || '', r.actualDeparture || '', r.dsExit || '', r.loadingMin, r.stayMin];
      if (showPlannedCols) {
        row.splice(10, 0, (r.plannedDeparture || r.plannedDepartureDisplay || '未設定'));
        row.push((r.diffMin !== '' && r.diffMin !== null ? r.diffMin : '-'), (r.judgment || r.judgmentDisplay || '判定不可'));
      }
      rows.push(row);
    }
    return { rows: rows, showPlannedCols: showPlannedCols };
  }

  // index.html: exportLatResult (17951-17954) のCSV文字列化＋BOM付与を移植（無変更）
  function latRowsToCsvString(rows) {
    var csv = rows.map(function (row) {
      return row.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    return '﻿' + csv;
  }

  var LatCore = {
    latExtractTime: latExtractTime,
    latFormatDate: latFormatDate,
    latTimeToMin: latTimeToMin,
    latMinDiff: latMinDiff,
    latParseDiffMins: latParseDiffMins,
    latResolveDiffMin: latResolveDiffMin,
    latResolveJudgment: latResolveJudgment,
    latResolvePlannedDepartureFromLow: latResolvePlannedDepartureFromLow,
    latFormatDepDiffText: latFormatDepDiffText,
    latRoundDiffMin: latRoundDiffMin,
    latBuildColMap: latBuildColMap,
    latOverlayDateColumnWithText: latOverlayDateColumnWithText,
    latDetectInputFormat: latDetectInputFormat,
    latParseRawTurnoverRows: latParseRawTurnoverRows,
    latParseRawRoutesRows: latParseRawRoutesRows,
    latParseLowRows: latParseLowRows,
    latCombineRaw: latCombineRaw,
    latBuildResultRows: latBuildResultRows,
    latBuildTidNameMaps: latBuildTidNameMaps,
    latNormalizeEnglishNameTokens: latNormalizeEnglishNameTokens,
    latResolveDriverDisplayName: latResolveDriverDisplayName,
    latResultHasPlannedDepartureSource: latResultHasPlannedDepartureSource,
    latBuildExportCsvRows: latBuildExportCsvRows,
    latRowsToCsvString: latRowsToCsvString
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LatCore;
  }
  if (typeof global !== 'undefined') {
    global.LatCore = LatCore;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
