import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const Core = require(join(repo, 'cortex-capture-extension/id-diag-core.js'));
function read(name) { return readFileSync(join(repo, name), 'utf8'); }
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

const DAY = '2026-10-14';
const NOW = new Date(Date.UTC(2026, 9, 14, 2, 0, 0));
const START = Date.UTC(2026, 9, 14, 0, 0, 0);
const RANGE_START = Date.UTC(2026, 9, 13, 15, 0, 0);
const RANGE_END = RANGE_START + 86400000;
const FRESH = NOW.toISOString();
const URL = 'https://vrm-mentor.edriving.com/reports/driver/shifts?decorate=yes&startTime=' + RANGE_START + '&endTime=' + RANGE_END + '&localDate=' + DAY;

function pair(official, mentorName) {
  const judged = Core.classifyNamePair(official, mentorName);
  assert(judged.identity === false, official + ' / ' + mentorName + ' must not become identity');
  return judged;
}
assert(pair('山田 太郎', '山田 太郎').relation === 'normalized' && pair('山田 太郎', '山田 太郎').reason === '表記が一致', 'exact names normalize without confirming identity');
assert(pair('山田 太郎', '太郎 山田').relation === 'normalized' && pair('山田 太郎', '太郎 山田').reason === '姓名の順序が異なる', 'reversed names stay unconfirmed');
assert(pair('山田 太郎', '山田太郎').reason === '空白の違い' && pair('山田 太郎', '山田　太郎').reason === '空白の違い', 'spaces do not confirm identity');
assert(pair('やまだ たろう', 'ヤマダ タロウ').reason === 'ひらがなとカタカナの違い', 'kana width stays unconfirmed');
const reading = pair('山田 太郎', '山田 たろう');
assert(reading.relation === 'similar' && reading.reason.indexOf('読みとしては確定しない') >= 0, 'kanji and kana stay a candidate, not a person');
assert(pair('山田 太郎', '佐藤 花子').relation === 'different', 'an unrelated name is not a candidate');

function session(now) {
  return Core.createSession(function () { return now || NOW; });
}
function person(id, family, given) {
  return {
    driverPersonId: id,
    driverName: family + ' ' + given,
    driverLastName: family,
    driverFirstName: given,
    reservations: [{ date: DAY, daPersonId: id, startTimeInMinutes: 9 * 60, startTimeInEpoch: START, status: 'ASSIGNED' }]
  };
}
function master(id, key, japanese) {
  return { name: key, japaneseName: japanese, transportId: id, department: 'GDSダイレクト' };
}
function mentorRow(staff, driver, family, given, end) {
  return { driverId: driver, realStaffNumber: staff, firstName: given, lastName: family, shiftEndTime: end, vrmStatus: 'Active' };
}
function load(people, rows, entries, capturedAt) {
  const book = session();
  const iso = capturedAt || FRESH;
  book.ingestScheduling({ ok: true, capturedAt: iso, fromDate: '2026-10-13', people: people });
  book.ingestMentor(Core.mentorDigest({ data: rows }, iso, URL));
  book.ingestMaster({ ok: true, phase: 'ready', loadedAt: NOW.getTime(), entries: entries });
  return book;
}
function rowOf(view, name) {
  return (view.rows || []).filter(function (row) { return row.schedulingName === name; })[0];
}
function attention(counts) {
  return (counts.activeUnseen || 0) + (counts.after5Unmatched || 0) + (counts.unknownTime || 0);
}

const sched = 'S1YAMAD45NAME01';
const staff = 'M1YAMAD45NAME01';
const driver = 'D1YAMAD45NAME01';
const otherSched = 'S2SATOH45NAME01';
const otherStaff = 'M2SATOH45NAME01';
const otherDriver = 'D2SATOH45NAME01';
const book = load(
  [person(sched, '山田', '太郎'), person(otherSched, '佐藤', '花子')],
  [mentorRow(staff, driver, '山田', '太郎', 'N/A'), mentorRow(otherStaff, otherDriver, '佐藤', '花子', 'N/A')],
  [master(sched, '山田キー', '山田 太郎'), master(otherSched, '佐藤キー', '佐藤 花子')]
);
const before = book.suspectView(DAY, true);
const yamada = rowOf(before, '山田 太郎');
const sato = rowOf(before, '佐藤 花子');
assert(yamada.status === 'Mentor未起動疑い（要確認）' && yamada.nameCandidates.length === 1, 'a different mentor id stays a suspect with one exact candidate');
assert(yamada.nameCandidates[0].mentorName === '山田 太郎' && yamada.nameCandidates[0].identity === false && yamada.nameCandidates[0].adminState === '未確認', 'the exact mentor name is only a candidate');
assert(yamada.matchBasis === '' && before.counts.suspect === 2 && before.identityProven === false, 'a name candidate does not change the four classes');
const rollBefore = JSON.stringify(book.rollCallView(DAY, false).counts);
assert(attention(book.rollCallView(DAY, false).counts) === book.rollCallView(DAY, false).counts.activeUnseen + book.rollCallView(DAY, false).counts.after5Unmatched + book.rollCallView(DAY, false).counts.unknownTime, 'roll attention uses the existing formula');

const dupBook = load(
  [person(sched, '山田', '太郎')],
  [mentorRow(staff, driver, '山田', '太郎', 'N/A'), mentorRow('M3YAMAD45NAME01', 'D3YAMAD45NAME01', '山田', '太郎', 'N/A')],
  [master(sched, '山田キー', '山田 太郎')]
);
const dup = rowOf(dupBook.suspectView(DAY, true), '山田 太郎');
assert(dup.nameCandidates.length === 2 && dup.nameCandidates.every(function (item) { return item.reason.indexOf('複数') >= 0 && item.identity === false; }), 'two identical mentor names require an admin');
assert(dup.status === 'Mentor未起動疑い（要確認）', 'duplicate names do not become active');

const clash = load(
  [person(sched, '山田', '太郎'), person(sched, '山田', '次郎')],
  [mentorRow(staff, driver, '山田', '太郎', 'N/A')],
  [master(sched, '山田キー', '山田 太郎')]
);
const clashView = clash.suspectView(DAY, true);
assert(clashView.rows.length === 1 && clashView.rows[0].status === '判定不能（原因付き）' && clashView.rows[0].cause === 'ID重複・競合', 'an id conflict stays undetermined');
assert(clashView.rows[0].nameCandidates.length === 0 && clashView.counts.active === 0, 'an id conflict is not resolved by a similar name');

const held = book.setIdentityLink(DAY, yamada.rowIndex, 0, 'held', before.identityGeneration);
assert(held.ok === true && rowOf(held.suspect, '山田 太郎').status === 'Mentor未起動疑い（要確認）', 'holding a candidate does not confirm startup');
assert(rowOf(held.suspect, '山田 太郎').nameCandidates[0].adminState === '保留', 'a held candidate stays distinct from a confirmed link');

const excluded = book.setIdentityLink(DAY, yamada.rowIndex, 0, 'excluded', held.suspect.identityGeneration);
assert(excluded.ok === true && rowOf(excluded.suspect, '山田 太郎').nameCandidates[0].adminState === '別人として除外', 'an admin can exclude a different person');
assert(rowOf(excluded.suspect, '山田 太郎').status === 'Mentor未起動疑い（要確認）' && excluded.suspect.counts.suspect === 2, 'exclusion does not change the class counts');

const linked = book.setIdentityLink(DAY, yamada.rowIndex, 0, 'linked', excluded.suspect.identityGeneration);
assert(linked.ok === true, 'an admin can register the pair: ' + linked.message);
const linkedRow = rowOf(linked.suspect, '山田 太郎');
assert(linkedRow.status === '現在Active確認候補' && linkedRow.matchBasis === 'Active確認候補｜管理者確認済みID対応', 'a saved link plus one current active row can enter the existing active class');
assert(linkedRow.matchBasis.indexOf('本人確認') < 0 && linked.suspect.identityProven === false, 'the basis does not claim identity or roll-call completion');
assert(linked.suspect.counts.suspect === 1 && linked.suspect.counts.active === 1, 'only the linked person leaves the suspect count');
assert(JSON.stringify(book.rollCallView(DAY, false).counts) === rollBefore, 'the roll-call counts stay on the old formula');
assert(book.rollCallView(DAY, true).rows.every(function (row) { return row.confirmation !== '確認済み'; }), 'a mentor link does not mark the existing confirmation flow');

const pairBook = load(
  [person(sched, '山田', '太郎'), {
    driverPersonId: 'S3YAMAD45NAME02',
    driverName: '太郎 山田',
    driverLastName: '山田',
    driverFirstName: '太郎',
    reservations: [{ date: DAY, daPersonId: 'S3YAMAD45NAME02', startTimeInMinutes: 9 * 60, startTimeInEpoch: START, status: 'ASSIGNED' }]
  }],
  [mentorRow(staff, driver, '山田', '太郎', 'N/A')],
  [master(sched, '山田キー', '山田 太郎'), master('S3YAMAD45NAME02', '山田次キー', '太郎 山田')]
);
const pairView = pairBook.suspectView(DAY, true);
assert(pairView.rows.length === 2 && pairView.rows.every(function (row) { return row.nameCandidates.length === 1 && row.status === 'Mentor未起動疑い（要確認）'; }), 'two scheduling people can see the same mentor name');
const first = pairBook.setIdentityLink(DAY, pairView.rows[0].rowIndex, 0, 'linked', pairView.identityGeneration);
assert(first.ok === true && first.suspect.counts.active === 1 && first.suspect.counts.suspect === 1, 'the first admin link uses the one active row');
const pending = first.suspect.rows.filter(function (row) { return row.matchBasis === ''; })[0];
const second = pairBook.setIdentityLink(DAY, pending.rowIndex, 0, 'linked', first.suspect.identityGeneration);
assert(second.ok === false && second.message.indexOf('複数') >= 0, 'the same mentor id cannot be linked to a second person');
assert(second.suspect.counts.active === 1 && second.suspect.counts.suspect === 1, 'a rejected link leaves the classes unchanged');

const saved = book.exportIdentityLinks();
const reloaded = load(
  [person(sched, '山田', '太郎'), person(otherSched, '佐藤', '花子')],
  [mentorRow(staff, driver, '山田', '太郎', 'N/A'), mentorRow(otherStaff, otherDriver, '佐藤', '花子', 'N/A')],
  [master(sched, '山田キー', '山田 太郎'), master(otherSched, '佐藤キー', '佐藤 花子')]
);
reloaded.loadIdentityLinks(saved);
const restored = reloaded.suspectView(DAY, true);
assert(rowOf(restored, '山田 太郎').matchBasis === 'Active確認候補｜管理者確認済みID対応', 'a reloaded link still needs the current active row');
assert(JSON.stringify(restored).indexOf(sched) < 0 && JSON.stringify(restored).indexOf(staff) < 0 && JSON.stringify(restored).indexOf(driver) < 0, 'the open view does not publish raw ids');

const cleared = reloaded.clearIdentityLink(DAY, rowOf(restored, '山田 太郎').rowIndex, restored.identityGeneration);
assert(cleared.ok === true && rowOf(cleared.suspect, '山田 太郎').status === 'Mentor未起動疑い（要確認）' && rowOf(cleared.suspect, '山田 太郎').matchBasis === '', 'clearing the link restores the previous class');
assert(reloaded.exportIdentityLinks().length === 0, 'clear removes the stored pair');

const ended = load(
  [person(sched, '山田', '太郎')],
  [mentorRow(staff, driver, '山田', '太郎', Date.UTC(2026, 9, 14, 1, 0, 0))],
  [master(sched, '山田キー', '山田 太郎')]
);
const endedBefore = ended.suspectView(DAY, true);
const endedSave = ended.setIdentityLink(DAY, rowOf(endedBefore, '山田 太郎').rowIndex, 0, 'linked', endedBefore.identityGeneration);
assert(endedSave.ok === true && rowOf(endedSave.suspect, '山田 太郎').status === 'Mentor未起動疑い（要確認）' && rowOf(endedSave.suspect, '山田 太郎').matchBasis === '', 'a same-day end without a current active row does not become active');
assert(rowOf(endedSave.suspect, '山田 太郎').nameCandidates[0].mentorState === '当日終了履歴あり（参考）', 'the ended row stays reference information');

const staleIso = new Date(NOW.getTime() - 16 * 60000).toISOString();
const stale = load([person(sched, '山田', '太郎')], [mentorRow(staff, driver, '山田', '太郎', 'N/A')], [master(sched, '山田キー', '山田 太郎')], staleIso);
const staleView = stale.suspectView(DAY, true);
assert(staleView.reason === '15分超過' && staleView.counts.suspect === 0 && staleView.rows.length === 0, 'stale data does not classify or show names');
assert(JSON.stringify(staleView).indexOf('山田 太郎') < 0, 'stale data hides names');
const staleSave = stale.setIdentityLink(DAY, 0, 0, 'linked', staleView.identityGeneration);
assert(staleSave.ok === false && JSON.stringify(staleSave.suspect).indexOf('山田 太郎') < 0, 'stale data cannot be registered');

const failed = session();
failed.ingestScheduling({ ok: true, capturedAt: FRESH, fromDate: '2026-10-13', people: [person(sched, '山田', '太郎')] });
failed.ingestMentor({ ok: false, issue: 'FAILED', capturedAt: FRESH });
failed.ingestMaster({ ok: true, phase: 'ready', loadedAt: NOW.getTime(), entries: [master(sched, '山田キー', '山田 太郎')] });
const failedView = failed.suspectView(DAY, true);
assert(failedView.counts.suspect === 0 && failedView.rows.length === 0 && JSON.stringify(failedView).indexOf('山田 太郎') < 0, 'a mentor failure shows no class and no name');

const hiddenBook = load(
  [person(sched, '山田', '太郎'), person(otherSched, '佐藤', '花子')],
  [mentorRow(staff, driver, '山田', '太郎', 'N/A'), mentorRow(otherStaff, otherDriver, '佐藤', '花子', 'N/A')],
  [master(sched, '山田キー', '山田 太郎'), master(otherSched, '佐藤キー', '佐藤 花子')]
);
const closed = hiddenBook.suspectView(DAY, false);
assert(closed.rows.length === 0 && closed.counts.suspect === 2 && JSON.stringify(closed).indexOf('山田') < 0, 'closing the list drops names and keeps the unlinked counts');

const background = read('cortex-capture-extension/background.js');
const handler = background.slice(background.indexOf('function handleIdDiag'), background.indexOf('function resolveOfk3BaseUrl'));
assert(handler.indexOf('fetch(') < 0 && handler.indexOf('chrome.storage') < 0 && handler.indexOf('/mentor-active/import') < 0, 'the diagnostic handler still does not send');
const storageFns = background.slice(background.indexOf('function ensureIdentityLinks'), background.indexOf('chrome.action.onClicked'));
assert(storageFns.indexOf('ofk3MentorIdentityLinks') > 0 && storageFns.indexOf('chrome.storage.local') > 0 && storageFns.indexOf('localStorage') < 0 && storageFns.indexOf('fetch(') < 0, 'links use the existing extension storage and do not send');
const panel = read('cortex-capture-extension/id-diag-panel.js');
assert(panel.indexOf('Mentor登録名の候補あり') > 0 && panel.indexOf('同一人物の可能性があります。確認しますか？') > 0 && panel.indexOf(IDENTITY_TEXT()) > 0 && panel.indexOf('fetch(') < 0 && panel.indexOf('未起動確定') < 0, 'the panel asks before saving and does not declare a missed start');
function IDENTITY_TEXT() { return '氏名の類似だけでは本人確認になりません。管理者が別の本人情報を確認した場合のみ登録してください。'; }

function panelElement(tag) {
  var node = { tag: tag, id: '', style: {}, children: [], parentElement: null, parentNode: null, _text: '', hidden: false, value: '', listeners: {} };
  Object.defineProperty(node, 'textContent', {
    get: function () { return node.children.length ? node.children.map(function (child) { return child.textContent; }).join('') : node._text; },
    set: function (value) { node._text = value == null ? '' : String(value); node.children = []; }
  });
  node.appendChild = function (child) { child.parentElement = node; child.parentNode = node; node.children.push(child); return child; };
  node.insertBefore = function (child, ref) {
    child.parentElement = node; child.parentNode = node;
    var at = node.children.indexOf(ref);
    if (at < 0) node.children.push(child); else node.children.splice(at, 0, child);
    return child;
  };
  node.addEventListener = function (type, fn) { node.listeners[type] = node.listeners[type] || []; node.listeners[type].push(fn); };
  node.querySelector = function (sel) {
    return findNode(node, function (child) { return sel.charAt(0) === '#' ? child.id === sel.slice(1) : child.tag === sel; });
  };
  node.getBoundingClientRect = function () { return { top: 0, bottom: 20, left: 0, right: 20, width: 20, height: 20 }; };
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
const win = {
  location: { hostname: 'vrm-mentor.edriving.com', origin: 'https://vrm-mentor.edriving.com' },
  listeners: {},
  posts: [],
  confirms: 0,
  confirmResult: false,
  confirm: function () { win.confirms += 1; return win.confirmResult; },
  OFK3IdDiag: { panelLines: function () { return ['ID照合診断（調査用）']; }, copyPayload: function () { return '{}'; } },
  addEventListener: function (type, fn) { win.listeners[type] = win.listeners[type] || []; win.listeners[type].push(fn); },
  postMessage: function (data) {
    win.posts.push(data);
    var source = win.__panelGlobal || win;
    (win.listeners.message || []).slice().forEach(function (fn) { fn({ source: source, data: data }); });
  },
  setInterval: function () { return 1; },
  clearInterval: function () {}
};
win.document = {
  createElement: panelElement,
  getElementById: function (id) { return id === 'ofk3-mentor-capture-v0' ? host : findNode(host, function (child) { return child.id === id; }); }
};
const host = panelElement('div');
host.id = 'ofk3-mentor-capture-v0';
const shadow = panelElement('div');
shadow.getElementById = function (id) { return findNode(shadow, function (child) { return child.id === id; }); };
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
vm.runInNewContext('this.__panelGlobal = typeof window !== "undefined" ? window : globalThis;\n' + read('cortex-capture-extension/id-diag-panel.js'), win, { filename: 'id-diag-panel.js' });
win.postMessage({
  source: 'OFK3_ID_DIAG',
  type: 'suspect-view',
  token: win.posts.filter(function (item) { return item.type === 'id-diag-suspect'; }).slice(-1)[0].token,
  suspect: {
    enabled: true,
    date: DAY,
    namesShown: true,
    identityGeneration: 3,
    identityProven: false,
    counts: { total: 1, active: 0, ended: 0, suspect: 1, undetermined: 0 },
    rows: [{
      rowIndex: 0,
      status: 'Mentor未起動疑い（要確認）',
      schedulingName: '山田 太郎',
      department: 'GDSダイレクト',
      startLabel: '09:00:00（開始予定）',
      elapsed: '経過 120分',
      mentorText: '該当行なし',
      matchBasis: '',
      linkNote: '',
      nameCandidates: [{
        mentorName: '太郎 山田',
        reason: '姓名の順序が異なる',
        mentorState: '現在Active',
        adminState: '未確認',
        canSave: true,
        saveBlock: '',
        relation: 'normalized',
        identity: false,
        candidateIndex: 0
      }]
    }]
  }
});
const people = shadow.getElementById('ofk3-ops-people');
assert(people.textContent.indexOf('Mentor登録名の候補あり') >= 0 && people.textContent.indexOf('同一人物の可能性があります。確認しますか？') >= 0 && people.textContent.indexOf('Active観測状況:') >= 0, 'a suspect row shows the mentor name candidate and the confirmation question');
const buttons = [];
(function walk(node) {
  if (node._text === '同一人物として対応登録') buttons.push(node);
  node.children.forEach(walk);
})(people);
assert(buttons.length === 1, 'the register control is present');
(buttons[0].listeners.click || []).forEach(function (fn) { fn(); });
assert(win.confirms === 1 && win.posts.filter(function (item) { return item.type === 'id-diag-identity-set'; }).length === 0, 'cancelling the warning does not register');
win.confirmResult = true;
(buttons[0].listeners.click || []).forEach(function (fn) { fn(); });
const posted = win.posts.filter(function (item) { return item.type === 'id-diag-identity-set'; }).slice(-1)[0];
assert(posted && posted.action === 'linked' && posted.generation === 3 && posted.rowIndex === 0 && posted.candidateIndex === 0, 'accepting the warning registers the selected candidate');

function sources(people, rows, entries, capturedAt) {
  const book = session();
  const iso = capturedAt || FRESH;
  book.ingestScheduling({ ok: true, capturedAt: iso, fromDate: '2026-10-13', people: people });
  book.ingestMentor(Core.mentorDigest({ data: rows }, iso, URL));
  if (entries) book.ingestMaster({ ok: true, phase: 'ready', loadedAt: NOW.getTime(), entries: entries });
  return book;
}
function signature(view) {
  return (view.rows || []).map(function (row) {
    return [row.schedulingName, row.status, row.cause || '', (row.nameCandidates || []).length].join('|');
  }).sort().join('\n');
}
const activePeople = [person(sched, '山田', '太郎'), person(otherSched, '佐藤', '花子')];
const activeRows = [mentorRow(sched, driver, '山田', '太郎', 'N/A'), mentorRow(otherSched, otherDriver, '佐藤', '花子', Date.UTC(2026, 9, 14, 1, 0, 0))];
const withMaster = sources(activePeople, activeRows, [master(sched, '山田キー', '山田 太郎'), master(otherSched, '佐藤キー', '佐藤 花子')]);
const withoutMaster = sources(activePeople, activeRows, null);
const withView = withMaster.suspectView(DAY, true);
const withoutView = withoutMaster.suspectView(DAY, true);
assert(withoutView.enabled === true && withoutView.reason === '' && signature(withView) === signature(withoutView), 'scheduling and mentor classify the same way when the master is absent');
assert(rowOf(withView, '山田 太郎').status === '現在Active確認候補' && rowOf(withView, '山田 太郎').department === 'GDSダイレクト', 'a fresh master still supplies the department');
assert(rowOf(withoutView, '山田 太郎').schedulingName === '山田 太郎' && rowOf(withoutView, '山田 太郎').department === '表示保留', 'without a master the official name stays and the department is withheld');
assert(rowOf(withoutView, '佐藤 花子').status === '当日終了履歴あり（参考）', 'a same-day end without a current active row stays a reference');
const pairRollBefore = JSON.stringify(withMaster.rollCallView(DAY, false).counts);
withMaster.suspectView(DAY, true);
const pairRollAfter = withMaster.rollCallView(DAY, false);
assert(pairRollBefore === JSON.stringify(pairRollAfter.counts) && attention(pairRollAfter.counts) === pairRollAfter.counts.activeUnseen + pairRollAfter.counts.after5Unmatched + pairRollAfter.counts.unknownTime, 'the two-source list does not change the roll-call formula');
const bareRoll = withoutMaster.rollCallView(DAY, false);
assert(bareRoll.enabled === false && bareRoll.counts.total === 0 && attention(bareRoll.counts) === 0, 'the roll call still waits for the master');

const reversedPeople = [person(sched, '山田', '太郎')];
const reversedRows = [mentorRow(staff, driver, '太郎', '山田', 'N/A')];
const reversedBare = sources(reversedPeople, reversedRows, null);
const reversedMaster = sources(reversedPeople, reversedRows, [master(sched, '山田キー', '山田 太郎')]);
const reversedBefore = reversedBare.suspectView(DAY, true);
assert(signature(reversedBefore) === signature(reversedMaster.suspectView(DAY, true)), 'a reversed mentor name has the same class with or without a master');
assert(reversedBefore.counts.active === 0 && reversedBefore.counts.suspect === 1 && reversedBefore.rows[0].nameCandidates.length === 1 && reversedBefore.rows[0].nameCandidates[0].reason === '姓名の順序が異なる' && reversedBefore.rows[0].nameCandidates[0].identity === false, 'a reversed name is only a candidate before confirmation');
const reversedHeld = reversedBare.setIdentityLink(DAY, reversedBefore.rows[0].rowIndex, 0, 'held', reversedBefore.identityGeneration);
assert(reversedHeld.ok === true && reversedHeld.suspect.counts.active === 0 && reversedHeld.suspect.counts.suspect === 1, 'holding a candidate does not make the person active');
const reversedLinked = reversedBare.setIdentityLink(DAY, reversedHeld.suspect.rows[0].rowIndex, 0, 'linked', reversedHeld.suspect.identityGeneration);
assert(reversedLinked.ok === true && reversedLinked.suspect.counts.active === 1 && reversedLinked.suspect.rows[0].matchBasis === 'Active確認候補｜管理者確認済みID対応', 'an admin link plus one current active row can become an active candidate without a master');
const pairRemembered = sources(reversedPeople, reversedRows, null);
pairRemembered.loadIdentityLinks(reversedBare.exportIdentityLinks());
const pairRememberedView = pairRemembered.suspectView(DAY, true);
assert(pairRememberedView.counts.active === 1 && pairRememberedView.rows[0].matchBasis === 'Active確認候補｜管理者確認済みID対応', 'a saved link is reused on the next read without a master');
const pairCleared = pairRemembered.clearIdentityLink(DAY, pairRememberedView.rows[0].rowIndex, pairRememberedView.identityGeneration);
assert(pairCleared.ok === true && pairCleared.suspect.counts.active === 0 && pairCleared.suspect.counts.suspect === 1 && pairCleared.suspect.rows[0].matchBasis === '', 'clearing the link returns the unconfirmed class');
const pairExcluded = pairRemembered.setIdentityLink(DAY, pairCleared.suspect.rows[0].rowIndex, 0, 'excluded', pairCleared.suspect.identityGeneration);
assert(pairExcluded.ok === true && pairExcluded.suspect.counts.active === 0 && pairExcluded.suspect.rows[0].nameCandidates[0].adminState === '別人として除外', 'excluding a candidate keeps the person out of the active class');

const twins = sources(
  [person(sched, '山田', '太郎')],
  [mentorRow(staff, driver, '山田', '太郎', 'N/A'), mentorRow(otherStaff, otherDriver, '山田', '太郎', 'N/A')],
  null
);
const twinView = twins.suspectView(DAY, true);
assert(twinView.counts.active === 0 && twinView.counts.suspect === 1 && twinView.rows[0].nameCandidates.length === 2 && twinView.rows[0].nameCandidates.every(function (item) { return item.identity === false && item.reason.indexOf('複数') >= 0; }), 'two identical mentor names stay candidates');
const clashPeople = [
  person(sched, '山田', '太郎'),
  { driverPersonId: sched, driverName: '山田 次郎', driverLastName: '山田', driverFirstName: '次郎', reservations: [{ date: DAY, daPersonId: sched, startTimeInMinutes: 9 * 60, startTimeInEpoch: START, status: 'ASSIGNED' }] }
];
const clashBare = sources(clashPeople, [mentorRow(sched, driver, '山田', '太郎', 'N/A')], null);
const clashMaster = sources(clashPeople, [mentorRow(sched, driver, '山田', '太郎', 'N/A')], [master(sched, '山田キー', '山田 太郎')]);
const clashBareView = clashBare.suspectView(DAY, true);
assert(signature(clashBareView) === signature(clashMaster.suspectView(DAY, true)), 'an id conflict has the same class with or without a master');
assert(clashBareView.counts.undetermined === 1 && clashBareView.rows[0].cause === 'ID重複・競合' && clashBareView.rows[0].nameCandidates.length === 0 && clashBareView.counts.active === 0, 'an id conflict is not resolved by an active mentor row or by a name');

const quiet = sources([person(sched, '山田', '太郎')], [], null);
const quietView = quiet.suspectView(DAY, true);
assert(quietView.counts.suspect === 1 && quietView.counts.active === 0 && quietView.rows[0].status === 'Mentor未起動疑い（要確認）', 'no mentor row stays a suspect and is not called inactive');
const staleBare = sources([person(sched, '山田', '太郎')], [mentorRow(sched, driver, '山田', '太郎', 'N/A')], null, new Date(NOW.getTime() - 16 * 60000).toISOString());
const staleBareView = staleBare.suspectView(DAY, true);
assert(staleBareView.reason === '15分超過' && staleBareView.rows.length === 0 && staleBareView.counts.suspect === 0 && JSON.stringify(staleBareView).indexOf('山田') < 0, 'stale scheduling and mentor data withhold the name without a master');
const failedBare = session();
failedBare.ingestScheduling({ ok: true, capturedAt: FRESH, fromDate: '2026-10-13', people: [person(sched, '山田', '太郎')] });
failedBare.ingestMentor({ ok: false, capturedAt: FRESH });
const failedBareView = failedBare.suspectView(DAY, true);
assert(failedBareView.rows.length === 0 && failedBareView.counts.suspect === 0 && JSON.stringify(failedBareView).indexOf('山田') < 0, 'a mentor failure shows no name when the master is also absent');

const absentSources = session().suspectView(DAY, true);
assert(absentSources.sources.scheduling === 'missing' && absentSources.sources.mentor === 'missing' && absentSources.rows.length === 0 && absentSources.counts.total === 0, 'both sources start missing and produce no class');
const schedulingOnly = session();
schedulingOnly.ingestScheduling({ ok: true, capturedAt: FRESH, fromDate: '2026-10-13', people: [person(sched, '山田', '太郎')] });
const schedulingOnlyView = schedulingOnly.suspectView(DAY, true);
assert(schedulingOnlyView.sources.scheduling === 'ready' && schedulingOnlyView.sources.mentor === 'missing' && schedulingOnlyView.reason === 'データ未取得' && schedulingOnlyView.rows.length === 0 && JSON.stringify(schedulingOnlyView.rows).indexOf('山田') < 0, 'mentor data is required before a class or a name is published');
const schedulingFailed = session();
schedulingFailed.ingestScheduling({ ok: false, capturedAt: FRESH });
schedulingFailed.ingestMentor(Core.mentorDigest({ data: [mentorRow(sched, driver, '山田', '太郎', 'N/A')] }, FRESH, URL));
const schedulingFailedView = schedulingFailed.suspectView(DAY, true);
assert(schedulingFailedView.sources.scheduling === 'failed' && schedulingFailedView.sources.mentor === 'ready' && schedulingFailedView.rows.length === 0 && schedulingFailedView.counts.active === 0, 'a scheduling failure stays distinct and does not inherit the mentor active row');
const schedulingStale = sources([person(sched, '山田', '太郎')], [mentorRow(sched, driver, '山田', '太郎', 'N/A')], null, new Date(NOW.getTime() - 16 * 60000).toISOString());
const schedulingStaleView = schedulingStale.suspectView(DAY, true);
assert(schedulingStaleView.sources.scheduling === 'stale' && schedulingStaleView.sources.mentor === 'stale' && schedulingStaleView.reason === '15分超過' && schedulingStaleView.rows.length === 0, 'stale captures are marked separately from a missing capture');
const readySources = sources([person(sched, '山田', '太郎')], [mentorRow(sched, driver, '山田', '太郎', 'N/A')], null).suspectView(DAY, true);
assert(readySources.sources.scheduling === 'ready' && readySources.sources.mentor === 'ready' && readySources.reason === '' && readySources.counts.active === 1, 'fresh scheduling and mentor data leave the warning path');

function timedPerson(epoch) {
  return {
    driverPersonId: sched,
    driverName: '山田 太郎',
    driverLastName: '山田',
    driverFirstName: '太郎',
    reservations: [{ date: DAY, daPersonId: sched, startTimeInMinutes: 9 * 60, startTimeInEpoch: epoch, status: 'ASSIGNED' }]
  };
}
assert(sources([timedPerson(NOW.getTime() + 60000)], [], null).suspectView(DAY, true).counts.total === 0, 'a start in the future stays out of the four classes');
const justAfter = sources([timedPerson(NOW.getTime() - 1000)], [], null).suspectView(DAY, true);
assert(justAfter.counts.total === 1 && justAfter.counts.suspect === 1 && justAfter.counts.active === 0, 'one second after the start is a suspect when no mentor row exists');
const longAfter = sources([timedPerson(NOW.getTime() - 3 * 3600000)], [], null).suspectView(DAY, true);
assert(longAfter.counts.suspect === 1 && longAfter.rows[0].status === 'Mentor未起動疑い（要確認）', 'more elapsed time does not turn a missing mentor row into an active candidate');
const longActive = sources([timedPerson(NOW.getTime() - 3 * 3600000)], [mentorRow(sched, driver, '山田', '太郎', 'N/A')], null).suspectView(DAY, true);
assert(longActive.counts.active === 1 && longActive.rows[0].status === '現在Active確認候補', 'a later clock still requires the current active observation');

const movedFrom = sources([person(sched, '山田', '太郎')], [mentorRow(staff, driver, '太郎', '山田', 'N/A')], null);
const movedBefore = movedFrom.suspectView(DAY, true);
const movedLink = movedFrom.setIdentityLink(DAY, movedBefore.rows[0].rowIndex, 0, 'linked', movedBefore.identityGeneration);
assert(movedLink.ok === true && movedLink.suspect.counts.active === 1, 'the saved link can classify the original mentor id');
const movedTo = sources([person(sched, '山田', '太郎')], [mentorRow('M9OTHER45NAME01', 'D9OTHER45NAME01', '太郎', '山田', 'N/A')], null);
movedTo.loadIdentityLinks(movedFrom.exportIdentityLinks());
const movedView = movedTo.suspectView(DAY, true);
assert(movedView.counts.active === 0 && movedView.counts.suspect === 1 && movedView.rows[0].linkNote === '識別子の変更を検出', 'a saved link does not follow a different mentor id');

console.log('mentor-identity-match: ok');
