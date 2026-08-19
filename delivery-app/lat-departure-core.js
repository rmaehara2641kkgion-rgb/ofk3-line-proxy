/**
 * OFK3 LAT — 出発判定・差分表示（UI非依存）
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

  var LatDepartureCore = {
    latTimeToMin: latTimeToMin,
    latMinDiff: latMinDiff,
    latParseDiffMins: latParseDiffMins,
    latResolveDiffMin: latResolveDiffMin,
    latResolveJudgment: latResolveJudgment,
    latFormatDepDiffText: latFormatDepDiffText,
    latRoundDiffMin: latRoundDiffMin,
    latAxisLabelStep: latAxisLabelStep,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LatDepartureCore;
  }
  global.LatDepartureCore = LatDepartureCore;
})(typeof window !== 'undefined' ? window : global);
