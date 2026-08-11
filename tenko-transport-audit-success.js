// TransportID照合の一致結果を、点呼照合タブへ切替後も見えるようにする。
(function() {
  'use strict';

  var lastSignature = '';
  var toastTimer = null;

  function removeExistingToast() {
    var old = document.getElementById('tenko-transport-success-toast');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  function showSuccessToast(text) {
    removeExistingToast();

    var toast = document.createElement('div');
    toast.id = 'tenko-transport-success-toast';
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:100000;min-width:340px;max-width:92vw;padding:16px 20px;border:2px solid #16a34a;border-radius:12px;background:#f0fdf4;color:#15803d;box-shadow:0 12px 30px rgba(0,0,0,.22);font-size:14px;font-weight:700;text-align:center;';
    toast.innerHTML = '<div style="font-size:17px;margin-bottom:4px;">✅ TransportID照合：一致</div>' +
      '<div style="font-size:13px;font-weight:600;">' + text + '</div>';
    document.body.appendChild(toast);

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() {
      removeExistingToast();
    }, 8000);
  }

  function mirrorToTenkoMatch(panel) {
    var matchPanel = document.getElementById('panel-tenko-match');
    if (!matchPanel) return;

    var mirror = document.getElementById('tenko-transport-audit-mirror');
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.id = 'tenko-transport-audit-mirror';
      mirror.className = 'card p-4 mb-4 border-2 border-emerald-400 bg-emerald-50';
      matchPanel.insertBefore(mirror, matchPanel.firstChild);
    }
    mirror.innerHTML = panel.innerHTML;
  }

  function inspectPanel() {
    var panel = document.getElementById('tenko-transport-audit-panel');
    if (!panel) return;

    var text = panel.textContent || '';
    if (text.indexOf('TransportID照合：一致') < 0) return;

    var signature = text.replace(/\s+/g, ' ').trim();
    if (!signature || signature === lastSignature) return;
    lastSignature = signature;

    var countMatch = signature.match(/一致\s*(\d+)名\s*\/\s*不一致\s*0名/);
    var message = countMatch
      ? 'AmazonスケジュールとDAシフト表：' + countMatch[1] + '名すべて一致しました'
      : 'AmazonスケジュールとDAシフト表のTransportIDは一致しています';

    showSuccessToast(message);
    mirrorToTenkoMatch(panel);
  }

  function startObserver() {
    inspectPanel();
    var observer = new MutationObserver(function() {
      inspectPanel();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
})();
