/**
 * デイリー実績の自動回収設定。HARVEST本体の再確認処理とは別ファイル。
 * 表示の更新に失敗しても、既存のHARVEST操作は止めない。
 */
(function () {
  'use strict';

  var REASONS = {
    idle: '未実行',
    'before-time': '設定時刻前',
    'file-absent': 'ファイルなし（待機）',
    'future-file': '翌日分のため待機',
    'other-day': '当日分なし（待機）',
    'date-mismatch': 'ファイル名と内部日付が不一致',
    'next-day': '内部データが翌日分',
    'ambiguous-latest': '当日分のファイルが複数',
    'report5-missing': 'Report5_Daily_Data がない',
    'read-failed': '読み取り失敗',
    'copy-failed': '保管失敗',
    archived: '保管済み',
    unchanged: '変更なし',
    saved: '設定を保存しました',
  };

  function reasonText(reason) {
    return REASONS[reason] || '状態を確認できません';
  }

  function timeText(iso) {
    if (!iso) return 'なし';
    try {
      return new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).format(new Date(iso));
    } catch (e) {
      return 'なし';
    }
  }

  function fillNumberSelect(select, max, selected) {
    var html = '';
    var current = String(selected);
    for (var value = 0; value <= max; value++) {
      var label = value < 10 ? '0' + value : String(value);
      html += '<option value="' + value + '"' + (String(value) === current ? ' selected' : '') + '>' + label + '</option>';
    }
    select.innerHTML = html;
  }

  function applyStatus(body) {
    var state = document.getElementById('ofk3-daily-archive-state');
    var success = document.getElementById('ofk3-daily-archive-success');
    var failure = document.getElementById('ofk3-daily-archive-failure');
    var hour = document.getElementById('ofk3-daily-archive-hour');
    var minute = document.getElementById('ofk3-daily-archive-minute');
    var interval = document.getElementById('ofk3-daily-archive-interval');
    if (!state || !body) return;
    var statusLabel = body.status === 'ok' ? '回収済み' : (body.status === 'error' ? '失敗' : '待機中');
    state.textContent = statusLabel + ' / ' + reasonText(body.reason);
    if (success) success.textContent = timeText(body.lastSuccessAt);
    if (failure) failure.textContent = body.lastFailureAt ? (timeText(body.lastFailureAt) + ' ' + reasonText(body.lastFailureReason)) : 'なし';
    if (body.settings && hour && minute && interval && document.activeElement !== hour && document.activeElement !== minute && document.activeElement !== interval) {
      fillNumberSelect(hour, 23, body.settings.hour);
      fillNumberSelect(minute, 59, body.settings.minute);
      interval.value = String(body.settings.intervalMinutes);
    }
  }

  function loadStatus() {
    var state = document.getElementById('ofk3-daily-archive-state');
    if (!state || typeof fetch !== 'function') return;
    fetch('/harvest/daily-archive/status', { cache: 'no-store' }).then(function (res) {
      return res.json();
    }).then(function (body) {
      try { applyStatus(body); } catch (e) {}
    }).catch(function () {
      try { state.textContent = '表示を更新できませんでした'; } catch (e2) {}
    });
  }

  function saveSettings() {
    var hour = document.getElementById('ofk3-daily-archive-hour');
    var minute = document.getElementById('ofk3-daily-archive-minute');
    var interval = document.getElementById('ofk3-daily-archive-interval');
    var state = document.getElementById('ofk3-daily-archive-state');
    if (!hour || !minute || !interval || typeof fetch !== 'function') return;
    fetch('/harvest/daily-archive/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hour: Number(hour.value),
        minute: Number(minute.value),
        intervalMinutes: Number(interval.value),
      }),
    }).then(function (res) {
      return res.json();
    }).then(function (body) {
      try {
        if (!body || body.ok === false) {
          if (state) state.textContent = '失敗 / ' + reasonText(body && body.reason);
          return;
        }
        applyStatus(body);
      } catch (e) {}
    }).catch(function () {
      try { if (state) state.textContent = '設定を保存できませんでした'; } catch (e2) {}
    });
  }

  function mountPanel() {
    if (document.getElementById('ofk3-daily-archive-panel')) return;
    var overlay = document.getElementById('ofk3-harvest-overlay');
    var content = document.getElementById('ofk3-harvest-content');
    if (!overlay || !overlay.firstChild || !content) return;
    var panel = document.createElement('div');
    panel.id = 'ofk3-daily-archive-panel';
    panel.style.cssText = 'margin:0 16px;padding:12px 0;border-bottom:1px solid #e5e7eb;font-size:13px;line-height:1.7;';
    panel.innerHTML = ''
      + '<b>デイリー実績の自動回収</b>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px;">'
      + '<label>回収時刻 <select id="ofk3-daily-archive-hour"></select> 時</label>'
      + '<label><select id="ofk3-daily-archive-minute"></select> 分</label>'
      + '<label>監視間隔 <select id="ofk3-daily-archive-interval">'
      + '<option value="5">5分</option><option value="10">10分</option><option value="15" selected>15分</option>'
      + '<option value="30">30分</option><option value="60">60分</option>'
      + '</select></label>'
      + '<button type="button" id="ofk3-daily-archive-save" style="padding:5px 12px;background:#0f766e;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;">設定を保存</button>'
      + '<button type="button" id="ofk3-daily-archive-refresh" style="padding:5px 12px;background:#e5e7eb;color:#111;border:none;border-radius:6px;font-size:12px;cursor:pointer;">表示を更新</button>'
      + '</div>'
      + '<div>状態: <span id="ofk3-daily-archive-state">読み込み中</span></div>'
      + '<div>最終回収: <span id="ofk3-daily-archive-success">なし</span></div>'
      + '<div>最終失敗: <span id="ofk3-daily-archive-failure">なし</span></div>'
      + '<p style="color:#6b7280;font-size:12px;margin:4px 0 0;">原本は読み取るだけです。ファイルが無い間は待機です。</p>';
    overlay.firstChild.insertBefore(panel, content);
    fillNumberSelect(document.getElementById('ofk3-daily-archive-hour'), 23, 8);
    fillNumberSelect(document.getElementById('ofk3-daily-archive-minute'), 59, 0);
    var save = document.getElementById('ofk3-daily-archive-save');
    var refresh = document.getElementById('ofk3-daily-archive-refresh');
    if (save) save.addEventListener('click', function () { try { saveSettings(); } catch (e) {} });
    if (refresh) refresh.addEventListener('click', function () { try { loadStatus(); } catch (e) {} });
  }

  function boot() {
    var harvest = window.OFK3Harvest;
    if (!harvest || typeof harvest.open !== 'function' || harvest.__dailyArchive) return;
    var orig = harvest.open;
    harvest.open = function () {
      var value = orig.apply(this, arguments);
      try { mountPanel(); loadStatus(); } catch (e) {}
      return value;
    };
    harvest.__dailyArchive = true;
  }

  try { boot(); } catch (e) {}
})();
