/**
 * OFK3 Cortex 13:00 priority — UI glue.
 * Does not fetch Cortex. Does not store cookies/tokens.
 * Input is a JSON bundle the user obtained while logged into Cortex.
 */
(function (global) {
  'use strict';

  var CACHE_TTL_MS = 5 * 60 * 1000;
  var memoryCache = { key: '', at: 0, result: null };

  function core() {
    return global.Cortex13PriorityCore;
  }

  function cacheGet(key) {
    if (!memoryCache.result) return null;
    if (memoryCache.key !== key) return null;
    if (Date.now() - memoryCache.at > CACHE_TTL_MS) return null;
    return memoryCache.result;
  }

  function cacheSet(key, result) {
    memoryCache = { key: key, at: Date.now(), result: result };
  }

  function cacheClear() {
    memoryCache = { key: '', at: 0, result: null };
  }

  function bookmarkletSource() {
    return [
      '(function(){',
      'if(!/logistics\\.amazon\\./.test(location.origin)){alert("Cortex (logistics.amazon.*) の画面で実行してください");return;}',
      'if(window.__OFK3_CORTEX_CAPTURE__&&window.__OFK3_CORTEX_CAPTURE__.start){window.__OFK3_CORTEX_CAPTURE__.start();return;}',
      'alert("OFK3 Cortex Capture 拡張を有効にするか、cortex-13-priority-core.js の次に cortex-13-capture-runner.js を Console へ貼ってください");',
      '})();'
    ].join('');
  }

  function copyBookmarklet() {
    var src = 'javascript:' + bookmarkletSource();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(src).then(function () { return true; });
    }
    return Promise.resolve(false);
  }

  function ingestJsonText(text, opts) {
    opts = opts || {};
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'JSON_PARSE', message: 'JSONを解析できません' };
    }
    var cacheKey = opts.cacheKey || (parsed.localDate || '') + ':' + text.length;
    if (!opts.refresh) {
      var cached = cacheGet(cacheKey);
      if (cached) {
        cached.fromCache = true;
        return cached;
      }
    } else {
      cacheClear();
    }
    var result = core().ingestBundle(parsed);
    result.fromCache = false;
    cacheSet(cacheKey, result);
    return result;
  }

  var Cortex13Priority = {
    CACHE_TTL_MS: CACHE_TTL_MS,
    cacheClear: cacheClear,
    bookmarkletSource: bookmarkletSource,
    copyBookmarklet: copyBookmarklet,
    ingestJsonText: ingestJsonText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Cortex13Priority;
  }
  global.Cortex13Priority = Cortex13Priority;
})(typeof window !== 'undefined' ? window : global);
