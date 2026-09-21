/**
 * Cortex route-sequence MAP model (Phase 2A).
 * Visit order comes from captured rmsRouteDetails.stops[].sequenceNumber.
 * 13:00 flags are joined from the existing priority packages; judgment is not duplicated here.
 * Phase 2B LINE send can reuse buildRouteSequenceModel / sequencePopup without changing this file's meaning.
 */
(function (root) {
  'use strict';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function sequenceKey(routeCode, seq) {
    return String(routeCode || '') + '#' + String(seq);
  }

  function toSeq(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function buildRouteSequenceModel(routeStops, packages) {
    var list = Array.isArray(routeStops) ? routeStops : [];
    var pkgs = Array.isArray(packages) ? packages : [];
    var priorityKeys = {};
    var priorityPkgCount = {};
    pkgs.forEach(function (p) {
      if (!p || p.routeCode == null || p.stop == null) return;
      var k = sequenceKey(p.routeCode, p.stop);
      priorityKeys[k] = true;
      priorityPkgCount[k] = (priorityPkgCount[k] || 0) + 1;
    });

    var pins = [];
    list.forEach(function (s, idx) {
      if (!s) return;
      var seq = toSeq(s.sequenceNumber != null ? s.sequenceNumber : s.stop);
      var code = String(s.routeCode || '');
      var k = sequenceKey(code, seq);
      var isPriority = seq != null && !!priorityKeys[k];
      pins.push({
        routeCode: code,
        routeId: s.routeId || '',
        driverName: s.driverName || '',
        sequenceNumber: seq,
        stop: seq,
        sortIndex: idx,
        address: s.address || '',
        latitude: s.latitude,
        longitude: s.longitude,
        plannedEndTime: s.plannedEndTime,
        plannedEndClock: s.plannedEndClock || '',
        packageCount: s.packageCount == null ? 0 : Number(s.packageCount) || 0,
        priorityPackageCount: isPriority ? (priorityPkgCount[k] || 0) : 0,
        isPriority1300: isPriority
      });
    });

    pins.sort(function (a, b) {
      var rc = String(a.routeCode).localeCompare(String(b.routeCode), 'en', { numeric: true });
      if (rc) return rc;
      if (a.sequenceNumber == null && b.sequenceNumber == null) return a.sortIndex - b.sortIndex;
      if (a.sequenceNumber == null) return 1;
      if (b.sequenceNumber == null) return -1;
      if (a.sequenceNumber !== b.sequenceNumber) return a.sequenceNumber - b.sequenceNumber;
      return a.sortIndex - b.sortIndex;
    });

    var routes = {};
    pins.forEach(function (p) { routes[p.routeCode || '-'] = true; });
    return {
      complete: list.length > 0,
      pins: pins,
      stopCount: pins.length,
      routeCount: Object.keys(routes).length
    };
  }

  function summarizeSelectedRoute(pins, packages, routeCode) {
    var code = String(routeCode || '');
    var routePins = (pins || []).filter(function (p) { return String(p.routeCode) === code; });
    var priorityStopCount = 0;
    routePins.forEach(function (p) { if (p.isPriority1300) priorityStopCount += 1; });
    var priorityPackageCount = 0;
    (packages || []).forEach(function (p) {
      if (String(p.routeCode || '') === code) priorityPackageCount += 1;
    });
    return {
      routeCode: code,
      driverName: (routePins[0] && routePins[0].driverName) || '',
      allStopCount: routePins.length,
      priorityStopCount: priorityStopCount,
      priorityPackageCount: priorityPackageCount
    };
  }

  function sequencePopup(pin) {
    pin = pin || {};
    var yes = !!pin.isPriority1300;
    return '<div>'
      + (yes ? '<div style="color:#b91c1c;font-weight:700;">🔴 13:00必達</div>' : '')
      + '<b>Route</b> ' + esc(pin.routeCode)
      + '<br><b>Driver</b> ' + esc(pin.driverName || '-')
      + '<br><b>巡回順</b> ' + esc(pin.sequenceNumber == null ? '-' : pin.sequenceNumber)
      + '<br><b>Cortex Stop</b> ' + esc(pin.stop == null ? '-' : pin.stop)
      + '<br><b>予定時刻</b> ' + esc(pin.plannedEndClock || '-')
      + '<br><b>13:00必達</b> ' + (yes ? 'YES' : 'NO')
      + '<br><b>Package数</b> ' + (pin.packageCount || 0)
      + '<br><b>住所</b> ' + esc(pin.address || '-')
      + '</div>';
  }

  function hasFiniteCoord(lat, lng) {
    var a = Number(lat), b = Number(lng);
    return isFinite(a) && isFinite(b) && !(a === 0 && b === 0);
  }

  function filterPinsByRoute(pins, routeCode) {
    var code = String(routeCode || '');
    return (pins || []).filter(function (p) { return String(p.routeCode) === code; });
  }

  function pinsStayOnRoute(pins, routeCode) {
    var code = String(routeCode || '');
    for (var i = 0; i < (pins || []).length; i++) {
      if (String(pins[i].routeCode) !== code) return false;
    }
    return true;
  }

  function coordCoverage(pins) {
    var total = (pins || []).length;
    var plotted = 0;
    (pins || []).forEach(function (p) {
      if (hasFiniteCoord(p.latitude, p.longitude)) plotted += 1;
    });
    return { total: total, plotted: plotted, missing: total - plotted };
  }

  function coverageLabel(coverage) {
    coverage = coverage || { total: 0, plotted: 0, missing: 0 };
    if (!coverage.missing) return coverage.total + ' Stops表示';
    return coverage.total + ' Stops中 ' + coverage.plotted + '件表示 / 座標未取得' + coverage.missing + '件';
  }

  var NO_SEQUENCE_MESSAGE = 'Cortex巡回順データがありません。\nExtension v1.6.3以降でCortexを再取得してください。';

  function buildSingleRouteView(model, routeCode, extras) {
    extras = extras || {};
    var code = String(routeCode || '');
    if (!model || !model.complete) {
      return {
        ok: false,
        reason: 'NO_SEQUENCE',
        message: NO_SEQUENCE_MESSAGE,
        routeCode: code,
        pins: [],
        plottedPins: [],
        coverage: { total: 0, plotted: 0, missing: 0 },
        stats: { routeCode: code, driverName: '', allStopCount: 0, priorityStopCount: 0, priorityPackageCount: 0, departure: extras.departure || '' }
      };
    }
    var pins = filterPinsByRoute(model.pins, code);
    if (!pins.length) {
      return {
        ok: false,
        reason: 'ROUTE_EMPTY',
        message: '選択RouteのCortex巡回Stopがありません。',
        routeCode: code,
        pins: [],
        plottedPins: [],
        coverage: { total: 0, plotted: 0, missing: 0 },
        stats: { routeCode: code, driverName: extras.assignmentDriverName || '', allStopCount: 0, priorityStopCount: 0, priorityPackageCount: 0, departure: extras.departure || '' }
      };
    }
    var coverage = coordCoverage(pins);
    var stats = summarizeSelectedRoute(pins, extras.packages || [], code);
    if (!stats.driverName && extras.assignmentDriverName) stats.driverName = extras.assignmentDriverName;
    stats.departure = extras.departure || '';
    return {
      ok: true,
      reason: '',
      message: '',
      routeCode: code,
      pins: pins,
      plottedPins: pins.filter(function (p) { return hasFiniteCoord(p.latitude, p.longitude); }),
      coverage: coverage,
      stats: stats,
      incomplete: coverage.missing > 0,
      singleRoute: pinsStayOnRoute(pins, code)
    };
  }

  function lookupLineUser(name, mapping, japaneseNames, resolveDriverKey) {
    if (!name) return null;
    mapping = mapping || {};
    japaneseNames = japaneseNames || {};
    var key = typeof resolveDriverKey === 'function' ? (resolveDriverKey(name) || name) : name;
    var userId = mapping[key] || mapping[name] || '';
    if (!userId) {
      var orig;
      for (orig in japaneseNames) {
        if (!Object.prototype.hasOwnProperty.call(japaneseNames, orig)) continue;
        if ((japaneseNames[orig] === name || japaneseNames[orig] === key) && mapping[orig]) {
          key = orig;
          userId = mapping[orig];
          break;
        }
      }
    }
    if (!userId) return null;
    return {
      driverKey: key,
      userId: userId,
      displayName: japaneseNames[key] || name
    };
  }

  function resolveLineSendTarget(opts) {
    opts = opts || {};
    var assignment = String(opts.assignmentDriverName || '').trim();
    var cortex = String(opts.cortexDriverName || '').trim();
    var fromAssign = lookupLineUser(assignment, opts.lineMapping, opts.driverJapaneseNames, opts.resolveDriverKey);
    var fromCortex = lookupLineUser(cortex, opts.lineMapping, opts.driverJapaneseNames, opts.resolveDriverKey);
    if (fromAssign) {
      return {
        ok: true,
        source: 'assignment',
        conflict: !!(fromCortex && fromCortex.userId !== fromAssign.userId),
        driverKey: fromAssign.driverKey,
        userId: fromAssign.userId,
        displayName: fromAssign.displayName
      };
    }
    if (fromCortex) {
      return {
        ok: true,
        source: 'cortex',
        conflict: false,
        driverKey: fromCortex.driverKey,
        userId: fromCortex.userId,
        displayName: fromCortex.displayName
      };
    }
    var shown = assignment || cortex || '';
    return {
      ok: false,
      source: '',
      reason: 'UNRESOLVED_DRIVER',
      message: (shown || 'Driver') + ' のLINE IDが未登録です。自動送信しません。',
      displayName: shown,
      driverKey: '',
      userId: ''
    };
  }

  function isPublicHttpsImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    var u = url.trim();
    if (!u || u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return false;
    if (/\s/.test(u)) return false;
    return /^https:\/\/[a-z0-9][a-z0-9.-]*(:\d+)?\/\S+$/i.test(u);
  }

  function lineImagePins(view) {
    if (!view || !view.ok || !view.singleRoute) return [];
    var code = String(view.routeCode || '');
    return (view.plottedPins || view.pins || []).filter(function (p) {
      return p && String(p.routeCode || '') === code && hasFiniteCoord(p.latitude, p.longitude);
    });
  }

  function buildLineText(view, target) {
    var s = (view && view.stats) || {};
    var cov = (view && view.coverage) || { total: 0, plotted: 0, missing: 0 };
    var msg = '🚚 OFK3 配送情報（Cortex巡回順）\n\n';
    msg += '■ 担当: ' + ((target && target.displayName) || s.driverName || '-') + '\n';
    msg += '■ ルート: ' + ((view && view.routeCode) || '-') + '\n';
    msg += '■ 全Stop: ' + (s.allStopCount || 0) + '\n';
    msg += '■ 13:00必達: ' + (s.priorityStopCount || 0) + ' Stops / ' + (s.priorityPackageCount || 0) + ' Packages\n';
    if (s.departure) msg += '■ 出発: ' + s.departure + '\n';
    if (cov.missing) msg += '\n⚠ 座標未取得 ' + cov.missing + '件（' + cov.plotted + '/' + cov.total + '件表示）\n';
    msg += '\n番号はCortex巡回順です。';
    return msg;
  }

  function buildLineMessages(text, imageUrl) {
    if (!isPublicHttpsImageUrl(imageUrl)) return [];
    return [
      { type: 'text', text: String(text || '') },
      { type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl }
    ];
  }

  function buildLinePreview(view, target, extras) {
    extras = extras || {};
    if (!view || !view.ok || !view.singleRoute) {
      return {
        ok: false,
        canSend: false,
        messages: [],
        imageUrl: '',
        message: (view && view.message) || NO_SEQUENCE_MESSAGE
      };
    }
    if (!target || !target.ok || !target.userId) {
      return {
        ok: false,
        canSend: false,
        messages: [],
        imageUrl: '',
        message: (target && target.message) || '送信先Driverが未解決です。自動送信しません。'
      };
    }
    var imagePins = lineImagePins(view);
    if (!imagePins.length) {
      return {
        ok: false,
        canSend: false,
        messages: [],
        imageUrl: '',
        routeCode: view.routeCode,
        message: '座標付きStopが無くMAP画像を生成できないため送信しません。'
      };
    }
    if (!pinsStayOnRoute(imagePins, view.routeCode)) {
      return {
        ok: false,
        canSend: false,
        messages: [],
        imageUrl: '',
        routeCode: view.routeCode,
        message: '他RouteのStopが混在しているため送信しません。'
      };
    }
    var msg = buildLineText(view, target);
    var imageUrl = String(extras.imageUrl || '');
    if (!isPublicHttpsImageUrl(imageUrl)) {
      return {
        ok: false,
        canSend: false,
        routeCode: view.routeCode,
        userId: target.userId,
        driverKey: target.driverKey,
        displayName: target.displayName,
        text: msg,
        imageUrl: '',
        messages: [],
        pinCount: view.pins.length,
        plottedCount: imagePins.length,
        missingCount: (view.coverage && view.coverage.missing) || 0,
        message: extras.imageUrl
          ? 'MAP画像URLがHTTPS公開ではないため送信しません。'
          : 'MAP画像の公開に失敗したため送信しません。テキストのみでは送信しません。'
      };
    }
    var messages = buildLineMessages(msg, imageUrl);
    var hasImage = messages.some(function (m) { return m && m.type === 'image' && m.originalContentUrl; });
    if (!hasImage || messages.length < 2) {
      return {
        ok: false,
        canSend: false,
        messages: [],
        imageUrl: '',
        message: 'MAP画像messageを組み立てられないため送信しません。'
      };
    }
    return {
      ok: true,
      canSend: true,
      routeCode: view.routeCode,
      userId: target.userId,
      driverKey: target.driverKey,
      displayName: target.displayName,
      text: msg,
      imageUrl: imageUrl,
      messages: messages,
      pinCount: view.pins.length,
      plottedCount: imagePins.length,
      missingCount: (view.coverage && view.coverage.missing) || 0
    };
  }

  var api = {
    buildRouteSequenceModel: buildRouteSequenceModel,
    summarizeSelectedRoute: summarizeSelectedRoute,
    sequencePopup: sequencePopup,
    hasFiniteCoord: hasFiniteCoord,
    filterPinsByRoute: filterPinsByRoute,
    pinsStayOnRoute: pinsStayOnRoute,
    coordCoverage: coordCoverage,
    coverageLabel: coverageLabel,
    buildSingleRouteView: buildSingleRouteView,
    resolveLineSendTarget: resolveLineSendTarget,
    isPublicHttpsImageUrl: isPublicHttpsImageUrl,
    lineImagePins: lineImagePins,
    buildLineMessages: buildLineMessages,
    buildLinePreview: buildLinePreview,
    NO_SEQUENCE_MESSAGE: NO_SEQUENCE_MESSAGE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OFK3RouteSequence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
