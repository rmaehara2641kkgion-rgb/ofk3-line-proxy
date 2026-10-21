import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dash = require('../duty-risk-dashboard.js');
const View = require('../inoichi-rolling-view.js');

function day(date, hours, origin) {
  return { date: date, hours: hours, origin: origin, future: origin === 'roster-plan' };
}

function windowFor(id, dates, hours, origins) {
  const days = dates.map((date, index) => day(date, hours[index], origins[index]));
  const total = days.every((item) => typeof item.hours === 'number') ? days.reduce((sum, item) => sum + item.hours, 0) : null;
  return { subjectId: id, start: dates[0], end: dates[6], predictedTotal: total, level: 'within', days: days };
}

const dates = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
const origins = ['daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'daily-estimate', 'roster-plan'];
const ids = ['A3PRGYRMR4CWKC', 'A8JSA661WQ3ZH', 'A18GVH52IIZCOZ', 'A2O7SIGBZ72IDB', 'A194546C4690YP'];
const hours = {
  A3PRGYRMR4CWKC: [8, 8, 8, 8, 8, 7, 5],
  A8JSA661WQ3ZH: [7, 7, 7, 7, 7, 7, 6],
  A18GVH52IIZCOZ: [6, 6, 6, 6, 6, 6, 6],
  A2O7SIGBZ72IDB: [5, 5, 5, 5, 5, 5, 5],
  A194546C4690YP: [4, 4, 4, 4, 4, 4, 4],
};
const history = {
  runs: [{
    referenceDate: '2026-10-21',
    predictedAt: '2026-10-21T02:00:00.000Z',
    predictions: ids.map((id) => windowFor(id, dates, hours[id], origins)).concat([
      windowFor('TID-UNKNOWN', dates, [3, 3, 3, 3, 3, 3, 3], origins),
      windowFor('TID-CASE', dates, [2, 2, 2, 2, 2, 2, 2], origins),
      windowFor('TID-SAME-1', dates, [9, 1, 1, 1, 1, 1, 1], origins),
      windowFor('TID-SAME-2', dates, [1, 9, 1, 1, 1, 1, 1], origins),
      windowFor('TID-KEEP', dates, [8, 8, 8, 8, 8, 8.2, 11], origins),
    ]),
  }],
};
const snapshot = {
  checkedAt: '2026-10-21T02:00:00.000Z',
  alerts: [
    { name: '時間照合の氏名', disposition: 'clear', basis: 'actual', startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 59.2, preTodayHours: 48.2, todayWindowHours: 59.2 },
  ],
};
const master = {
  byTransportId: {
    A3PRGYRMR4CWKC: { japaneseName: '試験 甲', englishName: 'test kou' },
    A8JSA661WQ3ZH: { japaneseName: '互 中川', englishName: 'tagai nakagawa' },
    A18GVH52IIZCOZ: { japaneseName: '', englishName: 'english only' },
    A2O7SIGBZ72IDB: { japaneseName: '大木 祐介', englishName: 'yuusuke oki' },
    A194546C4690YP: { japaneseName: '中村 聖人', englishName: 'masato nakamura' },
    'TID-SAME-1': { japaneseName: '同姓 同名', englishName: 'same one' },
    'TID-SAME-2': { japaneseName: '同姓 同名', englishName: 'same two' },
    ' tid-case ': { japaneseName: '空白違い', englishName: 'spaced' },
  },
};

const before = dash.buildView(snapshot, history, null);
const after = dash.buildView(snapshot, history, master);

ids.forEach((id) => {
  assert.equal(before.ranking.find((row) => row.transportId === id).name, '', id + ' before master');
});
assert.equal(after.ranking.find((row) => row.transportId === 'A3PRGYRMR4CWKC').name, '試験 甲');
assert.equal(after.ranking.find((row) => row.transportId === 'A8JSA661WQ3ZH').name, '互 中川');
assert.equal(after.ranking.find((row) => row.transportId === 'A18GVH52IIZCOZ').name, 'english only');
assert.equal(after.ranking.find((row) => row.transportId === 'A2O7SIGBZ72IDB').name, '大木 祐介');
assert.equal(after.ranking.find((row) => row.transportId === 'A194546C4690YP').name, '中村 聖人');
assert.equal(after.ranking.find((row) => row.transportId === 'TID-UNKNOWN').name, '');
assert.equal(after.ranking.find((row) => row.transportId === 'TID-CASE').name, '');
assert.equal(after.ranking.find((row) => row.transportId === 'TID-SAME-1').name, '同姓 同名');
assert.equal(after.ranking.find((row) => row.transportId === 'TID-SAME-2').name, '同姓 同名');
assert.equal(after.ranking.find((row) => row.transportId === 'TID-KEEP').name, '時間照合の氏名');
assert.equal(before.ranking.find((row) => row.transportId === 'TID-KEEP').pastActual, after.ranking.find((row) => row.transportId === 'TID-KEEP').pastActual);
assert.equal(before.ranking.find((row) => row.transportId === 'TID-KEEP').forecast, after.ranking.find((row) => row.transportId === 'TID-KEEP').forecast);

const failed = dash.buildView(snapshot, history, function () { throw new Error('master down'); });
assert.equal(failed.ranking.find((row) => row.transportId === 'TID-KEEP').name, '時間照合の氏名');
assert.equal(failed.ranking.find((row) => row.transportId === 'A2O7SIGBZ72IDB').name, '');
assert.equal(failed.ok, true);

const priority = dash.buildView(snapshot, history, {
  byTransportId: { 'TID-KEEP': { japaneseName: 'マスタ優先', englishName: 'master wins' } },
});
assert.equal(priority.ranking.find((row) => row.transportId === 'TID-KEEP').name, 'マスタ優先');

const namedView = View.build({
  summary: { ok: true, fileSuccess: 2, fileFailure: 0, checkedAt: '2026-10-21T00:00:00.000Z' },
  drivers: [{
    name: 'yuusuke oki',
    transportId: 'A2O7SIGBZ72IDB',
    disposition: 'exceed',
    windows: [{ judgment: 'exceed', startDate: '2026-10-15', endDate: '2026-10-21', totalHours: 61, overBy: 1 }],
  }],
  predictions: [],
});
assert.equal(namedView.alerts[0].name, 'yuusuke oki');
assert.equal(namedView.alerts[0].transportId, 'A2O7SIGBZ72IDB');

const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.equal(page.includes('function resolveDutyRiskMasterName'), true);
assert.equal(page.includes('resolveDriverKeyByTid(tid)'), true);
assert.equal(page.includes('notifyDutyRiskNames()'), true);
assert.equal(page.includes('DutyRiskDashboard.refresh'), true);

const dashSource = fs.readFileSync(new URL('../duty-risk-dashboard.js', import.meta.url), 'utf8');
assert.equal(dashSource.includes('computeRolling'), false);
assert.equal(dashSource.includes('rolling60h-core'), false);

function countNames(view) {
  const rows = view.ranking || [];
  let named = 0;
  let blank = 0;
  rows.forEach((row) => { if (row.name) named += 1; else blank += 1; });
  return { total: rows.length, named: named, blank: blank };
}

const savedSnap = 'C:/Users/PC-2320/ofk3-repo-link/local/inoichi-rolling-snapshot.json';
const savedHist = 'C:/Users/PC-2320/ofk3-repo-link/local/rolling60h-history.json';
const fixturePath = 'C:/Users/PC-2320/ofk3-repo-link/station-support-pack-recovered/tests/fixtures/ofk3-transport-ids-master.js';
assert.equal(fs.existsSync(savedSnap) && fs.existsSync(savedHist) && fs.existsSync(fixturePath), true);
const savedBefore = dash.buildView(JSON.parse(fs.readFileSync(savedSnap, 'utf8')), JSON.parse(fs.readFileSync(savedHist, 'utf8')), null);
const fixture = {};
const re = /"([^"]+)"\s*:\s*"([^"]+)"/g;
const fixtureText = fs.readFileSync(fixturePath, 'utf8');
let match;
while ((match = re.exec(fixtureText))) fixture[match[2]] = { japaneseName: '', englishName: match[1] };
const savedAfter = dash.buildView(JSON.parse(fs.readFileSync(savedSnap, 'utf8')), JSON.parse(fs.readFileSync(savedHist, 'utf8')), { byTransportId: fixture });
const beforeCounts = countNames(savedBefore);
const afterCounts = countNames(savedAfter);
console.log('SAVED_RANKING_BEFORE ' + JSON.stringify(beforeCounts));
console.log('SAVED_RANKING_AFTER_FIXTURE ' + JSON.stringify(afterCounts));
assert.equal(beforeCounts.total, 90);
assert.equal(beforeCounts.named, 23);
assert.equal(beforeCounts.blank, 67);
assert.equal(afterCounts.total, 90);
assert.ok(afterCounts.named > beforeCounts.named);
assert.equal(afterCounts.named + afterCounts.blank, 90);
ids.forEach((id) => {
  const row = savedAfter.ranking.find((item) => item.transportId === id);
  assert.ok(row, id + ' in saved ranking');
  if (fixture[id]) assert.equal(row.name, fixture[id].englishName);
  else assert.equal(row.name, '');
  assert.equal(row.pastActual, savedBefore.ranking.find((item) => item.transportId === id).pastActual);
  assert.equal(row.forecast, savedBefore.ranking.find((item) => item.transportId === id).forecast);
});

console.log('duty-risk-master-name tests passed');
