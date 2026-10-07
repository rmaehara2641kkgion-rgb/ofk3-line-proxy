import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const AssignSupportCore = require('../assign-support-core.js');
const AEC = require('../area-experience-core.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
  passed++;
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const HEADER = ['TransportID', 'driverName', 'area', 'experienceDays', 'lastVisitDate', 'primaryCount', 'splitCount', 'rescueCount', 'stops', 'packages', 'confidence'];
const HISTORY_HEADER = ['weekKey', 'dateFrom', 'dateTo', 'importedAt', 'sourceFingerprint', 'rowCount', 'source'];
// 実ファイルと同じ構造（基準 dateTo=9/10、W38=9/13〜、W39〜9/26 → 9/11〜9/12 欠損）
const HISTORY_W39 = [
  HISTORY_HEADER,
  ['LEGACY-BASELINE', '', '2026-09-10', '2026-10-01T03:56:09.511Z', 'legacy-baseline', 5, 'cumulative_W33-W37.xlsx'],
  ['2026-W38', '2026-09-13', '2026-09-19', '2026-10-01T03:56:09.511Z', 'fp38', 3, 'weekly_W38.xlsx'],
  ['2026-W39', '2026-09-20', '2026-09-26', '2026-10-01T04:01:00.436Z', 'fp39', 3, 'weekly_W39.xlsx'],
];
const AREA_ROWS = [
  HEADER,
  ['TID_A', 'driver a', '東油山', 28, '2026-09-26', 30, 2, 1, 1177, 1450, 'high'],
  ['TID_A', 'driver a', '片江', 27, '2026-09-26', 29, 1, 2, 928, 1195, 'high'],
  ['TID_A', 'driver a', '南片江', 26, '2026-09-26', 28, 1, 1, 1283, 1504, 'high'],
  ['TID_A', 'driver a', '樋井川', 26, '2026-09-26', 29, 2, 0, 1154, 1328, 'high'],
  ['TID_B', 'driver b', '原', 15, '2026-09-25', 10, 4, 3, 340, 371, 'high'],
  ['TID_B', 'driver b', '西新', 15, '2026-09-25', 12, 4, 2, 529, 594, 'high'],
  ['', '一郎 試験', '別府', 12, '2026-09-24', 10, 1, 1, 300, 320, 'high'],
  ['', '一郎 試験', '荒江', 3, '2026-09-20', 2, 1, 0, 40, 45, 'medium'],
  ['', '次郎 同名', '原', 5, '2026-09-22', 4, 1, 0, 90, 99, 'low'],
  ['', '三郎 不明', '室見', 2, '2026-09-21', 1, 1, 0, 20, 21, 'low'],
];
const MASTER = {
  'driver a': 'TID_A',
  'driver b': 'TID_B',
  '一郎　試験 ': 'TID_ICHI', // 全角空白・末尾空白の表記ゆれ
  '次郎 同名': 'TID_JIRO1',
  '次郎同名': 'TID_JIRO2', // 同姓同名（正規化後に2候補）
  '新人 花子': 'TID_NEW',
  'pph null': 'TID_PPHNULL',
};

function makeWorkbook(areaRows, historyRows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(areaRows), 'areaExperience');
  if (historyRows) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(historyRows), 'importHistory');
  // 実際のファイル読込と同じ経路（write → read）を通す
  return XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
}

function snapshotFrom(areaRows, historyRows, master, extra) {
  const parsed = AEC.parseExperienceWorkbook(makeWorkbook(areaRows, historyRows), XLSX, { fileName: 'test.xlsx' });
  return AEC.buildSnapshotLayer(parsed, Object.assign({ transportIDs: master || MASTER, driverJapaneseNames: {} }, extra || {}));
}

function capture(date, route, tid, addresses, capturedAt) {
  return { serviceDate: date, routeCode: route, transporterId: tid, addresses: addresses, capturedAt: capturedAt || date + 'T20:00:00Z' };
}
function eventsOf(captures, store) {
  const up = AEC.upsertRouteCaptures(store || {}, captures);
  return { store: up.store, events: AEC.deriveExperienceEvents(up.store) };
}
const ADDR_HIGASHIABURAYAMA = ['城南区東油山4丁目1-2, 福岡市, 福岡', '城南区東油山5丁目3, 福岡市, 福岡'];
const ADDR_BEPPU = ['城南区別府1丁目2-3, 福岡市, 福岡'];

const snap = snapshotFrom(AREA_ROWS, HISTORY_W39);
const known = new Set(Object.values(MASTER));

// ---- 取込・検証 ----
assert(snap.ok, 'snapshot ok: ' + snap.errors.join(','));
assert(snap.snapshotThroughDate === '2026-09-26', 'snapshotThroughDate = max(importHistory.dateTo)');
assert(snap.validation.maxLastVisitDate === '2026-09-26', 'max lastVisitDate');
assert(snap.importHistory.length === 3 && snap.importHistory[0].dateFrom === '', 'importHistory parsed, baseline dateFrom empty');

// Case 19: 9/11〜9/12 欠損期間（0日補完しない）
assert(snap.validation.missingPeriods.length === 1, 'Case19 one missing period');
assert(snap.validation.missingPeriods[0].from === '2026-09-11' && snap.validation.missingPeriods[0].to === '2026-09-12', 'Case19 9/11-9/12');
assert(snap.warnings.some((w) => w.indexOf('2026-09-11〜2026-09-12') >= 0), 'Case19 warning shown');
assert(!snap.records.some((r) => r.lastVisitDate === '2026-09-11' || r.lastVisitDate === '2026-09-12'), 'Case19 no synthetic records');

// Case 18: rawRows 全行保持（空欄行も失わない）
assert(snap.rawRows.length === AREA_ROWS.length - 1, 'Case18 all raw rows kept');
assert(snap.validation.blankTidRowCount === 4, 'Case18 blank rows counted');
assert(snap.rawRows.filter((r) => r[0] === '').length === 4, 'Case18 blank rows present in rawRows');

// Case 15: 空欄氏名の一意一致 → 内部解決、rawRows不変
const rawBefore = JSON.stringify(snap.rawRows);
const ichi = snap.resolvedDrivers.find((d) => d.driverName === '一郎 試験');
assert(ichi && ichi.resolvedTransportId === 'TID_ICHI', 'Case15 resolved via normalized name');
assert(snap.records.filter((r) => r.transportId === 'TID_ICHI').length === 2, 'Case15 records attached to TID');
assert(snap.rawRows[6][0] === '' && JSON.stringify(snap.rawRows) === rawBefore, 'Case15 rawRows unchanged');
const merged0 = AEC.mergeSnapshotAndEvents(snap, [], { knownTransportIds: known });
assert(merged0.byTransportId.TID_ICHI.areas['別府'].experienceDays === 12, 'Case15 reflected in experienceDb');

// Case 16: 同姓同名（複数候補） → 未解決
const jiro = snap.unresolvedDrivers.find((d) => d.driverName === '次郎 同名');
assert(jiro && jiro.reason === 'multiple_candidates', 'Case16 multiple candidates unresolved');
assert(jiro.candidateTransportIds.sort().join(',') === 'TID_JIRO1,TID_JIRO2', 'Case16 candidates listed');
assert(!merged0.byTransportId.TID_JIRO1 && !merged0.byTransportId.TID_JIRO2, 'Case16 not attached to either');

// Case 17: 不一致 → 未解決
const sabu = snap.unresolvedDrivers.find((d) => d.driverName === '三郎 不明');
assert(sabu && sabu.reason === 'not_in_master' && sabu.rowCount === 1 && sabu.areaCount === 1, 'Case17 unresolved with counts');

// 禁止事項: 部分一致・姓名入替・類似では解決しない
const idx = AEC.buildDriverNameIndex({ '山田 太郎': 'T1' }, {});
assert(AEC.resolveTransportIdByExactName('山田', idx).transportId === '', 'no partial match');
assert(AEC.resolveTransportIdByExactName('太郎 山田', idx).transportId === '', 'no name reversal');
assert(AEC.resolveTransportIdByExactName('山田 太朗', idx).transportId === '', 'no fuzzy match');
assert(AEC.resolveTransportIdByExactName('ＹＡＭＡＤＡ', AEC.buildDriverNameIndex({ 'yamada': 'T2' }, {})).transportId === 'T2', 'fullwidth/case normalized');
// 2つの別氏名が同一TIDへ解決 → 両方未解決
const shared = snapshotFrom(
  [HEADER, ['', 'aa', 'x', 1, '2026-09-20', 1, 0, 0, 1, 1, 'low'], ['', 'a a', 'y', 1, '2026-09-20', 1, 0, 0, 1, 1, 'low']],
  HISTORY_W39,
  { 'a a': 'T9' }
);
assert(shared.unresolvedDrivers.length === 2 && shared.unresolvedDrivers.every((u) => u.reason === 'tid_shared_by_multiple_names'), 'two names → same TID stay unresolved');
// 既にTID行を持つTIDへの氏名解決は統合しない
const conflict = snapshotFrom([HEADER, ['T1', 'p', 'x', 1, '2026-09-20', 1, 0, 0, 1, 1, 'low'], ['', 'q', 'x', 3, '2026-09-20', 1, 0, 0, 1, 1, 'low']], HISTORY_W39, { q: 'T1' });
assert(conflict.unresolvedDrivers[0].reason === 'tid_already_in_snapshot', 'no merge into existing TID rows');

// 検証エラー
const noHistory = snapshotFrom(AREA_ROWS, null);
assert(!noHistory.ok && noHistory.snapshotThroughDate === '', 'missing importHistory blocks throughDate');
const badDate = snapshotFrom(AREA_ROWS, [HISTORY_HEADER, ['W39', '2026-09-20', '9月26日', '', '', 1, '']]);
assert(!badDate.ok, 'unparsable dateTo blocks');
const beyond = snapshotFrom(AREA_ROWS, [HISTORY_HEADER, ['W38', '2026-09-13', '2026-09-19', '', '', 1, '']]);
assert(!beyond.ok && beyond.errors.some((e) => e.indexOf('lastVisitDate') >= 0), 'lastVisitDate beyond dateTo blocks');

// Case 11: TID+area 重複 → 統合せず警告、表示は従来どおり後の行
const dupSnap = snapshotFrom([HEADER, ['T1', 'p', '原', 3, '2026-09-10', 1, 0, 0, 1, 1, 'low'], ['T1', 'p', '原', 5, '2026-09-20', 2, 0, 0, 1, 1, 'low']], HISTORY_W39, {});
assert(dupSnap.validation.duplicates.length === 1 && dupSnap.records.length === 2, 'Case11 duplicates kept, warned');
assert(AEC.mergeSnapshotAndEvents(dupSnap, []).byTransportId.T1.areas['原'].experienceDays === 5, 'Case11 legacy last-row semantics');

// Case 23 / 10: イベントなし → 従来の経験DB・アサイン結果と完全一致
const legacyRows = AREA_ROWS.filter((r, i) => i === 0 || r[0] !== '');
const legacyDb = AssignSupportCore.parseExperienceRows(legacyRows, { knownTransportIds: known });
const tidOnlySnap = snapshotFrom(legacyRows, HISTORY_W39);
const newDb = AEC.mergeSnapshotAndEvents(tidOnlySnap, [], { knownTransportIds: known });
assert(deepEqual(newDb.byTransportId, legacyDb.byTransportId), 'Case23 byTransportId identical to legacy');
assert(deepEqual(newDb.stats, legacyDb.stats), 'Case23 stats identical');
assert(AssignSupportCore.formatAreaSummary(newDb.byTransportId.TID_A, 3) === '東油山 28日 / 片江 27日 / 南片江 26日 / …', 'Case23 screen summary unchanged');

const pph = () => 18;
const workers = [
  { name: 'driver a', driverName: 'driver a', transportId: 'TID_A', shiftCode: '〇' },
  { name: 'driver b', driverName: 'driver b', transportId: 'TID_B', shiftCode: '〇' },
  { name: '新人 花子', driverName: '新人 花子', transportId: 'TID_NEW', shiftCode: '〇' },
];
const routes = [
  { routeCode: 'DSX10', packages: 90, stops: 70, areas: [{ label: '東油山', role: 'primary' }, { label: '片江', role: 'secondary' }] },
  { routeCode: 'DSX11', packages: 80, stops: 60, areas: [{ label: '原', role: 'primary' }] },
  { routeCode: 'DSX12', packages: 70, stops: 50, areas: [{ label: '別府', role: 'primary' }] },
];
const amz = [
  { routeCode: 'DCX20', driverName: 'driver a', serviceType: 'Standard Parcel', transportId: 'TID_A' },
  { routeCode: 'DCX40', driverName: 'driver b', serviceType: 'Standard Parcel', transportId: 'TID_B' },
];
const dcxRoutes = [
  { routeCode: 'DCX20', packages: 90, stops: 70, areas: [{ label: '西新', role: 'primary' }] },
  { routeCode: 'DCX40', packages: 90, stops: 70, areas: [{ label: '樋井川', role: 'primary' }] },
];
const plan = (db) => AssignSupportCore.buildFirstAssignPlan(routes, workers, db, { cycle: 3, getPackagesPerHour: pph });
const evalPlan = (db) => AssignSupportCore.buildAmazonAssignEvaluationPlan(dcxRoutes, workers.slice(0, 2), db, { cycle: 1, amazonAssignments: amz, getPackagesPerHour: pph });
assert(plan(newDb).routes.length === 3 && plan(newDb).routes[0].firstRecommendation, 'Case23 plan is non-trivial');
assert((evalPlan(newDb).swaps || []).length === 1, 'Case23 evaluation is non-trivial');
assert(deepEqual(plan(newDb), plan(legacyDb)), 'Case23 buildFirstAssignPlan identical');
assert(deepEqual(evalPlan(newDb), evalPlan(legacyDb)), 'Case23 buildAmazonAssignEvaluationPlan identical');

// Case 14: 自動更新でカウント系は不変（イベントありでも）
const ev1 = eventsOf([capture('2026-09-27', 'DSX10', 'TID_A', ADDR_HIGASHIABURAYAMA)]).events;
const m1 = AEC.mergeSnapshotAndEvents(snap, ev1, { knownTransportIds: known });
const before = merged0.byTransportId.TID_A.areas['東油山'];
const after = m1.byTransportId.TID_A.areas['東油山'];
['primaryCount', 'splitCount', 'rescueCount', 'stops', 'packages', 'confidence'].forEach((f) => {
  assert(before[f] === after[f], 'Case14 ' + f + ' preserved');
});
// Case 1: 翌日走行 → +1、lastVisitDate更新
assert(after.experienceDays === 29 && after.lastVisitDate === '2026-09-27', 'Case1 +1 and lastVisitDate');
assert(snap.records.find((r) => r.transportId === 'TID_A' && r.area === '東油山').experienceDays === 28, 'snapshot records not mutated');

// Case 2: 同一日・同一エリアを2Route → +1のみ
const ev2 = eventsOf([
  capture('2026-09-28', 'DSX10', 'TID_A', ADDR_HIGASHIABURAYAMA),
  capture('2026-09-28', 'DSX15', 'TID_A', ADDR_HIGASHIABURAYAMA),
]).events;
assert(ev2.length === 1 && ev2[0].routeCodes.length === 2, 'Case2 one event, two routes');
assert(AEC.mergeSnapshotAndEvents(snap, ev2).byTransportId.TID_A.areas['東油山'].experienceDays === 29, 'Case2 +1 only');

// Case 3 / 21 / 9: 同一データ再処理・同一Route複数回取得・再読込 → 増加なし
const caps = [capture('2026-09-27', 'DSX10', 'TID_A', ADDR_HIGASHIABURAYAMA), capture('2026-09-28', 'DSX10', 'TID_A', ADDR_HIGASHIABURAYAMA)];
const once = eventsOf(caps);
const twice = eventsOf(caps, once.store);
const thrice = eventsOf(caps.concat(caps), twice.store);
const d1 = AEC.mergeSnapshotAndEvents(snap, once.events).byTransportId.TID_A.areas['東油山'].experienceDays;
assert(d1 === 30, 'two days → +2');
assert(AEC.mergeSnapshotAndEvents(snap, thrice.events).byTransportId.TID_A.areas['東油山'].experienceDays === d1, 'Case3/21 reprocess no increase');
// Case 9: ページ再読込相当（JSONシリアライズ→復元→同データ再処理）
const restoredStore = JSON.parse(JSON.stringify(thrice.store));
const reloaded = eventsOf(caps, restoredStore);
const restoredSnap = JSON.parse(JSON.stringify(snap));
assert(AEC.mergeSnapshotAndEvents(restoredSnap, reloaded.events).byTransportId.TID_A.areas['東油山'].experienceDays === d1, 'Case9 reload + reprocess no increase');
// 古い取得が後から届いても最新状態を壊さない
const stale = AEC.upsertRouteCaptures(once.store, [capture('2026-09-27', 'DSX10', 'TID_B', ADDR_HIGASHIABURAYAMA, '2026-09-27T01:00:00Z')]);
assert(stale.ignoredStale === 1 && stale.store['2026-09-27|DSX10'].transporterId === 'TID_A', 'stale capture ignored');

// Case 20: 同一Routeの transporterId 変更 → 旧ドライバーのイベントは残らない
const reassigned = eventsOf([capture('2026-09-27', 'DSX10', 'TID_B', ADDR_HIGASHIABURAYAMA, '2026-09-27T23:00:00Z')], once.store);
const m20 = AEC.mergeSnapshotAndEvents(snap, reassigned.events);
assert(m20.byTransportId.TID_A.areas['東油山'].experienceDays === 29, 'Case20 old driver keeps only 9/28');
assert(m20.byTransportId.TID_B.areas['東油山'].experienceDays === 1, 'Case20 new driver gets 9/27 once');
assert(reassigned.events.filter((e) => e.serviceDate === '2026-09-27').length === 1, 'Case20 single event for that date');

// Case 7: スナップショット以前のRouteデータ → 加算なし（9/26は境界日当日）
const old = eventsOf([capture('2026-09-26', 'DSX10', 'TID_A', ADDR_HIGASHIABURAYAMA), capture('2026-09-11', 'DSX10', 'TID_A', ADDR_HIGASHIABURAYAMA)]).events;
const m7 = AEC.mergeSnapshotAndEvents(snap, old);
assert(m7.byTransportId.TID_A.areas['東油山'].experienceDays === 28 && m7.meta.eventsBeforeThrough === 2, 'Case7 events ≤ through ignored');
// Case 13 相当: 9/27 は加算される
assert(AEC.mergeSnapshotAndEvents(snap, eventsOf([capture('2026-09-27', 'X', 'TID_A', ADDR_HIGASHIABURAYAMA)]).events).byTransportId.TID_A.areas['東油山'].experienceDays === 29, 'Case13 day after through counts');

// Case 4: 新人の初走行 → 経験DBへ自動追加、1日
const ev4 = eventsOf([capture('2026-10-01', 'DSX12', 'TID_NEW', ADDR_BEPPU)]).events;
const m4 = AEC.mergeSnapshotAndEvents(snap, ev4, { knownTransportIds: known, driverNameByTid: { TID_NEW: '新人 花子' } });
assert(m4.byTransportId.TID_NEW && m4.byTransportId.TID_NEW.areas['別府'].experienceDays === 1, 'Case4 new driver 1 day');
assert(m4.byTransportId.TID_NEW.areas['別府'].lastVisitDate === '2026-10-01' && m4.byTransportId.TID_NEW.driverName === '新人 花子', 'Case4 lastVisit/name');
assert(m4.meta.newDriversFromEvents.indexOf('TID_NEW') >= 0, 'Case4 reported as new');

// Case 8: 未知のエリア → 統合せず未解決警告
const ev8 = AEC.deriveExperienceEvents({ k: { serviceDate: '2026-09-30', routeCode: 'R', transporterId: 'TID_A', areas: ['東油山二', '架空町'] } });
const m8 = AEC.mergeSnapshotAndEvents(snap, ev8);
assert(m8.byTransportId.TID_A.areas['東油山'].experienceDays === 28, 'Case8 not merged into similar area');
assert(m8.byTransportId.TID_A.areas['東油山二'].experienceDays === 1, 'Case8 kept as separate new area');
const unres = m8.meta.unresolvedAreas.map((u) => u.area);
assert(unres.indexOf('東油山二') >= 0 && unres.indexOf('架空町') >= 0, 'Case8 warned');
assert(m8.meta.unresolvedAreas.find((u) => u.area === '東油山二').similarSnapshotAreas.indexOf('東油山') >= 0, 'Case8 similar shown as info only');
// 完全一致（normalizeAreaToken後）は加算
const evExact = AEC.deriveExperienceEvents({ k: { serviceDate: '2026-09-30', routeCode: 'R', transporterId: 'TID_A', areas: ['福岡市東油山'] } });
assert(AEC.mergeSnapshotAndEvents(snap, evExact).byTransportId.TID_A.areas['東油山'].experienceDays === 29, 'normalized exact match merges');
// エリア抽出は既存関数と同一
const cap = AEC.normalizeRouteCapture(capture('2026-09-30', 'R', 'T', ['城南区荒江三丁目1-2, 福岡市, 福岡']));
assert(cap.capture.areas[0] === AssignSupportCore.extractAreaLabelsFromAddresses(['城南区荒江三丁目1-2, 福岡市, 福岡'])[0].label, 'area via existing extractor');

// Case 22: W40 スナップショット登録 → throughDate前進、W40以前のイベントは計算外
const HISTORY_W40 = HISTORY_W39.concat([['2026-W40', '2026-09-27', '2026-10-03', '2026-10-04T00:00:00Z', 'fp40', 3, 'weekly_W40.xlsx']]);
const AREA_W40 = AREA_ROWS.map((r) => r.slice());
AREA_W40[1] = ['TID_A', 'driver a', '東油山', 30, '2026-10-03', 32, 2, 1, 1250, 1530, 'high']; // 外部ツールで9/27,9/28を含めた確定値
const snap40 = snapshotFrom(AREA_W40, HISTORY_W40);
assert(snap40.snapshotThroughDate === '2026-10-03', 'Case22 throughDate advanced');
const eventsAcross = eventsOf([...caps, capture('2026-10-04', 'DSX10', 'TID_A', ADDR_HIGASHIABURAYAMA)]).events;
const m22 = AEC.mergeSnapshotAndEvents(snap40, eventsAcross);
assert(m22.byTransportId.TID_A.areas['東油山'].experienceDays === 31, 'Case22 only 10/4 added on top of W40');
assert(m22.meta.eventsBeforeThrough === 2 && eventsAcross.length === 3, 'Case22 events kept but excluded');

// Case 24: イベントあり → experienceDays/lastVisitDate のみ最新化、スコア関数は同一
const scoreBefore = AssignSupportCore.buildDriverRouteScore(workers[0], routes[0], merged0.byTransportId.TID_A, {});
const scoreAfter = AssignSupportCore.buildDriverRouteScore(workers[0], routes[0], m1.byTransportId.TID_A, {});
assert(scoreAfter.primaryExperienceDays === scoreBefore.primaryExperienceDays + 1, 'Case24 days updated in score');
assert(scoreAfter.primaryCount === scoreBefore.primaryCount && scoreAfter.primaryConfidence === scoreBefore.primaryConfidence, 'Case24 other inputs unchanged');
const manualDb = JSON.parse(JSON.stringify(merged0));
manualDb.byTransportId.TID_A.areas['東油山'].experienceDays = 29;
manualDb.byTransportId.TID_A.areas['東油山'].lastVisitDate = '2026-09-27';
assert(deepEqual(plan(m1), plan(manualDb)), 'Case24 plan == same scoring on hand-updated db');

// Case 25: 空欄だった既存ドライバーをTID解決 → アサイン評価へ反映
const ichiWorker = { name: '一郎 試験', driverName: '一郎 試験', transportId: 'TID_ICHI', shiftCode: '〇' };
const s25 = AssignSupportCore.buildDriverRouteScore(ichiWorker, routes[2], merged0.byTransportId.TID_ICHI, {});
assert(s25.primaryExperienceDays === 12, 'Case25 resolved driver experience used in scoring');
assert(AssignSupportCore.buildDriverRouteScore(ichiWorker, routes[2], legacyDb.byTransportId.TID_ICHI, {}).primaryExperienceDays === 0, 'Case25 legacy had none');

// Case 5 / 6: マスタのみ（経験なし）・能力null でも一覧に表示
const list = AEC.buildExperienceDriverList(m1, MASTER);
const newbie = list.find((it) => it.transportId === 'TID_NEW');
assert(newbie && !newbie.hasExperience && newbie.driverName === '新人 花子', 'Case5 master-only driver listed without experience');
const pphNull = list.find((it) => it.transportId === 'TID_PPHNULL');
assert(pphNull, 'Case6 driver listed regardless of capability');
assert(AssignSupportCore.getPackagesPerHour('pph null', 'TID_PPHNULL', () => ({ packagesPerHour: null }), MASTER, null) === null, 'Case6 capability null (rendered as -)');
assert(list.find((it) => it.transportId === 'TID_ICHI').hasExperience, 'resolved snapshot driver listed with experience');
const onlyNone = AEC.filterExperienceDriverList(list, '', { onlyWithoutExperience: true });
assert(onlyNone.every((it) => !it.hasExperience) && onlyNone.some((it) => it.transportId === 'TID_NEW'), 'no-experience filter');
assert(AEC.filterExperienceDriverList(list, '別府').some((it) => it.transportId === 'TID_ICHI'), 'search by area');
const evOnly = AEC.buildExperienceDriverList(m4, { 'driver a': 'TID_A' });
assert(evOnly.some((it) => it.transportId === 'TID_NEW' && it.hasExperience && !it.inMaster), 'event-only driver in union');

const stats = AEC.buildExperienceOverviewStats(list, snap, m1);
assert(stats.masterDriverCount === 7 && stats.unresolvedDriverCount === 2, 'overview master/unresolved counts');
assert(stats.withExperienceCount + stats.withoutExperienceCount === list.length, 'overview with/without');
assert(stats.snapshotThroughDate === '2026-09-26' && stats.eventLastDate === '2026-09-27', 'overview dates');
assert(stats.missingPeriods.length === 1, 'overview missing periods');

// 日付ユーティリティ
assert(AEC.toIsoDate('2026/9/5') === '2026-09-05' && AEC.toIsoDate('2026-02-30') === '' && AEC.toIsoDate(46291) === '2026-09-26', 'toIsoDate formats');

// ===== Phase 1B: alias / 日本語名 / resolutionMethod =====
{
  const master = { 'taro yamada': 'T_TARO', 'hanako suzuki': 'T_HANA', 'jiro sato': '' };
  const jp = { 'taro yamada': '太郎 山田', 'jiro sato': '次郎 佐藤' };
  const aliases = {
    'たろう やまだ': 'taro yamada', // 明示的な別名 → T_TARO
    'yamada taro': 'taro yamada', // 姓名入替のみ（自動登録の可能性）→ 使わない
    'はなこ': 'missing name', // 正キーがマスタに無い → 使わない
    '次郎': 'jiro sato', // 正キーのTIDが空 → 使わない
    'dup alias': 'hanako suzuki',
  };
  const idx2 = AEC.buildDriverNameIndex(master, jp, aliases);
  const r1 = AEC.resolveTransportIdByExactName('taro yamada', idx2);
  assert(r1.transportId === 'T_TARO' && r1.resolutionMethod === 'exact_name', 'exact_name method');
  const r2 = AEC.resolveTransportIdByExactName('太郎　山田', idx2);
  assert(r2.transportId === 'T_TARO' && r2.resolutionMethod === 'master_japanese_name', 'master_japanese_name method');
  const r3 = AEC.resolveTransportIdByExactName('たろう やまだ', idx2);
  assert(r3.transportId === 'T_TARO' && r3.resolutionMethod === 'alias', 'alias method');
  assert(AEC.resolveTransportIdByExactName('yamada taro', idx2).transportId === '', 'reversal alias not used');
  assert(AEC.resolveTransportIdByExactName('はなこ', idx2).transportId === '', 'alias to missing canonical not used');
  assert(AEC.resolveTransportIdByExactName('次郎 佐藤', idx2).reason === 'master_has_no_transport_id', 'jp name without TID → reason');
  const excludedReasons = idx2.excludedAliases.map((x) => x.reason).sort().join(',');
  assert(excludedReasons === 'canonical_has_no_transport_id,canonical_not_in_master,name_reversal_alias', 'excluded aliases reported');
  // 優先順位: exact_name > master_japanese_name > alias（alias が正式名より優先されない）
  const idx3 = AEC.buildDriverNameIndex({ 'dup alias': 'T_OTHER', 'hanako suzuki': 'T_HANA' }, {}, { 'dup alias': 'hanako suzuki' });
  const r4 = AEC.resolveTransportIdByExactName('dup alias', idx3);
  assert(r4.transportId === 'T_OTHER' && r4.resolutionMethod === 'exact_name', 'exact_name wins over conflicting alias');
  assert(r4.lowerTierCandidates.length === 1 && r4.lowerTierCandidates[0].transportId === 'T_HANA', 'lower-tier conflict recorded');
  const idxJp = AEC.buildDriverNameIndex({ 'a b': 'T_JP', 'c d': 'T_AL' }, { 'a b': '花子 鈴木' }, { '花子 鈴木': 'c d' });
  const r5 = AEC.resolveTransportIdByExactName('花子 鈴木', idxJp);
  assert(r5.transportId === 'T_JP' && r5.resolutionMethod === 'master_japanese_name', 'japanese name wins over alias');
  // 同じ alias 文字列（正規化後）が別々のTIDへ → 自動解決しない
  const idxAA = AEC.buildDriverNameIndex({ x1: 'T1', x2: 'T2' }, {}, { 'old name': 'x1', 'OLD  NAME': 'x2' });
  const r6 = AEC.resolveTransportIdByExactName('old name', idxAA);
  assert(r6.transportId === '' && r6.reason === 'multiple_candidates', 'same alias to two TIDs → unresolved');
  // 正式名がマスタにあるがTID未登録 → alias へフォールバックしない
  const idxNo = AEC.buildDriverNameIndex({ 'same name': '', other: 'T_O' }, {}, { 'same name': 'other' });
  const r7 = AEC.resolveTransportIdByExactName('same name', idxNo);
  assert(r7.transportId === '' && r7.reason === 'master_has_no_transport_id', 'no fallback to alias when exact master row lacks TID');
  // 氏名修正・統合済み（明示alias、旧氏名 → 新正式名）は一意なら解決
  const idxRen = AEC.buildDriverNameIndex({ '新姓 花子': 'T_REN' }, {}, { '旧姓 花子': '新姓 花子' });
  const r8 = AEC.resolveTransportIdByExactName('旧姓 花子', idxRen);
  assert(r8.transportId === 'T_REN' && r8.resolutionMethod === 'alias', 'renamed driver resolved via explicit alias');
  // 姓名入替のみのaliasは除外され、入替名では解決しない
  const idxRev = AEC.buildDriverNameIndex({ '花子 新姓': 'T_R' }, {}, { '新姓 花子': '花子 新姓' });
  assert(AEC.resolveTransportIdByExactName('新姓 花子', idxRev).transportId === '', 'reversal-only alias never resolves');
  // スナップショット経由で method が残る
  const aliasSnap = snapshotFrom([HEADER, ['', 'たろう やまだ', '原', 4, '2026-09-20', 1, 0, 0, 1, 1, 'low']], HISTORY_W39, master, { driverJapaneseNames: jp, driverNameAliases: aliases });
  const ar = aliasSnap.resolvedDrivers[0];
  assert(ar.resolvedTransportId === 'T_TARO' && ar.resolutionMethod === 'alias', 'snapshot resolvedDrivers carry method');
  assert(aliasSnap.resolutionSummary.methodCounts.alias === 1, 'resolutionSummary methodCounts');
}

// ===== Phase 1B: 保存→復元（登録時の解決結果を固定） =====
{
  const payload = AEC.buildSnapshotSavePayload(snap, { knownTransportIds: known, updatedAt: '2026-10-01' });
  const restoredSaved = JSON.parse(JSON.stringify(payload.snapshot));
  const restored = AEC.restoreSnapshotLayer(restoredSaved);
  assert(restored.ok && restored.snapshotThroughDate === '2026-09-26', 'restore ok with throughDate');
  assert(restored.resolutionSummary.usedFixedResolution, 'restore uses fixed resolution');
  assert(deepEqual(restored.records, snap.records), 'restored records identical to registration');
  assert(deepEqual(AEC.mergeSnapshotAndEvents(restored, []).byTransportId, merged0.byTransportId), 'restored experienceDb identical');
  assert(restored.unresolvedDrivers.length === snap.unresolvedDrivers.length, 'unresolved preserved on restore');
  assert(restored.unresolvedDrivers.every((u) => u.latestLastVisitDate), 'unresolved latestLastVisitDate available');
  assert(deepEqual(restored.rawRows, snap.rawRows), 'rawRows identical after save/restore');
}

// ===== Phase 1B: TID既存ドライバーの全項目互換（旧方式との一致） =====
{
  const legacyAll = AssignSupportCore.parseExperienceRows(AREA_ROWS, { knownTransportIds: known });
  const nb = AEC.mergeSnapshotAndEvents(AEC.restoreSnapshotLayer(JSON.parse(JSON.stringify(AEC.buildSnapshotSavePayload(snap).snapshot))), []);
  ['TID_A', 'TID_B'].forEach((tid) => {
    assert(deepEqual(nb.byTransportId[tid], legacyAll.byTransportId[tid]), 'all fields identical for ' + tid);
  });
}

console.log('area-experience-core tests passed (' + passed + ' assertions)');
