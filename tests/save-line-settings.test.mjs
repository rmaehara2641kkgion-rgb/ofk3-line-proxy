// Sentry JAVASCRIPT-Y: 設定を閉じると saveLineSettings が存在しない
// #notify-status を更新して TypeError になる。index.html の実関数を vm で実行する。
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, 'index.html has function ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      for (i++; i < src.length && src[i] !== quote; i++) if (src[i] === '\\') i++;
    } else if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
    } else if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

function newElement(id, value) {
  const added = [];
  return {
    id: id,
    value: value || '',
    textContent: '',
    className: '',
    classList: {
      add: function (cls) { added.push(cls); },
      remove: function () {},
      contains: function () { return false; },
      toggle: function () {}
    },
    added: added
  };
}

const REMOVED_IDS = ['notify-status', 'line-notify-token'];

function createHarness(options) {
  const present = {};
  const values = options.values || {};
  (options.ids || []).forEach(function (id) {
    present[id] = newElement(id, values[id]);
  });
  const store = Object.assign({}, options.storage || {});
  const sandbox = {
    lineSettings: Object.assign({}, options.lineSettings || {}),
    renderLineMappings: function () { sandbox.renderCount += 1; },
    renderCount: 0,
    localStorage: {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
      },
      setItem: function (key, value) { store[key] = String(value); }
    },
    document: {
      getElementById: function (id) {
        return Object.prototype.hasOwnProperty.call(present, id) ? present[id] : null;
      }
    }
  };
  sandbox.elements = present;
  sandbox.storage = store;
  vm.createContext(sandbox);
  const source = ['closeSettings', 'initLineSettings', 'saveLineSettings']
    .map(function (name) { return extractFunction(html, name); })
    .join('\n');
  vm.runInContext(source, sandbox, { filename: 'index.html#save-line-settings' });
  return sandbox;
}

const SETTINGS_IDS = [
  'settings-modal',
  'messaging-status',
  'line-channel-token',
  'line-channel-secret',
  'line-message-template',
  'line-admin-id',
  'line-bot-id',
  'line-bot-logo-url',
  'gas-proxy-url',
  'addr-master-gas-url',
  'proxy-secret'
];

function productionDom(extra) {
  return createHarness({
    ids: SETTINGS_IDS.concat((extra && extra.ids) || []),
    values: Object.assign({
      'line-channel-token': 'channel-token',
      'line-channel-secret': 'channel-secret',
      'line-message-template': 'tmpl',
      'line-admin-id': 'Uadmin',
      'line-bot-id': '@bot',
      'line-bot-logo-url': 'https://example.test/logo.png',
      'gas-proxy-url': 'https://script.google.com/macros/s/abc/exec',
      'addr-master-gas-url': 'https://script.google.com/macros/s/def/exec',
      'proxy-secret': 'proxy-secret'
    }, extra && extra.values),
    lineSettings: extra && extra.lineSettings
  });
}

assert.equal(html.includes('id="notify-status"'), false, 'settings markup no longer has #notify-status');
assert.equal(html.includes('id="line-notify-token"'), false, 'settings markup no longer has #line-notify-token');
assert.equal(html.includes('id="messaging-status"'), true, 'Messaging API badge is still in the settings modal');
assert.equal(html.includes('onclick="closeSettings()"'), true, 'closing settings still calls closeSettings');

const closed = productionDom();
assert.equal(closed.document.getElementById('notify-status'), null);
assert.doesNotThrow(function () { closed.closeSettings(); }, 'closeSettings must not throw when #notify-status is gone');
assert.deepEqual(closed.elements['settings-modal'].added, ['hidden']);
const saved = JSON.parse(closed.storage.lineSettings);
assert.equal(saved.notifyToken, '');
assert.equal(saved.channelToken, 'channel-token');
assert.equal(saved.channelSecret, 'channel-secret');
assert.equal(saved.messageTemplate, 'tmpl');
assert.equal(saved.adminLineId, 'Uadmin');
assert.equal(saved.lineBotId, '@bot');
assert.equal(saved.lineBotLogoUrl, 'https://example.test/logo.png');
assert.equal(saved.gasProxyUrl, 'https://script.google.com/macros/s/abc/exec');
assert.equal(saved.addrMasterGasUrl, 'https://script.google.com/macros/s/def/exec');
assert.equal(saved.proxySecret, 'proxy-secret');
assert.equal(closed.elements['messaging-status'].textContent, '設定済み');
assert.equal(closed.elements['messaging-status'].className, 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium');
assert.equal(closed.lineSettings.channelToken, 'channel-token');

const cleared = productionDom({
  values: {
    'line-channel-token': '',
    'line-channel-secret': '',
    'line-message-template': '',
    'line-admin-id': '',
    'line-bot-id': '',
    'line-bot-logo-url': '',
    'gas-proxy-url': '',
    'addr-master-gas-url': '',
    'proxy-secret': ''
  }
});
assert.doesNotThrow(function () { cleared.saveLineSettings(); });
assert.equal(cleared.elements['messaging-status'].textContent, '未設定');
assert.equal(cleared.elements['messaging-status'].className, 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700');
assert.equal(JSON.parse(cleared.storage.lineSettings).channelToken, '');

const booting = productionDom({
  values: {
    'line-channel-token': '',
    'line-channel-secret': '',
    'line-message-template': '',
    'line-admin-id': '',
    'line-bot-id': '',
    'line-bot-logo-url': '',
    'gas-proxy-url': '',
    'addr-master-gas-url': '',
    'proxy-secret': ''
  },
  lineSettings: {
    notifyToken: 'legacy-notify-token',
    channelToken: 'saved-channel',
    channelSecret: 'saved-secret',
    messageTemplate: 'saved-template',
    adminLineId: 'Usaved',
    lineBotId: '@saved',
    lineBotLogoUrl: 'https://example.test/saved.png',
    gasProxyUrl: 'https://script.google.com/macros/s/saved/exec',
    addrMasterGasUrl: 'https://script.google.com/macros/s/addr/exec',
    proxySecret: 'saved-secret-proxy'
  }
});
assert.equal(booting.document.getElementById('line-notify-token'), null);
assert.doesNotThrow(function () { booting.initLineSettings(); }, 'init must not throw when a stored notify token has no input left');
assert.equal(booting.elements['line-channel-token'].value, 'saved-channel');
assert.equal(booting.elements['line-channel-secret'].value, 'saved-secret');
assert.equal(booting.elements['line-message-template'].value, 'saved-template');
assert.equal(booting.elements['line-admin-id'].value, 'Usaved');
assert.equal(booting.elements['line-bot-id'].value, '@saved');
assert.equal(booting.elements['line-bot-logo-url'].value, 'https://example.test/saved.png');
assert.equal(booting.elements['gas-proxy-url'].value, 'https://script.google.com/macros/s/saved/exec');
assert.equal(booting.elements['addr-master-gas-url'].value, 'https://script.google.com/macros/s/addr/exec');
assert.equal(booting.elements['proxy-secret'].value, 'saved-secret-proxy');
assert.equal(booting.elements['messaging-status'].textContent, '設定済み');
assert.equal(booting.renderCount, 1);
assert.equal(booting.lineSettings.notifyToken, 'legacy-notify-token');

const legacy = productionDom({
  ids: REMOVED_IDS,
  values: { 'line-notify-token': 'still-configured' }
});
legacy.saveLineSettings();
assert.equal(legacy.elements['notify-status'].textContent, '設定済み');
assert.equal(legacy.elements['notify-status'].className, 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium');
assert.equal(JSON.parse(legacy.storage.lineSettings).notifyToken, 'still-configured');

const legacyEmpty = productionDom({ ids: ['notify-status', 'line-notify-token'] });
legacyEmpty.saveLineSettings();
assert.equal(legacyEmpty.elements['notify-status'].textContent, '未設定');
assert.equal(legacyEmpty.elements['notify-status'].className, 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700');

const legacyInit = productionDom({
  ids: REMOVED_IDS,
  lineSettings: { notifyToken: 'kept-token', channelToken: '', channelSecret: '' }
});
legacyInit.initLineSettings();
assert.equal(legacyInit.elements['line-notify-token'].value, 'kept-token');
assert.equal(legacyInit.elements['notify-status'].textContent, '設定済み');
assert.equal(legacyInit.elements['notify-status'].className, 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium');
assert.equal(legacyInit.renderCount, 1);

console.log('save-line-settings: ok');
