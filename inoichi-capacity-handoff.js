/**
 * ENOU GET /api/v1/capacity/handoff を台数照合カードへ映す。
 * 接続失敗と未取得は 0 台にしない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InoichiCapacityHandoff = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function countText(value) {
    if (value == null) return '未取得';
    return String(value);
  }

  function lineDelta(plan, inputFile) {
    if (plan == null || inputFile == null) return null;
    return inputFile - plan;
  }

  function screenStatus(acquire) {
    var data = acquire && acquire.data ? acquire.data : acquire;
    var targets = data && Array.isArray(data.targets) ? data.targets : [];
    var observed = data && Array.isArray(data.observed) ? data.observed : (data && Array.isArray(data.observations) ? data.observations : []);
    var confirmed = targets.length > 0 && targets.every(function (target) { return target.confirmation === 'CONFIRMED'; });
    return {
      confirmation: confirmed && data.liveAcquireEnabled === true ? 'CONFIRMED' : 'SCREEN_UNCONFIRMED',
      liveAcquireEnabled: Boolean(data && data.liveAcquireEnabled) && confirmed,
      targets: targets.map(function (target) {
        return {
          id: target.id,
          label: target.label || target.id,
          confirmation: target.confirmation || 'SCREEN_UNCONFIRMED',
          counts: null
        };
      }),
      observed: observed.map(function (item) {
        return { path: item.path || '', status: item.status || 'SCREEN_UNCONFIRMED' };
      })
    };
  }

  function rankLabel(rank) {
    if (rank === 1) return '期限';
    if (rank === 2) return '不一致';
    if (rank === 3) return '未取得';
    if (rank === 4) return '判定不能';
    if (rank === 5) return '一致';
    return '未取得';
  }

  function present(input) {
    if (input == null) {
      return {
        state: 'not_loaded',
        label: '未接続',
        serviceDate: null,
        lines: [],
        acquiredAt: null,
        origins: []
      };
    }
    if (input.connectionFailed || input.httpStatus === 0) {
      return {
        state: 'connection_failed',
        label: '接続失敗',
        serviceDate: input.serviceDate || null,
        lines: [],
        acquiredAt: null,
        origins: [],
        windowDays: [],
        changes: null
      };
    }
    if (input.httpStatus === 401 || input.httpStatus === 403 || input.ok === false) {
      var auth = input.httpStatus === 401 || input.httpStatus === 403;
      return {
        state: auth ? 'auth_required' : 'connection_failed',
        label: auth ? '認証が必要' : '接続失敗',
        serviceDate: input.serviceDate || null,
        lines: [],
        acquiredAt: null,
        origins: [],
        windowDays: [],
        changes: null
      };
    }
    var data = input.data && input.data.lines ? input.data : input;
    if (!data || !Array.isArray(data.lines)) {
      return {
        state: 'not_loaded',
        label: '未接続',
        serviceDate: null,
        lines: [],
        acquiredAt: null,
        origins: []
      };
    }
    var sources = data.sources || {};
    var origins = [];
    Object.keys(sources).forEach(function (key) {
      var source = sources[key] || {};
      origins.push({
        source: key,
        state: source.state || 'not_collected',
        origin: source.origin || null,
        acquiredAt: source.acquiredAt || null
      });
    });
    return {
      state: 'loaded',
      label: data.overall && data.overall.label ? data.overall.label : '未確認',
      serviceDate: data.serviceDate || null,
      acquiredAt: data.dataUpdatedAt || data.reconciledAt || null,
      screen: screenStatus(input.acquire || data.screenBinding),
      origins: origins,
      windowDays: input.window && Array.isArray(input.window.dates) ? input.window.dates : [],
      priority: input.window && Array.isArray(input.window.priority) ? input.window.priority : [],
      changes: input.changes || null,
      reservationSummary: data.reservationSummary || { present: false, realData: false, groups: null },
      lines: data.lines.filter(function (line) { return !line.rollup; }).map(function (line) {
        return {
          serviceDate: line.serviceDate || data.serviceDate || null,
          cycleId: line.cycleId || null,
          serviceTypeName: line.serviceTypeName || null,
          serviceTime: line.serviceTime || null,
          plan: line.routeTarget == null ? null : line.routeTarget,
          reservation: line.effectiveReservationQuantity == null ? null : line.effectiveReservationQuantity,
          assignments: line.assignedCount == null ? null : line.assignedCount,
          inputFile: line.inputQuantity == null ? null : line.inputQuantity,
          judgment: line.label || line.judgment || '未確認',
          delta: lineDelta(line.routeTarget, line.inputQuantity)
        };
      })
    };
  }

  function storedSettings() {
    if (typeof localStorage === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem('ino.capacity.settings') || '{}'); } catch (e) { return {}; }
  }

  function settingsForm(model) {
    var stored = storedSettings();
    var base = stored.baseUrl || 'http://127.0.0.1:3018';
    var date = (model && model.serviceDate) || stored.serviceDate || '';
    return '<p><label>ENOU <input id="ino-capacity-base" value="' + escapeHtml(base) + '"></label> '
      + '<label>対象日 <input id="ino-capacity-date" value="' + escapeHtml(date) + '" placeholder="YYYY-MM-DD"></label> '
      + '<button type="button" id="ino-capacity-read" onclick="InoichiCapacityHandoff.reload()">ENOUから読む</button></p>';
  }

  var shown = null;

  function render(input) {
    var model = input && input.state ? input : present(input);
    if (input == null && shown) model = shown;
    else if (model.state !== 'not_loaded') shown = model;
    var html = '<div id="ino-capacity-handoff" data-ino-capacity-state="' + escapeHtml(model.state) + '">';
    html += '<h3 class="ino-card-title">ENOU台数照合</h3>';
    html += settingsForm(model);
    if (model.state === 'connection_failed') {
      html += '<p data-ino-capacity-label="接続失敗">接続失敗。届いていない台数は0台にしません。</p></div>';
      return html;
    }
    if (model.state === 'auth_required') {
      html += '<p data-ino-capacity-label="認証が必要">認証が必要です。届いていない台数は0台にしません。</p></div>';
      return html;
    }
    if (model.state !== 'loaded') {
      html += '<p data-ino-capacity-label="未接続">ENOUの照合結果はまだ読み込んでいません。</p></div>';
      return html;
    }
    html += screenText(model.screen);
    html += '<p>対象日 ' + escapeHtml(model.serviceDate || '未確認') + ' / 判定 ' + escapeHtml(model.label) + '</p>';
    html += '<p>最終取得 ' + escapeHtml(model.acquiredAt || '未取得') + '</p>';
    html += lineTable(model.lines);
    html += reservationText(model.reservationSummary);
    (model.origins || []).forEach(function (source) {
      html += '<p>取得元 ' + escapeHtml(source.source) + ' / ' + escapeHtml(source.origin || source.state) + ' / ' + escapeHtml(source.acquiredAt || '未取得') + '</p>';
    });
    html += changeText(model.changes);
    html += windowTable(model);
    html += '</div>';
    return html;
  }

  function screenText(screen) {
    var status = screen && screen.confirmation ? screen.confirmation : 'SCREEN_UNCONFIRMED';
    var html = '<p data-ino-capacity-screen="' + escapeHtml(status) + '">Amazon画面対応 ' + escapeHtml(status) + '。実画面からの取得は無効です。</p>';
    (screen && screen.targets || []).forEach(function (target) {
      html += '<p>' + escapeHtml(target.label) + ' / ' + escapeHtml(target.confirmation) + ' / 件数 未取得</p>';
    });
    (screen && screen.observed || []).forEach(function (item) {
      html += '<p>' + escapeHtml(item.status) + ' ' + escapeHtml(item.path) + '</p>';
    });
    return html;
  }

  function metricText(metric) {
    if (!metric || metric.state !== 'numeric' || metric.value == null) return '未取得';
    return String(metric.value);
  }

  function reservationText(summary) {
    if (!summary || summary.present !== true || summary.realData !== true) {
      return '<p data-ino-capacity-reservation="未取得">予約JSON 未取得。台数は0にしていません。</p>';
    }
    if (summary.readable === false) {
      return '<p data-ino-capacity-reservation="読めない">予約JSONを読めません。台数は0にしていません。</p>';
    }
    if (summary.shape === 'assignment_records') {
      var assignedHtml = '<p data-ino-capacity-reservation="予約台数未取得">予約JSONは読めました。quantity と assignedQuantity は含まれていません。行数は台数にしていません。</p>';
      assignedHtml += '<table><thead><tr><th>配送日</th><th>サイクル</th><th>分数</th><th>区分</th><th>行数</th><th>quantity</th><th>assignedQuantity</th></tr></thead><tbody>';
      (summary.observedRecords || []).forEach(function (group) {
        assignedHtml += '<tr><td>' + escapeHtml(group.serviceDate || '未取得') + '</td>';
        assignedHtml += '<td>' + escapeHtml(group.waveGroupId || '未取得') + '</td>';
        assignedHtml += '<td>' + escapeHtml(group.durationMinutes == null ? '未取得' : String(group.durationMinutes)) + '</td>';
        assignedHtml += '<td>' + escapeHtml(group.serviceTypeLabel || '未確認') + '</td>';
        assignedHtml += '<td>' + escapeHtml(group.recordCount == null ? '未取得' : String(group.recordCount)) + '</td>';
        assignedHtml += '<td>' + escapeHtml(metricText(group.quantity)) + '</td>';
        assignedHtml += '<td>' + escapeHtml(metricText(group.assignedQuantity)) + '</td></tr>';
      });
      assignedHtml += '</tbody></table>';
      (summary.issues || []).forEach(function (issue) {
        assignedHtml += '<p>診断 ' + escapeHtml(issue.code) + '</p>';
      });
      return assignedHtml;
    }
    var html = '<p data-ino-capacity-reservation="取得済">予約JSON。quantity と assignedQuantity は別の値です。</p>';
    if (!summary.groups || !summary.groups.length) {
      html += '<p>この配送日の有効予約行はありません。</p>';
    }
    html += '<table><thead><tr><th>配送日</th><th>サイクル</th><th>分数</th><th>serviceTypeId</th><th>区分</th><th>quantity</th><th>assignedQuantity</th><th>件数</th></tr></thead><tbody>';
    (summary.groups || []).forEach(function (group) {
      html += '<tr><td>' + escapeHtml(group.serviceDate || '未取得') + '</td>';
      html += '<td>' + escapeHtml(group.waveGroupId || '未取得') + '</td>';
      html += '<td>' + escapeHtml(group.durationMinutes == null ? '未取得' : String(group.durationMinutes)) + '</td>';
      html += '<td>' + escapeHtml(group.serviceTypeId || '未取得') + '</td>';
      html += '<td>' + escapeHtml(group.frame === 'special' ? '特別' : '通常') + '</td>';
      html += '<td>' + escapeHtml(metricText(group.quantity)) + '</td>';
      html += '<td>' + escapeHtml(metricText(group.assignedQuantity)) + '</td>';
      html += '<td>' + escapeHtml(String(group.reservationCount || 0)) + '</td></tr>';
    });
    html += '</tbody></table>';
    if (summary.historical && summary.historical.length) html += '<p>取消は有効台数に含めていません。</p>';
    (summary.issues || []).forEach(function (issue) {
      html += '<p>診断 ' + escapeHtml(issue.code) + '</p>';
    });
    return html;
  }

  function lineTable(lines) {
    var html = '<table><thead><tr><th>対象日</th><th>サイクル</th><th>種別</th><th>時間</th><th>Amazon計画</th><th>予約</th><th>DA割当</th><th>InputFile</th><th>差分</th><th>判定</th></tr></thead><tbody>';
    (lines || []).forEach(function (line) {
      html += '<tr><td>' + escapeHtml(line.serviceDate || '未確認') + '</td>';
      html += '<td>' + escapeHtml(line.cycleId || '未確認') + '</td>';
      html += '<td>' + escapeHtml(line.serviceTypeName || '未確認') + '</td>';
      html += '<td>' + escapeHtml(line.serviceTime || '未確認') + '</td>';
      html += '<td>' + escapeHtml(countText(line.plan)) + '</td>';
      html += '<td>' + escapeHtml(countText(line.reservation)) + '</td>';
      html += '<td>' + escapeHtml(countText(line.assignments)) + '</td>';
      html += '<td>' + escapeHtml(countText(line.inputFile)) + '</td>';
      html += '<td>' + escapeHtml(countText(line.delta)) + '</td>';
      html += '<td>' + escapeHtml(line.judgment) + '</td></tr>';
    });
    return html + '</tbody></table>';
  }

  function changeText(changes) {
    if (!changes || !changes.sources) return '<p>前回比 未取得</p>';
    var parts = [];
    Object.keys(changes.sources).forEach(function (key) {
      var source = changes.sources[key];
      if (!source || source.compared !== true) {
        parts.push(key + ' 前回なし');
        return;
      }
      if (!source.changed) {
        parts.push(key + ' 変更なし');
        return;
      }
      (source.deltas || []).forEach(function (delta) {
        var diff = delta.delta == null ? '未取得' : String(delta.delta);
        parts.push(key + ' ' + (delta.serviceTime || '') + ' ' + diff);
      });
    });
    return '<p>前回比 ' + escapeHtml(parts.join(' / ')) + '</p>';
  }

  function windowTable(model) {
    var days = (model.windowDays || []).slice().sort(function (left, right) {
      var rank = (left.attentionRank || 9) - (right.attentionRank || 9);
      if (rank) return rank;
      var tie = (left.attentionTie || 9) - (right.attentionTie || 9);
      if (tie) return tie;
      return String(left.serviceDate || '').localeCompare(String(right.serviceDate || ''));
    });
    if (!days.length) return '';
    var priority = {};
    (model.priority || []).forEach(function (date) { priority[date] = true; });
    var html = '<table><thead><tr><th>日付</th><th>計画</th><th>予約</th><th>DA割当</th><th>InputFile</th><th>差分</th><th>判定</th><th>優先</th><th>期限</th></tr></thead><tbody>';
    days.forEach(function (day) {
      var counts = day.counts || {};
      var deadline = day.daDeadlineOpen ? '締切前' : '締切後';
      if (day.capacityChangeFocus) deadline += ' / 14日前の目安';
      if (priority[day.serviceDate]) deadline += ' / 優先';
      html += '<tr data-ino-capacity-day="' + escapeHtml(day.serviceDate) + '">';
      html += '<td>' + escapeHtml(day.serviceDate) + '</td>';
      html += '<td>' + escapeHtml(countText(counts.plan)) + '</td>';
      html += '<td>' + escapeHtml(countText(counts.reservation)) + '</td>';
      html += '<td>' + escapeHtml(countText(counts.assignments)) + '</td>';
      html += '<td>' + escapeHtml(countText(counts.inputFile)) + '</td>';
      html += '<td>' + escapeHtml(countText(lineDelta(counts.plan, counts.inputFile))) + '</td>';
      html += '<td>' + escapeHtml(day.overall && day.overall.label ? day.overall.label : '未取得') + '</td>';
      html += '<td>' + escapeHtml(rankLabel(day.attentionRank)) + '</td>';
      html += '<td>' + escapeHtml(deadline) + '</td></tr>';
    });
    return html + '</tbody></table>';
  }

  function todayJst() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  function reload(options) {
    options = options || {};
    var stored = storedSettings();
    var baseEl = typeof document !== 'undefined' ? document.getElementById('ino-capacity-base') : null;
    var dateEl = typeof document !== 'undefined' ? document.getElementById('ino-capacity-date') : null;
    var base = options.baseUrl || (baseEl && baseEl.value) || stored.baseUrl || 'http://127.0.0.1:3018';
    var station = options.station || 'OFK3';
    var serviceDate = options.serviceDate || (dateEl && dateEl.value) || stored.serviceDate || todayJst();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('ino.capacity.settings', JSON.stringify({ baseUrl: base, serviceDate: serviceDate, station: station }));
    }
    var query = '?station=' + encodeURIComponent(station) + '&service_date=' + encodeURIComponent(serviceDate);
    var host = typeof document !== 'undefined' ? document.getElementById('ino-capacity-handoff') : null;
    function paint(model) {
      if (host) host.outerHTML = render(model);
      return model;
    }
    return Promise.all([
      fetch(base + '/api/v1/capacity/handoff' + query, { credentials: 'include' }),
      fetch(base + '/api/v1/capacity/window' + '?station=' + encodeURIComponent(station) + '&anchor=' + encodeURIComponent(serviceDate), { credentials: 'include' }),
      fetch(base + '/api/v1/capacity/changes' + query, { credentials: 'include' }),
      fetch(base + '/api/v1/capacity/acquire', { credentials: 'include' })
    ]).then(function (responses) {
      return Promise.all(responses.map(function (response) {
        return response.json().then(function (body) {
          return { httpStatus: response.status, body: body };
        }).catch(function () {
          return { httpStatus: response.status, body: null };
        });
      }));
    }).then(function (parts) {
      var handoff = parts[0];
      if (!handoff || handoff.httpStatus !== 200 || !handoff.body) {
        return paint(present({ httpStatus: handoff ? handoff.httpStatus : 0, serviceDate: serviceDate }));
      }
      var windowBody = parts[1] && parts[1].httpStatus === 200 ? parts[1].body : null;
      var changeBody = parts[2] && parts[2].httpStatus === 200 ? parts[2].body : null;
      var acquireBody = parts[3] && parts[3].httpStatus === 200 ? parts[3].body : null;
      return paint(present({
        httpStatus: 200,
        data: handoff.body.data || handoff.body,
        window: windowBody && (windowBody.data || windowBody),
        changes: changeBody && (changeBody.data || changeBody),
        acquire: acquireBody && (acquireBody.data || acquireBody),
        serviceDate: serviceDate
      }));
    }).catch(function () {
      return paint(present({ connectionFailed: true, serviceDate: serviceDate }));
    });
  }

  return { present: present, render: render, reload: reload };
}));
