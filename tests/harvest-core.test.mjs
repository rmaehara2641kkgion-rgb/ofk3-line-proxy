import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const Core = require(join(root, 'harvest-core.js'));
const Cols = require(join(root, 'harvest-collectors-cortex.js'));

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error('FAIL: ' + msg + ' expected ' + sb + ' got ' + sa);
}

// fetch を使わないこと (独自フェッチ禁止) を検出
let fetchCalls = 0;
globalThis.fetch = function () { fetchCalls += 1; throw new Error('HARVEST must not call fetch'); };

const TODAY = '2026-10-02';

function pkg(route, tid, extra) {
  return Object.assign({
    routeCode: route, routeId: route + '-id', stop: 1, driverName: 'SECRET-DRIVER',
    trackingId: tid, plannedEndTime: 46800000, plannedEndClock: '13:00',
    windowLabel: '09:00-13:00', address: 'SECRET-ADDRESS-1-2-3', latitude: 35, longitude: 139
  }, extra || {});
}
function assistRow(route, tid, extra) {
  return Object.assign({
    routeCode: route, trackingId: tid, referenceId: 'ref-' + tid, driverAid: null,
    bagName: 'B-1', bagScannableId: null, bagColorCode: null, bagColor: null, bagNumber: null,
    bagDisplay: 'B-1', bagStatus: 'captured', bagSource: 'trDetails'
  }, extra || {});
}

function makeFakeApi(opts) {
  opts = opts || {};
  const state = {
    entry: opts.entry === undefined ? { localDate: TODAY, packages: opts.packages || [] } : opts.entry,
    packages: opts.packages || [],
    assist: opts.assist || [],
    seq: opts.seq || [],
    loadCalls: 0
  };
  const api = {
    _state: state,
    load: function () {
      state.loadCalls += 1;
      if (opts.loadThrows) return Promise.reject(new Error('boom'));
      return new Promise(function (resolve) { setTimeout(resolve, opts.loadDelay || 0); });
    },
    getEntry: function () { return state.entry; },
    getPackages: function () { return state.packages; },
    getPackageAssistIndex: function () { return state.assist; },
    getPackageAssistDiagnostics: function () { return { indexCount: state.assist.length, note: 'x' }; },
    getPackageSequenceIndex: function () { return state.seq; },
    getPackageSequenceDiagnostics: function () { return { indexCount: state.seq.length }; },
    getRouteStops: function () { return []; },
    getStops: function () { return []; }
  };
  return api;
}

function makeHub(api, extra) {
  const events = [];
  const hub = Core.createHub({
    now: function () { return '2026-10-02T00:00:00.000Z'; },
    dispatch: function (name, detail) { events.push({ name, detail }); return true; }
  });
  Cols.registerCortexCollectors(hub, { getApi: function () { return api; }, todayIso: function () { return TODAY; } });
  return { hub, events };
}

async function runOne(api, id) {
  const { hub } = makeHub(api);
  await hub.runCollector(id);
  return hub.getState(id);
}

// ===== Static =====
{
  assert(Core.SCHEMA_VERSION === '0.1', 'schemaVersion 0.1');
  eq(Object.keys(Core.STATUS).map(function (k) { return Core.STATUS[k]; }).sort(),
    ['awaiting-data', 'checking', 'error', 'idle', 'ok', 'partial', 'stale'], 'status enum');
  eq(Object.keys(Core.OVERALL).sort(), ['COMPLETE', 'FAILED', 'PARTIAL'], 'overall enum');
  assert(Core.STATUS_LABEL['awaiting-data'] === 'データなし（未送信または取得失敗）', 'label awaiting');
  assert(Core.STATUS_LABEL.checking === '検証中', 'label checking');
  assert(Core.STATUS_LABEL.ok === '正常' && Core.STATUS_LABEL.partial === '一部異常' && Core.STATUS_LABEL.error === '異常', 'labels');
  Object.keys(Core.STATUS_LABEL).forEach(function (k) {
    assert(Core.STATUS_LABEL[k].indexOf('取得中') < 0, 'no "取得中" wording');
  });
  assert(Core.TRIGGER_KIND.HUMAN_FILE_UPLOAD === 'human-file-upload', 'reserved human-file-upload kind');
}

// ===== computeOverall =====
{
  assert(Core.computeOverall(['ok', 'ok']) === 'COMPLETE', 'all ok -> COMPLETE');
  assert(Core.computeOverall(['ok', 'error']) === 'PARTIAL', 'ok+error -> PARTIAL');
  assert(Core.computeOverall(['ok', 'awaiting-data']) === 'PARTIAL', 'ok+awaiting -> PARTIAL');
  assert(Core.computeOverall(['partial', 'error']) === 'PARTIAL', 'partial counts as usable');
  assert(Core.computeOverall(['error', 'awaiting-data']) === 'FAILED', 'none usable -> FAILED');
  assert(Core.computeOverall(['stale', 'stale']) === 'FAILED', 'stale only -> FAILED');
  assert(Core.computeOverall([]) === 'FAILED', 'empty -> FAILED');
}

// ===== Registry =====
{
  const hub = Core.createHub();
  let threw = false;
  try { hub.register({ id: 'x' }); } catch (e) { threw = true; }
  assert(threw, 'register rejects missing probe');
  hub.register({ id: 'a', probe: function () { return {}; }, normalize: function () { return { status: 'ok' }; } });
  threw = false;
  try { hub.register({ id: 'a', probe: function () {}, normalize: function () {} }); } catch (e) { threw = true; }
  assert(threw, 'duplicate id rejected');
  eq(hub.listIds(), ['a'], 'listIds');
  assert(hub.getState('a').status === 'idle', 'initial idle');
  const col = hub.getCollector('a');
  assert(col.trigger.kind === 'human-external', 'default trigger kind human-external');
  eq(col.dependsOn, [], 'default dependsOn');
  assert(hub.getOverall() === null, 'overall null while idle');

  const api = makeFakeApi({});
  const { hub: h2 } = makeHub(api);
  eq(h2.listIds(), ['timeWindow', 'bag'], 'two cortex collectors');
  eq(h2.getCollector('bag').dependsOn, ['timeWindow'], 'bag dependsOn timeWindow');
  assert(h2.getCollector('timeWindow').trigger.instruction.indexOf('「取得開始」→「Bag取得」→「OFK3へ送信」') >= 0, 'trigger instruction');
  assert(h2.getCollector('bag').trigger.kind === 'human-external', 'bag trigger kind');
}

// ===== Time Window Collector =====
{
  let s = await runOne(makeFakeApi({ packages: [pkg('R1', 'T1'), pkg('R2', 'T2')] }), 'timeWindow');
  assert(s.status === 'ok', 'TW ok');
  eq(s.counts, { success: 2, failure: 0, total: 2 }, 'TW ok counts');
  assert(s.details.routeCount === 2, 'TW route count');
  assert(s.checkedAt === '2026-10-02T00:00:00.000Z', 'checkedAt set');

  s = await runOne(makeFakeApi({ packages: [] }), 'timeWindow');
  assert(s.status === 'awaiting-data', 'TW empty -> awaiting-data');
  assert(s.errors.length === 1 && s.errors[0].code === 'no-packages', 'TW awaiting error kept');

  s = await runOne(makeFakeApi({ entry: null }), 'timeWindow');
  assert(s.status === 'awaiting-data', 'TW null entry -> awaiting-data');
  // real load() swallows fetch errors and leaves entry=null without throwing: wording must not assert the cause
  assert(s.errors[0].message.indexOf('取得失敗') >= 0, 'TW null entry msg mentions fetch failure');
  assert(s.errors[0].message.indexOf('Cortex拡張から未送信') < 0, 'TW null entry msg not definitive');
  assert(Core.STATUS_LABEL['awaiting-data'].indexOf('取得失敗') >= 0, 'label not definitive');

  s = await runOne(makeFakeApi({ packages: [pkg('R1', 'T1'), pkg('R1', '', {}), pkg('R2', 'T3', { plannedEndTime: null, plannedEndClock: '' })] }), 'timeWindow');
  assert(s.status === 'partial', 'TW partial');
  eq(s.counts, { success: 1, failure: 2, total: 3 }, 'TW partial counts');
  assert(s.errors.some(function (e) { return e.code === 'package-missing-key' && e.count === 1; }), 'TW key error kept');
  assert(s.errors.some(function (e) { return e.code === 'package-missing-time' && e.count === 1; }), 'TW time error kept');

  s = await runOne(makeFakeApi({ packages: [pkg('', 'T1'), pkg('R1', '')] }), 'timeWindow');
  assert(s.status === 'error', 'TW all invalid -> error');

  s = await runOne(makeFakeApi({ entry: { localDate: '2026-10-01', packages: [1] }, packages: [pkg('R1', 'T1')] }), 'timeWindow');
  assert(s.status === 'stale', 'TW stale when localDate not today');
  assert(s.errors[0].code === 'stale-date', 'TW stale error');
  assert(s.details.stale === true, 'TW stale detail');

  s = await runOne(makeFakeApi({ packages: [pkg('R1', 'T1')], loadThrows: true }), 'timeWindow');
  assert(s.status === 'error' && s.errors[0].code === 'load-exception', 'TW load exception -> error');

  const { hub } = makeHub(null);
  await hub.runCollector('timeWindow');
  s = hub.getState('timeWindow');
  assert(s.status === 'error' && s.errors[0].code === 'cortex13-api-missing', 'TW api missing -> error');
}

// ===== Bag Collector =====
{
  const pk = [pkg('R1', 'T1'), pkg('R1', 'T2'), pkg('R2', 'T3')];
  let s = await runOne(makeFakeApi({
    packages: pk,
    assist: [
      assistRow('R1', 'T1'),
      assistRow('R1', 'T2', { bagName: null, bagDisplay: null, bagStatus: 'captured_null' }),
      assistRow('R2', 'T3')
    ]
  }), 'bag');
  assert(s.status === 'ok', 'Bag ok incl. captured_null (not a failure)');
  eq(s.counts, { success: 3, failure: 0, total: 3 }, 'Bag ok counts');
  assert(s.details.bagStatusCounts.captured_null === 1 && s.details.bagStatusCounts.captured === 2, 'bagStatusCounts kept raw');
  assert(s.details.nullDistinguishable === true, 'new data distinguishable');

  s = await runOne(makeFakeApi({
    packages: pk,
    assist: [
      assistRow('R1', 'T1'),
      assistRow('R1', 'T2', { bagName: null, bagDisplay: null, bagStatus: 'timeout', bagSource: null }),
      assistRow('R2', 'T3', { bagName: null, bagDisplay: null, bagStatus: 'dom_not_found', bagSource: null })
    ]
  }), 'bag');
  assert(s.status === 'partial', 'Bag partial failure');
  eq(s.counts, { success: 1, failure: 2, total: 3 }, 'Bag partial counts');
  assert(s.details.bagStatusCounts.timeout === 1 && s.details.bagStatusCounts.dom_not_found === 1, '14-state not rounded');
  assert(s.errors.some(function (e) { return e.code === 'bag-timeout' && e.count === 1; }), 'Bag error code kept');

  s = await runOne(makeFakeApi({
    packages: pk,
    assist: pk.map(function (p) { return assistRow(p.routeCode, p.trackingId, { bagName: null, bagDisplay: null, bagStatus: 'click_failed', bagSource: null }); })
  }), 'bag');
  assert(s.status === 'error', 'Bag all failed -> error');

  s = await runOne(makeFakeApi({
    packages: pk,
    assist: pk.map(function (p) { return assistRow(p.routeCode, p.trackingId, { bagName: null, bagDisplay: null, bagStatus: 'not_attempted', bagSource: null }); })
  }), 'bag');
  assert(s.status === 'awaiting-data', 'Bag all not_attempted -> awaiting-data');

  s = await runOne(makeFakeApi({
    packages: pk,
    assist: [
      assistRow('R1', 'T1'),
      assistRow('R1', 'T2', { bagName: null, bagDisplay: null, bagStatus: 'not_attempted', bagSource: null })
    ]
  }), 'bag');
  assert(s.status === 'partial', 'Bag not_attempted + missing row with some success -> partial');
  assert(s.details.unattempted === 2 && s.details.noAssistRow === 1, 'unattempted and noAssistRow counted');

  // legacy rows (bagStatus absent): captured only judged by bagName/bagDisplay
  const legacy = function (r, t, name) {
    const row = assistRow(r, t, name ? {} : { bagName: null, bagDisplay: null });
    delete row.bagStatus; delete row.bagSource;
    return row;
  };
  s = await runOne(makeFakeApi({ packages: pk, assist: [legacy('R1', 'T1', true), legacy('R1', 'T2', false), legacy('R2', 'T3', true)] }), 'bag');
  assert(s.status === 'ok', 'legacy rows: null row is not an error');
  assert(s.details.legacyUnknown === 1 && s.details.legacyCaptured === 2, 'legacy counts');
  assert(s.details.nullDistinguishable === false, 'legacy flags not distinguishable');
  assert(s.summary.indexOf('区別不可') >= 0, 'legacy summary mentions indistinguishable');

  // legacy with nothing captured
  s = await runOne(makeFakeApi({ packages: pk, assist: [legacy('R1', 'T1', false)] }), 'bag');
  assert(s.status === 'awaiting-data', 'legacy no bag at all -> awaiting-data');

  // sanitizer field null (server returns null for legacy) is treated as legacy
  const nullStatus = assistRow('R1', 'T1', { bagStatus: null, bagSource: null });
  s = await runOne(makeFakeApi({ packages: [pkg('R1', 'T1')], assist: [nullStatus] }), 'bag');
  assert(s.status === 'ok' && s.details.legacyCaptured === 1, 'bagStatus:null row = legacy');

  s = await runOne(makeFakeApi({ packages: pk, assist: [] }), 'bag');
  assert(s.status === 'awaiting-data' && s.errors[0].code === 'no-assist-index', 'Bag no assist index -> awaiting-data');

  s = await runOne(makeFakeApi({
    entry: { localDate: '2026-10-01', packages: [1] }, packages: pk, assist: pk.map(function (p) { return assistRow(p.routeCode, p.trackingId); })
  }), 'bag');
  assert(s.status === 'stale', 'Bag stale when entry date is not today');
}

// ===== Both collectors / independence =====
{
  const pk = [pkg('R1', 'T1'), pkg('R2', 'T2')];
  const good = pk.map(function (p) { return assistRow(p.routeCode, p.trackingId); });

  // both ok
  let api = makeFakeApi({ packages: pk, assist: good });
  let { hub } = makeHub(api);
  let r = await hub.runAll();
  assert(r.overall === 'COMPLETE', 'both ok -> COMPLETE');
  assert(hub.getOverall() === 'COMPLETE', 'getOverall COMPLETE');
  assert(api._state.loadCalls === 1, 'HARVEST ALL shares one load() (got ' + api._state.loadCalls + ')');

  // TW partial, Bag ok
  api = makeFakeApi({ packages: [pkg('R1', 'T1'), pkg('R2', '')], assist: [assistRow('R1', 'T1'), assistRow('R2', 'T2')] });
  ({ hub } = makeHub(api));
  r = await hub.runAll();
  assert(r.results.timeWindow.status === 'partial', 'TW partial');
  assert(r.results.bag.status === 'ok', 'Bag unaffected by TW partial');
  assert(r.overall === 'PARTIAL', 'overall PARTIAL');

  // Bag failed, TW ok
  api = makeFakeApi({ packages: pk, assist: pk.map(function (p) { return assistRow(p.routeCode, p.trackingId, { bagName: null, bagDisplay: null, bagStatus: 'timeout', bagSource: null }); }) });
  ({ hub } = makeHub(api));
  r = await hub.runAll();
  assert(r.results.timeWindow.status === 'ok', 'TW unaffected by Bag failure');
  assert(r.results.bag.status === 'error', 'Bag error');
  assert(r.overall === 'PARTIAL', 'overall PARTIAL when only Bag fails');

  // both unavailable -> FAILED but no throw
  ({ hub } = makeHub(null));
  r = await hub.runAll();
  assert(r.overall === 'FAILED', 'everything failed -> FAILED');
  assert(r.ok === true, 'runAll resolved normally');

  // one collector throws in probe/normalize/summarize; others continue
  const hub3 = Core.createHub({ now: function () { return 'T'; }, dispatch: function () { return true; } });
  hub3.register({ id: 'boomProbe', probe: function () { throw new Error('probe-fail'); }, normalize: function () { return { status: 'ok' }; } });
  hub3.register({ id: 'boomNormalize', probe: function () { return {}; }, normalize: function () { throw new Error('norm-fail'); } });
  hub3.register({
    id: 'boomSummarize', probe: function () { return {}; },
    normalize: function () { return { status: 'ok', counts: { success: 1 } }; },
    summarize: function () { throw new Error('sum-fail'); }
  });
  hub3.register({ id: 'fine', probe: function () { return Promise.resolve({}); }, normalize: function () { return { status: 'ok', counts: { success: 5, failure: 0 } }; } });
  r = await hub3.runAll();
  assert(r.results.boomProbe.status === 'error' && r.results.boomProbe.errors[0].code === 'collector-exception', 'probe exception -> error state');
  assert(r.results.boomProbe.errors[0].message.indexOf('probe-fail') >= 0, 'exception message retained');
  assert(r.results.boomNormalize.status === 'error', 'normalize exception -> error state');
  assert(r.results.boomSummarize.status === 'ok' && r.results.boomSummarize.summary.length > 0, 'summarize exception falls back');
  assert(r.results.fine.status === 'ok' && r.results.fine.counts.success === 5, 'healthy collector unaffected');
  assert(r.overall === 'PARTIAL', 'overall PARTIAL with exceptions');

  // invalid normalize result -> error
  const hub4 = Core.createHub();
  hub4.register({ id: 'bad', probe: function () { return {}; }, normalize: function () { return { status: 'nonsense' }; } });
  await hub4.runCollector('bad');
  assert(hub4.getState('bad').status === 'error', 'unknown status coerced to error');
  hub4.register({ id: 'bad2', probe: function () { return {}; }, normalize: function () { return null; } });
  await hub4.runCollector('bad2');
  assert(hub4.getState('bad2').status === 'error', 'null result coerced to error');
}

// ===== State transitions / double click / concurrency =====
{
  const api = makeFakeApi({ packages: [pkg('R1', 'T1')], assist: [assistRow('R1', 'T1')], loadDelay: 20 });
  const { hub } = makeHub(api);
  const seen = [];
  hub.onChange(function (id) { if (id === 'timeWindow') seen.push(hub.getState('timeWindow').status); });

  assert(hub.getState('timeWindow').status === 'idle', 'idle before run');
  const p1 = hub.runCollector('timeWindow');
  assert(hub.getState('timeWindow').status === 'checking', 'checking during run');
  assert(hub.isRunning('timeWindow') === true, 'isRunning true');
  const p2 = hub.runCollector('timeWindow');
  const dup = await p2;
  assert(dup.skipped === true && dup.reason === 'already-running', 'double click ignored');

  // other collector can run while timeWindow is checking
  const pBag = hub.runCollector('bag');
  assert(hub.getState('bag').status === 'checking', 'other collector runs independently');
  await Promise.all([p1, pBag]);
  assert(hub.getState('timeWindow').status === 'ok', 'TW ok after run');
  assert(hub.getState('bag').status === 'ok', 'Bag ok after run');
  eq(seen, ['checking', 'ok'], 'TW transitions idle->checking->ok');
  assert(hub.isRunning('timeWindow') === false, 'isRunning false after run');
  assert(api._state.loadCalls === 1, 'overlapping single runs share load() (got ' + api._state.loadCalls + ')');

  // re-run after completion performs new load (fresh evaluation)
  await hub.runCollector('timeWindow');
  assert(api._state.loadCalls === 2, 'rerun after finish reloads');

  // changing underlying data then re-check updates state (re-run from error to ok)
  api._state.packages = [];
  api._state.entry = { localDate: TODAY, packages: [] };
  await hub.runCollector('timeWindow');
  assert(hub.getState('timeWindow').status === 'awaiting-data', 'rerun reflects new data');
  api._state.packages = [pkg('R1', 'T1')];
  api._state.entry = { localDate: TODAY, packages: [1] };
  await hub.runCollector('timeWindow');
  assert(hub.getState('timeWindow').status === 'ok', 'rerun recovers');

  // runAll twice concurrently -> second ignored
  const a1 = hub.runAll();
  assert(hub.isRunningAll() === true, 'isRunningAll');
  const a2 = await hub.runAll();
  assert(a2.skipped === true && a2.reason === 'already-running', 'runAll double click ignored');
  const a1r = await a1;
  assert(a1r.overall === 'COMPLETE', 'first runAll completes');
  assert(hub.isRunningAll() === false, 'runAll flag cleared');

  // runAll while a single collector running waits for it instead of double-running
  const api2 = makeFakeApi({ packages: [pkg('R1', 'T1')], assist: [assistRow('R1', 'T1')], loadDelay: 10 });
  const { hub: hubB } = makeHub(api2);
  const single = hubB.runCollector('timeWindow');
  const all = await hubB.runAll();
  await single;
  assert(all.overall === 'COMPLETE', 'runAll while single running');
  assert(api2._state.loadCalls === 1, 'no double load when runAll overlaps single run');
}

// ===== Dependency ordering =====
{
  const order = [];
  const hub = Core.createHub();
  const mk = function (id, deps) {
    return {
      id, dependsOn: deps,
      probe: function () { order.push('start:' + id); return new Promise(function (res) { setTimeout(res, id === 'c' ? 1 : 10); }); },
      normalize: function () { order.push('end:' + id); return { status: 'ok', counts: { success: 1 } }; }
    };
  };
  hub.register(mk('c', ['b']));
  hub.register(mk('b', ['a']));
  hub.register(mk('a', []));
  hub.register(mk('ghost', ['nonexistent']));
  await hub.runAll();
  assert(order.indexOf('end:a') < order.indexOf('start:b'), 'a completes before b starts');
  assert(order.indexOf('end:b') < order.indexOf('start:c'), 'b completes before c starts');
  assert(hub.getState('ghost').status === 'ok', 'unknown dependency ignored');

  // dependency failure does not block dependents
  const hubF = Core.createHub();
  hubF.register({ id: 'dep', probe: function () { throw new Error('x'); }, normalize: function () { return { status: 'ok' }; } });
  hubF.register({ id: 'child', dependsOn: ['dep'], probe: function () { return {}; }, normalize: function () { return { status: 'ok', counts: { success: 1 } }; } });
  const rr = await hubF.runAll();
  assert(rr.results.dep.status === 'error' && rr.results.child.status === 'ok', 'failed dependency does not propagate');
}

// ===== Extensibility =====
{
  const hub = Core.createHub();
  hub.register({
    id: 'twExtract', label: 'Excel Time Window (reserved)',
    trigger: { kind: Core.TRIGGER_KIND.HUMAN_FILE_UPLOAD, instruction: 'ファイルを選択' },
    probe: function () { return Promise.resolve({ rows: 3 }); },
    normalize: function (raw) { return { status: 'ok', counts: { success: raw.rows, failure: 0 } }; }
  });
  await hub.runCollector('twExtract');
  assert(hub.getState('twExtract').status === 'ok', 'third collector can be added');
  assert(hub.getCollector('twExtract').trigger.kind === 'human-file-upload', 'reserved trigger kind accepted');
  assert(hub.getState('twExtract').summary.indexOf('正常') >= 0, 'default summarize used');
}

// ===== Handoff =====
{
  const pk = [pkg('R1', 'T1'), pkg('R2', 'T2')];
  const api = makeFakeApi({ packages: pk, assist: pk.map(function (p) { return assistRow(p.routeCode, p.trackingId); }) });
  const { hub, events } = makeHub(api);

  let h = hub.handoff('timeWindow');
  assert(h.ok === false && h.reason === 'not-handoff-ready', 'handoff refused before check');
  assert(events.length === 0, 'no event before check');

  await hub.runAll();
  h = hub.handoff('timeWindow');
  assert(h.ok === true && h.dispatched === true, 'handoff ok');
  assert(events.length === 1 && events[0].name === 'harvest:handoff', 'harvest:handoff event dispatched');
  const rec = events[0].detail;
  eq(Object.keys(rec).sort(), [
    'collectedAt', 'confirmedAt', 'errors', 'failureCount', 'harvestConfirmed', 'payloadReference', 'schemaVersion', 'source', 'status', 'successCount'
  ], 'handoff record fields');
  assert(rec.source === 'timeWindow' && rec.status === 'ok', 'source/status');
  assert(rec.successCount === 2 && rec.failureCount === 0, 'handoff counts');
  assert(rec.schemaVersion === '0.1' && rec.harvestConfirmed === true, 'schemaVersion + confirmed flag');
  assert(rec.collectedAt === '2026-10-02T00:00:00.000Z', 'collectedAt from checkedAt');
  assert(Array.isArray(rec.errors), 'errors array');
  assert(rec.payloadReference.via === 'window.OFK3Cortex13' && rec.payloadReference.getters.indexOf('getPackages') >= 0, 'payloadReference via getters');
  const json = JSON.stringify(rec);
  assert(json.indexOf('SECRET-ADDRESS') < 0 && json.indexOf('SECRET-DRIVER') < 0, 'no PII in handoff');
  assert(json.indexOf('T1') < 0, 'no tracking ids in handoff');
  assert(hub.getLastHandoff('timeWindow').source === 'timeWindow', 'last handoff kept');

  const all = hub.handoffAll();
  assert(all.timeWindow.ok && all.bag.ok, 'handoffAll');
  assert(events.length === 3, 'event per handoff');

  // not-ready collector refused, partial allowed
  const { hub: hub2, events: ev2 } = makeHub(makeFakeApi({ packages: [] }));
  await hub2.runAll();
  assert(hub2.handoff('timeWindow').ok === false, 'awaiting-data not handed off');
  assert(ev2.length === 0, 'no event for not-ready');

  const { hub: hub3, events: ev3 } = makeHub(makeFakeApi({ packages: [pkg('R1', 'T1'), pkg('', 'T2')] }));
  await hub3.runCollector('timeWindow');
  const hp = hub3.handoff('timeWindow');
  assert(hp.ok && ev3[0].detail.status === 'partial' && ev3[0].detail.failureCount === 1, 'partial handed off with failure count');
  assert(ev3[0].detail.errors.length > 0, 'errors carried into handoff');

  // buildHandoff shape, direct
  const direct = Core.buildHandoff('x', { status: 'ok', counts: { success: 1, failure: 2 }, checkedAt: 'C', errors: [{ code: 'e', message: 'm' }] }, { payloadReference: { a: 1 } }, 'N');
  assert(direct.collectedAt === 'C' && direct.confirmedAt === 'N' && direct.payloadReference.a === 1, 'buildHandoff direct');
}

// ===== Coexistence: existing getters untouched, no own fetch =====
{
  const pk = [pkg('R1', 'T1')];
  const api = makeFakeApi({ packages: pk, assist: [assistRow('R1', 'T1')] });
  const before = JSON.stringify({ e: api.getEntry(), p: api.getPackages(), a: api.getPackageAssistIndex(), s: api.getPackageSequenceIndex() });
  const { hub } = makeHub(api);
  await hub.runAll();
  hub.handoffAll();
  const after = JSON.stringify({ e: api.getEntry(), p: api.getPackages(), a: api.getPackageAssistIndex(), s: api.getPackageSequenceIndex() });
  assert(before === after, 'HARVEST does not mutate OFK3Cortex13 data');
  assert(fetchCalls === 0, 'HARVEST never calls fetch directly');

  // details carry no PII
  const st = JSON.stringify(hub.getAll());
  assert(st.indexOf('SECRET-ADDRESS') < 0 && st.indexOf('SECRET-DRIVER') < 0, 'state store has no PII');
}

console.log('harvest-core tests passed');
