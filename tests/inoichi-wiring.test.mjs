import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as F from './inoichi-fixtures.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
function read(name) { return readFileSync(join(root, name), 'utf8'); }
let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); passed += 1; }

const FILES = ['inoichi-core.js', 'ofk3-inoichi-ui.js'];
const serverSrc = read('render-webhook-server.js');
const injectSrc = read('inject-tenko-audit.js');
const html = read('index.html');
const pkgJson = JSON.parse(read('package.json'));

// ===== Static contract =====
FILES.forEach(function (f) {
  assert(existsSync(join(root, f)), f + ' exists');
  const src = read(f);
  assert(src.indexOf('`') < 0, f + ': no template literals');
  assert(src.indexOf('setInterval(') < 0, f + ': no setInterval');
  assert(src.indexOf('new MutationObserver') < 0, f + ': no MutationObserver');
  assert(src.indexOf('fetch(') < 0, f + ': no fetch');
  assert(src.indexOf('XMLHttpRequest') < 0 && src.indexOf('sendBeacon') < 0 && src.indexOf('WebSocket') < 0, f + ': no network APIs');
  assert(src.indexOf('/cortex-priority') < 0, f + ': does not reference /cortex-priority endpoint');
  assert(src.indexOf('localStorage') < 0 && src.indexOf('sessionStorage') < 0 && src.indexOf('indexedDB') < 0, f + ': no browser storage');
  assert(src.indexOf('chrome.runtime') < 0, f + ': no extension coupling');
  assert(!/=>/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^'\n]*'/g, '')), f + ': no arrow functions');
  assert(!/\basync\s+function\b/.test(src) && !/\bawait\s/.test(src), f + ': no async/await');
});
assert(read('ofk3-inoichi-ui.js').indexOf('.load(') < 0, 'UI never calls OFK3Cortex13.load (no capture / no re-POST)');
assert(html.toLowerCase().indexOf('inoichi') < 0, 'index.html untouched by INOICHI');

// ===== Injection =====
FILES.forEach(function (f) {
  assert(serverSrc.indexOf("html.indexOf('/" + f + "') < 0") >= 0, 'server guards duplicate injection for ' + f);
  assert(serverSrc.indexOf('<script src="/' + f + '?v=') >= 0, 'server injects ' + f);
  assert(injectSrc.indexOf('<script src="/' + f + '?v=') >= 0, 'inject-tenko-audit tags ' + f);
  assert(injectSrc.indexOf("html.indexOf('/" + f + "') < 0") >= 0, 'inject-tenko-audit guards ' + f);
});
{
  const a = serverSrc.indexOf('/inoichi-core.js?v=');
  const b = serverSrc.indexOf('/ofk3-inoichi-ui.js?v=');
  assert(a > 0 && a < b, 'server order: core before ui');
  assert(a > serverSrc.indexOf('/ofk3-harvest-ui.js?v='), 'INOICHI scripts after HARVEST scripts (server)');
  const ia = injectSrc.indexOf('/inoichi-core.js?v=');
  const ib = injectSrc.indexOf('/ofk3-inoichi-ui.js?v=');
  assert(ia > 0 && ia < ib && ia > injectSrc.indexOf('/ofk3-harvest-ui.js?v='), 'inject order');
  ['/harvest-core.js', '/harvest-collectors-cortex.js', '/ofk3-harvest-ui.js', '/ofk3-cortex-priority-ui.js', '/ofk3-time-window-board.js'].forEach(function (s) {
    assert(serverSrc.indexOf(s) >= 0 && injectSrc.indexOf(s) >= 0, 'existing injection kept: ' + s);
  });
}
assert(pkgJson.scripts['test:inoichi'] === 'node tests/inoichi-core.test.mjs && node tests/inoichi-wiring.test.mjs', 'test:inoichi script');
assert(pkgJson.scripts['test:all'].indexOf('npm run test:inoichi') >= 0, 'test:all includes test:inoichi');
assert(pkgJson.scripts['test:all'].indexOf('npm run test:harvest') >= 0, 'test:all keeps test:harvest');
assert(pkgJson.scripts['test:harvest'] === 'node tests/harvest-core.test.mjs && node tests/harvest-wiring.test.mjs', 'test:harvest unchanged');

// ===== vm run of UI =====
function makeDom() {
  const byId = {};
  const log = { inserted: [], alerts: [] };
  function makeEl(id) {
    const el = {
      id: id || '', style: { cssText: '', display: '' }, _html: '', children: [], _l: [],
      set innerHTML(v) { el._html = v; }, get innerHTML() { return el._html; },
      appendChild: function (c) { el.children.push(c); if (c.id) byId[c.id] = c; return c; },
      addEventListener: function (type, fn) { el._l.push({ type, fn }); },
      insertAdjacentHTML: function (pos, h) {
        log.inserted.push({ host: el.id, pos, html: h });
        const m = h.match(/id="([^"]+)"/);
        if (m) { const n = makeEl(m[1]); n._html = h; byId[m[1]] = n; }
      }
    };
    return el;
  }
  const body = makeEl('body');
  const document = {
    readyState: 'complete', body,
    getElementById: function (id) { return byId[id] || null; },
    createElement: function () { return makeEl(''); },
    addEventListener: function () {}
  };
  byId['ofk3-harvest-btn-wrap'] = makeEl('ofk3-harvest-btn-wrap');
  return { document, byId, log };
}

function click(el, attrs) {
  const target = { disabled: false, getAttribute: function (k) { return attrs[k] == null ? null : attrs[k]; } };
  el._l.forEach(function (l) { if (l.type === 'click') l.fn({ target }); });
}

function boot(winExtra, opts) {
  opts = opts || {};
  const dom = makeDom();
  const listeners = {};
  const warns = [];
  const win = Object.assign({
    addEventListener: function (n, fn) { (listeners[n] = listeners[n] || []).push(fn); },
    dispatchEvent: function (ev) { (listeners[ev.type] || []).forEach(function (fn) { fn(ev); }); return true; }
  }, winExtra);
  win.window = win;
  const ctx = {
    window: win, document: dom.document, console: { warn: function (m) { warns.push(String(m)); }, error: function () {} },
    alert: function (m) { dom.log.alerts.push(m); }, Intl, Date, JSON, Object, Array, String, Number, isFinite, Math, module: undefined
  };
  vm.createContext(ctx);
  (opts.files || FILES).forEach(function (f) { vm.runInContext(read(f), ctx, { filename: f }); });
  return { dom, win, warns, listeners };
}

// Normal flow: button after HARVEST button, dry-run on click only
{
  const inp = F.makeInput();
  const api = F.makeFakeApi(inp);
  let getterCalls = 0;
  Object.keys(api).forEach(function (k) { const f = api[k]; api[k] = function () { getterCalls += 1; return f(); }; });
  const hub = {
    getState: function (id) { return F.makeHarvestState(id); },
    getLastHandoff: function () { return null; }
  };
  const { dom, win } = boot({ OFK3Cortex13: api, OFK3Harvest: { getHub: function () { return hub; } } });
  assert(win.InoichiCore && win.OFK3Inoichi, 'globals exposed');
  const ins = dom.log.inserted.filter(function (i) { return i.html.indexOf('ofk3-inoichi-btn-wrap') >= 0; })[0];
  assert(ins && ins.host === 'ofk3-harvest-btn-wrap' && ins.pos === 'afterend', 'button placed after HARVEST button');
  assert(dom.document.getElementById('ofk3-inoichi-overlay') === null, 'overlay lazily created');
  assert(getterCalls === 0, 'no getter read before user action');

  win.OFK3Inoichi.open();
  const overlay = dom.document.getElementById('ofk3-inoichi-overlay');
  const content = dom.document.getElementById('ofk3-inoichi-content');
  assert(overlay && overlay.style.display === 'block', 'overlay opened');
  assert(overlay.style.cssText.indexOf('z-index:99995') >= 0, 'z-index 99995');
  assert(content.innerHTML.indexOf('INOICHI 変換 (dry-run)') >= 0, 'dry-run button label');
  assert(getterCalls === 0, 'opening does not run conversion');
  assert(win.OFK3Inoichi.getLastResult() === null, 'no result before click');

  // harvest:handoff only records, does not convert
  win.dispatchEvent({ type: 'harvest:handoff', detail: F.makeHandoff('timeWindow') });
  assert(win.OFK3Inoichi.getHandoffRecords().timeWindow.source === 'timeWindow', 'handoff recorded');
  assert(getterCalls === 0 && win.OFK3Inoichi.getLastResult() === null, 'handoff does not auto-run dry-run');
  win.dispatchEvent({ type: 'harvest:handoff', detail: null });
  win.dispatchEvent({ type: 'harvest:handoff', detail: 'junk' });

  click(content, { 'data-ino-act': 'run' });
  assert(getterCalls > 0, 'getters read on click');
  const res = win.OFK3Inoichi.getLastResult();
  assert(res && res.envelopes.length === 2 && res.summary.ofk3Handoff.written === false, 'dry-run result, nothing written');
  assert(content.innerHTML.indexOf('READY: timeWindow, bag') >= 0, 'HANDOFF READY shown');
  assert(content.innerHTML.indexOf('dataType: timeWindow') >= 0 && content.innerHTML.indexOf('dataType: bag') >= 0, 'both dataTypes shown');
  assert(content.innerHTML.indexOf('&quot;schemaVersion&quot;') >= 0, 'JSON shown escaped');
  assert(content.innerHTML.indexOf('<script') < 0, 'no raw html injection');
  assert(content.innerHTML.indexOf('byRoute') >= 0, 'sourceDiagnostics displayed');

  // Escaping of hostile data
  inp.packages[0].address = '<img src=x onerror=alert(1)>';
  click(content, { 'data-ino-act': 'run' });
  assert(content.innerHTML.indexOf('<img') < 0 && content.innerHTML.indexOf('&lt;img') >= 0, 'esc() applied to data');

  // close
  overlay._l.forEach(function (l) { if (l.type === 'click') l.fn({ target: overlay }); });
  assert(overlay.style.display === 'none', 'closes on backdrop click');
}

// Getters throw -> UI survives
{
  const api = {
    getEntry: function () { throw new Error('boom'); }, getPackages: function () { throw new Error('boom'); },
    getPackageAssistIndex: function () { throw new Error('boom'); }, getRouteStops: function () { throw new Error('boom'); },
    getPackageSequenceIndex: function () { throw new Error('boom'); }, getPackageSequenceDiagnostics: function () { throw new Error('boom'); },
    getPackageAssistDiagnostics: function () { throw new Error('boom'); }
  };
  const { dom, win } = boot({ OFK3Cortex13: api });
  win.OFK3Inoichi.open();
  const content = dom.document.getElementById('ofk3-inoichi-content');
  click(content, { 'data-ino-act': 'run' });
  const res = win.OFK3Inoichi.getLastResult();
  assert(res && res.envelopes.every(function (e) { return e.status === 'rejected'; }), 'throwing getters -> rejected, UI alive');
  assert(content.innerHTML.indexOf('rejected') >= 0, 'rejected shown');
  assert(dom.log.alerts.length === 0, 'no alert');
}

// OFK3Cortex13 and HARVEST both absent -> warns, guidance, no crash
{
  const { dom, win, warns } = boot({});
  win.OFK3Inoichi.open();
  const content = dom.document.getElementById('ofk3-inoichi-content');
  assert(content.innerHTML.indexOf('OFK3Cortex13 が見つかりません') >= 0, 'guidance for missing Cortex');
  assert(content.innerHTML.indexOf('HARVEST hub が見つかりません') >= 0, 'guidance for missing hub');
  click(content, { 'data-ino-act': 'run' });
  assert(win.OFK3Inoichi.getLastResult().envelopes.every(function (e) { return e.status === 'rejected'; }), 'rejected without sources');
  assert(warns.some(function (w) { return w.indexOf('OFK3Cortex13') >= 0; }), 'console.warn emitted');
}

// Core missing -> silent
{
  const { dom, win, warns } = boot({}, { files: ['ofk3-inoichi-ui.js'] });
  assert(!win.OFK3Inoichi, 'UI does nothing without core');
  assert(dom.log.inserted.length === 0, 'no DOM mutation without core');
  assert(warns.length === 1, 'warn once');
}

// Chains onto dashboard hook without breaking existing hooks
{
  let orig = 0;
  const { win } = boot({ OFK3TimeWindowBoard: { onDashboardRender: function () { orig += 1; } } });
  win.OFK3TimeWindowBoard.onDashboardRender();
  assert(orig === 1, 'existing onDashboardRender still invoked');
  assert(win.OFK3TimeWindowBoard.__inoichiChained === true, 'chained once');
}

console.log('inoichi-wiring tests passed (' + passed + ' assertions)');
