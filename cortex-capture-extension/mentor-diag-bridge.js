(function () {
  'use strict';

  function originOk(ev) {
    if (ev.source !== window) return false;
    if (ev.origin && ev.origin !== location.origin) return false;
    return true;
  }

  function show(diagnostic) {
    try {
      window.postMessage({
        source: 'OFK3_ID_DIAG',
        type: 'diag-result',
        diagnostic: diagnostic || null
      }, location.origin);
    } catch (e) {}
  }

  window.addEventListener('message', function (ev) {
    if (!originOk(ev)) return;
    var data = ev.data;
    if (!data || data.source !== 'OFK3_ID_DIAG') return;
    if (data.type === 'mentor-ids') {
      try {
        chrome.runtime.sendMessage({ type: 'id-diag-mentor', digest: data.digest }, function (res) {
          void chrome.runtime.lastError;
          if (res && res.diagnostic) show(res.diagnostic);
        });
      } catch (e) {}
      return;
    }
    if (data.type === 'id-diag-identity-set' || data.type === 'id-diag-identity-clear') {
      try {
        chrome.runtime.sendMessage({
          type: data.type,
          date: data.date,
          rowIndex: data.rowIndex,
          candidateIndex: data.candidateIndex,
          action: data.action,
          generation: data.generation,
          includeRows: data.includeRows === true,
          token: data.token
        }, function (res) {
          void chrome.runtime.lastError;
          try {
            window.postMessage({
              source: 'OFK3_ID_DIAG',
              type: 'identity-result',
              token: data.token,
              ok: !!(res && res.ok),
              message: res && res.message ? res.message : '',
              suspect: res && res.suspect ? res.suspect : null
            }, location.origin);
          } catch (e3) {}
        });
      } catch (e4) {}
      return;
    }
    if (data.type === 'id-diag-confirm-read' || data.type === 'id-diag-confirm' || data.type === 'id-diag-confirm-reset' || data.type === 'id-diag-rollcall' || data.type === 'id-diag-suspect') {
      try {
        chrome.runtime.sendMessage({
          type: data.type,
          date: data.date,
          index: data.index,
          status: data.status,
          generation: data.generation,
          includeRows: data.includeRows === true,
          token: data.token
        }, function (res) {
          void chrome.runtime.lastError;
          try {
            if (data.type === 'id-diag-rollcall') {
              window.postMessage({
                source: 'OFK3_ID_DIAG',
                type: 'rollcall-view',
                token: data.token,
                rollCall: res && res.rollCall ? res.rollCall : null
              }, location.origin);
              return;
            }
            if (data.type === 'id-diag-suspect') {
              window.postMessage({
                source: 'OFK3_ID_DIAG',
                type: 'suspect-view',
                token: data.token,
                suspect: res && res.suspect ? res.suspect : null
              }, location.origin);
              return;
            }
            window.postMessage({
              source: 'OFK3_ID_DIAG',
              type: 'confirm-view',
              token: data.token,
              confirmation: res && res.confirmation ? res.confirmation : null
            }, location.origin);
          } catch (e3) {}
        });
      } catch (e4) {}
      return;
    }
    if (data.type === 'id-diag-refresh') {
      try {
        chrome.runtime.sendMessage({ type: 'id-diag-resend' }, function (res) {
          void chrome.runtime.lastError;
          if (res && res.diagnostic) show(res.diagnostic);
        });
      } catch (e2) {}
    }
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === 'id-diag-please-resend') {
      try {
        window.postMessage({ source: 'OFK3_ID_DIAG', type: 'please-resend-mentor' }, location.origin);
      } catch (e) {}
      return;
    }
    if (msg.type === 'id-diag-updated') show(msg.diagnostic);
  });
})();
