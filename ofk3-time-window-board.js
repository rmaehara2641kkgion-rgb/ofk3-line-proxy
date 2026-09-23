/**
 * OFK3 本日の時間指定（13:00まで）掲示ボード.
 * A: 全体掲示表（Driver/Route/Area/配達数/目的地/13:00まで/対象巡回順）
 * B: Route別 個人詳細票（巡回順・DA番号・Driver Aid・バッグ・時間指定・住所）
 *    Driver Aid = packageAssistIndex.driverAid（route-details driverAssistText）
 *    バッグ = packageAssistIndex.bagDisplay（trDetails optional; なければ "-"）
 * 全体掲示表には DA / Driver Aid / バッグ / 住所を出さない。
 * 既存カード印刷も維持（副次表示）。
 *
 * 独立描画のみ。body監視・setIntervalなし。テンプレートリテラル不使用。
 *
 * 13:00対象:
 *   Cortex capture済みRoute（packageSequenceIndexにRouteあり）:
 *     既存 Cortex priority packages を正とし、
 *     routeCode + '\0' + trackingId 完全一致で CYCLE 明細と JOIN。
 *     （windowEnd exactly 13:00 かつ plannedEndTime <= 13:00 の抽出済み集合）
 *   Cortex未取得Route:
 *     従来どおり CYCLE timeWindow endMin <= 780（データ不足のため CYCLE 暫定）。
 * 巡回順: packageSequenceIndex を同キーで JOIN。
 * MAP / LINE / capture範囲は変更しない。
 */
(function () {
  'use strict';

  var BTN_WRAP_ID = 'ofk3-tw-board-btn-wrap';
  var OVERLAY_ID = 'ofk3-tw-board-overlay';
  var CONTENT_ID = 'ofk3-tw-board-content';
  var ANCHOR_ID = 'ofk3-cortex13-dash-card';
  var END_LIMIT_MIN = 780;
  var LABEL_NOT_CAPTURED = '未取得';
  var LABEL_NO_MATCH = '照合不可';
  var LABEL_NO_SEQ = '順番なし';

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

  function getPackageSequenceIndex() {
    try {
      if (typeof window !== 'undefined' && window.OFK3Cortex13 &&
          typeof window.OFK3Cortex13.getPackageSequenceIndex === 'function') {
        var list = window.OFK3Cortex13.getPackageSequenceIndex();
        return Array.isArray(list) ? list : [];
      }
    } catch (e) {}
    return [];
  }

  // Optional package assist (Driver Aid from route-details; bag from native trDetails).
  function getPackageAssistIndex() {
    try {
      if (typeof window !== 'undefined' && window.OFK3Cortex13 &&
          typeof window.OFK3Cortex13.getPackageAssistIndex === 'function') {
        var list = window.OFK3Cortex13.getPackageAssistIndex();
        return Array.isArray(list) ? list : [];
      }
    } catch (e) {}
    return [];
  }

  function buildAssistMap(indexList) {
    var byKey = {};
    (indexList || []).forEach(function (row) {
      if (!row) return;
      var rc = String(row.routeCode || '');
      var tid = String(row.trackingId || '').trim();
      if (!rc || !tid) return;
      byKey[joinKey(rc, tid)] = {
        driverAid: row.driverAid == null || row.driverAid === '' ? null : String(row.driverAid),
        bagDisplay: row.bagDisplay == null || row.bagDisplay === '' ? null : String(row.bagDisplay)
      };
    });
    return byKey;
  }

  function assistCell(value) {
    return value == null || value === '' ? '-' : String(value);
  }

  // Existing Cortex 13:00 priority packages (exact 13:00 windowEnd + plannedEnd <= 13:00).
  function getPriorityPackages() {
    try {
      if (typeof window !== 'undefined' && window.OFK3Cortex13) {
        if (typeof window.OFK3Cortex13.getPackages === 'function') {
          var list = window.OFK3Cortex13.getPackages();
          return Array.isArray(list) ? list : [];
        }
        var entry = typeof window.OFK3Cortex13.getEntry === 'function'
          ? window.OFK3Cortex13.getEntry() : null;
        if (entry && Array.isArray(entry.packages)) return entry.packages;
      }
    } catch (e) {}
    return [];
  }

  function buildPriorityKeySet(packages) {
    var set = {};
    (packages || []).forEach(function (p) {
      if (!p) return;
      var rc = String(p.routeCode || '');
      var tid = String(p.trackingId || '').trim();
      if (!rc || !tid) return;
      set[joinKey(rc, tid)] = true;
    });
    return set;
  }

  function routeArea(route, areas, rc) {
    if (route && route.area) return String(route.area);
    if (Object.prototype.hasOwnProperty.call(areas, rc) && areas[rc]) return String(areas[rc]);
    return '-';
  }

  function joinKey(rc, tid) {
    return String(rc || '') + '\0' + String(tid || '');
  }

  function uniqSortedNums(arr) {
    var seen = {};
    var out = [];
    (arr || []).forEach(function (n) {
      if (n == null || !isFinite(n)) return;
      if (seen[n]) return;
      seen[n] = true;
      out.push(Number(n));
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function buildSequenceMaps(indexList) {
    var byRoute = {};
    var byKey = {};
    (indexList || []).forEach(function (row) {
      if (!row) return;
      var rc = String(row.routeCode || '');
      var tid = String(row.trackingId || '').trim();
      if (!rc || !tid) return;
      byRoute[rc] = true;
      var k = joinKey(rc, tid);
      if (!byKey[k]) byKey[k] = [];
      var seq = row.sequenceNumber;
      if (seq == null || seq === '' || !isFinite(Number(seq))) byKey[k].push(null);
      else byKey[k].push(Number(seq));
    });
    return { byRoute: byRoute, byKey: byKey };
  }

  function resolvePackageSequence(rc, tid, maps) {
    if (!maps || !maps.byRoute || !maps.byRoute[rc]) {
      return { status: 'not_captured', sequenceNumber: null, label: LABEL_NOT_CAPTURED };
    }
    var seqs = maps.byKey[joinKey(rc, tid)];
    if (!seqs || !seqs.length) {
      return { status: 'no_match', sequenceNumber: null, label: LABEL_NO_MATCH };
    }
    var finite = seqs.filter(function (n) { return n != null && isFinite(n); });
    if (!finite.length) {
      return { status: 'no_seq', sequenceNumber: null, label: LABEL_NO_SEQ };
    }
    var uniq = uniqSortedNums(finite);
    return {
      status: 'ok',
      sequenceNumber: uniq[0],
      sequences: uniq,
      label: '#' + uniq[0]
    };
  }

  function buildBoard() {
    var routes = getAssignmentData();
    var detail = getCycleDetailData();
    var areas = getRouteAreasMap();
    var seqMaps = buildSequenceMaps(getPackageSequenceIndex());
    var assistByKey = buildAssistMap(getPackageAssistIndex());
    var priorityKeys = buildPriorityKeySet(getPriorityPackages());
    var hasAssign = routes.length > 0;
    var hasCycle = Object.keys(detail).length > 0;

    var routeList = [];
    routes.forEach(function (route) {
      var rc = String((route && route.routeCode) || '');
      if (!rc) return;
      var routeCaptured = !!seqMaps.byRoute[rc];
      var items = detail[rc] || [];
      var packages = [];
      items.forEach(function (it) {
        var tid = String((it && it.trackingId) || '').trim();
        if (!tid) return;
        var parsed = parseWindow(it && it.timeWindow);
        if (routeCaptured) {
          // Captured: Cortex priority set is authoritative (not CYCLE end<=13:00 alone).
          if (!priorityKeys[joinKey(rc, tid)]) return;
        } else {
          // Not captured (e.g. 09:00 Biker): keep CYCLE end<=13:00 provisional + 未取得.
          if (!parsed) return;
          if (!isUntil1300(parsed)) return;
        }
        var resolved = resolvePackageSequence(rc, tid, seqMaps);
        var assist = assistByKey[joinKey(rc, tid)] || null;
        var windowLabel = '';
        if (parsed) windowLabel = parsed.start + '-' + parsed.end;
        packages.push({
          trackingId: tid,
          timeWindow: String((it && it.timeWindow) || ''),
          address: String((it && it.address) || ''),
          sequenceStatus: resolved.status,
          sequenceNumber: resolved.sequenceNumber,
          sequenceLabel: resolved.label,
          windowLabel: windowLabel,
          driverAid: assist ? assist.driverAid : null,
          bagDisplay: assist ? assist.bagDisplay : null
        });
      });
      if (!packages.length) return;

      var okSeqs = [];
      packages.forEach(function (p) {
        if (p.sequenceStatus === 'ok' && p.sequenceNumber != null) okSeqs.push(p.sequenceNumber);
      });
      var sequenceLabel;
      if (!routeCaptured) sequenceLabel = LABEL_NOT_CAPTURED;
      else if (!okSeqs.length) sequenceLabel = LABEL_NO_MATCH;
      else sequenceLabel = uniqSortedNums(okSeqs).map(function (n) { return '#' + n; }).join(' ');

      // Sort detail packages: ok by seq, then unmatched last
      packages.sort(function (a, b) {
        var ao = a.sequenceStatus === 'ok' ? 0 : 1;
        var bo = b.sequenceStatus === 'ok' ? 0 : 1;
        if (ao !== bo) return ao - bo;
        if (a.sequenceNumber != null && b.sequenceNumber != null && a.sequenceNumber !== b.sequenceNumber) {
          return a.sequenceNumber - b.sequenceNumber;
        }
        return String(a.trackingId).localeCompare(String(b.trackingId));
      });

      routeList.push({
        routeCode: rc,
        driverName: (route && route.driverName) || '',
        area: routeArea(route, areas, rc),
        until1300Count: packages.length,
        totalDeliveries: Number(route && route.totalDeliveries) || 0,
        allDestinations: Number(route && route.allDestinations) || 0,
        cortexCaptured: routeCaptured,
        sequenceLabel: sequenceLabel,
        packages: packages
      });
    });

    routeList.sort(function (a, b) {
      return a.routeCode.localeCompare(b.routeCode, 'en', { numeric: true });
    });

    var emptyReason = '';
    if (!hasAssign || !hasCycle) emptyReason = 'NEED_DATA';
    else if (!routeList.length) emptyReason = 'NO_TW';

    return {
      dateDisplay: todayDisplay(),
      routeList: routeList,
      hasAssign: hasAssign,
      hasCycle: hasCycle,
      emptyReason: emptyReason
    };
  }

  function buildPageHeaderHtml(board, subtitle) {
    var h = '';
    h += '<div class="tw-board-page-header" style="text-align:center;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px;">';
    h += '<div style="font-size:22px;font-weight:800;letter-spacing:0.02em;">OFK3</div>';
    h += '<div style="font-size:20px;font-weight:800;margin-top:2px;">本日の時間指定</div>';
    h += '<div style="font-size:18px;font-weight:800;color:#b91c1c;margin-top:2px;">13:00まで</div>';
    if (subtitle) h += '<div style="font-size:14px;font-weight:700;margin-top:4px;">' + esc(subtitle) + '</div>';
    h += '<div style="font-size:15px;margin-top:6px;">' + esc(board.dateDisplay) + '</div>';
    h += '<div style="font-size:13px;font-weight:800;margin-top:6px;">積み込み前に必ず確認してください</div>';
    h += '<div style="font-size:11px;color:#555;margin-top:6px;">※13:00までの時間指定があるRouteのみ掲載</div>';
    h += '</div>';
    return h;
  }

  function buildEmptyHtml(board) {
    var html = '';
    html += '<div class="tw-board-root" style="font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;color:#111;">';
    html += buildPageHeaderHtml(board, '全体掲示表');
    if (board.emptyReason === 'NEED_DATA') {
      html += '<div style="text-align:center;padding:48px 12px;font-size:15px;color:#444;">';
      if (!board.hasCycle) html += 'CYCLEデータ未読込';
      else html += 'アサインExcelとサイクルExcelを読み込んでから再度開いてください。';
      html += '<br><span style="font-size:12px;color:#666;">（未読込のため「0件」とは断定していません）</span>';
      html += '</div>';
    } else {
      html += '<div style="text-align:center;padding:60px 0;font-size:18px;color:#444;">本日の時間指定（13:00まで）はありません</div>';
    }
    html += '</div>';
    return html;
  }

  // A: 画面用全体掲示表（PIIなし）
  function buildBulletinTableHtml(board) {
    if (!board.routeList.length) return buildEmptyHtml(board);
    var html = '';
    html += '<div class="tw-board-root tw-bulletin-screen" style="font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;color:#111;">';
    html += buildPageHeaderHtml(board, '全体掲示表');
    html += '<div style="font-size:11px;color:#64748b;margin:-6px 0 10px;">Cortex取得済みRouteはCortex 13:00必達Packageを正とする。未取得RouteはCYCLE暫定＋巡回順「未取得」。住所・DA番号は掲示しません。</div>';
    html += '<div style="overflow:auto;">';
    html += '<table class="tw-bulletin-table" style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#f1f5f9;border-bottom:2px solid #111;">';
    html += '<th style="text-align:left;padding:8px 6px;">Driver</th>';
    html += '<th style="text-align:left;padding:8px 6px;">Route</th>';
    html += '<th style="text-align:left;padding:8px 6px;">Area</th>';
    html += '<th style="text-align:right;padding:8px 6px;">配達数</th>';
    html += '<th style="text-align:right;padding:8px 6px;">目的地</th>';
    html += '<th style="text-align:right;padding:8px 6px;color:#b91c1c;">13:00まで</th>';
    html += '<th style="text-align:left;padding:8px 6px;">対象巡回順</th>';
    html += '<th style="text-align:center;padding:8px 6px;" class="tw-no-print">詳細</th>';
    html += '</tr></thead><tbody>';
    board.routeList.forEach(function (r, i) {
      var bg = i % 2 ? 'background:#f8fafc;' : '';
      html += '<tr style="border-bottom:1px solid #e2e8f0;' + bg + '">';
      html += '<td style="padding:7px 6px;">' + esc(r.driverName || '-') + '</td>';
      html += '<td style="padding:7px 6px;font-family:monospace;font-weight:800;">' + esc(r.routeCode) + '</td>';
      html += '<td style="padding:7px 6px;font-size:12px;">' + esc(r.area) + '</td>';
      html += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;">' + r.totalDeliveries + '個</td>';
      html += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;">' + r.allDestinations + '件</td>';
      html += '<td style="padding:7px 6px;text-align:right;font-weight:900;color:#b91c1c;font-size:15px;">' + r.until1300Count + '個</td>';
      html += '<td style="padding:7px 6px;font-family:monospace;font-size:12px;">' + esc(r.sequenceLabel) + '</td>';
      html += '<td style="padding:7px 6px;text-align:center;" class="tw-no-print">';
      html += '<button type="button" data-tw-detail="' + esc(r.routeCode) + '" style="padding:4px 10px;font-size:11px;font-weight:700;background:#0f766e;color:#fff;border:none;border-radius:6px;cursor:pointer;">個人詳細票</button>';
      html += '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div style="margin-top:10px;padding-top:6px;border-top:1px solid #ccc;font-size:10px;color:#666;display:flex;justify-content:space-between;">';
    html += '<span>※ 住所・氏名・電話・Tracking ID は掲示しません。</span>';
    html += '<span>掲載 ' + board.routeList.length + ' Route　出力: ' + esc(nowClockJst()) + '</span>';
    html += '</div></div>';
    return html;
  }

  // A: 印刷用ヘッダ（1回のみ・コンパクト。2ページ目では再掲しない）
  function buildBulletinPrintHeaderHtml(board) {
    var h = '';
    h += '<div class="tw-board-print-header">';
    h += '<div class="tw-board-print-title">OFK3　本日の時間指定　<span class="tw-board-print-accent">13:00まで</span>　全体掲示表</div>';
    h += '<div class="tw-board-print-meta">' + esc(board.dateDisplay)
      + '　※積み込み前に必ず確認　※13:00までの時間指定があるRouteのみ</div>';
    h += '</div>';
    return h;
  }

  // A: 印刷用（連続1テーブル。強制page-breakなし。theadのみページ跨ぎで繰返し）
  function buildBulletinPrintHtml(board) {
    if (!board.routeList.length) return buildEmptyHtml(board);
    var html = '';
    html += '<div class="tw-board-root tw-bulletin-print" style="font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;color:#111;">';
    html += buildBulletinPrintHeaderHtml(board);
    html += '<table class="tw-bulletin-table">';
    html += '<colgroup>';
    html += '<col class="tw-col-driver"><col class="tw-col-route"><col class="tw-col-area">';
    html += '<col class="tw-col-del"><col class="tw-col-dest"><col class="tw-col-until"><col class="tw-col-seq">';
    html += '</colgroup>';
    html += '<thead><tr>';
    html += '<th class="tw-th-l">Driver</th>';
    html += '<th class="tw-th-l">Route</th>';
    html += '<th class="tw-th-l">Area</th>';
    html += '<th class="tw-th-r">配達数</th>';
    html += '<th class="tw-th-r">目的地</th>';
    html += '<th class="tw-th-r tw-th-until">13:00まで</th>';
    html += '<th class="tw-th-l">対象巡回順</th>';
    html += '</tr></thead><tbody>';
    board.routeList.forEach(function (r, i) {
      html += '<tr class="' + (i % 2 ? 'tw-row-alt' : '') + '">';
      html += '<td>' + esc(r.driverName || '-') + '</td>';
      html += '<td class="tw-td-route">' + esc(r.routeCode) + '</td>';
      html += '<td class="tw-td-area">' + esc(r.area) + '</td>';
      html += '<td class="tw-td-num">' + r.totalDeliveries + '個</td>';
      html += '<td class="tw-td-num">' + r.allDestinations + '件</td>';
      html += '<td class="tw-td-until">' + r.until1300Count + '個</td>';
      html += '<td class="tw-td-seq">' + esc(r.sequenceLabel) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '<div class="tw-board-footer">※ 住所・氏名・電話・Tracking ID は掲示しません。　掲載 '
      + board.routeList.length + ' Route</div>';
    html += '</div>';
    return html;
  }

  // 既存カード印刷（副次・維持）
  function buildRouteCardHtml(r) {
    var c = '';
    c += '<div class="tw-board-card" style="break-inside:avoid;page-break-inside:avoid;border:2px solid #1e293b;border-radius:8px;padding:12px 14px;background:#fff;">';
    c += '<div style="display:flex;justify-content:space-between;gap:8px;">';
    c += '<div style="font-size:28px;font-weight:900;font-family:monospace;">' + esc(r.routeCode) + '</div>';
    c += '<div style="font-size:14px;font-weight:700;">' + esc(r.driverName || '-') + '</div></div>';
    c += '<div style="font-size:12px;color:#334155;margin-top:8px;">' + esc(r.area) + '</div>';
    c += '<div style="margin-top:12px;text-align:center;border-top:1px solid #cbd5e1;padding-top:10px;">';
    c += '<div style="font-size:12px;font-weight:700;color:#64748b;">13:00まで</div>';
    c += '<div style="font-size:36px;font-weight:900;color:#b91c1c;">' + r.until1300Count + '<span style="font-size:18px;">個</span></div></div>';
    c += '<div style="margin-top:8px;text-align:center;font-size:12px;color:#475569;">全体 '
      + r.totalDeliveries + '個 / ' + r.allDestinations + '件</div>';
    c += '<div style="margin-top:6px;text-align:center;font-size:11px;font-family:monospace;">巡回順 '
      + esc(r.sequenceLabel) + '</div></div>';
    return c;
  }

  function buildReportHtml(board) {
    if (!board.routeList.length) return buildEmptyHtml(board);
    var html = '';
    html += '<div class="tw-board-root" style="font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;color:#111;">';
    html += '<div class="tw-board-pages">';
    var list = board.routeList;
    var pageSize = 6;
    var pi;
    for (pi = 0; pi < list.length; pi += pageSize) {
      var pageRoutes = list.slice(pi, pi + pageSize);
      html += '<div class="tw-board-page" style="margin-bottom:24px;padding:12px;border:2px dashed #cbd5e1;border-radius:8px;background:#f8fafc;">';
      html += buildPageHeaderHtml(board, 'カード掲示');
      html += '<div class="tw-board-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:12px;">';
      pageRoutes.forEach(function (r) { html += buildRouteCardHtml(r); });
      html += '</div></div>';
    }
    html += '</div>';
    html += '<div class="tw-board-footer" style="margin-top:10px;font-size:10px;color:#666;">※ 住所・氏名・電話・Tracking ID は掲示しません。</div>';
    html += '</div>';
    return html;
  }

  // B: 個人詳細票
  function findRoute(board, routeCode) {
    var rc = String(routeCode || '');
    var i;
    for (i = 0; i < (board.routeList || []).length; i++) {
      if (board.routeList[i].routeCode === rc) return board.routeList[i];
    }
    return null;
  }

  function buildDetailHtml(board, routeCode) {
    var r = findRoute(board, routeCode);
    var html = '';
    html += '<div class="tw-detail-root" style="font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;color:#111;padding:8px;">';
    if (!r) {
      html += '<div style="padding:40px;text-align:center;">Route が見つかりません</div></div>';
      return html;
    }
    html += '<div class="tw-detail-header" style="border-bottom:3px solid #111;padding-bottom:12px;margin-bottom:14px;">';
    html += '<div style="font-size:18px;font-weight:800;">13:00まで 時間指定詳細</div>';
    html += '<div style="font-size:13px;margin-top:4px;">' + esc(board.dateDisplay) + '</div>';
    html += '<div style="margin-top:12px;font-size:28px;font-weight:900;font-family:monospace;">' + esc(r.routeCode) + '</div>';
    html += '<div style="margin-top:8px;font-size:14px;"><b>Driver:</b> ' + esc(r.driverName || '-') + '</div>';
    html += '<div style="margin-top:4px;font-size:14px;"><b>Area:</b> ' + esc(r.area) + '</div>';
    html += '<div style="margin-top:8px;font-size:14px;"><b>全体:</b> ' + r.totalDeliveries + '個 / ' + r.allDestinations + '件</div>';
    html += '<div style="margin-top:4px;font-size:16px;font-weight:800;color:#b91c1c;"><b>13:00まで:</b> ' + r.until1300Count + '個</div>';
    html += '<div style="margin-top:4px;font-size:14px;font-family:monospace;"><b>対象巡回順:</b> ' + esc(r.sequenceLabel) + '</div>';
    html += '</div>';
    html += '<table class="tw-detail-table" style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#f1f5f9;border-bottom:2px solid #111;">';
    html += '<th style="text-align:left;padding:8px 6px;width:72px;">巡回順</th>';
    html += '<th style="text-align:left;padding:8px 6px;">DA番号</th>';
    html += '<th style="text-align:left;padding:8px 6px;width:88px;">Driver Aid</th>';
    html += '<th style="text-align:left;padding:8px 6px;width:100px;">バッグ</th>';
    html += '<th style="text-align:left;padding:8px 6px;width:110px;">時間指定</th>';
    html += '<th style="text-align:left;padding:8px 6px;">住所</th>';
    html += '</tr></thead><tbody>';
    (r.packages || []).forEach(function (p, i) {
      var bg = i % 2 ? 'background:#f8fafc;' : '';
      html += '<tr style="border-bottom:1px solid #e2e8f0;' + bg + 'page-break-inside:avoid;break-inside:avoid;">';
      html += '<td style="padding:7px 6px;font-family:monospace;font-weight:700;">' + esc(p.sequenceLabel) + '</td>';
      html += '<td style="padding:7px 6px;font-family:monospace;font-size:12px;">' + esc(p.trackingId) + '</td>';
      html += '<td style="padding:7px 6px;font-family:monospace;font-weight:700;">' + esc(assistCell(p.driverAid)) + '</td>';
      html += '<td style="padding:7px 6px;">' + esc(assistCell(p.bagDisplay)) + '</td>';
      html += '<td style="padding:7px 6px;">' + esc(p.timeWindow || p.windowLabel) + '</td>';
      html += '<td style="padding:7px 6px;font-size:12px;">' + esc(p.address || '-') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  function openPrintWindow(title, bodyHtml, cssExtra) {
    var printWindow = window.open('', '_blank', 'width=1100,height=800');
    if (!printWindow) {
      alert('ポップアップがブロックされました。ブラウザ設定をご確認ください。');
      return;
    }
    var doc = ''
      + '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
      + '<title>' + esc(title) + '</title><style>'
      + '*{margin:0;padding:0;box-sizing:border-box;}'
      + 'body{padding:14px;font-family:\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;}'
      + (cssExtra || '')
      + '</style></head><body>'
      + bodyHtml
      + '<script>window.onload=function(){window.print();};<\/script>'
      + '</body></html>';
    printWindow.document.write(doc);
    printWindow.document.close();
  }

  function printBulletin() {
    try {
      var board = lastBoard || buildBoard();
      var css = ''
        + 'html,body{margin:0;padding:0;}'
        + '.tw-bulletin-print{margin:0;padding:0;}'
        + '.tw-board-print-header{text-align:center;border-bottom:1.5px solid #111;padding:0 0 3px;margin:0 0 4px;}'
        + '.tw-board-print-title{font-size:11pt;font-weight:800;line-height:1.2;}'
        + '.tw-board-print-accent{color:#b91c1c;}'
        + '.tw-board-print-meta{font-size:8pt;line-height:1.15;margin-top:1px;color:#333;}'
        + '.tw-bulletin-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.5pt;line-height:1.15;}'
        + '.tw-col-driver{width:12%;}.tw-col-route{width:7%;}.tw-col-area{width:10%;}'
        + '.tw-col-del{width:7%;}.tw-col-dest{width:7%;}.tw-col-until{width:8%;}.tw-col-seq{width:49%;}'
        + '.tw-bulletin-table th,.tw-bulletin-table td{padding:2px 3px;vertical-align:top;}'
        + '.tw-bulletin-table th{background:#f1f5f9;border-bottom:1.5px solid #111;font-weight:700;}'
        + '.tw-bulletin-table td{border-bottom:0.5px solid #cbd5e1;}'
        + '.tw-th-l{text-align:left;}.tw-th-r{text-align:right;}.tw-th-until{color:#b91c1c;}'
        + '.tw-row-alt td{background:#f8fafc;}'
        + '.tw-td-route{font-family:monospace;font-weight:800;}'
        + '.tw-td-area{font-size:8pt;}'
        + '.tw-td-num{text-align:right;}'
        + '.tw-td-until{text-align:right;font-weight:900;color:#b91c1c;}'
        + '.tw-td-seq{font-family:monospace;font-size:8pt;white-space:normal;word-break:break-word;overflow-wrap:anywhere;}'
        + '.tw-board-footer{margin-top:4px;font-size:7.5pt;color:#666;}'
        + '@media print{'
        + 'html,body{margin:0;padding:0;}'
        + '@page{size:A4 landscape;margin:6mm;}'
        + '.tw-board-print-header{break-after:avoid;page-break-after:avoid;}'
        + 'thead{display:table-header-group;}'
        + 'tfoot{display:table-footer-group;}'
        + 'tr{break-inside:avoid;page-break-inside:avoid;}'
        + '.tw-bulletin-table{font-size:8.5pt;}'
        + '}';
      openPrintWindow('OFK3 13:00まで 全体掲示表', buildBulletinPrintHtml(board), css);
    } catch (e) {
      try { console.error('OFK3TimeWindowBoard.printBulletin error:', e); } catch (e2) {}
      alert('印刷処理中にエラーが発生しました。');
    }
  }

  function printCards() {
    try {
      var board = lastBoard || buildBoard();
      var css = ''
        + '.tw-board-page{margin-bottom:24px;padding:12px;border:2px dashed #cbd5e1;border-radius:8px;background:#f8fafc;}'
        + '.tw-board-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:12px;}'
        + '.tw-board-card{break-inside:avoid;page-break-inside:avoid;}'
        + '@media print{'
        + 'body{padding:6mm;}'
        + '@page{size:A4 landscape;margin:8mm;}'
        + '.tw-board-page{break-after:page;page-break-after:always;margin-bottom:0;padding:0;border:none;background:transparent;}'
        + '.tw-board-page:last-child{break-after:auto;page-break-after:auto;}'
        + '}';
      openPrintWindow('OFK3 本日の時間指定（13:00まで）カード', buildReportHtml(board), css);
    } catch (e) {
      try { console.error('OFK3TimeWindowBoard.printCards error:', e); } catch (e2) {}
      alert('印刷処理中にエラーが発生しました。');
    }
  }

  function printDetail(routeCode) {
    try {
      var board = lastBoard || buildBoard();
      var css = ''
        + '@media print{'
        + 'body{padding:8mm;}'
        + '@page{size:A4 portrait;margin:10mm;}'
        + 'thead{display:table-header-group;}'
        + 'tr{break-inside:avoid;page-break-inside:avoid;}'
        + '}';
      openPrintWindow('OFK3 13:00詳細 ' + String(routeCode || ''), buildDetailHtml(board, routeCode), css);
    } catch (e) {
      try { console.error('OFK3TimeWindowBoard.printDetail error:', e); } catch (e2) {}
      alert('個人詳細票の印刷中にエラーが発生しました。');
    }
  }

  function openDetailView(routeCode) {
    try {
      var board = lastBoard || buildBoard();
      var el = ensureOverlay();
      var content = document.getElementById(CONTENT_ID);
      var html = '';
      html += '<div style="margin-bottom:10px;">';
      html += '<button type="button" data-tw-board="back" style="padding:6px 12px;background:#e5e7eb;border:none;border-radius:6px;cursor:pointer;font-size:12px;">← 全体掲示表へ戻る</button> ';
      html += '<button type="button" data-tw-board="print-detail" data-tw-route="' + esc(routeCode) + '" style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;">この詳細票を印刷</button>';
      html += '</div>';
      html += buildDetailHtml(board, routeCode);
      content.innerHTML = html;
      el.style.display = 'block';
    } catch (e) {
      try { console.error('OFK3TimeWindowBoard.openDetail error:', e); } catch (e2) {}
      alert('個人詳細票の表示中にエラーが発生しました。');
    }
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
    bar.style.cssText = 'position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;z-index:1;flex-wrap:wrap;gap:8px;';
    bar.innerHTML = ''
      + '<b style="font-size:14px;">時間指定 詳細・掲示用一覧（13:00まで）</b>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + '<button type="button" data-tw-board="print-bulletin" style="padding:6px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;">全体掲示表を印刷（A4横）</button>'
      + '<button type="button" data-tw-board="print-cards" style="padding:6px 14px;background:#0f766e;color:#fff;border:none;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;">カード印刷</button>'
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
      var t = ev.target;
      var a = t && t.getAttribute && t.getAttribute('data-tw-board');
      if (a === 'close') hideOverlay();
      else if (a === 'print-bulletin') printBulletin();
      else if (a === 'print-cards') printCards();
      else if (a === 'print') printBulletin();
    });
    content.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var detailRc = t.getAttribute('data-tw-detail');
      if (detailRc) {
        openDetailView(detailRc);
        return;
      }
      var act = t.getAttribute('data-tw-board');
      if (act === 'back') {
        renderBulletinScreen();
        return;
      }
      if (act === 'print-detail') {
        printDetail(t.getAttribute('data-tw-route'));
      }
    });
    document.body.appendChild(el);
    return el;
  }

  function hideOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
  }

  var lastBoard = null;

  function renderBulletinScreen() {
    lastBoard = lastBoard || buildBoard();
    var content = document.getElementById(CONTENT_ID);
    if (content) content.innerHTML = buildBulletinTableHtml(lastBoard);
  }

  function openBoard() {
    try {
      lastBoard = buildBoard();
      var el = ensureOverlay();
      renderBulletinScreen();
      el.style.display = 'block';
    } catch (e) {
      try { console.error('OFK3TimeWindowBoard.open error:', e); } catch (e2) {}
      alert('時間指定一覧の表示中にエラーが発生しました。');
    }
  }

  function printBoard() {
    printBulletin();
  }

  function insertButton() {
    if (document.getElementById(BTN_WRAP_ID)) return;
    var anchor = document.getElementById(ANCHOR_ID);
    var html = ''
      + '<div id="' + BTN_WRAP_ID + '" class="card p-4 mb-4" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">'
      + '<div><p class="text-sm font-medium">時間指定 詳細・印刷</p>'
      + '<p class="text-xs text-ink-lighter mt-1">13:00までの全体掲示表（A4横）とRoute別個人詳細票</p></div>'
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
    printBulletin: printBulletin,
    printCards: printCards,
    printDetail: printDetail,
    openDetail: openDetailView,
    buildBoard: buildBoard,
    buildReportHtml: buildReportHtml,
    buildBulletinTableHtml: buildBulletinTableHtml,
    buildBulletinPrintHtml: buildBulletinPrintHtml,
    buildDetailHtml: buildDetailHtml,
    resolvePackageSequence: resolvePackageSequence,
    buildSequenceMaps: buildSequenceMaps,
    buildAssistMap: buildAssistMap,
    assistCell: assistCell,
    getPriorityPackages: getPriorityPackages,
    getPackageAssistIndex: getPackageAssistIndex,
    parseWindow: parseWindow,
    isUntil1300: isUntil1300,
    END_LIMIT_MIN: END_LIMIT_MIN,
    LABEL_NOT_CAPTURED: LABEL_NOT_CAPTURED,
    LABEL_NO_MATCH: LABEL_NO_MATCH,
    LABEL_NO_SEQ: LABEL_NO_SEQ,
    onDashboardRender: insertButton
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
