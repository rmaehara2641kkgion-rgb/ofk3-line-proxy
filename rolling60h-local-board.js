/**
 * OFK3 ローカル完結の60時間ボード（純粋関数）。
 * 判定は既存エンジンの出力（harvest-rolling60h-run の drivers / predictions）を読むだけで、再計算・変更しない。
 * 残り時間は duty-risk-dashboard の analyzePrediction（今日を終端とする7日窓）に合わせる。
 *   勤務可能上限       = 60 - 過去6日の合計        （過去6日が実績だけのときだけ確定値）
 *   予定終了後の余裕   = 60 - 対象7日の予測合計     （実績確定のときだけ確定値、予定込みは暫定）
 * 欠損は0にしない。数値を出せない項目は null。
 * Amazon の estimated_working_hour は推定であり、法的な労働時間の確定値ではない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Rolling60hLocalBoard = api;
})(this, function () {
  'use strict';

  var LIMIT = 60;
  var BOARD_KIND = 'ofk3-rolling60h-local-board';
  var SUMMARY_KIND = 'ofk3.rolling60h.friday-summary';
  var SCHEMA_VERSION = 1;
  var STALE_AFTER_HOURS = 12;

  var STATUS = {
    exceed: { code: 'exceed', label: '超過', rank: 0 },
    'partial-exceed': { code: 'partial', label: '部分欠損', detail: '確定した窓に超過あり', rank: 1 },
    approach: { code: 'approach', label: '接近', rank: 2 },
    'partial-approach': { code: 'partial', label: '部分欠損', detail: '確定した窓に接近あり', rank: 3 },
    partial: { code: 'partial', label: '部分欠損', detail: '一部の窓は判定不能', rank: 4 },
    undetermined: { code: 'undetermined', label: '判定不能', rank: 5 },
    clear: { code: 'clear', label: '正常', rank: 6 },
  };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function jstDate(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    return new Date(t + 9 * 3600000).toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    var p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || p.some(function (x) { return !isFinite(x); })) return '';
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.toISOString().slice(0, 10);
  }

  function adoptedLabel(day) {
    if (!day || !isNum(day.hours)) return '未取得';
    if (day.origin === 'daily-estimate' || day.origin === 'archived-daily') return '実績（Amazon推定）';
    if (day.origin === 'roster-plan') return '予定';
    return '未取得';
  }

  function statusOf(disposition) {
    return STATUS[disposition] || STATUS.undetermined;
  }

  /**
   * @param {Object} input
   *   executed: harvest-rolling60h-run.execute の戻り値 { summary, drivers, predictions }
   *   referenceDate: 'YYYY-MM-DD'（今日の7日窓の終端）
   *   generatedAt: ISO
   *   files: { shift: {name, range, ok}, daily: {name, range, ok} }
   *   names: { transportId: name }
   * @param {Object} deps  { analyze, dispositionOf }
   */
  function buildBoard(input, deps) {
    deps = deps || {};
    var analyze = deps.analyze;
    var dispositionOf = deps.dispositionOf;
    if (typeof analyze !== 'function' || typeof dispositionOf !== 'function') throw new Error('board-deps-missing');
    var executed = input.executed || {};
    var summary = executed.summary || {};
    var ref = input.referenceDate;
    var start = addDays(ref, -6);
    var names = input.names || {};
    var predByTid = {};
    (executed.predictions || []).forEach(function (p) {
      if (p && p.end === ref && p.start === start) predByTid[p.subjectId] = p;
    });
    var rows = (executed.drivers || []).map(function (driver) {
      var tid = driver.transportId;
      var status = statusOf(dispositionOf(driver));
      var pred = predByTid[tid] || null;
      var a = pred ? analyze(pred) : null;
      var pastOk = !!(a && isNum(a.pastActual));
      var pastActualOnly = pastOk && a.pastKind === '実績';
      var row = {
        transportId: tid,
        name: names[tid] || '',
        status: status.code,
        statusLabel: status.label,
        statusDetail: status.detail || '',
        rank: status.rank,
        windowStart: start,
        windowEnd: ref,
        windowJudgment: pred ? pred.level : null,
        past6: { hours: pastOk ? a.pastActual : null, kind: pastOk ? (pastActualOnly ? '実績' : '予定込み') : null },
        workable: {
          hours: pastOk ? a.workable : null,
          confirmed: pastActualOnly,
          note: pastActualOnly ? '' : (pastOk ? '予定を含む暫定値' : '過去6日に欠損があり算出不可'),
        },
        todayPlan: a && isNum(a.todayPlan) ? a.todayPlan : null,
        forecast: {
          hours: a && isNum(a.forecast) ? a.forecast : null,
          kind: a ? a.forecastKind : '',
        },
        marginAfterPlan: {
          hours: a && isNum(a.remaining) ? a.remaining : null,
          confirmed: !!(a && a.dataClass === '実績確定'),
          note: !a || !isNum(a.remaining) ? '7日合計を算出できない' : (a.dataClass === '実績確定' ? '' : '予定を含む暫定値'),
        },
        dataClass: a ? a.dataClass : '判定不能',
        gaps: a ? a.gaps : [{ date: '', reason: '今日を終端とする7日窓がない' }],
        days: pred ? (pred.days || []).map(function (d) {
          return { date: d.date || '', hours: isNum(d.hours) ? d.hours : null, adopted: adoptedLabel(d) };
        }) : [],
      };
      return row;
    });
    var counts = {
      driverCount: rows.length,
      exceed: 0, approach: 0, partial: 0, partialExceed: 0, partialApproach: 0, undetermined: 0, clear: 0,
    };
    rows.forEach(function (r) {
      if (r.status === 'partial') {
        counts.partial++;
        if (r.statusDetail.indexOf('超過') >= 0) counts.partialExceed++;
        else if (r.statusDetail.indexOf('接近') >= 0) counts.partialApproach++;
      } else {
        counts[r.status]++;
      }
    });
    var files = input.files || {};
    var inputs = {
      shift: !!(files.shift && files.shift.ok),
      daily: !!(files.daily && files.daily.ok),
    };
    var completeness = !inputs.shift || !inputs.daily ? 'incomplete-input'
      : (counts.partial + counts.undetermined > 0 ? 'partial' : 'complete');
    return {
      kind: BOARD_KIND,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: input.generatedAt,
      referenceDate: ref,
      windowStart: start,
      limitHours: LIMIT,
      files: files,
      inputs: inputs,
      completeness: completeness,
      counts: counts,
      hoursKind: 'estimated_working_hour',
      notice: 'Amazonの推定稼働時間とシフト予定による参考値です。法的な労働時間の確定値ではありません。',
      rows: rows,
    };
  }

  function validateBoard(board) {
    if (!board || board.kind !== BOARD_KIND || board.schemaVersion !== SCHEMA_VERSION) return false;
    if (!board.generatedAt || !isFinite(Date.parse(board.generatedAt))) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(board.referenceDate || '')) return false;
    if (!Array.isArray(board.rows) || !board.counts) return false;
    return board.rows.length === board.counts.driverCount;
  }

  function freshness(board, nowIso, options) {
    options = options || {};
    var hours = options.staleAfterHours != null ? options.staleAfterHours : STALE_AFTER_HOURS;
    if (!board || !board.generatedAt) return { status: 'unknown', reasons: ['no-data'], ageMinutes: null, staleAfterHours: hours };
    var age = (Date.parse(nowIso) - Date.parse(board.generatedAt)) / 60000;
    var reasons = [];
    if (!isFinite(age)) return { status: 'unknown', reasons: ['invalid-time'], ageMinutes: null, staleAfterHours: hours };
    if (age > hours * 60) reasons.push('age-over-limit');
    if (board.referenceDate !== jstDate(nowIso)) reasons.push('reference-date-not-today');
    return { status: reasons.length ? 'stale' : 'fresh', reasons: reasons, ageMinutes: Math.max(0, Math.round(age)), staleAfterHours: hours };
  }

  var SORTS = {
    risk: function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return marginCompare(a, b) || idCompare(a, b);
    },
    margin: function (a, b) { return marginCompare(a, b) || idCompare(a, b); },
    name: function (a, b) { return String(a.name || '￿').localeCompare(String(b.name || '￿'), 'ja') || idCompare(a, b); },
  };
  function marginCompare(a, b) {
    var x = a.marginAfterPlan.hours;
    var y = b.marginAfterPlan.hours;
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  }
  function idCompare(a, b) { return String(a.transportId).localeCompare(String(b.transportId)); }

  function sortRows(rows, mode) {
    var compare = SORTS[mode] || SORTS.risk;
    return (rows || []).slice().sort(compare);
  }

  function filterRows(rows, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return rows || [];
    return (rows || []).filter(function (r) {
      return ((r.name || '') + ' ' + (r.transportId || '')).toLowerCase().indexOf(q) >= 0;
    });
  }

  /**
   * FRIDAY向けの要約。氏名・Transport ID・個別の時間は含めない。
   * 人数は互いに排他: exceed / approach / partial / undetermined / clear の合計 = driverCount。
   * partial（部分欠損）は正常に含めない。FRIDAY側で警告対象にするかは接続側が決める。
   */
  function buildFridaySummary(board, nowIso) {
    var fresh = freshness(board, nowIso);
    var c = (board && board.counts) || {};
    return {
      kind: SUMMARY_KIND,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: board ? board.generatedAt : null,
      readAt: nowIso,
      referenceDate: board ? board.referenceDate : null,
      counts: {
        exceed: c.exceed == null ? null : c.exceed,
        approach: c.approach == null ? null : c.approach,
        undetermined: c.undetermined == null ? null : c.undetermined,
        partial: c.partial == null ? null : c.partial,
        partialExceed: c.partialExceed == null ? null : c.partialExceed,
        partialApproach: c.partialApproach == null ? null : c.partialApproach,
        clear: c.clear == null ? null : c.clear,
        driverCount: c.driverCount == null ? null : c.driverCount,
      },
      freshness: fresh,
      data: {
        completeness: board ? board.completeness : 'no-data',
        inputs: board ? board.inputs : { shift: false, daily: false },
        safeToAnnounceAsComplete: !!(board && board.completeness === 'complete' && fresh.status === 'fresh'),
      },
      hoursKind: 'estimated_working_hour',
      notice: '推定値・予定を含む参考値。法的な労働時間の確定値ではありません。',
      source: 'ofk3-local',
    };
  }

  return {
    LIMIT: LIMIT,
    BOARD_KIND: BOARD_KIND,
    SUMMARY_KIND: SUMMARY_KIND,
    SCHEMA_VERSION: SCHEMA_VERSION,
    STALE_AFTER_HOURS: STALE_AFTER_HOURS,
    buildBoard: buildBoard,
    validateBoard: validateBoard,
    freshness: freshness,
    sortRows: sortRows,
    filterRows: filterRows,
    buildFridaySummary: buildFridaySummary,
    jstDate: jstDate,
  };
});
