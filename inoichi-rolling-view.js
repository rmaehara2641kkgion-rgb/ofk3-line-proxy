/**
 * INO-1 dashboard view for rolling 60h.
 * Hours, overBy, and judgment come from the existing engine output.
 * This module does not slide windows or convert shift codes.
 * With a reference date, rows are split into current / future / past using inoichi-rolling-horizon.js
 * (display only: counts stay the engine counts that FRIDAY already receives).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.InoichiRollingView = api;
})(this, function () {
  'use strict';

  var Horizon = null;
  try { Horizon = require('./inoichi-rolling-horizon.js'); } catch (e) { Horizon = (typeof window !== 'undefined' && window.InoichiRollingHorizon) || null; }

  var FETCH_LABEL = {
    success: '取得成功',
    partial: '一部取得',
    failed: '取得失敗',
    missing: 'データ未取得',
    expired: 'データ期限切れ',
  };

  var STATUS_LABEL = {
    exceed: '60h超過',
    approach: '60h接近',
    'partial-exceed': '一部取得（超過を含む）',
    'partial-approach': '一部取得（接近を含む）',
    partial: '一部取得',
    undetermined: '判定不能',
    'duty-unconfirmed': '勤務予定未確認',
    resolved: '超過解消',
    'future-exceed': '将来超過あり',
  };

  var APPROACH_NOTE = '超過は7日合計が60時間を超えたときだけです。60時間ちょうどは注意です。現在は基準日を終端とする7日間です。過去の超過は履歴、将来の超過は別の警告として表示し、現在の判定とは混ぜません。';

  function fetchStatusOf(summary) {
    if (!summary) return 'missing';
    if (summary.expired === true || summary.fetchStatus === 'expired') return 'expired';
    var success = Number(summary.fileSuccess);
    var failure = Number(summary.fileFailure);
    if (!isFinite(success)) success = 0;
    if (!isFinite(failure)) failure = 0;
    if (success === 0 && failure === 0 && summary.ok !== true) return 'missing';
    if (summary.ok !== true && success === 0) return 'failed';
    if (failure > 0) return 'partial';
    if (summary.ok === true) return 'success';
    return 'failed';
  }

  function blankCounts() {
    return {
      driverCount: null,
      clearCount: null,
      exceedCount: null,
      approachCount: null,
      partialCount: null,
      undeterminedCount: null,
      dutyUnconfirmedCount: null,
    };
  }

  function countsFrom(summary) {
    return {
      driverCount: summary.driverCount,
      clearCount: summary.clearCount,
      exceedCount: summary.exceedCount,
      approachCount: summary.approachCount,
      partialCount: summary.partialCount,
      undeterminedCount: summary.undeterminedCount,
      dutyUnconfirmedCount: summary.dutyUnconfirmedCount == null ? null : summary.dutyUnconfirmedCount,
    };
  }

  function hoursText(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  // 元データは小数の時間。分は hours*60 を四捨五入し、秒は作らない。
  function hourMinuteText(hours) {
    if (typeof hours !== 'number' || !isFinite(hours)) return '取得不可';
    var sign = hours < 0 ? -1 : 1;
    var minutes = Math.round(Math.abs(hours) * 60);
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return (sign < 0 ? '-' : '') + h + '時間' + m + '分';
  }

  function gapText(totalHours, kind) {
    if (typeof totalHours !== 'number' || !isFinite(totalHours)) return '取得不可';
    if (kind === 'approach') return hourMinuteText(60 - totalHours);
    if (kind === 'exceed') return hourMinuteText(totalHours - 60);
    return '取得不可';
  }

  function rankOf(disposition) {
    if (disposition === 'exceed') return 0;
    if (disposition === 'partial-exceed') return 1;
    if (disposition === 'approach') return 2;
    if (disposition === 'future-exceed') return 2.5;
    if (disposition === 'partial-approach') return 3;
    if (disposition === 'partial') return 4;
    if (disposition === 'undetermined') return 5;
    if (disposition === 'resolved') return 6;
    return 7;
  }

  function primaryWindow(driver, disposition) {
    var windows = driver.windows || [];
    var want = disposition === 'exceed' || disposition === 'partial-exceed' ? 'exceed'
      : disposition === 'approach' || disposition === 'partial-approach' ? 'approach'
      : disposition === 'undetermined' ? 'undetermined'
      : 'within';
    var pool = windows.filter(function (item) { return item && item.judgment === want; });
    if (!pool.length) pool = windows.filter(Boolean);
    pool.sort(function (a, b) {
      var ao = a.judgment === 'exceed' && typeof a.overBy === 'number' ? a.overBy : -1;
      var bo = b.judgment === 'exceed' && typeof b.overBy === 'number' ? b.overBy : -1;
      if (bo !== ao) return bo - ao;
      var at = typeof a.totalHours === 'number' ? a.totalHours : -1;
      var bt = typeof b.totalHours === 'number' ? b.totalHours : -1;
      if (bt !== at) return bt - at;
      return String(b.endDate || '').localeCompare(String(a.endDate || ''));
    });
    return pool[0] || null;
  }

  function focusWindow(driver, disposition) {
    var windows = driver && driver.windows || [];
    if (driver && driver.referenceDate && (disposition === 'approach' || disposition === 'partial-approach' || disposition === 'duty-unconfirmed')) {
      var todayWindow = null;
      windows.forEach(function (window) {
        if (window && window.endDate === driver.referenceDate) todayWindow = window;
      });
      if (todayWindow) return todayWindow;
    }
    return primaryWindow(driver, disposition);
  }

  function basisOf(prediction, disposition) {
    if (!prediction || !Array.isArray(prediction.days) || prediction.days.length !== 7) {
      return { basis: 'unknown', basisLabel: '根拠なし' };
    }
    var future = prediction.future === true;
    var allDaily = prediction.days.every(function (day) {
      return day && (day.origin === 'daily-estimate' || day.origin === 'archived-daily');
    });
    var anyPlan = prediction.days.some(function (day) {
      return day && day.origin === 'roster-plan';
    });
    var exceed = disposition === 'exceed' || disposition === 'partial-exceed';
    var approach = disposition === 'approach' || disposition === 'partial-approach';
    if (future && exceed) return { basis: 'forecast', basisLabel: '超過予測' };
    if (future && approach) return { basis: 'forecast', basisLabel: '接近予測' };
    if (future) return { basis: 'forecast', basisLabel: '予定を含む' };
    if (allDaily && exceed) return { basis: 'actual', basisLabel: '実績超過' };
    if (allDaily && approach) return { basis: 'actual', basisLabel: '実績接近' };
    if (allDaily) return { basis: 'actual', basisLabel: '実績' };
    if (anyPlan) return { basis: 'plan', basisLabel: '予定を含む' };
    return { basis: 'unknown', basisLabel: '根拠なし' };
  }

  function makeRow(driver, disposition, win, change, checkedAt, prediction) {
    var same = 0;
    if (win) {
      (driver.windows || []).forEach(function (item) {
        if (item && item.judgment === win.judgment) same++;
      });
    }
    var over = win && win.judgment === 'exceed' && typeof win.overBy === 'number' ? win.overBy : null;
    var total = win && typeof win.totalHours === 'number' ? win.totalHours : null;
    return {
      name: driver && driver.name ? driver.name : '氏名未照合',
      company: driver && driver.company ? driver.company : '—',
      transportId: driver && driver.transportId ? driver.transportId : '',
      startDate: win ? win.startDate : '',
      endDate: win ? win.endDate : '',
      windowLabel: win ? (win.startDate + ' 〜 ' + win.endDate) : '—',
      totalHours: total,
      totalHoursText: hoursText(total),
      actualHours: win && typeof win.actualHours === 'number' ? win.actualHours : null,
      rosterHours: win && typeof win.rosterHours === 'number' ? win.rosterHours : null,
      todayDuty: driver && driver.todayDuty ? driver.todayDuty : '',
      preTodayHours: driver && typeof driver.preTodayHours === 'number' ? driver.preTodayHours : null,
      preTodayStart: driver && driver.preTodayStart ? driver.preTodayStart : '',
      preTodayEnd: driver && driver.preTodayEnd ? driver.preTodayEnd : '',
      todayWindowHours: driver && typeof driver.todayWindowHours === 'number' ? driver.todayWindowHours : null,
      overBy: over,
      overByText: over === null ? '—' : hoursText(over),
      disposition: disposition,
      statusLabel: STATUS_LABEL[disposition] || '判定不能',
      basis: basisOf(prediction, disposition).basis,
      basisLabel: basisOf(prediction, disposition).basisLabel,
      change: change,
      checkedAt: checkedAt || null,
      extraWindows: same > 1 ? same - 1 : 0,
      rank: rankOf(disposition),
    };
  }

  function findDriver(drivers, subjectId) {
    for (var i = 0; i < drivers.length; i++) {
      if (drivers[i] && drivers[i].transportId === subjectId) return drivers[i];
    }
    return null;
  }

  function referenceOf(options, summary) {
    // checkedAt（実行日時）は基準日の代わりにしない。再計算や日付またぎで食い違うため。
    var given = options.referenceDate || summary.referenceDate || '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof given === 'string' ? given : '');
    if (m) {
      var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]) return { date: given, source: 'run' };
    }
    return { date: '', source: 'missing' };
  }

  function build(options) {
    options = options || {};
    var summary = options.summary || {};
    var status = fetchStatusOf(summary);
    var usable = status === 'success' || status === 'partial';
    var drivers = options.drivers || [];
    var predictions = options.predictions || [];
    var prior = options.priorPredictions || [];
    var History = options.history || null;
    var DryRun = options.dryRun || null;
    if (!History) {
      try { History = require('./harvest-rolling60h-history.js'); } catch (e) { History = null; }
    }
    if (!DryRun) {
      try { DryRun = require('./inoichi-rolling-dryrun.js'); } catch (e2) { DryRun = null; }
    }
    var explained = History && typeof History.explain === 'function'
      ? History.explain(prior, predictions)
      : { counts: {}, changes: [] };
    var duplicate = summary.historyDuplicate === true;
    var previousKeys = [];
    prior.forEach(function (item) {
      if (!item || (item.level !== 'exceed' && item.level !== 'approach')) return;
      previousKeys.push(['rolling60h', item.subjectId, item.start, item.end, item.level].join('|'));
    });
    if (duplicate && DryRun) {
      var preview = DryRun.fromDrivers(drivers);
      previousKeys = (preview.alerts || []).map(function (alert) { return alert.alertKey; });
    }
    var dry = DryRun ? DryRun.fromDrivers(drivers, { previousKeys: previousKeys }) : { alerts: [], sent: false };
    var dryByKey = {};
    (dry.alerts || []).forEach(function (alert) { dryByKey[alert.alertKey] = alert; });
    var bySubject = {};
    (explained.changes || []).forEach(function (change) {
      if (!change || !change.subjectId) return;
      if (!bySubject[change.subjectId]) bySubject[change.subjectId] = [];
      bySubject[change.subjectId].push(change);
    });
    var predictionByKey = {};
    predictions.forEach(function (item) {
      if (!item) return;
      predictionByKey[item.subjectId + '\t' + item.start + '\t' + item.end] = item;
    });

    var ref = Horizon ? referenceOf(options, summary) : { date: '', source: '' };
    var horizonOn = !!(Horizon && ref.date);
    var pastExceeds = [];
    var horizonCounts = { currentExceed: 0, actualExceed: 0, forecastExceed: 0, caution: 0, futureWarning: 0, pastExceedPersons: 0 };

    function horizonRow(driver) {
      var h = Horizon.horizonOf(driver, ref.date, function (start, end) {
        return predictionByKey[driver.transportId + '\t' + start + '\t' + end] || null;
      });
      if (h.past.length) {
        horizonCounts.pastExceedPersons++;
        h.past.forEach(function (item) {
          pastExceeds.push({
            transportId: driver.transportId || '',
            name: driver.name || '氏名未照合',
            startDate: item.startDate,
            endDate: item.endDate,
            totalHours: item.totalHours,
            totalHoursText: Horizon.clockText(item.totalHours),
            overBy: item.overBy,
            overByText: Horizon.clockText(item.overBy),
            period: 'past',
            periodLabel: '過去の超過（履歴）',
          });
        });
      }
      var disposition;
      var win;
      var label;
      var basis;
      if (h.code === 'actual-exceed' || h.code === 'forecast-exceed') {
        disposition = 'exceed';
        win = h.current.window;
        label = Horizon.LABEL[h.code];
        basis = h.code === 'actual-exceed' ? 'actual' : 'forecast';
        horizonCounts.currentExceed++;
        horizonCounts[h.code === 'actual-exceed' ? 'actualExceed' : 'forecastExceed']++;
      } else if (h.code === 'caution') {
        disposition = 'approach';
        win = h.current.window;
        label = Horizon.LABEL.caution;
        basis = h.provisional ? 'forecast' : 'actual';
        horizonCounts.caution++;
      } else if (h.code === 'review') {
        disposition = 'undetermined';
        win = h.current ? h.current.window : null;
        label = Horizon.LABEL.review;
        basis = 'unknown';
      } else if (h.future) {
        disposition = 'future-exceed';
        win = null;
        label = STATUS_LABEL['future-exceed'];
        basis = 'forecast';
      } else {
        return null;
      }
      if (h.future) horizonCounts.futureWarning++;
      var shownWin = win;
      var futureWin = null;
      if (h.future) {
        futureWin = {
          startDate: h.future.top.startDate,
          endDate: h.future.top.endDate,
          totalHours: h.future.top.totalHours,
          overBy: h.future.top.overBy,
          totalHoursText: Horizon.clockText(h.future.top.totalHours),
          overByText: Horizon.clockText(h.future.top.overBy),
          count: h.future.count,
        };
        if (disposition === 'future-exceed') shownWin = { startDate: futureWin.startDate, endDate: futureWin.endDate, totalHours: futureWin.totalHours, overBy: futureWin.overBy, judgment: 'exceed' };
      }
      var pred = shownWin ? predictionByKey[driver.transportId + '\t' + shownWin.startDate + '\t' + shownWin.endDate] : null;
      var judged = h.current ? h.current.judged : null;
      var shownTotal = disposition === 'future-exceed' ? futureWin.totalHours : (judged ? judged.total : null);
      var shownOver = disposition === 'exceed' ? judged.overBy : (disposition === 'future-exceed' ? futureWin.overBy : null);
      var change = '変化なし';
      if (duplicate) change = 'データ更新なし';
      else if (disposition === 'exceed' || disposition === 'approach') {
        var key = ['rolling60h', driver.transportId, win.startDate, win.endDate, win.judgment].join('|');
        var alertOn = dryByKey[key];
        change = alertOn && alertOn.status === 'ONGOING' ? (disposition === 'exceed' ? '継続超過' : '継続接近') : (disposition === 'exceed' ? '新規超過' : '新規接近');
      } else if (disposition === 'future-exceed') change = '将来警告';
      var row = makeRow(driver, disposition, shownWin, change, summary.checkedAt, pred);
      row.statusLabel = label + (h.provisional && disposition !== 'future-exceed' && disposition !== 'undetermined' ? '・暫定' : '');
      row.judgmentCode = h.code;
      row.period = disposition === 'future-exceed' ? 'future' : 'current';
      row.periodLabel = row.period === 'future' ? '将来' : '現在';
      row.provisional = h.provisional;
      row.basis = basis;
      row.basisLabel = disposition === 'future-exceed' ? '将来超過' : (basis === 'actual' ? '実績' + (disposition === 'exceed' ? '超過' : '') : basis === 'forecast' ? (disposition === 'exceed' ? '超過予測' : '予定を含む') : '根拠なし');
      if (h.code === 'actual-exceed') row.basisLabel = '実績超過';
      row.totalHours = shownTotal;
      row.totalHoursText = Horizon.clockText(shownTotal);
      row.overBy = shownOver;
      row.overByText = shownOver == null ? '—' : Horizon.clockText(shownOver);
      row.windowStart = shownWin ? shownWin.startDate : h.windowStart;
      row.windowEnd = shownWin ? shownWin.endDate : h.windowEnd;
      row.futureExceed = futureWin;
      row.pastExceedCount = h.past.length;
      row.rank = disposition === 'exceed' ? (h.code === 'actual-exceed' ? 0 : 0.5) : rankOf(disposition);
      return row;
    }

    var rows = [];
    if (usable && horizonOn) {
      drivers.forEach(function (driver) {
        var row = horizonRow(driver);
        if (row) rows.push(row);
      });
    }
    if (usable && !horizonOn && Horizon) {
      // 基準日が不明なときは現在・過去・将来を区別できない。超過とも正常とも言わず、要確認にする。
      drivers.forEach(function (driver) {
        var disposition = driver && driver.disposition ? driver.disposition : 'undetermined';
        if (disposition === 'clear') return;
        var row = makeRow(driver, 'undetermined', null, duplicate ? 'データ更新なし' : '変化なし', summary.checkedAt, null);
        row.statusLabel = '基準日不明（要確認）';
        row.period = 'unknown';
        row.periodLabel = '基準日不明';
        row.basis = 'unknown';
        row.basisLabel = '根拠なし';
        rows.push(row);
      });
    }
    if (usable && !horizonOn && !Horizon) {
      drivers.forEach(function (driver) {
        var disposition = driver && driver.disposition ? driver.disposition : 'undetermined';
        if (disposition === 'clear') return;
        var win = focusWindow(driver, disposition);
        var change = '変化なし';
        var subjectChanges = bySubject[driver.transportId] || [];
        if (duplicate) {
          change = 'データ更新なし';
        } else if (disposition === 'exceed' || disposition === 'partial-exceed') {
          var key = win ? ['rolling60h', driver.transportId, win.startDate, win.endDate, win.judgment].join('|') : '';
          var alert = dryByKey[key];
          change = alert && alert.status === 'ONGOING' ? '継続超過' : '新規超過';
        } else if (disposition === 'approach' || disposition === 'partial-approach') {
          var approachKey = win ? ['rolling60h', driver.transportId, win.startDate, win.endDate, win.judgment].join('|') : '';
          var approachAlert = dryByKey[approachKey];
          change = approachAlert && approachAlert.status === 'ONGOING' ? '継続接近' : '新規接近';
        } else if (subjectChanges.some(function (item) { return item.change === 'undetermined'; })) {
          change = '判定不能への変化';
        }
        var matched = win ? predictionByKey[driver.transportId + '\t' + win.startDate + '\t' + win.endDate] : null;
        rows.push(makeRow(driver, disposition, win, change, summary.checkedAt, matched));
      });

      if (!duplicate) {
        var seenResolved = {};
        (explained.changes || []).forEach(function (change) {
          if (!change || change.change !== 'resolved') return;
          var id = change.subjectId + '\t' + change.start + '\t' + change.end;
          if (seenResolved[id]) return;
          seenResolved[id] = true;
          var driver = findDriver(drivers, change.subjectId);
          var current = predictionByKey[id];
          var synthetic = {
            name: driver && driver.name ? driver.name : '',
            company: driver && driver.company ? driver.company : '',
            transportId: driver ? driver.transportId : change.subjectId,
            windows: [{
              judgment: 'within',
              startDate: change.start,
              endDate: change.end,
              totalHours: current && typeof current.predictedTotal === 'number' ? current.predictedTotal : null,
              overBy: 0,
            }],
          };
          rows.push(makeRow(synthetic, 'resolved', synthetic.windows[0], '超過解消', summary.checkedAt, current));
        });
      }
    }

    function basisOrder(basis) {
      if (basis === 'actual') return 0;
      if (basis === 'forecast') return 1;
      if (basis === 'plan') return 2;
      return 3;
    }

    rows.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      var basisDiff = basisOrder(a.basis) - basisOrder(b.basis);
      if (basisDiff !== 0) return basisDiff;
      var ao = typeof a.overBy === 'number' ? a.overBy : -1;
      var bo = typeof b.overBy === 'number' ? b.overBy : -1;
      if (bo !== ao) return bo - ao;
      return String(a.name).localeCompare(String(b.name), 'ja');
    });

    function countChange(label) {
      var n = 0;
      rows.forEach(function (row) { if (row.change === label) n++; });
      return n;
    }

    var basisCounts = { actualExceed: 0, forecastExceed: 0, planExceed: 0, unknownExceed: 0 };
    rows.forEach(function (row) {
      if (row.disposition !== 'exceed' && row.disposition !== 'partial-exceed') return;
      if (row.basis === 'actual') basisCounts.actualExceed++;
      else if (row.basis === 'forecast') basisCounts.forecastExceed++;
      else if (row.basis === 'plan') basisCounts.planExceed++;
      else basisCounts.unknownExceed++;
    });

    return {
      fetchStatus: status,
      fetchLabel: FETCH_LABEL[status] || FETCH_LABEL.missing,
      checkedAt: summary.checkedAt || null,
      usable: usable,
      counts: usable ? countsFrom(summary) : blankCounts(),
      changes: {
        newExceed: usable && !duplicate ? countChange('新規超過') : 0,
        ongoingExceed: usable && !duplicate ? countChange('継続超過') : 0,
        resolvedExceed: usable && !duplicate ? countChange('超過解消') : 0,
        becameUndetermined: usable && !duplicate ? countChange('判定不能への変化') : 0,
        dataUnchanged: duplicate ? 1 : 0,
      },
      history: explained.counts || {},
      basisCounts: usable ? basisCounts : { actualExceed: 0, forecastExceed: 0, planExceed: 0, unknownExceed: 0 },
      missingShiftMonths: usable ? (summary.missingShiftMonths || '') : '',
      missingShiftWindows: usable ? (summary.missingShiftWindows || 0) : 0,
      alerts: rows,
      horizon: horizonOn ? {
        version: Horizon.VERSION,
        referenceDate: ref.date,
        referenceDateSource: ref.source,
        windowStart: Horizon.addDays(ref.date, -6),
        windowEnd: ref.date,
        updatedAt: summary.checkedAt || null,
        rowCounts: horizonCounts,
        pastExceeds: pastExceeds,
      } : (Horizon ? {
        version: Horizon.VERSION,
        referenceDate: null,
        referenceDateSource: 'missing',
        unavailable: true,
        reason: '基準日が不明のため、現在・過去・将来の判定は表示しません',
        updatedAt: summary.checkedAt || null,
      } : null),
      referenceDate: horizonOn ? ref.date : null,
      approachRule: '',
      approachNote: APPROACH_NOTE,
      warningHours: 60,
      limitHours: 60,
      sent: false,
      channel: 'dry-run',
      lastSuccess: null,
    };
  }

  return {
    FETCH_LABEL: FETCH_LABEL,
    APPROACH_NOTE: APPROACH_NOTE,
    fetchStatusOf: fetchStatusOf,
    build: build,
    hourMinuteText: hourMinuteText,
    gapText: gapText,
  };
});
