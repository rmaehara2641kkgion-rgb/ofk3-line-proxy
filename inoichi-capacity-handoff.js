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
    if (input.connectionFailed || input.ok === false) {
      return {
        state: 'connection_failed',
        label: '接続失敗',
        serviceDate: null,
        lines: [],
        acquiredAt: null,
        origins: []
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
      origins: origins,
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
          judgment: line.label || line.judgment || '未確認'
        };
      })
    };
  }

  function render(input) {
    var model = input && input.state ? input : present(input);
    var html = '<div id="ino-capacity-handoff" data-ino-capacity-state="' + escapeHtml(model.state) + '">';
    html += '<h3 class="ino-card-title">ENOU台数照合</h3>';
    if (model.state === 'connection_failed') {
      html += '<p data-ino-capacity-label="接続失敗">接続失敗。届いていない台数は0台にしません。</p>';
      html += '</div>';
      return html;
    }
    if (model.state !== 'loaded') {
      html += '<p data-ino-capacity-label="未接続">ENOUの照合結果はまだ読み込んでいません。</p>';
      html += '<button type="button" onclick="InoichiCapacityHandoff.reload()">ENOUから読む</button>';
      html += '</div>';
      return html;
    }
    html += '<p>対象日 ' + escapeHtml(model.serviceDate || '未確認') + ' / 判定 ' + escapeHtml(model.label) + '</p>';
    html += '<p>最終取得 ' + escapeHtml(model.acquiredAt || '未取得') + '</p>';
    html += '<table><thead><tr><th>対象日</th><th>サイクル</th><th>種別</th><th>時間</th><th>Amazon計画</th><th>予約</th><th>DA割当</th><th>InputFile</th><th>判定</th></tr></thead><tbody>';
    model.lines.forEach(function (line) {
      html += '<tr><td>' + escapeHtml(line.serviceDate || '未確認') + '</td>';
      html += '<td>' + escapeHtml(line.cycleId || '未確認') + '</td>';
      html += '<td>' + escapeHtml(line.serviceTypeName || '未確認') + '</td>';
      html += '<td>' + escapeHtml(line.serviceTime || '未確認') + '</td>';
      html += '<td>' + escapeHtml(countText(line.plan)) + '</td>';
      html += '<td>' + escapeHtml(countText(line.reservation)) + '</td>';
      html += '<td>' + escapeHtml(countText(line.assignments)) + '</td>';
      html += '<td>' + escapeHtml(countText(line.inputFile)) + '</td>';
      html += '<td>' + escapeHtml(line.judgment) + '</td></tr>';
    });
    html += '</tbody></table>';
    model.origins.forEach(function (source) {
      html += '<p>取得元 ' + escapeHtml(source.source) + ' / ' + escapeHtml(source.origin || source.state) + ' / ' + escapeHtml(source.acquiredAt || '未取得') + '</p>';
    });
    html += '</div>';
    return html;
  }

  function reload(options) {
    options = options || {};
    var base = options.baseUrl || 'http://127.0.0.1:3000';
    var station = options.station || 'OFK3';
    var serviceDate = options.serviceDate || '';
    var url = base + '/api/v1/capacity/handoff?station=' + encodeURIComponent(station) + '&service_date=' + encodeURIComponent(serviceDate);
    var host = typeof document !== 'undefined' ? document.getElementById('ino-capacity-handoff') : null;
    return fetch(url, { credentials: 'include' }).then(function (response) {
      if (!response.ok) throw new Error('handoff failed');
      return response.json();
    }).then(function (body) {
      var html = render(present(body));
      if (host) host.outerHTML = html;
      return present(body);
    }).catch(function () {
      var failed = present({ connectionFailed: true, serviceDate: serviceDate });
      if (host) host.outerHTML = render(failed);
      return failed;
    });
  }

  return { present: present, render: render, reload: reload };
}));
