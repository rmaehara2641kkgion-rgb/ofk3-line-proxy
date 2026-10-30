/**
 * ENOU が保管した風神の3系統照合を台数カードへ映す。
 * 通知は送らない。null は 0 台にしない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InoichiFujinCapacity = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONTRACT = 'fujin-capacity-three-source/1';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function countText(value) {
    if (value == null || value === '') return '未取得';
    return String(value);
  }

  function present(input) {
    var data = input && input.data ? input.data : input;
    var base = { contract: CONTRACT, notificationsSent: false, executedAt: null, rows: [] };
    if (!data || data.contract !== CONTRACT || !Array.isArray(data.rows)) {
      return Object.assign({}, base, { state: 'missing', label: '未取得' });
    }
    return Object.assign({}, base, {
      state: 'ready',
      label: '風神の照合',
      executedAt: data.executedAt || null,
      serviceDate: data.serviceDate || null,
      rows: data.rows.map(function (row) {
        var reservation = row.reservation || {};
        var scheduling = row.scheduling || {};
        var inputFile = row.inputFile || {};
        return {
          serviceDate: row.serviceDate || null,
          cycle: row.cycle || null,
          serviceType: row.serviceType || null,
          block: row.block || null,
          reservationQuantity: reservation.quantity == null ? null : reservation.quantity,
          assignedQuantity: reservation.assignedQuantity == null ? null : reservation.assignedQuantity,
          schedulingQuantity: scheduling.reservationQuantity == null ? null : scheduling.reservationQuantity,
          inputQuantity: inputFile.quantity == null ? null : inputFile.quantity,
          delta: row.delta == null ? null : row.delta,
          judgment: row.judgment || 'UNCONFIRMED',
          label: row.label || '未確認',
        };
      }),
    });
  }

  function render(model) {
    var view = model && model.state && model.notificationsSent === false ? model : present(model);
    var html = '<section id="ino-fujin-capacity" data-ino-fujin-state="' + escapeHtml(view.state) + '">';
    html += '<h3>風神の3系統照合</h3>';
    html += '<p>通知は送っていません。</p>';
    if (!view.rows.length) {
      html += '<p>風神の照合結果は未取得です。</p>';
    } else {
      html += '<p>照合実行 ' + escapeHtml(view.executedAt || '未取得') + '</p>';
      html += '<table><thead><tr><th>日付</th><th>サイクル</th><th>サービス</th><th>時間</th><th>予約</th><th>割当</th><th>Scheduling</th><th>InputFile</th><th>差分</th><th>判定</th></tr></thead><tbody>';
      view.rows.forEach(function (row) {
        html += '<tr data-ino-fujin-judgment="' + escapeHtml(row.judgment) + '">';
        html += '<td>' + escapeHtml(row.serviceDate || '未確認') + '</td>';
        html += '<td>' + escapeHtml(row.cycle || '未確認') + '</td>';
        html += '<td>' + escapeHtml(row.serviceType || '未確認') + '</td>';
        html += '<td>' + escapeHtml(row.block || '—') + '</td>';
        html += '<td>' + escapeHtml(countText(row.reservationQuantity)) + '</td>';
        html += '<td>' + escapeHtml(countText(row.assignedQuantity)) + '</td>';
        html += '<td>' + escapeHtml(countText(row.schedulingQuantity)) + '</td>';
        html += '<td>' + escapeHtml(countText(row.inputQuantity)) + '</td>';
        html += '<td>' + escapeHtml(row.delta == null ? '未取得' : (row.delta === 0 ? '±0' : String(row.delta))) + '</td>';
        html += '<td>' + escapeHtml(row.label) + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '<p><button type="button" id="ino-fujin-read" onclick="InoichiFujinCapacity.reload()">風神の照合を読む</button></p>';
    html += '</section>';
    return html;
  }

  function reload(options) {
    options = options || {};
    var stored = {};
    try {
      stored = JSON.parse(localStorage.getItem('ino.capacity.settings') || '{}');
    } catch (err) {
      stored = {};
    }
    var base = options.baseUrl || stored.baseUrl || 'http://127.0.0.1:3018';
    var station = options.station || stored.station || 'OFK3';
    var serviceDate = options.serviceDate || stored.serviceDate || '';
    var query = '?station=' + encodeURIComponent(station);
    if (serviceDate) query += '&service_date=' + encodeURIComponent(serviceDate);
    var host = typeof document !== 'undefined' ? document.getElementById('ino-fujin-capacity') : null;
    return fetch(base + '/api/v1/capacity/fujin' + query, { credentials: 'include' }).then(function (response) {
      return response.json().then(function (body) {
        var model = response.status === 200 ? present(body.data || body) : present(null);
        if (host) host.outerHTML = render(model);
        return model;
      });
    }).catch(function () {
      var model = present(null);
      if (host) host.outerHTML = render(model);
      return model;
    });
  }

  return { CONTRACT: CONTRACT, present: present, render: render, reload: reload };
}));
