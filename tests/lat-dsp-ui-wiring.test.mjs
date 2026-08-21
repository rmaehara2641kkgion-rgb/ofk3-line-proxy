import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const coreSource = readFileSync(join(repoRoot, 'lat-departure-core.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function newElement() {
  var el = {
    _attrs: {},
    _listeners: {},
    style: {},
    classList: {
      owner: null,
      add: function () {},
      remove: function () {},
      contains: function () { return false; }
    },
    textContent: '',
    innerHTML: '',
    value: '',
    tagName: 'DIV',
    closest: function () { return null; }
  };
  el.classList.owner = el;
  el.setAttribute = function (k, v) { el._attrs[k] = v; };
  el.removeAttribute = function (k) { delete el._attrs[k]; };
  el.getAttribute = function (k) { return el._attrs[k]; };
  el.addEventListener = function (type, cb) {
    if (!el._listeners[type]) el._listeners[type] = [];
    el._listeners[type].push(cb);
  };
  el.click = function () {
    var cbs = el._listeners.change || [];
    for (var i = 0; i < cbs.length; i++) cbs[i]({ target: el, preventDefault: function () {} });
  };
  el.dispatch = function (type, ev) {
    var cbs = el._listeners[type] || [];
    for (var i = 0; i < cbs.length; i++) cbs[i](ev);
  };
  return el;
}

function buildSandbox() {
  var input = newElement();
  input.tagName = 'INPUT';
  input.id = 'dsp-file-input';
  input._attrs.onchange = 'handleDspFile(this.files[0])';
  input.files = [{ name: 'dsp-ui-test.csv' }];

  var zone = newElement();
  zone.id = 'dsp-drop-zone';
  zone._attrs.ondrop = 'handleDspDrop(event)';

  var elements = {
    'dsp-file-input': input,
    'dsp-drop-zone': zone,
    'dsp-loaded-msg': newElement()
  };

  var domContentLoadedListeners = [];
  var sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.alert = function () {};
  sandbox.document = {
    readyState: 'loading',
    getElementById: function (id) { return elements[id] || null; },
    addEventListener: function (type, cb) {
      if (type === 'DOMContentLoaded') domContentLoadedListeners.push(cb);
    }
  };
  sandbox.FileReader = function () {
    this.onload = null;
  };
  sandbox.FileReader.prototype.readAsArrayBuffer = function () {};
  sandbox.XLSX = { read: function () { return { Sheets: { Sheet1: {} }, SheetNames: ['Sheet1'] }; }, utils: { sheet_to_json: function () { return []; } } };

  return { sandbox, input, zone, domContentLoadedListeners };
}

function runTests() {
  var ctx = buildSandbox();
  var sandbox = ctx.sandbox;
  var input = ctx.input;
  var zone = ctx.zone;

  vm.runInContext(coreSource, vm.createContext(sandbox), { filename: 'lat-departure-core.js' });
  sandbox.document.readyState = 'interactive';
  for (var i = 0; i < ctx.domContentLoadedListeners.length; i++) ctx.domContentLoadedListeners[i]();

  assert(sandbox.__latDspUiWired === true, 'wireLatDspUploadUi ran during loader install');
  assert(input.getAttribute('onchange') === undefined, 'legacy inline onchange removed from dsp-file-input');
  assert(zone.getAttribute('ondrop') === undefined, 'legacy inline ondrop removed from dsp-drop-zone');

  sandbox.handleDspFile = function (file) {
    sandbox.__latDspInvocation = { source: 'production-loader', fileName: file.name, invokedAt: Date.now() };
  };

  // file input change -> production loader
  input.dispatch('change', { target: input, preventDefault: function () {} });
  assert(sandbox.__latDspInvocation && sandbox.__latDspInvocation.source === 'production-loader', 'change event reaches production loader');
  assert(sandbox.__latDspInvocation.fileName === 'dsp-ui-test.csv', 'change passes selected file');

  sandbox.__latDspInvocation = undefined;

  // drop zone -> production loader
  zone.dispatch('drop', {
    preventDefault: function () {},
    dataTransfer: { files: [{ name: 'dsp-drop-test.csv' }] }
  });
  assert(sandbox.__latDspInvocation && sandbox.__latDspInvocation.source === 'production-loader', 'drop event reaches production loader');
  assert(sandbox.__latDspInvocation.fileName === 'dsp-drop-test.csv', 'drop passes transferred file');

  console.log('lat-dsp-ui-wiring.test.mjs: all tests passed');
}

runTests();
