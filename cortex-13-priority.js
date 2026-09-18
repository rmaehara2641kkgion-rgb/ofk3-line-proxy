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
    var fmtSrc = (core() && typeof core().formatFetchReport === 'function')
      ? core().formatFetchReport.toString()
      : 'function formatFetchReport(s){s=s||{};return "Cortex取得完了";}';
    return [
      '(async()=>{',
      'try{',
      fmtSrc + ';',
      'const origin=location.origin;',
      'if(!/logistics\\.amazon\\./.test(origin)){alert("Cortex (logistics.amazon.*) の画面で実行してください");return;}',
      'const params=new URLSearchParams(location.search);',
      'let serviceAreaId=params.get("serviceAreaId")||params.get("serviceAreaID")||"";',
      'const m=location.href.match(/serviceAreaId=([0-9a-f-]{36})/i);',
      'if(!serviceAreaId&&m)serviceAreaId=m[1];',
      'if(!serviceAreaId){alert("serviceAreaId がURLから取れませんでした");return;}',
      'const localDate=params.get("localDate")||new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());',
      'function httpErr(status){if(status===401)return{error:"UNAUTHORIZED",message:"UNAUTHORIZED"};if(status===403)return{error:"FORBIDDEN",message:"FORBIDDEN"};return{error:"HTTP_"+status,message:"HTTP "+status};}',
      'function save(obj){try{const blob=new Blob([JSON.stringify(obj,null,0)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="cortex-13-bundle_"+localDate+".json";a.click();return true;}catch(err){return false;}}',
      'const sumUrl=origin+"/operations/execution/api/route-summaries?historicalDay=false&localDate="+encodeURIComponent(localDate)+"&serviceAreaId="+encodeURIComponent(serviceAreaId)+"&statsFromSummaries=true";',
      'const sumRes=await fetch(sumUrl,{credentials:"include"});',
      'if(!sumRes.ok){const e=httpErr(sumRes.status);const saved=save({localDate,authError:e.error,httpStatus:sumRes.status,totalRouteCount:0,selectedRouteCount:0,details:[],failures:[{error:e.error,httpStatus:sumRes.status,message:e.message}]});alert(formatFetchReport({summariesOk:false,summariesStatus:sumRes.status,summariesError:e.error,saved:saved}));return;}',
      'const summaries=await sumRes.json();',
      'const rows=summaries.rmsRouteSummaries||[];',
      'const selected=[];',
      'for(const row of rows){',
      '  const dep=Number(row.plannedDepartureTime);',
      '  if(!dep)continue;',
      '  const hp=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Tokyo",hour:"numeric",hour12:false}).formatToParts(new Date(dep));',
      '  const hour=Number((hp.find(function(p){return p.type==="hour";})||{}).value);',
      '  if(hour===11)selected.push(row);',
      '}',
      'const failures=[]; const details=[];',
      'for(const row of selected){',
      '  const detUrl=origin+"/operations/execution/api/route-details/"+encodeURIComponent(row.routeId)+"?historicalDay=false&routeId="+encodeURIComponent(row.routeId)+"&serviceAreaId="+encodeURIComponent(serviceAreaId);',
      '  try{',
      '    const r=await fetch(detUrl,{credentials:"include"});',
      '    if(!r.ok){const e=httpErr(r.status);failures.push({routeId:row.routeId,routeCode:row.routeCode,error:e.error,httpStatus:r.status,message:e.message});continue;}',
      '    details.push(await r.json());',
      '  }catch(err){failures.push({routeId:row.routeId,routeCode:row.routeCode,error:"NETWORK",message:"NETWORK"});} ',
      '}',
      'const saved=save({localDate,totalRouteCount:rows.length,selectedRouteCount:selected.length,summaries,details,failures});',
      'alert(formatFetchReport({summariesOk:true,totalRouteCount:rows.length,selectedRouteCount:selected.length,successCount:details.length,failureCount:failures.length,failures:failures,saved:saved}));',
      '}catch(e){alert("取得失敗: "+(e&&e.message||e));}',
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
