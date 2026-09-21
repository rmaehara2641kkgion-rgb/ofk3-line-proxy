/**
 * OFK3 本日の時間指定 詳細・掲示用印刷ボード.
 * 本日のダッシュボード → 時間指定 詳細 → 掲示用一覧(A4横印刷) を提供する。
 * 独立描画のみ。body監視・setIntervalなし。既存ダッシュボードDOMは書き換えない
 * （固定IDのボタン/オーバーレイを追加するだけ）。テンプレートリテラルは使用しない
 * （プロジェクト規約: Edge IEモード互換のため文字列連結のみ）。
 *
 * 対象データの定義（重要）:
 *  twExtract()（📦時間指定タブ）は「13:00まで・11時台出発・別部隊引渡し」という
 *  既存業務固有のフィルタを持つ別機能であり、本モジュールはこれを呼ばない・使わない。
 *  本モジュールは assignmentData + cycleDetailData[routeCode] を直接集計し、
 *  当日の全Routeが持つ時間指定荷物（時間帯を問わない）を対象にする。
 *
 * cycleDetailData の実データ構造（tests/manual-assign-board-core.test.mjs の
 * sequencedRoute_* 実データヘッダーで確認済み。位置は index.html handleCycleDataUpload
 * と同一。推測ではなく実データヘッダーに基づく）:
 *   ヘッダー行: ['Stop','Tracking ID','Time (min)','Arrival','Time Window','Address',...]
 *   データ行例: ['1','DA0000000001','5','9:00','9:00-13:00','アドレスA',...]
 *   → cycleDetailData[routeCode] = [{ trackingId, address, timeWindow, stop }]
 *   → timeWindow は "H:MM-H:MM"（秒付き・全角/半角ダッシュ違いあり得る）。
 *     時間指定なし荷物は timeWindow === ''（index.html: row[4] ? ... : ''）。
 *   この判別は既存の twParseTimeWindow() と同じ正規表現を用いる（新規判定を作らない）。
 *
 * データソース:
 *  - assignmentData（let, index.htmlのアサインデータ）… routeCode/driverName
 *  - cycleDetailData（let, index.html）… routeCode -> [{trackingId,address,timeWindow,stop}]
 *  - routeAreas（let, index.html）… routeCode -> area（既存値のみ使用。住所からの新規エリア判定はしない）
 *  - window.OFK3Cortex13.getStops()/getEntry()（存在すれば）… 既に13:00判定済みのStopのみ。
 *    ここでは判定ロジックを一切再実装せず、件数を数える・trackingId一致を見るだけ。
 *    本日分のCortexデータが無い場合は「未取得」として0件と区別する。
 * 上記let宣言グローバルはindex.htmlのインライン<script>のトップレベルで宣言されており、
 * 後から読み込む本ファイル（別<script src>）からも同一グローバルスコープを通じて
 * bare識別子で参照できる（両方ともmodule化されていない classic script のため）。
 * 未読込・例外時は空データへ安全にフォールバックする。
 */
(function () {
  'use strict';

  var BTN_WRAP_ID = 'ofk3-tw-board-btn-wrap';
  var OVERLAY_ID = 'ofk3-tw-board-overlay';
  var CONTENT_ID = 'ofk3-tw-board-content';
  var ANCHOR_ID = 'ofk3-cortex13-dash-card';
  var ALL_DAY_SPAN_MIN = 720; // 既存twExtract()と同じ「全日指定は対象外」閾値(12h)

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

  // "9:00-13:00" 等 → {start:'09:00', end:'13:00', startMin, endMin}
  // 既存 twParseTimeWindow（index.html）と同一の書式想定・同一の正規表現。
  // 新しいtimeWindow判定は作らず、既存関数が利用可能ならそちらをそのまま呼ぶ。
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

  // ===== グローバルデータの安全取得（let宣言はwindowに乗らないため、bare識別子をtry/catchで参照） =====
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

  // Cortex 13:00必達の「取得状況」を判定する。ここでの目的は既存判定結果の集計のみ、
  // 判定ロジック自体（windowEndTime/DROP_OFF/JST等）には一切触れない。
  // 戻り値: { available: boolean, stopsByRoute: {routeCode:[stopEntry,...]}, trackingIdSet: Set }
  function getCortexSnapshot() {
    var out = { available: false, stopsByRoute: {}, trackingIdSet: {} };
    try {
      var api = window.OFK3Cortex13;
      if (!api || typeof api.getEntry !== 'function' || typeof api.getStops !== 'function') return out;
      var entry = api.getEntry();
      if (!entry || String(entry.localDate || '') !== todayIso()) return out; // 本日分でなければ「未取得」扱い
      out.available = true;
      var stops = api.getStops() || [];
      stops.forEach(function (s) {
        var rc = String((s && s.routeCode) || '');
        if (!rc) return;
        if (!out.stopsByRoute[rc]) out.stopsByRoute[rc] = [];
        out.stopsByRoute[rc].push(s);
        (Array.isArray(s.trackingIds) ? s.trackingIds : []).forEach(function (tid) {
          var t = String(tid || '').trim();
          if (t) out.trackingIdSet[t] = true;
        });
      });
    } catch (e) {}
    return out;
  }

  function buildBoard() {
    var routes = getAssignmentData();
    var detail = getCycleDetailData();
    var areas = getRouteAreasMap();
    var cortex = getCortexSnapshot();

    var routeList = [];
    routes.forEach(function (route) {
      var rc = String((route && route.routeCode) || '');
      if (!rc) return;
      var items = detail[rc] || [];
      if (!items.length) return;

      // 集計キー: (stop, timeWindowラベル) 単位 = 「同一Stop・同一時間指定」を1行に集約。
      // Stop件数とPackage件数は別々に数える（混同しない）。
      var groupMap = {};
      var order = [];
      var stopSet = {};
      var packageCount = 0;
      items.forEach(function (it) {
        var parsed = parseWindow(it && it.timeWindow);
        if (!parsed) return; // 時間指定なし荷物（timeWindow===''含む）は対象外
        if (parsed.endMin - parsed.startMin >= ALL_DAY_SPAN_MIN) return; // 全日指定は対象外（既存twExtract()と同基準）

        var stopRaw = it && it.stop != null ? String(it.stop).trim() : '';
        var key = stopRaw + '#' + parsed.start + '-' + parsed.end;
        if (!groupMap[key]) {
          groupMap[key] = {
            stop: stopRaw || '-',
            label: parsed.start + '〜' + parsed.end,
            startMin: parsed.startMin,
            count: 0,
            cortexHit: false
          };
          order.push(key);
        }
        groupMap[key].count += 1;
        packageCount += 1;
        if (stopRaw) stopSet[stopRaw] = true;

        var tid = String((it && it.trackingId) || '').trim();
        if (tid && cortex.trackingIdSet[tid]) groupMap[key].cortexHit = true;
      });
      if (!order.length) return;

      var groups = order.map(function (k) { return groupMap[k]; });
      groups.sort(function (a, b) {
        if (a.startMin !== b.startMin) return a.startMin - b.startMin;
        var an = parseInt(a.stop, 10), bn = parseInt(b.stop, 10);
        if (isFinite(an) && isFinite(bn)) return an - bn;
        return String(a.stop).localeCompare(String(b.stop), 'en', { numeric: true });
      });

      var area = Object.prototype.hasOwnProperty.call(areas, rc) && areas[rc] ? areas[rc] : '-';
      var driverName = (route && route.driverName) || '';
      var cortexStopCount = cortex.available
        ? ((cortex.stopsByRoute[rc] || []).length)
        : null; // null = 未取得（0件と区別する）

      routeList.push({
        routeCode: rc,
        driverName: driverName,
        area: area,
        stopCount: Object.keys(stopSet).length,
        packageCount: packageCount,
        cortexStopCount: cortexStopCount,
        groups: groups
      });
    });

    routeList.sort(function (a, b) {
      return a.routeCode.localeCompare(b.routeCode, 'en', { numeric: true });
    });

    return { dateDisplay: todayDisplay(), routeList: routeList, cortexAvailable: cortex.available };
  }

  function cortexBadgeText(n) {
    return n == null ? '未取得' : (n + ' Stop');
  }

  function buildReportHtml(board) {
    var html = '';
    html += '<div style="font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;color:#111;">';
    html += '<div style="text-align:center;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px;">';
    html += '<div style="font-size:24px;font-weight:800;letter-spacing:0.02em;">OFK3　本日の時間指定一覧</div>';
    html += '<div style="font-size:16px;margin-top:4px;">' + esc(board.dateDisplay) + '</div>';
    html += '<div style="font-size:13px;font-weight:800;color:#b91c1c;margin-top:6px;">積み込み前に必ず確認してください</div>';
    html += '</div>';

    if (!board.cortexAvailable) {
      html += '<div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 10px;margin-bottom:12px;">';
      html += '※ Cortex本日データ未取得のため「13:00必達」は未取得と表示しています（0件ではありません）。時間指定一覧自体は有効です。';
      html += '</div>';
    }

    if (!board.routeList.length) {
      html += '<div style="text-align:center;padding:60px 0;font-size:18px;color:#444;">本日の時間指定はありません</div>';
      html += '</div>';
      return html;
    }

    board.routeList.forEach(function (r) {
      html += '<div style="break-inside:avoid;page-break-inside:avoid;border:1px solid #999;border-radius:6px;margin-bottom:12px;overflow:hidden;">';
      html += '<div style="background:#1d4ed8;color:#fff;padding:8px 12px;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline;justify-content:space-between;">';
      html += '<div style="font-size:19px;font-weight:800;">' + esc(r.routeCode) + '　<span style="font-size:14px;font-weight:600;">' + esc(r.driverName || '-') + '</span></div>';
      html += '<div style="font-size:13px;">エリア：' + esc(r.area) + '</div>';
      html += '<div style="font-size:13px;font-weight:700;">時間指定：' + r.stopCount + ' Stop / ' + r.packageCount + ' Package'
        + '　　<span style="' + (r.cortexStopCount ? 'color:#fde047;' : '') + '">13:00必達：' + esc(cortexBadgeText(r.cortexStopCount)) + '</span></div>';
      html += '</div>';

      html += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
      html += '<thead><tr style="background:#e5e7eb;">';
      html += '<th style="border:1px solid #ccc;padding:4px 8px;text-align:left;width:30%;">時間帯</th>';
      html += '<th style="border:1px solid #ccc;padding:4px 8px;text-align:center;width:20%;">Stop</th>';
      html += '<th style="border:1px solid #ccc;padding:4px 8px;text-align:center;width:20%;">件数</th>';
      html += '</tr></thead><tbody>';
      r.groups.forEach(function (g) {
        html += '<tr style="break-inside:avoid;page-break-inside:avoid;">';
        html += '<td style="border:1px solid #ccc;padding:4px 8px;font-family:monospace;">' + esc(g.label)
          + (g.cortexHit ? '　<span style="color:#b91c1c;font-weight:800;font-size:11px;">★13:00必達</span>' : '') + '</td>';
        html += '<td style="border:1px solid #ccc;padding:4px 8px;text-align:center;font-family:monospace;">' + esc(g.stop) + '</td>';
        html += '<td style="border:1px solid #ccc;padding:4px 8px;text-align:center;font-weight:600;">' + g.count + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
      html += '</div>';
    });

    html += '<div style="margin-top:8px;padding-top:6px;border-top:1px solid #ccc;display:flex;justify-content:space-between;font-size:10px;color:#666;">';
    html += '<span>※ 掲示用一覧のため、住所・氏名・電話番号・Tracking ID等の個人情報は表示していません（エリア名のみ）</span>';
    html += '<span>出力: ' + esc(nowClockJst()) + '</span>';
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
      + '<b style="font-size:14px;">時間指定 詳細・掲示用一覧</b>'
      + '<div style="display:flex;gap:8px;">'
      + '<button type="button" data-tw-board="print" style="padding:6px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;">🖶 印刷する</button>'
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

  // 既存 openPrintPreview()/printTable() と同一の安全パターン
  // （別ウィンドウ → document.write → @page A4 landscape → window.print()）を踏襲。
  // メインページへの print CSS 追加は行わない。
  function printBoard() {
    try {
      var board = lastBoard || buildBoard();
      var reportHtml = buildReportHtml(board);
      var printWindow = window.open('', '_blank', 'width=1000,height=700');
      if (!printWindow) {
        alert('ポップアップがブロックされました。ブラウザ設定をご確認ください。');
        return;
      }
      var doc = ''
        + '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
        + '<title>OFK3 本日の時間指定一覧</title>'
        + '<style>'
        + '*{margin:0;padding:0;box-sizing:border-box;}'
        + 'body{padding:14px;}'
        + '@media print{body{padding:6mm;}@page{size:A4 landscape;margin:8mm;}}'
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
      + '<div><p class="text-sm font-medium">🖨 時間指定 詳細・印刷</p>'
      + '<p class="text-xs text-ink-lighter mt-1">本日の時間指定をRoute別に集計し、A4横で掲示印刷できます。</p></div>'
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
    // renderDashboard()末尾から既存のtry/catchパターンで呼ばれる。
    // ボタンが無ければ再挿入するだけの冪等処理（DOM監視の代替として明示呼び出しのみで完結させる）。
    onDashboardRender: insertButton
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
