import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const Overlay = require('../ofk3-map-cortex-overlay.js');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const overlaySrc = readFileSync(join(root, 'ofk3-map-cortex-overlay.js'), 'utf8');
const uiSrc = readFileSync(join(root, 'ofk3-cortex-priority-ui.js'), 'utf8');

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; return; }
  failed += 1;
  console.error('FAIL:', msg);
}

// ---------- synthetic DCX39-shaped data (79 delivery stops 2..80, 96 packages) ----------
const ROUTE = 'DCX39';
const PRIORITY_STOPS = [5, 8, 12, 13, 16, 18, 19, 23, 25];
// 17 two-package stops + 62 single → 96 packages. Among priority stops only 5 and 16 hold 2 packages (mixed).
const DOUBLE_STOPS = [2, 3, 4, 5, 6, 7, 9, 10, 11, 14, 15, 16, 17, 20, 21, 22, 24];
function tidOf(i) { return 'DA' + String(1000000000 + i); }
function addrOf(seq) { return '福岡市城南区七隈 ' + seq + '-1-1'; }

function buildDataset(opts) {
  opts = opts || {};
  const routeStops = [{ routeCode: ROUTE, sequenceNumber: 1, address: 'OFK3 station', latitude: 33.56, longitude: 130.32, plannedEndClock: '11:12:00' }];
  const seqIndex = [];
  const priority = [];
  const assist = [];
  const cycleRows = [];
  let n = 0;
  for (let seq = 2; seq <= 80; seq++) {
    const count = DOUBLE_STOPS.indexOf(seq) >= 0 ? 2 : 1;
    const withCoords = !opts.noCortexCoords && seq % 2 === 0;
    routeStops.push({
      routeCode: ROUTE,
      sequenceNumber: seq,
      address: addrOf(seq),
      latitude: withCoords ? 33.55 + seq / 10000 : null,
      longitude: withCoords ? 130.35 + seq / 10000 : null,
      plannedEndClock: '11:' + String(20 + (seq % 40)).padStart(2, '0') + ':00',
      packageCount: count
    });
    for (let k = 0; k < count; k++) {
      n += 1;
      const tid = tidOf(n);
      seqIndex.push({ routeCode: ROUTE, trackingId: tid, sequenceNumber: seq });
      cycleRows.push({ trackingId: tid, address: addrOf(seq) });
      if (PRIORITY_STOPS.indexOf(seq) >= 0 && k === 0) {
        priority.push({ routeCode: ROUTE, stop: seq, trackingId: tid, windowLabel: '05:00-13:00', plannedEndClock: '12:' + String(seq).padStart(2, '0') + ':00', address: addrOf(seq) });
      }
      assist.push({
        routeCode: ROUTE,
        trackingId: tid,
        driverAid: opts.noAid ? null : (seq === 12 ? null : String(400 + n)),
        bagDisplay: opts.noBag ? null : (seq === 5 ? '黄色 1956' : null),
        bagStatus: seq === 5 ? 'CAPTURED' : 'NOT_ATTEMPTED'
      });
    }
  }
  return { routeStops, seqIndex, priority, assist, cycleRows, packageCount: n };
}

function fakeCortex(ds, localDate) {
  const entry = { localDate: localDate || '2026-09-27', packages: ds.priority };
  return {
    getEntry: () => entry,
    getRouteStops: () => ds.routeStops,
    getPackageSequenceIndex: () => ds.seqIndex,
    getPackageAssistIndex: () => ds.assist
  };
}

function fakeLeaflet() {
  const stats = { maps: 0, removed: 0, markers: 0, tiles: 0, live: new Set() };
  function marker(ll, opt) {
    const m = {
      ll, opt, popup: '',
      bindPopup(h) { this.popup = h; return this; },
      addTo(map) { map._markers.push(this); stats.markers += 1; return this; }
    };
    return m;
  }
  const L = {
    map(container) {
      stats.maps += 1;
      const map = {
        id: stats.maps, container, _markers: [], _removed: false,
        setView() { return this; },
        fitBounds() { return this; },
        invalidateSize() {},
        remove() { this._removed = true; this._markers = []; stats.removed += 1; stats.live.delete(this.id); }
      };
      stats.live.add(map.id);
      return map;
    },
    tileLayer() { return { addTo() { stats.tiles += 1; return this; } }; },
    marker,
    divIcon(spec) { return spec; }
  };
  return { L, stats };
}

function areaOf(addr) { const m = String(addr).match(/区(\S+?)\s/); return m ? m[1] : ''; }
const palette = ['#ef4444', '#f59e0b', '#3b82f6'];

async function render(ds, routeIndex, extra) {
  extra = extra || {};
  const { L, stats } = extra.leaflet || fakeLeaflet();
  const model = Overlay.joinRouteRows(ROUTE, extra.rows || ds.cycleRows, routeIndex);
  const areas = Overlay.computeAreaGroups((extra.rows || ds.cycleRows).map((r) => r.address), areaOf, palette);
  const perf = Overlay.createMapPerf(ROUTE);
  perf.mark('mapClickAt'); perf.mark('modalCreatedAt'); perf.mark('routeDataReadyAt');
  const r = Overlay.renderRouteMap({
    L, container: 'delivery-map', model, areaOf, areaColorMap: areas.areaColorMap,
    lookupCoord: extra.lookupCoord || (() => null),
    lookupMaster: extra.lookupMaster || (() => null),
    ensureMaster: extra.ensureMaster,
    queue: extra.queue || Overlay.createGeocodeQueue(async () => null),
    isCurrent: extra.isCurrent || (() => true),
    perf,
    onProgress: extra.onProgress
  });
  await r.done;
  return { r, model, perf, stats };
}

(async function main() {
  const today = '2026-09-27';

  // A. No Cortex data → legacy dots + "Cortex巡回順 未取得"
  {
    Overlay.resetIndexMemo();
    const ds = buildDataset();
    const idx = Overlay.getMapCortexIndex(null);
    const st = Overlay.routeCortexState(idx, ROUTE, today);
    assert(idx === null && st.state === 'none', 'A: no Cortex → state none');
    assert(Overlay.cortexStateNote('none') === 'Cortex巡回順 未取得', 'A: note text');
    const { model, r } = await render(ds, null, { lookupCoord: () => ({ lat: 33.5, lng: 130.3 }) });
    assert(model.stops.length === 0 && model.unmatched.length === 79, 'A: all rows as legacy dots (grouped by address), got ' + model.unmatched.length);
    assert(model.diagnostics.length === 0, 'A: NO_CORTEX_ROUTE is a state, not a per-row diagnostic');
    assert(r.markers.every((m) => m.opt.icon.className === 'dpin'), 'A: legacy dot icon');
    const stale = Overlay.routeCortexState(Overlay.buildMapCortexIndex({ localDate: '2026-09-26', routeStops: ds.routeStops }), ROUTE, today);
    assert(stale.state === 'stale', 'A: yesterday data is not overlaid');
  }

  // B/C. Stop numbers + 13:00 highlight only on priority stops
  const ds = buildDataset();
  Overlay.resetIndexMemo();
  const c13 = fakeCortex(ds, today);
  const index = Overlay.getMapCortexIndex(c13);
  const ctx = Overlay.routeCortexState(index, ROUTE, today);
  assert(ctx.state === 'ok', 'B: route ok');
  assert(ctx.route.priorityStopCount === 9 && ctx.route.priorityPackageCount === 9, 'B: header 9 Stops / 9 Packages, got ' + ctx.route.priorityStopCount + '/' + ctx.route.priorityPackageCount);
  assert(ctx.route.priorityStopNumbers.join(',') === PRIORITY_STOPS.join(','), 'B: priority stop list');
  {
    const { model, r } = await render(ds, ctx.route, { lookupCoord: () => ({ lat: 33.5, lng: 130.3 }) });
    assert(model.stops.length === 79 && model.unmatched.length === 0, 'B: 79 numbered stops, 0 unmatched');
    assert(model.stops[0].stopNumber === 2 && model.stops[78].stopNumber === 80, 'B: numbers follow Cortex sequence');
    const stopMarkers = r.markers.filter((m) => /ofk3-dash-stop/.test(m.opt.icon.className));
    assert(stopMarkers.length === 79, 'B: 79 numbered markers drawn');
    const p13 = stopMarkers.filter((m) => /ofk3-dash-stop-p13/.test(m.opt.icon.className));
    assert(p13.length === 9, 'C: only 9 priority markers highlighted, got ' + p13.length);
    assert(p13.every((m) => m.opt.icon.html.indexOf('#dc2626') >= 0 && m.opt.icon.html.indexOf('⏰') >= 0), 'C: red outline + clock mark');
    assert(stopMarkers.filter((m) => !/p13/.test(m.opt.icon.className)).every((m) => m.opt.icon.html.indexOf('⏰') < 0), 'C: non-priority has no clock');
    const icon = Overlay.stopIconSpec('#3b82f6', 12, true);
    assert(icon.html.indexOf('background:#3b82f6') >= 0, 'C: area color kept on priority marker');
  }

  // D/E. Multi-package stop → one marker; mixed stop keeps packages separated
  {
    const model = Overlay.joinRouteRows(ROUTE, ds.cycleRows, ctx.route);
    const s3 = model.stops.find((g) => g.stopNumber === 3);
    assert(s3 && s3.trackingIds.length === 2, 'D: stop 3 has 2 DA in one group');
    const html3 = Overlay.stopPopupHtml(s3);
    assert(html3.indexOf(s3.trackingIds[0]) >= 0 && html3.indexOf(s3.trackingIds[1]) >= 0, 'D: popup lists both DA');
    assert(html3.indexOf('13:00対象外') >= 0, 'D: non-priority label');
    const s5 = model.stops.find((g) => g.stopNumber === 5);
    const html5 = Overlay.stopPopupHtml(s5);
    assert(s5.isPriority13, 'E: mixed stop is highlighted');
    assert(html5.indexOf('⏰ 13:00対象 1件') >= 0, 'E: priority count is package-level (1 of 2)');
    assert(html5.indexOf('13:00対象 DA') >= 0 && html5.indexOf('その他 DA') >= 0, 'E: priority and other packages listed separately');
    assert(html5.indexOf('予定到着') >= 0 && html5.indexOf('住所') >= 0 && html5.indexOf('Stop 5') >= 0, 'E: popup fields');

    // F/G. Bag present / absent
    assert(html5.indexOf('Bag 黄色 1956') >= 0, 'F: bag shown when captured');
    assert(html3.indexOf('Bag -') >= 0, 'G: bag "-" when not captured');

    // H. Driver Aid null
    const s12 = model.stops.find((g) => g.stopNumber === 12);
    const html12 = Overlay.stopPopupHtml(s12);
    assert(html12.indexOf('Aid ') < 0, 'H: Aid column omitted when every package is null');
    assert(html3.indexOf('Aid 40') >= 0, 'H: Aid shown when present');
    const noAid = buildDataset({ noAid: true, noBag: true });
    const idxNoAid = Overlay.buildMapCortexIndex({ localDate: today, routeStops: noAid.routeStops, packageSequenceIndex: noAid.seqIndex, priorityPackages: noAid.priority, assistIndex: noAid.assist });
    const htmlNoAid = Overlay.stopPopupHtml(Overlay.joinRouteRows(ROUTE, noAid.cycleRows, idxNoAid.byRoute[ROUTE]).stops[0]);
    assert(htmlNoAid.indexOf('Aid') < 0 && htmlNoAid.indexOf('Bag -') >= 0, 'H: all-null assist renders without errors');
  }

  // I. Ambiguous → no forced number
  {
    const rows = ds.cycleRows.slice(0, 4).concat([
      { trackingId: 'DA_UNKNOWN', address: addrOf(2) },
      { trackingId: '', address: '福岡市城南区七隈 999-9' },
      { trackingId: 'DA_DUP', address: addrOf(7) }
    ]);
    const routeIdx = JSON.parse(JSON.stringify(ctx.route));
    routeIdx.tidToSeqs.DA_DUP = [7, 9];
    const model = Overlay.joinRouteRows(ROUTE, rows, routeIdx);
    const reasons = model.diagnostics.map((d) => d.reason).sort();
    assert(reasons.join(',') === 'MULTIPLE_MATCH,NO_MATCH,NO_MATCH', 'I: diagnostics reasons, got ' + reasons.join(','));
    const dup = model.diagnostics.find((d) => d.reason === 'MULTIPLE_MATCH');
    assert(dup.candidateStops.join(',') === '7,9' && dup.routeCode === ROUTE, 'I: candidate stops reported');
    assert(model.stops.every((g) => g.trackingIds.indexOf('DA_DUP') < 0 && g.trackingIds.indexOf('DA_UNKNOWN') < 0), 'I: ambiguous rows get no Stop number');
    assert(Overlay.unmatchedPopupHtml(model.unmatched[0]).indexOf('Stop番号未照合') >= 0, 'I: unmatched popup label');
    const sameAddrOtherStop = model.unmatched.find((u) => u.trackingIds.indexOf('DA_UNKNOWN') >= 0);
    assert(sameAddrOtherStop, 'I: address equal to a Cortex stop does not join by address alone');
    const mism = Overlay.joinRouteRows(ROUTE, [
      { trackingId: tidOf(1), address: addrOf(2) },
      { trackingId: tidOf(2), address: '別住所 1-1' }
    ], ctx.route);
    assert(mism.diagnostics.some((d) => d.reason === 'ADDRESS_MISMATCH' && d.severity === 'warning'), 'I: ADDRESS_MISMATCH warning');
    const missing = Overlay.buildMapCortexIndex({ localDate: today, routeStops: buildDataset({ noCortexCoords: true }).routeStops, packageSequenceIndex: ds.seqIndex, priorityPackages: ds.priority });
    const res = await render(ds, missing.byRoute[ROUTE], { rows: ds.cycleRows.slice(0, 2) });
    assert(res.r.diagnostics.some((d) => d.reason === 'COORDINATE_MISSING'), 'I: COORDINATE_MISSING reported');
  }

  // J. Full cache hit → 0 geocode requests
  {
    let calls = 0;
    const queue = Overlay.createGeocodeQueue(async () => { calls += 1; return { lat: 1, lng: 1 }; });
    const { perf, r } = await render(ds, ctx.route, { queue, lookupCoord: () => ({ lat: 33.5, lng: 130.3 }) });
    assert(calls === 0 && queue.stats.requests === 0, 'J: 0 geocode requests on full cache hit');
    const s = perf.summary();
    assert(s.counters.pending === 0 && r.markers.length === 79, 'J: all markers from cache');
    ['modal', 'routeData', 'leafletInit', 'cachedMarkers', 'geocode', 'markerRender', 'total'].forEach((k) => {
      assert(typeof s[k] === 'number', 'J: perf ' + k + ' is measured');
    });
  }

  // K. Partial cache → progressive, bounded concurrency, dedupe
  {
    const noCoords = buildDataset({ noCortexCoords: true });
    const idx = Overlay.buildMapCortexIndex({ localDate: today, routeStops: noCoords.routeStops, packageSequenceIndex: noCoords.seqIndex, priorityPackages: noCoords.priority });
    let active = 0; let maxActive = 0; let calls = 0;
    const queue = Overlay.createGeocodeQueue(async () => {
      calls += 1; active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((res) => setTimeout(res, 2));
      active -= 1;
      return { lat: 33.6, lng: 130.4 };
    }, { concurrency: 3 });
    const progress = [];
    let firstDrawnBeforeGeocode = 0;
    const leaflet = fakeLeaflet();
    const out = render(noCoords, idx.byRoute[ROUTE], {
      leaflet, queue,
      lookupCoord: (a) => (/ (2|3|4|5|6)-1-1$/.test(a) ? { lat: 33.5, lng: 130.3 } : null),
      ensureMaster: () => Promise.resolve(),
      onProgress: (d, t) => progress.push(d + '/' + t)
    });
    firstDrawnBeforeGeocode = leaflet.stats.markers;
    const { r } = await out;
    assert(firstDrawnBeforeGeocode === 5, 'K: cached markers drawn before any geocode completes, got ' + firstDrawnBeforeGeocode);
    assert(progress[0] === '0/74' && progress[progress.length - 1] === '74/74', 'K: progress 0/74 → 74/74, got ' + progress[0] + ' .. ' + progress[progress.length - 1]);
    assert(maxActive <= 3 && calls === 74, 'K: concurrency ≤3 and one request per address, max ' + maxActive + ' calls ' + calls);
    assert(r.markers.length === 79, 'K: all markers after geocode');
    const q2 = Overlay.createGeocodeQueue(async () => ({ lat: 1, lng: 1 }));
    const a = q2.request('k', 'x'); const b = q2.request('k', 'x');
    assert(a === b && q2.stats.deduped === 1, 'K: same address in flight is deduped');
  }

  // L. Second open uses route model cache + coordinate cache
  {
    const storage = fakeStorage();
    const store = Overlay.createCoordCache(storage, { flushDelay: 0 });
    let builds = 0;
    const key = [ROUTE, today, index.version, 'ok', Overlay.rowsSignature(ds.cycleRows)].join('|');
    const first = Overlay.getRouteModel(key, () => { builds += 1; return Overlay.joinRouteRows(ROUTE, ds.cycleRows, ctx.route); });
    const second = Overlay.getRouteModel(key, () => { builds += 1; return Overlay.joinRouteRows(ROUTE, ds.cycleRows, ctx.route); });
    assert(builds === 1 && !first.cached && second.cached && first.model === second.model, 'L: route MAP cache hit on second open');
    store.set('addr-x', 33.1, 130.1);
    store.flush();
    const reopened = Overlay.createCoordCache(storage, {});
    assert(reopened.get('addr-x') && reopened.get('addr-x').lat === 33.1, 'L: coordinate cache persists across sessions');
    const old = Overlay.createCoordCache(fakeStorage(), { now: () => 0, flushDelay: 0 });
    old.set('old', 33, 130);
    assert(old.get('old') !== null, 'L: stale entry is still used (no daily re-geocode)');
    const cap = Overlay.createCoordCache(fakeStorage(), { max: 3, flushDelay: 0, now: (() => { let t = 0; return () => ++t; })() });
    ['a', 'b', 'c', 'd', 'e'].forEach((k, i) => cap.set(k, 33 + i / 10, 130));
    cap.flush();
    assert(cap.size() === 3 && cap.get('a') === null && cap.get('e') !== null, 'L: cache is capped, oldest pruned');
  }

  // M. 10x open/close → no leaked map instances, pending geocode cancelled
  {
    const leaflet = fakeLeaflet();
    let current = null;
    let token = 0;
    const queue = Overlay.createGeocodeQueue(() => new Promise((res) => setTimeout(() => res({ lat: 1, lng: 1 }), 5)), { concurrency: 2 });
    for (let i = 0; i < 10; i++) {
      if (current) current.remove();
      const my = ++token;
      const model = Overlay.joinRouteRows(ROUTE, ds.cycleRows, ctx.route);
      const r = Overlay.renderRouteMap({ L: leaflet.L, container: 'delivery-map', model, areaColorMap: {}, lookupCoord: () => null, queue, isCurrent: () => my === token, perf: Overlay.createMapPerf(ROUTE) });
      current = r.map;
      await Promise.resolve();
      await Promise.resolve();
      token += 1; // close
      queue.cancelPending();
      current.remove();
      current = null;
    }
    await new Promise((res) => setTimeout(res, 30));
    assert(leaflet.stats.maps === 10 && leaflet.stats.removed === 10 && leaflet.stats.live.size === 0, 'M: every map instance removed, live ' + leaflet.stats.live.size);
    assert(queue.pendingCount() === 0 && queue.activeCount() === 0, 'M: no queued geocode left after close');
    assert(queue.stats.requests <= 10 * 2, 'M: closed MAPs do not keep issuing geocode requests, got ' + queue.stats.requests);
  }

  // N. 160 priority packages are not re-parsed per click
  {
    Overlay.resetIndexMemo();
    const big = buildDataset();
    for (let i = 0; i < 151; i++) big.priority.push({ routeCode: 'DCX' + (i % 20), stop: 2 + (i % 50), trackingId: 'P' + i, plannedEndClock: '12:00:00' });
    const bigC13 = fakeCortex(big, today);
    Overlay.getMapCortexIndex(bigC13);
    for (let i = 0; i < 10; i++) Overlay.getMapCortexIndex(bigC13);
    assert(Overlay.indexBuildCount() === 1, 'N: index built once for 10 opens, got ' + Overlay.indexBuildCount());
    const total = Object.values(Overlay.getMapCortexIndex(bigC13).byRoute).reduce((s, r) => s + r.priorityPackageCount, 0);
    assert(total === 160, 'N: 160 priority packages indexed, got ' + total);
    const reloaded = fakeCortex(big, today);
    Overlay.getMapCortexIndex(reloaded);
    assert(Overlay.indexBuildCount() === 2, 'N: rebuilt only when Cortex data reloads');
  }

  // O. LINE送信 regression + wiring (source level)
  {
    const lineFn = html.slice(html.indexOf('async function sendMapToLine()'), html.indexOf('function assignmentForRoute('));
    assert(lineFn.indexOf("var addresses = cycleData[currentMapRouteCode] || [];") >= 0, 'O: LINE text still built from cycle area groups');
    assert(lineFn.indexOf('sendCortexRouteMapToLine') >= 0 && lineFn.indexOf("html2canvas(mapContainer") >= 0, 'O: LINE flow unchanged');
    assert(lineFn.indexOf('OFK3MapCortexOverlay') < 0, 'O: LINE送信 does not depend on overlay');
    assert(html.indexOf('function openDeliveryMap') >= 0 && html.indexOf('initDeliveryMapLegacy') >= 0, 'O: legacy MAP kept as fallback');
    assert(html.indexOf('/ofk3-map-cortex-overlay.js?v=') >= 0, 'O: overlay script loaded');
    assert(html.indexOf("perf.mark('routeDataReadyAt')") >= 0 && html.indexOf("mapPerf.mark('modalCreatedAt')") >= 0, 'O: perf marks wired');
    assert(html.indexOf('dashboardMapGeocodeQueue.cancelPending()') >= 0, 'O: close cancels pending geocode');
    assert(html.indexOf('addrMasterLoadInFlight') >= 0, 'O: address master load is single-flight');
    assert(uiSrc.indexOf('OFK3MapCortexOverlay.getMapCortexIndex') >= 0, 'O: index prebuilt when Cortex data loads');
    const openFn = html.slice(html.indexOf('function openDeliveryMap'), html.indexOf('// ===== Googleスプレッドシート住所キャッシュ'));
    assert(openFn.indexOf('setTimeout(function() { initDeliveryMap') < 0, 'O: fixed 100ms delay removed');
    const initFn = html.slice(html.indexOf('async function initDeliveryMap('), html.indexOf('async function initDeliveryMapLegacy('));
    assert(initFn.indexOf('await loadAddrMasterFromSheet') < 0, 'O: Leaflet init no longer waits for the full address master');
    // MAP must stay read-only toward Cortex
    const overlayCode = overlaySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    [/trDetails/, /fetch\(/, /XMLHttpRequest/, /route-details/, /\.click\(/].forEach((re) => {
      assert(!re.test(overlayCode), 'O: overlay has no Cortex/network side effect ' + re);
    });
    assert(!/windowEndTime|isExact1300Clock|isOnOrBeforeCutoff/.test(overlayCode), 'O: 13:00 judgment not re-implemented');
  }

  console.log('dashboard-map-cortex-overlay: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });

function fakeStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
}
