// TransportID照合の一致結果を、点呼照合タブへ切替後も見えるようにする。
(function() {
  'use strict';
  var lastSignature = '';
  var toastTimer = null;
  function removeExistingToast() { var old = document.getElementById('tenko-transport-success-toast'); if (old && old.parentNode) old.parentNode.removeChild(old); }
  function showSuccessToast(text) {
    removeExistingToast();
    var toast = document.createElement('div');
    toast.id = 'tenko-transport-success-toast';
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:100000;min-width:340px;max-width:92vw;padding:16px 20px;border:2px solid #16a34a;border-radius:12px;background:#f0fdf4;color:#15803d;box-shadow:0 12px 30px rgba(0,0,0,.22);font-size:14px;font-weight:700;text-align:center;';
    toast.innerHTML = '<div style="font-size:17px;margin-bottom:4px;">✅ TransportID照合：一致</div><div style="font-size:13px;font-weight:600;">' + text + '</div>';
    document.body.appendChild(toast);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(removeExistingToast, 8000);
  }
  function mirrorToTenkoMatch(panel) {
    var matchPanel = document.getElementById('panel-tenko-match'); if (!matchPanel) return;
    var mirror = document.getElementById('tenko-transport-audit-mirror');
    if (!mirror) { mirror = document.createElement('div'); mirror.id = 'tenko-transport-audit-mirror'; mirror.className = 'card p-4 mb-4 border-2 border-emerald-400 bg-emerald-50'; matchPanel.insertBefore(mirror, matchPanel.firstChild); }
    mirror.innerHTML = panel.innerHTML;
  }
  function inspectPanel() {
    var panel = document.getElementById('tenko-transport-audit-panel'); if (!panel) return;
    var text = panel.textContent || ''; if (text.indexOf('TransportID照合：一致') < 0) return;
    var signature = text.replace(/\s+/g, ' ').trim(); if (!signature || signature === lastSignature) return; lastSignature = signature;
    var countMatch = signature.match(/一致\s*(\d+)名\s*\/\s*不一致\s*0名\s*\/\s*Amazon側未確認\s*(\d+)名/);
    var message = countMatch ? 'Amazonスケジュールで確認できたシフト登録者のTransportIDはすべて一致しています（一致 ' + countMatch[1] + '名 / Amazon側未確認 ' + countMatch[2] + '名）' : 'Amazonスケジュールで確認できたシフト登録者のTransportIDはすべて一致しています';
    showSuccessToast(message); mirrorToTenkoMatch(panel);
  }
  function startObserver() { inspectPanel(); var observer = new MutationObserver(inspectPanel); observer.observe(document.body, { childList:true, subtree:true, characterData:true }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver); else startObserver();
})();

// CHAPPY OPS LINK Phase 1.4
// Sends the assignment snapshot plus route-level map centers already available
// in the OFK3 delivery app. No external AI receives this data.
(function () {
  'use strict';
  var URLS = ['http://127.0.0.1:3000/api/ops/snapshot','http://localhost:3000/api/ops/snapshot'];
  var lastHash = '';
  var lastEmptyLog = false;
  var lastAssignmentRef = null;
  var loadSequence = 0;

  function finiteNumber(value) { var n = Number(value); return Number.isFinite(n) ? n : null; }
  function firstNumber(row, keys) { for (var i=0;i<keys.length;i++) { if (row && row[keys[i]] != null && row[keys[i]] !== '') { var n=finiteNumber(row[keys[i]]); if (n != null) return n; } } return null; }
  function firstText(row, keys) { for (var i=0;i<keys.length;i++) { if (row && row[keys[i]] != null && String(row[keys[i]]).trim()) return String(row[keys[i]]).trim(); } return ''; }

  function routeMapCenter(route) {
    var directLat = firstNumber(route, ['lat','latitude','routeLat','areaLat','lastLat','endLat']);
    var directLon = firstNumber(route, ['lon','lng','longitude','routeLon','routeLng','areaLon','areaLng','lastLon','lastLng','endLon','endLng']);
    if (directLat != null && directLon != null) return { lat:directLat, lon:directLon, source:'assignment-coordinate', address:firstText(route,['lastAddress','endAddress','routeAddress','address','primaryAddress']) };

    try {
      var addresses = (typeof cycleData !== 'undefined' && route.routeCode && Array.isArray(cycleData[route.routeCode])) ? cycleData[route.routeCode] : [];
      var sumLat=0, sumLon=0, count=0;
      for (var i=0;i<addresses.length;i++) {
        var coord = (typeof cachedOrFallbackCoord === 'function') ? cachedOrFallbackCoord(addresses[i]) : null;
        if (coord && finiteNumber(coord.lat) != null && finiteNumber(coord.lng) != null) { sumLat += Number(coord.lat); sumLon += Number(coord.lng); count++; }
      }
      if (count > 0) return { lat:sumLat/count, lon:sumLon/count, source:'route-address-center', address: route.area || '' };
    } catch (e) { console.warn('[CHAPPY OPS] route center failed:', route.routeCode, e.message || e); }

    try {
      if (route.area && typeof getAreaCenter === 'function') {
        var areaCoord = getAreaCenter(route.area);
        if (areaCoord && finiteNumber(areaCoord.lat) != null && finiteNumber(areaCoord.lng) != null) return { lat:Number(areaCoord.lat), lon:Number(areaCoord.lng), source:'area-center', address:route.area };
      }
    } catch (e2) {}
    return { lat:null, lon:null, source:'none', address:route.area || '' };
  }

  function buildSnapshot() {
    var rows = (typeof assignmentData !== 'undefined' && Array.isArray(assignmentData)) ? assignmentData : [];
    if (rows !== lastAssignmentRef) { lastAssignmentRef = rows; loadSequence++; }
    var eventId = 'assignment-' + loadSequence;
    return {
      version: 3,
      source: 'OFK3_DELIVERY',
      eventId: eventId,
      updatedAt: new Date().toISOString(),
      routes: rows.map(function(r) {
        var map = routeMapCenter(r);
        return {
          routeCode:r.routeCode || '', driverName:r.driverName || '', area:r.area || '', serviceType:r.serviceType || '',
          totalDeliveries:Number(r.totalDeliveries)||0, allDestinations:Number(r.allDestinations)||0, departure:r.departure || '',
          capability:r.capability == null ? null : Number(r.capability), predictedEnd:r.predictedEnd || '', status:r.status || 'unknown',
          lat:map.lat, lon:map.lon, mapAddress:map.address, mapSource:map.source
        };
      })
    };
  }

  async function publish(force) {
    var payload;
    try { payload = buildSnapshot(); } catch(e) { console.warn('[CHAPPY OPS] snapshot build failed:', e.message || e); return {ok:false,error:String(e.message||e)}; }
    if (!payload.routes.length) { if (!lastEmptyLog) { console.log('[CHAPPY OPS] bridge ready; waiting for assignment data'); lastEmptyLog=true; } return {ok:false,standby:true}; }
    lastEmptyLog=false;
    var stable = payload.eventId + '|' + JSON.stringify(payload.routes);
    if (!force && stable === lastHash) return {ok:true,unchanged:true};
    console.log('[CHAPPY OPS] sending ' + payload.routes.length + ' routes / ' + payload.eventId + '...');
    var lastError=null;
    for (var i=0;i<URLS.length;i++) {
      try {
        var res=await fetch(URLS[i],{method:'POST',mode:'cors',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
        if (!res.ok) throw new Error('CHAPPY HTTP ' + res.status);
        var body=await res.json(); lastHash=stable;
        console.log('[CHAPPY OPS] ONLINE via ' + URLS[i], body.summary || body); return body;
      } catch(e) { lastError=e; console.warn('[CHAPPY OPS] connection failed via ' + URLS[i] + ':', e.message || e); }
    }
    console.warn('[CHAPPY OPS] STANDBY:', lastError ? (lastError.message || lastError) : 'connection failed');
    return {ok:false,error:String(lastError && (lastError.message||lastError) || 'connection failed')};
  }

  window.CHAPPY_OPS_BRIDGE={publish:publish,snapshot:buildSnapshot};
  console.log('[CHAPPY OPS] production bridge loaded // MAP v1.4');
  setTimeout(function(){publish(true);},1200);
  setInterval(function(){publish(false);},2000);
})();
