// OFK3送信先。既定は本番。Preview検証時のみ chrome.storage.local に
// { ofk3TargetBaseUrl: 'https://ofk3-cortex-preview.onrender.com' } を設定すると切り替わる
// （拡張の再ビルド不要。DevTools等から chrome.storage.local.set で設定/解除する）。
var OFK3_PRODUCTION_BASE_URL = 'https://ofk3-line-proxy-1.onrender.com';
try {
  importScripts('id-diag-core.js');
} catch (e) {}
var idDiagApi = typeof globalThis !== 'undefined' ? globalThis.OFK3IdDiag : null;
var idDiagSession = (idDiagApi && idDiagApi.createSession)
  ? idDiagApi.createSession(function () { return new Date(); })
  : null;

function idDiagPublic(selectedDate) {
  if (!idDiagSession) return null;
  return idDiagSession.read(selectedDate);
}

function idDiagPing(url) {
  try {
    chrome.tabs.query({ url: url }, function (tabs) {
      (tabs || []).forEach(function (tab) {
        if (!tab || !tab.id) return;
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'id-diag-please-resend' }, function () {
            void chrome.runtime.lastError;
          });
        } catch (e1) {}
      });
    });
  } catch (e2) {}
}

function publishMentorStartup(handoff) {
  try {
    var stamps = idDiagSession && typeof idDiagSession.captureStamps === 'function' ? idDiagSession.captureStamps() : {};
    var view = handoff && handoff.view ? handoff.view : handoff;
    fetch('http://127.0.0.1:3000/mentor-startup/notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        view: view,
        identities: handoff && Array.isArray(handoff.identities) ? handoff.identities : [],
        schedulingCapturedAt: stamps.schedulingCapturedAt || null,
        mentorCapturedAt: stamps.mentorCapturedAt || null,
        judgedAt: new Date().toISOString(),
        cycle: null
      })
    }).then(function () {}, function () {});
  } catch (e) {}
}

function idDiagNotify(diagnostic) {
  try {
    chrome.tabs.query({ url: 'https://vrm-mentor.edriving.com/*' }, function (tabs) {
      (tabs || []).forEach(function (tab) {
        if (!tab || !tab.id) return;
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'id-diag-updated', diagnostic: diagnostic }, function () {
            void chrome.runtime.lastError;
          });
        } catch (e1) {}
      });
    });
  } catch (e2) {}
}

function handleIdDiag(msg, sendResponse) {
  if (!idDiagSession) {
    sendResponse({ ok: false, diagnostic: null });
    return;
  }
  var diagnostic = null;
  if (msg.type === 'id-diag-scheduling') diagnostic = idDiagSession.ingestScheduling(msg.digest);
  else if (msg.type === 'id-diag-mentor') diagnostic = idDiagSession.ingestMentor(msg.digest);
  else if (msg.type === 'id-diag-master') diagnostic = idDiagSession.ingestMaster(msg.digest);
  else if (msg.type === 'id-diag-confirm-read') {
    sendResponse({ ok: true, confirmation: idDiagSession.confirmationView(msg.date, msg.includeRows === true) });
    return;
  } else if (msg.type === 'id-diag-rollcall') {
    sendResponse({ ok: true, rollCall: idDiagSession.rollCallView(msg.date, msg.includeRows === true) });
    return;
  } else if (msg.type === 'id-diag-suspect') {
    var suspectView = idDiagSession.suspectView(msg.date, msg.includeRows === true);
    sendResponse({ ok: true, suspect: suspectView });
    publishMentorStartup(typeof idDiagSession.startupHandoff === 'function' ? idDiagSession.startupHandoff(msg.date) : { view: suspectView, identities: [] });
    return;
  } else if (msg.type === 'id-diag-confirm') {
    sendResponse({ ok: true, confirmation: idDiagSession.setConfirmation(msg.date, msg.index, msg.status, msg.generation) });
    return;
  } else if (msg.type === 'id-diag-confirm-reset') {
    idDiagSession.resetConfirmations();
    sendResponse({ ok: true, confirmation: idDiagSession.confirmationView(msg.date, false) });
    return;
  } else if (msg.type === 'id-diag-identity-set' || msg.type === 'id-diag-identity-clear') {
    var changed = msg.type === 'id-diag-identity-clear'
      ? idDiagSession.clearIdentityLink(msg.date, msg.rowIndex, msg.generation)
      : idDiagSession.setIdentityLink(msg.date, msg.rowIndex, msg.candidateIndex, msg.action, msg.generation);
    sendResponse({
      ok: !!(changed && changed.ok),
      message: changed && changed.message ? changed.message : '',
      suspect: changed && changed.suspect ? changed.suspect : null
    });
    return;
  } else diagnostic = idDiagPublic();
  sendResponse({ ok: true, diagnostic: diagnostic });
  if (msg.type === 'id-diag-resend') {
    idDiagPing('https://logistics.amazon.co.jp/scheduling/*');
    idDiagPing('https://vrm-mentor.edriving.com/*');
    idDiagPing('https://ofk3-line-proxy-1.onrender.com/index.html');
    idDiagPing('https://ofk3-line-proxy-1.onrender.com/');
  }
  if (msg.type === 'id-diag-scheduling' || msg.type === 'id-diag-mentor' || msg.type === 'id-diag-master') idDiagNotify(diagnostic);
}
function resolveOfk3BaseUrl() {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(['ofk3TargetBaseUrl'], function (data) {
        var url = data && data.ofk3TargetBaseUrl;
        resolve(url || OFK3_PRODUCTION_BASE_URL);
      });
    } catch (e) {
      resolve(OFK3_PRODUCTION_BASE_URL);
    }
  });
}

var identityLinksReady = false;
function ensureIdentityLinks(done) {
  if (identityLinksReady) {
    done();
    return;
  }
  try {
    chrome.storage.local.get(['ofk3MentorIdentityLinks'], function (data) {
      void chrome.runtime.lastError;
      identityLinksReady = true;
      if (idDiagSession && typeof idDiagSession.loadIdentityLinks === 'function') {
        idDiagSession.loadIdentityLinks(data && data.ofk3MentorIdentityLinks);
      }
      done();
    });
  } catch (e) {
    identityLinksReady = true;
    done();
  }
}

function persistIdentityLinks() {
  if (!idDiagSession || typeof idDiagSession.exportIdentityLinks !== 'function') return;
  try {
    chrome.storage.local.set({ ofk3MentorIdentityLinks: idDiagSession.exportIdentityLinks() }, function () {
      void chrome.runtime.lastError;
    });
  } catch (e2) {}
}

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
  if (msg.type === 'id-diag-suspect' || msg.type === 'id-diag-identity-set' || msg.type === 'id-diag-identity-clear') {
    ensureIdentityLinks(function () {
      try {
        handleIdDiag(msg, sendResponse);
        if ((msg.type === 'id-diag-identity-set' || msg.type === 'id-diag-identity-clear') && idDiagSession && typeof idDiagSession.exportIdentityLinks === 'function') {
          persistIdentityLinks();
        }
      } catch (e) {
        try { sendResponse({ ok: false, diagnostic: null }); } catch (e2) {}
      }
    });
    return true;
  }
  if (msg.type === 'id-diag-scheduling' || msg.type === 'id-diag-mentor' || msg.type === 'id-diag-master' || msg.type === 'id-diag-read' || msg.type === 'id-diag-resend' || msg.type === 'id-diag-confirm-read' || msg.type === 'id-diag-confirm' || msg.type === 'id-diag-confirm-reset' || msg.type === 'id-diag-rollcall') {
    try {
      handleIdDiag(msg, sendResponse);
    } catch (e) {
      try { sendResponse({ ok: false, diagnostic: null }); } catch (e2) {}
    }
    return;
  }
  if (msg.type === 'mentor-active-import') {
    resolveOfk3BaseUrl().then(function (baseUrl) {
      return fetch(baseUrl + '/mentor-active/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg.payload || {})
      });
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body || body.status !== 'ok') {
          throw new Error((body && body.message) || ('HTTP ' + res.status));
        }
        sendResponse({
          ok: true,
          body: { status: 'ok', activeCount: body.activeCount, capturedAt: body.capturedAt }
        });
      });
    }).catch(function (e) {
      sendResponse({ ok: false, message: e && e.message ? e.message : 'Mentor送信失敗' });
    });
    return true;
  }
  if (msg.type === 'ofk3-priority-import') {
    resolveOfk3BaseUrl().then(function (baseUrl) {
      return fetch(baseUrl + '/cortex-priority/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg.payload || {})
      });
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body || body.status !== 'ok') {
          throw new Error((body && body.message) || ('HTTP ' + res.status));
        }
        sendResponse({ ok: true, body: body });
      });
    }).catch(function (e) {
      sendResponse({ ok: false, message: e && e.message ? e.message : 'OFK3送信失敗' });
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
