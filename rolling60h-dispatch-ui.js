/**
 * 配車調整ダッシュボード。判定は RollingDispatch.assess の結果だけを表示する。
 * 仮の今日の時間は画面内だけで、原本と正式シフトには書かない。
 */
(function (root) {
  'use strict';

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
    if (origin === 'simulation') return '仮調整';
    return '未取得';
  }

  function fmt(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    return (Math.round(value * 10) / 10).toFixed(1);
  }

  function determined(side) {
    return !!side && (side.status === 'within' || side.status === 'approach' || side.status === 'exceed');
  }

  function hoursView(side) {
    if (!side || side.status === 'missing' || side.origin === 'missing') return '実績未取得';
    var origin = originLabel(side.origin);
    if (typeof side.totalHours !== 'number') return side.label || '判定不能';
    if (!determined(side)) return origin + ' ' + fmt(side.totalHours) + 'h（' + (side.label || '判定不能') + '）';
    return origin + ' ' + fmt(side.totalHours) + 'h';
  }

  function avoidText(row) {
    if (!row || row.undetermined) return '判定不能';
    var tomorrow = row.tomorrow || {};
    if (tomorrow.status !== 'exceed') {
      if (tomorrow.status === 'within') return '超過なし';
      if (tomorrow.status === 'approach') return '接近';
      return '判定不能';
    }
    if (row.avoidable) return '回避可能';
    if (row.avoidReason === 'today-shortening-insufficient') return '回避不可';
    return '判定不能';
  }

  function reasonText(row) {
    var reasons = [];
    function add(side, when) {
      if (!side || side.status === 'missing' || side.origin === 'missing') reasons.push(when + 'は実績未取得');
      else if (side.status === 'unconfirmed') reasons.push(when + 'は予定未確定');
      else if (side.status === 'undefined') reasons.push(when + 'は勤務記号が未定義');
      else if (side.status === 'failed') reasons.push(when + 'は集計失敗');
      else if (!determined(side)) reasons.push(when + 'は判定不能');
    }
    add(row.today, '今日');
    add(row.tomorrow, '明日');
    if (!row.name) reasons.push('氏名未特定');
    if (row.avoidReason === 'today-undetermined') reasons.push('今日の時間が確定していないため、短縮できるかは判定不能');
    if (!reasons.length) reasons.push('判定に必要なデータが不足');
    return reasons.join('。');
  }

  function tone(row) {
    if (!row || row.undetermined || !determined(row.today) || !determined(row.tomorrow)) return 'unknown';
    if (row.today.status === 'exceed' || row.tomorrow.status === 'exceed') return 'exceed';
    if (row.today.status === 'approach' || row.tomorrow.status === 'approach') return 'approach';
    return 'safe';
  }

  function toneStyle(kind) {
    if (kind === 'exceed') return 'border:1px solid #dc2626;background:#fef2f2;';
    if (kind === 'approach') return 'border:1px solid #ea580c;background:#fff7ed;';
    if (kind === 'unknown') return 'border:1px solid #6b7280;background:#f3f4f6;';
    return 'border:1px solid #d1d5db;background:#fff;';
  }

  function trialText(row) {
    if (!row || row.simulationStatus !== 'applied') return '';
    var status = row.simulatedTomorrow && row.simulatedTomorrow.status;
    if (status === 'within') return 'この仮時間なら超過を回避';
    if (status === 'approach') return 'この仮時間では接近';
    if (status === 'exceed') return 'この仮時間ではまだ超過';
    return 'この仮時間では判定不能';
  }

  function personName(row) {
    return row.name || row.transportId || '氏名未設定';
  }

  function overText(side) {
    if (!determined(side) || typeof side.overHours !== 'number') return '判定不能';
    if (side.overHours > 0) return '超過' + fmt(side.overHours) + 'h';
    return '超過なし';
  }

  function applyOverrides(model) {
    var overrides = model.overrides || {};
    return {
      today: model.today,
      limitHours: model.limitHours,
      rolling: root && root.RollingCore,
      drivers: (model.drivers || []).map(function (driver) {
        var copy = {
          transportId: driver.transportId,
          name: driver.name,
          actualBlocksByDate: driver.actualBlocksByDate,
          rosterBlocksByDate: driver.rosterBlocksByDate
        };
        var raw = overrides[driver.transportId];
        if (raw != null && raw !== '') copy.todayHoursOverride = Number(raw);
        return copy;
      })
    };
  }

  function currentBoard(model) {
    if (!root || !root.RollingDispatch || typeof root.RollingDispatch.assess !== 'function') return null;
    return root.RollingDispatch.assess(applyOverrides(model));
  }

  function cardGrid(minPx, maxPx) {
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,' + minPx + 'px),' + maxPx + 'px));gap:8px;justify-content:start;align-items:start;">';
  }

  function summaryCards(board, summary) {
    var drivers = board && board.drivers ? board.drivers : [];
    function people(status) {
      return drivers.filter(function (row) {
        return row.today.status === status || row.tomorrow.status === status;
      }).length;
    }
    var windowLine = summary
      ? '7日窓の判定件数（人数ではない。継続は超過または接近のうち、前回と同じ窓の再掲で、件数は重複し得る） 超過' + summary.exceed + '／接近' + summary.approach + '／継続' + summary.ongoing + '／判定不能' + (summary.undetermined == null ? '未集計' : summary.undetermined)
      : '7日窓の判定件数は、WH60の再計算後に表示します。未集計は安全ではありません。';
    function card(label, value, note, style) {
      return '<div style="min-width:0;' + style + 'border-radius:10px;padding:8px 10px;">' +
        '<div style="font-size:12px;color:#64748b;">' + escapeHtml(label) + '</div>' +
        '<div style="font-size:22px;font-weight:700;line-height:1.2;">' + escapeHtml(String(value)) + '</div>' +
        '<div style="font-size:12px;color:#64748b;">' + escapeHtml(note) + '</div></div>';
    }
    return '<p style="font-size:12px;color:#64748b;margin:0 0 8px;">' + escapeHtml(windowLine) + '</p>' +
      cardGrid(148, 180) +
      card('超過', people('exceed'), '人数（今日または明日）', toneStyle('exceed')) +
      card('接近', people('approach'), '人数（今日または明日）', toneStyle('approach')) +
      card('継続', summary ? summary.ongoing : '—', '7日窓の再掲件数', toneStyle('approach')) +
      card('判定不能', board && board.undetermined ? board.undetermined.length : 0, '人数。安全ではない', toneStyle('unknown')) +
      '</div>';
  }

  function emptyText(rows) {
    return rows && rows.length ? '' : '<p style="margin:4px 0 0;color:#64748b;">該当なし</p>';
  }

  function dangerCards(rows, sideName) {
    if (!rows || !rows.length) return emptyText(rows);
    return cardGrid(200, 240) +
      rows.map(function (row) {
        var side = row[sideName] || {};
        return '<article style="' + toneStyle('exceed') + 'border-radius:10px;padding:8px 10px;font-size:13px;line-height:1.35;">' +
          '<div style="font-weight:700;">' + escapeHtml(personName(row)) + '</div>' +
          '<div>予測累計 ' + escapeHtml(hoursView(side)) + '</div>' +
          '<div>' + escapeHtml(overText(side)) + '</div></article>';
      }).join('') + '</div>';
  }

  function adjustCards(rows, overrides) {
    if (!rows || !rows.length) return emptyText(rows);
    return cardGrid(220, 260) +
      rows.map(function (row) { return personCard(row, overrides, true, 'card'); }).join('') + '</div>';
  }

  function personCard(row, overrides, prominent, slot) {
    var value = overrides && overrides[row.transportId] != null ? overrides[row.transportId] : '';
    var cut = typeof row.requiredCutHours === 'number' ? fmt(row.requiredCutHours) + 'h短縮' : '短縮時間は判定不能';
    return '<article data-driver="' + escapeHtml(row.transportId) + '" style="' + toneStyle(tone(row)) + 'border-radius:10px;padding:8px 10px;font-size:13px;line-height:1.35;">' +
      '<div style="font-weight:700;">' + escapeHtml(personName(row)) + '</div>' +
      '<div style="font-size:' + (prominent ? '15px' : '13px') + ';font-weight:700;">今日 ' + escapeHtml(cut) + '</div>' +
      '<div>明日 ' + escapeHtml(hoursView(row.tomorrow)) + ' / ' + escapeHtml(overText(row.tomorrow)) + '</div>' +
      '<div>今日の予測 ' + escapeHtml(hoursView(row.today)) + ' → 調整後 ' + escapeHtml(hoursView(row.simulatedTomorrow)) + '</div>' +
      '<div>60hまでの残り 今日 ' + escapeHtml(fmt(row.today && row.today.remainingHours)) + 'h / 明日 ' + escapeHtml(fmt(row.tomorrow && row.tomorrow.remainingHours)) + 'h</div>' +
      '<div>結果 ' + escapeHtml(avoidText(row)) + (trialText(row) ? '。' + escapeHtml(trialText(row)) : '') + '</div>' +
      (tone(row) === 'unknown' ? '<div>' + escapeHtml(reasonText(row)) + '</div>' : '') +
      '<label style="display:block;margin-top:6px;font-size:12px;">仮の今日（dry-run）' +
      '<input data-driver="' + escapeHtml(row.transportId) + '" data-slot="' + escapeHtml(slot || 'card') + '" class="dispatch-hours" type="number" min="0" step="0.5" value="' + escapeHtml(value) + '" aria-label="仮の今日の勤務時間" style="display:block;width:100%;max-width:120px;margin-top:2px;"></label>' +
      '</article>';
  }

  function unknownCards(rows) {
    if (!rows || !rows.length) return emptyText(rows);
    return cardGrid(200, 240) +
      rows.map(function (row) {
        return '<article style="' + toneStyle('unknown') + 'border-radius:10px;padding:8px 10px;font-size:13px;line-height:1.35;">' +
          '<div style="font-weight:700;">' + escapeHtml(personName(row)) + '</div>' +
          '<div>判定不能</div>' +
          '<div>今日 ' + escapeHtml(hoursView(row.today)) + ' / 明日 ' + escapeHtml(hoursView(row.tomorrow)) + '</div>' +
          '<div>' + escapeHtml(reasonText(row)) + '</div></article>';
      }).join('') + '</div>';
  }

  function overRank(row) {
    var values = [row.today && row.today.overHours, row.tomorrow && row.tomorrow.overHours].filter(function (value) {
      return typeof value === 'number';
    });
    if (!values.length) return -1;
    return Math.max.apply(null, values);
  }

  function visibleDrivers(board, view) {
    var query = String(view.query || '').trim().toLowerCase();
    var rows = (board.drivers || []).filter(function (row) {
      if (query && personName(row).toLowerCase().indexOf(query) < 0 && String(row.transportId || '').toLowerCase().indexOf(query) < 0) return false;
      if (view.filter === 'exceed') return row.today.status === 'exceed' || row.tomorrow.status === 'exceed';
      if (view.filter === 'approach') return row.today.status === 'approach' || row.tomorrow.status === 'approach';
      if (view.filter === 'unknown') return !!row.undetermined;
      if (view.filter === 'adjustable') return row.tomorrow.status === 'exceed' && row.avoidable;
      if (view.filter === 'safe') return tone(row) === 'safe';
      return true;
    });
    if (view.sort !== 'name') {
      rows.sort(function (a, b) { return overRank(b) - overRank(a); });
    } else {
      rows.sort(function (a, b) { return personName(a).localeCompare(personName(b), 'ja'); });
    }
    return rows;
  }

  function renderHtml(board, view, summary, overrides) {
    view = view || {};
    var drivers = board && board.drivers ? board.drivers : [];
    var todayDanger = board && board.todayDanger ? board.todayDanger : [];
    var tomorrowDanger = board && board.tomorrowDanger ? board.tomorrowDanger : [];
    var adjustable = board && board.adjustable ? board.adjustable : [];
    var unknown = board && board.undetermined ? board.undetermined : [];
    var listed = visibleDrivers(board || { drivers: [] }, view);
    var note = board && board.ok === false
      ? '集計失敗。安全とは判断できません。'
      : '仮変更は原本と正式シフトには反映しません。dry-runです。データ未取得と予定未確定は安全ではありません。';
    var options = [
      ['all', 'すべて'],
      ['exceed', '超過'],
      ['approach', '接近'],
      ['unknown', '判定不能'],
      ['adjustable', '回避可能'],
      ['safe', '安全確認済み']
    ].map(function (item) {
      return '<option value="' + item[0] + '"' + (view.filter === item[0] ? ' selected' : '') + '>' + item[1] + '</option>';
    }).join('');
    return '<div>' +
      '<h2 style="font-size:18px;font-weight:700;margin:0 0 4px;">今日と明日の配車調整</h2>' +
      '<p id="rolling-dispatch-note" style="font-size:13px;color:#64748b;">' + escapeHtml(note) + (board && board.note ? ' ' + escapeHtml(board.note) : '') + '</p>' +
      '<section><h3 style="font-size:14px;font-weight:700;">60hリスクサマリー</h3>' + summaryCards(board, summary) + '</section>' +
      '<section style="margin-top:16px;"><h3 style="font-size:16px;font-weight:700;">今日の調整で回避できるDA</h3>' + adjustCards(adjustable, overrides) + '</section>' +
      '<section style="margin-top:16px;"><h3 style="font-size:14px;font-weight:700;">今日の危険者</h3><div id="rolling-dispatch-today-list">' + dangerCards(todayDanger, 'today') + '</div></section>' +
      '<section style="margin-top:12px;"><h3 style="font-size:14px;font-weight:700;">明日の危険者</h3><div id="rolling-dispatch-tomorrow-list">' + dangerCards(tomorrowDanger, 'tomorrow') + '</div></section>' +
      '<section style="margin-top:12px;"><h3 style="font-size:14px;font-weight:700;">判定不能者・データ不足</h3><div id="rolling-dispatch-open-list">' + unknownCards(unknown) + '</div></section>' +
      '<details id="rolling-dispatch-details"' + (view.open ? ' open' : '') + ' style="margin-top:16px;">' +
      '<summary style="cursor:pointer;font-weight:700;">全DA詳細一覧（' + drivers.length + '人）</summary>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;">' +
      '<input id="rolling-dispatch-search" type="search" value="' + escapeHtml(view.query || '') + '" placeholder="氏名・ID" style="flex:1 1 180px;min-width:0;">' +
      '<select id="rolling-dispatch-filter">' + options + '</select>' +
      '<select id="rolling-dispatch-sort">' +
      '<option value="over"' + (view.sort === 'name' ? '' : ' selected') + '>超過時間順</option>' +
      '<option value="name"' + (view.sort === 'name' ? ' selected' : '') + '>氏名順</option></select></div>' +
      cardGrid(220, 260) +
      (listed.length ? listed.map(function (row) { return personCard(row, overrides, false, 'list'); }).join('') : '<p>該当なし</p>') +
      '</div></details>' +
      '<button type="button" id="rolling-dispatch-speak" style="margin-top:12px;">警告を読み上げ</button>' +
      '<p id="rolling-dispatch-speech-status"></p></div>';
  }

  function readView(host) {
    if (!host._view) host._view = { query: '', filter: 'all', sort: 'over', open: false };
    return host._view;
  }

  function paint(host, board) {
    var view = readView(host);
    var overrides = host._model && host._model.overrides ? host._model.overrides : {};
    host.innerHTML = renderHtml(board, view, host._model && host._model.summary, overrides);
    var again = host.querySelector && host.querySelector('#rolling-dispatch-details');
    if (again && view.open) again.open = true;
  }

  function mount(host, model) {
    if (!host) return;
    host._model = model || { drivers: [], overrides: {} };
    if (!host._model.overrides) host._model.overrides = {};
    readView(host);
    if (host.getAttribute('data-bound') !== '1') {
      host.setAttribute('data-bound', '1');
      host.addEventListener('input', function (event) {
        var input = event.target;
        if (!input || !input.id) {
          if (!input || !input.getAttribute || !input.getAttribute('data-driver')) return;
        }
        if (input.id === 'rolling-dispatch-search') {
          readView(host).query = input.value;
          readView(host).open = true;
          var searched = currentBoard(host._model);
          if (searched) paint(host, searched);
          var search = host.querySelector && host.querySelector('#rolling-dispatch-search');
          if (search && search.focus) {
            search.focus();
            if (search.setSelectionRange) search.setSelectionRange(search.value.length, search.value.length);
          }
          return;
        }
        if (!input.getAttribute || !input.getAttribute('data-driver')) return;
        var driverId = input.getAttribute('data-driver');
        var slot = input.getAttribute('data-slot') || 'card';
        host._model.overrides[driverId] = input.value;
        var board = currentBoard(host._model);
        if (board) paint(host, board);
        var restored = null;
        if (host.querySelectorAll) {
          host.querySelectorAll('input.dispatch-hours').forEach(function (field) {
            if (!restored && field.getAttribute('data-driver') === driverId && field.getAttribute('data-slot') === slot) restored = field;
          });
        }
        if (restored && restored.focus) restored.focus();
      });
      host.addEventListener('change', function (event) {
        var input = event.target;
        if (!input) return;
        if (input.id === 'rolling-dispatch-filter') readView(host).filter = input.value;
        else if (input.id === 'rolling-dispatch-sort') readView(host).sort = input.value;
        else return;
        readView(host).open = true;
        var board = currentBoard(host._model);
        if (board) paint(host, board);
      });
      host.addEventListener('toggle', function (event) {
        if (!event.target || event.target.id !== 'rolling-dispatch-details') return;
        readView(host).open = !!event.target.open;
      });
      host.addEventListener('click', function (event) {
        if (!event.target || event.target.id !== 'rolling-dispatch-speak') return;
        var board = currentBoard(host._model);
        var status = host.querySelector('#rolling-dispatch-speech-status');
        if (!root || !root.RollingDispatch || typeof root.RollingDispatch.deliver !== 'function') {
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

  var api = { mount: mount, renderHtml: renderHtml, avoidText: avoidText, hoursView: hoursView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RollingDispatchUI = api;
})(typeof window !== 'undefined' ? window : null);
