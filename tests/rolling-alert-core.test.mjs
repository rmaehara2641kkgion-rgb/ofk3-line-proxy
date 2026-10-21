import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const RC = require('../rolling60h-core.js');
const AC = require('../rolling-alert-core.js');

const { TARGET, PAST, NOW, makeDriver, fleet, SCENARIOS } = await import('./fixtures/rolling-alert-fixtures.mjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

const ev = (d) => AC.evaluateDriver(d, { targetDate: TARGET });

check('超過確定: 過去6日の実績だけで60h超', () => {
  const r = ev(makeDriver('A1', { pastActual: [11, 11, 11, 11, 11, 11], today: '休' }));
  assert.equal(r.alertClass, 'exceed_confirmed');
  assert.equal(r.past6ActualHours, 66);
  assert.equal(r.remainingHours, -6);
  assert.equal(r.remainingExact, true);
});

check('超過予測: 実績54h + 当日○(11h) = 65h', () => {
  const r = ev(makeDriver('A2', { pastActual: [9, 9, 9, 9, 9, 9], today: '○' }));
  assert.equal(r.alertClass, 'exceed_forecast');
  assert.equal(r.rollingTotalHours, 65);
  assert.equal(r.remainingHours, -5);
  assert.match(r.basis, /予定を含む/);
});

check('超過予測: 過去に予定日（実績なし）を含み60h超 → 確定にしない', () => {
  const r = ev(makeDriver('A3', {
    pastActual: [10, 10, 10, 10, 10, null],
    pastRoster: { '2026-10-20': '○' },
    today: '休',
  }));
  assert.equal(r.past6ActualHours, 50);
  assert.equal(r.past6PlanHours, 11);
  assert.equal(r.alertClass, 'exceed_forecast');
});

check('接近警告: 過去6日51h + 当日❽(8h) = 59h', () => {
  const r = ev(makeDriver('B1', { pastActual: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '❽' }));
  assert.equal(r.alertClass, 'approach');
  assert.equal(r.rollingTotalHours, 59);
  assert.equal(r.remainingHours, 1);
});

check('接近警告の境界: 過去6日がちょうど49hは対象、48.5hは対象外', () => {
  const at49 = ev(makeDriver('B2', { pastActual: [8, 8, 8, 8, 8, 9], today: 'b1' }));
  assert.equal(at49.past6Hours, 49);
  assert.equal(at49.alertClass, 'approach');
  const at485 = ev(makeDriver('B3', { pastActual: [8, 8, 8, 8, 8, 8.5], today: 'b1' }));
  assert.equal(at485.alertClass, 'normal');
});

check('ちょうど60h（合計）は超過ではない: 過去6日49h + 当日○(11h) = 60h → 接近警告', () => {
  const r = ev(makeDriver('C1', { pastActual: [8, 8, 8, 8, 8, 9], today: '○' }));
  assert.equal(r.rollingTotalHours, 60);
  assert.equal(r.alertClass, 'approach');
  assert.equal(r.remainingHours, 0);
});

check('ちょうど60h（過去6日）かつ当日休 → 超過ではなく除外', () => {
  const r = ev(makeDriver('C2', { pastActual: [10, 10, 10, 10, 10, 10], today: '休' }));
  assert.equal(r.alertClass, 'day_off');
});

check('過去6日が60h ちょうどで当日勤務あり → 60h超のため超過予測（接近と重複しない）', () => {
  const r = ev(makeDriver('C3', { pastActual: [10, 10, 10, 10, 10, 10], today: 'b1' }));
  assert.equal(r.alertClass, 'exceed_forecast');
});

check('当日休の人は接近警告から除外', () => {
  const r = ev(makeDriver('D1', { pastActual: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '休' }));
  assert.equal(r.alertClass, 'day_off');
  assert.equal(r.todayStatus, 'off');
});

check('当日勤務予定が不明（空白セル）→ 勤務予定未確認。0h/休にしない', () => {
  const r = ev(makeDriver('E1', { pastActual: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5], today: '' }));
  assert.equal(r.alertClass, 'schedule_unconfirmed');
  assert.equal(r.todayHours, null);
  assert.equal(r.rollingTotalHours, null);
  assert.equal(r.remainingExact, false);
});

check('当日勤務予定が不明（データなし）も勤務予定未確認', () => {
  const r = ev(makeDriver('E2', { pastActual: [8.5, 8.5, 8.5, 8.5, 8.5, 8.5] }));
  assert.equal(r.alertClass, 'schedule_unconfirmed');
  assert.equal(r.todayMissingReason, 'no-data');
});

check('当日不明でも過去6日が接近範囲外なら対象外', () => {
  const r = ev(makeDriver('E3', { pastActual: [5, 5, 5, 5, 5, 5], today: '' }));
  assert.equal(r.alertClass, 'normal');
});

check('過去6日に未取得日がある → 判定不能（0h補完しない）', () => {
  const r = ev(makeDriver('F1', { pastActual: [8, 8, 8, 8, 8, null], today: '○' }));
  assert.equal(r.alertClass, 'undetermined');
  assert.equal(r.past6Hours, null);
  assert.deepEqual(r.past6MissingDates, ['2026-10-20']);
});

check('未取得日があっても既知分だけで60h超なら超過（下限値であることを明示）', () => {
  const r = ev(makeDriver('F2', { pastActual: [13, 13, 13, 13, 13, null], today: '休' }));
  assert.equal(r.alertClass, 'exceed_confirmed');
  assert.equal(r.remainingExact, false);
});

check('未定義記号(C2)の日は未取得として扱う', () => {
  const r = ev(makeDriver('F3', { pastActual: [8, 8, 8, 8, 8, null], pastRoster: { '2026-10-20': 'C2' }, today: '休' }));
  assert.equal(r.alertClass, 'undetermined');
  assert.equal(r.days[5].missing, 'undefined-code');
});

check('照合シナリオ表（HARVEST照合用）が現行ルールの期待区分と一致', () => {
  SCENARIOS.forEach((sc) => {
    const r = ev(makeDriver('S', { pastActual: sc.past, today: sc.today }));
    assert.equal(r.alertClass, sc.expect, sc.id);
  });
});

// ---- スナップショット ----
const ctx = { targetDate: TARGET, dataImportedAt: '2026-10-21T00:00:00.000Z', computedAt: '2026-10-21T00:00:01.000Z' };
check('初回: 区分別の集計と並び順（確定 → 予測 → 接近 → 未確認）', () => {
  const snap = AC.buildSnapshot(fleet(), ctx);
  assert.equal(AC.validateSnapshot(snap, { now: NOW }).ok, true);
  assert.deepEqual(snap.alerts.map((a) => a.alertClass), ['exceed_confirmed', 'exceed_forecast', 'approach', 'schedule_unconfirmed']);
  assert.equal(snap.counts.alertCount, 4);
  assert.equal(snap.counts.undetermined, 1);
  assert.equal(snap.counts.day_off, 1);
  assert.equal(snap.counts.normal, 1);
  assert.equal(snap.counts.driverCount, 7);
  // 接近と超過予測を二重計上しない: 1人は1区分のみ
  const keys = snap.alerts.map((a) => a.driverKey);
  assert.equal(new Set(keys).size, keys.length);
});

check('データ更新後の再集計: 当日が○→休に変わると結果が変わり指紋も変わる', () => {
  const before = AC.buildSnapshot(fleet(), ctx);
  const updated = fleet();
  updated[1] = makeDriver('A2', { pastActual: [9, 9, 9, 9, 9, 9], today: '休' });
  const after = AC.buildSnapshot(updated, { ...ctx, computedAt: '2026-10-21T01:00:00.000Z' });
  assert.notEqual(after.inputFingerprint, before.inputFingerprint);
  assert.equal(after.alerts.some((a) => a.driverKey === 'A2'), false);
  assert.equal(after.counts.alertCount, 3);
});

check('同一データの再投入: 指紋が同じで、対象者は二重計上されない', () => {
  const a = AC.buildSnapshot(fleet(), ctx);
  const b = AC.buildSnapshot(fleet().concat(fleet()), { ...ctx, computedAt: '2026-10-21T02:00:00.000Z' });
  assert.equal(b.inputFingerprint, a.inputFingerprint);
  assert.equal(b.counts.driverCount, 7);
  assert.equal(b.alerts.length, 4);
});

check('対象者0名: alerts が空', () => {
  const snap = AC.buildSnapshot([makeDriver('N1', { pastActual: [5, 5, 5, 5, 5, 5], today: '❽' })], ctx);
  assert.equal(snap.alerts.length, 0);
  assert.equal(snap.counts.alertCount, 0);
  assert.equal(AC.validateSnapshot(snap, { now: NOW }).ok, true);
});

check('古い結果の判定: 対象日が基準日と違うスナップショットは stale', () => {
  const snap = AC.buildSnapshot(fleet(), ctx);
  assert.equal(AC.isStale(snap, TARGET), false);
  assert.equal(AC.isStale(snap, '2026-10-22'), true);
  assert.equal(AC.isStale(null, TARGET), true);
});

check('検証: 壊れたスナップショットを拒否', () => {
  const snap = AC.buildSnapshot(fleet(), ctx);
  assert.equal(AC.validateSnapshot({ ...snap, schemaVersion: 99 }, { now: NOW }).ok, false);
  assert.equal(AC.validateSnapshot({ ...snap, targetDate: '2026/10/21' }, { now: NOW }).ok, false);
  assert.equal(AC.validateSnapshot({ ...snap, alerts: [snap.alerts[0], snap.alerts[0]], counts: { ...snap.counts, alertCount: 2 } }, { now: NOW }).reason, 'duplicate-driver');
  assert.equal(AC.validateSnapshot(null).ok, false);
});

check('検証: 日時・形式・サイズ・数値の不正を拒否し、未知項目は捨てる', () => {
  const good = AC.buildSnapshot(fleet(), ctx);
  const bad = (patch, reason) => assert.equal(AC.validateSnapshot({ ...good, ...patch }, { now: NOW }).reason, reason, JSON.stringify(Object.keys(patch)));
  bad({ computedAt: '2027-01-01T00:00:00Z' }, 'computed-at'); // 未来
  bad({ computedAt: 'yesterday' }, 'computed-at');
  bad({ dataImportedAt: '1999-01-01T00:00:00Z' }, 'data-imported-at');
  bad({ targetDate: '2026-02-30' }, 'target-date');
  bad({ targetDate: '2030-01-01' }, 'target-date-range');
  bad({ inputFingerprint: '<script>' }, 'fingerprint');
  bad({ ruleVersion: 'other' }, 'rule-version');
  bad({ alerts: new Array(AC.LIMITS.maxAlerts + 1).fill(good.alerts[0]) }, 'alerts');
  bad({ counts: { ...good.counts, alertCount: 99 } }, 'counts-mismatch');
  const badNum = JSON.parse(JSON.stringify(good)); badNum.alerts[0].past6Hours = 1e9;
  assert.equal(AC.validateSnapshot(badNum, { now: NOW }).ok, false);
  const badCls = JSON.parse(JSON.stringify(good)); badCls.alerts[0].alertClass = 'admin';
  assert.equal(AC.validateSnapshot(badCls, { now: NOW }).ok, false);
  const extra = JSON.parse(JSON.stringify(good)); extra.evil = '<img onerror=x>'; extra.alerts[0].evil = 1; extra.alerts[0].name = 'x'.repeat(5000);
  const r = AC.sanitizeSnapshot(extra, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.evil, undefined);
  assert.equal(r.snapshot.alerts[0].evil, undefined);
  assert.equal(r.snapshot.alerts[0].name.length, AC.LIMITS.maxStr);
});

console.log('rolling-alert-core.test.mjs: ALL TESTS PASSED (' + passed + ' checks)');
