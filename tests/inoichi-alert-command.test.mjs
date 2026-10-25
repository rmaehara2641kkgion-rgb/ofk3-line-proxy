import { createRequire } from 'module';
import { strict as assert } from 'assert';
import fs from 'fs';

const require = createRequire(import.meta.url);
const Dashboard = require('../inoichi-dashboard.js');
const View = require('../inoichi-alert-view.js');

function commandFor(extra) {
  return View.buildCommandCenter(Object.assign({
    meta: { generatedAt: '2026-10-07T12:00:00.000Z', sampleMode: false, dataSource: 'test' },
    alertHistory: [],
    diagnostics: {},
    rollingView: { fetchStatus: 'missing', fetchLabel: 'データ未取得', alerts: [] },
    threeWay: null
  }, extra || {}));
}

function card(command, id) {
  return command.categories.filter(function (item) { return item.id === id; })[0];
}

var today = View.businessDate('2026-10-07T12:00:00.000Z');
assert.equal(today, '2026-10-07', '業務日は日本時間');
assert.equal(View.businessDate(''), '', '空の時刻は日付にしない');

var unconnected = commandFor();
assert.equal(card(unconnected, 'fleet_count').summary, '未接続');
assert.equal(card(unconnected, 'fleet_count').tone, 'unknown');
assert.equal(card(unconnected, 'fleet_count').countLabel, '—');
assert.equal(unconnected.todayTotal, 0);
assert.equal(unconnected.critical, 0);
assert.ok(unconnected.sources.some(function (source) {
  return source.id === 'amazon_input' && source.connection === 'not_connected';
}), 'Amazon入力サイトは未接続');
assert.ok(unconnected.daContract.every(function (item) { return item.implemented === false; }), 'DAの未実装契約を検知にしない');
assert.equal(unconnected.alerts.some(function (item) { return item.summary.indexOf('シフト未登録') >= 0; }), false);

var compared = commandFor({
  threeWay: {
    rows: [
      { date: '2026-10-07', cycle: 'CYCLE_1', vehicle: '8B', measure: 'courses', status: 'match', counts: { amazon_input: 19, amazon_schedule: 19, internal_excel: 19 } },
      { date: '2026-10-07', cycle: 'CYCLE_2', vehicle: '8B', measure: 'courses', status: 'mismatch', counts: { amazon_input: 8, amazon_schedule: 10, internal_excel: 8 } },
      { date: '2026-10-07', cycle: 'CYCLE_3', vehicle: '8B', measure: 'courses', status: 'missing', counts: { amazon_input: 11, amazon_schedule: null, internal_excel: 11 } }
    ]
  }
});
var mismatches = compared.alerts.filter(function (item) { return item.category === 'fleet_count'; });
assert.equal(mismatches.length, 1, '不一致だけを台数アラートにする');
assert.equal(mismatches[0].detail, 'Amazon予定が不一致');
assert.equal(mismatches[0].target_date, '2026-10-07');
assert.equal(mismatches[0].cycle, 'CYCLE_2');
var pending = compared.fleetRows.filter(function (row) { return row.cycle === 'CYCLE_3'; })[0];
assert.equal(pending.judgment, '判定保留');
assert.equal(pending.counts.amazon_schedule, null);
assert.equal(card(compared, 'fleet_count').countLabel, '1');
assert.notEqual(card(compared, 'fleet_count').tone, 'clear');

var failedFetch = commandFor({
  rollingView: { fetchStatus: 'failed', fetchLabel: '取得失敗', alerts: [{ name: '誰か', disposition: 'exceed', statusLabel: '超過' }] },
  threeWay: {
    rows: [],
    blockedSources: [{ source: 'internal_excel', reason: 'InputFileのNode/Block/Cycle列が見つかりません' }],
    acquisitionComplete: false
  }
});
assert.equal(failedFetch.alerts.some(function (item) { return item.category === 'fleet_count'; }), false, '取得失敗を台数不一致にしない');
assert.equal(failedFetch.sources.filter(function (source) { return source.id === 'rolling60h'; })[0].connection, 'failed');
assert.equal(failedFetch.sources.filter(function (source) { return source.id === 'internal_excel'; })[0].connection, 'failed');
assert.equal(card(failedFetch, 'fleet_count').summary, '取得失敗');

var resolved = commandFor({
  alertHistory: [
    { alertKey: 'same', status: 'OPEN', severity: 'warning', localDate: '2026-10-07', ruleId: 'fleet-capacity-shortage-v1', firstDetectedAt: '2026-10-07T01:00:00.000Z' },
    { alertKey: 'same', status: 'OPEN', severity: 'critical', localDate: '2026-10-07', ruleId: 'fleet-capacity-shortage-v1', firstDetectedAt: '2026-10-07T01:00:00.000Z', lastDetectedAt: '2026-10-07T02:00:00.000Z' },
    { alertKey: 'done', status: 'RESOLVED', severity: 'critical', localDate: '2026-10-07', ruleId: 'fleet-capacity-shortage-v1', firstDetectedAt: '2026-10-07T01:00:00.000Z' }
  ]
});
assert.equal(resolved.alerts.filter(function (item) { return item.alert_id === 'same'; }).length, 1, '同じアラートは一つ');
assert.equal(resolved.critical, 1);
assert.equal(resolved.warning, 0);
assert.equal(resolved.todayTotal, 1, '解消済みは本日の件数に入れない');
assert.equal(resolved.alerts.some(function (item) { return item.alert_id === 'done' && item.status === 'resolved'; }), true);

var odd = View.divergentSources({ amazon_input: 4, amazon_schedule: 4, internal_excel: 9 });
assert.deepEqual(odd, ['internal_excel']);
var allOdd = View.divergentSources({ amazon_input: 1, amazon_schedule: 2, internal_excel: 3 });
assert.equal(allOdd.length, 3);

var sample = Dashboard.buildDashboardState({
  store: Dashboard.generateSampleStore(),
  sampleMode: true,
  now: '2026-10-07T12:00:00.000Z'
});
assert.equal(sample.command.critical, 1);
assert.equal(sample.command.warning, 2);
assert.equal(sample.command.todayTotal, 3);
assert.equal(card(sample.command, 'fleet_count').summary, '未接続');
assert.notEqual(card(sample.command, 'da_shift').tone, 'clear');

var host = { innerHTML: '' };
Dashboard.renderDashboard(host, sample);
var statusAt = host.innerHTML.indexOf('id="ino-status-bar"');
var tabsAt = host.innerHTML.indexOf('role="tablist"');
var overviewHtml = host.innerHTML.split('id="ino-tab-overview"')[1].split('id="ino-tab-fleet"')[0];
assert.equal(statusAt >= 0 && tabsAt > statusAt, true);
assert.equal(overviewHtml.indexOf('id="ino-category-cards"') >= 0, true);
assert.equal(host.innerHTML.indexOf('id="ino-tab-overview" class="ino-tab-panel" role="tabpanel" hidden') >= 0, false);
assert.equal(host.innerHTML.indexOf('id="ino-status-bar"') >= 0, true);
assert.equal(host.innerHTML.indexOf('台数照合は未接続です') >= 0, true);
assert.equal(host.innerHTML.indexOf('A. サマリー') >= 0, true);
assert.equal(host.innerHTML.indexOf('B. 欠車リスク一覧') >= 0, true);
assert.equal(host.innerHTML.indexOf('ローリング60h監視') >= 0, true);
assert.equal(host.innerHTML.indexOf('data-ino-da-check="shift_unregistered"') >= 0, true);
assert.equal(host.innerHTML.indexOf('class="ino-logo"') >= 0, true);
assert.equal(host.innerHTML.indexOf('Cycle 1') >= 0, false);

Dashboard.openAlertTab({ getAttribute: function (name) { return name === 'data-ino-tab' ? 'fleet' : ''; } });
assert.equal(host.innerHTML.indexOf('id="ino-tab-fleet" class="ino-tab-panel" role="tabpanel" hidden') >= 0, false);
assert.equal(host.innerHTML.indexOf('id="ino-tab-overview" class="ino-tab-panel" role="tabpanel" hidden') >= 0, true);

var fleetHost = { innerHTML: '' };
Dashboard.renderDashboard(fleetHost, Dashboard.buildDashboardState({
  now: '2026-10-07T12:00:00.000Z',
  threeWay: compared.threeWay ? null : {
    rows: compared.fleetRows.map(function (row) {
      return {
        date: row.date,
        cycle: row.cycle,
        vehicle: row.vehicle,
        measure: row.measure,
        status: row.judgment === '一致' ? 'match' : (row.judgment === '不一致' ? 'mismatch' : 'missing'),
        counts: row.counts
      };
    })
  }
}));
assert.equal(fleetHost.innerHTML.indexOf('Amazon予定が不一致') >= 0, true);
var held = fleetHost.innerHTML.split('data-ino-fleet-judgment="判定保留"')[1].split('</tr>')[0];
assert.equal(held.indexOf('未取得') >= 0, true);
assert.equal(held.indexOf('>0<'), -1, '未取得の台数を0と表示しない');

var appSource = fs.readFileSync(new URL('../inoichi-dashboard.js', import.meta.url), 'utf8');
var viewSource = fs.readFileSync(new URL('../inoichi-alert-view.js', import.meta.url), 'utf8');
assert.equal(appSource.indexOf('Cycle 1'), -1);
assert.equal(viewSource.indexOf('Cycle 1'), -1);
assert.equal(appSource.indexOf('fetch('), -1);
assert.equal(appSource.indexOf('harvest'), -1);

var failureHost = { innerHTML: '' };
Dashboard.renderDashboard(failureHost, Dashboard.buildDashboardState({
  rollingView: {
    fetchStatus: 'failed',
    fetchLabel: '取得失敗',
    checkedAt: '2026-10-21T00:00:00.000Z',
    usable: false,
    counts: { exceedCount: null, clearCount: null },
    alerts: [],
    changes: {},
    notice: '今回の取得は成功していません。',
    lastSuccess: {
      checkedAt: '2026-10-20T00:00:00.000Z',
      counts: { exceedCount: 1 },
      alerts: [{ name: 'Over Driver', disposition: 'exceed', statusLabel: '60h超過', endDate: '2026-10-17', preTodayEnd: '2026-10-19' }]
    }
  }
}));
assert.equal(failureHost.innerHTML.indexOf('ローリング60h監視') >= 0, true);
assert.equal(failureHost.innerHTML.indexOf('data-ino-rolling-count="exceed">—') >= 0, true);
assert.equal(failureHost.innerHTML.indexOf('前回取得分') >= 0, true);
assert.equal(failureHost.innerHTML.indexOf('Over Driver') >= 0, true);

var windowHost = { innerHTML: '' };
Dashboard.renderDashboard(windowHost, Dashboard.buildDashboardState({
  rollingView: {
    fetchStatus: 'success',
    fetchLabel: '取得成功',
    checkedAt: '2026-10-21T02:07:52.450Z',
    usable: true,
    approachRule: 'prefix6-margin11',
    counts: { driverCount: 4, clearCount: 0, exceedCount: 2, approachCount: 0, partialCount: 1, undeterminedCount: 0, dutyUnconfirmedCount: 0 },
    changes: { newExceed: 0, ongoingExceed: 0, resolvedExceed: 1, becameUndetermined: 0, dataUnchanged: 0 },
    alerts: [
      { name: '架空過去', disposition: 'exceed', statusLabel: '60h超過', startDate: '2026-10-04', endDate: '2026-10-10', preTodayEnd: '2026-10-20', basis: 'plan', basisLabel: '予定を含む', totalHours: 70, todayDuty: 'off', checkedAt: '2026-10-21T02:07:52.450Z' },
      { name: '架空未来', disposition: 'exceed', statusLabel: '60h超過', startDate: '2026-10-24', endDate: '2026-10-30', preTodayEnd: '2026-10-20', basis: 'forecast', basisLabel: '超過予測', totalHours: 65, todayDuty: 'work', checkedAt: '2026-10-21T02:07:52.450Z' },
      { name: '架空解消', disposition: 'resolved', statusLabel: '超過解消', startDate: '2026-10-12', endDate: '2026-10-18', checkedAt: '2026-10-21T02:07:52.450Z' },
      { name: '架空不足', disposition: 'partial', statusLabel: '一部取得', startDate: '2026-10-15', endDate: '2026-10-21', preTodayEnd: '2026-10-20', checkedAt: '2026-10-21T02:07:52.450Z' }
    ]
  }
}));
var todaySection = windowHost.innerHTML.split('data-ino-rolling-section="past"')[0];
assert.equal(windowHost.innerHTML.indexOf('今日で終わる7日窓の超過は0名') >= 0, true);
assert.equal(windowHost.innerHTML.indexOf('data-ino-rolling-count="todayExceed">0') >= 0, true);
assert.equal(windowHost.innerHTML.indexOf('data-ino-rolling-count="pastExceed">1') >= 0, true);
assert.equal(windowHost.innerHTML.indexOf('data-ino-rolling-count="futureExceed">1') >= 0, true);
assert.equal(windowHost.innerHTML.indexOf('data-ino-rolling-count="resolvedRows">1') >= 0, true);
assert.equal(windowHost.innerHTML.indexOf('data-ino-rolling-count="exceed">2') >= 0, true);
assert.equal(todaySection.indexOf('該当なし') >= 0, true);
assert.equal(todaySection.indexOf('架空'), -1);
assert.equal(windowHost.innerHTML.indexOf('過去の7日窓で検出された超過') >= 0, true);
assert.equal(windowHost.innerHTML.indexOf('未来の7日窓で予測される超過') >= 0, true);

console.log('inoichi alert command tests passed');
