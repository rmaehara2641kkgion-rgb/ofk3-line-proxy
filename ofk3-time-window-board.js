/**
 * OFK3 本日の時間指定（13:00まで）掲示用印刷ボード.
 * 本日のダッシュボード → 時間指定 詳細・印刷 → Routeカード掲示（A4横）を提供する。
 * 独立描画のみ。body監視・setIntervalなし。既存ダッシュボードDOMは書き換えない
 * （固定IDのボタン/オーバーレイを追加するだけ）。テンプレートリテラルは使用しない
 * （プロジェクト規約: Edge IEモード互換のため文字列連結のみ）。
 *
 * 対象データの定義（重要）:
 *  📦時間指定タブの抽出機能は「午前指定・11時台出発・別部隊引渡し」など
 *  既存業務固有のフィルタを持つ別機能であり、本モジュールはそれを呼ばない・使わない。
 *  抽出タブの結果配列も読まない。
 *  本モジュールは assignmentData + cycleDetailData[routeCode] を直接集計し、
 *  「有効な timeWindow かつ parsed.endMin <= 780（13:00）」の Tracking 行のみを対象にする。
 *  広域時間窓を「全日」として機械除外するルールは採用しない（根拠不明のため）。
 *  Cortex 必達判定は使わない・表示しない（別概念）。
 *
 * cycleDetailData 構造（index.html handleCycleDataUpload と同一）:
 *   各行は Tracking / 時間窓 / Stop 等のフィールドを持つ。
 *   時間指定なしは timeWindow === '' → parse 不可で対象外。
 *   1 Tracking 行 = 13:00まで 1個。Stop件数は表示しない（実データで Stop 列が空の場合あり）。
 *
 * データソース:
 *  - assignmentData … routeCode / driverName / totalDeliveries / allDestinations / area
 *  - cycleDetailData … 時間指定 Tracking 行
 *  - routeAreas … route.area が空のときの既存エリア（住所からの新規解析はしない）
 */
(function () {
  'use strict';

  var BTN_WRAP_ID = 'ofk3-tw-board-btn-wrap';
  var OVERLAY_ID = 'ofk3-tw-board-overlay';
  var CONTENT_ID = 'ofk3-tw-board-content';
  var ANCHOR_ID = 'ofk3-cortex13-dash-card';
  // 13:00 = 13*60 分。終了時刻がこれ以下の時間指定のみ掲示対象。
  var END_LIMIT_MIN = 780;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function todayIso() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  function todayDisplay() {
    return todayIso().split('-').join('/');
  }

  function nowClockJst() {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date());
  }

  // "9:00-13:00" 等 → {start, end, startMin, endMin}
  // 既存 twParseTimeWindow（index.html）と同一の書式想定。利用可能ならそちらを呼ぶ。
  function localParseWindow(tw) {
    var s = String(tw || '');
    var m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*[-–〜～]\s*(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!m) return null;
    var sh = parseInt(m[1], 10), sm = parseInt(m[2], 10), eh = parseInt(m[3], 10), em = parseInt(m[4], 10);
    if (!isFinite(sh) || !isFinite(sm) || !isFinite(eh) || !isFinite(em)) return null;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return {
      start: pad(sh) + ':' + pad(sm),
      end: pad(eh) + ':' + pad(em),
      startMin: sh * 60 + sm,
      endMin: eh * 60 + em
    };
  }

  function parseWindow(tw) {
    try {
      if (typeof twParseTimeWindow === 'function') {
        var r = twParseTimeWindow(tw);
        if (r && typeof r.startMin === 'number' && typeof r.endMin === 'number') return r;
        return null;
      }
    } catch (e) {}
    return localParseWindow(tw);
  }

  function isUntil1300(parsed) {
    return !!(parsed && typeof parsed.endMin === 'number' && parsed.endMin <= END_LIMIT_MIN);
  }

  function getAssignmentData() {
    try {
      if (typeof assignmentData !== 'undefined' && Array.isArray(assignmentData)) return assignmentData;
    } catch (e) {}
    return [];
  }

  function getCycleDetailData() {
    try {
      if (typeof cycleDetailData !== 'undefined' && cycleDetailData && typeof cycleDetailData === 'object') return cycleDetailData;
    } catch (e) {}
    return {};
  }

  function getRouteAreasMap() {
    try {
      if (typeof routeAreas !== 'undefined' && routeAreas && typeof routeAreas === 'object') return routeAreas;
    } catch (e) {}
    return {};
  }

  function routeArea(route, areas, rc) {
    if (route && route.area) return String(route.area);
    if (Object.prototype.hasOwnProperty.call(areas, rc) && areas[rc]) return String(areas[rc]);
    return '-';
  }

  function buildBoard() {
    var routes = getAssignmentData();
    var detail = getCycleDetailData();
    var areas = getRouteAreasMap();
    var hasAssign = routes.length > 0;
    var hasCycle = Object.keys(detail).length > 0;

    var routeList = [];
    routes.forEach(function (route) {
      var rc = String((route && route.routeCode) || '');
      if (!rc) return;
      var items = detail[rc] || [];
      var untilCount = 0;
      items.forEach(function (it) {
        var parsed = parseWindow(it && it.timeWindow);
        if (!parsed) return;
        if (!isUntil1300(parsed)) return;
        untilCount += 1;
      });
      if (untilCount <= 0) return;

      routeList.push({
        routeCode: rc,
        driverName: (route && route.driverName) || '',
        area: routeArea(route, areas, rc),
        until1300Count: untilCount,
        totalDeliveries: Number(route && route.totalDeliveries) || 0,
        allDestinations: Number(route && route.allDestinations) || 0
      });
    });

    routeList.sort(function (a, b) {
      return a.routeCode.localeCompare(b.routeCode, 'en', { numeric: true });
    });

    var emptyReason = '';
    if (!hasAssign || !hasCycle) {
      emptyReason = 'NEED_DATA';
    } else if (!routeList.length) {
      emptyReason = 'NO_TW';
    }

    return {
      dateDisplay: todayDisplay(),
      routeList: routeList,
      hasAssign: hasAssign,
      hasCycle: hasCycle,
      emptyReason: emptyReason
    };
  }

  function buildReportHtml(board) {
    var html = '';
    html += '<div class="tw-board-root" style="font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;color:#111;">';
    html += '<div style="text-align:center;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px;">';
    html += '<div style="font-size:22px;font-weight:800;letter-spacing:0.02em;">OFK3</div>';
    html += '<div style="font-size:20px;font-weight:800;margin-top:2px;">本日の時間指定</div>';
    html += '<div style="font-size:18px;font-weight:800;color:#b91c1c;margin-top:2px;">13:00まで</div>';
    html += '<div style="font-size:15px;margin-top:6px;">' + esc(board.dateDisplay) + '</div>';
    html += '<div style="font-size:13px;font-weight:800;margin-top:6px;">積み込み前に必ず確認してください</div>';
    html += '<div style="font-size:11px;color:#555;margin-top:6px;">※13:00までの時間指定があるRouteのみ掲載</div>';
    html += '</div>';

    if (!board.routeList.length) {
      if (board.emptyReason === 'NEED_DATA') {
        html += '<div style="text-align:center;padding:48px 12px;font-size:15px;color:#444;">';
        html += 'アサインExcelとサイクルExcelを読み込んでから再度開いてください。';
        html += '<br><span style="font-size:12px;color:#666;">（未読込のため「0件」とは断定していません）</span>';
        html += '</div>';
      } else {
        html += '<div style="text-align:center;padding:60px 0;font-size:18px;color:#444;">本日の時間指定（13:00まで）はありません</div>';
      }
      html += '</div>';
      return html;
    }

    html += '<div class="tw-board-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">';
    board.routeList.forEach(function (r) {
      html += '<div class="tw-board-card" style="break-inside:avoid;page-break-inside:avoid;-webkit-column-break-inside:avoid;border:2px solid #1e293b;border-radius:8px;padding:12px 14px;background:#fff;min-height:160px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">';
      html += '<div style="font-size:28px;font-weight:900;font-family:monospace;letter-spacing:0.02em;line-height:1.1;">' + esc(r.routeCode) + '</div>';
      html += '<div style="font-size:14px;font-weight:700;text-align:right;line-height:1.2;">' + esc(r.driverName || '-') + '</div>';
      html += '</div>';
      html += '<div style="font-size:12px;color:#334155;margin-top:8px;line-height:1.35;">' + esc(r.area) + '</div>';
      html += '<div style="margin-top:12px;text-align:center;border-top:1px solid #cbd5e1;padding-top:10px;">';
      html += '<div style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:0.04em;">13:00まで</div>';
      html += '<div style="font-size:36px;font-weight:900;color:#b91c1c;line-height:1.05;margin-top:2px;">' + r.until1300Count + '<span style="font-size:18px;font-weight:800;margin-left:2px;">個</span></div>';
      html += '</div>';
      html += '<div style="margin-top:10px;text-align:center;font-size:12px;color:#475569;">全体 '
        + r.totalDeliveries + '個 / ' + r.allDestinations + '件</div>';
      html += '</div>';
    });
    html += '</div>';

    html += '<div style="margin-top:10px;padding-top:6px;border-top:1px solid #ccc;display:flex;justify-content:space-between;font-size:10px;color:#666;">';
    html += '<span>※ 住所・氏名・電話・Tracking ID は掲示しません。Stop件数は表示しません。</span>';
    html += '<span>出力: ' + esc(nowClockJst()) + '　掲載 ' + board.routeList.length + ' Route</span>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  function ensureOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('section');
    el.id = OVERLAY_ID;
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,0.5);';
    var inner = document.createElement('div');
    inner.style.cssText = 'position:absolute;top:20px;left:50%;transform:translateX(-50%);width:min(1100px,calc(100vw - 24px));max-height:calc(100vh - 40px);overflow:auto;background:#fff;color:#111;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,0.35);';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;z-index:1;';
    bar.innerHTML = ''
      + '<b style="font-size:14px;">時間指定 詳細・掲示用一覧（13:00まで）</b>'
      + '<div style="display:flex;gap:8px;">'
      + '<button type="button" data-tw-board="print" style="padding:6px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;">印刷する（A4横）</button>'
      + '<button type="button" data-tw-board="close" style="padding:6px 14px;background:#e5e7eb;color:#111;border:none;border-radius:6px;font-size:12px;cursor:pointer;">閉じる</button>'
      + '</div>';
    var content = document.createElement('div');
    content.id = CONTENT_ID;
    content.style.cssText = 'padding:16px;';
    inner.appendChild(bar);
    inner.appendChild(content);
    el.appendChild(inner);
    el.addEventListener('click', function (ev) {
      if (ev.target === el) hideOverlay();
    });
    bar.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-tw-board');
      if (a === 'close') hideOverlay();
      else if (a === 'print') printBoard();
    });
    document.body.appendChild(el);
    return el;
  }

  function hideOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
  }

  var lastBoard = null;

  function openBoard() {
    try {
      lastBoard = buildBoard();
      var el = ensureOverlay();
      var content = document.getElementById(CONTENT_ID);
      content.innerHTML = buildReportHtml(lastBoard);
      el.style.display = 'block';
    } catch (e) {
      try { console.error('OFK3TimeWindowBoard.open error:', e); } catch (e2) {}
      alert('時間指定一覧の表示中にエラーが発生しました。');
    }
  }

  // 既存 openPrintPreview()/printTable() と同一パターン（別ウィンドウ + document.write + A4 landscape）
  function printBoard() {
    try {
      var board = lastBoard || buildBoard();
      var reportHtml = buildReportHtml(board);
      var printWindow = window.open('', '_blank', 'width=1100,height=800');
      if (!printWindow) {
        alert('ポップアップがブロックされました。ブラウザ設定をご確認ください。');
        return;
      }
      var doc = ''
        + '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
        + '<title>OFK3 本日の時間指定（13:00まで）</title>'
        + '<style>'
        + '*{margin:0;padding:0;box-sizing:border-box;}'
        + 'body{padding:14px;font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;}'
        + '.tw-board-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;}'
        + '.tw-board-card{break-inside:avoid;page-break-inside:avoid;-webkit-column-break-inside:avoid;}'
        + '@media print{'
        + 'body{padding:6mm;}'
        + '@page{size:A4 landscape;margin:8mm;}'
        + '.tw-board-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}'
        + '.tw-board-card{break-inside:avoid;page-break-inside:avoid;}'
        + '}'
        + '</style></head><body>'
        + reportHtml
        + '<script>window.onload=function(){window.print();};<\/script>'
        + '</body></html>';
      printWindow.document.write(doc);
      printWindow.document.close();
    } catch (e) {
      try { console.error('OFK3TimeWindowBoard.print error:', e); } catch (e2) {}
      alert('印刷処理中にエラーが発生しました。');
    }
  }

  function insertButton() {
    if (document.getElementById(BTN_WRAP_ID)) return;
    var anchor = document.getElementById(ANCHOR_ID);
    var html = ''
      + '<div id="' + BTN_WRAP_ID + '" class="card p-4 mb-4" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">'
      + '<div><p class="text-sm font-medium">時間指定 詳細・印刷</p>'
      + '<p class="text-xs text-ink-lighter mt-1">13:00までの時間指定をRouteカードで掲示印刷（A4横・最大6 Route/頁）</p></div>'
      + '<button type="button" data-tw-board-open="1" style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;">時間指定 詳細・印刷</button>'
      + '</div>';
    try {
      if (anchor && anchor.insertAdjacentHTML) {
        anchor.insertAdjacentHTML('afterend', html);
      } else {
        var host = document.getElementById('dashboard-content') || document.body;
        host.insertAdjacentHTML('afterbegin', html);
      }
      var wrap = document.getElementById(BTN_WRAP_ID);
      if (wrap) {
        wrap.addEventListener('click', function (ev) {
          var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-tw-board-open');
          if (a) openBoard();
        });
      }
    } catch (e) {}
  }

  function boot() {
    try { insertButton(); } catch (e) {}
  }

  window.OFK3TimeWindowBoard = {
    open: openBoard,
    close: hideOverlay,
    print: printBoard,
    buildBoard: buildBoard,
    buildReportHtml: buildReportHtml,
    parseWindow: parseWindow,
    isUntil1300: isUntil1300,
    END_LIMIT_MIN: END_LIMIT_MIN,
    onDashboardRender: insertButton
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
