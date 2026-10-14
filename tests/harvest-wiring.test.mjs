import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
function read(name) { return readFileSync(join(root, name), 'utf8'); }
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

const FILES = ['harvest-core.js', 'harvest-collectors-cortex.js', 'ofk3-harvest-ui.js'];
const serverSrc = read('render-webhook-server.js');
const injectSrc = read('inject-tenko-audit.js');
const html = read('index.html');
const pkgJson = JSON.parse(read('package.json'));
const cortexUiSrc = read('ofk3-cortex-priority-ui.js');

// ===== Files exist + static safety =====
FILES.forEach(function (f) {
  assert(existsSync(join(root, f)), f + ' exists');
  const src = read(f);
  assert(src.indexOf('`') < 0, f + ': no template literals');
  assert(src.indexOf('setInterval(') < 0, f + ': no setInterval');
  assert(src.indexOf('new MutationObserver') < 0, f + ': no MutationObserver');
  assert(src.indexOf('fetch(') < 0, f + ': no own fetch');
  assert(src.indexOf('/cortex-priority') < 0, f + ': does not reference /cortex-priority endpoint');
  assert(src.indexOf('chrome.runtime') < 0 && src.indexOf('externally_connectable') < 0, f + ': no extension coupling');
  assert(src.indexOf('XMLHttpRequest') < 0, f + ': no XHR');
  assert(!/=>/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^'\n]*'/g, '')), f + ': no arrow functions (Edge IE mode)');
  assert(!/\basync\s+function\b/.test(src) && !/\bawait\s/.test(src), f + ': no async/await');
});
assert(html.indexOf('harvest-core.js') < 0 && html.indexOf('ofk3-harvest-ui.js') < 0, 'index.html untouched by HARVEST');

// ===== Collectors depend on OFK3Cortex13 getters =====
{
  const col = read('harvest-collectors-cortex.js');
  ['window.OFK3Cortex13', 'load', 'getEntry', 'getPackages', 'getPackageAssistIndex', 'getPackageSequenceIndex',
    'getRouteStops', 'getStops', 'getPackageAssistDiagnostics', 'getPackageSequenceDiagnostics'].forEach(function (n) {
    assert(col.indexOf(n) >= 0, 'collectors use ' + n);
  });
  ['getEntry', 'getPackages', 'getPackageAssistIndex', 'getPackageSequenceIndex', 'getRouteStops', 'getStops', 'load'].forEach(function (n) {
    assert(cortexUiSrc.indexOf(n + ':') >= 0, 'OFK3Cortex13 exports ' + n);
  });
  assert(col.indexOf("dependsOn: ['timeWindow']") >= 0, 'bag dependsOn timeWindow');
  assert(col.indexOf('human-external') >= 0, 'trigger kind human-external');
  assert(col.indexOf('「取得開始」→「Bag取得」→「OFK3へ送信」') >= 0, 'trigger instruction text');
}

// ===== Server injection / inject script / package.json =====
FILES.forEach(function (f) {
  assert(serverSrc.indexOf("html.indexOf('/" + f + "') < 0") >= 0, 'server guards duplicate injection for ' + f);
  assert(serverSrc.indexOf('<script src="/' + f + '?v=') >= 0, 'server injects ' + f);
  assert(injectSrc.indexOf('<script src="/' + f + '?v=') >= 0, 'inject-tenko-audit tags ' + f);
  assert(injectSrc.indexOf("html.indexOf('/" + f + "') < 0") >= 0, 'inject-tenko-audit guards ' + f);
});
{
  const a = serverSrc.indexOf('/harvest-core.js?v=');
  const b = serverSrc.indexOf('/harvest-collectors-cortex.js?v=');
  const c = serverSrc.indexOf('/ofk3-harvest-ui.js?v=');
  assert(a > 0 && a < b && b < c, 'server script order: core, collectors, ui');
  assert(a > serverSrc.indexOf('/ofk3-cortex-priority-ui.js?v=') && a > serverSrc.indexOf('/ofk3-time-window-board.js?v='), 'HARVEST scripts after existing OFK3 scripts');
  const ia = injectSrc.indexOf('/harvest-core.js?v=');
  const ib = injectSrc.indexOf('/harvest-collectors-cortex.js?v=');
  const ic = injectSrc.indexOf('/ofk3-harvest-ui.js?v=');
  assert(ia > 0 && ia < ib && ib < ic, 'inject script order');
  // existing injections remain
  ['/ofk3-cortex-priority-ui.js', '/ofk3-time-window-board.js', '/gds-fleet-audit-core.js', '/ofk3-gds-fleet-audit-ui.js'].forEach(function (s) {
    assert(serverSrc.indexOf(s) >= 0 && injectSrc.indexOf(s) >= 0, 'existing injection kept: ' + s);
  });
  assert(serverSrc.indexOf('?v=20260923-driveraid') >= 0, 'time-window cache bust untouched');
}
assert(pkgJson.scripts['test:harvest'] === 'node tests/harvest-core.test.mjs && node tests/harvest-wiring.test.mjs', 'test:harvest script');
assert(pkgJson.scripts['test:all'].indexOf('npm run test:harvest') >= 0, 'test:all includes test:harvest');
assert(pkgJson.scripts['test:cortex-13'].indexOf('cortex-bag-enrichment.test.mjs') >= 0, 'test:cortex-13 unchanged');

// ===== Sanitizer: bagStatus / bagSource, backward compatible =====
{
  const start = serverSrc.indexOf('function sanitizeCortexPackageAssistIndexRow');
  const end = serverSrc.indexOf('function sanitizeCortexPackageAssistDiagnostics');
  assert(start > 0 && end > start, 'sanitizer source located');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(serverSrc.slice(start, end) + '\nthis.fn = sanitizeCortexPackageAssistIndexRow;', ctx);
  const fn = ctx.fn;

  const legacy = fn({ routeCode: 'R1', trackingId: 'T1', bagName: 'B', bagDisplay: 'B' });
  assert(legacy.bagStatus === null && legacy.bagSource === null, 'legacy row: bagStatus/bagSource null');
  assert(legacy.bagName === 'B' && legacy.bagDisplay === 'B' && legacy.routeCode === 'R1', 'legacy row fields preserved');

  const fresh = fn({ routeCode: 'R1', trackingId: 'T1', bagStatus: 'captured_null', bagSource: 'trDetails', bagName: null });
  assert(fresh.bagStatus === 'captured_null' && fresh.bagSource === 'trDetails', 'new row carries bagStatus/bagSource');
  assert(fresh.bagName === null, 'captured_null keeps bagName null');

  const na = fn({ routeCode: 'R1', trackingId: 'T1', bagStatus: 'not_attempted', bagSource: null });
  assert(na.bagStatus === 'not_attempted' && na.bagSource === null, 'not_attempted row');

  const empty = fn({ routeCode: 'R1', trackingId: 'T1', bagStatus: '', bagSource: '' });
  assert(empty.bagStatus === null && empty.bagSource === null, 'empty string -> null');

  assert(fn({ routeCode: '', trackingId: 'T1' }) === null, 'invalid row still dropped');
  assert(fn(null) === null, 'null row still dropped');
  const num = fn({ routeCode: 'R1', trackingId: 'T1', bagStatus: 5 });
  assert(num.bagStatus === '5', 'bagStatus coerced to String');
}

// ===== vm run of UI with DOM stub =====
function makeDom() {
  const byId = {};
  const listeners = {};
  const log = { inserted: [], alerts: [] };
  function makeEl(id) {
    const el = {
      id: id || '', style: { cssText: '', display: '' }, _html: '', children: [], attrs: {},
      set innerHTML(v) { el._html = v; }, get innerHTML() { return el._html; },
      appendChild: function (c) { el.children.push(c); if (c.id) byId[c.id] = c; return c; },
      addEventListener: function (type, fn) { (listeners[el.id || '_'] = listeners[el.id || '_'] || []).push({ type, fn, el }); el._l = el._l || []; el._l.push({ type, fn }); },
      insertAdjacentHTML: function (pos, h) {
        log.inserted.push({ host: el.id, pos, html: h });
        const m = h.match(/id="([^"]+)"/);
        if (m) { const n = makeEl(m[1]); n._html = h; byId[m[1]] = n; }
      },
      getAttribute: function (k) { return el.attrs[k] == null ? null : el.attrs[k]; }
    };
    return el;
  }
  const body = makeEl('body');
  body.appendChild = function (c) { body.children.push(c); if (c.id) byId[c.id] = c; return c; };
  const document = {
    readyState: 'complete',
    body,
    getElementById: function (id) { return byId[id] || null; },
    createElement: function () { return makeEl(''); },
    addEventListener: function () {}
  };
  byId['ofk3-cortex13-dash-card'] = makeEl('ofk3-cortex13-dash-card');
  return { document, byId, log, makeEl };
}

function click(el, attrs) {
  const target = { attrs: attrs, disabled: false, getAttribute: function (k) { return attrs[k] == null ? null : attrs[k]; } };
  (el._l || []).forEach(function (l) { if (l.type === 'click') l.fn({ target: target }); });
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(function (r) { setTimeout(r, 5); });
}

{
  const dom = makeDom();
  const events = [];
  let loadCalls = 0;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const pk = [{ routeCode: 'R1', trackingId: 'T1', plannedEndTime: 1, plannedEndClock: '13:00', address: 'SECRET-ADDR' }];
  const assist = [{ routeCode: 'R1', trackingId: 'T1', bagName: null, bagDisplay: null, bagStatus: 'captured_null', bagSource: 'trDetails' }];
  const existingDashHook = { calls: 0 };
  const win = {
    OFK3Cortex13: {
      load: function () { loadCalls += 1; return Promise.resolve(); },
      getEntry: function () { return { localDate: today, packages: pk }; },
      getPackages: function () { return pk; },
      getPackageAssistIndex: function () { return assist; },
      getPackageAssistDiagnostics: function () { return null; },
      getPackageSequenceIndex: function () { return []; },
      getPackageSequenceDiagnostics: function () { return null; },
      getRouteStops: function () { return []; },
      getStops: function () { return []; }
    },
    OFK3TimeWindowBoard: {
      onDashboardRender: function () {
        existingDashHook.calls += 1;
        if (!dom.document.getElementById('ofk3-tw-board-btn-wrap')) {
          dom.document.getElementById('ofk3-cortex13-dash-card').insertAdjacentHTML('afterend', '<div id="ofk3-tw-board-btn-wrap"></div>');
        }
      }
    },
    dispatchEvent: function (ev) { events.push(ev); return true; }
  };
  const ctx = {
    window: win, document: dom.document, console, alert: function (m) { dom.log.alerts.push(m); },
    setTimeout, Intl, Date, Promise, JSON, Object, Array, String, Number, isFinite, Math,
    CustomEvent: function (name, init) { this.type = name; this.detail = init && init.detail; },
    module: undefined
  };
  win.window = win;
  vm.createContext(ctx);
  FILES.forEach(function (f) { vm.runInContext(read(f), ctx, { filename: f }); });

  assert(win.HarvestCore && win.HarvestCollectorsCortex && win.OFK3Harvest, 'globals exposed');
  const hub = win.OFK3Harvest.getHub();
  assert(hub.listIds().join(',') === 'timeWindow,bag', 'collectors registered in default hub');

  // button inserted after existing tw board wrap; no overlay yet
  assert(dom.document.getElementById('ofk3-harvest-btn-wrap'), 'HARVEST button inserted');
  assert(dom.document.getElementById('ofk3-harvest-overlay') === null, 'overlay lazily created');
  const ins = dom.log.inserted.filter(function (i) { return i.html.indexOf('ofk3-harvest-btn-wrap') >= 0; })[0];
  assert(ins.host === 'ofk3-tw-board-btn-wrap' || ins.host === 'ofk3-cortex13-dash-card', 'button placed next to existing dashboard card');

  // existing hook still called and chained (dashboard re-render re-inserts button)
  delete dom.document.getElementById; // ensure not relied upon accidentally
  dom.document.getElementById = function (id) { return id === 'ofk3-harvest-btn-wrap' ? null : (dom.byId[id] || null); };
  win.OFK3TimeWindowBoard.onDashboardRender();
  assert(existingDashHook.calls >= 1, 'existing onDashboardRender still invoked');
  assert(dom.log.inserted.filter(function (i) { return i.html.indexOf('ofk3-harvest-btn-wrap') >= 0; }).length === 2, 'button re-inserted after dashboard re-render via chained hook');
  dom.document.getElementById = function (id) { return dom.byId[id] || null; };

  // IDs do not collide with existing ones
  ['ofk3-harvest-btn-wrap', 'ofk3-harvest-overlay', 'ofk3-harvest-content'].forEach(function (id) {
    assert(id.indexOf('ofk3-harvest-') === 0, id + ' prefixed');
  });

  // open overlay
  win.OFK3Harvest.open();
  const overlay = dom.document.getElementById('ofk3-harvest-overlay');
  const content = dom.document.getElementById('ofk3-harvest-content');
  assert(overlay && overlay.style.display === 'block', 'overlay opened');
  assert(content.innerHTML.indexOf('HARVEST ALL (全Collector再確認)') >= 0, 'HARVEST ALL button present');
  assert(content.innerHTML.indexOf('「取得開始」→「Bag取得」→「OFK3へ送信」を実行後') >= 0, 'human procedure shown');
  assert(content.innerHTML.indexOf('未確認') >= 0, 'idle shown as 未確認');
  assert(content.innerHTML.indexOf('取得中') < 0, 'no 取得中 wording in UI');
  assert(content.innerHTML.indexOf('Cortexの取得を開始しません') >= 0, 'UI states it does not start Cortex capture');
  ['Collector', '状態', '最終確認', '成功', '失敗', 'エラー', 'Action'].forEach(function (h) {
    assert(content.innerHTML.indexOf('>' + h + '<') >= 0, 'table header ' + h);
  });

  // click HARVEST ALL
  click(content, { 'data-hv-act': 'run-all' });
  await flush();
  assert(loadCalls === 1, 'single load() for HARVEST ALL via UI (got ' + loadCalls + ')');
  assert(hub.getState('timeWindow').status === 'ok' && hub.getState('bag').status === 'ok', 'both ok through UI');
  assert(content.innerHTML.indexOf('COMPLETE') >= 0, 'overall COMPLETE rendered');
  assert(content.innerHTML.indexOf('正常') >= 0, 'ok label rendered');
  assert(content.innerHTML.indexOf('SECRET-ADDR') < 0, 'no PII in UI');
  assert(content.innerHTML.indexOf('captured_null') >= 0, 'bag state breakdown rendered');

  // single re-check button
  click(content, { 'data-hv-act': 'run', 'data-hv-id': 'bag' });
  await flush();
  assert(loadCalls === 2, 'single recheck performs one more load()');

  // handoff button dispatches harvest:handoff and does nothing else
  click(content, { 'data-hv-act': 'handoff', 'data-hv-id': 'timeWindow' });
  assert(events.length === 1 && events[0].type === 'harvest:handoff', 'handoff via UI dispatches harvest:handoff');
  assert(events[0].detail.harvestConfirmed === true && events[0].detail.schemaVersion === '0.1', 'handoff detail');
  assert(JSON.stringify(events[0].detail).indexOf('SECRET-ADDR') < 0, 'handoff has no PII');

  // close
  overlay._l.forEach(function (l) { if (l.type === 'click') l.fn({ target: overlay }); });
  assert(overlay.style.display === 'none', 'overlay closes on backdrop click');
}

// ===== Degrades silently when core is missing (script 404) =====
{
  const dom = makeDom();
  const ctx = { window: {}, document: dom.document, console: { warn: function () {}, error: function () {} }, Intl, Date, Promise, JSON, Object, Array, String, Number };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(read('ofk3-harvest-ui.js'), ctx);
  assert(!ctx.window.OFK3Harvest, 'UI does nothing without core');
  assert(dom.log.inserted.length === 0, 'no DOM mutation without core');
}

console.log('harvest-wiring tests passed');
