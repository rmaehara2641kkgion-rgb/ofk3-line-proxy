/**
 * OFK3 MANUAL ASSIGN BOARD — UI配線（DOM操作）
 *
 * ロジックは manual-assign-board-core.js（UI非依存）と、マニフェスト解析は
 * 既存の assign-support-core.js#parseManifestWorkbook() を再利用する。
 * ここでは Cycle タブ切替・Route一覧描画・Clipboardコピー・コピー済み表示のみを扱う。
 *
 * v1時点でAmazon Name（右ペイン）は未実装（シフト表の構造確認後に対応）。
 * Cortexの自動操作・自動アサインは一切行わない。
 */
(function () {
  'use strict';

  var state = {
    boardRoutes: [],   // ManualAssignBoardCore.buildBoardRoutesFromManifestRoutes() の出力
    groups: [],         // ManualAssignBoardCore.groupRoutesByCycle() の出力
    selectedGroupKey: null,
    copiedDa: {}         // routeCode -> true（Clipboardへコピー済み。Assign完了の意味ではない）
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
    renderManualAssignBoard();
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
  }

  window.handleManualAssignManifestUpload = handleManualAssignManifestUpload;
  window.mabSelectCycle = mabSelectCycle;
  window.mabCopyDaNumbers = mabCopyDaNumbers;
  window.renderManualAssignBoard = renderManualAssignBoard;
})();
