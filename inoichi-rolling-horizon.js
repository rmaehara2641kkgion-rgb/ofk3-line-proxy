/**
 * INO-1 表示用の期間分離（過去・現在・将来）。
 * 計算エンジン（rolling60h-core.js）の7日窓の結果だけを読み、再計算も書き換えもしない。
 * 現在 = 基準日を終端とする7日間。過去 = それより前に終わる窓。将来 = 基準日より後に終わる窓。
 * 境界は「合計 > 60 が超過、合計 = 60 ちょうどは注意（超過ではない）」。
 * 有効なシフト範囲内の空白（未確定の空白だけが理由の窓）は、休み00:00として読み直す。
 * 時間不明・シフトデータなしは要確認のまま。確定済みの時間だけで超過している窓は正常にしない。
 * 49時間のルールは持たない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.InoichiRollingHorizon = api;
})(this, function () {
  'use strict';

  var LIMIT = 60;
  var VERSION = 'ino1-horizon-1';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function addDays(iso, n) {
    var p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || p.some(function (x) { return !isFinite(x); })) return '';
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  function jstDate(iso) {
    var t = Date.parse(iso || '');
    return isFinite(t) ? new Date(t + 9 * 3600000).toISOString().slice(0, 10) : '';
  }

  function periodOf(window, ref) {
    if (window.endDate < ref) return 'past';
    if (window.endDate > ref) return 'future';
    return 'current';
  }

  // 未確定の空白だけが判定不能の理由の窓（時間不明・データなしを含まない）
  function isBlankOnly(window) {
    if (!window || !window.hasUnconfirmed || window.hasUndefinedHours || window.complete === false) return false;
    return !(window.noDataDates && window.noDataDates.length) && !(window.undefinedDates && window.undefinedDates.length);
  }

  /** @return {{status:'exceed'|'approach'|'within'|'undetermined', total:number|null, overBy:number, known:boolean}} */
  function judgeWindow(window) {
    var total = window && isNum(window.totalHours) ? window.totalHours : null;
    if (!window) return { status: 'undetermined', total: null, overBy: 0, known: false };
    if (window.judgment === 'exceed' || window.judgment === 'approach' || window.judgment === 'within') {
      return { status: window.judgment, total: total, overBy: window.judgment === 'exceed' ? total - LIMIT : 0, known: false };
    }
    if (isBlankOnly(window) && total != null) {
      if (total > LIMIT) return { status: 'exceed', total: total, overBy: total - LIMIT, known: false };
      if (total === LIMIT) return { status: 'approach', total: total, overBy: 0, known: false };
      return { status: 'within', total: total, overBy: 0, known: false };
    }
    if (window.knownOver && total != null) {
      return { status: 'exceed', total: total, overBy: isNum(window.knownOverBy) && window.knownOverBy > 0 ? window.knownOverBy : total - LIMIT, known: true };
    }
    return { status: 'undetermined', total: total, overBy: 0, known: false };
  }

  function actualOrigin(origin) { return origin === 'daily-estimate' || origin === 'archived-daily'; }

  // 過去6日の確定分が実績だけで60時間を超えているか（空白は休み0時間の予定として数える）
  function pastSixActual(prediction) {
    var days = prediction && Array.isArray(prediction.days) ? prediction.days.slice(0, 6) : [];
    if (days.length !== 6) return { over: false, missing: 0 };
    var numeric = [];
    days.forEach(function (day) {
      if (!day) return;
      if (day.origin === 'roster-unconfirmed') numeric.push({ hours: 0, origin: 'roster-plan' });
      else if (isNum(day.hours)) numeric.push(day);
    });
    if (!numeric.length) return { over: false, missing: 0 };
    var sum = 0;
    numeric.forEach(function (day) { sum += day.hours; });
    return { over: sum > LIMIT && numeric.every(function (day) { return actualOrigin(day.origin); }), missing: 6 - numeric.length };
  }

  function allActual(prediction) {
    var days = prediction && Array.isArray(prediction.days) ? prediction.days : [];
    return days.length === 7 && days.every(function (day) { return day && isNum(day.hours) && actualOrigin(day.origin); });
  }

  function summaryOf(window, judged) {
    return {
      startDate: window.startDate, endDate: window.endDate, totalHours: judged.total, overBy: judged.overBy, known: judged.known,
      actualHours: isNum(window.actualHours) ? window.actualHours : null,
      rosterHours: isNum(window.rosterHours) ? window.rosterHours : null,
    };
  }

  /**
   * @param {Object} driver  { transportId, windows[] }（エンジン出力）
   * @param {string} ref     基準日 YYYY-MM-DD
   * @param {Function} predictionOf  (start, end) => prediction | null
   */
  function horizonOf(driver, ref, predictionOf) {
    var windows = (driver && driver.windows || []).filter(Boolean);
    var current = null;
    var past = [];
    var futures = [];
    windows.forEach(function (window) {
      var period = periodOf(window, ref);
      var judged = judgeWindow(window);
      if (period === 'current') current = { window: window, judged: judged };
      else if (judged.status === 'exceed') (period === 'past' ? past : futures).push(summaryOf(window, judged));
    });
    futures.sort(function (a, b) {
      if (b.overBy !== a.overBy) return b.overBy - a.overBy;
      return a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0;
    });
    past.sort(function (a, b) { return a.endDate < b.endDate ? 1 : a.endDate > b.endDate ? -1 : 0; });

    var code = 'review';
    var provisional = true;
    var prediction = null;
    if (current) {
      prediction = predictionOf ? predictionOf(current.window.startDate, current.window.endDate) : null;
      provisional = !allActual(prediction);
      if (current.judged.status === 'exceed') {
        var six = pastSixActual(prediction);
        code = six.over ? 'actual-exceed' : 'forecast-exceed';
        // OFK3 list: only a gap-bridged (known-hours) result is provisional; a full 7-day forecast is shown as is.
        provisional = six.over ? six.missing > 0 : current.judged.known;
      } else if (current.judged.status === 'approach') code = 'caution';
      else if (current.judged.status === 'within') code = 'ok';
    }
    return {
      version: VERSION,
      referenceDate: ref,
      windowStart: addDays(ref, -6),
      windowEnd: ref,
      current: current ? { window: current.window, judged: current.judged, prediction: prediction } : null,
      code: code,
      provisional: provisional,
      future: futures.length ? { top: futures[0], count: futures.length } : null,
      past: past,
    };
  }

  var LABEL = {
    'actual-exceed': '実績超過',
    'forecast-exceed': '超過予測',
    caution: '注意',
    ok: '正常',
    review: '要確認',
  };

  function clockText(hours) {
    if (!isNum(hours)) return '要確認';
    var minutes = Math.round(Math.abs(hours) * 60);
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return (hours < 0 ? '-' : '') + (h < 10 ? '0' + h : String(h)) + ':' + (m < 10 ? '0' + m : String(m));
  }

  return {
    VERSION: VERSION, LIMIT: LIMIT, LABEL: LABEL,
    addDays: addDays, jstDate: jstDate, periodOf: periodOf, judgeWindow: judgeWindow,
    horizonOf: horizonOf, clockText: clockText,
  };
});
