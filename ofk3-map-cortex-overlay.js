/**
 * Dashboard 🗺 配送MAP: Cortex Stop numbers + 13:00 highlight on the existing area-colored map.
 * Read-only over already-captured Cortex data (route-details / 13:00 priority / assist index).
 * Never triggers Cortex access, Stop opening or trDetails fetch.
 * JOIN key is routeCode + trackingId (cycle "Tracking ID" == Cortex scannableId); address is never the sole key.
 * 13:00 judgment is reused from the priority packages as-is (package-level); nothing is re-judged here.
 */
(function (root) {
  'use strict';

  var SEP = '\u0000';
  var COORD_CACHE_KEY = 'ofk3MapCoordCache:v1';
  var COORD_CACHE_MAX = 4000;
  var DAY_MS = 86400000;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function hasFiniteCoord(lat, lng) {
    if (lat == null || lng == null || lat === '' || lng === '') return false;
    var a = Number(lat), b = Number(lng);
    return isFinite(a) && isFinite(b) && !(a === 0 && b === 0);
  }

  function toSeq(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function defaultNormalize(addr) {
    return String(addr == null ? '' : addr).replace(/[\s\u3000,]+/g, ' ').trim();
  }

  function nowMs() {
    if (root.performance && typeof root.performance.now === 'function') return root.performance.now();
    return Date.now();
  }

  // ---------- mapCortexIndex[routeCode].stops[stopNumber] ----------

  var indexVersion = 0;

  function buildMapCortexIndex(src) {
    src = src || {};
    var byRoute = {};

    function route(code) {
      code = String(code || '');
      if (!byRoute[code]) {
        byRoute[code] = {
          routeCode: code,
          stops: {},
          tidToSeqs: {},
          priorityStopNumbers: [],
          priorityStopCount: 0,
          priorityPackageCount: 0,
          stopCount: 0
        };
      }
      return byRoute[code];
    }

    function stop(r, seq) {
      var k = String(seq);
      if (!r.stops[k]) {
        r.stops[k] = {
          stopNumber: seq,
          plannedArrival: '',
          address: '',
          latitude: null,
          longitude: null,
          isPriority13: false,
          priorityPackageCount: 0,
          packages: []
        };
        Object.defineProperty(r.stops[k], '_byTid', { value: {}, enumerable: false });
      }
      return r.stops[k];
    }

    function addPackage(st, tid) {
      if (!tid) return null;
      if (st._byTid[tid]) return st._byTid[tid];
      var p = { trackingId: tid, isPriority13: false, windowLabel: '', bag: null, bagStatus: null, driverAid: null };
      st._byTid[tid] = p;
      st.packages.push(p);
      return p;
    }

    (src.routeStops || []).forEach(function (s) {
      if (!s) return;
      var seq = toSeq(s.sequenceNumber != null ? s.sequenceNumber : s.stop);
      if (seq == null) return;
      var st = stop(route(s.routeCode), seq);
      st.plannedArrival = s.plannedEndClock || st.plannedArrival;
      st.address = s.address || st.address;
      if (hasFiniteCoord(s.latitude, s.longitude)) {
        st.latitude = Number(s.latitude);
        st.longitude = Number(s.longitude);
      }
    });

    (src.packageSequenceIndex || []).forEach(function (row) {
      if (!row) return;
      var seq = toSeq(row.sequenceNumber);
      var tid = String(row.trackingId || '').trim();
      if (seq == null || !tid) return;
      var r = route(row.routeCode);
      var list = r.tidToSeqs[tid] || (r.tidToSeqs[tid] = []);
      if (list.indexOf(seq) < 0) list.push(seq);
      addPackage(stop(r, seq), tid);
    });

    (src.priorityPackages || []).forEach(function (p) {
      if (!p) return;
      var seq = toSeq(p.stop);
      if (seq == null) return;
      var r = route(p.routeCode);
      var st = stop(r, seq);
      if (!st.plannedArrival) st.plannedArrival = p.plannedEndClock || '';
      if (!st.address) st.address = p.address || '';
      if (st.latitude == null && hasFiniteCoord(p.latitude, p.longitude)) {
        st.latitude = Number(p.latitude);
        st.longitude = Number(p.longitude);
      }
      var tid = String(p.trackingId || '').trim();
      if (tid && !r.tidToSeqs[tid]) r.tidToSeqs[tid] = [seq];
      var pkg = addPackage(st, tid);
      if (pkg && pkg.isPriority13) return;
      if (pkg) {
        pkg.isPriority13 = true;
        pkg.windowLabel = p.windowLabel || '';
      }
      st.isPriority13 = true;
      st.priorityPackageCount += 1;
      r.priorityPackageCount += 1;
    });

    var assist = {};
    (src.assistIndex || []).forEach(function (a) {
      if (!a || !a.trackingId) return;
      assist[String(a.routeCode || '') + SEP + String(a.trackingId).trim()] = a;
    });

    Object.keys(byRoute).forEach(function (code) {
      var r = byRoute[code];
      var keys = Object.keys(r.stops);
      r.stopCount = keys.length;
      keys.forEach(function (k) {
        var st = r.stops[k];
        st.packages.forEach(function (pkg) {
          var a = assist[code + SEP + pkg.trackingId];
          if (!a) return;
          pkg.bag = a.bagDisplay ? String(a.bagDisplay) : null;
          pkg.bagStatus = a.bagStatus || null;
          pkg.driverAid = a.driverAid == null || a.driverAid === '' ? null : String(a.driverAid);
        });
        if (st.isPriority13) r.priorityStopNumbers.push(st.stopNumber);
      });
      r.priorityStopNumbers.sort(function (a, b) { return a - b; });
      r.priorityStopCount = r.priorityStopNumbers.length;
    });

    indexVersion += 1;
    return {
      version: indexVersion,
      localDate: String(src.localDate || ''),
      byRoute: byRoute,
      routeCount: Object.keys(byRoute).length
    };
  }

  var memo = { entry: null, routeStops: null, seqIndex: null, assistIndex: null, index: null, builds: 0 };
  var routeModelCache = {};

  function readCortexSource(c13) {
    if (!c13 || typeof c13.getEntry !== 'function') return null;
    var entry = c13.getEntry();
    if (!entry) return null;
    return {
      entry: entry,
      localDate: entry.localDate || '',
      routeStops: typeof c13.getRouteStops === 'function' ? c13.getRouteStops() : [],
      packageSequenceIndex: typeof c13.getPackageSequenceIndex === 'function' ? c13.getPackageSequenceIndex() : [],
      assistIndex: typeof c13.getPackageAssistIndex === 'function' ? c13.getPackageAssistIndex() : [],
      priorityPackages: Array.isArray(entry.packages) ? entry.packages : []
    };
  }

  // Memoized on source identity: rebuilt only when Cortex data is (re)loaded, never per MAP click.
  function getMapCortexIndex(c13) {
    var src = readCortexSource(c13 || root.OFK3Cortex13);
    if (!src) return null;
    if (memo.index && memo.entry === src.entry && memo.routeStops === src.routeStops &&
        memo.seqIndex === src.packageSequenceIndex && memo.assistIndex === src.assistIndex) {
      return memo.index;
    }
    memo.entry = src.entry;
    memo.routeStops = src.routeStops;
    memo.seqIndex = src.packageSequenceIndex;
    memo.assistIndex = src.assistIndex;
    memo.index = buildMapCortexIndex(src);
    memo.builds += 1;
    routeModelCache = {};
    return memo.index;
  }

  function indexBuildCount() {
    return memo.builds;
  }

  function resetIndexMemo() {
    memo = { entry: null, routeStops: null, seqIndex: null, assistIndex: null, index: null, builds: 0 };
    routeModelCache = {};
  }

  // state: 'ok' | 'none' (no Cortex data) | 'stale' (not today's data) | 'route-missing'
  function routeCortexState(index, routeCode, today) {
    if (!index) return { state: 'none', route: null };
    if (today && index.localDate && index.localDate !== today) return { state: 'stale', route: null };
    var r = index.byRoute[String(routeCode || '')];
    if (!r || !r.stopCount) return { state: 'route-missing', route: null };
    return { state: 'ok', route: r };
  }

  function cortexStateNote(state) {
    if (state === 'none') return 'Cortex巡回順 未取得';
    if (state === 'stale') return 'Cortex巡回順 未取得（本日分なし）';
    if (state === 'route-missing') return 'Cortex巡回順 未取得（このRoute）';
    return '';
  }

  // ---------- JOIN: cycle rows → Cortex stops ----------

  function joinRouteRows(routeCode, rows, routeIndex, normalize) {
    normalize = typeof normalize === 'function' ? normalize : defaultNormalize;
    var code = String(routeCode || '');
    var bySeq = {};
    var stops = [];
    var unmatchedByKey = {};
    var unmatched = [];
    var diagnostics = [];
    var matchedRowCount = 0;
    var unmatchedRowCount = 0;

    (rows || []).forEach(function (row) {
      if (!row) return;
      var addr = String(row.address || '').trim();
      if (!addr) return;
      var tid = String(row.trackingId || '').trim();
      var seq = null;
      var reason = '';
      var candidates = [];
      if (!routeIndex) reason = 'NO_CORTEX_ROUTE';
      else if (!tid) reason = 'NO_MATCH';
      else {
        var seqs = routeIndex.tidToSeqs[tid] || [];
        if (seqs.length === 1) seq = seqs[0];
        else if (seqs.length > 1) { reason = 'MULTIPLE_MATCH'; candidates = seqs.slice().sort(function (a, b) { return a - b; }); }
        else reason = 'NO_MATCH';
      }
      if (seq != null) {
        matchedRowCount += 1;
        var g = bySeq[seq];
        if (!g) {
          var st = routeIndex.stops[String(seq)] || null;
          g = {
            kind: 'stop',
            routeCode: code,
            stopNumber: seq,
            stop: st,
            address: addr,
            addresses: [],
            trackingIds: [],
            isPriority13: !!(st && st.isPriority13),
            latitude: st && hasFiniteCoord(st.latitude, st.longitude) ? st.latitude : null,
            longitude: st && hasFiniteCoord(st.latitude, st.longitude) ? st.longitude : null
          };
          Object.defineProperty(g, '_norm', { value: {}, enumerable: false });
          bySeq[seq] = g;
          stops.push(g);
        }
        if (g.trackingIds.indexOf(tid) < 0) g.trackingIds.push(tid);
        var nk = normalize(addr) || addr;
        if (!g._norm[nk]) {
          g._norm[nk] = true;
          g.addresses.push(addr);
        }
        return;
      }
      unmatchedRowCount += 1;
      var key = normalize(addr) || addr;
      var u = unmatchedByKey[key];
      if (!u) {
        u = { kind: 'unmatched', routeCode: code, address: addr, trackingIds: [], reasons: [] };
        unmatchedByKey[key] = u;
        unmatched.push(u);
      }
      if (tid && u.trackingIds.indexOf(tid) < 0) u.trackingIds.push(tid);
      if (u.reasons.indexOf(reason) < 0) u.reasons.push(reason);
      if (reason !== 'NO_CORTEX_ROUTE') {
        diagnostics.push({ routeCode: code, trackingId: tid, address: addr, candidateStops: candidates, reason: reason });
      }
    });

    stops.sort(function (a, b) { return a.stopNumber - b.stopNumber; });
    stops.forEach(function (g) {
      if (g.addresses.length > 1) {
        diagnostics.push({
          routeCode: code,
          trackingId: g.trackingIds.join(' '),
          address: g.addresses.join(' / '),
          candidateStops: [g.stopNumber],
          reason: 'ADDRESS_MISMATCH',
          severity: 'warning'
        });
      }
    });

    return {
      routeCode: code,
      stops: stops,
      unmatched: unmatched,
      diagnostics: diagnostics,
      matchedRowCount: matchedRowCount,
      unmatchedRowCount: unmatchedRowCount
    };
  }

  function getRouteModel(key, build) {
    if (routeModelCache[key]) return { model: routeModelCache[key], cached: true };
    var model = build();
    routeModelCache[key] = model;
    return { model: model, cached: false };
  }

  function rowsSignature(rows) {
    var list = rows || [];
    var first = list[0] || {};
    var last = list[list.length - 1] || {};
    return list.length + ':' + (first.trackingId || first.address || '') + ':' + (last.trackingId || last.address || '');
  }

  // ---------- marker / popup HTML ----------

  function stopIconSpec(color, stopNumber, isPriority) {
    var label = stopNumber == null ? '-' : String(stopNumber);
    var digits = label.length;
    var w = digits >= 3 ? 30 : (digits >= 2 ? 24 : 20);
    var h = 20;
    // White gap + red ring + orange halo stays visible even when the area color itself is red.
    var border = '2px solid #fff';
    var shadow = isPriority
      ? '0 0 0 3px #dc2626, 0 0 0 5px #fdba74, 0 1px 4px rgba(0,0,0,.45)'
      : '0 1px 3px rgba(0,0,0,.4)';
    var badge = isPriority
      ? '<span style="position:absolute;top:-12px;right:-12px;font-size:12px;line-height:1;background:#fff;border-radius:50%;padding:1px;">⏰</span>'
      : '';
    var html = '<div style="position:relative;background:' + esc(color) + ';color:#fff;min-width:' + w + 'px;height:' + h + 'px;padding:0 4px;box-sizing:border-box;border-radius:10px;border:' + border + ';display:flex;align-items:center;justify-content:center;font-size:' + (digits >= 3 ? '10px' : '11px') + ';font-weight:700;box-shadow:' + shadow + ';white-space:nowrap;">' + esc(label) + badge + '</div>';
    return {
      className: 'ofk3-dash-stop' + (isPriority ? ' ofk3-dash-stop-p13' : ''),
      html: html,
      iconSize: [w + 6, h + 6],
      iconAnchor: [(w + 6) / 2, (h + 6) / 2]
    };
  }

  function dotIconSpec(color) {
    return {
      className: 'dpin',
      html: '<div style="width:10px;height:10px;background:' + esc(color) + ';border-radius:50%;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>',
      iconSize: [10, 10],
      iconAnchor: [5, 5]
    };
  }

  function packageLines(list, withAid) {
    return list.map(function (p) {
      return '<div style="font-family:monospace;font-size:11px;">' + esc(p.trackingId)
        + '　Bag ' + esc(p.bag || '-')
        + (withAid ? '　Aid ' + esc(p.driverAid == null ? '-' : p.driverAid) : '')
        + '</div>';
    }).join('');
  }

  function stopPackages(group) {
    var st = group.stop || {};
    var list = Array.isArray(st.packages) ? st.packages.slice() : [];
    var seen = {};
    list.forEach(function (p) { seen[p.trackingId] = true; });
    (group.trackingIds || []).forEach(function (tid) {
      if (tid && !seen[tid]) {
        seen[tid] = true;
        list.push({ trackingId: tid, isPriority13: false, bag: null, driverAid: null });
      }
    });
    return list;
  }

  function stopPopupHtml(group) {
    var st = group.stop || {};
    var pkgs = stopPackages(group);
    var pri = pkgs.filter(function (p) { return p.isPriority13; });
    var other = pkgs.filter(function (p) { return !p.isPriority13; });
    var withAid = pkgs.some(function (p) { return p.driverAid != null; });
    return '<div class="ofk3-dash-stop-popup" style="min-width:220px;font-size:12px;line-height:1.5;">'
      + '<div style="font-weight:700;font-size:13px;">Stop ' + esc(group.stopNumber) + '</div>'
      + (pri.length
        ? '<div style="color:#b91c1c;font-weight:700;">⏰ 13:00対象 ' + pri.length + '件</div>'
        : '<div style="color:#6b7280;">13:00対象外</div>')
      + '<div><b>予定到着</b> ' + esc(st.plannedArrival || '-') + '</div>'
      + '<div><b>住所</b> ' + esc(group.address || st.address || '-') + '</div>'
      + (pri.length
        ? '<div style="margin-top:4px;color:#b91c1c;font-weight:700;">13:00対象 DA</div>' + packageLines(pri, withAid)
        : '')
      + (other.length
        ? '<div style="margin-top:4px;font-weight:700;">' + (pri.length ? 'その他 DA' : 'DA') + '</div>' + packageLines(other, withAid)
        : '')
      + '</div>';
  }

  var REASON_LABEL = {
    NO_MATCH: 'Cortexに該当DAなし',
    MULTIPLE_MATCH: '複数Stop候補',
    ADDRESS_MISMATCH: '住所不一致',
    COORDINATE_MISSING: '座標未取得',
    NO_CORTEX_ROUTE: 'Cortex巡回順 未取得'
  };

  function unmatchedPopupHtml(u) {
    var reasons = (u.reasons || []).map(function (r) { return esc(r) + '（' + esc(REASON_LABEL[r] || r) + '）'; }).join(' / ');
    return '<div class="ofk3-dash-stop-popup" style="min-width:200px;font-size:12px;line-height:1.5;">'
      + '<div style="font-weight:700;color:#6b7280;">Stop番号未照合</div>'
      + (reasons ? '<div style="font-size:11px;color:#6b7280;">' + reasons + '</div>' : '')
      + '<div><b>住所</b> ' + esc(u.address || '-') + '</div>'
      + ((u.trackingIds || []).length
        ? '<div style="margin-top:4px;font-weight:700;">DA</div>' + u.trackingIds.map(function (t) {
          return '<div style="font-family:monospace;font-size:11px;">' + esc(t) + '</div>';
        }).join('')
        : '')
      + '</div>';
  }

  // ---------- persistent coordinate cache ----------

  function createCoordCache(storage, opts) {
    opts = opts || {};
    var key = opts.key || COORD_CACHE_KEY;
    var max = opts.max || COORD_CACHE_MAX;
    var clock = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var data = null;
    var dirty = false;
    var timer = null;

    function load() {
      if (data) return data;
      data = {};
      try {
        var raw = storage && storage.getItem(key);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && parsed.v === 1 && parsed.e && typeof parsed.e === 'object') data = parsed.e;
        }
      } catch (e) {
        data = {};
      }
      return data;
    }

    function flush() {
      timer = null;
      if (!dirty || !storage) return;
      dirty = false;
      var keys = Object.keys(data);
      if (keys.length > max) {
        keys.sort(function (a, b) { return (data[a][2] || 0) - (data[b][2] || 0); });
        keys.slice(0, keys.length - max).forEach(function (k) { delete data[k]; });
      }
      try {
        storage.setItem(key, JSON.stringify({ v: 1, e: data }));
      } catch (e) {}
    }

    function schedule() {
      dirty = true;
      if (timer || typeof setTimeout !== 'function') return;
      timer = setTimeout(flush, opts.flushDelay == null ? 400 : opts.flushDelay);
    }

    return {
      // Coordinates never expire for display; updatedAt only drives pruning order.
      get: function (norm) {
        if (!norm) return null;
        var e = load()[norm];
        if (!e || !hasFiniteCoord(e[0], e[1])) return null;
        return { lat: Number(e[0]), lng: Number(e[1]), updatedAt: e[2] || 0 };
      },
      set: function (norm, lat, lng) {
        if (!norm || !hasFiniteCoord(lat, lng)) return;
        var d = load();
        var prev = d[norm];
        var t = clock();
        if (prev && prev[0] === Number(lat) && prev[1] === Number(lng) && t - (prev[2] || 0) < 30 * DAY_MS) return;
        d[norm] = [Number(lat), Number(lng), t];
        schedule();
      },
      size: function () { return Object.keys(load()).length; },
      flush: flush
    };
  }

  // ---------- rate-limited geocode queue ----------

  function createGeocodeQueue(resolver, opts) {
    opts = opts || {};
    var concurrency = Math.max(1, opts.concurrency || 3);
    var queue = [];
    var inflight = {};
    var active = 0;
    var stats = { requests: 0, deduped: 0, maxActive: 0, cancelled: 0 };

    function pump() {
      while (active < concurrency && queue.length) {
        var job = queue.shift();
        active += 1;
        if (active > stats.maxActive) stats.maxActive = active;
        stats.requests += 1;
        run(job);
      }
    }

    function run(job) {
      var p;
      try { p = Promise.resolve(resolver(job.addr)); } catch (e) { p = Promise.resolve(null); }
      p.then(function (r) { return r; }, function () { return null; }).then(function (r) {
        active -= 1;
        delete inflight[job.key];
        job.resolve(r || null);
        pump();
      });
    }

    return {
      request: function (key, addr) {
        key = key || addr;
        if (inflight[key]) {
          stats.deduped += 1;
          return inflight[key];
        }
        var job = { key: key, addr: addr };
        var promise = new Promise(function (resolve) { job.resolve = resolve; });
        inflight[key] = promise;
        queue.push(job);
        pump();
        return promise;
      },
      // Drops not-yet-started jobs (MAP closed / reopened). In-flight ones finish and still fill the cache.
      cancelPending: function () {
        var dropped = queue;
        queue = [];
        dropped.forEach(function (job) {
          stats.cancelled += 1;
          delete inflight[job.key];
          job.resolve(null);
        });
        return dropped.length;
      },
      activeCount: function () { return active; },
      pendingCount: function () { return queue.length; },
      stats: stats
    };
  }

  // ---------- performance marks ----------

  var PERF_MARKS = ['mapClickAt', 'modalCreatedAt', 'routeDataReadyAt', 'leafletReadyAt', 'firstMarkerAt', 'cachedMarkersAt', 'coordinatesReadyAt', 'allMarkersReadyAt'];

  function createMapPerf(routeCode, clock) {
    clock = typeof clock === 'function' ? clock : nowMs;
    var marks = {};
    var counters = { cacheHits: 0, cortexCoords: 0, masterHits: 0, geocodeRequests: 0, pending: 0, stopMarkers: 0, unmatchedMarkers: 0 };
    function span(a, b) {
      return marks[a] != null && marks[b] != null ? Math.round(marks[b] - marks[a]) : null;
    }
    return {
      routeCode: String(routeCode || ''),
      marks: marks,
      counters: counters,
      mark: function (name) {
        if (marks[name] == null) marks[name] = clock();
        return marks[name];
      },
      summary: function () {
        var endMark = marks.allMarkersReadyAt != null ? 'allMarkersReadyAt' : 'cachedMarkersAt';
        return {
          routeCode: this.routeCode,
          modal: span('mapClickAt', 'modalCreatedAt'),
          routeData: span('modalCreatedAt', 'routeDataReadyAt'),
          leafletInit: span('routeDataReadyAt', 'leafletReadyAt'),
          cachedMarkers: span('leafletReadyAt', 'cachedMarkersAt'),
          firstMarker: span('mapClickAt', 'firstMarkerAt'),
          geocode: span('cachedMarkersAt', 'coordinatesReadyAt'),
          markerRender: span('coordinatesReadyAt', 'allMarkersReadyAt'),
          total: span('mapClickAt', endMark),
          counters: Object.assign({}, counters)
        };
      }
    };
  }

  function recordPerf(perf, extra) {
    var s = perf.summary();
    if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
    var log = root.OFK3MapPerfLog || (root.OFK3MapPerfLog = []);
    log.push(s);
    if (log.length > 20) log.splice(0, log.length - 20);
    try { if (root.console && console.info) console.info('[OFK3 MAP perf]', JSON.stringify(s)); } catch (e) {}
    return s;
  }

  // ---------- area grouping (same rule as the legacy MAP) ----------

  function computeAreaGroups(addresses, areaOf, palette) {
    var areaGroups = {};
    (addresses || []).forEach(function (a) {
      var name = (typeof areaOf === 'function' ? areaOf(a) : '') || '不明';
      if (!areaGroups[name]) areaGroups[name] = { count: 0, addresses: [] };
      areaGroups[name].count += 1;
      areaGroups[name].addresses.push(a);
    });
    var areaList = Object.keys(areaGroups).sort(function (a, b) { return areaGroups[b].count - areaGroups[a].count; });
    var areaColorMap = {};
    areaList.forEach(function (name, i) { areaColorMap[name] = palette[i % palette.length]; });
    return { areaGroups: areaGroups, areaList: areaList, areaColorMap: areaColorMap };
  }

  // ---------- progressive renderer ----------

  /**
   * o.L, o.container, o.model (joinRouteRows result), o.areaOf, o.areaColorMap, o.normalize,
   * o.lookupCoord(addr) sync → {lat,lng}|null, o.ensureMaster() → Promise, o.lookupMaster(addr) sync,
   * o.resolveCoord(addr) → Promise (only through o.queue), o.queue, o.isCurrent(), o.perf,
   * o.onProgress(done,total), o.areaLabels [{lat,lng,html}], o.onMarker(marker)
   */
  function renderRouteMap(o) {
    var L = o.L;
    var perf = o.perf || createMapPerf('');
    var normalize = typeof o.normalize === 'function' ? o.normalize : defaultNormalize;
    var isCurrent = typeof o.isCurrent === 'function' ? o.isCurrent : function () { return true; };
    var colorOf = function (addr) {
      var area = (typeof o.areaOf === 'function' ? o.areaOf(addr) : '') || '不明';
      return (o.areaColorMap && o.areaColorMap[area]) || '#6b7280';
    };
    var map = L.map(o.container).setView([33.58, 130.34], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 18
    }).addTo(map);
    perf.mark('leafletReadyAt');

    var latlngs = [];
    var markers = [];

    function add(marker) {
      marker.addTo(map);
      markers.push(marker);
      if (typeof o.onMarker === 'function') o.onMarker(marker);
    }

    function drawStop(g, lat, lng) {
      var spec = stopIconSpec(colorOf(g.address), g.stopNumber, g.isPriority13);
      var m = L.marker([lat, lng], { icon: L.divIcon(spec), zIndexOffset: g.isPriority13 ? 600 : 200 });
      m.bindPopup(stopPopupHtml(g));
      add(m);
      perf.counters.stopMarkers += 1;
      latlngs.push([lat, lng]);
      perf.mark('firstMarkerAt');
    }

    function drawUnmatched(u, lat, lng) {
      var m = L.marker([lat, lng], { icon: L.divIcon(dotIconSpec(colorOf(u.address))) });
      m.bindPopup(unmatchedPopupHtml(u));
      add(m);
      perf.counters.unmatchedMarkers += 1;
      latlngs.push([lat, lng]);
      perf.mark('firstMarkerAt');
    }

    var plotted = [];
    function draw(item, lat, lng) {
      plotted.push(item);
      if (item.kind === 'stop') drawStop(item, lat, lng);
      else drawUnmatched(item, lat, lng);
    }

    var model = o.model || { stops: [], unmatched: [], diagnostics: [] };
    var pending = [];
    model.stops.forEach(function (g) {
      if (hasFiniteCoord(g.latitude, g.longitude)) {
        perf.counters.cortexCoords += 1;
        draw(g, Number(g.latitude), Number(g.longitude));
        return;
      }
      var c = o.lookupCoord ? o.lookupCoord(g.address) : null;
      if (c) { perf.counters.cacheHits += 1; draw(g, c.lat, c.lng); } else pending.push(g);
    });
    model.unmatched.forEach(function (u) {
      var c = o.lookupCoord ? o.lookupCoord(u.address) : null;
      if (c) { perf.counters.cacheHits += 1; draw(u, c.lat, c.lng); } else pending.push(u);
    });

    (o.areaLabels || []).forEach(function (lab) {
      var m = L.marker([lab.lat, lab.lng], { icon: L.divIcon({ className: 'area-label', html: lab.html, iconSize: [0, 0], iconAnchor: [0, 0] }) });
      add(m);
    });

    perf.mark('cachedMarkersAt');
    if (latlngs.length) map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 15 });
    perf.counters.pending = pending.length;

    var total = pending.length;
    var done = 0;
    function progress() {
      if (typeof o.onProgress === 'function') o.onProgress(done, total);
    }

    var finished;
    if (!total) {
      perf.mark('coordinatesReadyAt');
      perf.mark('allMarkersReadyAt');
      finished = Promise.resolve();
    } else {
      progress();
      finished = Promise.resolve(typeof o.ensureMaster === 'function' ? o.ensureMaster() : null)
        .catch(function () { return null; })
        .then(function () {
          if (!isCurrent()) return;
          var rest = [];
          pending.forEach(function (item) {
            var c = o.lookupMaster ? o.lookupMaster(item.address) : null;
            if (c) {
              perf.counters.masterHits += 1;
              draw(item, c.lat, c.lng);
              done += 1;
            } else rest.push(item);
          });
          progress();
          return Promise.all(rest.map(function (item) {
            var key = normalize(item.address) || item.address;
            perf.counters.geocodeRequests += 1;
            return o.queue.request(key, item.address).then(function (c) {
              if (!isCurrent()) return;
              if (c && hasFiniteCoord(c.lat, c.lng)) draw(item, Number(c.lat), Number(c.lng));
              done += 1;
              progress();
            });
          }));
        })
        .then(function () {
          if (!isCurrent()) return;
          perf.mark('coordinatesReadyAt');
          if (latlngs.length) map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 15 });
          perf.mark('allMarkersReadyAt');
        });
    }

    var result = {
      map: map,
      markers: markers,
      diagnostics: model.diagnostics.slice(),
      done: finished.then(function () {
        model.stops.forEach(function (g) {
          if (plotted.indexOf(g) < 0) {
            result.diagnostics.push({ routeCode: model.routeCode, trackingId: g.trackingIds.join(' '), address: g.address, candidateStops: [g.stopNumber], reason: 'COORDINATE_MISSING' });
          }
        });
        return result;
      })
    };
    return result;
  }

  var api = {
    buildMapCortexIndex: buildMapCortexIndex,
    getMapCortexIndex: getMapCortexIndex,
    indexBuildCount: indexBuildCount,
    resetIndexMemo: resetIndexMemo,
    routeCortexState: routeCortexState,
    cortexStateNote: cortexStateNote,
    joinRouteRows: joinRouteRows,
    getRouteModel: getRouteModel,
    rowsSignature: rowsSignature,
    stopIconSpec: stopIconSpec,
    dotIconSpec: dotIconSpec,
    stopPopupHtml: stopPopupHtml,
    unmatchedPopupHtml: unmatchedPopupHtml,
    createCoordCache: createCoordCache,
    createGeocodeQueue: createGeocodeQueue,
    createMapPerf: createMapPerf,
    recordPerf: recordPerf,
    computeAreaGroups: computeAreaGroups,
    renderRouteMap: renderRouteMap,
    hasFiniteCoord: hasFiniteCoord,
    PERF_MARKS: PERF_MARKS,
    REASON_LABEL: REASON_LABEL
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OFK3MapCortexOverlay = api;
})(typeof window !== 'undefined' ? window : globalThis);
