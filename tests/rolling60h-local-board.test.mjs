import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Run = require('../harvest-rolling60h-run.js');
const Rolling = require('../rolling60h-core.js');
const Harvest = require('../harvest-daily-manifest.js');
const DryRun = require('../inoichi-rolling-dryrun.js');
const Dash = require('../duty-risk-dashboard.js');
const Snap = require('../duty-risk-snapshot.js');
const Board = require('../rolling60h-local-board.js');
const Store = require('../rolling60h-local-store.js');
const XLSX = require('../node_modules/xlsx/xlsx.js');

const days = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'];
const REF = '2026-10-17';
const header = ['transporter_id', 'working_day', 'estimated_working_hour', 'station_code'];

function shiftBook(rows) {
  const head = ['社名', '名前', 'Transport ID'].concat(days.map((iso) => {
    const p = iso.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head].concat(rows)), 'GDS');
  return wb;
}
function daily(tid, hours) {
  return hours.map((h, i) => (h == null ? null : [tid, days[i], h, 'OFK3'])).filter(Boolean);
}
const MARU = '○'; // 11h

// 6日分のデイリー実績 + 今日(17日)はシフト予定○=11h
const rows = [
  ['GDS', 'Under Fiction', 'T-UNDER'].concat(Array(7).fill(MARU)),
  ['GDS', 'Exact Fiction', 'T-EXACT'].concat(Array(7).fill(MARU)),
  ['GDS', 'Over Fiction', 'T-OVER'].concat(Array(7).fill(MARU)),
  ['GDS', 'Gap Fiction', 'T-GAP'].concat([MARU, MARU, '', MARU, MARU, MARU, MARU]),
];
const dailyRows = [header]
  .concat(daily('T-UNDER', [8, 8, 8, 8, 8, 8]))   // 48 + 11 = 59
  .concat(daily('T-EXACT', [8, 8, 8, 8, 8, 9]))   // 49 + 11 = 60
  .concat(daily('T-OVER', [8, 8, 8, 8, 8, 10]))   // 50 + 11 = 61
  .concat(daily('T-GAP', [8, 8, null, 8, 8, 8])); // 13日が実績もシフトもない

function execute(extra) {
  return Run.capture(Object.assign({
    xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun,
    dailyRows, dailyFileName: 'Daily_FICTION.xlsx',
    shiftBook: shiftBook(rows), shiftFileName: 'shift_FICTION.xlsx',
    referenceDate: REF,
  }, extra || {}));
}

const executed = execute();
assert.equal(executed.summary.fileSuccess, 2);
assert.equal(executed.summary.fileFailure, 0);
assert.equal(executed.summary.dailyReason, 'ok');
assert.equal(executed.historyFile, false, '注入入力では履歴ファイルを書かない');

const deps = { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf };
const board = Board.buildBoard({
  executed, referenceDate: REF, generatedAt: '2026-10-17T03:00:00.000Z',
  files: { shift: { name: 'shift_FICTION.xlsx', ok: true }, daily: { name: 'Daily_FICTION.xlsx', ok: true } },
  names: { 'T-UNDER': 'Under Fiction', 'T-EXACT': 'Exact Fiction', 'T-OVER': 'Over Fiction' },
}, deps);
assert.equal(Board.validateBoard(board), true);
const byId = Object.fromEntries(board.rows.map((r) => [r.transportId, r]));

// 60時間未満 / ちょうど60時間 / 超過（既存エンジンの判定: 超過は > 60、接近は = 60）
assert.equal(byId['T-UNDER'].status, 'clear');
assert.equal(byId['T-UNDER'].forecast.hours, 59);
assert.equal(byId['T-EXACT'].status, 'approach');
assert.equal(byId['T-EXACT'].forecast.hours, 60);
assert.equal(byId['T-OVER'].status, 'exceed');
assert.equal(byId['T-OVER'].forecast.hours, 61);

// 残り時間: 勤務可能上限 = 60 - 過去6日、予定終了後の余裕 = 60 - 7日合計
assert.equal(byId['T-UNDER'].past6.hours, 48);
assert.equal(byId['T-UNDER'].workable.hours, 12);
assert.equal(byId['T-UNDER'].workable.confirmed, true, '過去6日が実績だけなら確定値');
assert.equal(byId['T-UNDER'].marginAfterPlan.hours, 1);
assert.equal(byId['T-UNDER'].marginAfterPlan.confirmed, false, '今日が予定なので暫定');
assert.equal(byId['T-EXACT'].marginAfterPlan.hours, 0);
assert.equal(byId['T-OVER'].marginAfterPlan.hours, -1);
board.rows.forEach((r) => {
  if (r.past6.hours != null) assert.equal(r.workable.hours, 60 - r.past6.hours);
  if (r.forecast.hours != null) assert.equal(r.marginAfterPlan.hours, 60 - r.forecast.hours);
});
assert.equal(byId['T-UNDER'].days.length, 7);
assert.equal(byId['T-UNDER'].days[0].adopted, '実績（Amazon推定）');
assert.equal(byId['T-UNDER'].days[6].adopted, '予定');

// 欠損は確定値にしない（0にもしない）。正常扱いにもしない
const gap = byId['T-GAP'];
assert.ok(['partial', 'undetermined'].includes(gap.status), '欠損者は部分欠損/判定不能');
assert.equal(gap.workable.hours == null || gap.workable.confirmed === false, true);
assert.ok(gap.gaps.length > 0);

// 件数は既存集計と一致し、排他
const c = board.counts;
assert.equal(c.exceed, executed.summary.exceedCount);
assert.equal(c.approach, executed.summary.approachCount);
assert.equal(c.partial, executed.summary.partialCount);
assert.equal(c.undetermined, executed.summary.undeterminedCount);
assert.equal(c.clear, executed.summary.clearCount);
assert.equal(c.exceed + c.approach + c.partial + c.undetermined + c.clear, c.driverCount);
assert.equal(board.completeness, 'partial');

// 並び順・検索
assert.equal(Board.sortRows(board.rows, 'risk')[0].transportId, 'T-OVER');
assert.equal(Board.sortRows(board.rows, 'margin')[0].transportId, 'T-OVER');
assert.deepEqual(Board.filterRows(board.rows, 'exact').map((r) => r.transportId), ['T-EXACT']);
assert.deepEqual(Board.filterRows(board.rows, 't-under').map((r) => r.transportId), ['T-UNDER']);
assert.equal(Board.filterRows(board.rows, '').length, board.rows.length);

// デイリー欠損: 入力不足として明示し、完全判定にしない
const noDaily = execute({ dailyRows: null });
assert.equal(noDaily.summary.dailyReason, 'not-provided');
assert.equal(noDaily.summary.fileFailure, 1);
const incompleteBoard = Board.buildBoard({
  executed: noDaily, referenceDate: REF, generatedAt: '2026-10-17T03:00:00.000Z',
  files: { shift: { name: 's', ok: true }, daily: { name: '', ok: false } },
}, deps);
assert.equal(incompleteBoard.completeness, 'incomplete-input');
assert.equal(Board.buildFridaySummary(incompleteBoard, '2026-10-17T03:10:00.000Z').data.safeToAnnounceAsComplete, false);

// 鮮度: 12時間以内かつ基準日が今日なら fresh、それ以外は stale
assert.equal(Board.freshness(board, '2026-10-17T05:00:00.000Z').status, 'fresh');
assert.ok(Board.freshness(board, '2026-10-17T20:00:00.000Z').reasons.includes('age-over-limit'));
// 日付境界: UTC 15:00 = JST 翌日 00:00 で基準日が今日でなくなる
assert.equal(Board.jstDate('2026-10-17T14:59:59.000Z'), '2026-10-17');
assert.equal(Board.jstDate('2026-10-17T15:00:00.000Z'), '2026-10-18');
assert.deepEqual(Board.freshness(board, '2026-10-17T15:00:00.000Z').reasons, ['reference-date-not-today']);
assert.equal(Board.freshness(board, '2026-10-17T15:00:00.000Z').status, 'stale');
assert.equal(Board.freshness(null, '2026-10-17T05:00:00.000Z').status, 'unknown');

// FRIDAY要約: 人数・日時・鮮度・欠損状態のみ。氏名・IDを含まない
const summary = Board.buildFridaySummary(board, '2026-10-17T05:00:00.000Z');
assert.equal(summary.kind, 'ofk3.rolling60h.friday-summary');
assert.equal(summary.counts.exceed, 1);
assert.equal(summary.counts.approach, 1);
assert.equal(summary.counts.undetermined, c.undetermined);
assert.equal(summary.freshness.status, 'fresh');
assert.equal(summary.data.completeness, 'partial');
assert.equal(summary.data.safeToAnnounceAsComplete, false, '部分欠損があれば完全扱いにしない');
const packed = JSON.stringify(summary);
['Fiction', 'T-UNDER', 'T-EXACT', 'T-OVER', 'T-GAP'].forEach((s) => assert.equal(packed.includes(s), false, '個人情報を含まない: ' + s));
const empty = Board.buildFridaySummary(null, '2026-10-17T05:00:00.000Z');
assert.equal(empty.data.completeness, 'no-data');
assert.equal(empty.counts.exceed, null, 'データなしは0人ではなく null');

// ---- IndexedDB 保存: 前回の正常データを壊さない（最小のIndexedDB代替）----
function fakeIdb() {
  const data = {};
  let failNextWrite = false;
  const idb = {
    failWrite() { failNextWrite = true; },
    data,
    open() {
      const request = {};
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          transaction() {
            const pending = {};
            const tx = {
              objectStore() {
                return {
                  put(value, key) { pending[key] = JSON.parse(JSON.stringify(value)); },
                  get(key) {
                    const r = {};
                    setTimeout(() => { r.result = data[key] === undefined ? undefined : JSON.parse(JSON.stringify(data[key])); r.onsuccess && r.onsuccess(); }, 0);
                    return r;
                  },
                };
              },
            };
            setTimeout(() => {
              if (!Object.keys(pending).length) return;
              if (failNextWrite) { failNextWrite = false; tx.error = new Error('quota'); tx.onabort && tx.onabort(); return; }
              Object.assign(data, pending);
              tx.oncomplete && tx.oncomplete();
            }, 0);
            return tx;
          },
        };
        request.onupgradeneeded && request.onupgradeneeded();
        request.onsuccess && request.onsuccess();
      }, 0);
      return request;
    },
  };
  return idb;
}
const idb = fakeIdb();
const mirror = {};
const store = Store.create({ indexedDB: idb, validate: Board.validateBoard, localStorage: { setItem: (k, v) => { mirror[k] = v; } } });
await store.save(board, summary);
assert.equal((await store.loadBoard()).generatedAt, board.generatedAt);
assert.equal((await store.loadSummary()).counts.exceed, 1);
assert.equal(JSON.parse(mirror[Store.MIRROR_KEY]).kind, 'ofk3.rolling60h.friday-summary');

const newer = JSON.parse(JSON.stringify(board));
newer.generatedAt = '2026-10-17T09:00:00.000Z';
idb.failWrite();
await assert.rejects(() => store.save(newer, summary));
assert.equal((await store.loadBoard()).generatedAt, board.generatedAt, '書き込み失敗でも前回の正常データが残る');
await assert.rejects(() => store.save({ kind: 'broken' }, summary), /invalid-board/);
assert.equal((await store.loadBoard()).generatedAt, board.generatedAt, '不正なボードは保存されない');
const noIdb = Store.create({ indexedDB: null, validate: Board.validateBoard });
await assert.rejects(() => noIdb.save(board, summary), /indexeddb-unavailable/);

// ---- 画面の配線 ----
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
['wh60-local-root', 'rolling60h-board-ui.js', 'rolling60h-local-board.js', 'rolling60h-local-store.js', 'harvest-rolling60h-run.js', 'inoichi-rolling-dryrun.js', 'Rolling60hBoardUI.onShown'].forEach((token) => {
  assert.ok(html.includes(token), 'index.html に ' + token);
});
assert.ok(html.includes('duty-risk-dashboard.js'), '既存のGAS/Render経路のスクリプトは残す');
const ui = fs.readFileSync(new URL('../rolling60h-board-ui.js', import.meta.url), 'utf8');
['データ取込', '残り時間・リスク一覧', 'シフト格子（既存）', 'このブラウザ'].forEach((t) => assert.ok(ui.includes(t), 'UI文言 ' + t));
assert.equal(/fetch\(|XMLHttpRequest|harvest:handoff/.test(ui), false, '外部通信・handoff送信をしない');

console.log('rolling60h-local-board.test.mjs: ALL PASSED');
