import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
function read(name) { return readFileSync(join(repo, name), 'utf8'); }
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

function panelElement(tag) {
  var node = {
    tag: tag,
    id: '',
    className: '',
    type: '',
    style: {},
    children: [],
    parentElement: null,
    parentNode: null,
    _text: '',
    hidden: false,
    value: '',
    listeners: {}
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
  copied: '',
  OFK3IdDiag: {
    panelLines: function () { return ['ID照合診断（調査用）', 'Scheduling: 取得済み']; },
    copyPayload: function () { return 'DIAG-COPY'; }
  },
  navigator: {
    clipboard: {
      writeText: function (text) {
        win.copied = text;
        return { then: function (fn) { fn(); return { catch: function () {} }; } };
      }
    }
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
const tech = panelElement('div');
tech.id = 'ofk3-mentor-tech';
tech.hidden = true;
const diag = panelElement('div');
diag.id = 'ofk3-id-diag';
const pre = panelElement('pre');
pre.id = 'ofk3-id-diag-body';
diag.appendChild(panelElement('b'));
diag.appendChild(pre);
details.appendChild(diag);
details.appendChild(tech);
shadow.appendChild(details);
win.window = win;
win.globalThis = win;
win.addEventListener('message', function (ev) {
  var data = ev.data;
  if (!data || data.source !== 'OFK3_ID_DIAG') return;
  if (data.type !== 'id-diag-refresh') return;
  win.postMessage({
    source: 'OFK3_ID_DIAG',
    type: 'diag-result',
    diagnostic: {
      stale: false,
      crossStatus: 'ready',
      scheduling: {
        state: 'ready',
        capturedAt: '2026-10-14T01:02:03.000Z',
        schedule: { dateKeys: ['2026-10-14', '2026-10-15'], focus: '2026-10-14' }
      },
      mentor: { state: 'ready', capturedAt: '2026-10-14T01:00:00.000Z' }
    }
  });
});

vm.runInNewContext('this.__panelGlobal = typeof window !== "undefined" ? window : globalThis;\n' + read('cortex-capture-extension/id-diag-panel.js'), win, { filename: 'id-diag-panel.js' });

const title = shadow.getElementById('ofk3-ops-title');
const people = shadow.getElementById('ofk3-ops-people');
const updated = shadow.getElementById('ofk3-ops-updated');
const status = shadow.getElementById('ofk3-ops-status');
const toggle = shadow.getElementById('ofk3-detail-toggle');
const legend = shadow.getElementById('ofk3-detail-legend');
const copy = findNode(diag, function (child) { return child._text === '診断結果をコピー' || child.textContent === '診断結果をコピー'; });
assert(title && title.textContent === 'Mentor稼働確認', 'the normal screen is titled Mentor稼働確認');
assert(pre.hidden === true && legend.hidden === true && toggle.textContent === '詳細診断・取得ログを表示', 'the diagnostic log starts collapsed');
assert(tech.hidden === true, 'the API log starts collapsed');
assert(updated.textContent.indexOf('最終更新時刻（JST）') >= 0 && updated.textContent.indexOf('10:02:03') >= 0, 'the latest capture is shown in JST');
assert(status.textContent.indexOf('集計待ち') >= 0, 'a ready diagnostic waits for the class counts');
assert(shadow.getElementById('ofk3-count-active').textContent === '—', 'counts stay blank until the existing view arrives');

const suspectPosts = win.posts.filter(function (item) { return item.type === 'id-diag-suspect'; });
assert(suspectPosts.length > 0 && suspectPosts[suspectPosts.length - 1].includeRows === true, 'an open panel asks for the existing suspect rows');
const token = suspectPosts[suspectPosts.length - 1].token;
const secret = '秘密 太郎';
const folded = '折り畳み中の氏名';
win.postMessage({
  source: 'OFK3_ID_DIAG',
  type: 'suspect-view',
  token: token,
  suspect: {
    enabled: false,
    reason: 'データ未取得',
    date: '2026-10-14',
    namesShown: false,
    counts: { total: 0, active: 0, ended: 0, suspect: 0, undetermined: 0 },
    rows: [{ schedulingName: secret, department: 'GDS', startLabel: '09:00:00（開始予定）', elapsed: '経過 6分', status: 'Mentor未起動疑い（要確認）' }]
  }
});
assert(status.textContent.indexOf('データ未取得。判定しません') >= 0, 'missing data does not become a judgment');
assert(shadow.getElementById('ofk3-count-suspect').textContent === '—', 'a disabled view does not show zero as a suspect count');
assert(people.textContent.indexOf(secret) < 0 && people.textContent.indexOf('氏名は表示しません') >= 0, 'missing data keeps the name off the page');

win.postMessage({
  source: 'OFK3_ID_DIAG',
  type: 'suspect-view',
  token: token,
  suspect: {
    enabled: false,
    reason: '15分超過',
    date: '2026-10-14',
    namesShown: false,
    counts: { total: 0, active: 0, ended: 0, suspect: 0, undetermined: 0 },
    rows: [{ schedulingName: secret, status: '現在Active確認候補' }]
  }
});
assert(status.textContent.indexOf('取得が古い。判定しません') >= 0 && people.textContent.indexOf(secret) < 0, 'stale data stays undetermined and unnamed');

details.style.display = 'none';
win.postMessage({
  source: 'OFK3_ID_DIAG',
  type: 'suspect-view',
  token: token,
  suspect: {
    enabled: true,
    date: '2026-10-14',
    namesShown: true,
    counts: { total: 1, active: 0, ended: 0, suspect: 1, undetermined: 0 },
    rows: [{ schedulingName: folded, department: 'GDS', startLabel: '09:00:00（開始予定）', elapsed: '経過 6分', status: 'Mentor未起動疑い（要確認）' }]
  }
});
assert(people.textContent.indexOf(folded) < 0, 'a collapsed panel does not paint names');
details.style.display = 'block';
win.postMessage({
  source: 'OFK3_ID_DIAG',
  type: 'suspect-view',
  token: token,
  suspect: {
    enabled: true,
    date: '2026-10-14',
    namesShown: true,
    counts: { total: 10, active: 2, ended: 1, suspect: 3, undetermined: 4 },
    rows: [
      { schedulingName: '該当 なし', department: 'GDSダイレクト', startLabel: '09:00:00（開始予定）', elapsed: '経過 30分', status: 'Mentor未起動疑い（要確認）' },
      { schedulingName: '要確認', department: '要確認', startLabel: '09:10:00（開始予定）', elapsed: '経過 20分', status: '判定不能（原因付き）' },
      { schedulingName: '終了 履歴', department: 'JHS', startLabel: '08:00:00（開始予定）', elapsed: '経過 90分', status: '当日終了履歴あり（参考）' },
      { schedulingName: '稼働 中', department: 'GDSダイレクト', startLabel: '09:30:00（開始予定）', elapsed: '経過 10分', status: '現在Active確認候補' }
    ]
  }
});
assert(shadow.getElementById('ofk3-count-active').textContent === '2人', 'active count is the existing view count');
assert(shadow.getElementById('ofk3-count-ended').textContent === '1人', 'ended count is the existing view count');
assert(shadow.getElementById('ofk3-count-suspect').textContent === '3人', 'suspect count is the existing view count');
assert(shadow.getElementById('ofk3-count-undetermined').textContent === '4人', 'undetermined count is the existing view count');
assert(shadow.getElementById('ofk3-ops-alert').hidden === true && shadow.getElementById('ofk3-ops-alert-text').textContent.indexOf('Schedulingのデータが取得できていません') < 0, 'a ready class view does not show the acquisition warning');
assert(people.textContent.indexOf('未起動疑い 3人') >= 0 && people.textContent.indexOf('未起動疑い 3人') < people.textContent.indexOf('判定不能 4人'), 'warning classes stay above the others');
assert(people.textContent.indexOf('現在の分類: Mentor未起動疑い（要確認）') >= 0, 'the row keeps the existing suspect class');
assert(people.textContent.indexOf('現在の分類: 判定不能（原因付き）') >= 0, 'the row keeps the existing undetermined class');
assert(people.textContent.indexOf('現在の分類: 当日終了履歴あり（参考）') >= 0, 'the row keeps the existing ended class');
assert(people.textContent.indexOf('現在の分類: 現在Active確認候補') >= 0, 'the row keeps the existing active class');
assert(people.textContent.indexOf('要確認') >= 0 && people.textContent.indexOf('所属会社: 要確認') >= 0, 'an unmatched person stays on the withheld label');
assert(people.textContent.indexOf('Active候補は本人確認・点呼完了を証明しない') < 0, 'the caution stays with the counts, not inside a renamed class');
assert(shadow.getElementById('ofk3-ops-caution').textContent.indexOf('Active候補は本人確認・点呼完了を証明しない') >= 0, 'the active caution stays visible');
assert(shadow.getElementById('ofk3-ops-caution').textContent.indexOf('未起動疑いは未起動・点呼未実施の証明ではない') >= 0, 'the suspect caution stays visible');

clickControl(toggle);
assert(pre.hidden === false && legend.hidden === false && tech.hidden === false && toggle.textContent === '詳細診断・取得ログを閉じる', 'the detail control opens the diagnostic and the API log');
assert(pre.textContent.indexOf('ID照合診断（調査用）') >= 0 && legend.textContent.indexOf('Scheduling取得情報') >= 0 && legend.textContent.indexOf('hook installed') >= 0, 'opening detail keeps the diagnostic text');
assert(copy && copy.parentElement.hidden === false, 'copy stays inside the opened detail');
clickControl(copy);
const note = shadow.getElementById('ofk3-id-diag-note');
assert(win.copied === 'DIAG-COPY' && note.textContent === 'コピーしました', 'diagnostic copy uses the existing payload');
clickControl(toggle);
assert(pre.hidden === true && tech.hidden === true && toggle.textContent === '詳細診断・取得ログを表示', 'the detail control closes again');

const select = shadow.getElementById('ofk3-id-diag-date');
select.value = '2026-10-15';
(select.listeners.change || []).forEach(function (fn) { fn(); });
const dated = win.posts.filter(function (item) { return item.type === 'id-diag-suspect'; });
assert(dated[dated.length - 1].date === '2026-10-15', 'changing the date asks for that day');
assert(people.textContent.indexOf('該当 なし') < 0, 'the previous day leaves the list while the new day is loading');

const beforeRefresh = win.posts.filter(function (item) { return item.type === 'id-diag-refresh'; }).length;
clickControl(findNode(diag, function (child) { return child.textContent === '診断を更新'; }));
assert(win.posts.filter(function (item) { return item.type === 'id-diag-refresh'; }).length === beforeRefresh + 1, 'refresh asks for a new diagnostic');

const roll = shadow.getElementById('ofk3-rollcall-toggle');
const rollBody = shadow.getElementById('ofk3-rollcall-body');
assert(roll.textContent === '点呼要確認一覧' && shadow.getElementById('ofk3-rollcall').hidden === true, 'the roll call list still starts closed');
clickControl(roll);
assert(roll.textContent === '点呼要確認一覧を閉じる', 'the roll call list still opens');
clickControl(roll);
assert(roll.textContent === '点呼要確認一覧' && rollBody.textContent === '', 'closing the roll call list still removes names');

const panelSrc = read('cortex-capture-extension/id-diag-panel.js');
assert(panelSrc.indexOf('var attention = (counts.activeUnseen || 0) + (counts.after5Unmatched || 0) + (counts.unknownTime || 0);') > 0, 'the attention formula is unchanged');
assert(panelSrc.indexOf('Schedulingのデータが取得できていません。Scheduling UIを開いて対象日の予約一覧を表示してください。すでに開いている場合はページを更新してください。') > 0, 'the scheduling warning uses the required sentence');
assert(panelSrc.indexOf('window.open') < 0 && panelSrc.indexOf('chrome.tabs') < 0 && panelSrc.indexOf('fetch(') < 0, 'the warning does not open a tab or call the network');
assert(read('cortex-capture-extension/mentor-capture.js').indexOf('sendActiveSnapshot') > 0 && read('cortex-capture-extension/mentor-capture.js').indexOf('HARVESTへ送る') > 0, 'the HARVEST button and its sender remain');

function latestSuspectToken() {
  const posts = win.posts.filter(function (item) { return item.type === 'id-diag-suspect'; });
  return posts[posts.length - 1].token;
}
function postSuspect(suspect) {
  win.postMessage({ source: 'OFK3_ID_DIAG', type: 'suspect-view', token: latestSuspectToken(), suspect: suspect });
}
const heldName = '保留 太郎';
postSuspect({
  enabled: true,
  reason: 'データ未取得',
  date: '2026-10-14',
  namesShown: true,
  sources: { scheduling: 'missing', mentor: 'ready' },
  counts: { total: 0, active: 0, ended: 0, suspect: 0, undetermined: 0 },
  rows: [{ schedulingName: heldName, department: 'GDS', startLabel: '09:00:00（開始予定）', elapsed: '経過 6分', status: 'Mentor未起動疑い（要確認）' }]
});
const alert = shadow.getElementById('ofk3-ops-alert');
const alertText = shadow.getElementById('ofk3-ops-alert-text');
assert(alert.hidden === false && alertText.textContent === 'Schedulingのデータが取得できていません。Scheduling UIを開いて対象日の予約一覧を表示してください。すでに開いている場合はページを更新してください。', 'missing scheduling data shows the scheduling warning');
assert(alertText.textContent.indexOf('Mentorのデータが取得できていません') < 0, 'a ready mentor source does not add the mentor warning');
assert(status.textContent.indexOf('データ未取得。判定しません') >= 0, 'missing scheduling data stays unresolved');
assert(shadow.getElementById('ofk3-count-active').textContent === '—' && shadow.getElementById('ofk3-count-suspect').textContent === '—', 'missing data does not show the four classes as zero');
assert(people.textContent.indexOf(heldName) < 0 && people.textContent.indexOf('氏名は表示しません') >= 0, 'missing scheduling data shows no name');
const postsBeforeClose = win.posts.length;
(shadow.getElementById('ofk3-ops-alert-close').listeners.click || []).forEach(function (fn) { fn(); });
assert(alert.hidden === true && win.posts.length === postsBeforeClose, 'closing the warning sends nothing');
assert(shadow.getElementById('ofk3-count-suspect').textContent === '—' && people.textContent.indexOf(heldName) < 0, 'closing the warning keeps the hold');
postSuspect({
  enabled: true,
  reason: '',
  date: '2026-10-14',
  namesShown: true,
  sources: { scheduling: 'failed', mentor: 'ready' },
  counts: { total: 0, active: 0, ended: 0, suspect: 0, undetermined: 0 },
  rows: [{ schedulingName: heldName, status: '現在Active確認候補' }]
});
assert(alert.hidden === false && status.textContent.indexOf('取得失敗。判定しません') >= 0 && people.textContent.indexOf(heldName) < 0, 'a scheduling failure is distinct and still shows no class or name');
postSuspect({
  enabled: true,
  reason: '15分超過',
  date: '2026-10-14',
  namesShown: true,
  sources: { scheduling: 'stale', mentor: 'ready' },
  counts: { total: 1, active: 0, ended: 0, suspect: 0, undetermined: 1 },
  rows: [{ schedulingName: heldName, status: '判定不能（原因付き）' }]
});
assert(alert.hidden === false && status.textContent.indexOf('取得が古い。判定しません') >= 0 && shadow.getElementById('ofk3-count-undetermined').textContent === '—', 'stale scheduling data stays on hold instead of showing the internal count');
postSuspect({
  enabled: true,
  reason: 'データ未取得',
  date: '2026-10-14',
  namesShown: false,
  sources: { scheduling: 'ready', mentor: 'missing' },
  counts: { total: 0, active: 0, ended: 0, suspect: 0, undetermined: 0 },
  rows: []
});
assert(alertText.textContent === 'Mentorのデータが取得できていません。このMentor画面を更新してください。' && alertText.textContent.indexOf('Schedulingのデータが取得できていません') < 0, 'a missing mentor source shows only the mentor warning');
assert(shadow.getElementById('ofk3-count-active').textContent === '—', 'a missing mentor source does not show zero people');
postSuspect({
  enabled: true,
  reason: '',
  date: '2026-10-14',
  namesShown: true,
  sources: { scheduling: 'ready', mentor: 'ready' },
  counts: { total: 1, active: 1, ended: 0, suspect: 0, undetermined: 0 },
  rows: [{ schedulingName: '稼働 中', department: 'GDSダイレクト', startLabel: '09:30:00（開始予定）', elapsed: '経過 10分', status: '現在Active確認候補' }]
});
assert(alert.hidden === true && alertText.textContent === '' && shadow.getElementById('ofk3-count-active').textContent === '1人', 'fresh sources hide the warning and show the class count');

console.log('mentor-ops-ui: ok');
