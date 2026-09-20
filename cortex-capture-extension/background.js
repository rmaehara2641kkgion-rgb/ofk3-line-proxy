chrome.action.onClicked.addListener(function (tab) {
  if (!tab || !tab.id) return;
  var url = tab.url || '';
  if (!/^https:\/\/logistics\.amazon\.(co\.jp|com)(\/|$)/.test(url)) return;
  var target = { tabId: tab.id };
  chrome.scripting.executeScript({
    target: target,
    world: 'MAIN',
    func: function () {
      var api = window.__OFK3_CORTEX_CAPTURE__;
      if (api && typeof api.stop === 'function') {
        try { api.stop(); } catch (e1) {}
      }
    }
  }).then(function () {
    return chrome.scripting.executeScript({
      target: target,
      world: 'MAIN',
      files: ['phase1-core.js', 'phase1-runner.js']
    });
  }).then(function () {
    return chrome.scripting.executeScript({
      target: target,
      world: 'MAIN',
      func: function () {
        var api = window.__OFK3_CORTEX_CAPTURE__;
        if (!api || api.phase !== 'poc-2' || typeof api.start !== 'function') return;
        api.start();
      }
    });
  }).catch(function () {});
});

function cdpResult(partial) {
  var out = {
    ok: false,
    attach: 'fail',
    mousePressed: 'fail',
    mouseReleased: 'fail',
    error: 'DEBUGGER',
    message: 'CDP失敗'
  };
  var key;
  for (key in partial) {
    if (Object.prototype.hasOwnProperty.call(partial, key)) out[key] = partial[key];
  }
  return out;
}

function safeDetach(target, cb) {
  chrome.debugger.detach(target, function () {
    void chrome.runtime.lastError;
    if (typeof cb === 'function') cb();
  });
}

function dispatchLeftClick(target, x, y, done) {
  var press = {
    type: 'mousePressed',
    x: x,
    y: y,
    button: 'left',
    clickCount: 1
  };
  chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', press, function () {
    if (chrome.runtime.lastError) {
      done(cdpResult({
        ok: false,
        attach: 'success',
        mousePressed: 'fail',
        mouseReleased: 'fail',
        error: 'DEBUGGER_INPUT',
        message: 'CDP mousePressed失敗: ' + chrome.runtime.lastError.message
      }));
      return;
    }
    chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x,
      y: y,
      button: 'left',
      clickCount: 1
    }, function () {
      if (chrome.runtime.lastError) {
        done(cdpResult({
          ok: false,
          attach: 'success',
          mousePressed: 'success',
          mouseReleased: 'fail',
          error: 'DEBUGGER_INPUT',
          message: 'CDP mouseReleased失敗: ' + chrome.runtime.lastError.message
        }));
        return;
      }
      done(cdpResult({
        ok: true,
        attach: 'success',
        mousePressed: 'success',
        mouseReleased: 'success',
        error: '',
        message: ''
      }));
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === 'ofk3-priority-import') {
    fetch('https://ofk3-cortex-preview.onrender.com/cortex-priority/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.payload || {})
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body || body.status !== 'ok') {
          throw new Error((body && body.message) || ('HTTP ' + res.status));
        }
        sendResponse({ ok: true, body: body });
      });
    }).catch(function (e) {
      sendResponse({ ok: false, message: e && e.message ? e.message : 'OFK3 Preview送信失敗' });
    });
    return true;
  }
  if (msg.type !== 'ofk3-cdp-click' && msg.type !== 'ofk3-cdp-wheel') return;
  var tabId = sender && sender.tab && sender.tab.id;
  var x = Number(msg.x);
  var y = Number(msg.y);
  if (!tabId || !isFinite(x) || !isFinite(y)) {
    sendResponse(cdpResult({
      ok: false,
      error: 'CLICK_COORD',
      message: 'クリック座標がありません'
    }));
    return;
  }
  var target = { tabId: tabId };
  var isWheel = msg.type === 'ofk3-cdp-wheel';
  chrome.debugger.attach(target, '1.3', function () {
    if (chrome.runtime.lastError) {
      sendResponse(cdpResult({
        ok: false,
        attach: 'fail',
        mousePressed: 'fail',
        mouseReleased: 'fail',
        error: 'DEBUGGER_ATTACH',
        message: 'CDP attach失敗: ' + chrome.runtime.lastError.message
      }));
      return;
    }
    try {
      if (isWheel) {
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: x,
          y: y,
          deltaX: Number(msg.deltaX) || 0,
          deltaY: Number(msg.deltaY) || 0
        }, function () {
          var err = chrome.runtime.lastError;
          safeDetach(target, function () {
            sendResponse(err ? {
              ok: false,
              error: 'DEBUGGER_WHEEL',
              message: 'CDP wheel失敗: ' + err.message
            } : { ok: true, error: '', message: '' });
          });
        });
        return;
      }
      dispatchLeftClick(target, x, y, function (result) {
        safeDetach(target, function () {
          sendResponse(result);
        });
      });
    } catch (e) {
      safeDetach(target, function () {
        sendResponse(cdpResult({
          ok: false,
          attach: 'success',
          error: 'DEBUGGER',
          message: 'CDP失敗'
        }));
      });
    }
  });
  return true;
});
