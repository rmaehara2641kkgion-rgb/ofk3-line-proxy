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
    var c = core() || {};
    function fn(name, fallback) {
      return (typeof c[name] === 'function') ? c[name].toString() : fallback;
    }
    return [
      '(function(){',
      'if(!/logistics\\.amazon\\./.test(location.origin)){alert("Cortex (logistics.amazon.*) の画面で実行してください");return;}',
      fn('createCaptureStore', 'function createCaptureStore(){return {summaries:null,detailsByRouteId:{},failures:[]};}') + ';',
      fn('isCortexApiCaptureUrl', 'function isCortexApiCaptureUrl(u){return /route-summaries|route-details/.test(String(u||""));}') + ';',
      fn('routeIdFromDetailsUrl', 'function routeIdFromDetailsUrl(u){var m=String(u||"").match(/\\/route-details\\/([^/?#]+)/);return m?m[1]:"";}') + ';',
      fn('applyCapturedCortexResponse', 'function applyCapturedCortexResponse(s){return s;}') + ';',
      fn('secretCaptureKey', 'function secretCaptureKey(k){k=String(k||"").toLowerCase();return k==="cookie"||k==="authorization"||k.indexOf("hmac")>=0||k.indexOf("x-cortex-")===0;}') + ';',
      fn('sanitizeCapturedJson', 'function sanitizeCapturedJson(v){return v;}') + ';',
      fn('buildCaptureBundle', 'function buildCaptureBundle(s){return {details:[],failures:[]};}') + ';',
      'if(window.__OFK3_CORTEX_CAPTURE__){window.__OFK3_CORTEX_CAPTURE__.show();return;}',
      'const params=new URLSearchParams(location.search);',
      'const localDate=params.get("localDate")||new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());',
      'const store=createCaptureStore();',
      'function saveBundle(){',
      '  const bundle=buildCaptureBundle(store,{localDate:localDate});',
      '  if(!(bundle.summaries||(bundle.details&&bundle.details.length))){alert("まだ捕捉できていません。Cortex一覧を再表示してから対象Routeをクリックしてください");return false;}',
      '  try{const blob=new Blob([JSON.stringify(bundle)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="cortex-13-bundle_"+localDate+".json";a.click();alert("Cortex捕捉完了\\nsummaries: "+(bundle.summaries?"あり":"なし")+"\\ndetails: "+(bundle.details||[]).length+"\\nfailures: "+(bundle.failures||[]).length+"\\n\\nJSONを保存しました。");return true;}catch(err){alert("JSON保存に失敗しました。");return false;}',
      '}',
      'function paint(){',
      '  var s=document.getElementById("ofk3-cortex-sum");',
      '  var d=document.getElementById("ofk3-cortex-det");',
      '  if(s)s.textContent=store.summaries?"捕捉済":"未捕捉";',
      '  if(d)d.textContent=String(Object.keys(store.detailsByRouteId).length);',
      '}',
      'function note(url,status,body){applyCapturedCortexResponse(store,{url:url,status:status,body:body});paint();}',
      'var origFetch=window.fetch;',
      'window.fetch=function(input){',
      '  var url="";try{if(typeof input==="string")url=input;else if(input&&typeof input.url==="string")url=input.url;else if(input&&typeof input.href==="string")url=input.href;}catch(e1){}',
      '  return origFetch.apply(this,arguments).then(function(res){',
      '    var u=url||res.url||"";',
      '    if(isCortexApiCaptureUrl(u)){res.clone().json().then(function(body){note(u,res.status,body);}).catch(function(){});}',
      '    return res;',
      '  });',
      '};',
      'var xhrOpen=XMLHttpRequest.prototype.open;',
      'var xhrSend=XMLHttpRequest.prototype.send;',
      'XMLHttpRequest.prototype.open=function(method,url){this.__ofk3Url=url;return xhrOpen.apply(this,arguments);};',
      'XMLHttpRequest.prototype.send=function(){',
      '  this.addEventListener("load",function(){',
      '    var u=this.__ofk3Url||this.responseURL||"";',
      '    if(!isCortexApiCaptureUrl(u))return;',
      '    var body=null;try{body=JSON.parse(this.responseText);}catch(e2){return;}',
      '    note(u,this.status,body);',
      '  });',
      '  return xhrSend.apply(this,arguments);',
      '};',
      'var box=document.createElement("div");',
      'box.id="ofk3-cortex-capture-panel";',
      'box.setAttribute("style","position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;padding:12px;font:12px/1.5 sans-serif;border-radius:8px;max-width:280px;");',
      'box.innerHTML="<b>OFK3 Cortex捕捉</b><div>summaries: <span id=\\"ofk3-cortex-sum\\">未捕捉</span></div><div>details: <span id=\\"ofk3-cortex-det\\">0</span></div><div style=\\"margin:8px 0;opacity:.85\\">APIは呼びません。一覧を再表示してからRouteをクリックし、JSON保存。</div>";',
      'var btn=document.createElement("button");btn.type="button";btn.textContent="JSON保存";btn.setAttribute("style","margin-right:8px;");btn.onclick=saveBundle;',
      'var close=document.createElement("button");close.type="button";close.textContent="閉じる";close.onclick=function(){box.style.display="none";};',
      'box.appendChild(btn);box.appendChild(close);',
      'document.documentElement.appendChild(box);',
      'window.__OFK3_CORTEX_CAPTURE__={show:function(){box.style.display="block";paint();},save:saveBundle};',
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
