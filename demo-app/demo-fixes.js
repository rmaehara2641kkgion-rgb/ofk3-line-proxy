// Demo-only fixes. Production logic and tenko flow stay untouched.
(function() {
  function toast(msg) {
    if (typeof window._demoToast === 'function') { window._demoToast(msg); return; }
    if (typeof _demoToast === 'function') { _demoToast(msg); return; }
    console.log(msg);
  }

  function installFreeAddressFix() {
    var originalStart = window.startDemoAddrSearchFree;
    if (typeof originalStart === 'function' && !originalStart._demoFixed) {
      var wrappedStart = function() {
        originalStart();
        var inputEl = document.getElementById('addr-free-input');
        var addr = inputEl && inputEl.value ? inputEl.value.trim() : '';
        if (!addr && typeof DEMO_ADDR_FREE !== 'undefined' && DEMO_ADDR_FREE) addr = DEMO_ADDR_FREE.address || '';
        window.addrFreeCurrentAddress = addr;
        try { addrFreeCurrentAddress = addr; } catch(e) {}
      };
      wrappedStart._demoFixed = true;
      window.startDemoAddrSearchFree = wrappedStart;
    }

    window.sendFreeAddressToLine = function() {
      var inputEl = document.getElementById('addr-free-input');
      var addr = window.addrFreeCurrentAddress || '';
      if (!addr) {
        try { addr = addrFreeCurrentAddress || ''; } catch(e) {}
      }
      if (!addr && inputEl && inputEl.value) addr = inputEl.value.trim();
      if (!addr) {
        toast('先に住所デモ枠をクリックしてください');
        return;
      }

      window.addrFreeCurrentAddress = addr;
      try { addrFreeCurrentAddress = addr; } catch(e) {}
      if (inputEl) inputEl.value = addr;

      if (typeof openDmModal !== 'function') {
        toast('LINE送信画面を開けませんでした');
        return;
      }
      openDmModal('');

      var templateEl = document.getElementById('dm-template-select');
      if (templateEl) templateEl.value = 'map_free';
      if (typeof applyDmTemplate === 'function') applyDmTemplate();

      var addrEl = document.getElementById('dm-seihaisou-addr');
      if (addrEl) addrEl.value = addr;
      if (typeof geocodeDmAddress === 'function') geocodeDmAddress('seihaisou');
    };
  }

  function showLatOnly() {
    var dnr = document.getElementById('dnr-section');
    if (dnr) {
      dnr.classList.add('hidden');
      dnr.style.display = 'none';
    }

    var dnrIds = ['dnr-dashboard', 'dnr-map-section', 'dnr-detail-section'];
    var latIds = ['lat-summary', 'lat-driver-summary', 'lat-timeline-visual'];
    var i;
    var el;
    for (i = 0; i < dnrIds.length; i++) {
      el = document.getElementById(dnrIds[i]);
      if (el) el.classList.add('hidden');
    }
    for (i = 0; i < latIds.length; i++) {
      el = document.getElementById(latIds[i]);
      if (el) el.classList.remove('hidden');
    }

    var divider = document.getElementById('quality-dnr-lat-divider');
    if (divider) divider.classList.remove('hidden');
    var hero = document.getElementById('quality-hero');
    if (hero) hero.style.display = 'none';
    var summary = document.getElementById('quality-summary');
    if (summary) summary.classList.remove('hidden');
  }

  function installLatFix() {
    window.startDemoLat = function() {
      if (typeof _seedLatData === 'function') _seedLatData();
      if (!window.latResultData) window.latResultData = [];
      try { latResultData = window.latResultData; } catch(e) {}
      try { demoLatLoaded = true; } catch(e) {}

      showLatOnly();
      if (!window.latResultData.length) {
        toast('LATデモデータを読み込めませんでした');
        return;
      }

      if (typeof renderLatResults === 'function') {
        try { renderLatResults(); } catch(e) { console.log('Demo LAT render error', e); }
      }
      if (typeof updateQualitySummary === 'function') {
        try { updateQualitySummary(); } catch(e) {}
      }

      showLatOnly();
      var latSection = document.getElementById('lat-summary');
      if (latSection && latSection.scrollIntoView) latSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('デモ：LAT 12件を表示しています');
    };

    var zone = document.getElementById('lat-drop-zone');
    if (zone) {
      zone.style.cursor = 'pointer';
      zone.onclick = function(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        window.startDemoLat();
      };
      zone.ondrop = function(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        window.startDemoLat();
      };
    }
  }

  function refreshIcons() {
    if (typeof getDemoDriverIcon !== 'function') return;
    window.getDriverIcon = getDemoDriverIcon;
    try { getDriverIcon = getDemoDriverIcon; } catch(e) {}

    if (typeof _seedDemoLineProfiles === 'function') {
      try { _seedDemoLineProfiles(); } catch(e) {}
    }
    if (typeof renderMasterTable === 'function') {
      try { renderMasterTable(); } catch(e) { console.log('Demo master icon refresh error', e); }
    }
    if (typeof renderDriverTable === 'function') {
      try { renderDriverTable(); } catch(e) {}
    }
    if (typeof renderDashboard === 'function' && typeof assignmentData !== 'undefined' && assignmentData.length > 0) {
      try { renderDashboard(); } catch(e) {}
    }
  }

  function installIconFix() {
    try { localStorage.removeItem('lineProfileCache'); } catch(e) {}
    refreshIcons();
  }

  function installAll() {
    installFreeAddressFix();
    installLatFix();
    installIconFix();
  }

  installAll();
  window.addEventListener('load', function() {
    installAll();
    setTimeout(function() {
      installFreeAddressFix();
      installLatFix();
      refreshIcons();
    }, 1100);
  });
})();
