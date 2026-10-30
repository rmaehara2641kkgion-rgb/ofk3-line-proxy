/**
 * 11時間接近の表示用まとめ。
 * 7日窓の超過・接近・判定不能とは別の一覧にする。
 * 時間未取得を 0 にはしない。実績ファイルが無いとき、実績判定済みとは書かない。
 */
(function (global) {
  'use strict';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hoursText(hours) {
    if (typeof hours !== 'number' || !isFinite(hours)) return '取得不可';
    var rounded = Math.round(hours * 100) / 100;
    return String(rounded) + '時間';
  }

  function dayAt(series, date) {
    var found = null;
    (series || []).forEach(function (day) {
      if (day && day.date === date) found = day;
    });
    return found;
  }

  function basisText(amazonLoaded, series, prefixStart, referenceDate) {
    if (!amazonLoaded) {
      return 'シフト予定に基づく判定です。Amazon実績は読み込んでいません。';
    }
    var actual = false;
    var plan = false;
    (series || []).forEach(function (day) {
      if (!day || day.date < prefixStart || day.date > referenceDate) return;
      (day.blocks || []).forEach(function (block) {
        if (!block) return;
        if (block.source === 'actual') actual = true;
        else if (block.source === 'roster') plan = true;
      });
    });
    if (actual && plan) return '推定稼働時間とシフト予定が混在しています。確定した労働時間ではありません。';
    if (actual) return 'Amazonの推定稼働時間に基づく参考値です。確定した労働時間ではありません。';
    return 'シフト予定に基づく判定です。この期間の実績時間はありません。';
  }

  function assessDriver(core, input) {
    input = input || {};
    var ref = input.referenceDate || '';
    var series = input.series || [];
    var prefixStart = core.addDaysIso(ref, -6);
    var prefixEnd = core.addDaysIso(ref, -1);
    var prefix = core.prefixHoursBeforeToday(series, ref);
    var today = dayAt(series, ref);
    var duty = core.todayDutyFromBlocks(today && today.blocks);
    var margin = core.approachByMargin(prefix, duty);
    var windowStart = prefixStart;
    var found = null;
    (input.windows || []).forEach(function (item) {
      if (item && item.endDate === ref && item.startDate === windowStart) found = item;
    });
    return {
      name: input.name || '',
      transportId: input.transportId || '',
      prefixHours: prefix,
      prefixStart: prefixStart,
      prefixEnd: prefixEnd,
      duty: duty,
      margin: margin.notice,
      marginReason: margin.reason,
      windowJudgment: found ? found.judgment : 'undetermined',
      windowHours: found && typeof found.totalHours === 'number' ? found.totalHours : null,
      windowStart: windowStart,
      windowEnd: ref,
      basisText: basisText(!!input.amazonLoaded, series, prefixStart, ref),
    };
  }

  function personLabel(row) {
    var name = row.name || '氏名未設定';
    return name + (row.transportId ? '（' + row.transportId + '）' : '');
  }

  function summarize(rows, meta) {
    meta = meta || {};
    rows = rows || [];
    var ref = meta.referenceDate || (rows[0] && rows[0].windowEnd) || '';
    var prefixStart = rows[0] ? rows[0].prefixStart : '';
    var prefixEnd = rows[0] ? rows[0].prefixEnd : '';
    var windowStart = rows[0] ? rows[0].windowStart : '';
    var marginApproach = [];
    var windowExceed = [];
    var windowApproach = [];
    var undetermined = [];
    var excluded = 0;
    rows.forEach(function (row) {
      if (!row) return;
      if (row.margin === 'approach') marginApproach.push(row);
      if (row.margin === 'excluded') excluded++;
      if (row.windowJudgment === 'exceed') windowExceed.push(row);
      else if (row.windowJudgment === 'approach') windowApproach.push(row);
      if (row.windowJudgment === 'undetermined' || row.prefixHours == null || row.margin === 'unconfirmed') {
        undetermined.push(row);
      }
    });
    var basis = rows.length ? rows[0].basisText : basisText(!!meta.amazonLoaded, [], prefixStart, ref);
    return {
      referenceDate: ref,
      prefixStart: prefixStart,
      prefixEnd: prefixEnd,
      windowStart: windowStart,
      windowEnd: ref,
      basisText: basis,
      marginApproach: marginApproach,
      windowExceed: windowExceed,
      windowApproach: windowApproach,
      undetermined: undetermined,
      excluded: excluded,
      driverCount: rows.length,
    };
  }

  function line(row, hours, extra) {
    return esc(personLabel(row)) + ' ' + hoursText(hours) + (extra ? ' ' + esc(extra) : '');
  }

  function listBlock(title, note, rows, hoursOf) {
    var html = '<h4 class="font-bold mt-3 mb-1">' + esc(title) + ' ' + rows.length + '人</h4>';
    html += '<p class="text-xs text-ink-lighter mb-1">' + esc(note) + '</p>';
    if (!rows.length) return html + '<p class="text-sm">該当なし</p>';
    html += '<ul class="text-sm" style="margin:0;padding-left:1.2em;">';
    rows.forEach(function (row) {
      html += '<li>' + line(row, hoursOf(row), row.windowJudgment === 'undetermined' ? row.marginReason : '') + '</li>';
    });
    html += '</ul>';
    return html;
  }

  function renderHtml(summary) {
    if (!summary || !summary.referenceDate) {
      return '<div class="card p-4 mb-4 text-sm">基準日の11時間接近は、まだ計算されていません。WH60でシフト表を読み込むと、ここに表示します。</div>';
    }
    var html = '<div class="card p-4 mb-4 text-sm">';
    html += '<h3 class="text-sm font-bold mb-1">11時間接近（7日窓の接近とは別）</h3>';
    html += '<p>基準日 ' + esc(summary.referenceDate) + '。11時間接近の対象期間は ' + esc(summary.prefixStart) + '〜' + esc(summary.prefixEnd) + '（当日は含まない）。基準日で終わる7日窓は ' + esc(summary.windowStart) + '〜' + esc(summary.windowEnd) + '。</p>';
    html += '<p>' + esc(summary.basisText) + '</p>';
    html += '<p class="text-xs text-ink-lighter">当日休みのため11時間接近に入れない人 ' + summary.excluded + '人。同じ人が複数の一覧に出ることがあります。</p>';
    html += listBlock('11時間接近', '前6日が60時間まで11時間以内で、当日に勤務がある人です。', summary.marginApproach, function (row) { return row.prefixHours; });
    html += listBlock('7日窓の超過', '基準日で終わる7日間の合計が60時間を超えた人です。', summary.windowExceed, function (row) { return row.windowHours; });
    html += listBlock('7日窓の接近', '基準日で終わる7日間の合計が警戒ラインに達した人です。11時間接近の条件とは別です。', summary.windowApproach, function (row) { return row.windowHours; });
    html += listBlock('判定不能', '不明な時間は0時間にしていません。', summary.undetermined, function (row) { return row.prefixHours; });
    html += '</div>';
    return html;
  }

  function renderPrintHtml(summary) {
    if (!summary || !summary.referenceDate) return '';
    function names(rows, hoursOf) {
      if (!rows.length) return '該当なし';
      return rows.map(function (row) { return personLabel(row) + ' ' + hoursText(hoursOf(row)); }).join('、');
    }
    var html = '<h2>11時間接近（7日窓の接近とは別）</h2>';
    html += '<p>基準日 ' + esc(summary.referenceDate) + '。11時間接近の対象期間 ' + esc(summary.prefixStart) + '〜' + esc(summary.prefixEnd) + '。7日窓 ' + esc(summary.windowStart) + '〜' + esc(summary.windowEnd) + '。</p>';
    html += '<p>' + esc(summary.basisText) + '</p>';
    html += '<p>11時間接近 ' + summary.marginApproach.length + '人: ' + esc(names(summary.marginApproach, function (row) { return row.prefixHours; })) + '</p>';
    html += '<p>7日窓の超過 ' + summary.windowExceed.length + '人: ' + esc(names(summary.windowExceed, function (row) { return row.windowHours; })) + '</p>';
    html += '<p>7日窓の接近 ' + summary.windowApproach.length + '人: ' + esc(names(summary.windowApproach, function (row) { return row.windowHours; })) + '</p>';
    html += '<p>判定不能 ' + summary.undetermined.length + '人: ' + esc(names(summary.undetermined, function (row) { return row.prefixHours; })) + '</p>';
    return html;
  }

  var api = {
    assessDriver: assessDriver,
    summarize: summarize,
    renderHtml: renderHtml,
    renderPrintHtml: renderPrintHtml,
    hoursText: hoursText,
  };
  global.RollingPrefixView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
