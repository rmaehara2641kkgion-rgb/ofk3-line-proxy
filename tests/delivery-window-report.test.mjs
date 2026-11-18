import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = require(join(root, 'delivery-window-core.js'));
const R = require(join(root, 'delivery-window-report.js'));
const XLSX = require('xlsx');

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
}
function srt(o) { const r = {}; Object.keys(o).sort().forEach((k) => { r[k] = o[k]; }); return r; }
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok - ' + name); } catch (e) { console.error('  NOT OK - ' + name + '\n' + e.message); process.exit(1); }
}

// ---- synthetic fixtures ----
const REF = '2026-11-17';
const D = REF + ' ';
const id = (n) => 'DA' + String(n).padStart(10, '0');
const HEAD = 'Tracking ID,Last Updated Time,Scheduled Delivery Start Time,Scheduled Delivery End Time,Promised Delivery Date';
function srLine(n, s, e, p) { return [id(n), '2026-11-17 09:00:00', s || '', e || '', p === undefined ? REF : p].join(','); }
function srCsv(lines) { return '﻿' + HEAD + '\r\n' + lines.join('\r\n') + '\r\n'; }

// Elimination workbook: Cycle1 (mixed heading) ids c1, Cycle2 ("16-18時指定") ids c2
function workbook(c1, c2, opts) {
  const o = opts || {};
  const rows = [
    [null, null, null, null, null, null],
    [null, 'RTS報告', null, null, null, null],
    [null, null, null, null, null, null],
    [null, '日付', 46343, null, null, null],
    [null, 'Node', 'OFK3', null, null, null],
    [null, null, null, null, null, null],
    [null, 'Cycle1', null, null, 'Cycle2', null],
    [null, 'AM指定・14-16指定・BC', null, null, '16-18時指定', null],
    [null, '番号', o.noIdHeader ? '備考' : 'トラッキングID', null, '番号', o.noIdHeader ? '備考' : 'トラッキングID']
  ];
  const n = Math.max(c1.length, c2.length);
  for (let i = 0; i < n; i++) rows.push([null, i + 1, c1[i] === undefined ? null : id(c1[i]), null, i + 1, c2[i] === undefined ? null : id(c2[i])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), o.sheetName || 'エリミネーション報告');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['TRID'], [id(999)]]), '未配報告');
  return wb;
}
function ingest(lines, c1, c2, opts, extra) {
  return R.ingest(Object.assign({ srText: srCsv(lines), XLSX, workbook: workbook(c1, c2, opts) }, extra || {}));
}

// A broad synthetic scenario (ids are local to the fixture):
//  1 Cycle1  08-12                      -> readable always
//  2 Cycle2  16-18                      -> readable always
//  3 Cycle2  08-22                      -> conflict_elimi only (heading)
//  4 Cycle2  blank                      -> time_blank
//  5 Cycle2  not in SR                  -> not_in_sr
//  6 Cycle2  date mismatch + heading    -> date_mismatch (+conflict_elimi)
//  7 Cycle2  window yesterday           -> date_out_of_range (+conflict_elimi)
//  8 Cycle2  one side blank             -> time_partial
//  9 Cycle1  also in Cycle2             -> dup_cycle_elimi
// 20 SR only                             -> not in target set
const LINES = [
  srLine(1, D + '08:00:00', D + '12:00:00'),
  srLine(2, D + '16:00:00', D + '18:00:00'),
  srLine(3, D + '08:00:00', D + '22:00:00'),
  srLine(4, '', ''),
  srLine(6, '2026-11-18 08:00:00', '2026-11-18 12:00:00', REF),
  srLine(7, '2026-11-16 18:00:00', '2026-11-16 23:59:00', '2026-11-16'),
  srLine(8, D + '08:00:00', ''),
  srLine(9, D + '08:00:00', D + '12:00:00'),
  srLine(20, D + '08:00:00', D + '12:00:00')
];
const C1 = [1, 9];
const C2 = [2, 3, 4, 5, 6, 7, 8, 9];

console.log('delivery-window-report tests');

// ---------- primary + all reasons ----------
t('every target gets exactly one primary reason and the counts add up to the target total', () => {
  const g = ingest(LINES, C1, C2);
  assert(g.ok, 'ingest ok');
  const s = R.reasonSummary(g.table);
  eq(s.total, 9, 'targets (ids 1,2,3,4,5,6,7,8,9)');
  eq(Object.keys(s.counts).reduce((a, k) => a + s.counts[k], 0), 9, 'sum');
  eq(srt(s.counts), srt({ ok: 2, conflict_elimi: 1, time_blank: 1, not_in_sr: 1, date_mismatch: 1, date_out_of_range: 1, time_partial: 1, dup_cycle_elimi: 1 }), 'by reason');
});
t('all applicable reasons are kept (primary = first in priority order)', () => {
  const g = ingest(LINES, C1, C2);
  eq(g.table.byId[id(6)].allReasons, ['date_mismatch', 'conflict_elimi'], 'mismatch + heading');
  eq(g.table.byId[id(6)].reason, 'date_mismatch', 'primary');
  eq(g.table.byId[id(7)].allReasons, ['date_out_of_range', 'conflict_elimi'], 'range + heading');
  eq(g.table.byId[id(2)].allReasons, [], 'none for readable');
  eq(g.table.byId[id(9)].allReasons.slice(0, 1), ['dup_cycle_elimi'], 'dup first');
  const s = R.reasonSummary(g.table);
  eq(s.anyCounts.conflict_elimi, 4, 'ids with heading conflict at all (3,6,7 and 9 via its Cycle2 entry)');
  eq(s.anyCounts.date_mismatch, 1, 'any mismatch');
});
t('multiple problems on one ID: SR dup conflict + blank is reported together', () => {
  const g = ingest([srLine(1, '', ''), srLine(1, D + '08:00:00', D + '12:00:00')], [1], []);
  eq(g.table.byId[id(1)].allReasons, ['dup_conflict_sr', 'time_blank'], 'both kept');
});

// ---------- heading comparison on hold ----------
t('default keeps the heading check (production condition unchanged)', () => {
  const g = ingest(LINES, C1, C2);
  eq(g.table.byId[id(3)].reason, 'conflict_elimi', 'default still conflict');
  eq(g.table.options.headingCheck, true, 'option default');
});
t('headingCheck:false removes only the heading-derived conflict; other safety conditions stay', () => {
  const g = ingest(LINES, C1, C2, null, { options: { headingCheck: false } });
  eq(g.table.byId[id(3)].status, 'no_window', '8-22 (no time window) readable without heading rule');
  eq(g.table.byId[id(3)].headingDiffers, true, 'difference is still recorded');
  for (const [n, reason] of [[4, 'time_blank'], [5, 'not_in_sr'], [6, 'date_mismatch'], [7, 'date_out_of_range'], [8, 'time_partial'], [9, 'dup_cycle_elimi']]) {
    eq(g.table.byId[id(n)].reason, reason, 'still excluded ' + n);
  }
});
t('blank times are never "no window" even with the heading check off', () => {
  const g = ingest([srLine(1, '', '')], [], [1], null, { options: { headingCheck: false } });
  eq([g.table.byId[id(1)].status, g.table.byId[id(1)].speech], ['unknown', '確認できません！'], 'blank');
});

// ---------- scenarios ----------
t('scenario comparison: current / heading off / date range off / both off', () => {
  const g = ingest(LINES, C1, C2);
  const sc = R.compareScenarios(g.input, {});
  eq(sc.map((s) => [s.name, s.total, s.readable]), [['current', 9, 2], ['heading_off', 9, 3], ['date_range_off', 9, 2], ['heading_and_range_off', 9, 4]], 'scenarios');
  eq(srt(sc[0].counts), srt(R.reasonSummary(g.table).counts), 'first scenario == production table');
  eq(R.transitions(sc[0], sc[1]), { 'conflict_elimi -> no_window': 1 }, 'heading off moves one');
  eq([sc[1].withWindow, sc[1].noWindow, sc[3].withWindow, sc[3].noWindow], [2, 1, 3, 1], 'window / no-window split');
  eq(R.transitions(sc[0], sc[2]), { 'date_out_of_range -> conflict_elimi': 1 }, 'range off: still heading-conflict');
  eq(R.transitions(sc[0], sc[3]), { 'conflict_elimi -> no_window': 1, 'date_out_of_range -> ok': 1 }, 'both off');
});
t('date range off alone does not make date-mismatch rows readable', () => {
  const g = ingest(LINES, C1, C2);
  const sc = R.compareScenarios(g.input, {});
  eq(sc[3].table.byId[id(6)].reason, 'date_mismatch', 'mismatch stays excluded in every scenario');
});
t('scenarios never mutate the production table or each other', () => {
  const g = ingest(LINES, C1, C2);
  const before = JSON.stringify(g.table.byId);
  R.compareScenarios(g.input, {});
  eq(JSON.stringify(g.table.byId), before, 'production table unchanged');
});

// ---------- ingest / errors ----------
t('ingest rejects missing SearchResults columns, naming them; no table is produced', () => {
  const g = R.ingest({ srText: 'Tracking ID,Foo\n' + id(1) + ',x\n', XLSX, workbook: workbook([1], []) });
  eq([g.ok, g.table, g.errors[0].code], [false, null, 'sr_missing_columns'], 'rejected');
  assert(g.errors[0].detail.indexOf('Promised Delivery Date') >= 0, 'names the column');
});
t('ingest rejects a workbook without the target sheet / without ID header / without workbook', () => {
  eq(ingest(LINES, [1], [], { sheetName: 'Other' }).errors[0].code, 'elimi_sheet_missing', 'sheet');
  eq(ingest(LINES, [1], [], { noIdHeader: true }).errors[0].code, 'elimi_id_header_not_found', 'header');
  eq(R.ingest({ srText: srCsv(LINES), XLSX }).errors[0].code, 'elimi_no_workbook', 'no workbook');
});
t('ingest reports all problems at once (SR and elimi)', () => {
  const g = R.ingest({ srText: 'a,b\n1,2\n', XLSX, workbook: workbook([1], [], { sheetName: 'Other' }) });
  eq(g.errors.map((e) => e.code), ['sr_missing_columns', 'elimi_sheet_missing'], 'both');
});
t('other sheets (未配報告) are present in the workbook but not read', () => {
  const g = ingest(LINES, C1, C2);
  eq(g.table.byId[id(999)], undefined, 'TRID from another sheet ignored');
});
t('warnings: blank-ID SR rows and invalid elimi ID cells are counted, not fatal', () => {
  const wb = workbook([1], []);
  const ws = wb.Sheets['エリミネーション報告'];
  XLSX.utils.sheet_add_aoa(ws, [[null, 9, 'garbage']], { origin: 'A11' });
  const g = R.ingest({ srText: srCsv([srLine(1, D + '08:00:00', D + '12:00:00'), ',,,,']), XLSX, workbook: wb });
  assert(g.ok, 'ok');
  eq(g.warnings.map((w) => w.code).sort(), ['elimi_invalid_id_cells', 'sr_blank_id_rows'], 'warnings');
});
t('re-ingest after a file update rebuilds from scratch (no stale entries)', () => {
  const a = ingest([srLine(1, D + '08:00:00', D + '12:00:00')], [1], []);
  const b = ingest([srLine(2, D + '14:00:00', D + '16:00:00')], [2], []);
  eq([a.table.byId[id(1)].status, b.table.byId[id(1)], b.table.byId[id(2)].speech], ['window', undefined, '14時から16時！'], 'rebuilt');
});
t('errorSummary carries counts and codes only (no Tracking IDs, no times)', () => {
  const g = ingest(LINES, C1, C2);
  const j = JSON.stringify(R.errorSummary(g));
  assert(!/DA\d{10}/.test(j), 'no ids');
  assert(!/\d{4}-\d{2}-\d{2} \d{2}:/.test(j), 'no timestamps');
});

// ---------- CSV ----------
t('summary CSV: BOM, TOTAL row equals target count', () => {
  const g = ingest(LINES, C1, C2);
  const text = R.summaryCsv(g.table);
  assert(text.charCodeAt(0) === 0xFEFF, 'BOM');
  const rows = text.slice(1).trim().split('\r\n').map((l) => l.split(','));
  const total = rows[rows.length - 1];
  eq([total[0], total[2]], ['TOTAL', '9'], 'total');
  eq(rows.slice(1, -1).reduce((a, r) => a + Number(r[2]), 0), 9, 'rows add up');
});
t('items CSV: targets then SR-only rows; all_reasons joined; quoting safe', () => {
  const g = ingest(LINES, C1, C2);
  const lines = R.itemsCsv(g.table).slice(1).trim().split('\r\n');
  eq(lines.length, 1 + 9 + 1, 'header + 9 targets + 1 sr_only');
  assert(lines.filter((l) => l.indexOf('elimi_target') === 0).length === 9, 'targets');
  assert(lines.filter((l) => l.indexOf('sr_only') === 0).length === 1, 'sr only');
  assert(lines.some((l) => l.indexOf('date_mismatch|conflict_elimi') > 0), 'all reasons');
  eq(R.csv([['a,b', 'c"d', 'e\nf']]), '﻿"a,b","c""d","e\nf"\r\n', 'escaping');
});
t('scenario CSV has one row per scenario and a column per reason', () => {
  const g = ingest(LINES, C1, C2);
  const lines = R.scenarioCsv(R.compareScenarios(g.input, {})).slice(1).trim().split('\r\n');
  eq(lines.length, 5, 'header + 4');
  assert(lines[0].split(',').indexOf('conflict_elimi') > 0, 'column');
});
t('summary separates 時間指定あり(ok) / 時間指定なし(no_window) / 確認不能 and "readable" is their sum', () => {
  const g = ingest(LINES, C1, C2, null, { options: { headingCheck: false } });
  const sm = R.reasonSummary(g.table);
  eq([sm.counts.ok, sm.counts.no_window], [2, 1], 'ok(1,2), no_window(3); id 9 stays stopped by its duplicate cycle');
});
t('summary CSV lists no_window as its own row and still totals the target count', () => {
  const lines = [srLine(1, D + '08:00:00', D + '22:00:00'), srLine(2, D + '08:00:00', D + '12:00:00'), srLine(3, '', '')];
  const g = ingest(lines, [1, 2, 3], []);
  const rows = R.summaryCsv(g.table).slice(1).trim().split('\r\n').map((l) => l.split(','));
  eq(rows.map((r) => [r[0], r[2]]), [['primary_reason', 'count'], ['ok', '1'], ['no_window', '1'], ['time_blank', '1'], ['TOTAL', '3']], 'rows');
  const sc = R.compareScenarios(g.input, {});
  eq([sc[0].readable, sc[0].withWindow, sc[0].noWindow], [2, 1, 1], 'readable = with + no');
  const items = R.itemsCsv(g.table);
  assert(items.indexOf('時間指定なし！') > 0 && items.indexOf('8時から12時！') > 0, 'speech columns');
});

// ---------- CLI ----------
t('CLI writes the reports for synthetic files and refuses an output dir inside the repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwr-'));
  try {
    writeFileSync(join(dir, 'sr.csv'), srCsv(LINES));
    writeFileSync(join(dir, 'el.xlsx'), XLSX.write(workbook(C1, C2), { type: 'buffer', bookType: 'xlsx' }));
    const ok = spawnSync(process.execPath, [join(root, 'scripts', 'delivery-window-report.mjs'), '--sr', join(dir, 'sr.csv'), '--elimi', join(dir, 'el.xlsx'), '--out', join(dir, 'out')], { encoding: 'utf8' });
    eq(ok.status, 0, 'exit 0: ' + ok.stderr);
    for (const f of ['summary_by_primary_reason.csv', 'items.csv', 'scenario_comparison.csv', 'errors.json']) assert(existsSync(join(dir, 'out', f)), f);
    eq(JSON.parse(ok.stdout).scenarios[0].total, 9, 'stdout summary');
    const bad = spawnSync(process.execPath, [join(root, 'scripts', 'delivery-window-report.mjs'), '--sr', join(dir, 'sr.csv'), '--elimi', join(dir, 'el.xlsx'), '--out', join(root, 'docs', 'x')], { encoding: 'utf8' });
    eq(bad.status, 2, 'refuses repo dir');
    assert(!existsSync(join(root, 'docs', 'x')), 'nothing created');
    writeFileSync(join(dir, 'bad.csv'), 'Tracking ID\nDA0000000001\n');
    const fail = spawnSync(process.execPath, [join(root, 'scripts', 'delivery-window-report.mjs'), '--sr', join(dir, 'bad.csv'), '--elimi', join(dir, 'el.xlsx'), '--out', join(dir, 'out2')], { encoding: 'utf8' });
    eq(fail.status, 1, 'ingest failure exits 1');
    assert(JSON.parse(readFileSync(join(dir, 'out2', 'errors.json'), 'utf8')).errors[0].code === 'sr_missing_columns', 'errors.json written');
    assert(!existsSync(join(dir, 'out2', 'items.csv')), 'no partial reports on failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

t('report module hygiene: no template literals, arrow functions or console', () => {
  const src = readFileSync(join(root, 'delivery-window-report.js'), 'utf8');
  assert(src.indexOf('`') < 0, 'backtick');
  assert(!/=>/.test(src), 'arrow');
  assert(!/console\./.test(src), 'console');
});

console.log('\n' + passed + ' tests passed');
