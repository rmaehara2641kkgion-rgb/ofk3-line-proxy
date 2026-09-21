/**
 * OFK3 時間指定 掲示用印刷（ステーション掲示）。
 * 主データは CYCLE Excel 時間指定（twExtract と同系統）。
 * Cortex 13:00 packages / routeStops は任意で補強するだけ（判定ロジックは再実装しない）。
 * MutationObserver / setInterval は使わない。
 */
(function (root) {
  'use strict';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function parseTimeWindow(tw) {
    if (!tw) return null;
    var parts = String(tw).split('-');
    if (parts.length < 2) return null;
    var startRaw = parts[0].trim();
    var endRaw = parts[parts.length - 1].trim();
    var sMatch = startRaw.match(/(\d{1,2}):(\d{2})/);
    var eMatch = endRaw.match(/(\d{1,2}):(\d{2})/);
    if (!sMatch || !eMatch) return null;
    var startH = parseInt(sMatch[1], 10);
    var startM = parseInt(sMatch[2], 10);
    var endH = parseInt(eMatch[1], 10);
    var endM = parseInt(eMatch[2], 10);
    return {
      start: (startH < 10 ? '0' : '') + startH + ':' + (startM < 10 ? '0' : '') + startM,
      end: (endH < 10 ? '0' : '') + endH + ':' + (endM < 10 ? '0' : '') + endM,
      startMin: startH * 60 + startM,
      endMin: endH * 60 + endM,
      label: String(tw).trim()
    };
  }

  function isAllDayWindow(parsed) {
    return !!(parsed && (parsed.endMin - parsed.startMin >= 720));
  }

  function areaFromAddress(addr, extractAreaName) {
    if (!addr) return '';
    if (typeof extractAreaName === 'function') {
      try {
        var a = extractAreaName(addr);
        if (a) return String(a);
      } catch (e) {}
    }
    return '';
  }

  function routeDriverMap(assignmentData) {
    var map = {};
    (assignmentData || []).forEach(function (r) {
      if (!r || !r.routeCode) return;
      map[String(r.routeCode)] = {
        driverName: r.driverName || '',
        departure: r.departure || ''
      };
    });
    return map;
  }

  function cortexPriorityStopSet(packages) {
    var set = {};
    (packages || []).forEach(function (p) {
      if (!p || p.routeCode == null || p.stop == null) return;
      set[String(p.routeCode) + '#' + String(p.stop)] = true;
    });
    return set;
  }

  function cortexSequenceMap(routeStops) {
    var map = {};
    (routeStops || []).forEach(function (s) {
      if (!s || s.routeCode == null) return;
      var seq = s.sequenceNumber != null ? s.sequenceNumber : s.stop;
      if (seq == null || seq === '') return;
      var stop = s.stop != null ? s.stop : seq;
      map[String(s.routeCode) + '#' + String(stop)] = Number(seq);
    });
    return map;
  }

  function collectFromTwExtracted(twExtractedData, assignmentData, extractAreaName) {
    var drivers = routeDriverMap(assignmentData);
    var items = [];
    (twExtractedData || []).forEach(function (d) {
      if (!d) return;
      var parsed = parseTimeWindow(d.timeWindow);
      if (!parsed || isAllDayWindow(parsed)) return;
      var routeCode = String(d.routeCode || '').trim();
      if (!routeCode) return;
      var meta = drivers[routeCode] || { driverName: '', departure: '' };
      items.push({
        routeCode: routeCode,
        driverName: String(d.driverName || meta.driverName || '').trim(),
        departure: String(d.departure || meta.departure || '').trim(),
        timeWindow: parsed.label,
        startMin: parsed.startMin,
        endMin: parsed.endMin,
        endLabel: parsed.end,
        area: areaFromAddress(d.address, extractAreaName),
        stop: d.stop != null && d.stop !== '' ? Number(d.stop) : null,
        packageCount: 1
      });
    });
    return items;
  }

  function collectRawItems(assignmentData, cycleDetailData, extractAreaName) {
    var drivers = routeDriverMap(assignmentData);
    var items = [];
    var routeCodes = Object.keys(cycleDetailData || {});
    routeCodes.sort();
    routeCodes.forEach(function (routeCode) {
      var details = cycleDetailData[routeCode] || [];
      var meta = drivers[routeCode] || { driverName: '', departure: '' };
      details.forEach(function (d) {
        if (!d) return;
        var parsed = parseTimeWindow(d.timeWindow);
        if (!parsed || isAllDayWindow(parsed)) return;
        items.push({
          routeCode: String(routeCode),
          driverName: meta.driverName,
          departure: meta.departure,
          timeWindow: parsed.label,
          startMin: parsed.startMin,
          endMin: parsed.endMin,
          endLabel: parsed.end,
          area: areaFromAddress(d.address, extractAreaName),
          stop: d.stop != null && d.stop !== '' ? Number(d.stop) : null,
          packageCount: 1
        });
      });
    });
    return items;
  }

  function aggregateRows(rawItems, prioritySet, sequenceMap) {
    var buckets = {};
    rawItems.forEach(function (it) {
      var stopKey = it.stop == null || !isFinite(it.stop) ? '' : String(it.stop);
      var key = it.routeCode + '\t' + it.timeWindow + '\t' + (it.area || '') + '\t' + stopKey;
      if (!buckets[key]) {
        var prio = !!(stopKey && prioritySet[it.routeCode + '#' + stopKey]);
        var seq = stopKey && sequenceMap[it.routeCode + '#' + stopKey];
        buckets[key] = {
          routeCode: it.routeCode,
          driverName: it.driverName,
          departure: it.departure,
          timeWindow: it.timeWindow,
          startMin: it.startMin,
          endMin: it.endMin,
          endLabel: it.endLabel,
          area: it.area || '',
          stop: stopKey ? Number(stopKey) : null,
          packageCount: 0,
          isPriority1300: prio,
          sequenceNumber: seq != null && isFinite(seq) ? seq : null
        };
      }
      buckets[key].packageCount += 1;
      if (!buckets[key].driverName && it.driverName) buckets[key].driverName = it.driverName;
    });
    var rows = Object.keys(buckets).map(function (k) { return buckets[k]; });
    rows.sort(function (a, b) {
      if (a.routeCode !== b.routeCode) return a.routeCode < b.routeCode ? -1 : 1;
      if (a.endMin !== b.endMin) return a.endMin - b.endMin;
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      var sa = a.sequenceNumber != null ? a.sequenceNumber : 1e9;
      var sb = b.sequenceNumber != null ? b.sequenceNumber : 1e9;
      if (sa !== sb) return sa - sb;
      return (a.stop || 0) - (b.stop || 0);
    });
    return rows;
  }

  function summarizeRoutes(rows, priorityPackages) {
    var byRoute = {};
    rows.forEach(function (r) {
      if (!byRoute[r.routeCode]) {
        byRoute[r.routeCode] = {
          routeCode: r.routeCode,
          driverName: r.driverName || '',
          departure: r.departure || '',
          packageCount: 0,
          rowCount: 0,
          priorityStopCount: 0,
          priorityPackageCount: 0
        };
      }
      var s = byRoute[r.routeCode];
      s.packageCount += r.packageCount;
      s.rowCount += 1;
      if (!s.driverName && r.driverName) s.driverName = r.driverName;
      if (r.isPriority1300) s.priorityStopCount += 1;
    });
    // Prefer Cortex package counts for 13:00 (already judged upstream)
    var pkgByRoute = {};
    var stopByRoute = {};
    (priorityPackages || []).forEach(function (p) {
      if (!p || !p.routeCode) return;
      var rc = String(p.routeCode);
      pkgByRoute[rc] = (pkgByRoute[rc] || 0) + 1;
      var sk = rc + '#' + String(p.stop);
      if (!stopByRoute[rc]) stopByRoute[rc] = {};
      stopByRoute[rc][sk] = true;
    });
    Object.keys(byRoute).forEach(function (rc) {
      if (pkgByRoute[rc]) {
        byRoute[rc].priorityPackageCount = pkgByRoute[rc];
        byRoute[rc].priorityStopCount = Object.keys(stopByRoute[rc] || {}).length;
      }
    });
    return Object.keys(byRoute).sort().map(function (k) { return byRoute[k]; });
  }

  function emptyModel(localDate, reason, hint, hasCortexPriority) {
    return {
      ok: true,
      empty: true,
      reason: reason || 'NO_TW',
      message: '本日の時間指定はありません',
      hint: hint || '',
      localDate: localDate || '',
      routes: [],
      rows: [],
      totalPackages: 0,
      totalRoutes: 0,
      hasCortexPriority: !!hasCortexPriority,
      hasSequence: false
    };
  }

  function buildBulletinModel(opts) {
    opts = opts || {};
    var assignmentData = opts.assignmentData || [];
    var cycleDetailData = opts.cycleDetailData || {};
    var twExtractedData = opts.twExtractedData || [];
    var extractAreaName = opts.extractAreaName;
    var priorityPackages = opts.priorityPackages || [];
    var routeStops = opts.routeStops || [];
    var localDate = opts.localDate || '';
    var hasCortexPriority = (priorityPackages || []).length > 0;

    var hasCycle = Object.keys(cycleDetailData || {}).length > 0;
    var hasAssign = (assignmentData || []).length > 0;
    var hasTwExtract = (twExtractedData || []).length > 0;

    if (!hasCycle && !hasTwExtract) {
      return emptyModel(
        localDate,
        !hasAssign ? 'NO_ASSIGN' : 'NO_CYCLE',
        !hasAssign
          ? '先にダッシュボードでルート（アサイン）Excelを読み込んでください。'
          : '先にダッシュボードでサイクルExcelを読み込んでください。',
        hasCortexPriority
      );
    }

    var prioritySet = cortexPriorityStopSet(priorityPackages);
    var sequenceMap = cortexSequenceMap(routeStops);
    // Prefer already-filtered TW extract when present; else scan cycle (same all-day skip as twExtract)
    var raw = hasTwExtract
      ? collectFromTwExtracted(twExtractedData, assignmentData, extractAreaName)
      : collectRawItems(assignmentData, cycleDetailData, extractAreaName);
    var rows = aggregateRows(raw, prioritySet, sequenceMap);
    var routes = summarizeRoutes(rows, priorityPackages);
    var hasSequence = rows.some(function (r) { return r.sequenceNumber != null; });

    if (!rows.length) {
      return emptyModel(localDate, 'NO_TW', '', hasCortexPriority);
    }

    var totalPackages = rows.reduce(function (n, r) { return n + r.packageCount; }, 0);
    return {
      ok: true,
      empty: false,
      reason: '',
      message: '',
      hint: '',
      localDate: localDate,
      routes: routes,
      rows: rows,
      totalPackages: totalPackages,
      totalRoutes: routes.length,
      hasCortexPriority: hasCortexPriority,
      hasSequence: hasSequence
    };
  }

  function formatDateLabel(localDate) {
    if (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      var p = localDate.split('-');
      return p[0] + '/' + p[1] + '/' + p[2];
    }
    try {
      return new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function buildBulletinHtml(model) {
    model = model || {};
    var dateLabel = formatDateLabel(model.localDate);
    var html = ''
      + '<div class="tw-bulletin" style="font-family:\'Noto Sans JP\',sans-serif;color:#111;">'
      + '<div style="text-align:center;margin-bottom:14px;border-bottom:2px solid #222;padding-bottom:10px;">'
      + '<h1 style="font-size:20px;margin:0 0 4px 0;">OFK3　本日の時間指定一覧</h1>'
      + '<p style="font-size:13px;color:#555;margin:0;">' + esc(dateLabel) + '</p>'
      + '<p style="font-size:13px;font-weight:700;margin:8px 0 0 0;">積み込み前に必ず確認してください</p>'
      + '</div>';

    if (model.empty) {
      html += '<p style="text-align:center;font-size:16px;padding:40px 12px;">'
        + esc(model.message || '本日の時間指定はありません') + '</p>';
      if (model.hint) {
        html += '<p style="text-align:center;font-size:12px;color:#666;">' + esc(model.hint) + '</p>';
      }
      html += '</div>';
      return html;
    }

    html += '<p style="font-size:12px;margin:0 0 10px 0;color:#444;">'
      + '対象Route ' + model.totalRoutes + '　／　時間指定 ' + model.totalPackages + ' 件';
    if (model.hasCortexPriority) html += '　／　13:00必達は既存Cortex判定を表示';
    html += '</p>';

    html += '<div class="tw-bulletin-summary" style="margin-bottom:14px;">';
    (model.routes || []).forEach(function (r) {
      html += '<div class="tw-bulletin-route-block" style="border:1px solid #ddd;border-radius:6px;padding:8px 10px;margin-bottom:8px;page-break-inside:avoid;">'
        + '<div style="font-size:15px;font-weight:700;font-family:monospace;">' + esc(r.routeCode) + '</div>'
        + '<div style="font-size:12px;margin-top:2px;">Driver：' + esc(r.driverName || '-') + '</div>'
        + '<div style="font-size:12px;margin-top:2px;">時間指定：' + r.packageCount + '件';
      if (model.hasCortexPriority) {
        var pCount = r.priorityPackageCount != null ? r.priorityPackageCount : r.priorityStopCount;
        html += '　／　<span style="color:#b91c1c;font-weight:700;">13:00必達：'
          + pCount + '件</span>';
      }
      html += '</div></div>';
    });
    html += '</div>';

    html += '<table class="tw-bulletin-table" style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr>'
      + '<th style="background:#f3f4f6;border:1px solid #ddd;padding:6px 8px;text-align:left;">Route</th>'
      + '<th style="background:#f3f4f6;border:1px solid #ddd;padding:6px 8px;text-align:left;">Driver</th>'
      + '<th style="background:#f3f4f6;border:1px solid #ddd;padding:6px 8px;text-align:left;">時間指定</th>'
      + '<th style="background:#f3f4f6;border:1px solid #ddd;padding:6px 8px;text-align:left;">エリア</th>'
      + '<th style="background:#f3f4f6;border:1px solid #ddd;padding:6px 8px;text-align:right;">件数</th>';
    if (model.hasSequence) {
      html += '<th style="background:#f3f4f6;border:1px solid #ddd;padding:6px 8px;text-align:center;">巡回順</th>';
    }
    html += '</tr></thead><tbody>';

    var prevRoute = '';
    (model.rows || []).forEach(function (row) {
      var routeBreak = row.routeCode !== prevRoute;
      var trStyle = routeBreak ? 'border-top:2px solid #94a3b8;' : '';
      if (row.isPriority1300) trStyle += 'background:#fef2f2;';
      html += '<tr class="tw-bulletin-row" style="page-break-inside:avoid;' + trStyle + '">';
      html += '<td style="border:1px solid #ddd;padding:5px 8px;font-family:monospace;font-weight:600;">' + esc(row.routeCode) + '</td>';
      html += '<td style="border:1px solid #ddd;padding:5px 8px;">' + esc(row.driverName || '-') + '</td>';
      html += '<td style="border:1px solid #ddd;padding:5px 8px;'
        + (row.isPriority1300 ? 'color:#b91c1c;font-weight:700;' : '') + '">'
        + esc(row.timeWindow)
        + (row.isPriority1300 ? '　<span style="font-size:10px;">13:00必達</span>' : '')
        + '</td>';
      html += '<td style="border:1px solid #ddd;padding:5px 8px;">' + esc(row.area || '-') + '</td>';
      html += '<td style="border:1px solid #ddd;padding:5px 8px;text-align:right;font-family:monospace;">' + row.packageCount + '</td>';
      if (model.hasSequence) {
        html += '<td style="border:1px solid #ddd;padding:5px 8px;text-align:center;font-family:monospace;">'
          + (row.sequenceNumber != null ? esc(row.sequenceNumber) : '-') + '</td>';
      }
      html += '</tr>';
      prevRoute = row.routeCode;
    });

    html += '</tbody></table>'
      + '<p style="margin-top:10px;font-size:10px;color:#777;">※ フル住所・顧客名・電話番号・Tracking ID は掲示しない</p>'
      + '</div>';
    return html;
  }

  function gatherContext(rootObj, overrides) {
    rootObj = rootObj || root;
    overrides = overrides || {};
    var assignmentData = overrides.assignmentData
      || rootObj.assignmentData
      || [];
    var cycleDetailData = overrides.cycleDetailData
      || rootObj.cycleDetailData
      || {};
    var twExtractedData = overrides.twExtractedData
      || rootObj.twExtractedData
      || [];
    var extractAreaName = overrides.extractAreaName
      || (typeof rootObj.extractAreaName === 'function' ? rootObj.extractAreaName : null);
    var priorityPackages = overrides.priorityPackages || [];
    var routeStops = overrides.routeStops || [];
    var localDate = overrides.localDate || '';
    try {
      if (!priorityPackages.length && rootObj.OFK3Cortex13) {
        var entry = rootObj.OFK3Cortex13.getEntry && rootObj.OFK3Cortex13.getEntry();
        if (entry) {
          priorityPackages = entry.packages || [];
          if (!localDate) localDate = entry.localDate || '';
        }
        if ((!routeStops || !routeStops.length) && rootObj.OFK3Cortex13.getRouteStops) {
          routeStops = rootObj.OFK3Cortex13.getRouteStops() || [];
        }
      }
    } catch (e) {}
    if (!localDate && typeof rootObj.getTodayJst === 'function') {
      try { localDate = rootObj.getTodayJst(); } catch (e2) {}
    }
    return {
      assignmentData: assignmentData,
      cycleDetailData: cycleDetailData,
      twExtractedData: twExtractedData,
      extractAreaName: extractAreaName,
      priorityPackages: priorityPackages,
      routeStops: routeStops,
      localDate: localDate
    };
  }

  function openBulletin(optsOrRoot) {
    try {
      var overrides = {};
      var rootObj = root;
      if (optsOrRoot && typeof optsOrRoot === 'object') {
        if (optsOrRoot.assignmentData || optsOrRoot.cycleDetailData || optsOrRoot.twExtractedData
            || optsOrRoot.extractAreaName || optsOrRoot.priorityPackages || optsOrRoot.localDate) {
          overrides = optsOrRoot;
        } else if (optsOrRoot.OFK3Cortex13 || optsOrRoot.document) {
          rootObj = optsOrRoot;
        }
      }
      var ctx = gatherContext(rootObj, overrides);
      var model = buildBulletinModel(ctx);
      var html = buildBulletinHtml(model);
      var modal = document.getElementById('tw-bulletin-modal');
      var content = document.getElementById('tw-bulletin-content');
      var title = document.getElementById('tw-bulletin-title');
      if (!modal || !content) {
        printBulletinHtml(html, model);
        return model;
      }
      if (title) title.textContent = '時間指定 詳細・掲示用印刷';
      content.innerHTML = html;
      modal.classList.remove('hidden');
      return model;
    } catch (e) {
      try { console.error('tw bulletin open failed:', e); } catch (e2) {}
      try { alert('時間指定掲示一覧の表示に失敗しました（本体は継続動作します）'); } catch (e3) {}
      return { ok: false, empty: true, message: String(e && e.message || e) };
    }
  }

  function closeBulletin() {
    var modal = document.getElementById('tw-bulletin-modal');
    if (modal) modal.classList.add('hidden');
  }

  function printBulletinHtml(html, model) {
    var printWindow = window.open('', '_blank', 'width=1100,height=800');
    if (!printWindow) {
      alert('ポップアップがブロックされました。印刷ウィンドウを許可してください。');
      return;
    }
    printWindow.document.write('<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
      + '<title>OFK3 本日の時間指定一覧</title>'
      + '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">'
      + '<style>'
      + '*{margin:0;padding:0;box-sizing:border-box;}'
      + 'body{font-family:\'Noto Sans JP\',sans-serif;padding:16px;color:#111;}'
      + 'table{width:100%;border-collapse:collapse;font-size:12px;}'
      + 'th,td{border:1px solid #ddd;padding:5px 8px;}'
      + 'th{background:#f3f4f6;}'
      + '.tw-bulletin-route-block{page-break-inside:avoid;}'
      + '.tw-bulletin-row{page-break-inside:avoid;}'
      + 'thead{display:table-header-group;}'
      + '@media print{body{padding:8px;} @page{size:A4 landscape;margin:10mm;} .no-print{display:none!important;}}'
      + '</style></head><body>'
      + html
      + '<scr' + 'ipt>window.onload=function(){window.print();}</scr' + 'ipt>'
      + '</body></html>');
    printWindow.document.close();
  }

  function printBulletin(optsOrRoot) {
    try {
      var content = document.getElementById('tw-bulletin-content');
      var html = content ? content.innerHTML : '';
      if (!html) {
        var overrides = (optsOrRoot && typeof optsOrRoot === 'object'
          && (optsOrRoot.assignmentData || optsOrRoot.cycleDetailData || optsOrRoot.twExtractedData))
          ? optsOrRoot : {};
        var model = buildBulletinModel(gatherContext(root, overrides));
        html = buildBulletinHtml(model);
      }
      printBulletinHtml(html);
    } catch (e) {
      try { console.error('tw bulletin print failed:', e); } catch (e2) {}
      try { alert('印刷に失敗しました（本体は継続動作します）'); } catch (e3) {}
    }
  }

  var api = {
    parseTimeWindow: parseTimeWindow,
    isAllDayWindow: isAllDayWindow,
    collectRawItems: collectRawItems,
    collectFromTwExtracted: collectFromTwExtracted,
    buildBulletinModel: buildBulletinModel,
    buildBulletinHtml: buildBulletinHtml,
    open: openBulletin,
    close: closeBulletin,
    print: printBulletin
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OFK3TwBulletin = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
