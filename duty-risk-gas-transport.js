/**
 * GAS Webアプリとの送受信。
 * 302はGoogleの実行URLへGETで1回だけ追う。別ホストへは追わず、本文も再送しない。
 * ログ用の戻り値にトークン、スナップショット、履歴は載せない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DutyRiskGasTransport = api;
})(this, function () {
  'use strict';

  var ECHO_HOST = 'script.googleusercontent.com';

  function safeCode(value) {
    var text = value == null ? '' : String(value);
    if (!text) return '';
    if (/token|secret|bearer|password|authorization/i.test(text)) return '';
    return /^[a-z][a-z0-9-]{0,40}$/.test(text) ? text : '';
  }

  function header(response, name) {
    var headers = response && response.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') return String(headers.get(name) || '');
    var direct = headers[name] || headers[name.toLowerCase()] || '';
    return direct == null ? '' : String(direct);
  }

  function hostOf(location) {
    try {
      return new URL(location).host;
    } catch (error) {
      return '';
    }
  }

  function redirectResult(status) {
    return {
      status: status || 302,
      data: { ok: false, published: false, reason: 'redirect-unexpected', stage: 'redirect' },
    };
  }

  function followGet(http, location, timeout, hops) {
    if (!location || hostOf(location) !== ECHO_HOST || hops > 2) return Promise.resolve(redirectResult(302));
    return http.get(location, {
      timeout: timeout,
      maxRedirects: 0,
      validateStatus: function () { return true; },
    }).then(function (response) {
      var status = response && response.status;
      if (status !== 301 && status !== 302 && status !== 303) return response;
      return followGet(http, header(response, 'location'), timeout, hops + 1);
    });
  }

  function followPost(http, response, timeout) {
    var status = response && response.status;
    if (status !== 301 && status !== 302 && status !== 303) return Promise.resolve(response);
    return followGet(http, header(response, 'location'), timeout, 1);
  }

  function interpret(response) {
    var status = response && typeof response.status === 'number' ? response.status : 0;
    var data = response && response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {
        ok: false,
        published: false,
        reason: status >= 400 ? 'http-error' : 'non-json',
        stage: 'response',
        httpStatus: status || null,
      };
    }
    var keepBody = status >= 200 && status < 300 && data.ok === true;
    var result = {};
    Object.keys(data).forEach(function (key) {
      if (key === 'token' || key === 'secret' || key === 'authorization' || key === 'password') return;
      if (!keepBody && (key === 'snapshot' || key === 'historyRun' || key === 'alerts' || key === 'predictions' || key === 'drivers')) return;
      result[key] = data[key];
    });
    if (result.reason != null) result.reason = safeCode(result.reason) || 'redacted';
    if (result.stage != null) result.stage = safeCode(result.stage) || 'redacted';
    if (result.revision != null) result.revision = safeCode(result.revision) || 'redacted';
    result.httpStatus = status || null;
    if (status >= 400 && !safeCode(data.reason)) result.reason = 'http-error';
    return result;
  }

  function postJson(http, url, body, options) {
    options = options || {};
    var timeout = options.timeout || 60000;
    return http.post(url, body, {
      timeout: timeout,
      maxRedirects: 0,
      validateStatus: function () { return true; },
      headers: options.headers || {},
    }).then(function (response) {
      return followPost(http, response, timeout);
    }).then(interpret);
  }

  function getJson(http, url, options) {
    options = options || {};
    var timeout = options.timeout || 60000;
    return http.get(url, {
      timeout: timeout,
      params: options.params,
      maxRedirects: 0,
      validateStatus: function () { return true; },
      headers: options.headers || {},
    }).then(function (response) {
      return followPost(http, response, timeout);
    }).then(interpret);
  }

  return {
    safeCode: safeCode,
    followPost: followPost,
    interpret: interpret,
    postJson: postJson,
    getJson: getJson,
  };
});
