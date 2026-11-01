(function () {
  'use strict';

  function originOk(ev) {
    if (!ev || ev.source !== window) return false;
    if (ev.origin && ev.origin !== location.origin) return false;
    return true;
  }

  function readMap(key) {
    try {
      var value = JSON.parse(localStorage.getItem(key) || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return value;
    } catch (e) {
      return null;
    }
  }

  function send(digest) {
    try {
      chrome.runtime.sendMessage({ type: 'id-diag-master', digest: digest }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  window.addEventListener('message', function (ev) {
    if (!originOk(ev)) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_ID_DIAG' || data.type !== 'master-status') return;
    if (data.phase !== 'ready') {
      send({ ok: false, phase: data.phase === 'failed' ? 'failed' : 'loading' });
      return;
    }
    var tids = readMap('transportIDs');
    var names = readMap('driverJapaneseNames');
    var depts = readMap('driverDepartments');
    if (!tids || !names || !depts) {
      send({ ok: false, phase: 'failed' });
      return;
    }
    var entries = Object.keys(tids).map(function (key) {
      return {
        name: key,
        japaneseName: typeof names[key] === 'string' ? names[key] : '',
        transportId: tids[key] == null ? '' : String(tids[key]),
        department: typeof depts[key] === 'string' ? depts[key] : ''
      };
    });
    send({
      ok: true,
      phase: 'ready',
      loadedAt: typeof data.loadedAt === 'number' ? data.loadedAt : 0,
      entries: entries
    });
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'id-diag-please-resend') return;
    try {
      window.postMessage({ source: 'OFK3_ID_DIAG', type: 'please-resend-master' }, location.origin);
    } catch (e) {}
  });

  send({ ok: false, phase: 'loading' });
})();
