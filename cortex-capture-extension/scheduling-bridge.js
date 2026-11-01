(function () {
  'use strict';

  function originOk(ev) {
    if (ev.source !== window) return false;
    if (ev.origin && ev.origin !== location.origin) return false;
    return true;
  }

  window.addEventListener('message', function (ev) {
    if (!originOk(ev)) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_ID_DIAG' || data.type !== 'scheduling-ids') return;
    try {
      chrome.runtime.sendMessage({ type: 'id-diag-scheduling', digest: data.digest }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'id-diag-please-resend') return;
    try {
      window.postMessage({ source: 'OFK3_ID_DIAG', type: 'please-resend-scheduling' }, location.origin);
    } catch (e) {}
  });
})();
