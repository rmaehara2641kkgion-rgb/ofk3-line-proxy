import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ')'); }

const Core = require('../harvest-core.js');
const Fleet = require('../harvest-collectors-fleet.js');
const CATS = ['block6_5', 'block4_5', 'eightB', 'bike2h', 'bike3h'];

const NOW = '2026-10-07T01:02:03.000Z';

function bucket(o) {
  return Object.assign({ block6_5: 0, block4_5: 0, eightB: 0, bike2h: 0, bike3h: 0, bikeByCycle: {}, otherServiceTypes: {} }, o || {});
}
function sideOk(byDate, extra) {
  return Object.assign({ ok: true, error: null, byDate: byDate, meta: { ofk3Rows: 7, totalRows: 20, warnings: ['w'] }, fileName: 'f.csv' }, extra || {});
}

function makeHub(state, opts) {
  opts = opts || {};
  const events = [];
  const hub = Core.createHub({ now: function () { return NOW; }, dispatch: function (n, d) { events.push({ n: n, d: d }); return true; } });
  let calls = 0;
  const api = opts.noApi ? null : {
    getState: function () {
      calls += 1;
      if (opts.throws) throw new Error('boom');
      return typeof state === 'function' ? state() : state;
    }
  };
  Fleet.registerFleetCollector(hub, { getApi: function () { return api; } });
  return { hub: hub, events: events, calls: function () { return calls; } };
}

async function run(state, opts) {
  const h = makeHub(state, opts);
  await h.hub.runCollector('fleetCapacity');
  return { h: h, st: h.hub.getState('fleetCapacity') };
}

// ===== static: scope + no judgement tokens =====
{
  const src = readFileSync(join(root, 'harvest-collectors-fleet.js'), 'utf8');
  assert(src.indexOf('`') < 0, 'no template literals');
  ['fetch(', 'setInterval(', 'MutationObserver', 'XMLHttpRequest', 'async ', 'await '].forEach(function (t) {
    assert(src.indexOf(t) < 0, 'no ' + t);
  });
  assert(!/=>/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^'\n]*'/g, '')), 'no arrow functions');
  ['shortage', 'severity', 'critical', 'warning', 'alert', 'lastCompare', 'compareGdsFleet', 'GdsFleetAuditCore', 'diff'].forEach(function (t) {
    assert(src.toLowerCase().indexOf(t.toLowerCase()) < 0, 'source does not mention ' + t);
  });
  assert(src.indexOf('getState') >= 0 && src.indexOf('OFK3GdsFleetAudit') >= 0, 'reads OFK3GdsFleetAudit.getState');
  assert(!/\.(renderAll|_renderAll|onTab)\b/.test(src), 'does not call GDS UI methods');
  const core = readFileSync(join(root, 'harvest-core.js'), 'utf8');
  assert(core.indexOf('fleetCapacity') < 0, 'harvest-core has no fleet knowledge');
}

// ===== registration / contract =====
{
  const h = makeHub({ cortex: null, input: null });
  eq(h.hub.listIds(), ['fleetCapacity'], 'registered id');
  const def = h.hub.getCollector('fleetCapacity');
  eq(def.dependsOn, [], 'no dependency');
  assert(def.trigger.kind === 'human-file-upload', 'trigger kind');
  eq(Fleet.CATEGORIES, CATS, 'five categories');
  assert(h.hub.getState('fleetCapacity').status === 'idle', 'idle before run');
}

// ===== ok: multi-day, all 5 categories, source semantics kept =====
{
  const cortex = sideOk({
    '2026-09-13': bucket({ block6_5: 3, block4_5: 2, eightB: 10, bike2h: 1, bike3h: 0 }),
    '2026-09-14': bucket({ block6_5: 4, block4_5: 5, eightB: 11, bike2h: 2, bike3h: 3 })
  }, { fileName: 'cortex.csv' });
  const input = sideOk({
    '2026-09-13': bucket({ block6_5: 3, block4_5: 1, eightB: 10, bike2h: 1, bike3h: 0 }),
    '2026-09-14': bucket({ block6_5: 9, block4_5: 5, eightB: 11, bike2h: 2, bike3h: 3 })
  }, { fileName: 'input.xlsm', meta: { ofk3Rows: 5, headerRowIndex: 3, warnings: [] } });
  const { h, st } = await run({ cortex: cortex, input: input });
  assert(st.status === 'ok', 'ok status (got ' + st.status + ')');
  eq(st.counts, { success: 10, failure: 0, total: 10 }, 'counts = date x category cells with both sides');
  eq(st.details.dateCount, 2, 'two dates');
  eq(st.details.categories, CATS, 'categories in details');
  CATS.forEach(function (k) {
    ['2026-09-13', '2026-09-14'].forEach(function (d) {
      const cell = st.details.byDate[d][k];
      assert(cell.cortexCount === cortex.byDate[d][k], d + ' ' + k + ' cortexCount');
      assert(cell.inputCount === input.byDate[d][k], d + ' ' + k + ' inputCount');
      assert(cell.cortexMissing === null && cell.inputMissing === null, d + ' ' + k + ' no missing');
    });
  });
  // zero stays zero (not null)
  assert(st.details.byDate['2026-09-13'].bike3h.cortexCount === 0, 'zero preserved as 0');
  // differing counts are carried as-is: no judgement fields at all
  const json = JSON.stringify(st);
  ['shortage', 'severity', 'critical', 'warning', 'alert', 'diff', 'expected', 'actual', 'bikeByCycle', 'otherServiceTypes'].forEach(function (t) {
    assert(json.indexOf(t) < 0, 'output has no ' + t);
  });
  assert(Object.keys(st.details.byDate['2026-09-13'].block6_5).sort().join() === 'cortexCount,cortexMissing,inputCount,inputMissing', 'cell keys');
  assert(st.summary.indexOf('不足判定は行いません') >= 0, 'summary states no judgement');
  // provenance
  const p = st.details.provenance;
  assert(p.via === 'window.OFK3GdsFleetAudit' && p.getter === 'getState', 'provenance source');
  assert(p.observedAt === NOW, 'observedAt from hub clock');
  assert(p.loadedAt === null, 'loadedAt not invented');
  eq(p.dates, ['2026-09-13', '2026-09-14'], 'provenance dates');
  assert(p.dateFrom === '2026-09-13' && p.dateTo === '2026-09-14', 'provenance range');
  assert(p.cortex.fileName === 'cortex.csv' && p.input.fileName === 'input.xlsm', 'file names');
  assert(p.cortex.ofk3Rows === 7 && p.cortex.totalRows === 20, 'cortex meta');
  assert(p.input.headerRowIndex === 3, 'input meta');
  // handoff (P0 core unchanged): reference only, provenance inside payloadReference
  const r = h.hub.handoff('fleetCapacity');
  assert(r.ok && r.dispatched, 'handoff ok');
  const rec = h.events[0].d;
  assert(h.events[0].n === 'harvest:handoff' && rec.source === 'fleetCapacity', 'harvest:handoff fired');
  assert(rec.schemaVersion === '0.1' && rec.harvestConfirmed === true, 'schema 0.1 / confirmed');
  assert(rec.status === 'ok' && rec.successCount === 10 && rec.failureCount === 0, 'handoff counts');
  assert(rec.payloadReference.via === 'window.OFK3GdsFleetAudit', 'payloadReference.via');
  eq(rec.payloadReference.getters, ['getState'], 'payloadReference.getters');
  assert(rec.payloadReference.provenance.cortex.fileName === 'cortex.csv', 'provenance in payloadReference');
  assert(JSON.stringify(rec).indexOf('byDate') < 0 && JSON.stringify(rec).indexOf('cortexMissing') < 0, 'handoff carries no data body');
  // read-only: input state untouched, getState read once
  assert(h.calls() === 1, 'getState read once');
  assert(JSON.stringify(cortex.byDate['2026-09-13']) === JSON.stringify(bucket({ block6_5: 3, block4_5: 2, eightB: 10, bike2h: 1, bike3h: 0 })), 'source state not mutated');
}

// ===== not loaded -> awaiting-data =====
for (const s of [{ cortex: null, input: null }, { cortex: undefined, input: undefined }, {}]) {
  const { h, st } = await run(s);
  assert(st.status === 'awaiting-data', 'awaiting-data when nothing loaded');
  eq(st.counts, { success: 0, failure: 0, total: 0 }, 'zero counts');
  assert(st.errors[0].code === 'no-fleet-files', 'error code');
  const r = h.hub.handoff('fleetCapacity');
  assert(r.ok === false && r.reason === 'not-handoff-ready', 'awaiting-data is not handoff-ready');
}

// ===== null / missing preserved, never 0 =====
{
  const cortex = sideOk({
    '2026-09-13': bucket({ block6_5: 3 }),
    '2026-09-14': { block6_5: null, block4_5: 'x', eightB: -1, bike2h: NaN }
  });
  delete cortex.byDate['2026-09-13'].bike3h; // missing category
  const input = sideOk({ '2026-09-13': bucket({ block6_5: 3, block4_5: 1, eightB: 10, bike2h: 1, bike3h: 0 }) });
  const { st } = await run({ cortex: cortex, input: input });
  assert(st.status === 'partial', 'partial when some cells unavailable');
  const d13 = st.details.byDate['2026-09-13'];
  assert(d13.bike3h.cortexCount === null && d13.bike3h.cortexMissing === 'missing-category', 'missing category -> null + reason');
  assert(d13.bike3h.inputCount === 0 && d13.bike3h.inputMissing === null, 'input zero kept');
  const d14 = st.details.byDate['2026-09-14'];
  assert(d14.block6_5.cortexCount === null && d14.block6_5.cortexMissing === 'invalid-value', 'null value -> null');
  assert(d14.block4_5.cortexCount === null && d14.block4_5.cortexMissing === 'invalid-value', 'string -> null');
  assert(d14.eightB.cortexCount === null && d14.eightB.cortexMissing === 'invalid-value', 'negative -> null');
  assert(d14.bike2h.cortexCount === null, 'NaN -> null');
  assert(d14.bike3h.cortexMissing === 'missing-category', 'absent key in present date -> missing-category');
  assert(d14.block6_5.inputCount === null && d14.block6_5.inputMissing === 'missing-date', 'date only in cortex -> input missing-date');
  const total = 10;
  assert(st.counts.total === total, 'total cells');
  assert(st.counts.success === 4, 'cells with both sides: ' + st.counts.success);
  assert(st.counts.failure === 6, 'failure cells: ' + st.counts.failure);
  assert(st.errors.some(function (e) { return e.code === 'fleet-cell-unavailable' && e.count === 6; }), 'unavailable cells reported');
  assert(st.details.missingReasons['cortex:missing-category'] >= 1 && st.details.missingReasons['input:missing-date'] === 5, 'reason breakdown');
  assert(Core.STATUS.STALE === 'stale' && st.status !== 'stale', 'no stale handling');
}

// ===== one side only -> partial =====
for (const which of ['cortex', 'input']) {
  const only = sideOk({ '2026-09-13': bucket({ block6_5: 3, block4_5: 2, eightB: 10, bike2h: 1, bike3h: 0 }) });
  const s = { cortex: null, input: null };
  s[which] = only;
  const { h, st } = await run(s);
  assert(st.status === 'partial', which + ' only -> partial');
  eq(st.counts, { success: 0, failure: 5, total: 5 }, which + ' only counts');
  const other = which === 'cortex' ? 'input' : 'cortex';
  assert(st.details.byDate['2026-09-13'].eightB[other + 'Count'] === null, other + ' count null (not 0)');
  assert(st.details.byDate['2026-09-13'].eightB[other + 'Missing'] === 'source-not-loaded', other + ' reason');
  assert(st.errors.some(function (e) { return e.code === other + '-not-loaded'; }), other + ' not-loaded error');
  assert(h.hub.handoff('fleetCapacity').ok === true, 'partial is handoff-ready');
}

// ===== parse failure on one side =====
{
  const only = sideOk({ '2026-09-13': bucket({ block6_5: 1 }) });
  const failed = { ok: false, error: 'ヘッダー不足', byDate: {}, meta: {}, fileName: 'bad.csv' };
  const { st } = await run({ cortex: only, input: failed });
  assert(st.status === 'partial', 'ready + failed -> partial');
  assert(st.errors.some(function (e) { return e.code === 'input-parse-failed'; }), 'parse failure reported');
  assert(st.details.byDate['2026-09-13'].block6_5.inputMissing === 'source-parse-failed', 'reason source-parse-failed');
  assert(st.details.provenance.input.fileName === 'bad.csv' && st.details.provenance.input.state === 'failed', 'failed file name kept');
  const both = await run({ cortex: failed, input: failed });
  assert(both.st.status === 'error', 'both failed -> error');
  const noneReady = await run({ cortex: failed, input: null });
  assert(noneReady.st.status === 'error', 'failed + absent -> error');
}

// ===== empty parsed result =====
{
  const { st } = await run({ cortex: sideOk({}), input: sideOk({}) });
  assert(st.status === 'awaiting-data' && st.errors.some(function (e) { return e.code === 'no-dates'; }), 'no dates -> awaiting-data');
}

// ===== malformed state / getter missing / getState throws =====
{
  for (const bad of [null, 'str', 5, []]) {
    const { st } = await run(function () { return bad; });
    assert(st.status === 'error' && st.errors[0].code === 'malformed-state', 'malformed top-level state: ' + JSON.stringify(bad));
  }
  const m1 = await run({ cortex: 5, input: null });
  assert(m1.st.status === 'error' && m1.st.errors.some(function (e) { return e.code === 'cortex-malformed'; }), 'non-object side');
  const m2 = await run({ cortex: { ok: true, byDate: 'x' }, input: null });
  assert(m2.st.status === 'error' && m2.st.errors.some(function (e) { return e.code === 'cortex-malformed'; }), 'byDate not object');
  const m3 = await run({ cortex: { byDate: {} }, input: null });
  assert(m3.st.status === 'error', 'ok flag missing');
  const m4 = await run({ cortex: sideOk({ '2026-09-13': 'oops' }), input: sideOk({ '2026-09-13': bucket({ block6_5: 1 }) }) });
  assert(m4.st.status === 'partial' && m4.st.details.byDate['2026-09-13'].block6_5.cortexMissing === 'bucket-invalid', 'bad bucket -> null + bucket-invalid');
  const m5 = await run({ cortex: sideOk({ '2026-09-13': bucket({ block6_5: 1 }) }), input: 7 });
  assert(m5.st.status === 'partial', 'ready + malformed -> partial');

  const noApi = await run(null, { noApi: true });
  assert(noApi.st.status === 'error' && noApi.st.errors[0].code === 'fleet-api-missing', 'getter absent');
  const hub2 = Core.createHub({ now: function () { return NOW; } });
  Fleet.registerFleetCollector(hub2, { getApi: function () { return { getState: 5 }; } });
  await hub2.runCollector('fleetCapacity');
  assert(hub2.getState('fleetCapacity').errors[0].code === 'fleet-api-missing', 'getState not a function');
  const thr = await run(null, { throws: true });
  assert(thr.st.status === 'error' && thr.st.errors[0].code === 'getstate-exception', 'getState throws');
  assert(thr.h.hub.handoff('fleetCapacity').ok === false, 'error is not handoff-ready');
}

// ===== independence: fleet failure does not affect other collectors =====
{
  const hub = Core.createHub({ now: function () { return NOW; } });
  hub.register({ id: 'other', probe: function () { return Promise.resolve({}); }, normalize: function () { return { status: 'ok', counts: { success: 1, failure: 0, total: 1 }, errors: [], details: {} }; } });
  Fleet.registerFleetCollector(hub, { getApi: function () { return null; } });
  const res = await hub.runAll();
  assert(hub.getState('other').status === 'ok' && hub.getState('fleetCapacity').status === 'error', 'independent evaluation');
  assert(res.overall === 'PARTIAL', 'overall computed by unchanged P0 core');
}

// ===== default env uses window.OFK3GdsFleetAudit =====
{
  globalThis.window = { OFK3GdsFleetAudit: { getState: function () { return { cortex: null, input: null }; } } };
  const hub = Core.createHub({ now: function () { return NOW; } });
  Fleet.registerFleetCollector(hub);
  await hub.runCollector('fleetCapacity');
  assert(hub.getState('fleetCapacity').status === 'awaiting-data', 'default getApi reads window.OFK3GdsFleetAudit');
  delete globalThis.window;
}

console.log('harvest-collectors-fleet tests passed');
