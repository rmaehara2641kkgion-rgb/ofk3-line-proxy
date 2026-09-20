chrome.action.onClicked.addListener(function (tab) {
  if (!tab || !tab.id) return;
  var url = tab.url || '';
  if (!/^https:\/\/logistics\.amazon\.(co\.jp|com)(\/|$)/.test(url)) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    files: ['cortex-13-priority-core.js', 'cortex-13-capture-runner.js']
  }).then(function () {
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: function () {
        if (window.__OFK3_CORTEX_CAPTURE__ && typeof window.__OFK3_CORTEX_CAPTURE__.start === 'function') {
          window.__OFK3_CORTEX_CAPTURE__.start();
        }
      }
    });
  }).catch(function () {});
});

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
      done({ ok: false, error: 'DEBUGGER_INPUT', message: 'CDPクリックに失敗しました' });
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
        done({ ok: false, error: 'DEBUGGER_INPUT', message: 'CDPクリックに失敗しました' });
        return;
      }
      done({ ok: true });
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'ofk3-cdp-click') return;
  var tabId = sender && sender.tab && sender.tab.id;
  var x = Number(msg.x);
  var y = Number(msg.y);
  if (!tabId || !isFinite(x) || !isFinite(y)) {
    sendResponse({ ok: false, error: 'CLICK_COORD', message: 'クリック座標がありません' });
    return;
  }
  var target = { tabId: tabId };
  chrome.debugger.attach(target, '1.3', function () {
    if (chrome.runtime.lastError) {
      sendResponse({
        ok: false,
        error: 'DEBUGGER_ATTACH',
        message: 'DevToolsを閉じて再実行してください'
      });
      return;
    }
    try {
      dispatchLeftClick(target, x, y, function (result) {
        safeDetach(target, function () {
          sendResponse(result);
        });
      });
    } catch (e) {
      safeDetach(target, function () {
        sendResponse({ ok: false, error: 'DEBUGGER', message: 'CDP失敗' });
      });
    }
  });
  return true;
});
