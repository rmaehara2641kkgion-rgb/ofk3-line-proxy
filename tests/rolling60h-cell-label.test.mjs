import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const RC = require('../rolling60h-core.js');

const rows = [
  ['transporter_id', 'working_day', 'station_code', 'estimated_working_hour'],
  ['TID-A', '2026-10-20', 'OFK3', 10.355277],
  ['TID-A', '2026-10-19', 'OFK3', ''],
  ['TID-A', '2026-10-18', 'OFK3', 'estimated_working_hour'],
  ['TID-B', '2026-10-20', 'OFK3', 9.988888],
  ['TID-SAME', '2026-10-20', 'OFK3', 8],
  ['TID-OTHER', '2026-10-20', 'OFK3', 4],
];
const parsed = RC.parseAmazonDailyRows(rows);
const byTid = RC.groupActualRecordsByTransportId(parsed.records);
const dayA = RC.buildDayRecord('2026-10-20', byTid['TID-A']['2026-10-20']);
assert.equal(dayA.dailyTotalHours, 10.355277);
assert.equal(dayA.blocks[0].rawCode, '(estimated_working_hour)');
assert.equal(RC.formatRollingBlockLabel(dayA.blocks[0]), '10時間21分 実績');
assert.equal(RC.formatRollingBlockLabel(dayA.blocks[0]).includes('estimated_working_hour'), false);

const missing = RC.buildDayRecord('2026-10-19', byTid['TID-A']['2026-10-19']);
assert.equal(missing.blocks[0].hours, null);
assert.equal(missing.hasUndefinedHours, true);
assert.equal(RC.formatRollingBlockLabel(missing.blocks[0]), '未取得');
const around = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'].map((date) => (
  date === '2026-10-19' ? missing : RC.buildDayRecord(date, RC.parseShiftCellToBlocks('休', 'roster').blocks)
));
const missingWindow = RC.computeRolling60h(around, { limitHours: 60 });
assert.equal(missingWindow[0].judgment, 'undetermined');
assert.equal(missingWindow[0].over, false);

const leakedHeader = RC.buildDayRecord('2026-10-18', byTid['TID-A']['2026-10-18']);
assert.equal(leakedHeader.blocks[0].hours, null);
assert.equal(leakedHeader.hasUndefinedHours, true);
assert.equal(RC.formatRollingBlockLabel(leakedHeader.blocks[0]), '未取得');

assert.equal(RC.formatRollingBlockLabel(byTid['TID-B']['2026-10-20'][0]), '9時間59分 実績');
assert.notEqual(byTid['TID-SAME']['2026-10-20'][0].hours, byTid['TID-OTHER']['2026-10-20'][0].hours);

const off = RC.parseShiftCellToBlocks('休', 'roster').blocks[0];
assert.equal(RC.formatRollingBlockLabel(off), '休');
const plan = RC.parseShiftCellToBlocks('○', 'roster').blocks[0];
assert.equal(RC.formatRollingBlockLabel(plan), '○ 予定');
assert.equal(plan.hours, 11);
const blankParsed = RC.parseShiftCellToBlocks('', 'roster');
assert.equal(blankParsed.blocks.length, 0);
assert.equal(RC.formatRollingBlockLabel({ blank: true, source: 'roster', hours: null, defined: false, rawCode: '' }), '未取得');
const bad = RC.parseShiftCellToBlocks('C2', 'roster').blocks[0];
assert.equal(RC.formatRollingBlockLabel(bad), '判定不能');
assert.equal(bad.defined, false);

const series = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'].map((date, index) => ({
  date: date,
  blocks: [],
}));
const exact = {};
const over = {};
series.forEach((day, index) => {
  exact[day.date] = index === 6 ? '休' : 'bike';
  over[day.date] = '○';
});
function windowsFor(codes) {
  return RC.computeRolling60h(series, { limitHours: 60, overrides: codes });
}
assert.equal(windowsFor(exact)[0].totalHours, 60);
assert.equal(windowsFor(exact)[0].over, false);
assert.equal(windowsFor(over)[0].totalHours, 77);
assert.equal(windowsFor(over)[0].over, true);

const ui = require('fs').readFileSync(new URL('../rolling60h-ui.js', import.meta.url), 'utf8');
assert.match(ui, /formatRollingBlockLabel/);
assert.equal(ui.includes("b.code === 'AMAZON_ACTUAL'"), false);

console.log('rolling60h-cell-label.test.mjs: ALL PASSED');
