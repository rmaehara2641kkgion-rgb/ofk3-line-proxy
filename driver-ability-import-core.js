/**
 * ドライバー能力DB（ドライバー別配送データ）の取込マージ。DOM非依存。
 *
 * 累計Excel（ファイル名またはシート名に「累計」）は、その行の値がすでに期間合計なので、
 * localStorage上の既存累計へ足すと再加算になる。同一ドライバーはExcel値で置換し、
 * Excelにいない既存ドライバーは触らない。
 *
 * 週次（mode !== 'cumulative'）は index.html の processDriverData 従来仕様のまま:
 * 同日の再取込は上書き、別日は稼働日数・総配送数・正配依頼を加算し個/時間は加重平均。
 */
(function (global) {
  'use strict';

  function isCumulativeDriverUpload(fileName, sheetName) {
    var src = String(fileName || '') + '\n' + String(sheetName || '');
    return src.indexOf('累計') >= 0;
  }

  function findCol(row, patterns) {
    var keys = Object.keys(row || {});
    for (var p = 0; p < patterns.length; p++) {
      var pNorm = String(patterns[p]).replace(/\s+/g, '');
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).replace(/\s+/g, '').indexOf(pNorm) >= 0 && row[keys[i]] != null) {
          return row[keys[i]];
        }
      }
    }
    return null;
  }

  function parseDriverAbilityRow(row) {
    var name = String((row && row['配達アソシエート']) || '').trim();
    var pphRaw = row ? row['1時間あたり配送個数'] : null;
    var pphNumber = parseFloat(pphRaw);
    var packagesPerHour = pphNumber || null;
    var deliveryRateRaw = findCol(row, ['配管率%(平均)', '配管率%', '配管率']);
    var deliveryRate = deliveryRateRaw != null ? parseFloat(String(deliveryRateRaw).replace('%', '')) : null;
    var workDaysRaw = findCol(row, ['集計対象稼働日数', '稼働日数']);
    var workDays = workDaysRaw != null ? parseInt(workDaysRaw) : 0;
    var totalPkgRaw = findCol(row, ['配送個数合計', '配送個数']);
    var totalPackages = totalPkgRaw != null ? parseInt(totalPkgRaw) : 0;
    var incidentRaw = findCol(row, ['正配依頼合計', '正配依頼']);
    var incidents = incidentRaw != null ? parseInt(incidentRaw) : 0;
    var misRateRaw = findCol(row, ['誤配率%', '誤配率']);
    var misdeliveryRate = misRateRaw != null ? parseFloat(String(misRateRaw).replace('%', '')) : null;
    if (misdeliveryRate != null && misdeliveryRate < 1 && misdeliveryRate > 0) {
      misdeliveryRate = Math.round(misdeliveryRate * 10000) / 100;
    }
    if (deliveryRate != null && isNaN(deliveryRate)) deliveryRate = null;
    if (misdeliveryRate != null && isNaN(misdeliveryRate)) misdeliveryRate = null;
    return {
      name: name,
      packagesPerHour: packagesPerHour,
      pphNumber: pphNumber,
      packagesPerHourPresent: pphRaw != null && String(pphRaw).trim() !== '' && !isNaN(pphNumber),
      deliveryRate: deliveryRate,
      deliveryRatePresent: deliveryRateRaw != null && deliveryRate != null,
      misdeliveryRate: misdeliveryRate,
      misdeliveryRatePresent: misRateRaw != null && misdeliveryRate != null,
      workDays: workDays,
      workDaysPresent: workDaysRaw != null,
      totalPackages: totalPackages,
      totalPackagesPresent: totalPkgRaw != null,
      incidents: incidents,
      incidentsPresent: incidentRaw != null
    };
  }

  function assignKeptFields(existing, overrides) {
    var next = {};
    for (var k in existing) next[k] = existing[k];
    for (var ok in overrides) next[ok] = overrides[ok];
    return next;
  }

  function replaceCumulativeDriver(existing, parsed) {
    var replaced = {};
    for (var k in existing) replaced[k] = existing[k];
    if (parsed.packagesPerHourPresent) {
      replaced.packagesPerHour = Math.round(parsed.pphNumber * 10) / 10;
    }
    if (parsed.deliveryRatePresent) replaced.deliveryRate = parsed.deliveryRate;
    if (parsed.misdeliveryRatePresent) replaced.misdeliveryRate = parsed.misdeliveryRate;
    if (parsed.workDaysPresent) replaced.workDays = parsed.workDays;
    if (parsed.totalPackagesPresent) replaced.totalPackages = parsed.totalPackages;
    if (parsed.incidentsPresent) replaced.incidents = parsed.incidents;
    return replaced;
  }

  function applyDriverAbilityRows(driverDB, rows, options) {
    options = options || {};
    var mode = options.mode === 'cumulative' ? 'cumulative' : 'weekly';
    var today = options.today || new Date().toLocaleDateString('ja-JP');
    var nextDriverId = options.nextDriverId || function () { return null; };
    var newlyRegisteredNames = [];
    var list = rows || [];

    for (var i = 0; i < list.length; i++) {
      var row = list[i] || {};
      var parsed = parseDriverAbilityRow(row);
      var name = parsed.name;
      if (!name) continue;
      var packagesPerHour = parsed.packagesPerHour;
      var deliveryRate = parsed.deliveryRate;
      var misdeliveryRate = parsed.misdeliveryRate;
      var workDays = parsed.workDays;
      var totalPackages = parsed.totalPackages;
      var incidents = parsed.incidents;

      if (mode === 'cumulative' && driverDB[name]) {
        var replaced = replaceCumulativeDriver(driverDB[name], parsed);
        replaced.lastUpdated = today;
        replaced.history = (driverDB[name].history || []).concat([{
          date: '累計',
          pph: replaced.packagesPerHour,
          days: replaced.workDays,
          cumulative: true
        }]);
        driverDB[name] = replaced;
        continue;
      }

      if (driverDB[name] && driverDB[name].packagesPerHour && packagesPerHour) {
        var existing = driverDB[name];
        var lastHistory = existing.history && existing.history.length > 0 ? existing.history[existing.history.length - 1] : null;
        if (lastHistory && lastHistory.date === today) {
          var sameDay = assignKeptFields(existing, {
            packagesPerHour: Math.round(packagesPerHour * 10) / 10,
            deliveryRate: deliveryRate || existing.deliveryRate,
            misdeliveryRate: misdeliveryRate || existing.misdeliveryRate,
            workDays: workDays,
            totalPackages: totalPackages,
            incidents: incidents,
            lastUpdated: today
          });
          if (existing.history && existing.history.length > 0) {
            sameDay.history = existing.history.slice(0, -1).concat([{ date: today, pph: packagesPerHour, days: workDays }]);
          }
          driverDB[name] = sameDay;
        } else {
          var totalDays = existing.workDays + workDays;
          var weightedCapability = (existing.packagesPerHour * existing.workDays + packagesPerHour * workDays) / totalDays;
          driverDB[name] = assignKeptFields(existing, {
            packagesPerHour: Math.round(weightedCapability * 10) / 10,
            deliveryRate: deliveryRate || existing.deliveryRate,
            misdeliveryRate: misdeliveryRate || existing.misdeliveryRate,
            workDays: totalDays,
            totalPackages: existing.totalPackages + totalPackages,
            incidents: existing.incidents + incidents,
            lastUpdated: today,
            history: (existing.history || []).concat([{ date: today, pph: packagesPerHour, days: workDays }])
          });
        }
      } else {
        var createdPph = packagesPerHour ? Math.round(packagesPerHour * 10) / 10 : null;
        driverDB[name] = {
          driverId: nextDriverId(),
          packagesPerHour: createdPph,
          deliveryRate: deliveryRate,
          misdeliveryRate: misdeliveryRate,
          workDays: workDays,
          totalPackages: totalPackages,
          incidents: incidents,
          lastUpdated: today,
          history: mode === 'cumulative'
            ? [{ date: '累計', pph: createdPph, days: workDays, cumulative: true }]
            : [{ date: today, pph: packagesPerHour, days: workDays }]
        };
        newlyRegisteredNames.push(name);
      }
    }

    return { newlyRegisteredNames: newlyRegisteredNames };
  }

  var api = {
    isCumulativeDriverUpload: isCumulativeDriverUpload,
    applyDriverAbilityRows: applyDriverAbilityRows
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof global !== 'undefined') {
    global.DriverAbilityImport = api;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
