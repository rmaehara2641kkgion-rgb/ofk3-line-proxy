// OFK3送信先。既定は本番。Preview検証時のみ chrome.storage.local に
// { ofk3TargetBaseUrl: 'https://ofk3-cortex-preview.onrender.com' } を設定すると切り替わる
// （拡張の再ビルド不要。DevTools等から chrome.storage.local.set で設定/解除する）。
var OFK3_PRODUCTION_BASE_URL = 'https://ofk3-line-proxy-1.onrender.com';
try {
  importScripts('id-diag-core.js', 'mentor-slot-watch.js');
} catch (e) {}
var mentorWatch = typeof globalThis !== 'undefined' ? globalThis.OFK3MentorSlotWatch : null;
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

var lastMentorPublishKey = '';
var mentorInflight = {};
var mentorOutbox = [];
var mentorReloads = {};
var mentorStoredStamps = null;

function mentorSourcesReady(sources) {
  return !!(sources
    && sources.scheduling !== 'missing' && sources.scheduling !== 'failed'
    && sources.mentor !== 'missing' && sources.mentor !== 'failed');
}

function mentorPublishKey(handoff, stamps) {
  var view = handoff && handoff.view ? handoff.view : handoff;
  var counts = view && view.counts ? view.counts : {};
  var rows = Array.isArray(view && view.rows) ? view.rows : [];
  return [
    view && view.date || '',
    counts.total, counts.active, counts.suspect, counts.undetermined,
    stamps && stamps.schedulingCapturedAt || '',
    stamps && stamps.mentorCapturedAt || '',
    rows.map(function (row) { return (row && row.status || '') + ':' + (row && row.schedulingName || ''); }).join(',')
  ].join('|');
}

var aliasAuditSettled = false;
function publishIfCaptured(date) {
  ensureIdentityLinks(function () {
    publishCapturedReady(date);
  });
}

function publishCapturedReady(date) {
  if (!idDiagSession || typeof idDiagSession.startupHandoff !== 'function') return;
  var handoff = idDiagSession.startupHandoff(date);
  var sources = handoff && handoff.view && handoff.view.sources;
  if (!mentorSourcesReady(sources)) return;
  var audited = null;
  if (!aliasAuditSettled && sources.scheduling === 'ready' && sources.mentor === 'ready' && typeof idDiagSession.nameAudit === 'function') {
    audited = idDiagSession.nameAudit(date);
    if (audited && audited.summary && audited.summary.ready) {
      if (audited.handoff) handoff = audited.handoff;
      if (audited.summary.kanjiFound) aliasAuditSettled = true;
    }
  }
  var summary = audited && audited.summary && audited.summary.ready ? audited.summary : null;
  function finish(ack) {
    if (summary) {
      summary.aliasOk = !!(ack && ack.ok);
      summary.aliasCount = ack && ack.count ? ack.count : 0;
      summary.aliasGiven = ack && ack.given ? ack.given : '';
      summary.aliasSched = ack && ack.sched ? ack.sched : '';
      try {
        chrome.storage.local.set({ ofk3MentorNameAudit: summary }, function () {
          void chrome.runtime.lastError;
          idDiagNotify(null);
        });
      } catch (eAudit) {}
    }
  }
  if (audited && audited.registered) {
    persistConfirmedAliases(finish);
  } else {
    readConfirmedAliasAck(finish);
  }
  publishMentorStartup(handoff);
}

function persistMentorWatch() {
  try {
    chrome.storage.local.set({
      ofk3MentorPublishKey: lastMentorPublishKey,
      ofk3MentorOutbox: mentorOutbox,
      ofk3MentorSlotReloads: mentorReloads,
      ofk3MentorCaptureStamps: mentorStoredStamps
    }, function () { void chrome.runtime.lastError; });
  } catch (eStore) {}
}

function currentCaptureStamps() {
  var live = idDiagSession && typeof idDiagSession.captureStamps === 'function' ? idDiagSession.captureStamps() : null;
  if (live && live.schedulingCapturedAt && live.mentorCapturedAt) return live;
  return mentorStoredStamps;
}

function postMentorNotice(payload, key, attempt) {
  if (!attempt) {
    if (key && (key === lastMentorPublishKey || mentorInflight[key])) return;
    if (key) mentorInflight[key] = true;
  }
  fetch('http://127.0.0.1:3000/mentor-startup/notice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (res) {
    if (!res || !res.ok) throw new Error('mentor-startup');
    lastMentorPublishKey = key;
    if (key) delete mentorInflight[key];
    if (mentorWatch) mentorOutbox = mentorWatch.drop(mentorOutbox, key);
    persistMentorWatch();
  }).catch(function () {
    if (mentorWatch) mentorOutbox = mentorWatch.enqueue(mentorOutbox, { key: key, payload: payload, queuedAt: new Date().toISOString() });
    persistMentorWatch();
    if (attempt >= 2) {
      if (key) delete mentorInflight[key];
      return;
    }
    setTimeout(function () { postMentorNotice(payload, key, attempt + 1); }, 1500);
  });
}

function publishMentorStartup(handoff) {
  try {
    var stamps = currentCaptureStamps() || {};
    mentorStoredStamps = {
      schedulingCapturedAt: stamps.schedulingCapturedAt || null,
      mentorCapturedAt: stamps.mentorCapturedAt || null
    };
    var key = mentorPublishKey(handoff, stamps);
    if (key && key === lastMentorPublishKey) return;
    var view = handoff && handoff.view ? handoff.view : handoff;
    postMentorNotice({
      view: view,
      identities: handoff && Array.isArray(handoff.identities) ? handoff.identities : [],
      schedulingCapturedAt: stamps.schedulingCapturedAt || null,
      mentorCapturedAt: stamps.mentorCapturedAt || null,
      judgedAt: new Date().toISOString(),
      cycle: null
    }, key, 0);
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
    publishIfCaptured(msg.date);
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
  if (msg.type === 'id-diag-scheduling' || msg.type === 'id-diag-mentor' || msg.type === 'id-diag-master') {
    idDiagNotify(diagnostic);
    if (msg.type === 'id-diag-scheduling' || msg.type === 'id-diag-mentor') {
      mentorStoredStamps = currentCaptureStamps();
      persistMentorWatch();
      publishIfCaptured();
    }
  }
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
    chrome.storage.local.get(['ofk3MentorIdentityLinks', 'ofk3MentorConfirmedAliases'], function (data) {
      void chrome.runtime.lastError;
      identityLinksReady = true;
      if (idDiagSession && typeof idDiagSession.loadIdentityLinks === 'function') {
        idDiagSession.loadIdentityLinks(data && data.ofk3MentorIdentityLinks);
      }
      if (idDiagSession && typeof idDiagSession.loadConfirmedAliases === 'function') {
        idDiagSession.loadConfirmedAliases(data && data.ofk3MentorConfirmedAliases);
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

function confirmedAliasAck(saved, failed) {
  var aliases = saved && saved.version === 1 && Array.isArray(saved.aliases) ? saved.aliases : [];
  var hit = null;
  aliases.forEach(function (item) {
    if (item && item.schedulingId === 'A3OCANZ1K090JB') hit = item;
  });
  function tail(text) {
    text = typeof text === 'string' ? text : '';
    return text ? text.charCodeAt(text.length - 1).toString(16) : '';
  }
  var family = '\u8c37\u53e3';
  return {
    ok: !failed && aliases.length === 1 && !!hit && hit.confirmed === true && tail(hit.schedulingGiven) === '5df1' && tail(hit.mentorGiven) === '5df2' && hit.schedulingFamily === family && hit.mentorFamily === family,
    count: aliases.length,
    given: hit ? tail(hit.mentorGiven) : '',
    sched: hit ? tail(hit.schedulingGiven) : ''
  };
}

function readConfirmedAliasAck(done) {
  try {
    chrome.storage.local.get(['ofk3MentorConfirmedAliases'], function (data) {
      var failed = !!chrome.runtime.lastError;
      if (typeof done === 'function') done(confirmedAliasAck(data && data.ofk3MentorConfirmedAliases, failed));
    });
  } catch (eAck) {
    if (typeof done === 'function') done({ ok: false, count: 0, given: '', sched: '' });
  }
}

function persistConfirmedAliases(done) {
  if (!idDiagSession || typeof idDiagSession.exportConfirmedAliases !== 'function') {
    if (typeof done === 'function') done({ ok: false, count: 0, given: '', sched: '' });
    return;
  }
  try {
    chrome.storage.local.set({ ofk3MentorConfirmedAliases: idDiagSession.exportConfirmedAliases() }, function () {
      if (chrome.runtime.lastError) {
        if (typeof done === 'function') done({ ok: false, count: 0, given: '', sched: '' });
        return;
      }
      readConfirmedAliasAck(done);
    });
  } catch (e3) {
    if (typeof done === 'function') done({ ok: false, count: 0, given: '', sched: '' });
  }
}

chrome.action.onClicked.addListener(function (tab) {
  // Show Mentor status immediately without replacing the existing Cortex capture action.
  try { chrome.tabs.create({url: chrome.runtime.getURL('mentor-status.html')}); } catch (_e) {}

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
  if (msg.type === 'id-diag-suspect' || msg.type === 'id-diag-identity-set' || msg.type === 'id-diag-identity-clear' || msg.type === 'id-diag-alias-register') {
    ensureIdentityLinks(function () {
      try {
        if (msg.type === 'id-diag-alias-register') {
          var registered = idDiagSession && typeof idDiagSession.registerConfirmedAlias === 'function'
            ? idDiagSession.registerConfirmedAlias(msg.alias)
            : { ok: false, reason: 'unavailable' };
          if (registered && registered.ok) persistConfirmedAliases();
          sendResponse({ ok: !!(registered && registered.ok), reason: registered && registered.reason ? registered.reason : '' });
          return;
        }
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
  if (msg.type === 'id-diag-scheduling' || msg.type === 'id-diag-mentor' || msg.type === 'id-diag-master' || msg.type === 'id-diag-read' || msg.type === 'id-diag-resend' || msg.type === 'id-diag-confirm-read' || msg.type === 'id-diag-confirm' || msg.type === 'id-diag-confirm-reset' || msg.type === 'id-diag-rollcall' || msg.type === 'id-diag-suspect') {
    try {
      handleIdDiag(msg, sendResponse);
    } catch (e) {
      try { sendResponse({ ok: false, diagnostic: null }); } catch (e2) {}
    }
    return;
  }
  if (msg.type === 'friday-time-window-summary') {
    // Only accept explicitly reconciled data from trusted extension scripts.
    const senderUrl=String(sender?.url||'');
    if(!/^https:\/\/logistics\.amazon\.(co\.jp|com)\//.test(senderUrl)) {
      sendResponse({ok:false,error:'UNTRUSTED_SENDER'});return;
    }
    fetch('http://127.0.0.1:3000/api/ops/time-window-report', {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg.payload||{})
    }).then(async r=>({status:r.status,body:await r.json()})).then(r=>sendResponse(r.body))
      .catch(e=>sendResponse({ok:false,error:String(e.message||e)}));
    return true;
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

function reloadLoggedInTab(urlPattern) {
  try {
    chrome.tabs.query({ url: urlPattern }, function (tabs) {
      (tabs || []).forEach(function (tab) {
        if (!tab || !tab.id || tab.status === 'loading') return;
        if (mentorWatch && mentorWatch.loginUrl(tab.url || '')) return;
        try { chrome.tabs.reload(tab.id); } catch (eReload) {}
      });
    });
  } catch (eQuery) {}
}

function runMentorPrep(slotId) {
  if (!mentorWatch || !slotId) return;
  var action = mentorWatch.prepAction({
    stamps: currentCaptureStamps(),
    reloads: mentorReloads
  }, slotId, new Date());
  if (action.reason === 'already-fresh' || action.reason === 'reload-used') {
    if (action.reason === 'reload-used') {
      idDiagPing('https://logistics.amazon.co.jp/scheduling/*');
      idDiagPing('https://logistics.amazon.com/scheduling/*');
      idDiagPing('https://vrm-mentor.edriving.com/*');
    }
    return;
  }
  mentorReloads = mentorWatch.markReload(mentorReloads, action.reloadKey, action.mark);
  persistMentorWatch();
  if (action.reload) {
    reloadLoggedInTab('https://logistics.amazon.co.jp/scheduling/*');
    reloadLoggedInTab('https://logistics.amazon.com/scheduling/*');
    reloadLoggedInTab('https://vrm-mentor.edriving.com/*');
    return;
  }
  idDiagPing('https://logistics.amazon.co.jp/scheduling/*');
  idDiagPing('https://logistics.amazon.com/scheduling/*');
  idDiagPing('https://vrm-mentor.edriving.com/*');
}

function flushMentorOutbox() {
  mentorOutbox.slice().forEach(function (item) {
    if (!item || !item.payload || !item.key) return;
    postMentorNotice(item.payload, item.key, 0);
  });
}

function scheduleMentorWatch() {
  if (!mentorWatch || typeof chrome === 'undefined' || !chrome.alarms) return;
  mentorWatch.alarmPlan(new Date()).forEach(function (alarm) {
    try {
      chrome.alarms.create(alarm.name, { when: alarm.when, periodInMinutes: alarm.periodInMinutes });
    } catch (eAlarm) {}
  });
}

function restoreMentorWatch() {
  function start(data) {
    if (data && typeof data.ofk3MentorPublishKey === 'string') lastMentorPublishKey = data.ofk3MentorPublishKey;
    mentorOutbox = data && Array.isArray(data.ofk3MentorOutbox) ? data.ofk3MentorOutbox : [];
    mentorReloads = data && data.ofk3MentorSlotReloads && typeof data.ofk3MentorSlotReloads === 'object' ? data.ofk3MentorSlotReloads : {};
    mentorStoredStamps = data && data.ofk3MentorCaptureStamps ? data.ofk3MentorCaptureStamps : null;
    scheduleMentorWatch();
    if (mentorWatch) mentorWatch.duePreps(new Date(), mentorReloads).forEach(runMentorPrep);
    flushMentorOutbox();
  }
  try {
    chrome.storage.local.get(['ofk3MentorPublishKey', 'ofk3MentorOutbox', 'ofk3MentorSlotReloads', 'ofk3MentorCaptureStamps'], function (data) {
      void chrome.runtime.lastError;
      start(data || {});
    });
  } catch (eRestore) {
    start({});
  }
}

try {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (!alarm || !mentorWatch) return;
    if (alarm.name === mentorWatch.OUTBOX_ALARM) {
      flushMentorOutbox();
      return;
    }
    var slot = mentorWatch.slotByAlarm(alarm.name);
    if (slot) runMentorPrep(slot.id);
  });
} catch (eAlarmListener) {}

restoreMentorWatch();
