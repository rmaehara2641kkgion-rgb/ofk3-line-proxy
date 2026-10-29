(function () {
  'use strict';

  if (location.hostname !== 'ofk3-line-proxy-1.onrender.com') return;
  var path = location.pathname || '';
  if (path !== '/index.html' && path !== '/') return;

  var sentReady = 0;

  function post(phase, loadedAt) {
    var body = { source: 'OFK3_ID_DIAG', type: 'master-status', phase: phase };
    if (loadedAt) body.loadedAt = loadedAt;
    window.postMessage(body, location.origin);
  }

  function tick() {
    var status = window.__ofk3MasterLoadStatus;
    if (!status || typeof status.completedAt !== 'number' || !isFinite(status.completedAt)) return;
    if (sentReady === status.completedAt) return;
    sentReady = status.completedAt;
    post('ready', status.completedAt);
  }

  setTimeout(function () { post('loading'); }, 0);
  tick();
  setInterval(tick, 500);

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin && ev.origin !== location.origin) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_ID_DIAG' || data.type !== 'please-resend-master') return;
    sentReady = 0;
    post('loading');
    tick();
  });
})();
