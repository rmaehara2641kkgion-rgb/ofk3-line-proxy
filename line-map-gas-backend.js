/**
 * 割当の永続化バックエンド (GAS Web App)。既存の duty-risk-store.gs と同じ方式:
 * トークンは Script Properties、Render側は環境変数。トークンはURLに載せずPOSTボディで送る。
 * LINE_MAP_GAS_URL / LINE_MAP_GAS_TOKEN が未設定ならバックエンド無し(= 接続しない)。
 * fetch は注入可能 (テストではモック。本番接続はしない)。
 */
'use strict';

function createGasBackend(opts) {
  opts = opts || {};
  var url = opts.url, token = opts.token;
  var doFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  var timeoutMs = opts.timeoutMs || 8000;
  if (!url || !token || !doFetch) return null;

  async function call(action, extra) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
    try {
      var res = await doFetch(url, {
        method: 'POST', redirect: 'follow', signal: ctl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // GASのプリフライト回避
        body: JSON.stringify(Object.assign({ action: action, token: token }, extra || {}))
      });
      if (!res.ok) throw new Error('gas-http-' + res.status);
      var j = await res.json();
      if (!j || j.status !== 'ok') throw new Error('gas-' + ((j && j.reason) || 'error'));
      return j;
    } finally { clearTimeout(timer); }
  }
  return {
    load: async function () { var j = await call('load'); return j.data && typeof j.data === 'object' ? j.data : {}; },
    save: async function (data) { await call('save', { data: data }); }
  };
}

module.exports = { createGasBackend: createGasBackend };
