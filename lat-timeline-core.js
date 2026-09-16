/**
 * OFK3 LAT — chronological timeline reconstruction (UI-independent).
 *
 * W37 LOW/DSP beacon cells like "57:46.8" are minutes:seconds.tenths of a clock
 * (Amazon's own diff_plan_vs_actual_mins matches this), NOT HH:mm and NOT
 * "hour % 24". Date-bearing cells stay exact. Bare HH:mm without tenths keeps
 * the existing clock-of-day + business-order chain.
 *
 * mm:ss visits reconstruct departure against planned first, then pin
 * arrival/entrance at-or-before departure (hour wrap: 34:55 + 07:22 => 10:34
 * then 11:07). Scans are only snapped into the [entrance, exit] stay window
 * when a candidate actually sits inside it; scans outside that window stay
 * unresolved and remain 判定不可. Missing events are skipped for the 120-min
 * adjacent-gap rule.
 */
(function (global) {
  'use strict';

  var LAT_TIMELINE_GAP_SUSPICIOUS_MIN = 120;
  var LAT_TIMELINE_DIFF_SUSPICIOUS_MIN = 180;
  var LAT_TIMELINE_ROLLOVER_SUSPICIOUS_DAYS = 2;
  var EVENT_ORDER = [
    { key: 'arrival', outKey: 'arrivalAbs' },
    { key: 'entrance', outKey: 'entranceAbs' },
    { key: 'firstScan', outKey: 'firstScanAbs' },
    { key: 'lastScan', outKey: 'lastScanAbs' },
    { key: 'departure', outKey: 'departureAbs' },
    { key: 'exit', outKey: 'exitAbs' },
  ];

  function latParseDateToDayNumber(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    var str = String(raw).trim();
    if (!str) return null;
    var m = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) return Math.floor(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) / 86400000);
    var num = parseFloat(str);
    if (!isNaN(num) && str.match(/^-?\d+\.?\d*$/) && num > 40000) {
      return Math.floor(num) - 25569;
    }
    var m8 = str.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m8) return Math.floor(Date.UTC(parseInt(m8[1], 10), parseInt(m8[2], 10) - 1, parseInt(m8[3], 10)) / 86400000);
    return null;
  }

  function latLooksLikeBeaconMmSs(raw) {
    return /^\d{1,2}:\d{2}\.\d+$/.test(String(raw == null ? '' : raw).trim());
  }

  function latParseMmSsMinutes(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var m = s.match(/^(\d{1,2}):(\d{2})(?:\.(\d+))?$/);
    if (!m) return null;
    var mm = parseInt(m[1], 10);
    var ss = parseInt(m[2], 10);
    if (mm > 59 || ss > 59) return null;
    var frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
    return mm + (ss + frac) / 60;
  }

  function latResolveOwnDateAbsoluteMinutes(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    var str = String(raw).trim();
    if (!str) return null;
    var num = parseFloat(str);
    if (!isNaN(num) && str.match(/^-?\d+\.?\d*$/) && num > 40000) {
      var ownDay = Math.floor(num) - 25569;
      var timeMin = Math.round((num - Math.floor(num)) * 1440);
      return ownDay * 1440 + timeMin;
    }
    var ownDay2 = latParseDateToDayNumber(str);
    if (ownDay2 === null) return null;
    var tm = str.match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/);
    if (!tm) return null;
    var timeMin2 = parseInt(tm[1], 10) * 60 + parseInt(tm[2], 10);
    if (tm[3]) timeMin2 += parseInt(tm[3], 10) / 60;
    return ownDay2 * 1440 + timeMin2;
  }

  function latRawClockMinuteOfDay(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    var str = String(raw).trim();
    if (!str) return null;
    var num = parseFloat(str);
    if (!isNaN(num) && str.match(/^-?\d+\.?\d*$/)) {
      if (num > 40000) {
        var timeMin = Math.round((num - Math.floor(num)) * 1440);
        return ((timeMin % 1440) + 1440) % 1440;
      }
      if (num >= 0 && num < 1) return Math.round(num * 1440) % 1440;
      if (num >= 1 && num < 86400) return Math.round(num / 60) % 1440;
    }
    var tm = str.match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/);
    if (!tm) return null;
    var timeMin2 = parseInt(tm[1], 10) * 60 + parseInt(tm[2], 10);
    if (tm[3]) timeMin2 += parseInt(tm[3], 10) / 60;
    return ((timeMin2 % 1440) + 1440) % 1440;
  }

  function latReconstructMmSsAbs(raw, anchorAbs, bounds) {
    var within = latParseMmSsMinutes(raw);
    if (within == null) return null;
    var anchor = anchorAbs == null ? within : anchorAbs;
    var anchorHour = Math.floor(anchor / 60);
    var bestAbs = null;
    var bestDiff = Infinity;
    var bestDh = 0;
    var boundedAbs = null;
    var boundedDiff = Infinity;
    var slack = 0.2;
    var minAbs = bounds && bounds.minAbs != null ? bounds.minAbs : null;
    var maxAbs = bounds && bounds.maxAbs != null ? bounds.maxAbs : null;
    for (var dh = -2; dh <= 2; dh++) {
      var cand = (anchorHour + dh) * 60 + within;
      var diff = Math.abs(cand - anchor);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestAbs = cand;
        bestDh = dh;
      }
      var inMin = minAbs == null || cand >= minAbs - slack;
      var inMax = maxAbs == null || cand <= maxAbs + slack;
      if (inMin && inMax && diff < boundedDiff) {
        boundedDiff = diff;
        boundedAbs = cand;
      }
    }
    return {
      abs: boundedAbs != null ? boundedAbs : bestAbs,
      hourDelta: bestDh,
      confidence: 'inferred',
      source: 'beacon-mmss',
      usedBounds: boundedAbs != null,
    };
  }

  function latResolveTimelineField(raw, prevAbs, anchorAbs, bounds) {
    if (raw === null || raw === undefined || raw === '') {
      return { abs: null, hasOwnDate: false, rolloverDays: 0, confidence: 'unresolved', source: null };
    }
    var ownDateAbs = latResolveOwnDateAbsoluteMinutes(raw);
    if (ownDateAbs !== null) {
      return { abs: ownDateAbs, hasOwnDate: true, rolloverDays: 0, confidence: 'exact', source: 'excel-date' };
    }
    var localAnchor = prevAbs != null ? prevAbs : anchorAbs;
    if (latLooksLikeBeaconMmSs(raw)) {
      var recon = latReconstructMmSsAbs(raw, localAnchor, bounds);
      if (!recon) return { abs: null, hasOwnDate: false, rolloverDays: 0, confidence: 'unresolved', source: 'beacon-mmss' };
      return {
        abs: recon.abs,
        hasOwnDate: false,
        rolloverDays: 0,
        confidence: 'inferred',
        source: 'beacon-mmss',
      };
    }
    var clockMin = latRawClockMinuteOfDay(raw);
    if (clockMin === null) return { abs: null, hasOwnDate: false, rolloverDays: 0, confidence: 'unresolved', source: null };

    if (prevAbs === null) {
      var anchorDay = Math.floor(anchorAbs / 1440);
      var bestAbs = null;
      var bestDiff = Infinity;
      var bestK = 0;
      for (var k = -2; k <= 2; k++) {
        var cand = (anchorDay + k) * 1440 + clockMin;
        var diff = Math.abs(cand - anchorAbs);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestAbs = cand;
          bestK = k;
        }
      }
      return { abs: bestAbs, hasOwnDate: false, rolloverDays: Math.abs(bestK), confidence: 'inferred', source: 'route-anchor' };
    }

    var baseDay = Math.floor(prevAbs / 1440);
    var slack = 5;
    for (var f = 0; f <= 3; f++) {
      var cand2 = (baseDay + f) * 1440 + clockMin;
      if (cand2 >= prevAbs - slack) {
        return { abs: cand2, hasOwnDate: false, rolloverDays: f, confidence: 'inferred', source: 'timeline-rollover' };
      }
    }
    return {
      abs: (baseDay + 3) * 1440 + clockMin,
      hasOwnDate: false,
      rolloverDays: 3,
      confidence: 'inferred',
      source: 'timeline-rollover',
    };
  }

  function reasonCode(reason) {
    if (reason.indexOf('出発差分') === 0) return 'departure_diff_over_180';
    if (reason.indexOf('が') >= 0 && reason.indexOf('日分ロールオーバー') >= 0) return 'rollover_over_2days';
    if (reason.indexOf('順序が成立しない') >= 0) return 'event_order_invalid';
    if (reason.indexOf('間隔が') >= 0) return 'adjacent_gap_over_120';
    return 'other';
  }

  function normalizeLatTimeline(input) {
    input = input || {};
    var routeDayNumber = input.routeDayNumber;
    var fieldMeta = {};

    var scheduledAbs = null;
    if (input.plannedDeparture) {
      scheduledAbs = latResolveOwnDateAbsoluteMinutes(input.plannedDeparture);
      if (scheduledAbs === null) {
        var schedClock = latRawClockMinuteOfDay(input.plannedDeparture);
        if (schedClock !== null && routeDayNumber !== null && routeDayNumber !== undefined) {
          scheduledAbs = routeDayNumber * 1440 + (schedClock % 1440);
        }
      }
    }
    var anchorAbs = scheduledAbs !== null ? scheduledAbs
      : (routeDayNumber !== null && routeDayNumber !== undefined ? routeDayNumber * 1440 : 0);

    var result = { plannedDepartureAbs: scheduledAbs };
    var resolvedByKey = {};
    var mmssVisit = false;
    var ei;
    for (ei = 0; ei < EVENT_ORDER.length; ei++) {
      if (latLooksLikeBeaconMmSs(input[EVENT_ORDER[ei].key])) {
        mmssVisit = true;
        break;
      }
    }

    function assignField(key, resolved) {
      var spec = null;
      var si;
      for (si = 0; si < EVENT_ORDER.length; si++) {
        if (EVENT_ORDER[si].key === key) spec = EVENT_ORDER[si];
      }
      resolvedByKey[key] = resolved;
      if (spec) result[spec.outKey] = resolved.abs;
      fieldMeta[key] = {
        value: resolved.abs,
        confidence: resolved.confidence,
        source: resolved.source,
      };
    }

    if (mmssVisit) {
      // Departure is reconstructed against planned first (W37: Amazon
      // diff_plan_vs_actual_mins matches this for 181/188). Arrival/entrance
      // then pick the hour that stays at-or-before departure (clock wrap
      // 34:55 → 10:34 when dep is 11:07). Scans are placed inside the
      // [entrance, exit] stay window when a candidate exists; otherwise they
      // keep nearest-to-departure and remain flaggable.
      assignField('departure', latResolveTimelineField(input.departure, null, anchorAbs));
      var depAbs = resolvedByKey.departure.abs;
      var visitRef = depAbs != null ? depAbs : anchorAbs;
      assignField('exit', latResolveTimelineField(input.exit, visitRef, anchorAbs, depAbs != null ? { minAbs: depAbs } : null));
      assignField('entrance', latResolveTimelineField(input.entrance, visitRef, anchorAbs, depAbs != null ? { maxAbs: depAbs } : null));
      assignField('arrival', latResolveTimelineField(input.arrival, visitRef, anchorAbs, depAbs != null ? { maxAbs: depAbs } : null));
      var windowMin = resolvedByKey.entrance.abs != null ? resolvedByKey.entrance.abs : resolvedByKey.arrival.abs;
      var windowMax = resolvedByKey.exit.abs != null ? resolvedByKey.exit.abs : depAbs;
      var scanBounds = {};
      if (windowMin != null) scanBounds.minAbs = windowMin;
      if (windowMax != null) scanBounds.maxAbs = windowMax;
      var hasScanBounds = windowMin != null && windowMax != null;
      assignField('firstScan', latResolveTimelineField(input.firstScan, visitRef, anchorAbs, hasScanBounds ? scanBounds : null));
      assignField('lastScan', latResolveTimelineField(input.lastScan, visitRef, anchorAbs, hasScanBounds ? scanBounds : null));
    } else {
      var chainPrev = null;
      for (ei = 0; ei < EVENT_ORDER.length; ei++) {
        var chainKey = EVENT_ORDER[ei].key;
        var chained = latResolveTimelineField(input[chainKey], chainPrev, anchorAbs);
        assignField(chainKey, chained);
        if (chained.abs !== null) chainPrev = chained.abs;
      }
    }

    var reasons = [];
    var reasonCodes = [];
    var prevAbs = null;
    var prevLabel = null;
    var prevIndex = -1;
    for (var i = 0; i < EVENT_ORDER.length; i++) {
      var key = EVENT_ORDER[i].key;
      var resolved = resolvedByKey[key] || { abs: null, rolloverDays: 0 };
      if (resolved.abs !== null) {
        if (resolved.rolloverDays >= LAT_TIMELINE_ROLLOVER_SUSPICIOUS_DAYS) {
          var rollMsg = key + 'が' + resolved.rolloverDays + '日分ロールオーバーして解決された';
          reasons.push(rollMsg);
          reasonCodes.push('rollover_over_2days');
        }
        if (prevAbs !== null) {
          var gap = resolved.abs - prevAbs;
          var consecutive = i - prevIndex === 1;
          if (consecutive && gap > LAT_TIMELINE_GAP_SUSPICIOUS_MIN) {
            reasons.push(prevLabel + '→' + key + 'の間隔が' + Math.round(gap) + '分で異常に長い');
            reasonCodes.push('adjacent_gap_over_120');
          } else if (gap < -5) {
            reasons.push(prevLabel + '→' + key + 'の順序が成立しない(' + Math.round(gap) + '分)');
            reasonCodes.push('event_order_invalid');
          }
        }
        prevAbs = resolved.abs;
        prevLabel = key;
        prevIndex = i;
      }
    }

    if (scheduledAbs !== null && result.departureAbs !== null) {
      var diff = result.departureAbs - scheduledAbs;
      if (Math.abs(diff) > LAT_TIMELINE_DIFF_SUSPICIOUS_MIN) {
        reasons.push('出発差分が' + Math.round(diff) + '分で異常に大きい');
        reasonCodes.push('departure_diff_over_180');
      }
    }

    result.isTimelineSuspicious = reasons.length > 0;
    result.timelineWarningReason = reasons.join('; ');
    result.timelineWarningCodes = reasonCodes;
    result.fieldMeta = fieldMeta;
    return result;
  }

  function latFormatAbsClock(abs) {
    if (abs == null || !isFinite(abs)) return '';
    var tod = ((abs % 1440) + 1440) % 1440;
    var hh = Math.floor(tod / 60);
    var mmFloat = tod - hh * 60;
    var mm = Math.floor(mmFloat);
    var ss = Math.round((mmFloat - mm) * 60);
    if (ss === 60) {
      ss = 0;
      mm += 1;
    }
    if (mm === 60) {
      mm = 0;
      hh += 1;
    }
    hh = hh % 24;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  var LatTimelineCore = {
    LAT_TIMELINE_GAP_SUSPICIOUS_MIN: LAT_TIMELINE_GAP_SUSPICIOUS_MIN,
    LAT_TIMELINE_DIFF_SUSPICIOUS_MIN: LAT_TIMELINE_DIFF_SUSPICIOUS_MIN,
    latParseDateToDayNumber: latParseDateToDayNumber,
    latLooksLikeBeaconMmSs: latLooksLikeBeaconMmSs,
    latParseMmSsMinutes: latParseMmSsMinutes,
    latResolveOwnDateAbsoluteMinutes: latResolveOwnDateAbsoluteMinutes,
    latRawClockMinuteOfDay: latRawClockMinuteOfDay,
    latResolveTimelineField: latResolveTimelineField,
    normalizeLatTimeline: normalizeLatTimeline,
    latFormatAbsClock: latFormatAbsClock,
    reasonCode: reasonCode,
  };

  global.LatTimelineCore = LatTimelineCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = LatTimelineCore;
})(typeof window !== 'undefined' ? window : global);
