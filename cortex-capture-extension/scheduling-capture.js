/**
 * Scheduling ページ自身の GET /rosters だけを見る。
 * 応答本体はページへそのまま返し、追加リクエストはしない。
 */
(function (global) {
  'use strict';

  var Core = global.OFK3IdDiag;
  if (!Core) return;

  function onHost() {
    try {
      var location = global.location;
      return location.hostname === 'logistics.amazon.co.jp' && /^\/scheduling(\/|$)/.test(location.pathname || '');
    } catch (e) {
      return false;
    }
  }

  if (!onHost()) return;

  var lastDigest = null;
  var matched = 0;
  var otherHostRosterCount = 0;
  var otherHosts = [];

  function requestInfo(input, init) {
    var url = '';
    var method = 'GET';
    try {
      if (typeof input === 'string') url = input;
      else if (input && typeof input.url === 'string') url = input.url;
      else if (input && typeof input.href === 'string') url = input.href;
      if (init && init.method) method = init.method;
      else if (input && typeof input.method === 'string') method = input.method;
    } catch (e) {}
    return { url: url, method: method };
  }

  function meta() {
    return {
      matched: matched,
      otherHostRosterCount: otherHostRosterCount,
      otherHosts: otherHosts.slice()
    };
  }

  function noteForeign(url, method) {
    var host = Core.foreignRosterHost(url, method);
    if (!host) return;
    otherHostRosterCount += 1;
    if (otherHosts.indexOf(host) < 0 && otherHosts.length < 3) otherHosts.push(host);
    if (lastDigest && lastDigest.ok === true) {
      lastDigest.meta = meta();
      publish(lastDigest);
      return;
    }
    publish({
      ok: false,
      issue: 'OTHER_HOST',
      capturedAt: new Date().toISOString(),
      meta: meta()
    });
  }

  function origin() {
    try { return global.location.origin || ''; } catch (e) { return ''; }
  }

  function publish(digest) {
    lastDigest = digest;
    var target = origin();
    if (!target || typeof global.postMessage !== 'function') return;
    try {
      global.postMessage({ source: 'OFK3_ID_DIAG', type: 'scheduling-ids', digest: digest }, target);
    } catch (e) {}
  }

  function publishFail(issue) {
    publish({
      ok: false,
      issue: issue,
      capturedAt: new Date().toISOString(),
      meta: meta()
    });
  }

  function acceptText(url, status, text) {
    if (!(status >= 200 && status < 300)) {
      publishFail('HTTP');
      return;
    }
    var parsed = Core.parseJson(text);
    if (!parsed.ok) {
      publishFail(parsed.issue || 'JSON_PARSE_FAILED');
      return;
    }
    var digest = Core.extractRoster(parsed.body, url, new Date().toISOString());
    digest.meta = meta();
    publish(digest);
  }

  function observeResponse(url, method, res) {
    noteForeign(url, method);
    if (!Core.isRosterRequest(url, method)) return;
    matched += 1;
    var status = res ? Number(res.status) || 0 : 0;
    if (!res || typeof res.clone !== 'function') {
      publishFail('CLONE_FAILED');
      return;
    }
    var cloned;
    try {
      cloned = res.clone();
    } catch (e) {
      publishFail('CLONE_FAILED');
      return;
    }
    if (!cloned || typeof cloned.text !== 'function') {
      publishFail('TEXT_FAILED');
      return;
    }
    cloned.text().then(function (text) {
      acceptText(url, status, text);
    }, function () {
      publishFail('TEXT_FAILED');
    });
  }

  function installFetch() {
    if (global.__OFK3_ROSTER_HOOKED__) return;
    var origFetch = global.fetch;
    if (typeof origFetch !== 'function') return;
    global.fetch = function (input, init) {
      var info = requestInfo(input, init);
      var promise = origFetch.apply(this, arguments);
      if (promise && typeof promise.then === 'function') {
        promise.then(function (res) {
          try { observeResponse(info.url || (res && res.url) || '', info.method, res); } catch (e) {}
        }, function () {});
      }
      return promise;
    };
    global.__OFK3_ROSTER_HOOKED__ = true;
  }

  function installXhr() {
    if (global.__OFK3_ROSTER_XHR_HOOKED__) return;
    if (!global.XMLHttpRequest || !global.XMLHttpRequest.prototype) return;
    var xhrOpen = global.XMLHttpRequest.prototype.open;
    var xhrSend = global.XMLHttpRequest.prototype.send;
    if (typeof xhrOpen !== 'function' || typeof xhrSend !== 'function') return;
    global.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__ofk3RosterMethod = method;
        this.__ofk3RosterUrl = url;
      } catch (e) {}
      return xhrOpen.apply(this, arguments);
    };
    global.XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      try {
        noteForeign(xhr.__ofk3RosterUrl, xhr.__ofk3RosterMethod);
        if (Core.isRosterRequest(xhr.__ofk3RosterUrl, xhr.__ofk3RosterMethod)) {
          xhr.addEventListener('load', function () {
            matched += 1;
            var text = '';
            try { text = xhr.responseText || ''; } catch (e1) {
              publishFail('TEXT_FAILED');
              return;
            }
            acceptText(xhr.__ofk3RosterUrl || xhr.responseURL || '', Number(xhr.status) || 0, text);
          });
        }
      } catch (e2) {}
      return xhrSend.apply(this, arguments);
    };
    global.__OFK3_ROSTER_XHR_HOOKED__ = true;
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('message', function (ev) {
      if (ev.source !== global) return;
      var data = ev.data;
      if (!data || data.source !== 'OFK3_ID_DIAG' || data.type !== 'please-resend-scheduling') return;
      if (lastDigest) publish(lastDigest);
    });
  }

  installFetch();
  installXhr();
})(typeof window !== 'undefined' ? window : globalThis);
