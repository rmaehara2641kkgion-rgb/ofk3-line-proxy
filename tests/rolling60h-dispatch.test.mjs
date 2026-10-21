import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../rolling60h-core.js');
const Dispatch = require('../rolling60h-dispatch.js').bindCore(Core);

function block(hours, source) {
  return [{ code: 'H', rawCode: String(hours), source: source, hours: hours, defined: true }];
}
function blank() {
  return [{ code: 'BLANK', rawCode: '', source: 'roster', hours: null, defined: false, blank: true }];
}
function fill(start, count, hours, source) {
  const map = {};
  for (let i = 0; i < count; i += 1) map[Core.addDays(start, i)] = block(hours, source);
  return map;
}
function driver(extra) {
  return Object.assign({
    transportId: 'TID-FICTION',
    name: '架空太郎',
    actualBlocksByDate: {},
    rosterBlocksByDate: {},
  }, extra);
}
function texts(plan, scope) {
  return plan.speak.filter((item) => item.scope === scope).map((item) => item.text);
}

const today = '2026-10-22';
const shared = fill('2026-10-16', 7, 10, 'actual');
const roster = { '2026-10-23': block(4, 'roster') };
const windows = Dispatch.assess({
  today: today,
  drivers: [driver({ actualBlocksByDate: shared, rosterBlocksByDate: roster })],
});
assert.equal(windows.ok, true);
assert.equal(windows.today, '2026-10-22');
assert.equal(windows.tomorrow, '2026-10-23');
assert.equal(windows.drivers[0].today.startDate, '2026-10-16');
assert.equal(windows.drivers[0].today.endDate, '2026-10-22');
assert.equal(windows.drivers[0].tomorrow.startDate, '2026-10-17');
assert.equal(windows.drivers[0].tomorrow.endDate, '2026-10-23');
assert.equal(windows.drivers[0].today.totalHours, 70);
assert.equal(windows.drivers[0].tomorrow.totalHours, 64);
assert.equal(windows.drivers[0].droppedDate, '2026-10-16');
assert.equal(windows.drivers[0].droppedHours, 10);
assert.equal(windows.drivers[0].addedHours, 4);

const month = Dispatch.assess({
  today: '2026-03-01',
  drivers: [driver({ actualBlocksByDate: {}, rosterBlocksByDate: {} })],
});
assert.equal(month.drivers[0].today.startDate, '2026-02-23');
assert.equal(month.drivers[0].tomorrow.startDate, '2026-02-24');
assert.equal(month.drivers[0].tomorrow.endDate, '2026-03-02');
assert.equal(month.drivers[0].today.status, 'missing');
assert.equal(month.safe, false);
assert.equal(month.todayDanger.length, 0);

const actual = fill('2026-10-16', 6, 8, 'actual');
actual['2026-10-22'] = block(4, 'actual');
const both = { '2026-10-22': block(9, 'roster'), '2026-10-23': block(10, 'roster') };
const beforeActual = JSON.stringify(actual);
const beforeRoster = JSON.stringify(both);
const picked = Dispatch.assess({
  today: today,
  drivers: [driver({ actualBlocksByDate: actual, rosterBlocksByDate: both, todayHoursOverride: 1 })],
});
assert.equal(JSON.stringify(actual), beforeActual);
assert.equal(JSON.stringify(both), beforeRoster);
assert.equal(picked.drivers[0].countedTodayHours, 4);
assert.equal(picked.drivers[0].countedTodayOrigin, 'actual');
assert.equal(picked.drivers[0].todayOrigin, 'roster');
assert.equal(picked.drivers[0].today.origin, 'roster');
assert.equal(picked.drivers[0].today.totalHours, 57);
assert.notEqual(picked.drivers[0].today.totalHours, 61);
assert.equal(picked.drivers[0].tomorrow.totalHours, 54);
assert.equal(picked.drivers[0].simulationStatus, 'applied');
assert.equal(picked.drivers[0].tomorrow.totalHours, picked.drivers[0].tomorrow.totalHours);
assert.notEqual(picked.drivers[0].simulatedTomorrow.totalHours, picked.drivers[0].tomorrow.totalHours);

const onlyRoster = Dispatch.assess({
  today: today,
  drivers: [driver({
    actualBlocksByDate: fill('2026-10-16', 6, 8, 'actual'),
    rosterBlocksByDate: { '2026-10-22': block(9, 'roster'), '2026-10-23': block(0, 'roster') },
  })],
});
assert.equal(onlyRoster.drivers[0].todayOrigin, 'roster');
assert.equal(onlyRoster.drivers[0].countedTodayHours, 9);

const avoidActual = fill('2026-10-16', 6, 9, 'actual');
avoidActual['2026-10-22'] = block(10, 'actual');
const avoid = Dispatch.assess({
  today: today,
  drivers: [driver({
    actualBlocksByDate: avoidActual,
    rosterBlocksByDate: { '2026-10-23': block(10, 'roster') },
    todayHoursOverride: 5,
  })],
});
const avoidRow = avoid.drivers[0];
assert.equal(avoidRow.tomorrow.totalHours, 65);
assert.equal(avoidRow.avoidable, true);
assert.equal(avoidRow.requiredCutHours, 5);
assert.equal(avoidRow.simulatedTomorrow.totalHours, 60);
assert.equal(avoidRow.simulatedTomorrow.status, 'approach');
assert.equal(avoid.todayDanger.length, 1);
assert.equal(avoid.tomorrowDanger.length, 1);
assert.equal(avoid.adjustable.length, 1);
assert.equal(avoid.adjustable[0].transportId, 'TID-FICTION');

const stuckActual = fill('2026-10-17', 5, 10, 'actual');
stuckActual['2026-10-16'] = block(10, 'actual');
stuckActual['2026-10-22'] = block(8, 'actual');
const stuck = Dispatch.assess({
  today: today,
  drivers: [driver({
    name: '架空花子',
    transportId: 'TID-STUCK',
    actualBlocksByDate: stuckActual,
    rosterBlocksByDate: { '2026-10-23': block(12, 'roster') },
    todayHoursOverride: 0,
  })],
});
assert.equal(stuck.drivers[0].tomorrow.totalHours, 70);
assert.equal(stuck.drivers[0].avoidable, false);
assert.equal(stuck.drivers[0].avoidReason, 'today-shortening-insufficient');
assert.equal(stuck.drivers[0].residualHours, 2);
assert.equal(stuck.drivers[0].simulatedTomorrow.totalHours, 62);
assert.equal(stuck.drivers[0].simulatedTomorrow.status, 'exceed');
assert.equal(stuck.adjustable.length, 0);
assert.equal(stuck.tomorrowDanger.length, 1);

const openActual = fill('2026-10-16', 6, 11, 'actual');
const open = Dispatch.assess({
  today: today,
  drivers: [driver({
    actualBlocksByDate: openActual,
    rosterBlocksByDate: { '2026-10-22': blank(), '2026-10-23': block(0, 'roster') },
  })],
});
assert.equal(open.drivers[0].today.status, 'unconfirmed');
assert.equal(open.drivers[0].today.knownOver, true);
assert.equal(open.drivers[0].today.safe, false);
assert.equal(open.safe, false);
assert.equal(open.todayDanger.length, 0);
assert.equal(open.undetermined.length, 1);
assert.equal(open.drivers[0].today.remainingHours, null);

const failed = Dispatch.assess({ today: '2026/10/22', drivers: [] });
assert.equal(failed.ok, false);
assert.equal(failed.safe, false);
const failedSpeech = Dispatch.planSpeech(null, failed);
assert.match(failedSpeech.speak[0].text, /安全とは判断できません/);
assert.doesNotMatch(failedSpeech.speak[0].text, /以内/);
assert.equal(Dispatch.planSpeech(failedSpeech.state, failed).speak.length, 0);

const firstSpeech = Dispatch.planSpeech(null, avoid);
assert.match(texts(firstSpeech, 'today')[0], /今日のローリング60時間の緊急警告/);
assert.match(texts(firstSpeech, 'tomorrow')[0], /明日のローリング60時間の事前警告/);
assert.match(texts(firstSpeech, 'tomorrow')[0], /短縮すると回避できます/);
assert.notEqual(texts(firstSpeech, 'today')[0], texts(firstSpeech, 'tomorrow')[0]);
assert.equal(Dispatch.planSpeech(firstSpeech.state, avoid).speak.length, 0);

const stuckSpeech = Dispatch.planSpeech(null, stuck);
assert.match(texts(stuckSpeech, 'tomorrow')[0], /今日の短縮だけでは回避できません/);
assert.doesNotMatch(texts(stuckSpeech, 'tomorrow')[0], /短縮すると回避できます/);

const openSpeech = Dispatch.planSpeech(null, open);
assert.equal(openSpeech.speak[0].event, 'unavailable');
assert.match(openSpeech.speak[0].text, /安全とは判断できません/);
assert.doesNotMatch(openSpeech.speak.map((item) => item.text).join('\n'), /緊急警告|解消/);

const approachActual = fill('2026-10-16', 6, 10, 'actual');
approachActual['2026-10-22'] = block(0, 'actual');
const approach = Dispatch.assess({
  today: today,
  drivers: [driver({ actualBlocksByDate: approachActual, rosterBlocksByDate: { '2026-10-23': block(0, 'roster') } })],
});
assert.equal(approach.drivers[0].today.status, 'approach');
const approachSpeech = Dispatch.planSpeech(null, approach);
assert.match(texts(approachSpeech, 'today')[0], /接近しています/);
assert.doesNotMatch(texts(approachSpeech, 'today')[0], /緊急警告/);

const raisedActual = fill('2026-10-16', 6, 10, 'actual');
raisedActual['2026-10-22'] = block(5, 'actual');
const raised = Dispatch.assess({
  today: today,
  drivers: [driver({ actualBlocksByDate: raisedActual, rosterBlocksByDate: { '2026-10-23': block(0, 'roster') } })],
});
const raisedSpeech = Dispatch.planSpeech(approachSpeech.state, raised);
assert.equal(raisedSpeech.speak.find((item) => item.scope === 'today').event, 'severity-up');
assert.match(texts(raisedSpeech, 'today')[0], /緊急警告/);

const clearedActual = fill('2026-10-16', 6, 8, 'actual');
clearedActual['2026-10-22'] = block(0, 'actual');
const cleared = Dispatch.assess({
  today: today,
  drivers: [driver({ actualBlocksByDate: clearedActual, rosterBlocksByDate: { '2026-10-23': block(0, 'roster') } })],
});
const clearedSpeech = Dispatch.planSpeech(raisedSpeech.state, cleared);
assert.equal(clearedSpeech.speak.find((item) => item.scope === 'today').event, 'resolved');
assert.match(texts(clearedSpeech, 'today')[0], /解消/);
assert.doesNotMatch(texts(clearedSpeech, 'today')[0], /緊急警告/);

const lost = Dispatch.planSpeech(raisedSpeech.state, open);
assert.equal(lost.speak.find((item) => item.scope === 'today').event, 'unavailable');
assert.doesNotMatch(lost.speak.find((item) => item.scope === 'today').text, /解消/);

let spoken = [];
const delivered = await Dispatch.deliver(null, avoid, async (items) => {
  spoken = items;
  return false;
});
assert.equal(delivered.spoken, false);
assert.equal(delivered.reason, 'not-spoken');
const retry = await Dispatch.deliver(delivered.state, avoid, async () => true);
assert.equal(retry.reason, 'spoken');
assert.ok(retry.speak.length > 0);
const quiet = await Dispatch.deliver(retry.state, avoid, async () => true);
assert.equal(quiet.reason, 'unchanged');
assert.equal(quiet.speak.length, 0);
assert.ok(spoken.length > 0);

const ui = fs.readFileSync(new URL('../rolling60h-dispatch-ui.js', import.meta.url), 'utf8');
const alerts = fs.readFileSync(new URL('../friday/rolling60h-dispatch-alerts.js', import.meta.url), 'utf8');
const screen = fs.readFileSync(new URL('../rolling60h-ui.js', import.meta.url), 'utf8');
assert.match(ui, /RollingDispatch\.assess/);
assert.match(ui, /仮変更は原本と正式シフトには反映しません/);
assert.match(screen, /RollingDispatchUI\.mount/);
assert.match(screen, /rolling-dispatch-host/);
assert.match(alerts, /speakText/);
assert.match(alerts, /__FRIDAY_CALENDAR_SPEAKING/);
assert.doesNotMatch(ui, /writeFile|unlink|DAILY_DIR/);
assert.doesNotMatch(alerts, /speechSynthesis\.speak\(|new SpeechSynthesisUtterance|writeFile|unlink/);

const os = await import('node:os');
const path = await import('node:path');
const crypto = await import('node:crypto');
const XLSX = require('../node_modules/xlsx/xlsx.js');
const Reader = require('../rolling60h-archive-reader.js');
const Feed = require('../rolling60h-dispatch-feed.js');
const Route = require('../harvest-rolling60h-route.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r60-archive-'));
const header = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];
const archivedRows = [header];
for (let i = 0; i < 7; i += 1) archivedRows.push(['TID-ARCHIVE', Core.addDays('2026-10-16', i), 10, 'OFK3']);
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(archivedRows), 'Report5_Daily_Data');
const raw = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
const hash = crypto.createHash('sha256').update(raw).digest('hex');
fs.mkdirSync(path.join(dir, 'files', '2026-10-22'), { recursive: true });
const archivedFile = path.join(dir, 'files', '2026-10-22', hash + '.xlsx');
fs.writeFileSync(archivedFile, raw);
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
  version: 1,
  revisions: [{ filenameDate: '2026-10-22', maxDate: '2026-10-22', contentHash: hash, sourceName: 'Daily_AMZL_JP_Working_Hour_2026-10-22_fixture.xlsx' }],
}));
const beforeArchive = fs.readFileSync(archivedFile);
const loaded = Reader.read({ fs: fs, path: path, xlsx: XLSX, rolling: Core, root: dir, date: '2026-10-22' });
assert.equal(loaded.ok, true);
assert.equal(fs.readFileSync(archivedFile).equals(beforeArchive), true);
assert.equal(loaded.blocksByTransportId['TID-ARCHIVE']['2026-10-22'][0].hours, 10);
const rejected = Reader.read({ fs: fs, path: path, xlsx: XLSX, rolling: Core, root: dir, date: '2026-10-23' });
assert.equal(rejected.ok, false);
assert.equal(rejected.reason, 'not-archived');
const fromArchive = Dispatch.assess({
  today: today,
  archiveBlocksByTransportId: loaded.blocksByTransportId,
  drivers: [driver({ transportId: 'TID-ARCHIVE', name: '架空保管', actualBlocksByDate: { '2026-10-22': block(4, 'actual') }, rosterBlocksByDate: {} })],
});
assert.equal(fromArchive.drivers[0].countedTodayHours, 4);
assert.equal(fromArchive.drivers[0].today.totalHours, 64);
assert.notEqual(fromArchive.drivers[0].today.totalHours, 74);
const payload = Feed.read({ fs: fs, path: path, xlsx: XLSX, rolling: Core, root: dir, today: '2026-10-22', now: function () { return new Date('2026-10-22T00:00:00.000Z'); } });
assert.equal(payload.app, 'harvest-rolling60h');
assert.equal(payload.approachRule, '');
assert.equal(payload.noticeKind, 'limit60');
assert.equal(payload.referenceDate, '2026-10-22');
assert.equal(payload.alerts.find((alert) => alert.endDate === '2026-10-22').noticeKind, 'today-emergency');
assert.equal(payload.alerts.find((alert) => alert.category === 'insufficient').noticeKind, 'tomorrow-undetermined');
assert.ok(payload.alerts.some((alert) => alert.endDate === '2026-10-22' && alert.category === 'forecast_exceed'));
assert.ok(payload.alerts.some((alert) => alert.endDate === '2026-10-23' && alert.category === 'insufficient'));
assert.equal(payload.alerts.some((alert) => alert.category === 'forecast_exceed' && alert.endDate === '2026-10-23'), false);
const missingFeed = Feed.read({ fs: fs, path: path, xlsx: XLSX, rolling: Core, root: path.join(dir, 'absent'), today: '2026-10-22', now: function () { return new Date('2026-10-22T00:00:00.000Z'); } });
assert.equal(missingFeed.ok, false);
assert.equal(missingFeed.connected, false);
assert.equal(missingFeed.alerts[0].category, 'insufficient');
let ran = false;
const app = {
  post: function (route, handler) { app.postHandler = handler; app.postRoute = route; },
  get: function (route, handler) { app.getHandler = handler; app.getRoute = route; },
};
Route.mount(app, { run: function () { ran = true; return { ok: true }; }, readDispatch: function () { return payload; } });
assert.equal(app.getRoute, '/harvest/rolling60h/alerts');
const remote = { statusCode: 0, body: null, status: function (code) { remote.statusCode = code; return { json: function (body) { remote.body = body; } }; }, socket: { remoteAddress: '8.8.8.8' } };
app.getHandler({ socket: { remoteAddress: '8.8.8.8' } }, remote);
assert.equal(remote.statusCode, 403);
assert.equal(ran, false);
const local = { statusCode: 0, body: null, status: function (code) { local.statusCode = code; return { json: function (body) { local.body = body; } }; } };
app.getHandler({ socket: { remoteAddress: '127.0.0.1' } }, local);
assert.equal(local.statusCode, 200);
assert.equal(local.body.app, 'harvest-rolling60h');
assert.equal(ran, false);
fs.rmSync(dir, { recursive: true, force: true });

console.log('rolling60h-dispatch.test.mjs: ALL TESTS PASSED');
