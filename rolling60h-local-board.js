/**
 * OFK3 ローカル完結の60時間ボード（純粋関数）。
 * 判定は既存エンジンの出力（harvest-rolling60h-run の drivers / predictions）を読むだけで、再計算・変更しない。
 * 残り時間は duty-risk-dashboard の analyzePrediction（今日を終端とする7日窓）に合わせる。
 *   勤務可能上限       = 60 - 過去6日の合計        （過去6日が実績だけのときだけ確定値）
 *   予定終了後の余裕   = 60 - 対象7日の予測合計     （実績確定のときだけ確定値、予定込みは暫定）
 * 空白セルと「休」は確定した休み（0時間）であり、一覧の欠損ではない。
 * 勤務記号があるのに時間が取れない日、シフトデータがない日、期間外、DAを特定できない場合は従来どおり欠損。
 * 実績がある日は実績を優先する。ローリング計算とエンジンの人数区分は変えない。
 * 時間不明の日があっても、既存エンジンが確定分だけで上限超過（knownOver）と出しているときは、
 * その合計を超過予測として残す。時間不明の日は0時間にしない。
 * 一覧の超過予測は、基準日を終端とする7日間だけを見る。別期間の超過は根拠として残し、将来分は補助表示にする。
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
    if (day && day.rest === 'blank') return '休み';
    if (day && day.origin === 'roster-unconfirmed') return 'シフト未入力';
    if (!day || !isNum(day.hours)) return '未取得';
    if (day.origin === 'daily-estimate' || day.origin === 'archived-daily') return '実績（Amazon推定）';
    if (day.origin === 'roster-plan') return '予定';
    return '未取得';
  }

  function isActualOrigin(origin) {
    return origin === 'daily-estimate' || origin === 'archived-daily';
  }

  function knownSum(days) {
    var sum = 0;
    var missing = 0;
    (days || []).forEach(function (day) {
      if (day && isNum(day.hours)) sum += day.hours;
      else missing += 1;
    });
    return { sum: sum, missing: missing, count: (days || []).length };
  }

  function pastIsActual(days) {
    var numeric = (days || []).filter(function (day) { return day && isNum(day.hours); });
    return numeric.length > 0 && numeric.every(function (day) { return isActualOrigin(day.origin); });
  }

  // 既存エンジンの knownOver / predictedTotal を、欠損で捨てずに一覧へ載せる。
  // 未確定日は加算しない（0時間にもしない）。
  function revealKnown(row, pred) {
    if (!pred || !Array.isArray(pred.days)) return;
    var byDate = {};
    pred.days.forEach(function (day) { if (day && day.date) byDate[day.date] = day; });
    row.gaps = (row.gaps || []).map(function (gap) {
      var day = byDate[gap.date];
      if (day && day.origin === 'roster-unconfirmed') {
        return { date: gap.date, reason: 'シフト未入力。0時間にはしていません' };
      }
      return gap;
    });
    var pastDays = pred.days.slice(0, 6);
    var past = knownSum(pastDays);
    var today = pred.days.length > 6 ? pred.days[6] : null;
    var engineTotal = isNum(pred.predictedTotal) ? pred.predictedTotal : null;
    var pastAlreadyOver = past.count === 6 && past.missing < past.count && past.sum > LIMIT && pastIsActual(pastDays);
    if (!pred.knownOver && !pastAlreadyOver) return;
    if (row.past6.hours == null && past.count === 6 && past.missing < past.count) {
      row.past6.hours = past.sum;
      row.past6.kind = pastIsActual(pastDays) ? '実績' : '確定分';
      row.past6.provisional = past.missing > 0;
      row.past6.note = past.missing ? '未確定の日は含みません。0時間にはしていません。' : '';
    }
    if (row.workable.hours == null && isNum(row.past6.hours)) {
      row.workable.hours = LIMIT - row.past6.hours;
      row.workable.confirmed = false;
      row.workable.note = past.missing
        ? '未確定の日を除いた残りです。実際の残りはこれ以下です。'
        : '予定を含む暫定値';
    }
    if (row.todayPlan == null && today && isNum(today.hours) && today.origin === 'roster-plan') {
      row.todayPlan = today.hours;
    }
    if (row.forecast.hours == null && engineTotal != null) {
      row.forecast.hours = engineTotal;
      row.forecast.kind = '予測';
      row.forecast.provisional = true;
      row.forecast.note = '未確定の日は加算していません。確定している時間だけで上限を超えています。';
    }
    if (row.marginAfterPlan.hours == null && isNum(row.forecast.hours)) {
      row.marginAfterPlan.hours = LIMIT - row.forecast.hours;
      row.marginAfterPlan.confirmed = false;
      row.marginAfterPlan.note = '暫定。未確定日を0時間にはしていません。';
    }
  }

  // 一覧表示だけ。空白セル（roster-unconfirmed）を確定した休み0時間として読む。エンジンの予測は書き換えない。
  function withConfirmedRest(pred) {
    if (!pred || !Array.isArray(pred.days)) return pred;
    var days = pred.days.map(function (day) {
      if (!day || day.origin !== 'roster-unconfirmed') return day;
      return { date: day.date, hours: 0, origin: 'roster-plan', future: !!day.future, rest: 'blank' };
    });
    return {
      subjectId: pred.subjectId,
      start: pred.start,
      end: pred.end,
      predictedTotal: pred.predictedTotal,
      level: pred.level,
      knownOver: pred.knownOver,
      knownOverBy: pred.knownOverBy,
      days: days,
    };
  }

  function isRestWindow(window) {
    if (!window || !window.hasUnconfirmed || window.hasUndefinedHours) return false;
    if (window.complete === false) return false;
    if (window.noDataDates && window.noDataDates.length) return false;
    if (window.undefinedDates && window.undefinedDates.length) return false;
    return true;
  }

  function clockText(hours) {
    if (!isNum(hours)) return '要確認';
    var sign = hours < 0 ? -1 : 1;
    var total = Math.round(Math.abs(hours) * 60);
    var hour = Math.floor(total / 60);
    var minute = total % 60;
    var hourText = hour < 10 ? '0' + hour : String(hour);
    var minuteText = minute < 10 ? '0' + minute : String(minute);
    return (sign < 0 ? '-' : '') + hourText + ':' + minuteText;
  }

  function displayName(row) {
    var name = row && row.name ? String(row.name).trim() : '';
    if (name) return name;
    var id = row && row.transportId ? String(row.transportId) : '';
    return id ? '未照合DA（' + id + '）' : '未照合DA';
  }

  function judgmentText(row) {
    var label = ((row && row.judgmentLabel) || '要確認') + (row && row.judgmentProvisional ? '・暫定' : '');
    var future = row && row.futureExceed;
    if (future && isNum(future.overBy) && future.overBy > 0) {
      label += ' / 将来超過あり +' + clockText(future.overBy);
    }
    return label;
  }

  function evidenceGaps(window) {
    if (isRestWindow(window)) return [];
    var gaps = [];
    (window.undefinedDates || []).forEach(function (date) {
      gaps.push({ date: date, reason: '勤務記号があるが時間不明' });
    });
    (window.noDataDates || []).forEach(function (date) {
      gaps.push({ date: date, reason: 'シフトデータがない' });
    });
    (window.unconfirmedDates || []).forEach(function (date) {
      gaps.push({ date: date, reason: 'シフト未入力' });
    });
    return gaps;
  }

  function collectEvidence(driver, preds, ref) {
    var byKey = {};
    (preds || []).forEach(function (pred) {
      if (pred && pred.start && pred.end) byKey[pred.start + '|' + pred.end] = pred;
    });
    var list = [];
    ((driver && driver.windows) || []).forEach(function (window) {
      if (!window || !window.startDate || !window.endDate) return;
      var period = window.endDate < ref ? 'past' : window.endDate > ref ? 'future' : 'current';
      var exceeds = window.judgment === 'exceed' || !!window.knownOver;
      if (period !== 'current' && !exceeds) return;
      var shown = withConfirmedRest(byKey[window.startDate + '|' + window.endDate] || null);
      var days = shown && shown.days ? shown.days.map(function (day) {
        return {
          date: day.date || '',
          hours: isNum(day.hours) ? day.hours : null,
          adopted: adoptedLabel(day),
          origin: day && day.origin ? day.origin : '',
        };
      }) : [];
      var confirmedActual = days.length === 7 && days.every(function (day) {
        return day.origin === 'daily-estimate' || day.origin === 'archived-daily';
      });
      var overBy = 0;
      if (window.judgment === 'exceed' && isNum(window.totalHours)) overBy = window.totalHours - LIMIT;
      else if (window.knownOver && isNum(window.knownOverBy)) overBy = window.knownOverBy;
      list.push({
        period: period,
        periodLabel: period === 'past' ? '過去' : period === 'future' ? '未来' : '現在',
        start: window.startDate,
        end: window.endDate,
        totalHours: isNum(window.totalHours) ? window.totalHours : null,
        overBy: overBy,
        exceeds: exceeds,
        knownOver: !!window.knownOver,
        confirmedActual: confirmedActual,
        provisional: !confirmedActual,
        days: days,
        gaps: evidenceGaps(window),
      });
    });
    var order = { current: 0, future: 1, past: 2 };
    list.sort(function (a, b) {
      if (order[a.period] !== order[b.period]) return order[a.period] - order[b.period];
      return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
    });
    return list;
  }

  function pickFuture(evidence) {
    var futures = (evidence || []).filter(function (item) {
      return item.period === 'future' && item.exceeds && isNum(item.overBy) && item.overBy > 0;
    });
    if (!futures.length) return null;
    futures.sort(function (a, b) {
      if (b.overBy !== a.overBy) return b.overBy - a.overBy;
      return a.end < b.end ? -1 : a.end > b.end ? 1 : 0;
    });
    var top = futures[0];
    return {
      start: top.start,
      end: top.end,
      totalHours: top.totalHours,
      overBy: top.overBy,
      count: futures.length,
    };
  }

  function indexActualDays(list) {
    var byTid = {};
    (list || []).forEach(function (day) {
      if (!day || !day.transportId || !day.date || !isNum(day.hours)) return;
      if (!byTid[day.transportId]) byTid[day.transportId] = {};
      byTid[day.transportId][day.date] = (byTid[day.transportId][day.date] || 0) + day.hours;
    });
    var out = {};
    Object.keys(byTid).forEach(function (tid) {
      out[tid] = Object.keys(byTid[tid]).sort().map(function (date) {
        return { date: date, hours: byTid[tid][date] };
      });
    });
    return out;
  }

  // 今日の7日間だけを判定する。別期間の exceed はバッジを超過予測にしない。
  function judge(row) {
    var pastHours = row.past6.hours;
    var forecastHours = row.forecast.hours;
    var pastOver = isNum(pastHours) && pastHours > LIMIT && row.past6.kind === '実績';
    var forecastOver = isNum(forecastHours) && forecastHours > LIMIT;
    var todayKnownOver = row.knownOver === true;
    if (pastOver) {
      return { code: 'actual-exceed', label: '実績超過', provisional: row.past6.provisional === true, rank: 0 };
    }
    if (forecastOver || todayKnownOver) {
      return {
        code: 'forecast-exceed',
        label: '超過予測',
        provisional: row.forecast.provisional === true || todayKnownOver && row.dataClass === '判定不能',
        rank: 1,
      };
    }
    if (row.dataClass !== '判定不能' && isNum(forecastHours) && forecastHours === LIMIT) {
      return { code: 'caution', label: '注意', provisional: row.dataClass === '予定込み予測', rank: 2 };
    }
    if (row.dataClass !== '判定不能' && isNum(forecastHours) && forecastHours < LIMIT) {
      return { code: 'ok', label: '正常', provisional: row.dataClass !== '実績確定', rank: 4 };
    }
    return { code: 'review', label: '要確認', provisional: true, rank: 3 };
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
    var allPreds = {};
    (executed.predictions || []).forEach(function (p) {
      if (!p || !p.subjectId) return;
      if (p.end === ref && p.start === start) predByTid[p.subjectId] = p;
      if (!allPreds[p.subjectId]) allPreds[p.subjectId] = [];
      allPreds[p.subjectId].push(p);
    });
    var actualByTid = indexActualDays(input.actualDays);
    var rows = (executed.drivers || []).map(function (driver) {
      var tid = driver.transportId;
      var status = statusOf(dispositionOf(driver));
      var pred = predByTid[tid] || null;
      var listPred = withConfirmedRest(pred);
      var a = listPred ? analyze(listPred) : null;
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
          note: pastActualOnly ? '' : (pastOk ? '予定を含む暫定値' : '過去6日に欠損があり、残り許容は確定できません'),
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
        days: listPred ? (listPred.days || []).map(function (d) {
          return { date: d.date || '', hours: isNum(d.hours) ? d.hours : null, adopted: adoptedLabel(d), origin: d && d.origin ? d.origin : '' };
        }) : [],
        knownOver: !!(pred && pred.knownOver),
      };
      revealKnown(row, pred);
      row.evidence = collectEvidence(driver, allPreds[tid] || [], ref);
      row.futureExceed = pickFuture(row.evidence);
      row.recordedActuals = actualByTid[tid] || [];
      row.unmatchedReason = names[tid] ? '' : 'シフト表とDAマスタにこの Transport ID の氏名がありません';
      var judgment = judge(row);
      row.judgment = judgment.code;
      row.judgmentLabel = judgment.label;
      row.judgmentProvisional = judgment.provisional;
      row.judgmentRank = row.futureExceed && judgment.rank > 1 ? 1.5 : judgment.rank;
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
      var ar = a.judgmentRank != null ? a.judgmentRank : a.rank;
      var br = b.judgmentRank != null ? b.judgmentRank : b.rank;
      if (ar !== br) return ar - br;
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
      return ((r.name || '') + ' ' + displayName(r) + ' ' + (r.transportId || '')).toLowerCase().indexOf(q) >= 0;
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
    var hasBoard = !!board;
    // hasGap: 判定できない・欠けている人や入力がある。データなしのときは null（「欠損なし」とは言えない）。
    var hasGap = hasBoard ? (board.completeness !== 'complete') : null;
    return {
      kind: SUMMARY_KIND,
      schemaVersion: SCHEMA_VERSION,
      // ready: 要約を利用できる（保存済みの集計がある）という意味だけ。全員の勤務時間が確定した意味ではない。
      ready: hasBoard,
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
        hasGap: hasGap,
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
    displayName: displayName,
    judgmentText: judgmentText,
    clockText: clockText,
    validateBoard: validateBoard,
    freshness: freshness,
    sortRows: sortRows,
    filterRows: filterRows,
    buildFridaySummary: buildFridaySummary,
    jstDate: jstDate,
  };
});
