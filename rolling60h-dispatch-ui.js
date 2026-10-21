/**
 * 配車調整ダッシュボード。判定は RollingDispatch.assess の結果だけを表示する。
 * 仮の今日の時間は画面内だけで、原本と正式シフトには書かない。
 */
(function (root) {
  'use strict';
  if (!root) return;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function originLabel(origin) {
    if (origin === 'actual') return '実績';
    if (origin === 'roster') return '予定';
    if (origin === 'unconfirmed') return '未確定';
    if (origin === 'rest') return '休み';
    return '未取得';
  }

  function fmt(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    return (Math.round(value * 10) / 10).toFixed(1);
  }

  function applyOverrides(model) {
    var overrides = model.overrides || {};
    return {
      today: model.today,
      limitHours: model.limitHours,
      rolling: root.RollingCore,
      drivers: (model.drivers || []).map(function (driver) {
        var copy = {
          transportId: driver.transportId,
          name: driver.name,
          actualBlocksByDate: driver.actualBlocksByDate,
          rosterBlocksByDate: driver.rosterBlocksByDate
        };
        var raw = overrides[driver.transportId];
        if (raw != null && raw !== '') {
          var hours = Number(raw);
          copy.todayHoursOverride = hours;
        }
        return copy;
      })
    };
  }

  function currentBoard(model) {
    if (!root.RollingDispatch || typeof root.RollingDispatch.assess !== 'function') return null;
    return root.RollingDispatch.assess(applyOverrides(model));
  }

  function names(rows) {
    if (!rows || !rows.length) return '該当なし';
    return rows.map(function (row) { return row.name || row.transportId || '氏名未設定'; }).join('、');
  }

  function avoidText(row) {
    if (row.tomorrow.status !== 'exceed') return '超過なし';
    if (row.avoidable) return '今日を' + fmt(row.requiredCutHours) + 'h短縮で回避';
    if (row.avoidReason === 'today-shortening-insufficient') return '今日の短縮だけでは回避できない';
    return '判定できない';
  }

  function paint(host, board) {
    var drivers = board && board.drivers ? board.drivers : [];
    var rows = drivers.map(function (row) {
      return '<tr data-driver="' + escapeHtml(row.transportId) + '">' +
        '<td>' + escapeHtml(row.name || row.transportId || '氏名未設定') + '</td>' +
        '<td class="dispatch-today-total">' + escapeHtml(originLabel(row.today.origin) + ' ' + row.today.label) + ' ' + fmt(row.today.totalHours) + '</td>' +
        '<td class="dispatch-tomorrow-total">' + escapeHtml(originLabel(row.tomorrow.origin) + ' ' + row.tomorrow.label) + ' ' + fmt(row.tomorrow.totalHours) + '</td>' +
        '<td class="dispatch-remaining">今日 ' + fmt(row.today.remainingHours) + ' / 明日 ' + fmt(row.tomorrow.remainingHours) + '</td>' +
        '<td class="dispatch-over">今日 ' + fmt(row.today.overHours) + ' / 明日 ' + fmt(row.tomorrow.overHours) + '</td>' +
        '<td><input data-driver="' + escapeHtml(row.transportId) + '" class="dispatch-hours" type="number" min="0" step="0.5" aria-label="仮の今日の勤務時間"></td>' +
        '<td class="dispatch-sim">' + escapeHtml(row.simulatedTomorrow.label) + ' ' + fmt(row.simulatedTomorrow.totalHours) + '</td>' +
        '<td class="dispatch-cut">' + fmt(row.requiredCutHours) + '</td>' +
        '<td class="dispatch-avoid">' + escapeHtml(avoidText(row)) + '</td>' +
        '</tr>';
    }).join('');
    var note = board && board.ok === false
      ? '集計失敗。安全とは判断できません。'
      : '仮変更は原本と正式シフトには反映しません。データ未取得と予定未確定は安全ではありません。';
    host.innerHTML =
      '<section id="rolling-dispatch-panel">' +
      '<h3>今日と明日の配車調整</h3>' +
      '<p id="rolling-dispatch-note">' + escapeHtml(note) + (board && board.note ? ' ' + escapeHtml(board.note) : '') + '</p>' +
      '<p>今日の危険者 <span id="rolling-dispatch-today-list">' + escapeHtml(names(board && board.todayDanger)) + '</span></p>' +
      '<p>明日の危険者 <span id="rolling-dispatch-tomorrow-list">' + escapeHtml(names(board && board.tomorrowDanger)) + '</span></p>' +
      '<p>今日の調整で回避できる人 <span id="rolling-dispatch-adjust-list">' + escapeHtml(names(board && board.adjustable)) + '</span></p>' +
      '<p>判定できない人 <span id="rolling-dispatch-open-list">' + escapeHtml(names(board && board.undetermined)) + '</span></p>' +
      '<table><thead><tr>' +
      '<th>DA</th><th>今日の予測</th><th>明日の予測</th><th>60hまでの残り</th><th>超過見込み</th>' +
      '<th>仮の今日の時間</th><th>短縮後の明日</th><th>必要な短縮</th><th>回避</th>' +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="9">対象のDAがありません</td></tr>') + '</tbody></table>' +
      '<button type="button" id="rolling-dispatch-speak">警告を読み上げ</button>' +
      '<p id="rolling-dispatch-speech-status"></p>' +
      '</section>';
    var overrides = host._model && host._model.overrides ? host._model.overrides : {};
    var inputs = host.querySelectorAll('.dispatch-hours');
    Array.prototype.forEach.call(inputs, function (input) {
      var id = input.getAttribute('data-driver');
      if (overrides[id] != null && overrides[id] !== '') input.value = overrides[id];
    });
  }

  function refreshRow(host, row) {
    var found = null;
    Array.prototype.forEach.call(host.querySelectorAll('tr[data-driver]'), function (tr) {
      if (tr.getAttribute('data-driver') === row.transportId) found = tr;
    });
    if (!found) return;
    found.querySelector('.dispatch-sim').textContent = row.simulatedTomorrow.label + ' ' + fmt(row.simulatedTomorrow.totalHours);
    found.querySelector('.dispatch-cut').textContent = fmt(row.requiredCutHours);
    found.querySelector('.dispatch-avoid').textContent = avoidText(row);
  }

  function mount(host, model) {
    if (!host) return;
    host._model = model || { drivers: [], overrides: {} };
    if (!host._model.overrides) host._model.overrides = {};
    if (host.getAttribute('data-bound') !== '1') {
      host.setAttribute('data-bound', '1');
      host.addEventListener('input', function (event) {
        var input = event.target;
        if (!input || !input.getAttribute || !input.getAttribute('data-driver')) return;
        var id = input.getAttribute('data-driver');
        host._model.overrides[id] = input.value;
        var board = currentBoard(host._model);
        if (!board) return;
        board.drivers.forEach(function (row) {
          if (row.transportId === id) refreshRow(host, row);
        });
      });
      host.addEventListener('click', function (event) {
        if (!event.target || event.target.id !== 'rolling-dispatch-speak') return;
        var board = currentBoard(host._model);
        var status = host.querySelector('#rolling-dispatch-speech-status');
        if (!root.RollingDispatch || typeof root.RollingDispatch.deliver !== 'function') {
          if (status) status.textContent = '集計失敗。安全とは判断できません。';
          return;
        }
        root.RollingDispatch.deliver(host._spoken, board, function (items) {
          if (!root.RollingDispatchSpeech || typeof root.RollingDispatchSpeech.speak !== 'function') return false;
          return root.RollingDispatchSpeech.speak(items);
        }).then(function (result) {
          host._spoken = result.state;
          if (!status) return;
          if (result.reason === 'speech-unavailable') status.textContent = 'FRIDAYの読み上げ機能が未接続です。';
          else if (result.reason === 'unchanged') status.textContent = '新しい警告はありません。';
          else if (result.reason === 'spoken') status.textContent = '読み上げました。';
          else status.textContent = '読み上げできませんでした。安全とは判断できません。';
        });
      });
    }
    var board = currentBoard(host._model);
    if (!board) {
      host.innerHTML = '<p id="rolling-dispatch-note">配車調整の集計機能を読み込めませんでした。安全とは判断できません。</p>';
      return;
    }
    paint(host, board);
  }

  root.RollingDispatchUI = { mount: mount };
})(typeof window !== 'undefined' ? window : null);
