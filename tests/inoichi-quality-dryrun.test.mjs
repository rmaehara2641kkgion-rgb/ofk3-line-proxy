import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as F from './inoichi-fixtures.mjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
function read(name) { return readFileSync(join(root, name), 'utf8'); }
const Core = require(join(root, 'inoichi-core.js'));
const Q = require(join(root, 'inoichi-quality-dryrun.js'));
const Rules = require(join(root, 'inoichi-detection-rules.js'));

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); passed += 1; }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
  passed += 1;
}

const NOW = F.NOW; // 01:00Z; capturedAt 00:30Z -> exactly 30 min
function minutesAfter(n) { return new Date(Date.parse(NOW) + n * 60000).toISOString(); }
function envFor(overrides) { return Core.dryRun(F.makeInput(overrides), ['timeWindow']).envelopes[0]; }
function stateOf(status) { return { timeWindow: F.makeHarvestState('timeWindow', { status }), bag: F.makeHarvestState('bag') }; }

// ===== Module (pure) =====
{
  const r = Q.evaluateTimeWindowQuality(envFor(), { now: NOW, freshnessThresholdMinutes: 30 });
  eq([r.dryRun, r.written, r.notified, r.error, r.ruleId], [true, false, false, null, 'time-window-data-freshness-v1'], 'dry-run flags');
  eq([r.adapterOutput.evaluable, r.adapterOutput.issueCount, r.alerts.length], [true, 0, 0], 'fresh confirmed data -> evaluable, no alert');
  eq(r.detection.diagnostics.ruleCount, 1, 'exactly one rule evaluated (fleet rule never evaluated)');
  eq(r.ruleDefinitionEnabled, false, 'definition reported disabled');
  // Shared definitions are untouched by the dry-run.
  eq(Rules.TIME_WINDOW_DATA_FRESHNESS_V1.enabled, false, 'shared rule definition still enabled:false');
  eq(Rules.getTimeWindowDataFreshnessRule().enabled, false, 'fresh copy still enabled:false');
  eq(Rules.DEFAULT_RULES.length, 0, 'DEFAULT_RULES still empty');
  eq(Rules.getSampleFleetCapacityRule().enabled, false, 'fleet rule still disabled');
}
{
  const r = Q.evaluateTimeWindowQuality(envFor(), { now: minutesAfter(1), freshnessThresholdMinutes: 30 });
  eq([r.adapterOutput.freshness.state, r.adapterOutput.evaluable, r.alerts.length, r.alerts[0].severity], ['refetch-recommended', true, 1, 'info'], '30+ min -> re-fetch recommended, info alert, still evaluable');
  eq(r.adapterOutput.issues.map(function (i) { return i.code; }), ['refetch-recommended'], 'issues[] carries the detail');
}
{
  const r = Q.evaluateTimeWindowQuality(envFor({ harvestStates: stateOf('stale') }), { now: NOW });
  eq([r.adapterOutput.evaluable, r.alerts[0].severity], [false, 'warning'], 'stale -> not evaluable, warning alert');
  assert(r.adapterOutput.notEvaluableReasons.indexOf('harvest-stale') >= 0, 'stale reason kept');
  eq(r.adapterOutput.freshness.state, 'fresh', 'quality still diagnosed when not evaluable');
}
{
  const r = Q.evaluateTimeWindowQuality(envFor({ harvestStates: stateOf('partial') }), { now: NOW });
  eq([r.adapterOutput.evaluable, r.alerts[0].severity, r.adapterOutput.harvestStatus], [true, 'info', 'partial'], 'partial -> evaluable warning, distinguished');
}
{
  const unconfirmed = envFor({ handoffRecords: { timeWindow: F.makeHandoff('timeWindow', { harvestConfirmed: false }), bag: F.makeHandoff('bag') } });
  const r = Q.evaluateTimeWindowQuality(unconfirmed, { now: NOW });
  eq([r.adapterOutput.evaluable, r.adapterOutput.notEvaluableReasons.indexOf('handoff-not-confirmed') >= 0], [false, true], 'unconfirmed handoff rejected');
  const none = envFor({ handoffRecords: { timeWindow: null, bag: null } });
  const r2 = Q.evaluateTimeWindowQuality(none, { now: NOW });
  eq(r2.adapterOutput.evaluable, false, 'no handoff -> not evaluable');
}
{
  const first = Q.evaluateTimeWindowQuality(envFor(), { now: minutesAfter(5) });
  const second = Q.evaluateTimeWindowQuality(envFor(), { now: minutesAfter(6), existingAlerts: first.alerts });
  eq([first.detection.diagnostics.created, second.detection.diagnostics.created, second.alerts.length], [1, 0, 1], 're-run does not create a duplicate alert');
  eq(second.alerts[0].alertId, first.alerts[0].alertId, 'same alertId');
  const healed = Q.evaluateTimeWindowQuality(envFor(), { now: NOW, existingAlerts: second.alerts });
  eq(healed.alerts[0].status, 'resolved', 'recovery resolves');
}
{
  const r = Q.evaluateTimeWindowQuality(null, {});
  eq([r.error, r.adapterOutput.evaluable], [null, false], 'garbage input never throws, not evaluable');
  const src = read('inoichi-quality-dryrun.js').replace(/\/\*[\s\S]*?\*\//g, '');
  ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'localStorage', 'sessionStorage', 'new Date', 'Date.now', 'window.', 'document.', 'dispatchEvent', 'setTimeout', 'setInterval', '`'].forEach(function (n) {
    assert(src.indexOf(n) < 0, 'quality module has no ' + n);
  });
}

// ===== UI (vm) =====
const UI_FILES = ['inoichi-core.js', 'inoichi-time-window-adapter.js', 'inoichi-detection-core.js', 'inoichi-detection-rules.js', 'inoichi-quality-dryrun.js', 'ofk3-inoichi-ui.js'];

function makeDom() {
  const byId = {};
  function makeEl(id) {
    const el = {
      id: id || '', style: { cssText: '', display: '' }, _html: '', children: [], _l: [],
      set innerHTML(v) { el._html = v; }, get innerHTML() { return el._html; },
      appendChild: function (c) { el.children.push(c); if (c.id) byId[c.id] = c; return c; },
      addEventListener: function (type, fn) { el._l.push({ type, fn }); },
      insertAdjacentHTML: function (pos, h) { const m = h.match(/id="([^"]+)"/); if (m) { const n = makeEl(m[1]); n._html = h; byId[m[1]] = n; } }
    };
    return el;
  }
  const document = {
    readyState: 'complete', body: makeEl('body'),
    getElementById: function (id) { return byId[id] || null; },
    createElement: function () { return makeEl(''); },
    addEventListener: function () {}
  };
  byId['ofk3-harvest-btn-wrap'] = makeEl('ofk3-harvest-btn-wrap');
  return { document, byId };
}
function click(el, attrs) {
  const target = { disabled: false, getAttribute: function (k) { return attrs[k] == null ? null : attrs[k]; } };
  el._l.forEach(function (l) { if (l.type === 'click') l.fn({ target }); });
}
function makeFakeDate(iso) {
  const fixed = Date.parse(iso);
  return class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}
function boot(opts) {
  opts = opts || {};
  const dom = makeDom();
  const listeners = {};
  const errors = [];
  const sent = [];
  const win = Object.assign({
    addEventListener: function (n, fn) { (listeners[n] = listeners[n] || []).push(fn); },
    dispatchEvent: function (ev) { sent.push(ev.type); (listeners[ev.type] || []).forEach(function (fn) { fn(ev); }); return true; }
  }, opts.win || {});
  win.window = win;
  win.self = win;
  const ctx = {
    window: win, self: win, document: dom.document,
    console: { warn: function () {}, error: function (m) { errors.push(String(m)); } },
    alert: function () { errors.push('alert'); },
    Intl, Date: makeFakeDate(opts.now || NOW), JSON, Object, Array, String, Number, isFinite, Math, Set, module: undefined
    // no fetch / XMLHttpRequest / localStorage: any use would throw and surface as an error
  };
  vm.createContext(ctx);
  (opts.files || UI_FILES).forEach(function (f) { vm.runInContext(read(f), ctx, { filename: f }); });
  return { dom, win, errors, sent };
}
function setup(o) {
  o = o || {};
  const inp = F.makeInput();
  const api = F.makeFakeApi(inp);
  const calls = { getters: 0, hubReads: 0 };
  Object.keys(api).forEach(function (k) { const f = api[k]; api[k] = function () { calls.getters += 1; return f(); }; });
  const hub = {
    getState: function (id) { calls.hubReads += 1; return F.makeHarvestState(id, { status: o.status || 'ok' }); },
    getLastHandoff: function (id) { calls.hubReads += 1; return o.noHandoff ? null : F.makeHandoff(id, o.handoff || {}); }
  };
  const b = boot({ now: o.now, files: o.files, win: { OFK3Cortex13: api, OFK3Harvest: { getHub: function () { return hub; } } } });
  b.win.OFK3Inoichi && b.win.OFK3Inoichi.open();
  b.content = b.dom.document.getElementById('ofk3-inoichi-content');
  b.calls = calls;
  b.inp = inp;
  return b;
}

// Nothing is evaluated until the button is pressed.
{
  const b = setup();
  assert(b.content.innerHTML.indexOf('品質検知 (dry-run)') >= 0, 'quality button shown');
  assert(b.content.innerHTML.indexOf('未実行') >= 0, 'shows not-run state');
  eq([b.calls.getters, b.calls.hubReads, b.win.OFK3Inoichi.getLastQuality()], [0, 0, null], 'open does not read data or evaluate');
  b.win.dispatchEvent({ type: 'harvest:handoff', detail: F.makeHandoff('timeWindow') });
  eq([b.calls.getters, b.win.OFK3Inoichi.getLastQuality()], [0, null], 'handoff event does not evaluate');
  b.win.OFK3Inoichi.render();
  eq(b.win.OFK3Inoichi.getLastQuality(), null, 're-render does not evaluate');
}

// Confirmed + fresh at the 30 min boundary.
{
  const b = setup();
  click(b.content, { 'data-ino-act': 'quality' });
  const q = b.win.OFK3Inoichi.getLastQuality();
  eq([q.adapterOutput.evaluable, q.adapterOutput.issueCount, q.alerts.length], [true, 0, 0], 'confirmed fresh data');
  assert(b.content.innerHTML.indexOf('evaluable: true') >= 0, 'evaluable shown');
  assert(b.content.innerHTML.indexOf('品質上の問題は検出されませんでした') >= 0, 'no-issue message');
  assert(b.content.innerHTML.indexOf('閾値30分') >= 0, 'threshold 30 shown');
  eq(q.adapterOutput.now, NOW, 'now passed explicitly (clock at click)');
  assert(b.calls.getters > 0 && b.calls.hubReads > 0, 'read via existing getters/hub on click');
  eq(b.win.OFK3Inoichi.getLastResult(), null, 'quality click does not run the P0 conversion display');
  eq(b.win.InoichiDetectionRules.getTimeWindowDataFreshnessRule().enabled, false, 'rule definition still disabled');
  eq(b.win.InoichiDetectionRules.DEFAULT_RULES.length, 0, 'DEFAULT_RULES empty');
  eq(q.detection.diagnostics.ruleCount, 1, 'only the time-window rule evaluated');
}

// 30+ minutes -> re-fetch recommended, issues[] shown, not lateness.
{
  const b = setup({ now: minutesAfter(1) });
  click(b.content, { 'data-ino-act': 'quality' });
  const html = b.content.innerHTML;
  assert(html.indexOf('refetch-recommended') >= 0 && html.indexOf('再取得推奨') >= 0, 'issue code and label shown');
  assert(html.indexOf('evaluable: true') >= 0, 'still evaluable');
  assert(html.indexOf('配送遅延・配送完了は判定しません') >= 0, 'states it is not lateness');
  assert(html.indexOf('&quot;ageMinutes&quot;') >= 0, 'issue detail shown (escaped JSON)');
}

// stale / partial are distinct.
{
  const s = setup({ status: 'stale' });
  click(s.content, { 'data-ino-act': 'quality' });
  assert(s.content.innerHTML.indexOf('evaluable: false') >= 0 && s.content.innerHTML.indexOf('harvest-stale') >= 0, 'stale: not evaluable with reason');
  assert(s.content.innerHTML.indexOf('評価不能の要因') >= 0, 'blocking marked as reason');
  const p = setup({ status: 'partial' });
  click(p.content, { 'data-ino-act': 'quality' });
  assert(p.content.innerHTML.indexOf('evaluable: true') >= 0 && p.content.innerHTML.indexOf('harvest-partial') >= 0, 'partial: evaluable warning');
  assert(p.content.innerHTML.indexOf('harvest-stale') < 0, 'partial not shown as stale');
}

// Unconfirmed / missing handoff is refused but diagnosed.
{
  const u = setup({ handoff: { harvestConfirmed: false } });
  click(u.content, { 'data-ino-act': 'quality' });
  assert(u.content.innerHTML.indexOf('evaluable: false') >= 0 && u.content.innerHTML.indexOf('handoff-not-confirmed') >= 0, 'unconfirmed handoff rejected with reason');
  const n = setup({ noHandoff: true });
  click(n.content, { 'data-ino-act': 'quality' });
  assert(n.content.innerHTML.indexOf('evaluable: false') >= 0 && n.content.innerHTML.indexOf('handoff-not-confirmed') >= 0, 'no handoff rejected with reason');
  eq(n.win.OFK3Inoichi.getLastQuality().adapterOutput.freshness.state, 'fresh', 'freshness still diagnosed');
}

// Repeated clicks de-duplicate (screen memory only).
{
  const b = setup({ now: minutesAfter(5) });
  click(b.content, { 'data-ino-act': 'quality' });
  const id1 = b.win.OFK3Inoichi.getLastQuality().alerts[0].alertId;
  assert(b.content.innerHTML.indexOf('新規 1') >= 0, 'first click: 1 new');
  click(b.content, { 'data-ino-act': 'quality' });
  const q2 = b.win.OFK3Inoichi.getLastQuality();
  eq([q2.alerts.length, q2.alerts[0].alertId, q2.detection.diagnostics.created], [1, id1, 0], 'second click: same alert, none created');
  assert(b.content.innerHTML.indexOf('新規 0') >= 0, 'second click: 0 new');
}

// No network / notification / write / storage; escaping of hostile data.
{
  const b = setup({ status: '<img src=x onerror=alert(1)>' });
  click(b.content, { 'data-ino-act': 'quality' });
  assert(b.content.innerHTML.indexOf('<img') < 0 && b.content.innerHTML.indexOf('&lt;img') >= 0, 'hostile status escaped');
  eq(b.errors, [], 'no errors / alerts (no network or storage API was touched)');
  assert(b.sent.every(function (t) { return t === 'harvest:handoff'; }), 'UI dispatched no events');
}

// Missing dependency scripts -> message, no crash, rest of UI works.
{
  const b = setup({ files: ['inoichi-core.js', 'ofk3-inoichi-ui.js'] });
  click(b.content, { 'data-ino-act': 'quality' });
  assert(b.content.innerHTML.indexOf('dependency-missing') >= 0, 'dependency-missing shown');
  click(b.content, { 'data-ino-act': 'run' });
  assert(b.win.OFK3Inoichi.getLastResult() !== null, 'P0 dry-run still works');
  eq(b.errors, [], 'no errors');
}

// Static contract of the UI / glue sources.
{
  ['ofk3-inoichi-ui.js', 'inoichi-quality-dryrun.js'].forEach(function (f) {
    const src = read(f);
    assert(src.indexOf('`') < 0 && src.indexOf('fetch(') < 0 && src.indexOf('XMLHttpRequest') < 0 && src.indexOf('sendBeacon') < 0, f + ': no template literal / network');
    assert(src.indexOf('localStorage') < 0 && src.indexOf('sessionStorage') < 0 && src.indexOf('indexedDB') < 0, f + ': no storage');
    assert(src.indexOf('setInterval(') < 0 && src.indexOf('new MutationObserver') < 0, f + ': no timers/observers');
    assert(src.indexOf('.load(') < 0, f + ': never triggers Cortex capture');
  });
  const ui = read('ofk3-inoichi-ui.js');
  assert(ui.indexOf('enabled = true') < 0 && ui.indexOf('enabled: true') < 0, 'UI never enables a rule');
  assert(read('inoichi-detection-rules.js').match(/enabled: false/g).length === 2, 'both rule definitions remain enabled:false');
  eq(Core.SUPPORTED_INPUT_SCHEMA_VERSIONS, ['0.1'], 'HARVEST handoff schema v0.1 unchanged');
}

console.log('inoichi-quality-dryrun tests passed (' + passed + ' assertions)');
