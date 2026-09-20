(function () {
  'use strict';

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin && ev.origin !== location.origin) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_CORTEX' || data.type !== 'cdp-click') return;
    chrome.runtime.sendMessage({
      type: 'ofk3-cdp-click',
      x: Number(data.x),
      y: Number(data.y)
    }, function (res) {
      var err = chrome.runtime.lastError;
      window.postMessage({
        source: 'OFK3_CORTEX',
        type: 'cdp-click-result',
        ok: !!(res && res.ok),
        error: (res && res.error) || (err ? 'DEBUGGER_BRIDGE' : 'DEBUGGER'),
        message: (res && res.message) || (err ? '拡張との通信に失敗しました' : 'CDP失敗')
      }, location.origin);
    });
  });
})();
