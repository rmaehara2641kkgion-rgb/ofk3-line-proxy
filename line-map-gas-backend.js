/**
 * 割当の永続化バックエンド (GAS Web App)。既存の duty-risk-store.gs と同じ方式:
 * トークンは Script Properties、Render側は環境変数。トークンはURLに載せずPOSTボディで送る。
 * LINE_MAP_GAS_URL / LINE_MAP_GAS_TOKEN が未設定ならバックエンド無し(= 接続しない)。
 * fetch は注入可能 (テストではモック。本番接続はしない)。
 *
 * エラーは必ず固定コード(gas-timeout 等)だけを持つ。URL・トークン・応答本文は例外に含めない。
 * 保存データは envelope { v, seq, savedAt, checksum, data }。保存成功は GAS が返す seq / checksum が
 * 送ったものと一致したときだけ「成功」とする (部分応答・不正応答は失敗)。
 */
'use strict';

var MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

function coded(code, extra) {
  var e = new Error(code); // message は固定コードのみ
  e.code = code;
  if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
  return e;
}

function createGasBackend(opts) {
  opts = opts || {};
  var url = opts.url, token = opts.token;
  var doFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  var timeoutMs = opts.timeoutMs || 8000;
  if (!url || !token || !doFetch) return null;

  async function call(action, extra) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
    var res;
    try {
      res = await doFetch(url, {
        method: 'POST', redirect: 'follow', signal: ctl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // GASのプリフライト回避
        body: JSON.stringify(Object.assign({ action: action, token: token }, extra || {}))
      });
    } catch (e) {
      clearTimeout(timer);
      throw coded(e && (e.name === 'AbortError' || e.name === 'TimeoutError') ? 'gas-timeout' : 'gas-network');
    }
    try {
      if (res.status === 429) throw coded('gas-rate-limited');
      if (res.status >= 500) throw coded('gas-server-error');
      if (res.status === 401 || res.status === 403) throw coded('gas-unauthorized');
      if (!res.ok) throw coded('gas-http');
      var text;
      try { text = await res.text(); } catch (e) { throw coded(e && (e.name === 'AbortError' || e.name === 'TimeoutError') ? 'gas-timeout' : 'gas-network'); }
      if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES) throw coded('gas-too-large');
      var j;
      try { j = JSON.parse(text); } catch (e) { throw coded('gas-bad-json'); }
      if (!j || typeof j !== 'object') throw coded('gas-bad-json');
      if (j.status !== 'ok') {
        var reason = String(j.reason || 'error').replace(/[^a-z-]/g, '').slice(0, 30) || 'error';
        throw coded('gas-' + reason, reason === 'conflict' ? { remoteSeq: Number(j.seq) } : null);
      }
      return j;
    } finally { clearTimeout(timer); }
  }
  return {
    // envelope または null(まだ何も保存されていない)。それ以外(欠落・型違い)は部分応答として失敗。
    load: async function () {
      var j = await call('load');
      if (j.envelope === null) return null;
      if (!j.envelope || typeof j.envelope !== 'object') throw coded('gas-partial-response');
      return j.envelope;
    },
    // expectedSeq は読み込んだ時点の seq (楽観ロック)。GASが同じ seq / checksum を返して初めて成功。
    save: async function (envelope, expectedSeq) {
      var j = await call('save', { envelope: envelope, expectedSeq: expectedSeq });
      if (j.seq !== envelope.seq || j.checksum !== envelope.checksum) throw coded('gas-partial-response');
    }
  };
}

module.exports = { createGasBackend: createGasBackend };
