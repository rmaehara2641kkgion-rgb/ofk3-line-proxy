(function () {
  'use strict';

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin && ev.origin !== location.origin) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_CORTEX') return;
    if (data.type === 'ofk3-priority-import') {
      chrome.runtime.sendMessage({
        type: 'ofk3-priority-import',
        requestId: data.requestId,
        payload: data.payload
      }, function (res) {
        var err = chrome.runtime.lastError;
        window.postMessage({
          source: 'OFK3_CORTEX',
          type: 'ofk3-priority-import-result',
          requestId: data.requestId,
          ok: !!(res && res.ok),
          body: (res && res.body) || null,
          message: (res && res.message) || (err ? err.message : 'OFK3送信失敗')
        }, location.origin);
      });
      return;
    }
    if (data.type !== 'cdp-click' && data.type !== 'cdp-wheel') return;
    var isWheel = data.type === 'cdp-wheel';
    chrome.runtime.sendMessage({
      type: isWheel ? 'ofk3-cdp-wheel' : 'ofk3-cdp-click',
      x: Number(data.x),
      y: Number(data.y),
      deltaX: isWheel ? Number(data.deltaX || 0) : 0,
      deltaY: isWheel ? Number(data.deltaY || 0) : 0
    }, function (res) {
      var err = chrome.runtime.lastError;
      window.postMessage({
        source: 'OFK3_CORTEX',
        type: isWheel ? 'cdp-wheel-result' : 'cdp-click-result',
        ok: !!(res && res.ok),
        attach: (res && res.attach) || 'fail',
        mousePressed: (res && res.mousePressed) || 'fail',
        mouseReleased: (res && res.mouseReleased) || 'fail',
        error: (res && res.error) || (err ? 'DEBUGGER_BRIDGE' : 'DEBUGGER'),
        message: (res && res.message) || (err ? '拡張との通信に失敗しました' : 'CDP失敗')
      }, location.origin);
    });
  });
})();
