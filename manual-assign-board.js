/**
 * OFK3 MANUAL ASSIGN BOARD — UI配線（DOM操作）
 *
 * ロジックは manual-assign-board-core.js（UI非依存）と、マニフェスト解析は
 * 既存の assign-support-core.js#parseManifestWorkbook() を再利用する。
 * 左ペイン: Cycle タブ切替・Route一覧描画・DA番号Clipboardコピー・コピー済み表示。
 * 右ペイン: シフト表（点呼表）読込・選択中CycleのAmazon Name一覧・Clipboardコピー。
 *
 * 左右のペインは独立。Route→Amazon Nameの自動紐付け・自動Assignは行わない。
 * Cortexの自動操作も行わない。
 */
(function () {
  'use strict';

  var state = {
    boardRoutes: [],   // ManualAssignBoardCore.buildBoardRoutesFromManifestRoutes() の出力
    groups: [],         // ManualAssignBoardCore.groupRoutesByCycle() の出力
    selectedGroupKey: null,
    copiedDa: {},        // routeCode -> true（Clipboardへコピー済み。Assign完了の意味ではない）

    // ---- AMAZON NAME（右ペイン）。左ペインの状態とは独立に管理する ----
    tenkoSheets: [],     // ManualAssignBoardCore.parseTenkoRosterWorkbook() の出力（点呼表ごとに1件）
    selectedTenkoIndex: -1,
    tenkoCopiedName: {}   // transportId -> true（Clipboardへコピー済み）
  };

  function mabCopyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      var tmp = document.createElement('textarea');
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mabGroupLabel(key) {
    var map = { C1: 'C1 / DCX', C2: 'C2 / DMX', C3: 'C3 / DSX' };
    return map[key] || key;
  }

  function handleManualAssignManifestUpload(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        var manifestRoutes = AssignSupportCore.parseManifestWorkbook(wb);
        var boardRoutes = ManualAssignBoardCore.buildBoardRoutesFromManifestRoutes(manifestRoutes);

        // マニフェスト再投入時は前回の状態を完全にリセットする（古いカード・コピー済み表示を残さない）
        state.boardRoutes = boardRoutes;
        state.groups = ManualAssignBoardCore.groupRoutesByCycle(boardRoutes);
        state.copiedDa = {};
        state.selectedGroupKey = state.groups.length ? state.groups[0].key : null;
        var filterInput = document.getElementById('mab-filter-input');
        if (filterInput) filterInput.value = '';

        var statusEl = document.getElementById('mab-manifest-status');
        if (statusEl) {
          if (!boardRoutes.length) {
            statusEl.textContent = '⚠ sequencedRoute_* シートが見つかりませんでした';
            statusEl.className = 'text-xs mt-1 text-amber-600';
          } else {
            var totalDa = boardRoutes.reduce(function (s, r) { return s + r.count; }, 0);
            statusEl.textContent = '✅ ' + boardRoutes.length + 'ルート / DA ' + totalDa + '件 読込済み';
            statusEl.className = 'text-xs mt-1 text-emerald-600';
          }
        }
        renderManualAssignBoard();
      } catch (err) {
        console.error('[MANUAL ASSIGN BOARD] manifest parse failed', err);
        alert('マニフェストの読込に失敗しました: ' + (err && err.message ? err.message : err));
      }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = ''; // 同じファイルを再選択してもchangeが発火するように
  }

  function mabSelectCycle(key) {
    state.selectedGroupKey = key;
    renderManualAssignBoard(); // 右ペイン（Amazon Name）も選択中Cycleに連動して再描画される
  }

  function mabCopyDaNumbers(routeCode) {
    var route = null;
    for (var i = 0; i < state.boardRoutes.length; i++) {
      if (state.boardRoutes[i].routeCode === routeCode) { route = state.boardRoutes[i]; break; }
    }
    if (!route) return;
    mabCopyToClipboard(ManualAssignBoardCore.formatDaListForClipboard(route.daNumbers));
    state.copiedDa[routeCode] = true;
    renderManualAssignBoard();
  }

  function mabRouteRowHtml(route) {
    var copied = !!state.copiedDa[route.routeCode];
    return (
      '<div class="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border text-xs last:border-b-0">' +
        '<div class="flex items-center gap-2 min-w-0">' +
          '<span class="font-mono font-bold">' + escapeHtml(route.routeCode) + '</span>' +
          '<span class="text-ink-lighter whitespace-nowrap">' + route.count + '件</span>' +
          (copied ? '<span class="text-emerald-600 font-bold whitespace-nowrap">✓ COPY</span>' : '') +
        '</div>' +
        '<button type="button" class="btn-secondary text-xs px-2 py-1 rounded shrink-0" onclick=\'mabCopyDaNumbers(' + JSON.stringify(route.routeCode) + ')\'>DA番号コピー</button>' +
      '</div>'
    );
  }

  // ===========================================================================
  // AMAZON NAME（右ペイン）
  // ===========================================================================

  function handleManualAssignRosterUpload(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        var tenkoSheets = ManualAssignBoardCore.parseTenkoRosterWorkbook(wb, XLSX);

        // シフト表の再投入は右ペイン専用の状態のみをリセットする。
        // 左ペイン（マニフェスト/Route/DA番号コピー状態）は一切触らない。
        state.tenkoSheets = tenkoSheets;
        state.selectedTenkoIndex = tenkoSheets.length ? 0 : -1;
        state.tenkoCopiedName = {};
        var searchInput = document.getElementById('mab-tenko-search-input');
        if (searchInput) searchInput.value = '';

        var statusEl = document.getElementById('mab-roster-status');
        if (statusEl) {
          if (!tenkoSheets.length) {
            statusEl.textContent = '⚠ 点呼表シートが見つかりませんでした';
            statusEl.className = 'text-xs mt-1 text-amber-600';
          } else {
            var totalPeople = tenkoSheets.reduce(function (s, t) { return s + t.count; }, 0);
            statusEl.textContent = '✅ ' + tenkoSheets.length + '日分 / 計' + totalPeople + '名 読込済み';
            statusEl.className = 'text-xs mt-1 text-emerald-600';
          }
        }
        renderManualAssignBoard();
      } catch (err) {
        console.error('[MANUAL ASSIGN BOARD] shift table parse failed', err);
        alert('シフト表の読込に失敗しました: ' + (err && err.message ? err.message : err));
      }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = '';
  }

  function mabSelectTenkoDate(index) {
    state.selectedTenkoIndex = index;
    state.tenkoCopiedName = {}; // 日付切替時はコピー済み表示をリセットする（別日の状態を持ち越さない）
    var searchInput = document.getElementById('mab-tenko-search-input');
    if (searchInput) searchInput.value = '';
    renderManualAssignBoard();
  }

  function mabCopyAmazonName(transportId) {
    var sheet = state.tenkoSheets[state.selectedTenkoIndex];
    if (!sheet) return;
    var entry = sheet.entries.filter(function (e) { return e.transportId === transportId; })[0];
    if (!entry || !entry.amazonName) return;
    mabCopyToClipboard(entry.amazonName);
    state.tenkoCopiedName[transportId] = true;
    renderManualAssignBoard();
  }

  function mabAmazonNameRowHtml(entry) {
    if (!entry.resolved) {
      return (
        '<div class="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border text-xs last:border-b-0 opacity-60">' +
          '<span class="min-w-0 truncate">' + escapeHtml(entry.name || entry.transportId) + '</span>' +
          '<span class="text-amber-600 whitespace-nowrap shrink-0">Amazon Name未解決</span>' +
        '</div>'
      );
    }
    var copied = !!state.tenkoCopiedName[entry.transportId];
    return (
      '<div class="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border text-xs last:border-b-0">' +
        '<div class="flex items-center gap-2 min-w-0">' +
          '<span class="min-w-0 truncate">' + escapeHtml(entry.amazonName) + '</span>' +
          (copied ? '<span class="text-emerald-600 font-bold whitespace-nowrap">✓ COPY</span>' : '') +
        '</div>' +
        '<button type="button" class="btn-secondary text-xs px-2 py-1 rounded shrink-0" onclick=\'mabCopyAmazonName(' + JSON.stringify(entry.transportId) + ')\'>コピー</button>' +
      '</div>'
    );
  }

  function renderAmazonNamePane() {
    var headerEl = document.getElementById('mab-tenko-header');
    var dateSelectWrap = document.getElementById('mab-tenko-date-wrap');
    var searchWrap = document.getElementById('mab-tenko-search-wrap');
    var listEl = document.getElementById('mab-tenko-list');
    var emptyEl = document.getElementById('mab-tenko-empty');
    if (!listEl || !emptyEl) return;

    if (!state.tenkoSheets.length) {
      emptyEl.classList.remove('hidden');
      emptyEl.textContent = 'シフト表（点呼表）未読込のため、この欄は表示できません。上のアップロード欄からシフト表を読み込んでください。';
      listEl.innerHTML = '';
      if (headerEl) headerEl.textContent = '';
      if (dateSelectWrap) dateSelectWrap.innerHTML = '';
      if (searchWrap) searchWrap.classList.add('hidden');
      return;
    }

    if (state.selectedTenkoIndex < 0 || state.selectedTenkoIndex >= state.tenkoSheets.length) {
      state.selectedTenkoIndex = 0;
    }
    var sheet = state.tenkoSheets[state.selectedTenkoIndex];

    // 日付選択（複数シフト日が読み込まれている場合のみ表示）
    if (dateSelectWrap) {
      if (state.tenkoSheets.length > 1) {
        var options = state.tenkoSheets.map(function (t, idx) {
          var label = (t.dateLabel || t.sheetName) + '（' + t.count + '名）';
          return '<option value="' + idx + '"' + (idx === state.selectedTenkoIndex ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
        }).join('');
        dateSelectWrap.innerHTML = '<select class="text-xs px-2 py-1 rounded border border-border" onchange="mabSelectTenkoDate(parseInt(this.value,10))">' + options + '</select>';
      } else {
        dateSelectWrap.innerHTML = '';
      }
    }

    var cycleKey = state.selectedGroupKey;
    var cycleLabel = mabGroupLabel(cycleKey);
    var dateDisplay = sheet.dateLabel || sheet.sheetName;

    var cycleResult = ManualAssignBoardCore.buildAmazonNameRosterForCycle(
      sheet.entries, cycleKey, AssignSupportCore.filterWorkersByCycleEligibility
    );

    if (!cycleResult.cycleClassified) {
      if (headerEl) headerEl.textContent = escapeHtml(cycleLabel) + ' / ' + dateDisplay;
      if (searchWrap) searchWrap.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      emptyEl.textContent = 'このRouteグループ（' + cycleLabel + '）はCycle分類なしのため、対象者一覧は表示されません。';
      listEl.innerHTML = '';
      return;
    }
    emptyEl.classList.add('hidden');
    if (searchWrap) searchWrap.classList.remove('hidden');

    if (headerEl) {
      headerEl.textContent = cycleLabel + ' / ' + dateDisplay + '　対象 ' + cycleResult.roster.length + '名';
    }

    var searchInput = document.getElementById('mab-tenko-search-input');
    var searchText = searchInput ? searchInput.value.trim() : '';
    var filteredRoster = cycleResult.roster.filter(function (r) {
      if (!searchText) return true;
      return (r.amazonName && r.amazonName.indexOf(searchText) >= 0) ||
        (r.name && r.name.indexOf(searchText) >= 0);
    });

    if (!filteredRoster.length) {
      listEl.innerHTML = '<p class="text-xs text-ink-lighter px-1 py-4 text-center">該当する対象者がいません</p>';
    } else {
      listEl.innerHTML = filteredRoster.map(mabAmazonNameRowHtml).join('');
    }
  }

  function renderManualAssignBoard() {
    var emptyEl = document.getElementById('mab-empty');
    var boardEl = document.getElementById('mab-board');
    if (!boardEl) return;

    if (!state.boardRoutes.length) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      boardEl.classList.add('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    boardEl.classList.remove('hidden');

    // Cycleタブ
    var tabsEl = document.getElementById('mab-cycle-tabs');
    if (tabsEl) {
      var tabsHtml = '';
      for (var g = 0; g < state.groups.length; g++) {
        var group = state.groups[g];
        var active = group.key === state.selectedGroupKey;
        tabsHtml += '<button type="button" class="text-xs px-3 py-1.5 rounded-full ' +
          (active ? 'bg-amber-500 text-white font-bold' : 'bg-surface-secondary text-ink-lighter hover:bg-amber-100') +
          '" onclick=\'mabSelectCycle(' + JSON.stringify(group.key) + ')\'>' +
          escapeHtml(mabGroupLabel(group.key)) + '（' + group.routes.length + '）</button>';
      }
      tabsEl.innerHTML = tabsHtml;
    }

    var currentGroup = null;
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].key === state.selectedGroupKey) { currentGroup = state.groups[i]; break; }
    }
    if (!currentGroup && state.groups.length) currentGroup = state.groups[0];

    var filterInput = document.getElementById('mab-filter-input');
    var filterText = filterInput ? filterInput.value.trim().toUpperCase() : '';
    var routesInGroup = currentGroup ? currentGroup.routes : [];
    var filtered = routesInGroup.filter(function (r) {
      return !filterText || r.routeCode.toUpperCase().indexOf(filterText) >= 0;
    });

    var summaryEl = document.getElementById('mab-summary');
    if (summaryEl) {
      var totalDa = state.boardRoutes.reduce(function (s, r) { return s + r.count; }, 0);
      summaryEl.textContent = state.boardRoutes.length + 'ルート / DA ' + totalDa + '件（全体）' +
        (filterText ? ' / 絞り込み ' + filtered.length + '件表示' : '');
    }

    var listEl = document.getElementById('mab-routes-list');
    if (listEl) {
      if (!filtered.length) {
        listEl.innerHTML = '<p class="text-xs text-ink-lighter px-1 py-4 text-center">該当するRouteがありません</p>';
      } else {
        listEl.innerHTML = filtered.map(mabRouteRowHtml).join('');
      }
    }

    renderAmazonNamePane(); // 右ペインは選択中Cycleに連動して再描画（左ペインの状態は変更しない）
  }

  window.handleManualAssignManifestUpload = handleManualAssignManifestUpload;
  window.mabSelectCycle = mabSelectCycle;
  window.mabCopyDaNumbers = mabCopyDaNumbers;
  window.renderManualAssignBoard = renderManualAssignBoard;
  window.handleManualAssignRosterUpload = handleManualAssignRosterUpload;
  window.mabSelectTenkoDate = mabSelectTenkoDate;
  window.mabCopyAmazonName = mabCopyAmazonName;
  window.renderAmazonNamePane = renderAmazonNamePane;
})();
