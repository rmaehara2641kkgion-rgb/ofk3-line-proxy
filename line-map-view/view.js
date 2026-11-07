(function () {
  'use strict';
  var bar = document.getElementById('bar');
  function fail(msg) { bar.className = 'err'; bar.textContent = msg; }
  // トークンはURLフラグメント(#...)。サーバーログ・Refererに載らない。読んだら履歴から消す。
  var token = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* noop */ }
  if (!token) { fail('このURLは無効です。LINEで「マップ」と送ると新しいURLが届きます。'); return; }
  fetch('/line-map/data', {
    method: 'POST', cache: 'no-store', credentials: 'omit',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token })
  }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._http = r.status; return d; }); })
    .then(function (d) {
      if (d.status !== 'ok') { fail(d.message || '表示できません。'); return; }
      if (typeof L === 'undefined') { fail('地図の読み込みに失敗しました。通信状況を確認してください。'); return; }
      bar.textContent = d.cycle + ' ' + d.routeCode + ' / ' + d.stopCount + '件（表示 ' + d.pins.length + '件）';
      if (d.missingCoordinateCount) bar.textContent += ' ※位置不明 ' + d.missingCoordinateCount + '件は非表示';
      var map = L.map('map', { zoomControl: true, tap: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'no-referrer' }).addTo(map);
      var pts = [];
      d.pins.forEach(function (p) {
        pts.push([p.lat, p.lng]);
        var el = document.createElement('div');
        el.textContent = '巡回 ' + p.pin + '番' + (p.packageCount ? ' / ' + p.packageCount + '個' : '') + (p.address ? '\n' + p.address : '');
        el.style.whiteSpace = 'pre-line';
        var pin = document.createElement('div');
        pin.className = 'pin';
        pin.textContent = String(p.pin); // 巡回番号。textContent でHTML注入を避ける
        L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: pin, iconSize: [28, 28], iconAnchor: [14, 14] }) })
          .addTo(map).bindPopup(el);
      });
      map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
    })
    .catch(function () { fail('通信に失敗しました。もう一度お試しください。'); });
})();
