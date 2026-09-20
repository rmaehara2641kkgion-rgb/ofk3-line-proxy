/**
 * OFK3 Cortex 13:00 priority UI.
 * Injected into the existing OFK3 app without modifying the large index.html.
 */
(function () {
  'use strict';
  var ID='ofk3-cortex13-ui', INLINE_ID='ofk3-cortex13-inline', state={entry:null,stops:[],mode:'time',map:null,markers:[]};

  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
  function today(){var p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return p;}
  function group(packages){
    var m={};
    (packages||[]).forEach(function(p){
      var k=String(p.routeCode||'')+'#'+String(p.stop==null?'':p.stop);
      if(!m[k])m[k]={routeCode:p.routeCode||'',routeId:p.routeId||'',stop:p.stop,driverName:p.driverName||'',plannedEndClock:p.plannedEndClock||'',address:p.address||'',latitude:p.latitude,longitude:p.longitude,trackingIds:[]};
      if(p.trackingId)m[k].trackingIds.push(p.trackingId);
      if(!m[k].address&&p.address)m[k].address=p.address;
      if(m[k].latitude==null&&p.latitude!=null)m[k].latitude=p.latitude;
      if(m[k].longitude==null&&p.longitude!=null)m[k].longitude=p.longitude;
    });
    return Object.keys(m).map(function(k){return m[k];}).sort(function(a,b){var r=String(a.routeCode).localeCompare(String(b.routeCode),'en',{numeric:true});return r||Number(a.stop||0)-Number(b.stop||0);});
  }
  async function load(){
    var d=today(), status=document.getElementById('c13-status');
    if(status)status.textContent='読込中…';
    var reqUrl='/cortex-priority?localDate='+encodeURIComponent(d);
    console.log('[Cortex13 UI]\norigin='+location.origin+'\ntoday='+d+'\nrequest='+reqUrl);
    try{
      var r=await fetch(reqUrl,{cache:'no-store'});
      var j=await r.json();
      console.log('[Cortex13 UI] response httpStatus='+r.status+' jsonStatus='+(j&&j.status));
      if(!r.ok||j.status!=='ok'){
        var fallbackUrl=reqUrl+'&latest=1';
        console.log('[Cortex13 UI] fallbackRequest='+fallbackUrl);
        r=await fetch(fallbackUrl,{cache:'no-store'});
        j=await r.json();
        console.log('[Cortex13 UI] fallback response httpStatus='+r.status+' jsonStatus='+(j&&j.status)+' localDate='+(j&&j.localDate)+' stopCount='+(j&&j.stopCount)+' packageCount='+(j&&j.packageCount));
      }
      if(!r.ok||j.status!=='ok')throw new Error(j.message||'Cortexデータなし');
      state.entry=j;state.stops=group(j.packages);render();renderInline();
      if(state.mode==='dash') await renderMap();
    }catch(e){state.entry=null;state.stops=[];render();renderInline(e.message);var s=document.getElementById('c13-status');if(s)s.textContent=e.message;}
  }
  function csvCell(v){var s=String(v==null?'':v);return '"'+s.replace(/"/g,'""')+'"';}
  function exportCsv(){
    if(!state.entry)return alert('Cortex 13:00データがありません');
    var head=['日付','Route','Stop','Driver','予定到着','住所','Tracking ID','Stop内個数','緯度','経度'];
    var counts={};state.stops.forEach(function(s){counts[s.routeCode+'#'+s.stop]=s.trackingIds.length;});
    var rows=[head].concat((state.entry.packages||[]).map(function(p){return[
      state.entry.localDate,p.routeCode,p.stop,p.driverName,p.plannedEndClock,p.address,p.trackingId,
      counts[String(p.routeCode||'')+'#'+String(p.stop)]||1,p.latitude,p.longitude
    ];}));
    var text='\uFEFF'+rows.map(function(r){return r.map(csvCell).join(',');}).join('\r\n');
    var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));a.download='OFK3_Cortex_13時必達詳細_'+state.entry.localDate+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},1000);
  }
  async function geocodeStop(s){
    var lat=Number(s.latitude),lng=Number(s.longitude);
    if(Number.isFinite(lat)&&Number.isFinite(lng)&&!(lat===0&&lng===0))return s;
    if(!s.address)return s;
    try{var r=await fetch('/geocode?address='+encodeURIComponent(s.address));var j=await r.json();if(j.status==='ok'){s.latitude=Number(j.lat);s.longitude=Number(j.lng);}}catch(e){}
    return s;
  }
  async function ensureCoords(){
    var pending=state.stops.filter(function(s){var a=Number(s.latitude),b=Number(s.longitude);return !(Number.isFinite(a)&&Number.isFinite(b)&&!(a===0&&b===0))&&s.address;});
    for(var i=0;i<pending.length;i++)await geocodeStop(pending[i]);
  }
  function popup(s){return '<b>'+esc(s.routeCode)+' / Stop '+esc(s.stop)+'</b><br>'+esc(s.driverName)+'<br>予定 '+esc(s.plannedEndClock)+' / '+s.trackingIds.length+'個<br>'+esc(s.address)+'<br><small>'+esc(s.trackingIds.join(', '))+'</small>';}
  async function renderMap(){
    var host=document.getElementById('c13-map');if(!host)return;
    host.innerHTML='<div style="padding:12px">座標を準備中…</div>';
    await ensureCoords();
    var pts=state.stops.filter(function(s){var a=Number(s.latitude),b=Number(s.longitude);return Number.isFinite(a)&&Number.isFinite(b)&&!(a===0&&b===0);});
    if(!pts.length){host.innerHTML='<div style="padding:12px">地図化できる住所・座標がありません</div>';return;}
    host.innerHTML='';
    if(window.L&&typeof window.L.map==='function'){
      state.map=window.L.map(host);var layer=window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(state.map);
      var bounds=[];pts.forEach(function(s){var ll=[Number(s.latitude),Number(s.longitude)];bounds.push(ll);window.L.marker(ll).addTo(state.map).bindPopup(popup(s));});state.map.fitBounds(bounds,{padding:[20,20]});return;
    }
    if(window.google&&google.maps&&google.maps.Map){
      state.map=new google.maps.Map(host,{zoom:12,center:{lat:Number(pts[0].latitude),lng:Number(pts[0].longitude)}});
      var bounds=new google.maps.LatLngBounds();
      pts.forEach(function(s){var pos={lat:Number(s.latitude),lng:Number(s.longitude)},m=new google.maps.Marker({position:pos,map:state.map,title:s.routeCode+' Stop '+s.stop});bounds.extend(pos);var iw=new google.maps.InfoWindow({content:popup(s)});m.addListener('click',function(){iw.open({map:state.map,anchor:m});});});
      state.map.fitBounds(bounds);return;
    }
    host.innerHTML='<div style="padding:12px">既存MAPライブラリを検出できません。座標取得 '+pts.length+' / '+state.stops.length+' Stops</div>';
  }
  function render(){
    var root=document.getElementById(ID);if(!root)return;
    var e=state.entry, n=e?e.stopCount:0, p=e?e.packageCount:0;
    var body='';
    if(state.mode==='time'){
      body='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0"><b>13:00必達 '+n+' Stops / '+p+' Packages</b><span id="c13-status" style="opacity:.7">'+(e?'受信済 '+esc(e.localDate):'未読込')+'</span></div>';
      body+='<div style="max-height:340px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th>Route</th><th>Stop</th><th>Driver</th><th>個数</th><th>予定</th><th>住所</th></tr></thead><tbody>';
      state.stops.forEach(function(s){body+='<tr style="border-top:1px solid #ddd"><td>'+esc(s.routeCode)+'</td><td style="text-align:center">'+esc(s.stop)+'</td><td>'+esc(s.driverName)+'</td><td style="text-align:center">'+s.trackingIds.length+'</td><td>'+esc(s.plannedEndClock)+'</td><td>'+esc(s.address||'-')+'</td></tr>';});
      body+='</tbody></table></div>';
    }else{
      body='<div style="margin:8px 0"><b>13:00必達 MAP — '+n+' Stops / '+p+' Packages</b></div><div id="c13-map" style="height:430px;border:1px solid #ccc;border-radius:6px"></div>';
    }
    root.querySelector('.c13-body').innerHTML=body;
  }
  function findTimeWindowHeading(){
    var all=document.querySelectorAll('h1,h2,h3,h4,strong,b,div,span');
    for(var i=0;i<all.length;i++){var t=String(all[i].textContent||'').replace(/\s+/g,'');if(t==='時間指定抽出'||t.indexOf('時間指定抽出')===0)return all[i];}
    return null;
  }
  function renderInline(error){
    var h=findTimeWindowHeading();if(!h)return false;
    var host=document.getElementById(INLINE_ID);
    if(!host){
      host=document.createElement('section');host.id=INLINE_ID;
      host.style.cssText='margin:16px 0;padding:16px 20px;background:#fff;border:2px solid #2563eb;border-radius:14px;box-shadow:0 4px 14px rgba(37,99,235,.08)';
      var anchor=h.closest('section')||h.parentElement; if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(host,anchor.nextSibling);else h.insertAdjacentElement('afterend',host);
    }
    var e=state.entry,n=e?e.stopCount:0,p=e?e.packageCount:0;
    var html='<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><b style="font-size:18px">⚡ Cortex 13:00必達</b>';
    if(e) html+='<span style="font-weight:700;color:#2563eb">'+n+' Stops / '+p+' Packages</span><span style="opacity:.65">'+esc(e.localDate)+' 受信済</span>';
    else html+='<span style="color:#b45309">'+esc(error||'本日のCortexデータを確認中…')+'</span>';
    html+='<button type="button" data-c13-inline="reload" style="margin-left:auto">更新</button><button type="button" data-c13-inline="csv">詳細CSV</button><button type="button" data-c13-inline="map">MAP表示</button></div>';
    if(e){
      html+='<div style="margin-top:12px;max-height:420px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>No.</th><th>ルート</th><th>ドライバー</th><th>予定到着</th><th>個数</th><th>住所</th><th>Stop</th></tr></thead><tbody>';
      state.stops.forEach(function(s,i){html+='<tr style="border-top:1px solid #e5e7eb"><td>'+(i+1)+'</td><td>'+esc(s.routeCode)+'</td><td>'+esc(s.driverName||'-')+'</td><td>'+esc(s.plannedEndClock||'-')+'</td><td style="text-align:center">'+s.trackingIds.length+'</td><td>'+esc(s.address||'-')+'</td><td style="text-align:center">'+esc(s.stop)+'</td></tr>';});
      html+='</tbody></table></div>';
    }
    host.innerHTML=html;
    host.onclick=function(ev){var a=ev.target&&ev.target.getAttribute('data-c13-inline');if(a==='reload')load();else if(a==='csv')exportCsv();else if(a==='map')open('dash');};
    return true;
  }
  function syncTimeWindowTab(){
    if(!findTimeWindowHeading())return;
    renderInline();
    if(!state.entry)load();
  }
  function ensure(){
    if(document.getElementById(ID))return;
    var root=document.createElement('section');root.id=ID;root.style.cssText='position:fixed;right:14px;bottom:14px;z-index:99998;width:min(900px,calc(100vw - 28px));max-height:75vh;overflow:auto;background:#fff;color:#111;border:1px solid #aaa;border-radius:10px;padding:12px;box-shadow:0 4px 20px rgba(0,0,0,.25);display:none';
    root.innerHTML='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>Cortex 13:00必達</b><button type="button" data-a="time">時間指定</button><button type="button" data-a="dash">ダッシュボードMAP</button><button type="button" data-a="load">更新</button><button type="button" data-a="csv">詳細CSV</button><button type="button" data-a="close" style="margin-left:auto">閉じる</button></div><div class="c13-body"></div>';
    document.body.appendChild(root);
    root.addEventListener('click',function(ev){var a=ev.target&&ev.target.getAttribute('data-a');if(!a)return;if(a==='close'){root.style.display='none';return;}if(a==='csv'){exportCsv();return;}if(a==='load'){load();return;}if(a==='time'||a==='dash'){state.mode=a;render();if(a==='dash')renderMap();}});
    render();
  }
  function open(mode){ensure();state.mode=mode||'time';var r=document.getElementById(ID);r.style.display='block';render();load();}
  document.addEventListener('click',function(ev){
    var el=ev.target&&ev.target.closest&&ev.target.closest('button,a,[role="button"]');if(!el)return;var t=String(el.textContent||'').replace(/\s+/g,'');
    if(t.indexOf('時間指定')>=0)setTimeout(function(){open('time');},50);
    else if(t.indexOf('ダッシュボード')>=0)setTimeout(function(){open('dash');},50);
  },true);
  window.OFK3Cortex13={open:open,load:load,exportCsv:exportCsv};
  function boot(){ensure();syncTimeWindowTab();new MutationObserver(function(){syncTimeWindowTab();}).observe(document.body,{childList:true,subtree:true});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();