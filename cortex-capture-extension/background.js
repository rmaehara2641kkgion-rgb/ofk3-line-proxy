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
