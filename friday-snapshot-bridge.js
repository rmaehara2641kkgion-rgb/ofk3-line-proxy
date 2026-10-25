/**
 * Browser-side sender for the FRIDAY delivery snapshot.
 * Node environment variables are not visible here. The page, the script URL,
 * or same-origin localStorage can set the endpoint before the default.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FridaySnapshotBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var DEFAULT_ENDPOINT = 'http://127.0.0.1:3200/api/ops/snapshot';
  var BLOCKED_PORTS = { '3000': true, '3100': true };
  var LIVE_PORTS = { '3200': true };
  var HEARTBEAT_MS = 60000;
  var RETRY_BASE_MS = 5000;
  var RETRY_MAX_MS = 30000;
  var CHECK_MS = 2000;

  function resolveEndpoint(options) {
    var settings = options || {};
    var raw = settings.windowEndpoint || settings.queryEndpoint || settings.storedEndpoint || settings.fallback || DEFAULT_ENDPOINT;
    var url;
    try { url = new URL(String(raw)); }
    catch (error) { return { ok: false, error: 'invalid-endpoint' }; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'invalid-protocol' };
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return { ok: false, error: 'non-loopback' };
    if (url.pathname !== '/api/ops/snapshot') return { ok: false, error: 'invalid-path' };
    if (BLOCKED_PORTS[url.port]) return { ok: false, error: 'blocked-port' };
    if (settings.forbidLivePorts && LIVE_PORTS[url.port]) return { ok: false, error: 'live-port' };
    return { ok: true, url: url.origin + url.pathname };
  }

  function nextBackoff(failureCount) {
    var steps = Math.max(0, Number(failureCount) || 0);
    var delay = RETRY_BASE_MS * Math.pow(2, Math.min(steps, 4));
    return Math.min(RETRY_MAX_MS, delay);
  }

  function decideSend(state, now, stable, force) {
    var current = state || {};
    var clock = Number(now) || 0;
    if (force) return { send: true, reason: 'force' };
    if (current.acked !== true) {
      if (current.nextAttemptAt && clock < current.nextAttemptAt) {
        return { send: false, reason: 'backoff', waitMs: current.nextAttemptAt - clock };
      }
      return { send: true, reason: current.failureCount ? 'retry' : 'initial' };
    }
    if (current.lastHash !== stable) return { send: true, reason: 'changed' };
    if (clock - current.lastOkAt >= HEARTBEAT_MS) return { send: true, reason: 'heartbeat' };
    return { send: false, reason: 'unchanged', waitMs: HEARTBEAT_MS - (clock - current.lastOkAt) };
  }

  function noteSuccess(state, now, stable) {
    state.acked = true;
    state.lastOkAt = now;
    state.lastHash = stable;
    state.failureCount = 0;
    state.nextAttemptAt = 0;
    return state;
  }

  function noteFailure(state, now) {
    state.acked = false;
    state.failureCount = (state.failureCount || 0) + 1;
    state.lastOkAt = 0;
    state.nextAttemptAt = now + nextBackoff(state.failureCount - 1);
    return state;
  }

  return {
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    BLOCKED_PORTS: BLOCKED_PORTS,
    HEARTBEAT_MS: HEARTBEAT_MS,
    RETRY_BASE_MS: RETRY_BASE_MS,
    RETRY_MAX_MS: RETRY_MAX_MS,
    CHECK_MS: CHECK_MS,
    resolveEndpoint: resolveEndpoint,
    decideSend: decideSend,
    nextBackoff: nextBackoff,
    noteSuccess: noteSuccess,
    noteFailure: noteFailure,
  };
});
