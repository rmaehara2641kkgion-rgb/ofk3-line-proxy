import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const DryRun = require('../inoichi-rolling-dryrun.js');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function window(judgment, start, extra) {
  return Object.assign({
    startDate: start,
    endDate: '2026-10-17',
    totalHours: judgment === 'exceed' ? 70 : judgment === 'approach' ? 60 : 40,
    limitHours: 60,
    judgment: judgment,
    complete: judgment !== 'undetermined',
    hasUndefinedHours: false,
    over: judgment === 'exceed',
    warning: judgment === 'approach',
  }, extra || {});
}

const first = DryRun.fromDrivers([
  {
    transportId: 'TID-FICTION-1',
    hoursKind: 'estimated_working_hour',
    windows: [
      window('exceed', '2026-10-11'),
      window('approach', '2026-10-12'),
      window('undetermined', '2026-10-13', { complete: false, totalHours: 20 }),
      window('within', '2026-10-14', { totalHours: 40 }),
    ],
  },
  {
    transportId: '',
    windows: [window('exceed', '2026-10-11')],
  },
]);

assert(first.sent === false && first.channel === 'dry-run', '送信しない');
assert(first.suppressionReason === 'policy-not-confirmed', '本番通知ポリシーは未確定のまま');
assert(first.alerts.length === 2, '超過と接近だけを候補にする');
assert(first.alerts[0].level === 'exceed' && first.alerts[0].status === 'OPEN', '超過は新規候補');
assert(first.alerts[1].level === 'approach', '60時間ちょうどは接近');
assert(first.alerts[0].evidence.transportId === 'TID-FICTION-1', '対象者を証拠に残す');
assert(first.alerts[0].evidence.startDate === '2026-10-11' && first.alerts[0].evidence.endDate === '2026-10-17', '集計期間を証拠に残す');
assert(first.alerts[0].evidence.totalHours === 70 && first.alerts[0].evidence.hoursKind === 'estimated_working_hour', '推定時間を証拠に残す');
assert(first.undetermined.length === 2, 'データ不足とIDなしは判定不能');
assert(first.undetermined.some(function (row) { return row.reason === 'incomplete-window'; }), '7日不足を判定不能にする');
assert(first.undetermined.some(function (row) { return row.reason === 'missing-transport-id'; }), 'IDが無い人は推測しない');

const again = DryRun.fromDrivers([
  {
    transportId: 'TID-FICTION-1',
    windows: [window('exceed', '2026-10-11')],
  },
], { previousKeys: first.alerts.map(function (alert) { return alert.alertKey; }) });
assert(again.alerts.length === 1 && again.alerts[0].status === 'ONGOING', '同じ警告は再発報しない');
assert(again.alerts[0].sent === false, '継続候補も送信しない');

const source = require('fs').readFileSync(new URL('../inoichi-rolling-dryrun.js', import.meta.url), 'utf8');
assert(source.indexOf('wh60SendAlerts') === -1 && source.indexOf('fetch(') === -1, 'LINE送信と外部通信を持たない');

console.log('inoichi-rolling-dryrun.test.mjs: ALL TESTS PASSED');
