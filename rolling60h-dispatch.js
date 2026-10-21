/**
 * 今日と明日を別の基準日にしたローリング60h判定。
 * 合計は rolling60h-core.js の computeRolling60h を使う。
 * 同じ日に実績と予定が両方あっても足さず、実績がある日は実績だけを使う。
 * 仮の短縮は計算結果だけを変え、渡された原本のブロックは変更しない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.RollingCore) root.RollingDispatch = api.bindCore(root.RollingCore);
  else if (root) root.RollingDispatch = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var EPS = 1e-9;
  var LABELS = {
    within: '以内',
    approach: '接近',
    exceed: '超過',
    missing: 'データ未取得',
    unconfirmed: '予定未確定',
    undefined: '記号未定義',
    failed: '集計失敗'
  };

  function failedBoard(today) {
    return {
      ok: false,
      status: 'failed',
      safe: false,
      today: today || '',
      tomorrow: '',
      limitHours: 60,
      todayDanger: [],
      tomorrowDanger: [],
      adjustable: [],
      undetermined: [],
      drivers: [],
      note: '集計失敗'
    };
  }

  function bindCore(rolling) {
    function dateOk(value) {
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    }

    function originOf(blocks) {
      if (!blocks) return 'missing';
      if (!blocks.length) return 'rest';
      if (blocks.some(function (block) { return block && block.blank; })) return 'unconfirmed';
      var actual = false;
      var roster = false;
      blocks.forEach(function (block) {
        if (!block) return;
        if (block.source === 'actual') actual = true;
        else if (block.source === 'roster') roster = true;
      });
      if (actual && roster) return 'mixed';
      if (actual) return 'actual';
      if (roster) return 'roster';
      return 'missing';
    }

    function blend(actualMap, rosterMap, reference, start, end) {
      var merged = rolling.mergeActualAndRoster(actualMap, rosterMap, reference);
      var blocksByDate = {};
      var origins = {};
      var cursor = start;
      var guard = 0;
      while (cursor && guard < 4000) {
        if (Object.prototype.hasOwnProperty.call(merged, cursor)) {
          blocksByDate[cursor] = merged[cursor];
          origins[cursor] = originOf(merged[cursor]);
        } else {
          origins[cursor] = 'missing';
        }
        if (cursor === end) break;
        cursor = rolling.addDays(cursor, 1);
        guard += 1;
      }
      return { blocksByDate: blocksByDate, origins: origins };
    }

    function fillActual(actualMap, archiveMap) {
      var filled = {};
      Object.keys(actualMap || {}).forEach(function (date) { filled[date] = actualMap[date]; });
      Object.keys(archiveMap || {}).forEach(function (date) {
        if (!Object.prototype.hasOwnProperty.call(filled, date)) filled[date] = archiveMap[date];
      });
      return filled;
    }

    function windowOf(blocksByDate, start, end, limit, overrides) {
      var series = rolling.buildContinuousDailySeries(blocksByDate, start, end);
      var found = rolling.computeRolling60h(series, {
        limitHours: limit,
        warningHours: limit,
        overrides: overrides || {}
      });
      return { series: series, window: found.length ? found[0] : null };
    }

    function dayOf(series, date) {
      var found = null;
      (series || []).forEach(function (day) {
        if (day.date === date) found = day;
      });
      return found;
    }

    function sideFrom(result, limit, origin) {
      if (!result) {
        return {
          status: 'failed',
          label: LABELS.failed,
          origin: origin || 'missing',
          totalHours: null,
          remainingHours: null,
          overHours: null,
          safe: false,
          knownOver: false,
          startDate: '',
          endDate: ''
        };
      }
      var status = result.judgment;
      if (origin === 'mixed') status = 'undefined';
      else if (!result.complete || (result.noDataDates && result.noDataDates.length) || origin === 'missing') status = 'missing';
      else if (result.hasUndefinedHours) status = 'undefined';
      else if (result.hasUnconfirmed || origin === 'unconfirmed') status = 'unconfirmed';
      var determined = status === 'within' || status === 'approach' || status === 'exceed';
      var total = result.totalHours;
      return {
        status: status,
        label: LABELS[status] || status,
        origin: origin || 'missing',
        totalHours: total,
        remainingHours: determined ? Math.max(0, limit - total) : null,
        overHours: determined ? Math.max(0, total - limit) : null,
        safe: status === 'within',
        knownOver: !!result.knownOver,
        startDate: result.startDate,
        endDate: result.endDate
      };
    }

    function determinedDay(day) {
      return !!(day && !day.noData && !day.hasUnconfirmed && !day.hasUndefinedHours);
    }

    function avoidance(tomorrowSide, todayDay, limit) {
      if (tomorrowSide.status !== 'exceed') {
        return { avoidable: false, reason: tomorrowSide.status === 'within' || tomorrowSide.status === 'approach' ? 'not-exceeding' : ('tomorrow-' + tomorrowSide.status), requiredCutHours: null, residualHours: null };
      }
      if (!determinedDay(todayDay)) {
        return { avoidable: false, reason: 'today-undetermined', requiredCutHours: null, residualHours: null };
      }
      var other = tomorrowSide.totalHours - todayDay.dailyTotalHours;
      if (other > limit + EPS) {
        return { avoidable: false, reason: 'today-shortening-insufficient', requiredCutHours: null, residualHours: other - limit };
      }
      return { avoidable: true, reason: 'today-cut', requiredCutHours: tomorrowSide.totalHours - limit, residualHours: 0 };
    }

    function overrideBlocks(hours) {
      return [{ code: 'SIM', rawCode: 'simulation', source: 'simulation', hours: hours, defined: true }];
    }

    function validOverride(value) {
      return typeof value === 'number' && isFinite(value) && value >= 0;
    }

    function assessDriver(driver, today, tomorrow, limit) {
      var actual = fillActual(driver.actualBlocksByDate, driver.archiveBlocksByDate);
      var roster = driver.rosterBlocksByDate || {};
      var todayStart = rolling.addDays(today, -6);
      var tomorrowStart = rolling.addDays(today, -5);
      var todayBlend = blend(actual, roster, today, todayStart, today);
      var tomorrowBlend = blend(actual, roster, tomorrow, tomorrowStart, tomorrow);
      var todayPack = windowOf(todayBlend.blocksByDate, todayStart, today, limit, {});
      var tomorrowPack = windowOf(tomorrowBlend.blocksByDate, tomorrowStart, tomorrow, limit, {});
      var todaySide = sideFrom(todayPack.window, limit, todayBlend.origins[today]);
      var tomorrowSide = sideFrom(tomorrowPack.window, limit, tomorrowBlend.origins[tomorrow]);
      var todayDay = dayOf(tomorrowPack.series, today);
      var dropped = dayOf(todayPack.series, todayStart);
      var added = dayOf(tomorrowPack.series, tomorrow);
      var plan = avoidance(tomorrowSide, todayDay, limit);
      var simulated = tomorrowSide;
      var simulationStatus = 'baseline';
      if (validOverride(driver.todayHoursOverride)) {
        var overrideMap = {};
        overrideMap[today] = overrideBlocks(driver.todayHoursOverride);
        var overridden = windowOf(tomorrowBlend.blocksByDate, tomorrowStart, tomorrow, limit, overrideMap);
        simulated = sideFrom(overridden.window, limit, 'simulation');
        simulationStatus = 'applied';
      } else if (driver.todayHoursOverride != null && driver.todayHoursOverride !== '') {
        simulationStatus = 'invalid';
      }
      var open = todaySide.status !== 'within' && todaySide.status !== 'approach' && todaySide.status !== 'exceed'
        || tomorrowSide.status !== 'within' && tomorrowSide.status !== 'approach' && tomorrowSide.status !== 'exceed';
      return {
        transportId: driver.transportId || '',
        name: driver.name || '',
        today: todaySide,
        tomorrow: tomorrowSide,
        simulatedTomorrow: simulated,
        simulationStatus: simulationStatus,
        countedTodayHours: determinedDay(todayDay) ? todayDay.dailyTotalHours : null,
        countedTodayOrigin: tomorrowBlend.origins[today] || 'missing',
        todayOrigin: todayBlend.origins[today] || 'missing',
        droppedDate: todayStart,
        droppedHours: dropped && !dropped.noData ? dropped.dailyTotalHours : null,
        addedDate: tomorrow,
        addedHours: added && !added.noData ? added.dailyTotalHours : null,
        avoidable: plan.avoidable,
        avoidReason: plan.reason,
        requiredCutHours: plan.requiredCutHours,
        residualHours: plan.residualHours,
        undetermined: open
      };
    }

    function assess(input) {
      try {
        input = input || {};
        if (!dateOk(input.today) || !Array.isArray(input.drivers)) return failedBoard(input.today);
        var today = input.today;
        var tomorrow = rolling.addDays(today, 1);
        var limit = typeof input.limitHours === 'number' && isFinite(input.limitHours) ? input.limitHours : 60;
        var archive = input.archiveBlocksByTransportId || {};
        var drivers = input.drivers.map(function (driver) {
          var source = driver || {};
          var copy = {
            transportId: source.transportId,
            name: source.name,
            actualBlocksByDate: source.actualBlocksByDate,
            rosterBlocksByDate: source.rosterBlocksByDate,
            archiveBlocksByDate: source.archiveBlocksByDate || archive[source.transportId] || null,
            todayHoursOverride: source.todayHoursOverride
          };
          return assessDriver(copy, today, tomorrow, limit);
        });
        function pick(test) {
          return drivers.filter(test);
        }
        var undetermined = pick(function (row) { return row.undetermined; });
        return {
          ok: true,
          status: drivers.length ? 'ready' : 'empty',
          safe: drivers.length > 0 && undetermined.length === 0 && drivers.every(function (row) {
            return row.today.status === 'within' && row.tomorrow.status === 'within';
          }),
          today: today,
          tomorrow: tomorrow,
          limitHours: limit,
          todayDanger: pick(function (row) { return row.today.status === 'exceed'; }),
          tomorrowDanger: pick(function (row) { return row.tomorrow.status === 'exceed'; }),
          adjustable: pick(function (row) { return row.tomorrow.status === 'exceed' && row.avoidable; }),
          undetermined: undetermined,
          drivers: drivers,
          note: drivers.length ? '' : '対象のDAがありません'
        };
      } catch (err) {
        return failedBoard(input && input.today);
      }
    }

    function speakableName(name) {
      if (typeof name !== 'string') return '氏名未設定';
      var text = name.trim();
      if (!text || text.length > 40 || /[。、\n\r<>]/.test(text)) return '氏名未設定';
      return text;
    }

    function hoursText(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '未取得';
      return (Math.round(value * 10) / 10).toFixed(1) + '時間';
    }

    function rank(status) {
      if (status === 'exceed') return 3;
      if (status === 'approach') return 2;
      if (status === 'within') return 1;
      return 0;
    }

    function fingerprint(row, scope) {
      var side = row[scope];
      return [row.transportId, scope, side.status, side.totalHours, side.overHours, row.avoidable ? 1 : 0, row.requiredCutHours, row.avoidReason].join('|');
    }

    function copyState(previous) {
      var spoken = {};
      var source = previous && previous.spoken ? previous.spoken : {};
      Object.keys(source).forEach(function (key) {
        var item = source[key] || {};
        spoken[key] = { fingerprint: item.fingerprint, status: item.status, overHours: item.overHours };
      });
      return { spoken: spoken };
    }

    function textFor(row, scope, event) {
      var name = speakableName(row.name);
      var side = row[scope];
      if (event === 'resolved') {
        return scope === 'today'
          ? name + 'さんの今日のローリング60時間の警告は解消しました。'
          : name + 'さんの明日のローリング60時間の事前警告は解消しました。';
      }
      if (event === 'unavailable') {
        return scope === 'today'
          ? name + 'さんの今日のローリング60時間は判定できません。安全とは判断できません。'
          : name + 'さんの明日のローリング60時間は判定できません。安全とは判断できません。';
      }
      if (side.status === 'approach') {
        return scope === 'today'
          ? '今日のローリング60時間に接近しています。' + name + 'さんは今日までの7日間で' + hoursText(side.totalHours) + 'です。超過ではありません。'
          : '明日のローリング60時間に接近しています。' + name + 'さんは明日までの7日間で' + hoursText(side.totalHours) + 'です。超過ではありません。';
      }
      if (scope === 'today') {
        return '今日のローリング60時間の緊急警告です。' + name + 'さんは今日までの7日間で' + hoursText(side.totalHours) + '、超過見込みは' + hoursText(side.overHours) + 'です。';
      }
      var text = '明日のローリング60時間の事前警告です。' + name + 'さんは明日までの7日間で' + hoursText(side.totalHours) + '、超過見込みは' + hoursText(side.overHours) + 'です。';
      if (row.avoidable) text += '今日の勤務を' + hoursText(row.requiredCutHours) + '短縮すると回避できます。';
      else if (row.avoidReason === 'today-shortening-insufficient') text += '今日の短縮だけでは回避できません。';
      return text;
    }

    function planSpeech(previous, board) {
      var state = copyState(previous);
      if (!board || board.ok !== true) {
        var failedKey = 'board|failed';
        if (state.spoken[failedKey]) return { speak: [], state: state };
        state.spoken[failedKey] = { fingerprint: 'failed', status: 'failed', overHours: null };
        return {
          speak: [{ id: failedKey, scope: 'board', event: 'unavailable', text: 'ローリング60時間の集計に失敗しました。安全とは判断できません。' }],
          state: state
        };
      }
      var speak = [];
      (board.drivers || []).forEach(function (row) {
        ['today', 'tomorrow'].forEach(function (scope) {
          var side = row[scope];
          var key = row.transportId + '|' + scope;
          var prev = state.spoken[key];
          var nextPrint = fingerprint(row, scope);
          if (prev && prev.fingerprint === nextPrint) return;
          var event = '';
          if (!prev) {
            if (side.status === 'exceed' || side.status === 'approach') event = 'new';
            else if (side.status !== 'within') event = 'unavailable';
          } else if (rank(side.status) === 0 && rank(prev.status) >= 2) {
            event = 'unavailable';
          } else if (side.status === 'within' && rank(prev.status) >= 2) {
            event = 'resolved';
          } else if (rank(prev.status) === 0 && (side.status === 'exceed' || side.status === 'approach')) {
            event = 'new';
          } else if (rank(side.status) > rank(prev.status) && rank(side.status) >= 2) {
            event = 'severity-up';
          } else if (side.status === 'exceed' && prev.status === 'exceed' && side.overHours > prev.overHours + EPS) {
            event = 'severity-up';
          }
          if (!event) return;
          state.spoken[key] = { fingerprint: nextPrint, status: side.status, overHours: side.overHours };
          speak.push({ id: key, scope: scope, event: event, transportId: row.transportId, text: textFor(row, scope, event) });
        });
      });
      return { speak: speak, state: state };
    }

    function deliver(previous, board, speakFn) {
      var plan = planSpeech(previous, board);
      var kept = copyState(previous);
      if (!plan.speak.length) return Promise.resolve({ speak: [], state: plan.state, spoken: true, reason: 'unchanged' });
      if (typeof speakFn !== 'function') {
        return Promise.resolve({ speak: plan.speak, state: kept, spoken: false, reason: 'speech-unavailable' });
      }
      return Promise.resolve().then(function () {
        return speakFn(plan.speak);
      }).then(function (ok) {
        if (ok !== true) return { speak: plan.speak, state: kept, spoken: false, reason: 'not-spoken' };
        return { speak: plan.speak, state: plan.state, spoken: true, reason: 'spoken' };
      }, function () {
        return { speak: plan.speak, state: kept, spoken: false, reason: 'not-spoken' };
      });
    }

    function fridayPayload(board, checkedAt) {
      var today = board && board.today ? board.today : '';
      if (!board || board.ok !== true) {
        return {
          ok: false,
          app: 'harvest-rolling60h',
          connected: false,
          fetchStatus: '',
          stale: true,
          checkedAt: checkedAt || null,
          approachRule: '',
          referenceDate: today,
          alerts: [{
            id: 'rolling60h|unavailable|insufficient',
            category: 'insufficient',
            driver: '対象者',
            period: '',
            startDate: '',
            endDate: '',
            reason: 'データ未取得',
            disposition: 'insufficient'
          }]
        };
      }
      var alerts = [];
      (board.drivers || []).forEach(function (row) {
        ['today', 'tomorrow'].forEach(function (scope) {
          var side = row[scope];
          if (!side || side.status === 'within') return;
          var category = side.status === 'exceed' ? 'forecast_exceed'
            : side.status === 'approach' ? 'approach'
            : side.status === 'unconfirmed' ? 'duty_unconfirmed'
            : 'insufficient';
          var item = {
            id: ['rolling60h', row.transportId || 'unknown', side.startDate, side.endDate, category].join('|'),
            category: category,
            driver: row.name || '氏名未設定',
            period: side.startDate && side.endDate ? side.startDate + ' 〜 ' + side.endDate : '',
            startDate: side.startDate || '',
            endDate: side.endDate || '',
            reason: side.label,
            disposition: side.status,
            scope: scope,
            origin: side.origin || 'missing'
          };
          if (category === 'forecast_exceed' || category === 'approach') item.forecastHours = side.totalHours;
          if (scope === 'tomorrow') {
            item.avoidable = row.avoidable === true;
            item.requiredCutHours = row.requiredCutHours;
            item.avoidReason = row.avoidReason || '';
          }
          item.text = textFor(row, scope, category === 'insufficient' || category === 'duty_unconfirmed' ? 'unavailable' : 'new');
          alerts.push(item);
        });
      });
      return {
        ok: true,
        app: 'harvest-rolling60h',
        connected: true,
        fetchStatus: board.safe ? 'success' : 'partial',
        stale: false,
        checkedAt: checkedAt || null,
        approachRule: '',
        referenceDate: today,
        alerts: alerts
      };
    }

    return { assess: assess, planSpeech: planSpeech, deliver: deliver, fridayPayload: fridayPayload, labels: LABELS };
  }

  return { bindCore: bindCore, labels: LABELS };
});
