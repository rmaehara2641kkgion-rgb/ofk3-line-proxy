(function () {
  if (window.__FRIDAY_MENTOR_STARTUP) return;
  window.__FRIDAY_MENTOR_STARTUP = true;
  var BASE = 'http://127.0.0.1:3000';
  var KEY = 'friday.mentorStartup.v1';
  var busy = false;

  function loadState() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function saveState(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch (e) { return false; }
  }
  function remember(key) {
    var state = loadState() || { confirmed: {} };
    if (!state.confirmed) state.confirmed = {};
    state.confirmed[key] = new Date().toISOString();
    return saveState(state);
  }
  function post(pathname, body) {
    return fetch(BASE + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      if (!res.ok) throw new Error('mentor-startup');
      return res.json();
    });
  }
  function get(pathname) {
    return fetch(BASE + pathname, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('mentor-startup');
      return res.json();
    });
  }
  function render(payload, disconnected) {
    var box = document.getElementById('mentor-startup-alerts');
    if (!box) return;
    if (disconnected || !payload) {
      box.textContent = 'INO-1のMentor起動通知は未取得です。音声が出なくても、取得済みの通知は残します。';
      return;
    }
    var reason = payload.outcomeReason || '未取得';
    if (reason.indexOf('未起動者') === 0) reason = '未起動の疑いはありません';
    var lines = [
      '判定 ' + reason,
      (payload.scope === 'overall' ? '区分 全体報告' : ('サイクル ' + (payload.cycle || '未確定'))),
      '確認対象 ' + (payload.evaluatedCount == null ? '不明' : payload.evaluatedCount),
      '起動確認候補 ' + (payload.activeCandidateCount == null ? '不明' : payload.activeCandidateCount),
      '疑い ' + (payload.suspectCount == null ? '不明' : payload.suspectCount),
      '判定不能 ' + (payload.undeterminedCount == null ? '不明' : payload.undeterminedCount)
    ];
    var captured = payload.mentorCapturedAt || payload.judgedAt || '';
    if (captured) lines.push('取得時刻 ' + captured);
    (Array.isArray(payload.people) ? payload.people : []).forEach(function (person) {
      var name = person && typeof person.name === 'string' ? person.name.trim() : '';
      var who = name && name !== '要確認' && name !== '取得不可' ? name : (person && person.schedulingId ? '識別子 ' + person.schedulingId : '識別子なし');
      lines.push(who + ' / ' + (person && person.status ? person.status : '状況は未確認'));
    });
    if (payload.sample === true) lines.push('これはテストデータです');
    if (payload.text) lines.push(payload.text);
    box.textContent = lines.join(' / ');
  }
  function audioBusy() {
    return window.__FRIDAY_CALENDAR_SPEAKING === true
      || window.__FRIDAY_CALENDAR_STARTUP === 'pending'
      || window.__FRIDAY_SPEECH_BUSY === true
      || !!(window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending));
  }
  function waitIdle() {
    var started = Date.now();
    return new Promise(function (resolve) {
      (function step() {
        if (!audioBusy() || Date.now() - started >= 20000) { resolve(!audioBusy()); return; }
        setTimeout(step, 400);
      })();
    });
  }
  function reconcile() {
    var state = loadState();
    var keys = state && state.confirmed ? Object.keys(state.confirmed) : [];
    if (!keys.length) return Promise.resolve();
    return post('/mentor-startup/reconcile', { keys: keys }).catch(function () {});
  }
  function speakPayload(payload) {
    if (!payload || typeof speakText !== 'function' || !payload.text) return Promise.resolve(false);
    return speakText(payload.text).then(function (ok) {
      var keys = Array.isArray(payload.keys) && payload.keys.length ? payload.keys : (payload.key ? [payload.key] : []);
      if (!keys.length) return ok === true;
      var saved = ok === true;
      keys.forEach(function (key) { if (ok === true) saved = remember(key) && saved; });
      return Promise.all(keys.map(function (key) {
        return post('/mentor-startup/ack', { key: key, ok: ok === true }).catch(function () {});
      })).then(function () { return saved && ok === true; });
    });
  }
  var DEFAULT_SLOTS = [
    { id: '1', time: '09:05', enabled: false },
    { id: '2', time: '11:10', enabled: false },
    { id: '3', time: '11:35', enabled: false },
    { id: '4', time: '15:00', enabled: false }
  ];
  function timeState(text) {
    var node = document.getElementById('mentor-startup-time-state');
    if (node) node.textContent = text;
  }
  function slotList(settings) {
    var slots = settings && Array.isArray(settings.slots) && settings.slots.length === 4 ? settings.slots : DEFAULT_SLOTS;
    return DEFAULT_SLOTS.map(function (item, index) {
      var found = slots[index] && slots[index].id === item.id ? slots[index] : item;
      return {
        id: item.id,
        time: typeof found.time === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(found.time) ? found.time : item.time,
        enabled: found.enabled === true
      };
    });
  }
  function renderSlots(settings) {
    var host = document.getElementById('mentor-startup-slots');
    if (!host) return;
    var editing = host.contains(document.activeElement);
    if (editing) return;
    host.innerHTML = slotList(settings).map(function (slot) {
      return '<label class="mentor-slot"><input type="checkbox" data-slot-enabled="' + slot.id + '"' + (slot.enabled ? ' checked' : '') + '>通知' + slot.id + '</label><input data-slot-time="' + slot.id + '" type="time" step="60" value="' + slot.time + '">';
    }).join('');
    var enabled = slotList(settings).filter(function (slot) { return slot.enabled; }).map(function (slot) { return slot.time; });
    timeState(enabled.length ? ('自動読み上げは ' + enabled.join('、') + ' です。') : '自動読み上げはオフです。');
  }
  function readSlots() {
    return DEFAULT_SLOTS.map(function (item) {
      var timeInput = document.querySelector('[data-slot-time="' + item.id + '"]');
      var enabledInput = document.querySelector('[data-slot-enabled="' + item.id + '"]');
      return {
        id: item.id,
        time: timeInput && timeInput.value ? timeInput.value : item.time,
        enabled: !!(enabledInput && enabledInput.checked)
      };
    });
  }
  function applySettings(settings) {
    renderSlots(settings);
  }
  function loadSettings() {
    return get('/mentor-startup/settings').then(applySettings).catch(function () {
      applySettings(null);
      timeState('設定を確認できませんでした。自動読み上げはオフです。');
    });
  }
  function saveSettings() {
    var slots = readSlots();
    var seen = {};
    var invalid = slots.some(function (slot) {
      if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(slot.time) || seen[slot.time]) return true;
      seen[slot.time] = true;
      return false;
    });
    if (invalid) {
      timeState('4つの時刻は、それぞれ別の時分にしてください。');
      return Promise.resolve(false);
    }
    return get('/mentor-startup/settings').then(function (current) {
      var cycles = current && current.cycles && typeof current.cycles === 'object' && !Array.isArray(current.cycles) ? current.cycles : {};
      return post('/mentor-startup/settings', {
        freshnessMs: current && typeof current.freshnessMs === 'number' ? current.freshnessMs : null,
        slots: slots,
        cycles: cycles
      });
    }).then(function (saved) {
      applySettings(saved);
      var enabled = slotList(saved).filter(function (slot) { return slot.enabled; });
      timeState(enabled.length ? ('自動読み上げは ' + enabled.map(function (slot) { return slot.time; }).join('、') + ' に保存しました。') : '自動読み上げをオフに保存しました。');
      return true;
    }).catch(function () {
      timeState('時刻を保存できませんでした。');
      return false;
    });
  }
  function bindSettings() {
    var closed = 'FRIDAYを開いている間だけ読み上げます。閉じている間の時刻は読み上げできません。';
    if (!document.getElementById('mentor-startup-timebox')) {
      var panel = document.getElementById('mentor-startup-panel');
      var alerts = document.getElementById('mentor-startup-alerts');
      if (panel && alerts) {
        var box = document.createElement('div');
        box.id = 'mentor-startup-timebox';
        box.innerHTML = '<p id="mentor-startup-closed">' + closed + '</p><div id="mentor-startup-slots"></div><button type="button" id="mentor-startup-save">時刻を保存</button><p id="mentor-startup-time-state">自動読み上げはオフです。</p>';
        panel.insertBefore(box, alerts);
      }
    }
    if (!document.getElementById('mentor-startup-style')) {
      var style = document.createElement('style');
      style.id = 'mentor-startup-style';
      style.textContent = '#mentor-startup-timebox{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}#mentor-startup-closed,#mentor-startup-time-state{flex:1 0 100%;margin:0;font-size:12px}#mentor-startup-slots{display:flex;flex-wrap:wrap;gap:6px;width:100%}.mentor-slot{font-size:12px}[data-slot-time]{background:#111;color:#fff;border:1px solid #666;border-radius:4px;padding:2px 4px}#mentor-startup-save{cursor:pointer}';
      document.head.appendChild(style);
    }
    renderSlots(null);
    var button = document.getElementById('mentor-startup-save');
    if (button && !button.__mentorTimeBound) {
      button.__mentorTimeBound = true;
      button.addEventListener('click', function () { saveSettings(); });
    }
  }
  function tick(manual) {
    if (busy) return;
    busy = true;
    var button = document.getElementById('mentor-startup-check');
    if (button) button.disabled = true;
    var done = Promise.resolve();
    if (manual) {
      done = get('/mentor-startup/manual').then(function (payload) {
        render(payload, false);
        return speakPayload(payload);
      });
    } else {
      done = get('/mentor-startup/plan').then(function (payload) {
        render(payload, false);
        if (!payload.speak) return false;
        return waitIdle().then(function (idle) {
          if (!idle) return post('/mentor-startup/ack', { key: payload.key, ok: false }).catch(function () {});
          return speakPayload(payload);
        });
      });
    }
    return done.catch(function () { render(null, true); }).then(function () {
      busy = false;
      if (button) button.disabled = false;
    });
  }
  var button = document.getElementById('mentor-startup-check');
  if (button) button.addEventListener('click', function () { tick(true); });
  bindSettings();
  reconcile().then(function () { return loadSettings(); }).then(function () { tick(false); });
  setInterval(function () { tick(false); }, 60000);
})();
