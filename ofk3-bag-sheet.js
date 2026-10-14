/**
 * OFK3 cycle 2/3 BAG sheet.
 * Joins assignment + manifest + a cycle-bag document.
 * Does not read Cortex, does not write the 13:00 store, does not touch Mentor.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'ofk3CycleBag.v1';
  var OVERLAY_ID = 'ofk3-bag-sheet-overlay';
  var CONTENT_ID = 'ofk3-bag-sheet-content';
  var CYCLE_PREFIX = { DCX: 'C1', DMX: 'C2', DSX: 'C3' };
  var CYCLE_NAME = { C1: 'DCX', C2: 'DMX', C3: 'DSX' };
  var bagBucket = { byDate: {} };
  var openName = '';

  function cycleOfRouteCode(routeCode) {
    var m = String(routeCode || '').toUpperCase().match(/^([A-Z]+)/);
    if (!m) return '';
    return CYCLE_PREFIX[m[1]] || '';
  }

  function cycleName(cycle) {
    return CYCLE_NAME[cycle] || '';
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function tokyoDate(now) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(now || new Date());
    } catch (e) {
      return '';
    }
  }

  function hasBagIdentity(row) {
    if (!row) return false;
    return !!(row.bagNumber || row.bagName || row.bagDisplay);
  }

  // not_attempted and route_aborted were never read. captured_null is unknown, not loose.
  function classifyPlacement(row) {
    if (!row) return 'not_fetched';
    var status = row.bagStatus || '';
    if (hasBagIdentity(row) && (status === 'captured' || row.bagSource === 'trDetails' || row.bagSource === 'stop_dom')) {
      return 'in_bag';
    }
    if (!status || status === 'not_attempted' || status === 'route_aborted') return 'not_fetched';
    var outside = row.looseConfirmed === true &&
      row.packageBlockRead === true &&
      row.stopComplete !== true &&
      !hasBagIdentity(row) &&
      status !== 'captured';
    return outside ? 'outside' : 'unknown';
  }

  function readAssignment() {
    try {
      if (typeof assignmentData !== 'undefined' && Array.isArray(assignmentData)) return assignmentData;
    } catch (e) {}
    return null;
  }

  function readManifest() {
    try {
      if (typeof cycleDetailData !== 'undefined' && cycleDetailData && typeof cycleDetailData === 'object') {
        return cycleDetailData;
      }
    } catch (e) {}
    return null;
  }

  function manifestCount(manifest) {
    if (!manifest || typeof manifest !== 'object') return 0;
    var n = 0;
    Object.keys(manifest).forEach(function (k) {
      if (Array.isArray(manifest[k]) && manifest[k].length) n += 1;
    });
    return n;
  }

  function trackingIdsOf(items) {
    var out = [];
    var seen = {};
    (items || []).forEach(function (it) {
      var tid = String((it && (it.trackingId || it)) || '').trim();
      if (!tid || seen[tid]) return;
      seen[tid] = true;
      out.push(tid);
    });
    return out;
  }

  function bagLabel(row) {
    if (row && row.bagDisplay) return String(row.bagDisplay);
    var color = row && (row.bagColor || row.bagColorCode) ? String(row.bagColor || row.bagColorCode) : '';
    var num = row && row.bagNumber ? String(row.bagNumber) : '';
    return (color + (num ? ' ' + num : '')).trim();
  }

  function routesForDate(localDate) {
    var day = bagBucket.byDate && bagBucket.byDate[localDate];
    if (!day || !day.routes) return {};
    return day.routes;
  }

  function buildDriverSheet(opts) {
    opts = opts || {};
    var localDate = String(opts.localDate || '');
    var driverName = String(opts.driverName || '').trim();
    var assignment = opts.assignment;
    var manifest = opts.manifestByRoute;
    var sheet = {
      localDate: localDate,
      driverName: driverName,
      state: 'ok',
      notices: [],
      routes: []
    };
    if (!Array.isArray(assignment) || !assignment.length) {
      sheet.state = 'assignment_missing';
      sheet.notices.push('アサイン未読込。ダッシュボードでルート_OFK3を読み込んでください。');
      return sheet;
    }
    var mine = [];
    assignment.forEach(function (row) {
      if (!row || !row.routeCode) return;
      if (String(row.driverName || '').trim() !== driverName) return;
      mine.push(row);
    });
    if (!driverName || !mine.length) {
      sheet.state = 'driver_missing';
      sheet.notices.push('このドライバーの担当Routeはありません。');
      return sheet;
    }
    var manifestReady = !!(manifest && typeof manifest === 'object' && manifestCount(manifest) > 0);
    if (!manifestReady) {
      sheet.state = 'manifest_missing';
      sheet.notices.push('マニフェスト未読込。サイクルExcelを読み込んでください。');
    }
    var stored = routesForDate(localDate);
    var docDate = opts.bagDocumentDate || '';
    if (docDate && docDate !== localDate) {
      sheet.notices.push('読み込み済みのBAGは ' + docDate + ' です。表示中の配送日とは別です。');
    }
    mine.sort(function (a, b) {
      return String(a.routeCode).localeCompare(String(b.routeCode), 'en', { numeric: true });
    });
    mine.forEach(function (row) {
      var routeCode = String(row.routeCode);
      var cycle = cycleOfRouteCode(routeCode);
      var section = {
        routeCode: routeCode,
        driverName: driverName,
        cycle: cycle,
        cycleName: cycleName(cycle),
        bagState: 'not_fetched',
        bags: [],
        outside: [],
        undetermined: [],
        notFetched: [],
        bagCount: null,
        itemCount: null,
        notice: ''
      };
      if (cycle === 'C1') {
        section.bagState = 'out_of_scope';
        section.notice = 'サイクル1（DCX）は時間指定の帳票です。この帳票にはBAGを出しません。';
        sheet.routes.push(section);
        return;
      }
      if (cycle !== 'C2' && cycle !== 'C3') {
        section.bagState = 'out_of_scope';
        section.notice = 'サイクル不明。BAGは照合しません。';
        sheet.routes.push(section);
        return;
      }
      if (!manifestReady) {
        section.bagState = 'manifest_missing';
        section.notice = 'マニフェスト未読込';
        sheet.routes.push(section);
        return;
      }
      var items = manifest[routeCode];
      if (!Array.isArray(items) || !items.length) {
        section.bagState = 'manifest_missing';
        section.notice = 'このRouteのマニフェストがありません。';
        sheet.routes.push(section);
        return;
      }
      var das = trackingIdsOf(items);
      section.itemCount = das.length;
      var storedRoute = stored[routeCode] || null;
      if (!storedRoute || storedRoute.fetched !== true || storedRoute.cycle !== cycle) {
        section.bagState = 'not_fetched';
        section.notice = '未取得';
        sheet.routes.push(section);
        return;
      }
      var byDa = {};
      (storedRoute.packages || []).forEach(function (pkg) {
        if (!pkg) return;
        if (String(pkg.routeCode || routeCode) !== routeCode) return;
        if ((pkg.cycle || cycle) !== cycle) return;
        var tid = String(pkg.trackingId || '').trim();
        if (!tid || byDa[tid]) return;
        byDa[tid] = pkg;
      });
      var groups = {};
      var groupOrder = [];
      var routeAborted = false;
      das.forEach(function (tid) {
        var pkg = byDa[tid] || null;
        if (pkg && pkg.bagStatus === 'route_aborted') routeAborted = true;
        var place = pkg ? classifyPlacement(pkg) : 'not_fetched';
        if (place === 'in_bag') {
          var key = String(pkg.bagNumber || pkg.bagName || '') + '|' + String(pkg.bagColorCode || pkg.bagColor || '');
          if (!groups[key]) {
            groups[key] = {
              bagNumber: pkg.bagNumber || '',
              bagColor: pkg.bagColor || '',
              label: bagLabel(pkg),
              das: []
            };
            groupOrder.push(key);
          }
          groups[key].das.push(tid);
        } else if (place === 'outside') {
          section.outside.push(tid);
        } else if (place === 'unknown') {
          section.undetermined.push(tid);
        } else {
          section.notFetched.push(tid);
        }
      });
      section.bagState = 'fetched';
      section.bags = groupOrder.map(function (k) { return groups[k]; });
      section.bagCount = section.bags.length;
      if (routeAborted) section.notice = 'RouteのBAG取得が中断された荷物があります。';
      else if (!section.bags.length && !section.outside.length && !section.undetermined.length) section.notice = '未取得';
      sheet.routes.push(section);
    });
    return sheet;
  }

  function routeBlockHtml(section, localDate) {
    var html = '<section class="bag-route">';
    html += '<h2>' + esc(section.routeCode) + '</h2>';
    html += '<p>配送日 ' + esc(localDate || '—') + '</p>';
    html += '<p>サイクル ' + esc(section.cycleName || section.cycle || '不明') + (section.cycle ? ' / ' + esc(section.cycle) : '') + '</p>';
    html += '<p>担当ドライバー ' + esc(section.driverName || '') + '</p>';
    html += '<p>Route ' + esc(section.routeCode) + '</p>';
    if (section.notice) {
      html += '<p class="bag-notice">' + esc(section.notice) + '</p>';
    }
    if (section.bagState === 'fetched') {
      html += '<p>BAG数 ' + esc(section.bagCount) + ' / 商品数 ' + esc(section.itemCount) + '</p>';
      if (!section.bags.length) html += '<p>BAG番号・色: なし</p>';
      section.bags.forEach(function (bag) {
        html += '<h3>BAG ' + esc(bag.label || ((bag.bagColor || '') + ' ' + (bag.bagNumber || ''))) + '</h3>';
        html += '<p>BAG番号 ' + esc(bag.bagNumber || '—') + ' / 色 ' + esc(bag.bagColor || '—') + '</p>';
        html += '<p>DA番号</p><ul>';
        bag.das.forEach(function (da) { html += '<li>' + esc(da) + '</li>'; });
        html += '</ul>';
      });
      html += '<h3>BAG外</h3>';
      if (!section.outside.length) html += '<p>該当なし</p>';
      else {
        html += '<ul>';
        section.outside.forEach(function (da) { html += '<li>' + esc(da) + '</li>'; });
        html += '</ul>';
      }
      html += '<h3>不明</h3>';
      if (!section.undetermined.length) html += '<p>該当なし</p>';
      else {
        html += '<ul>';
        section.undetermined.forEach(function (da) { html += '<li>' + esc(da) + '</li>'; });
        html += '</ul>';
      }
      html += '<h3>未取得</h3>';
      if (!section.notFetched.length) html += '<p>該当なし</p>';
      else {
        html += '<ul>';
        section.notFetched.forEach(function (da) { html += '<li>' + esc(da) + '</li>'; });
        html += '</ul>';
      }
    }
    html += '</section>';
    return html;
  }

  function buildPrintHtml(sheet) {
    sheet = sheet || { notices: [], routes: [] };
    var html = '<article class="bag-sheet">';
    html += '<h1>荷物詳細</h1>';
    if (sheet.driverName) html += '<p>担当ドライバー ' + esc(sheet.driverName) + '</p>';
    html += '<p>配送日 ' + esc(sheet.localDate || '—') + '</p>';
    (sheet.notices || []).forEach(function (n) {
      html += '<p class="bag-notice">' + esc(n) + '</p>';
    });
    if (!sheet.routes.length && !(sheet.notices || []).length) {
      html += '<p class="bag-notice">未取得</p>';
    }
    (sheet.routes || []).forEach(function (section) {
      html += routeBlockHtml(section, sheet.localDate);
    });
    html += '</article>';
    return html;
  }

  function printCss() {
    return '@media print{body{padding:8mm;}@page{size:A4 portrait;margin:10mm;}.bag-route{break-after:page;page-break-after:always;}.bag-route:last-child{break-after:auto;page-break-after:auto;}}' +
      'body{font-family:sans-serif;color:#111;}' +
      'h1{font-size:18px;margin:0 0 8px;}h2{font-size:16px;margin:12px 0 4px;}h3{font-size:14px;margin:10px 0 4px;}' +
      'p,li{font-size:12px;line-height:1.45;}ul{margin:0 0 8px 1.2em;}' +
      '.bag-notice{font-weight:700;}' +
      '.bag-route{margin:0 0 16px;padding-bottom:8px;border-bottom:1px solid #ddd;}';
  }

  function currentSheet() {
    var dateEl = typeof document !== 'undefined' ? document.getElementById('ofk3-bag-date') : null;
    var localDate = dateEl && dateEl.value ? dateEl.value : tokyoDate();
    var dates = Object.keys((bagBucket && bagBucket.byDate) || {});
    return buildDriverSheet({
      localDate: localDate,
      driverName: openName,
      assignment: readAssignment(),
      manifestByRoute: readManifest(),
      bagDocumentDate: dates.length === 1 ? dates[0] : ''
    });
  }

  function paint() {
    var content = typeof document !== 'undefined' ? document.getElementById(CONTENT_ID) : null;
    if (!content) return;
    content.innerHTML = buildPrintHtml(currentSheet());
  }

  function openPrintWindow(title, bodyHtml) {
    var printWindow = global.open('', '_blank', 'width=900,height=800');
    if (!printWindow) {
      global.alert('ポップアップがブロックされました。ブラウザ設定をご確認ください。');
      return;
    }
    var doc = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>' +
      esc(title) + '</title><style>' + printCss() + '</style></head><body>' +
      bodyHtml + '<script>window.onload=function(){window.print();}<\/script></body></html>';
    printWindow.document.write(doc);
    printWindow.document.close();
  }

  function printDriver() {
    var sheet = currentSheet();
    openPrintWindow('荷物詳細 ' + (sheet.driverName || ''), buildPrintHtml(sheet));
  }

  function ensureOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('section');
    el.id = OVERLAY_ID;
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:99996;background:rgba(0,0,0,0.5);';
    var inner = document.createElement('div');
    inner.style.cssText = 'position:absolute;top:20px;left:50%;transform:translateX(-50%);width:min(900px,calc(100vw - 24px));max-height:calc(100vh - 40px);overflow:auto;background:#fff;color:#111;border-radius:10px;';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;z-index:1;';
    bar.innerHTML = '<b>荷物詳細</b>' +
      '<label>配送日 <input id="ofk3-bag-date" type="date"></label>' +
      '<button type="button" id="ofk3-bag-print">荷物詳細を印刷</button>' +
      '<button type="button" id="ofk3-bag-import">BAGファイルを読み込む</button>' +
      '<input id="ofk3-bag-file" type="file" accept="application/json,.json" style="display:none">' +
      '<button type="button" id="ofk3-bag-close">閉じる</button>';
    var content = document.createElement('div');
    content.id = CONTENT_ID;
    content.style.cssText = 'padding:16px;';
    inner.appendChild(bar);
    inner.appendChild(content);
    el.appendChild(inner);
    document.body.appendChild(el);
    document.getElementById('ofk3-bag-print').onclick = function () { printDriver(); };
    document.getElementById('ofk3-bag-close').onclick = function () { el.style.display = 'none'; };
    document.getElementById('ofk3-bag-date').onchange = function () { paint(); };
    document.getElementById('ofk3-bag-import').onclick = function () {
      document.getElementById('ofk3-bag-file').click();
    };
    document.getElementById('ofk3-bag-file').onchange = function (ev) {
      var file = ev.target && ev.target.files && ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var parsed = null;
        try { parsed = JSON.parse(String(reader.result || '')); } catch (e) { parsed = null; }
        var result = loadBagSnapshot(parsed);
        if (!result.ok) {
          global.alert(result.message);
          return;
        }
        var dateEl = document.getElementById('ofk3-bag-date');
        if (dateEl && result.localDate) dateEl.value = result.localDate;
        paint();
      };
      reader.readAsText(file);
    };
    return el;
  }

  function openDriver(driverName) {
    openName = String(driverName || '').trim();
    if (typeof document === 'undefined') return currentSheet();
    var el = ensureOverlay();
    var dateEl = document.getElementById('ofk3-bag-date');
    if (dateEl && !dateEl.value) dateEl.value = tokyoDate();
    paint();
    el.style.display = 'block';
    return currentSheet();
  }

  function persist() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bagBucket));
    } catch (e) {}
  }

  function loadStored() {
    try {
      if (typeof localStorage === 'undefined') return;
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.byDate && typeof parsed.byDate === 'object') bagBucket = parsed;
    } catch (e) {}
  }

  function loadBagSnapshot(doc) {
    if (!doc || doc.kind !== 'ofk3-cycle-bag' || !/^\d{4}-\d{2}-\d{2}$/.test(String(doc.localDate || ''))) {
      return { ok: false, message: 'BAGファイルの形式が違います。' };
    }
    var cleaned = { kind: 'ofk3-cycle-bag', version: 1, localDate: String(doc.localDate), routes: [] };
    (doc.routes || []).forEach(function (r) {
      if (!r || !r.routeCode) return;
      if (r.cycle !== 'C2' && r.cycle !== 'C3') return;
      var packages = [];
      (r.packages || []).forEach(function (pkg) {
        if (!pkg) return;
        packages.push({
          routeCode: String(pkg.routeCode || r.routeCode),
          trackingId: String(pkg.trackingId || '').trim(),
          referenceId: pkg.referenceId || null,
          bagName: pkg.bagName || null,
          bagNumber: pkg.bagNumber || null,
          bagColor: pkg.bagColor || null,
          bagColorCode: pkg.bagColorCode || null,
          bagDisplay: pkg.bagDisplay || null,
          bagStatus: pkg.bagStatus || 'not_attempted',
          bagSource: pkg.bagSource || null,
          stopStatus: pkg.stopStatus || null,
          stopComplete: pkg.stopComplete === true,
          looseConfirmed: pkg.looseConfirmed === true,
          packageBlockRead: pkg.packageBlockRead === true
        });
      });
      cleaned.routes.push({
        routeCode: String(r.routeCode),
        cycle: r.cycle,
        fetched: r.fetched === true,
        packages: packages
      });
    });
    var next = { byDate: {} };
    Object.keys(bagBucket.byDate || {}).forEach(function (date) {
      next.byDate[date] = { routes: Object.assign({}, bagBucket.byDate[date].routes || {}) };
    });
    if (!next.byDate[cleaned.localDate]) next.byDate[cleaned.localDate] = { routes: {} };
    cleaned.routes.forEach(function (r) {
      next.byDate[cleaned.localDate].routes[r.routeCode] = r;
    });
    bagBucket = next;
    persist();
    paintDashboardStatus();
    return { ok: true, localDate: cleaned.localDate, routeCount: cleaned.routes.length };
  }

  function clearBagSnapshot() {
    bagBucket = { byDate: {} };
    persist();
    paintDashboardStatus();
  }

  function paintDashboardStatus() {
    if (typeof document === 'undefined') return;
    var el = document.getElementById('ofk3-bag-dash-status');
    if (!el) return;
    var dates = Object.keys((bagBucket && bagBucket.byDate) || {});
    if (!dates.length) {
      el.textContent = 'BAGファイル未読込';
      return;
    }
    var parts = [];
    dates.forEach(function (date) {
      var routes = (bagBucket.byDate[date] && bagBucket.byDate[date].routes) || {};
      parts.push(date + ' ' + Object.keys(routes).length + 'Route');
    });
    el.textContent = 'BAG読込済み ' + parts.join(' / ');
  }

  function openImport() {
    if (typeof document === 'undefined') return;
    var el = ensureOverlay();
    var dateEl = document.getElementById('ofk3-bag-date');
    if (dateEl && !dateEl.value) dateEl.value = tokyoDate();
    paint();
    el.style.display = 'block';
    var file = document.getElementById('ofk3-bag-file');
    if (file) file.click();
  }

  loadStored();
  paintDashboardStatus();

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      if (t.id === 'ofk3-bag-dashboard-import') {
        ev.preventDefault();
        openImport();
        return;
      }
      var name = t.getAttribute('data-ofk3-bag-driver');
      if (!name) return;
      ev.preventDefault();
      openDriver(name);
    });
  }

  var api = {
    cycleOfRouteCode: cycleOfRouteCode,
    classifyPlacement: classifyPlacement,
    buildDriverSheet: buildDriverSheet,
    buildPrintHtml: buildPrintHtml,
    printCss: printCss,
    openDriver: openDriver,
    openImport: openImport,
    printDriver: printDriver,
    loadBagSnapshot: loadBagSnapshot,
    clearBagSnapshot: clearBagSnapshot,
    currentSheet: currentSheet
  };

  global.OFK3BagSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
