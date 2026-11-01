(function () {
  'use strict';

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin && ev.origin !== location.origin) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_MENTOR' || data.type !== 'mentor-active-import') return;
    chrome.runtime.sendMessage({
      type: 'mentor-active-import',
      requestId: data.requestId,
      payload: data.payload
    }, function (res) {
      var err = chrome.runtime.lastError;
      window.postMessage({
        source: 'OFK3_MENTOR',
        type: 'mentor-active-import-result',
        requestId: data.requestId,
        ok: !!(res && res.ok),
        activeCount: res && res.body && res.body.activeCount != null ? res.body.activeCount : null,
        message: (res && res.message) || (err ? err.message : 'Mentor送信失敗')
      }, location.origin);
    });
  });
})();
