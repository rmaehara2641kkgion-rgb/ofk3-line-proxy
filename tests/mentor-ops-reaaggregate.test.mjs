import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
function read(name) { return readFileSync(join(repo, name), 'utf8'); }
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

const nowMs = Date.now();
const startMs = nowMs - 60 * 60 * 1000;
const day = new Date(startMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const capturedAt = new Date(nowMs).toISOString();
const yamada = 'S1YAMAD45NAME01';
const sato = 'S2SATOH45NAME02';
let fetches = 0;

function person(id, family, given) {
  return {
    driverPersonId: id,
    driverName: family + ' ' + given,
    driverLastName: family,
    driverFirstName: given,
    reservations: [{
      date: day,
      daPersonId: id,
      startTimeInMinutes: 9 * 60,
      startTimeInEpoch: startMs,
      status: 'ASSIGNED'
    }]
  };
}
function mentorRow(staff, driver, family, given) {
  return {
    driverId: driver,
    realStaffNumber: staff,
    firstName: given,
    lastName: family,
    active: true,
    endDate: ''
  };
}

const context = {
  console: console,
  URL: URL,
  fetch: function () {
    fetches += 1;
    throw new Error('external send');
  },
  importScripts: function (name) {
    vm.runInContext(read(join('cortex-capture-extension', name)), context, { filename: name });
  },
  chrome: {
    action: { onClicked: { addListener: function () {} } },
    runtime: {
      lastError: null,
      onMessage: { addListener: function (fn) { context.__onMessage = fn; } }
    },
    tabs: {
      create: function () {},
      query: function (_query, cb) { cb([{ id: 1 }]); },
      sendMessage: function (_id, msg, cb) {
        if (cb) cb();
        if (msg && msg.type === 'id-diag-updated' && context.deliver) context.deliver(msg.diagnostic);
      }
    },
    storage: {
      local: {
        get: function (_keys, cb) { cb({}); },
        set: function (_data, cb) { if (cb) cb(); }
      }
    },
    scripting: { executeScript: function () { return { then: function () { return { catch: function () {} }; } }; } },
    debugger: { attach: function () {}, detach: function () {}, sendCommand: function () {} }
  }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(read('cortex-capture-extension/background.js'), context, { filename: 'background.js' });

function ask(msg) {
  let response = null;
  context.__onMessage(msg, { tab: { id: 1 }, url: 'https://vrm-mentor.edriving.com/reports' }, function (res) {
    response = res;
  });
  return response;
}

const firstScheduling = ask({
  type: 'id-diag-scheduling',
  digest: { ok: true, capturedAt: capturedAt, fromDate: day, people: [person(yamada, '山田', '太郎')] }
});
assert(firstScheduling && firstScheduling.diagnostic && firstScheduling.diagnostic.crossStatus === 'mentor-missing', 'scheduling alone is not a ready compare');
const ready = ask({
  type: 'id-diag-mentor',
  digest: { ok: true, capturedAt: capturedAt, rows: [mentorRow(yamada, 'D1YAMAD45NAME01', '山田', '太郎')] }
});
assert(ready.diagnostic.crossStatus === 'ready', 'mentor and scheduling together are ready');
assert(ready.diagnostic.mentor.activeRows === 1, 'the active mentor row is counted');

const suspect = ask({ type: 'id-diag-suspect', date: day, includeRows: true });
assert(suspect && suspect.ok === true && suspect.suspect && suspect.suspect.enabled === true, 'a ready capture returns the class aggregation');
assert(suspect.suspect.reason === '', 'fresh mentor and scheduling are not held as missing');
assert(suspect.suspect.counts.total === 1 && suspect.suspect.counts.active === 1, 'the started matching person is aggregated');
assert(suspect.suspect.counts.suspect === 0, 'an active name match is not labeled as not started');
assert(suspect.rollCall == null, 'the class request is not answered with the roll-call view');

const roll = ask({ type: 'id-diag-rollcall', date: day, includeRows: false });
assert(roll && roll.rollCall && roll.suspect == null, 'roll call stays on its own view');

function panelElement(tag) {
  var node = {
    tag: tag, id: '', className: '', type: '', style: {}, children: [],
    parentElement: null, parentNode: null, _text: '', hidden: false, value: '', listeners: {}
  };
  Object.defineProperty(node, 'textContent', {
    get: function () {
      if (node.children.length) return node.children.map(function (child) { return child.textContent; }).join('');
      return node._text;
    },
    set: function (value) {
      node._text = value == null ? '' : String(value);
      node.children = [];
    }
  });
  node.appendChild = function (child) {
    child.parentElement = node;
    child.parentNode = node;
    node.children.push(child);
    return child;
  };
  node.insertBefore = function (child, ref) {
    child.parentElement = node;
    child.parentNode = node;
    var at = node.children.indexOf(ref);
    if (at < 0) node.children.push(child);
    else node.children.splice(at, 0, child);
    return child;
  };
  node.addEventListener = function (type, fn) {
    node.listeners[type] = node.listeners[type] || [];
    node.listeners[type].push(fn);
  };
  node.querySelector = function (sel) {
    return findNode(node, function (child) {
      return sel.charAt(0) === '#' ? child.id === sel.slice(1) : child.tag === sel;
    });
  };
  node.getBoundingClientRect = function () {
    return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
  };
  return node;
}
function findNode(node, pred) {
  for (var i = 0; i < node.children.length; i += 1) {
    if (pred(node.children[i])) return node.children[i];
    var nested = findNode(node.children[i], pred);
    if (nested) return nested;
  }
  return null;
}
function clickControl(button) {
  (button.listeners.click || []).forEach(function (fn) { fn(); });
}

const win = {
  location: { hostname: 'vrm-mentor.edriving.com', origin: 'https://vrm-mentor.edriving.com' },
  listeners: {},
  posts: [],
  OFK3IdDiag: {
    panelLines: function () { return ['ID照合診断（調査用）']; },
    copyPayload: function () { return '{}'; }
  },
  addEventListener: function (type, fn) {
    win.listeners[type] = win.listeners[type] || [];
    win.listeners[type].push(fn);
  },
  postMessage: function (data) {
    win.posts.push(data);
    var source = win.__panelGlobal || win;
    (win.listeners.message || []).slice().forEach(function (fn) {
      fn({ source: source, data: data });
    });
  },
  setInterval: function () { return 1; },
  clearInterval: function () {}
};
win.document = {
  body: panelElement('body'),
  documentElement: panelElement('html'),
  createElement: panelElement,
  getElementById: function (id) {
    return id === 'ofk3-mentor-capture-v0' ? host : findNode(host, function (child) { return child.id === id; });
  }
};
const host = panelElement('div');
host.id = 'ofk3-mentor-capture-v0';
const shadow = panelElement('div');
shadow.getElementById = function (id) {
  return findNode(shadow, function (child) { return child.id === id; });
};
host.shadowRoot = shadow;
const details = panelElement('div');
details.id = 'ofk3-mentor-details';
details.style.display = 'block';
const diag = panelElement('div');
diag.id = 'ofk3-id-diag';
const pre = panelElement('pre');
pre.id = 'ofk3-id-diag-body';
diag.appendChild(panelElement('b'));
diag.appendChild(pre);
details.appendChild(diag);
shadow.appendChild(details);
win.window = win;
win.globalThis = win;

function bridgeReply(data, res) {
  if (data.type === 'id-diag-rollcall') {
    win.postMessage({ source: 'OFK3_ID_DIAG', type: 'rollcall-view', token: data.token, rollCall: res && res.rollCall ? res.rollCall : null });
    return;
  }
  if (data.type === 'id-diag-suspect') {
    win.postMessage({ source: 'OFK3_ID_DIAG', type: 'suspect-view', token: data.token, suspect: res && res.suspect ? res.suspect : null });
    return;
  }
  if (data.type === 'id-diag-confirm-read' || data.type === 'id-diag-confirm' || data.type === 'id-diag-confirm-reset') {
    win.postMessage({ source: 'OFK3_ID_DIAG', type: 'confirm-view', token: data.token, confirmation: res && res.confirmation ? res.confirmation : null });
  }
}

win.addEventListener('message', function (ev) {
  var data = ev.data;
  if (!data || data.source !== 'OFK3_ID_DIAG') return;
  if (data.type === 'id-diag-refresh') {
    var refreshed = ask({ type: 'id-diag-resend' });
    if (refreshed && refreshed.diagnostic) {
      win.postMessage({ source: 'OFK3_ID_DIAG', type: 'diag-result', diagnostic: refreshed.diagnostic });
    }
    return;
  }
  if (data.type === 'id-diag-suspect' || data.type === 'id-diag-rollcall' || data.type === 'id-diag-confirm-read' || data.type === 'id-diag-confirm' || data.type === 'id-diag-confirm-reset') {
    bridgeReply(data, ask(data));
  }
});
context.deliver = function (diagnostic) {
  win.postMessage({ source: 'OFK3_ID_DIAG', type: 'diag-result', diagnostic: diagnostic || null });
};

vm.runInNewContext('this.__panelGlobal = typeof window !== "undefined" ? window : globalThis;\n' + read('cortex-capture-extension/id-diag-panel.js'), win, { filename: 'id-diag-panel.js' });

const status = shadow.getElementById('ofk3-ops-status');
const people = shadow.getElementById('ofk3-ops-people');
const active = shadow.getElementById('ofk3-count-active');
const undetermined = shadow.getElementById('ofk3-count-undetermined');
assert(status.textContent.indexOf('取得済み') >= 0, 'a ready capture leaves the waiting state');
assert(active.textContent === '1人', 'the first aggregation shows the active count');
assert(people.textContent.indexOf('山田 太郎') >= 0, 'the aggregated name is shown');
assert(status.textContent.indexOf('集計待ち') < 0, 'fresh class counts are not left waiting');

const second = ask({
  type: 'id-diag-scheduling',
  digest: {
    ok: true,
    capturedAt: capturedAt,
    fromDate: day,
    people: [person(yamada, '山田', '太郎'), person(sato, '佐藤', '花子')]
  }
});
assert(second.diagnostic.crossStatus === 'ready' && second.diagnostic.scheduling.peopleCount === 2, 'the newer scheduling capture stays ready');
assert(undetermined.textContent === '1人', 'the new scheduling capture recomputes the classes');
assert(active.textContent === '1人', 'the previous active person stays active only while the match still holds');
assert(people.textContent.indexOf('佐藤 花子') >= 0, 'the newly started person appears in the list');
assert(status.textContent.indexOf('集計待ち') < 0 && status.textContent.indexOf('取得済み') >= 0, 'a newer capture does not return to waiting');

const refresh = findNode(diag, function (child) { return child.textContent === '診断を更新'; });
clickControl(refresh);
assert(status.textContent.indexOf('取得済み') >= 0 && undetermined.textContent === '1人', 'refresh runs the aggregation again instead of clearing it');
assert(people.textContent.indexOf('佐藤 花子') >= 0, 'refresh keeps the latest names');

const failed = ask({ type: 'id-diag-mentor', digest: { ok: false, issue: 'FAILED', capturedAt: capturedAt } });
assert(failed.diagnostic.crossStatus === 'failed', 'a mentor failure is not reported as ready');
assert(status.textContent.indexOf('取得失敗。判定しません') >= 0, 'a failed capture names the failure');
assert(active.textContent === '—' && undetermined.textContent === '—', 'a failed capture does not keep the previous counts');
assert(people.textContent.indexOf('山田 太郎') < 0 && people.textContent.indexOf('佐藤 花子') < 0, 'a failed capture hides names');
assert(shadow.getElementById('ofk3-ops-alert-text').textContent.indexOf('Mentorのデータが取得できていません') >= 0, 'the missing mentor source is named');
assert(fetches === 0, 'reaggregation does not send data out');

console.log('mentor-ops-reaaggregate: ok');
