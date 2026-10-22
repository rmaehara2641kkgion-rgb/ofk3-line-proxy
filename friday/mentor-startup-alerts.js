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
    var lines = [
      '判定 ' + (payload.outcomeReason || '未取得'),
      (payload.scope === 'overall' ? '区分 全体報告' : ('サイクル ' + (payload.cycle || '未確定'))),
      '確認対象 ' + (payload.evaluatedCount == null ? '不明' : payload.evaluatedCount),
      '起動確認候補 ' + (payload.activeCandidateCount == null ? '不明' : payload.activeCandidateCount),
      '疑い ' + (payload.suspectCount == null ? '不明' : payload.suspectCount),
      '判定不能 ' + (payload.undeterminedCount == null ? '不明' : payload.undeterminedCount),
      '未起動断定 ' + (payload.confirmedUnstartedCount == null ? 0 : payload.confirmedUnstartedCount)
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
  reconcile().then(function () { tick(false); });
  setInterval(function () { tick(false); }, 60000);
})();
