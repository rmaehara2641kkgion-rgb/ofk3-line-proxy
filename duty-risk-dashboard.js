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

  // 将来超過の警告。従来の行（exceed + forecast）と、INO-1 の期間分離後の行（future-exceed、および現在行に付く futureExceed）の両方を読む。
  // 同じ人・同じ期間は1件だけにする。
  function futureCandidates(alerts, referenceDate) {
    var out = [];
    var seen = {};
    function add(alert, source) {
      var key = (alert.transportId || alert.name || '') + '|' + alert.startDate + '|' + alert.endDate + '|' + alert.totalHours;
      if (seen[key]) return;
      seen[key] = true;
      out.push(source);
    }
    (alerts || []).forEach(function (alert) {
      if (!alert) return;
      var legacy = alert.disposition === 'exceed' && alert.basis === 'forecast' && alert.endDate > referenceDate;
      if (legacy || (alert.disposition === 'future-exceed' && alert.endDate > referenceDate)) add(alert, alert);
      var nested = alert.futureExceed;
      if (nested && alert.disposition !== 'future-exceed' && nested.endDate > referenceDate) {
        add({ transportId: alert.transportId, name: alert.name, startDate: nested.startDate, endDate: nested.endDate, totalHours: nested.totalHours }, {
          transportId: alert.transportId,
          name: alert.name,
          startDate: nested.startDate,
          endDate: nested.endDate,
          totalHours: nested.totalHours,
          overBy: nested.overBy,
          actualHours: nested.actualHours,
          rosterHours: nested.rosterHours,
        });
      }
    });
    return out;
  }

  function futureRows(snapshot, referenceDate, predictions) {
    var index = indexByWindow(predictions);
    return futureCandidates(snapshot && Array.isArray(snapshot.alerts) ? snapshot.alerts : [], referenceDate).map(function (alert) {
      var ids = index[predictionKey(alert.startDate, alert.endDate, alert.totalHours)] || [];
      var joined = ids.length === 1 ? ids[0] : '';
      var transportId = alert.transportId || joined;
      return {
        name: alert.name || '',
        transportId: transportId,
        transportNote: transportId ? '' : '保存データ上、Transport IDを一意に結び付けられない',
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

  function masterText(value) {
    return value == null ? '' : String(value).trim();
  }

  function masterRecord(master, transportId) {
    if (!master || transportId == null || transportId === '') return null;
    var id = String(transportId);
    var record = null;
    try {
      if (typeof master === 'function') record = master(id);
      else if (typeof master.lookup === 'function') record = master.lookup(id);
      else if (master.byTransportId && Object.prototype.hasOwnProperty.call(master.byTransportId, id)) record = master.byTransportId[id];
    } catch (e) {
      return null;
    }
    return record || null;
  }

  function masterDisplayName(record) {
    if (!record) return '';
    if (typeof record === 'string') return masterText(record);
    return masterText(record.japaneseName) || masterText(record.englishName);
  }

  function applyMasterNames(rows, master) {
    (rows || []).forEach(function (row) {
      if (!row || row.transportId == null || row.transportId === '') return;
      var name = masterDisplayName(masterRecord(master, row.transportId));
      if (name) row.name = name;
    });
  }

  function liveMaster(transportId) {
    if (typeof resolveDutyRiskMasterName !== 'function') return null;
    try { return resolveDutyRiskMasterName(transportId); } catch (e) { return null; }
  }

  function buildView(snapshot, history, master) {
    var lookup = master === undefined ? liveMaster : master;
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
    applyMasterNames(rows, lookup);
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
      future: (function () {
        var future = futureRows(snapshot, referenceDate, run.predictions);
        applyMasterNames(future, lookup);
        future.forEach(function (row) { if (!row.name) row.name = ''; });
        return future;
      })(),
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

  function checkedAtText(iso) {
    var time = Date.parse(iso || '');
    if (!isFinite(time)) return '未取得';
    var jst = new Date(time + 9 * 60 * 60 * 1000);
    function two(n) { return n < 10 ? '0' + n : String(n); }
    return jst.getUTCFullYear() + '-' + two(jst.getUTCMonth() + 1) + '-' + two(jst.getUTCDate()) + ' ' + two(jst.getUTCHours()) + ':' + two(jst.getUTCMinutes()) + ':' + two(jst.getUTCSeconds());
  }

  function render(rootEl, view, query) {
    if (!rootEl) return;
    var notice = state.feedNotice ? '<div class="card p-4 mb-4 text-sm">' + escapeHtml(state.feedNotice) + '</div>' : '';
    if (!view || !view.ok) {
      rootEl.innerHTML = notice + '<div class="card p-4 text-sm">保存データを表示できません。' + escapeHtml(view && view.reason ? view.reason : '') + '</div>';
      return;
    }
    var q = String(query || '').trim().toLowerCase();
    var mode = view.sortMode === 'name' ? 'name' : 'remaining';
    var attention = orderedRows((view.attention || []).filter(function (row) { return matches(row, q); }), mode);
    var ranking = orderedRows(view.ranking.filter(function (row) { return matches(row, q); }), mode);
    var future = view.future.filter(function (row) { return matches(row, q); });
    var gaps = view.gaps.filter(function (row) { return matches(row, q); });
    var selected = view.selectedId ? view.ranking.concat(view.gaps).filter(function (row) { return row.transportId === view.selectedId; })[0] : null;
    var html = '';
    html += notice;
    if (view.stale) {
      html += '<div class="card p-4 mb-4 text-sm" role="alert" style="background:#fffbeb">以下は前回取得できた保存データ（' + escapeHtml(checkedAtText(view.checkedAt)) + '）です。最新のデータではありません。</div>';
    }
    if (!view.ranking.length && !view.gaps.length) {
      html += '<div class="card p-4 mb-4 text-sm">保存データに対象者がいません（取得は成功しています）。</div>';
    }
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
    html += reloadButton();
    rootEl.innerHTML = html;
    bindReload(rootEl);
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

  var state = { view: null, loading: false, root: null, snapshot: null, history: null, query: '', feedNotice: '' };

  var FAILURE_REASONS = {
    'unauthorized': '認証に失敗しました（アプリ設定のプロキシ認証キーを確認してください）',
    'not-configured': 'サーバー側の取得設定（DUTY_RISK_GAS_URL / DUTY_RISK_GAS_TOKEN / PROXY_SECRET）が未設定です',
    'timeout': '取得がタイムアウトしました',
    'network': 'サーバーから保存データ元（GAS）へ接続できませんでした',
    'upstream-http': '保存データ元（GAS）がエラー応答を返しました',
    'invalid-response': '保存データ元（GAS）の応答を読み取れませんでした（GASの公開設定・デプロイURLを確認してください）',
    'read-failed': '保存データの読み出しに失敗しました',
    'client-network': 'ブラウザからサーバーへ接続できませんでした',
    'client-timeout': 'サーバーからの応答がタイムアウトしました',
    'client-invalid-response': 'サーバーの応答を読み取れませんでした',
  };

  // 失敗・データなし・成功を区別する。'not-published' は失敗ではなく「まだ公開データがない」。
  function classifyFeed(body, httpStatus) {
    if (body && body.ok === true && body.snapshot && body.historyRun) return { kind: 'ok', reason: '' };
    if (body && body.ok === false && body.reason === 'not-published') return { kind: 'empty', reason: 'not-published' };
    var reason = body && typeof body === 'object' && body.reason ? String(body.reason) : '';
    if (!reason) reason = httpStatus ? 'upstream-http' : 'client-invalid-response';
    return { kind: 'failure', reason: reason, httpStatus: httpStatus || null };
  }

  function reasonText(reason) {
    return FAILURE_REASONS[reason] || ('原因コード: ' + String(reason || 'unknown').replace(/[^\w-]/g, ''));
  }

  function failureText(body, previousCheckedAt) {
    var when = body && body.lastSuccessAt ? body.lastSuccessAt : (previousCheckedAt || '');
    var head = '勤務時間データを取得できませんでした。';
    var reason = body && body.reason ? reasonText(body.reason) + '。' : '';
    return head + reason + '最終成功データの取得日時: ' + (when ? checkedAtText(when) : '不明');
  }

  function emptyText(view) {
    return '勤務時間データはまだ公開されていません（取得失敗ではありません）。ローカル回収後の公開をお待ちください。';
  }

  function feedHeaders() {
    try {
      if (typeof dutyRiskAuthHeaders === 'function') return dutyRiskAuthHeaders() || {};
    } catch (e) {}
    return {};
  }

  function refresh() {
    if (!state.snapshot || !state.history) return state.view;
    var query = state.query || '';
    if (state.root && typeof document !== 'undefined') {
      var search = document.getElementById('duty-risk-search');
      if (search) query = search.value;
    }
    state.query = query;
    var wasStale = !!(state.view && state.view.stale);
    var sortMode = state.view && state.view.sortMode;
    var selectedId = state.view && state.view.selectedId;
    state.view = buildView(state.snapshot, state.history);
    if (state.view) {
      state.view.stale = wasStale;
      if (sortMode) state.view.sortMode = sortMode;
      if (selectedId) state.view.selectedId = selectedId;
    }
    if (state.root) render(state.root, state.view, query);
    return state.view;
  }

  function showFailure(rootEl, body, httpStatus) {
    var previousCheckedAt = state.view && state.view.checkedAt ? state.view.checkedAt : '';
    var text = failureText(body, previousCheckedAt);
    if (httpStatus && body && body.reason === 'upstream-http') text += '（HTTP ' + httpStatus + '）';
    state.feedNotice = text;
    if (state.view) {
      // 前回成功分は「最新ではない」と明示して残す。最新データとしては見せない。
      state.view.stale = true;
      render(rootEl, state.view, state.query || '');
    } else {
      rootEl.innerHTML = '<div class="card p-4 text-sm" role="alert">' + escapeHtml(text) + '</div>' + reloadButton();
      bindReload(rootEl);
    }
  }

  function reloadButton() {
    return '<div class="mt-3"><button type="button" class="underline text-sm" data-duty-reload="1">再読み込み</button></div>';
  }

  function bindReload(rootEl) {
    var button = rootEl.querySelector ? rootEl.querySelector('[data-duty-reload]') : null;
    if (button) button.addEventListener('click', function () { load(rootEl); });
  }

  function logFailure(info) {
    try { if (typeof console !== 'undefined') console.warn('勤務時間リスクの取得失敗:', info); } catch (e) {}
  }

  function load(rootEl) {
    if (!rootEl || state.loading) return Promise.resolve();
    state.root = rootEl;
    state.loading = true;
    if (!state.view) rootEl.innerHTML = '<p class="text-sm">保存データを読み込んでいます。</p>';
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 60000) : null;
    var httpStatus = 0;
    return fetch('/duty-risk-feed', {
      cache: 'no-store',
      headers: feedHeaders(),
      signal: controller ? controller.signal : undefined,
    }).then(function (res) {
      httpStatus = res.status;
      return res.json().then(function (body) { return body; }, function () { return { ok: false, reason: 'client-invalid-response' }; });
    }).then(function (body) {
      if (timer) clearTimeout(timer);
      state.loading = false;
      var result = classifyFeed(body, httpStatus);
      if (result.kind === 'failure') {
        logFailure({ reason: result.reason, httpStatus: httpStatus });
        showFailure(rootEl, { reason: result.reason, lastSuccessAt: body && body.lastSuccessAt }, httpStatus);
        return;
      }
      state.feedNotice = '';
      if (result.kind === 'empty') {
        state.view = null; state.snapshot = null; state.history = null;
        rootEl.innerHTML = '<div class="card p-4 text-sm">' + escapeHtml(emptyText()) + '</div>' + reloadButton();
        bindReload(rootEl);
        return;
      }
      state.snapshot = body.snapshot;
      state.history = { runs: [body.historyRun] };
      state.view = buildView(state.snapshot, state.history);
      if (state.view) state.view.stale = false;
      render(rootEl, state.view, state.query || '');
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      state.loading = false;
      var aborted = err && err.name === 'AbortError';
      logFailure({ reason: aborted ? 'client-timeout' : 'client-network', message: err && err.message ? err.message : '' });
      showFailure(rootEl, { reason: aborted ? 'client-timeout' : 'client-network' }, 0);
    });
  }

  // タブを開くたびに取得し直す（成功済みの古い表示を最新として使い回さない）。
  function mount(rootEl) {
    if (!rootEl) return Promise.resolve();
    if (state.view && !state.loading) render(rootEl, state.view, state.query || '');
    return load(rootEl);
  }

  return { analyzePrediction: analyzePrediction, buildView: buildView, hourText: hourText, marginText: marginText, statusOf: statusOf, dayBreakdown: dayRows, failureText: failureText, classifyFeed: classifyFeed, emptyText: emptyText, mount: mount, refresh: refresh, _state: state };
});
