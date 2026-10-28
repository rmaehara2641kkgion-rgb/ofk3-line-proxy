import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const boardSource = fs.readFileSync(new URL('../rolling60h-local-board.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../rolling60h-board-ui.js', import.meta.url), 'utf8');
const dutySource = fs.readFileSync(new URL('../duty-risk-dashboard.js', import.meta.url), 'utf8');
const context = { console, window: {} };
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(boardSource, context);
vm.runInContext(uiSource, context);
const ui = context.window.Rolling60hBoardUI;
assert.equal(typeof ui.printHtml, 'function');

function row(fields) {
  return Object.assign({
    judgmentProvisional: false,
    judgmentRank: 4,
    rank: 4,
    marginAfterPlan: { hours: 12 },
    futureExceed: null,
  }, fields);
}

const board = {
  referenceDate: '2026-10-28',
  windowStart: '2026-10-22',
  generatedAt: '2026-10-27T15:00:00.000Z',
  rows: [
    row({
      transportId: 'T-CLOSE',
      name: '架空 接近',
      judgment: 'forecast-exceed',
      judgmentLabel: '超過予測',
      judgmentProvisional: true,
      judgmentRank: 1,
      past6: { hours: 51 + 44 / 60 },
      forecast: { hours: 62 + 44 / 60 },
      workable: { hours: 8 + 16 / 60 },
      marginAfterPlan: { hours: -2.733 },
      futureExceed: { start: '2026-11-01', end: '2026-11-07', count: 2, overBy: 1.5 },
    }),
    row({
      transportId: 'T-GAP',
      name: '架空 欠損',
      judgment: 'review',
      judgmentLabel: '要確認',
      judgmentProvisional: true,
      judgmentRank: 3,
      past6: { hours: null },
      forecast: { hours: null },
      workable: { hours: null },
      marginAfterPlan: { hours: null },
    }),
    row({
      transportId: 'T-REST',
      name: '架空 休日',
      judgment: 'ok',
      judgmentLabel: '正常',
      past6: { hours: 0 },
      forecast: { hours: 0 },
      workable: { hours: 60 },
    }),
  ],
};

function rowSlice(html, token) {
  const at = html.indexOf(token);
  assert.ok(at >= 0, token);
  const start = html.lastIndexOf('<tr>', at);
  return html.slice(start < 0 ? at : start, html.indexOf('</tr>', at));
}

const printed = ui.printHtml(board, '', 'risk', '2026-10-28T01:02:03.000Z');
assert.match(printed, /<meta charset="utf-8">/);
assert.match(printed, /@page\{size:A4 landscape;margin:6mm;\}/);
assert.match(printed, /thead\{display:table-header-group;\}/);
assert.match(printed, /page-break-inside:avoid/);
assert.match(printed, /window\.print\(\)/);
assert.match(printed, /対象日 2026-10-28/);
assert.match(printed, /判定対象期間 2026-10-22 〜 2026-10-28/);
assert.match(printed, /出力日時 2026-10-28 10:02:03/);
assert.match(printed, /検索条件 なし。並び順 リスク順。/);
assert.match(printed, /要確認は時間を決められない状態で、0時間にはしていません/);
const closeSlice = rowSlice(printed, '架空 接近');
assert.match(closeSlice, /51:44/);
assert.match(closeSlice, /62:44/);
assert.match(closeSlice, /08:16/);
assert.match(closeSlice, /▲超過予測・暫定/);
assert.match(closeSlice, /将来超過あり \+01:30/);
assert.match(closeSlice, /2026-11-01〜2026-11-07 ほか1件/);
assert.equal(closeSlice.includes('51.7'), false);
const gapSlice = rowSlice(printed, '架空 欠損');
assert.match(gapSlice, /？要確認・暫定/);
assert.equal((gapSlice.match(/要確認/g) || []).length >= 4, true);
assert.equal(gapSlice.includes('00:00'), false);
const restSlice = rowSlice(printed, '架空 休日');
assert.match(restSlice, /00:00/);
assert.match(restSlice, /○正常/);
const filtered = ui.printHtml(board, '架空 接近', 'name', '2026-10-28T01:02:03.000Z');
assert.equal(filtered.includes('架空 接近'), true);
assert.equal(filtered.includes('架空 欠損'), false);
assert.equal(filtered.includes('架空 休日'), false);
assert.match(filtered, /検索条件 架空 接近。並び順 氏名順。/);
assert.match(ui.printHtml(board, '   ', 'margin', '2026-10-28T01:02:03.000Z'), /検索条件 なし。並び順 余裕が少ない順。/);

assert.equal(uiSource.includes('data-local60-print="1"'), true);
assert.equal(uiSource.includes('算出不可'), false);
assert.equal(uiSource.includes('氏名なし'), false);
assert.equal(/fetch\(|XMLHttpRequest|harvest:handoff/.test(uiSource), false);
assert.equal(dutySource.includes('data-duty-print="1"'), true);
assert.equal(fs.readFileSync(new URL('../rolling60h-local-board.js', import.meta.url), 'utf8').includes('印刷／PDF保存'), false);

console.log('rolling60h-board-print.test.mjs: ALL PASSED');
