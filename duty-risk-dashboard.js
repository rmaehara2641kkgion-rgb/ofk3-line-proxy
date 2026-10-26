/**
 * 管理者用の勤務時間リスク表示。
 * 正式な60時間判定と接近判定は読まない。欠損は0にしない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DutyRiskDashboard = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var LIMIT = 60;

  function isNum(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function addUtcDays(iso, days) {
    var parts = String(iso || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(function (part) { return !isFinite(part); })) return '';
    var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    date.setUTCDate(date.getUTCDate() + days);
    var month = date.getUTCMonth() + 1;
    var day = date.getUTCDate();
    return date.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
  }

  function formatApi() {
    if (typeof window !== 'undefined' && window.DutyHoursFormat) return window.DutyHoursFormat;
    return require('./duty-hours-format.js');
  }

  function hourText(value) {
    if (!isNum(value)) return '未取得';
    return formatApi().durationText(value);
  }

  function marginText(value) {
    if (!isNum(value)) return '—';
    if (value < 0) return formatApi().overText(value, 'forecast');
    return formatApi().remainingText(value);
  }

  function valueState(row) {
    if (!row || row.dataClass === '判定不能') return '判定不能';
    if (row.dataClass === '予定込み予測') return '暫定（予定を含む）';
    if (row.dataClass === '実績確定') return '推定（確定値ではない）';
    return '';
  }

  function statusOf(row) {
    if (!row || row.dataClass === '判定不能' || row.seriesComplete === false) {
      var reasons = (row && row.gaps || []).map(function (gap) {
        return (gap.date || '日付不明') + ' ' + gap.reason;
      }).join('、');
      return {
        tone: 'unknown',
        label: '判定不能',
        text: '合計できない',
        hint: (reasons || '当日窓が保存されていない') + '。欠損は0時間にしていません。',
        bar: 0,
      };
    }
    var past = row.pastActual;
    if (row.pastKind === '実績' && isNum(past) && past > 60) {
      return {
        tone: 'actual',
        label: '実績超過',
        text: formatApi().overText(past - 60, 'actual'),
        hint: '過去6日の実績がすでに60時間を超えています。今日の予定を足す前の状態です。',
        bar: 100,
      };
    }
    if (row.forecastOver) {
      var overBy = isNum(row.forecast) ? row.forecast - 60 : null;
      var hint = '今日の予定を含めた予測です。実績超過ではありません。';
      if (isNum(past) && past <= 60) hint = '過去6日の実績は60時間以下です。' + hint;
      else if (row.pastKind === '予定込み') hint = '過去6日に予定が含まれます。確定した実績超過ではありません。' + hint;
      return {
        tone: 'forecast',
        label: '超過見込み',
        text: overBy == null ? '超過見込み' : formatApi().overText(overBy, 'forecast'),
        hint: hint,
        bar: 100,
      };
    }
    if (row.dataClass === '実績確定' && isNum(row.forecast) && row.forecast > 60) {
      return {
        tone: 'actual',
        label: '実績超過',
        text: formatApi().overText(row.forecast - 60, 'actual'),
        hint: '7日間が推定実績で、合計が60時間を超えています。今日の予定を足した予測ではありません。',
        bar: 100,
      };
    }
    var margin = row.marginAfterPlan != null ? row.marginAfterPlan : row.remaining;
    if (!isNum(margin)) {
      return { tone: 'unknown', label: '判定不能', text: '未取得', hint: '合計できないため残量を出していません。', bar: 0 };
    }
    var bar = Math.max(0, Math.min(100, (margin / 60) * 100));
    if (row.adminLabel === '本日要注意') {
      return { tone: 'urgent', label: '本日要注意', text: formatApi().remainingText(margin), hint: '勤務予定があり、終了後の余裕が1時間未満です。', bar: bar };
    }
    if (row.adminLabel === '本日監視') {
      return { tone: 'watch', label: '本日監視', text: formatApi().remainingText(margin), hint: '終了後の余裕が1時間以上、5時間未満です。', bar: bar };
    }
    var calm = '既存の要注意・監視（1時間未満、5時間未満）には入りません。';
    if (margin === 0) calm = '残りは0時間です。既存判定では、60時間ちょうどは超過ではありません。';
    return { tone: 'ok', label: '余裕あり', text: formatApi().remainingText(margin), hint: calm, bar: bar };
  }

  var TONE_COLOR = {
    actual: '#9f1239',
    forecast: '#c2410c',
    urgent: '#b91c1c',
    watch: '#b45309',
    ok: '#15803d',
    unknown: '#64748b',
  };

  function forecastText(row) {
    if (!row || !isNum(row.forecast)) return '未取得';
    var text = hourText(row.forecast) + (row.forecastKind ? ' ' + row.forecastKind : '');
    if (row.pastKind === '実績' && isNum(row.pastActual) && row.pastActual > 60) text += ' 実績超過';
    else if (row.dataClass === '予定込み予測' && row.forecast >= LIMIT) text += ' 超過見込み';
    return text;
  }

  function actualOrigin(origin) {
    return origin === 'daily-estimate' || origin === 'archived-daily';
  }

  function pickRun(history, checkedAt) {
    var runs = history && Array.isArray(history.runs) ? history.runs : [];
    for (var i = 0; i < runs.length; i++) {
      if (runs[i] && runs[i].predictedAt === checkedAt) return runs[i];
    }
    return null;
  }

  function gapReason(day) {
    if (!day || day.origin === 'missing' || !day.origin) return '実績未取得';
    if (day.origin === 'undefined' || !isNum(day.hours)) return '時間未定義';
    if (day.origin === 'roster-plan') return '実績がなく予定のみ';
    return '実績未取得';
  }

  function dayKind(day) {
    if (!day || !isNum(day.hours) || day.origin === 'missing' || day.origin === 'undefined') return 'void';
    if (actualOrigin(day.origin)) return 'actual';
    if (day.origin === 'roster-plan') return 'plan';
    return 'void';
  }

  function analyzePrediction(prediction) {
    var days = prediction && Array.isArray(prediction.days) ? prediction.days : [];
    var kinds = days.map(dayKind);
    var gaps = [];
    days.forEach(function (day, index) {
      if (kinds[index] !== 'void') return;
      gaps.push({ date: day && day.date ? day.date : '', reason: gapReason(day) });
    });
    if (days.length < 7) gaps.push({ date: '', reason: '当日窓が保存されていない' });
    var past = days.slice(0, 6);
    var pastKinds = kinds.slice(0, 6);
    var pastNumeric = past.length === 6 && pastKinds.every(function (kind) { return kind === 'actual' || kind === 'plan'; });
    var pastActualOnly = pastNumeric && pastKinds.every(function (kind) { return kind === 'actual'; });
    var pastHours = null;
    if (pastNumeric) {
      pastHours = 0;
      past.forEach(function (day) { pastHours += day.hours; });
    }
    var today = days.length > 6 ? days[6] : null;
    var todayKind = kinds.length > 6 ? kinds[6] : 'void';
    var todayPlan = todayKind === 'plan' ? today.hours : null;
    var seriesNumeric = pastNumeric && (todayKind === 'actual' || todayKind === 'plan');
    var dataClass = '判定不能';
    if (seriesNumeric) dataClass = (pastActualOnly && todayKind === 'actual') ? '実績確定' : '予定込み予測';
    var forecast = null;
    if (seriesNumeric) {
      forecast = pastHours + today.hours;
    }
    var forecastKind = dataClass === '実績確定' ? '実績' : (dataClass === '予定込み予測' ? '予測' : '');
    var workable = pastHours == null ? null : LIMIT - pastHours;
    var marginAfterPlan = todayKind === 'plan' && forecast != null ? LIMIT - forecast : null;
    var remaining = forecast == null ? null : LIMIT - forecast;
    var hasDuty = todayPlan != null && todayPlan > 0;
    var adminLabel = '';
    if (hasDuty && marginAfterPlan != null) {
      if (marginAfterPlan < 1) adminLabel = '本日要注意';
      else if (marginAfterPlan >= 1 && marginAfterPlan < 5) adminLabel = '本日監視';
    }
    return {
      transportId: prediction && prediction.subjectId ? prediction.subjectId : '',
      pastActual: pastHours,
      pastKind: pastActualOnly ? '実績' : (pastNumeric ? '予定込み' : ''),
      todayPlan: todayPlan,
      forecast: forecast,
      forecastKind: forecastKind,
      dataClass: dataClass,
      remaining: remaining,
      workable: workable,
      marginAfterPlan: marginAfterPlan,
      hasDuty: hasDuty,
      adminLabel: adminLabel,
      forecastOver: dataClass === '予定込み予測' && forecast != null && forecast >= LIMIT,
      gaps: gaps,
      seriesComplete: dataClass !== '判定不能',
      savedLevel: prediction && prediction.level ? prediction.level : '',
      savedTotal: prediction && isNum(prediction.predictedTotal) ? prediction.predictedTotal : null,
      days: days,
    };
  }

  function predictionKey(start, end, total) {
    if (!isNum(total)) return '';
    return start + '|' + end + '|' + total.toFixed(4);
  }

  function indexByWindow(predictions) {
    var map = {};
    (predictions || []).forEach(function (item) {
      var key = predictionKey(item && item.start, item && item.end, item && item.predictedTotal);
      if (!key || !item.subjectId) return;
      if (!map[key]) map[key] = [];
      if (map[key].indexOf(item.subjectId) < 0) map[key].push(item.subjectId);
    });
    return map;
  }

  function namesBySubject(predictions, alerts) {
    var index = indexByWindow(predictions);
    var names = {};
    (alerts || []).forEach(function (alert) {
      if (!alert || !alert.name) return;
      var ids = index[predictionKey(alert.startDate, alert.endDate, alert.totalHours)] || [];
      if (ids.length !== 1) return;
      if (!names[ids[0]]) names[ids[0]] = alert.name;
      else if (names[ids[0]] !== alert.name) names[ids[0]] = '';
    });
    return names;
  }

  function attachNames(rows, alerts) {
    var groups = {};
    rows.forEach(function (row) {
      if (!isNum(row.pastActual) || !isNum(row.forecast)) return;
      var key = row.pastActual.toFixed(4) + '|' + row.forecast.toFixed(4);
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    });
    (alerts || []).forEach(function (alert) {
      if (!alert || !isNum(alert.preTodayHours) || !isNum(alert.todayWindowHours) || !alert.name) return;
      var key = alert.preTodayHours.toFixed(4) + '|' + alert.todayWindowHours.toFixed(4);
      var hits = groups[key] || [];
      if (hits.length !== 1) return;
      if (!hits[0].name) hits[0].name = alert.name;
      else if (hits[0].name !== alert.name) hits[0].name = '';
    });
  }

  function attachSavedTotalNames(rows, alerts) {
    var groups = {};
    (rows || []).forEach(function (row) {
      if (!row || !isNum(row.savedTotal)) return;
      var key = row.savedTotal.toFixed(4);
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    });
    Object.keys(groups).forEach(function (key) {
      var hits = groups[key];
      if (hits.length !== 1 || hits[0].name) return;
      var names = [];
      (alerts || []).forEach(function (alert) {
        if (!alert || !alert.name || !isNum(alert.todayWindowHours)) return;
        if (alert.todayWindowHours.toFixed(4) !== key) return;
        if (names.indexOf(alert.name) < 0) names.push(alert.name);
      });
      if (names.length === 1) hits[0].name = names[0];
    });
  }

  function futureRows(snapshot, referenceDate, predictions) {
    var index = indexByWindow(predictions);
    return (snapshot && Array.isArray(snapshot.alerts) ? snapshot.alerts : []).filter(function (alert) {
      return alert && alert.disposition === 'exceed' && alert.basis === 'forecast' && alert.endDate > referenceDate;
    }).map(function (alert) {
      var ids = index[predictionKey(alert.startDate, alert.endDate, alert.totalHours)] || [];
      return {
        name: alert.name || '',
        transportId: ids.length === 1 ? ids[0] : '',
        transportNote: ids.length === 1 ? '' : '保存データ上、Transport IDを一意に結び付けられない',
        windowLabel: alert.windowLabel || ((alert.startDate || '') + ' 〜 ' + (alert.endDate || '')),
        startDate: alert.startDate || '',
        endDate: alert.endDate || '',
        totalHours: isNum(alert.totalHours) ? alert.totalHours : null,
        overBy: isNum(alert.overBy) ? alert.overBy : null,
        actualHours: isNum(alert.actualHours) ? alert.actualHours : null,
        rosterHours: isNum(alert.rosterHours) ? alert.rosterHours : null,
      };
    });
  }

  function buildView(snapshot, history) {
    var checkedAt = snapshot && snapshot.checkedAt ? snapshot.checkedAt : '';
    var run = pickRun(history, checkedAt);
    if (!run || !/^\d{4}-\d{2}-\d{2}$/.test(run.referenceDate || '')) {
      return { ok: false, reason: '保存履歴とスナップショットの取得日時が一致しません' };
    }
    var referenceDate = run.referenceDate;
    var byId = {};
    (run.predictions || []).forEach(function (item) {
      if (!item || !item.subjectId) return;
      if (item.end === referenceDate && item.start === addUtcDays(referenceDate, -6)) byId[item.subjectId] = item;
    });
    var rows = Object.keys(byId).map(function (id) { return analyzePrediction(byId[id]); });
    var named = namesBySubject(run.predictions, snapshot && snapshot.alerts);
    rows.forEach(function (row) {
      if (named[row.transportId]) row.name = named[row.transportId];
    });
    attachNames(rows, snapshot && snapshot.alerts);
    attachSavedTotalNames(rows, snapshot && snapshot.alerts);
    rows.forEach(function (row) { if (!row.name) row.name = ''; });
    var ranking = rows.filter(function (row) { return row.seriesComplete; }).sort(function (a, b) {
      if (a.remaining !== b.remaining) return a.remaining - b.remaining;
      return String(a.transportId).localeCompare(String(b.transportId));
    });
    var gaps = rows.filter(function (row) { return !row.seriesComplete; }).sort(function (a, b) {
      return String(a.transportId).localeCompare(String(b.transportId));
    });
    var basis = snapshot && snapshot.basisCounts ? snapshot.basisCounts : {};
    var attention = ranking.filter(function (row) {
      return row.adminLabel === '本日要注意' || row.adminLabel === '本日監視';
    });
    return {
      ok: true,
      referenceDate: referenceDate,
      windowStart: addUtcDays(referenceDate, -6),
      checkedAt: checkedAt,
      confirmed: isNum(basis.actualExceed) ? basis.actualExceed : null,
      actualComplete: ranking.filter(function (row) { return row.dataClass === '実績確定'; }).length,
      planForecast: ranking.filter(function (row) { return row.dataClass === '予定込み予測'; }).length,
      pastPlanCount: isNum(basis.planExceed) ? basis.planExceed : null,
      watchNow: attention.filter(function (row) { return row.adminLabel === '本日要注意'; }).length,
      watchSoon: attention.filter(function (row) { return row.adminLabel === '本日監視'; }).length,
      attention: attention,
      ranking: ranking,
      future: futureRows(snapshot, referenceDate, run.predictions),
      gaps: gaps,
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function matches(row, query) {
    if (!query) return true;
    var hay = ((row.name || '') + ' ' + (row.transportId || '')).toLowerCase();
    return hay.indexOf(query) >= 0;
  }

  function dayRows(row) {
    return (row.days || []).map(function (day) {
      var actual = day && actualOrigin(day.origin) && isNum(day.hours);
      var plan = day && day.origin === 'roster-plan' && isNum(day.hours);
      var valueKind = '未取得';
      if (actual && day.origin === 'archived-daily') valueKind = '保存済みの推定（暫定）';
      else if (actual) valueKind = '推定（暫定）';
      else if (plan) valueKind = '予定（暫定）';
      return {
        date: day && day.date ? day.date : '',
        actual: actual ? hourText(day.hours) : '未取得',
        plan: plan ? hourText(day.hours) : '—',
        adopted: actual ? '実績' : (plan ? '予定' : '未取得'),
        valueKind: valueKind,
      };
    });
  }

  function checkedAtText(iso) {
    var time = Date.parse(iso || '');
    if (!isFinite(time)) return '未取得';
    var jst = new Date(time + 9 * 60 * 60 * 1000);
    function two(n) { return n < 10 ? '0' + n : String(n); }
    return jst.getUTCFullYear() + '-' + two(jst.getUTCMonth() + 1) + '-' + two(jst.getUTCDate()) + ' ' + two(jst.getUTCHours()) + ':' + two(jst.getUTCMinutes()) + ':' + two(jst.getUTCSeconds());
  }

  function orderedRows(rows, mode) {
    var copy = (rows || []).slice();
    if (mode !== 'name') return copy;
    copy.sort(function (a, b) {
      var byName = String(a.name || '').localeCompare(String(b.name || ''), 'ja');
      if (byName !== 0) return byName;
      return String(a.transportId).localeCompare(String(b.transportId));
    });
    return copy;
  }

  function gaugeCard(row) {
    var status = statusOf(row);
    var color = TONE_COLOR[status.tone] || TONE_COLOR.unknown;
    var width = Math.max(0, Math.min(100, status.bar));
    return '<article class="card p-3" data-duty-tone="' + status.tone + '" style="border-left:4px solid ' + color + '">' +
      '<div class="text-sm font-bold">' + escapeHtml(row.name || '氏名なし') + '</div>' +
      '<div class="text-xs text-ink-lighter mb-1">' + escapeHtml(row.transportId || '') + '</div>' +
      '<div class="text-lg font-bold" style="color:' + color + '">' + escapeHtml(status.text) + '</div>' +
      '<div style="height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin:6px 0">' +
      '<div style="width:' + width + '%;height:8px;background:' + color + '"></div></div>' +
      '<div class="text-sm font-bold">' + escapeHtml(status.label) + '</div>' +
      '<div class="text-xs text-ink-lighter">' + escapeHtml(valueState(row)) + '。' + escapeHtml(status.hint) + '</div>' +
      '</article>';
  }

  function renderHtml(view, query) {
    if (!view || !view.ok) {
      return '<div class="card p-4 text-sm">保存データを表示できません。' + escapeHtml(view && view.reason ? view.reason : '') + '</div>';
    }
    var q = String(query || '').trim().toLowerCase();
    var mode = view.sortMode === 'name' ? 'name' : 'remaining';
    var attention = orderedRows((view.attention || []).filter(function (row) { return matches(row, q); }), mode);
    var ranking = orderedRows(view.ranking.filter(function (row) { return matches(row, q); }), mode);
    var future = view.future.filter(function (row) { return matches(row, q); });
    var gaps = view.gaps.filter(function (row) { return matches(row, q); });
    var selected = view.selectedId ? view.ranking.concat(view.gaps).filter(function (row) { return row.transportId === view.selectedId; })[0] : null;
    var html = '';
    html += '<div class="mb-4"><h2 class="text-lg font-bold">勤務時間リスク</h2>';
    html += '<p class="text-sm text-ink-lighter">対象 ' + escapeHtml(view.windowStart || '') + ' 〜 ' + escapeHtml(view.referenceDate) + '。取得日時 ' + escapeHtml(checkedAtText(view.checkedAt)) + '。この取得日時は保存データの時刻です。</p>';
    html += '<p class="text-sm text-ink-lighter">過去6日の実績が60時間を超えたときだけ実績超過です。今日の予定を足してはじめて60時間以上になるときは超過見込みで、実績超過ではありません。1時間未満は本日要注意、1時間以上5時間未満は本日監視です。推定時間は確定値ではありません。ゲージは60時間に対する残量です。</p></div>';
    html += '<div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-4">';
    html += card('超過確定', view.confirmed == null ? '未取得' : String(view.confirmed), '保存済みの実績確定');
    html += card('本日要注意', String(view.watchNow), '勤務予定あり・余裕1時間未満');
    html += card('本日監視', String(view.watchSoon), '余裕1時間以上5時間未満');
    html += card('未来予測超過', String(view.future.length), '今日の7日窓とは別');
    html += card('実績確定', String(view.actualComplete), '必要な実績が揃っている');
    html += card('予定込み予測', String(view.planForecast), '実績確定には含めない');
    html += card('判定不能', String(view.gaps.length), '合計を出せない');
    html += '</div>';
    html += '<input id="duty-risk-search" class="w-full md:w-80 mb-4 px-3 py-2 border rounded-lg text-sm" placeholder="氏名・Transport ID" value="' + escapeHtml(query || '') + '">';
    html += '<div class="flex flex-wrap gap-2 mb-3">';
    html += '<button type="button" class="px-3 py-1 rounded text-sm ' + (mode === 'remaining' ? 'bg-slate-800 text-white' : 'bg-slate-100') + '" data-duty-sort="remaining">残りが少ない順</button>';
    html += '<button type="button" class="px-3 py-1 rounded text-sm ' + (mode === 'name' ? 'bg-slate-800 text-white' : 'bg-slate-100') + '" data-duty-sort="name">氏名順</button>';
    html += '</div>';
    html += '<h3 class="font-bold mb-2">勤務時間残量</h3>';
    html += '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-4">';
    if (!ranking.length) html += '<p class="text-sm text-ink-lighter">該当なし</p>';
    ranking.forEach(function (row) { html += gaugeCard(row); });
    html += '</div>';
    html += '<h3 class="font-bold mb-2">本日の危険DA</h3>';
    html += '<p class="text-xs text-ink-lighter mb-2">本日要注意と本日監視だけを、通常ランキングの上に出しています。</p>';
    html += table(attention.map(attentionCells), ['氏名', 'Transport ID', '危険度', '過去6日の時間', '今日の予定時間', '7日予測合計', '今日の勤務可能上限', '今日の予定終了後の余裕', '区分'], {
      rowStyle: function (row) {
        if (String(row[3]).indexOf('本日要注意') >= 0) return 'background:#fff1f2';
        if (String(row[3]).indexOf('本日監視') >= 0) return 'background:#fffbeb';
        return '';
      }
    });
    html += '<h3 class="font-bold mt-6 mb-2">本日リスクランキング</h3>';
    html += '<p class="text-xs text-ink-lighter mb-2">初期順は予定終了後の余裕が少ない順です。予定込み予測も表示します。本日監視は余裕1時間以上5時間未満です。</p>';
    html += table(ranking.map(riskCells), ['氏名', 'Transport ID', '過去6日の時間', '今日の予定時間', '7日予測合計', '今日の勤務可能上限', '今日の予定終了後の余裕', '区分']);
    html += '<h3 class="font-bold mt-6 mb-2">未来予測超過</h3>';
    if (view.pastPlanCount != null) {
      html += '<p class="text-xs text-ink-lighter mb-2">保存済みの過去窓（予定を含む）は ' + view.pastPlanCount + ' 件。この一覧には入れていません。</p>';
    }
    html += table(future.map(function (row) {
      return [
        '',
        escapeHtml(row.name || '氏名なし'),
        escapeHtml(row.transportId || row.transportNote || '未結合'),
        escapeHtml(row.windowLabel),
        hourText(row.totalHours),
        hourText(row.overBy),
        '実績 ' + hourText(row.actualHours) + ' / 予定 ' + hourText(row.rosterHours),
      ];
    }), ['氏名', 'Transport ID', '対象期間', '予測合計', '超過予測', '内訳']);
    html += '<h3 class="font-bold mt-6 mb-2">判定不能</h3>';
    html += '<p class="text-xs text-ink-lighter mb-2">欠損を0時間にはしていません。理由は行ごとに表示します。</p>';
    html += table(gaps.map(function (row) {
      var dates = row.gaps.map(function (gap) { return (gap.date || '日付不明') + ' ' + gap.reason; }).join('、');
      return [
        row.transportId,
        escapeHtml(row.name || '氏名なし'),
        escapeHtml(row.transportId),
        escapeHtml(dates || '当日窓が保存されていない'),
        '判定不能',
      ];
    }), ['氏名', 'Transport ID', '欠損', '判定']);
    html += '<h3 class="font-bold mt-6 mb-2">DA詳細</h3>';
    if (!selected) {
      html += '<p class="text-sm text-ink-lighter">ランキングまたは判定不能の行を選ぶと、7日間の内訳を表示します。</p>';
    } else {
      var selectedStatus = statusOf(selected);
      html += '<p class="text-sm mb-2">' + escapeHtml(selected.name || '氏名なし') + ' ' + escapeHtml(selected.transportId) + '</p>';
      html += table(dayRows(selected).map(function (day) {
        return ['', escapeHtml(day.date), day.actual, day.plan, day.adopted, escapeHtml(day.valueKind)];
      }), ['日付', 'Amazon実績', 'シフト予定', '採用', '値の性質']);
      html += '<p class="text-sm mt-2">区分: ' + escapeHtml(selected.dataClass) + ' / ' + escapeHtml(selectedStatus.label) + '</p>';
      html += '<p class="text-sm">値の性質: ' + escapeHtml(valueState(selected)) + '</p>';
      html += '<p class="text-sm">' + escapeHtml(selectedStatus.hint) + '</p>';
      html += '<p class="text-sm">7日間の合計: ' + (selected.seriesComplete ? forecastText(selected) : '判定不能') + '</p>';
      html += '<p class="text-sm">今日の勤務可能上限: ' + hourText(selected.workable) + '。今日の予定終了後の余裕: ' + marginCell(selected) + '</p>';
    }
    return html;
  }

  function render(rootEl, view, query) {
    if (!rootEl) return;
    rootEl.innerHTML = renderHtml(view, query);
    if (typeof document === 'undefined' || !rootEl.querySelectorAll) return;
    var search = document.getElementById('duty-risk-search');
    if (search) {
      search.addEventListener('input', function () {
        render(rootEl, view, search.value);
        var again = document.getElementById('duty-risk-search');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    }
    rootEl.querySelectorAll('[data-duty-sort]').forEach(function (button) {
      button.addEventListener('click', function () {
        view.sortMode = button.getAttribute('data-duty-sort') || 'remaining';
        var current = document.getElementById('duty-risk-search');
        render(rootEl, view, current ? current.value : query);
      });
    });
    rootEl.querySelectorAll('[data-duty-id]').forEach(function (button) {
      button.addEventListener('click', function () {
        view.selectedId = button.getAttribute('data-duty-id');
        var current = document.getElementById('duty-risk-search');
        render(rootEl, view, current ? current.value : query);
      });
    });
  }

  function card(title, value, note) {
    return '<div class="card p-3"><div class="text-xs text-ink-lighter">' + escapeHtml(title) + '</div><div class="text-2xl font-bold">' + escapeHtml(value) + '</div><div class="text-xs text-ink-lighter">' + escapeHtml(note) + '</div></div>';
  }

  function marginCell(row) {
    var status = statusOf(row);
    var margin = marginText(row.marginAfterPlan);
    if (status.tone === 'actual') return '実績超過。予定を含めると ' + margin;
    return margin;
  }

  function classLabel(row) {
    var status = statusOf(row);
    return row.dataClass + '・' + status.label + (row.adminLabel ? '・' + row.adminLabel : '') + '・' + valueState(row);
  }

  function riskCells(row) {
    return [
      row.transportId,
      escapeHtml(row.name || '氏名なし'),
      escapeHtml(row.transportId),
      hourText(row.pastActual) + (row.pastKind ? ' ' + row.pastKind : ''),
      row.todayPlan == null ? '予定なし' : hourText(row.todayPlan),
      forecastText(row),
      hourText(row.workable),
      escapeHtml(marginCell(row)),
      escapeHtml(classLabel(row)),
    ];
  }

  function attentionCells(row) {
    return [
      row.transportId,
      escapeHtml(row.name || '氏名なし'),
      escapeHtml(row.transportId),
      escapeHtml(row.adminLabel || ''),
      hourText(row.pastActual) + (row.pastKind ? ' ' + row.pastKind : ''),
      row.todayPlan == null ? '予定なし' : hourText(row.todayPlan),
      forecastText(row),
      hourText(row.workable),
      escapeHtml(marginCell(row)),
      escapeHtml(classLabel(row)),
    ];
  }

  function table(rows, headers, options) {
    var rowStyle = options && options.rowStyle;
    var html = '<div class="overflow-x-auto card"><table class="w-full text-sm"><thead><tr>';
    headers.forEach(function (header) { html += '<th class="text-left p-2">' + escapeHtml(header) + '</th>'; });
    html += '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td class="p-2 text-ink-lighter" colspan="' + headers.length + '">該当なし</td></tr>';
    rows.forEach(function (row) {
      var id = row[0];
      var style = rowStyle ? rowStyle(row) : '';
      html += '<tr class="border-t"' + (style ? ' style="' + style + '"' : '') + '>';
      row.slice(1).forEach(function (cell, index) {
        if (index === 0 && id) html += '<td class="p-2"><button type="button" class="underline" data-duty-id="' + escapeHtml(id) + '">' + cell + '</button></td>';
        else html += '<td class="p-2">' + cell + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  var state = { view: null, loading: false };

  function mount(rootEl) {
    if (!rootEl || state.loading) return;
    if (state.view) { render(rootEl, state.view, ''); return; }
    state.loading = true;
    rootEl.innerHTML = '<p class="text-sm">保存データを読み込んでいます。</p>';
    Promise.all([
      fetch('/local/inoichi-rolling-snapshot.json', { cache: 'no-store' }).then(function (res) { return res.json(); }),
      fetch('/local/rolling60h-history.json', { cache: 'no-store' }).then(function (res) { return res.json(); }),
    ]).then(function (pair) {
      state.view = buildView(pair[0], pair[1]);
      state.loading = false;
      render(rootEl, state.view, '');
    }).catch(function () {
      state.loading = false;
      rootEl.innerHTML = '<div class="card p-4 text-sm">保存データを読めませんでした。再回収は行っていません。</div>';
    });
  }

  return { buildView: buildView, hourText: hourText, marginText: marginText, statusOf: statusOf, renderHtml: renderHtml, dayBreakdown: dayRows, mount: mount };
});
