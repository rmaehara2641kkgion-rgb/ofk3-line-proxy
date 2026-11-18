import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = require(join(root, 'delivery-window-core.js'));
const V = require(join(root, 'delivery-window-voice.js'));

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
}
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok - ' + name); } catch (e) { console.error('  NOT OK - ' + name + '\n' + e.message); process.exit(1); }
}

// ---- synthetic fixtures (no real data) ----
const REF = '2026-11-17';
function id(n) { return 'DA' + String(n).padStart(10, '0'); }
function sr(n, s, e, promised, updated) {
  return { id: id(n), start: s || '', end: e || '', promised: promised === undefined ? REF : promised, updated: updated || '2026-11-17 09:00:00' };
}
function el(n, cycle, heading, expected, mixed) {
  return { id: id(n), cycle: cycle || 'Cycle2', heading: heading || '16-18時指定', mixed: !!mixed, expected: expected === undefined ? [[960, 1080]] : expected, row: 10 };
}
const D = REF + ' ';
function build(srRows, elRecs, opts) { return C.buildTable({ srRows, elimiRecords: elRecs, reportDate: REF, loadedAt: 'x' }, opts); }
// Cycle1-style record: mixed heading, no expectation
function el1(n) { return el(n, 'Cycle1', 'AM指定・14-16指定・BC', null, true); }
function spoken(table, n) { return C.lookup(table, id(n)); }

console.log('delivery-window-core tests');

// ---------- speech ----------
t('8:00-12:00 -> 8時から12時！', () => {
  const T = build([sr(1, D + '08:00:00', D + '12:00:00')], [el1(1)]);
  const r = spoken(T, 1);
  eq([r.status, r.speech], ['window', '8時から12時！'], 'speech');
});
t('14:00-16:00 -> 14時から16時！', () => {
  const T = build([sr(1, D + '14:00:00', D + '16:00:00')], [el1(1)]);
  eq(spoken(T, 1).speech, '14時から16時！', 'speech');
});
t('16:00-18:00 in Cycle2 heading 16-18 -> 16時から18時！', () => {
  const T = build([sr(1, D + '16:00:00', D + '18:00:00')], [el(1)]);
  eq(spoken(T, 1).speech, '16時から18時！', 'speech');
});
t('8:00-22:00 is never read as 8-12', () => {
  const T = build([sr(1, D + '08:00:00', D + '22:00:00')], [el1(1)]);
  const r = spoken(T, 1);
  eq([r.speech, r.startMin, r.endMin], ['8時から22時！', 480, 1320], 'speech');
});
t('non-standard windows are generated from data (18:00-23:59, 0:00-23:59:59, 5-13)', () => {
  const T = build([
    sr(1, D + '18:00:00', D + '23:59:00'), sr(2, D + '00:00:00', D + '23:59:59'), sr(3, D + '05:00:00', D + '13:00:00'),
    sr(4, D + '08:30:00', D + '12:15:00')
  ], [el1(1), el1(2), el1(3), el1(4)]);
  eq(spoken(T, 1).speech, '18時から23時59分！', '18-2359');
  eq(spoken(T, 2).speech, '0時から23時59分！', '0-2359');
  eq(spoken(T, 3).speech, '5時から13時！', '5-13');
  eq(spoken(T, 4).speech, '8時30分から12時15分！', 'minutes');
});

// ---------- unknown / no-window ----------
t('blank time fields -> unknown (確認できません！), never "時間指定なし"', () => {
  const T = build([sr(1, '', '')], [el1(1)]);
  const r = spoken(T, 1);
  eq([r.status, r.reason, r.speech], ['unknown', 'time_blank', '確認できません！'], 'blank');
});
t('no_window is reachable only through noWindowEvidence (future-ready)', () => {
  const T = build([sr(1, '', '')], [el1(1)], { noWindowEvidence: (info) => info.id === id(1) });
  eq([spoken(T, 1).status, spoken(T, 1).speech], ['no_window', '時間指定なし！'], 'with evidence');
  const T2 = build([sr(1, '', ''), sr(2, '', '')], [el1(1), el1(2)], { noWindowEvidence: (info) => info.id === id(1) });
  eq(spoken(T2, 2).status, 'unknown', 'other id stays unknown');
  const T3 = build([sr(1, '', '')], [el1(1)], { noWindowEvidence: () => 'yes' });
  eq(spoken(T3, 1).status, 'unknown', 'only strict true counts');
});
t('evidence never overrides a data problem (SR duplicate conflict stays unknown)', () => {
  const T = build([sr(1, '', ''), sr(1, D + '08:00:00', D + '12:00:00')], [el1(1)], { noWindowEvidence: () => true });
  eq(spoken(T, 1).reason, 'dup_conflict_sr', 'conflict wins');
});
t('only one of start/end -> time_partial; garbage/zone/reversed -> time_invalid', () => {
  const T = build([
    sr(1, D + '08:00:00', ''), sr(2, 'abc', 'def'), sr(3, '2026-11-17T08:00:00Z', '2026-11-17T12:00:00Z'),
    sr(4, D + '12:00:00', D + '08:00:00'), sr(5, D + '25:00:00', D + '26:00:00')
  ], [el1(1), el1(2), el1(3), el1(4), el1(5)]);
  eq(spoken(T, 1).reason, 'time_partial', 'partial');
  eq(spoken(T, 2).reason, 'time_invalid', 'garbage');
  eq(spoken(T, 3).reason, 'time_invalid', 'zone suffix is not guessed');
  eq(spoken(T, 4).reason, 'time_invalid', 'reversed');
  eq(spoken(T, 5).reason, 'time_invalid', 'hour 25');
});
t('match failures: not in SR / not in elimi / unknown scan value all warn', () => {
  const T = build([sr(1, D + '08:00:00', D + '12:00:00'), sr(2, D + '08:00:00', D + '12:00:00')], [el1(1), el1(3)]);
  eq(spoken(T, 2).reason, 'not_in_elimi', 'SR only');
  eq(spoken(T, 3).reason, 'not_in_sr', 'elimi only');
  eq(spoken(T, 9).reason, 'not_found', 'neither');
  for (const n of [2, 3, 9]) eq(spoken(T, n).speech, '確認できません！', 'speech ' + n);
});
t('requireElimi:false lets a valid SR-only window be read (option, default is strict)', () => {
  const T = build([sr(2, D + '08:00:00', D + '12:00:00')], [], { requireElimi: false });
  eq(spoken(T, 2).speech, '8時から12時！', 'relaxed');
});

// ---------- duplicates ----------
t('ELIMI duplicate in the same cycle is counted but harmless', () => {
  const T = build([sr(1, D + '08:00:00', D + '12:00:00')], [el1(1), el1(1)]);
  eq(spoken(T, 1).status, 'window', 'still window');
  eq([T.report.elimiRecords, T.report.elimiUniqueIds, T.report.elimiDuplicateIds, T.report.elimiDuplicateCycleIds], [2, 1, 1, 0], 'counts');
});
t('ELIMI duplicate across cycles -> dup_cycle_elimi (not spoken)', () => {
  const T = build([sr(1, D + '16:00:00', D + '18:00:00')], [el1(1), el(1)]);
  eq(spoken(T, 1).reason, 'dup_cycle_elimi', 'cross-cycle');
  eq(T.report.elimiDuplicateCycleIds, 1, 'counted');
});
t('SR duplicate with the same window is merged', () => {
  const T = build([sr(1, D + '08:00:00', D + '12:00:00'), sr(1, D + '08:00:00', D + '12:00:00')], [el1(1)]);
  eq(spoken(T, 1).status, 'window', 'merged');
  eq([T.report.srRows, T.report.srUniqueIds, T.report.srDuplicateIds, T.report.srDuplicateConflicts], [2, 1, 1, 0], 'counts');
});
t('SR duplicate with different windows -> dup_conflict_sr, not spoken', () => {
  const T = build([sr(1, D + '08:00:00', D + '12:00:00'), sr(1, D + '14:00:00', D + '16:00:00')], [el1(1)]);
  const r = spoken(T, 1);
  eq([r.status, r.reason, r.speech], ['unknown', 'dup_conflict_sr', '確認できません！'], 'conflict');
  eq(T.report.srDuplicateConflicts, 1, 'counted');
});

// ---------- elimi heading vs SearchResults ----------
t('mixed heading (Cycle1) never creates a contradiction by itself', () => {
  const T = build([sr(1, D + '08:00:00', D + '12:00:00'), sr(2, D + '14:00:00', D + '16:00:00'), sr(3, D + '08:00:00', D + '22:00:00')], [el1(1), el1(2), el1(3)]);
  for (const n of [1, 2, 3]) eq(spoken(T, n).status, 'window', 'cycle1 ' + n);
});
t('single-range heading that disagrees -> conflict_elimi, neither side is trusted', () => {
  const T = build([sr(1, D + '08:00:00', D + '22:00:00')], [el(1)]);
  const r = spoken(T, 1);
  eq([r.status, r.reason, r.speech], ['unknown', 'conflict_elimi', '確認できません！'], 'conflict');
  eq(r.expectedFromHeading, [[960, 1080]], 'recorded');
});
t('heading parser', () => {
  eq(C.parseHeadingExpectation('16-18時指定'), { mixed: false, expected: [[960, 1080]] }, '16-18');
  eq(C.parseHeadingExpectation('１６－１８時指定'), { mixed: false, expected: [[960, 1080]] }, 'full width');
  eq(C.parseHeadingExpectation('AM指定・14-16指定・BC'), { mixed: true, expected: null }, 'mixed');
  eq(C.parseHeadingExpectation('AM指定'), { mixed: false, expected: null }, 'no range');
  eq(C.parseHeadingExpectation(''), { mixed: false, expected: null }, 'empty');
});

// ---------- dates ----------
t('window date != Promised Delivery Date -> date_mismatch (excluded)', () => {
  const T = build([sr(1, '2026-11-18 08:00:00', '2026-11-18 12:00:00', '2026-11-17')], [el1(1)]);
  eq([spoken(T, 1).reason, spoken(T, 1).speech], ['date_mismatch', '確認できません！'], 'mismatch');
});
t('start/end on different dates -> date_span; blank/bad Promised date -> date_promised_missing', () => {
  const T = build([sr(1, D + '08:00:00', '2026-11-18 12:00:00'), sr(2, D + '08:00:00', D + '12:00:00', ''), sr(3, D + '08:00:00', D + '12:00:00', '2026/11/17')], [el1(1), el1(2), el1(3)]);
  eq(spoken(T, 1).reason, 'date_span', 'span');
  eq(spoken(T, 2).reason, 'date_promised_missing', 'blank promised');
  eq(spoken(T, 3).reason, 'date_promised_missing', 'bad format promised');
});
t('date window: today and tomorrow ok; yesterday and +5 days excluded; reference date missing excluded', () => {
  const T = build([
    sr(1, '2026-11-17 08:00:00', '2026-11-17 12:00:00', '2026-11-17'),
    sr(2, '2026-11-18 08:00:00', '2026-11-18 12:00:00', '2026-11-18'),
    sr(3, '2026-11-16 08:00:00', '2026-11-16 12:00:00', '2026-11-16'),
    sr(4, '2026-11-22 08:00:00', '2026-11-22 12:00:00', '2026-11-22')
  ], [el1(1), el1(2), el1(3), el1(4)]);
  eq([spoken(T, 1).status, spoken(T, 2).status], ['window', 'window'], 'today/tomorrow');
  eq([spoken(T, 3).reason, spoken(T, 4).reason], ['date_out_of_range', 'date_out_of_range'], 'out of range');
  const T2 = C.buildTable({ srRows: [sr(1, D + '08:00:00', D + '12:00:00')], elimiRecords: [el1(1)], reportDate: null });
  eq(T2.byId[id(1)].reason, 'date_ref_missing', 'no reference');
  const T3 = build([sr(3, '2026-11-16 08:00:00', '2026-11-16 12:00:00', '2026-11-16')], [el1(3)], { dateRange: null });
  eq(T3.byId[id(3)].status, 'window', 'range check can be disabled explicitly');
});

// ---------- scan value resolution ----------
const TS = build([sr(1, D + '08:00:00', D + '12:00:00'), sr(2, D + '14:00:00', D + '16:00:00')], [el1(1), el1(2)], { allowedAffixes: ['SCN-'] });
t('scan: exact, lower-case, full-width, trailing CR/LF/space and control chars', () => {
  for (const raw of [id(1), id(1).toLowerCase(), 'ＤＡ０００００００００１', id(1) + '\r\n', '  ' + id(1) + ' ', id(1) + '\u0003']) {
    eq(C.lookup(TS, raw).id, id(1), 'raw ' + JSON.stringify(raw));
  }
});
t('scan: delimited prefix/suffix is accepted as embedded; configured affix as affix', () => {
  eq([C.lookup(TS, '*' + id(1) + '*').matchKind, C.lookup(TS, '*' + id(1) + '*').id], ['embedded', id(1)], 'delimited');
  eq([C.lookup(TS, 'SCN-' + id(2)).matchKind, C.lookup(TS, 'SCN-' + id(2)).id], ['affix', id(2)], 'affix');
});
t('scan: wrong partial matches are rejected (glued letters/digits, truncated, extra digit, split)', () => {
  for (const raw of ['X' + id(1), id(1) + '3', id(1).slice(0, -1), id(1).slice(0, 8), 'ZZ' + id(1), id(1) + 'A', '1' + id(1), id(1).replace('DA', 'DB')]) {
    const r = C.lookup(TS, raw);
    eq([r.status, r.speech], ['unknown', '確認できません！'], 'rejected ' + raw);
    assert(r.id === null || r.reason === 'not_found', 'no accidental id for ' + raw);
  }
});
t('scan: two different IDs in one scan -> ambiguous, same ID twice -> that ID', () => {
  const r = C.lookup(TS, id(1) + ' ' + id(2));
  eq([r.status, r.reason], ['unknown', 'ambiguous_scan'], 'ambiguous');
  eq(C.lookup(TS, id(1) + ' ' + id(1)).id, id(1), 'same twice');
});
t('scan: empty / null / non-string never throws', () => {
  for (const raw of ['', '   ', null, undefined, 12345, {}]) eq(C.lookup(TS, raw).status, 'unknown', 'raw ' + String(raw));
  eq(C.lookup(null, id(1)).status, 'unknown', 'no table');
});

// ---------- continuous / repeated scans ----------
t('consecutive scans are independent; rescanning the same item gives the same answer every time', () => {
  const seq = [id(1), id(2), id(1), id(1), id(9), id(2)];
  const out = seq.map((s) => C.lookup(TS, s).speech);
  eq(out, ['8時から12時！', '14時から16時！', '8時から12時！', '8時から12時！', '確認できません！', '14時から16時！'], 'sequence');
});
t('mutating a returned result cannot corrupt the table', () => {
  const r = C.lookup(TS, id(1)); r.speech = 'X'; r.status = 'unknown';
  eq(C.lookup(TS, id(1)).speech, '8時から12時！', 'table intact');
});
t('__proto__/constructor style IDs do not hit prototype properties', () => {
  for (const raw of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) eq(C.lookup(TS, raw).status, 'unknown', raw);
});

// ---------- rebuild on file update ----------
t('rebuilding with updated data replaces answers and metadata (no stale state)', () => {
  const T1 = build([sr(1, D + '08:00:00', D + '12:00:00', REF, '2026-11-17 09:00:00')], [el1(1)]);
  const T2 = build([sr(1, D + '14:00:00', D + '16:00:00', REF, '2026-11-17 10:30:00')], [el1(1)]);
  eq([C.lookup(T1, id(1)).speech, C.lookup(T2, id(1)).speech], ['8時から12時！', '14時から16時！'], 'new answer');
  eq([T1.meta.srLastUpdated, T2.meta.srLastUpdated], ['2026-11-17 09:00:00', '2026-11-17 10:30:00'], 'last updated');
  eq(C.lookup(T1, id(1)).speech, '8時から12時！', 'old table untouched');
});

// ---------- input parsing ----------
const HEAD = 'Tracking ID,Last Updated Time,Scheduled Delivery Start Time,Scheduled Delivery End Time,Promised Delivery Date,Extra';
t('SearchResults CSV: BOM, CRLF, quoted commas/newlines, extra columns', () => {
  const csv = '﻿' + HEAD + '\r\n' + id(1) + ',2026-11-17 09:00:00,2026-11-17 08:00:00,2026-11-17 12:00:00,2026-11-17,"a,b"\r\n' + id(2) + ',2026-11-17 09:00:00,,,2026-11-17,"x\ny"\r\n';
  const p = C.parseSearchResults(csv);
  assert(p.ok, 'ok');
  eq([p.rowCount, p.rows[0].start, p.rows[1].start, p.rows[1].end], [2, '2026-11-17 08:00:00', '', ''], 'rows');
});
t('SearchResults CSV: missing required column is rejected and names the column', () => {
  const p = C.parseSearchResults('Tracking ID,Scheduled Delivery Start Time\n' + id(1) + ',x\n');
  eq([p.ok, p.error, p.missingColumns], [false, 'missing_columns', ['Scheduled Delivery End Time', 'Promised Delivery Date']], 'missing');
  eq(C.parseSearchResults('').ok, false, 'empty');
  eq(C.parseSearchResults('foo,bar\n1,2\n').missingColumns.length, 4, 'wrong file');
});
t('SearchResults CSV: IDs are normalised, blank-ID rows counted not kept', () => {
  const p = C.parseSearchResults(HEAD + '\n da0000000001 ,,,,2026-11-17,\n,,,,,\n');
  eq([p.rowCount, p.rows[0].id, p.blankIdRows], [1, id(1), 1], 'normalised');
});

function elimiSheet(extra) {
  const rows = [
    [null, null, null, null, null, null],
    [null, 'RTS報告', null, null, null, null],
    [null, null, null, null, null, null],
    [null, '日付', extra && extra.date !== undefined ? extra.date : new Date(Date.UTC(2026, 10, 17)), null, null, null],
    [null, 'Node', 'OFK3', null, null, null],
    [null, null, null, null, null, null],
    [null, 'Cycle1', null, null, 'Cycle2', null],
    [null, 'AM指定・14-16指定・BC', null, null, '16-18時指定', null],
    [null, '番号', 'トラッキングID', null, '番号', 'トラッキングID'],
    [null, 1, id(1), null, 1, id(11)],
    [null, 2, id(2), null, 2, id(12)],
    [null, 3, null, null, 3, 'not-an-id'],
    [null, 4, null, null, 4, id(12)]
  ];
  if (extra && extra.noHeader) rows[8] = [null, '番号', '備考', null, '番号', '備考'];
  return rows;
}
t('ELIMI sheet: Cycle1/Cycle2 sections, headings, report date, invalid cell count', () => {
  const p = C.parseElimiCycleSheet(elimiSheet(), { sheetName: 'エリミネーション報告' });
  assert(p.ok, 'ok');
  eq([p.records.length, p.reportDate, p.invalidCells], [5, '2026-11-17', 1], 'counts');
  eq(p.records.filter((r) => r.cycle === 'Cycle1').map((r) => r.id), [id(1), id(2)], 'cycle1');
  eq(p.sections.map((s) => [s.cycle, s.mixed, s.expected]), [['Cycle1', true, null], ['Cycle2', false, [[960, 1080]]]], 'sections');
  const T = C.buildTable({ srRows: [], elimiRecords: p.records, reportDate: p.reportDate });
  eq([T.report.elimiRecords, T.report.elimiUniqueIds, T.report.elimiDuplicateIds], [5, 4, 1], 'dup id inside Cycle2');
});
t('ELIMI sheet: report date from Excel serial and string; structure errors are reported', () => {
  eq(C.parseElimiCycleSheet(elimiSheet({ date: 46343 })).reportDate, '2026-11-17', 'serial');
  eq(C.parseElimiCycleSheet(elimiSheet({ date: '2026-11-17 00:00:00' })).reportDate, '2026-11-17', 'string');
  eq(C.parseElimiCycleSheet(elimiSheet({ noHeader: true })).error, 'id_header_not_found', 'no id header');
  eq(C.parseElimiCycleSheet([[1, 2], [3, 4]]).error, 'cycle_sections_not_found', 'wrong sheet');
});

// ---------- report ----------
t('report: input / matched / unmatched / duplicates / ok / needs-check add up', () => {
  const T = build([
    sr(1, D + '08:00:00', D + '12:00:00'), sr(2, '', ''), sr(3, D + '08:00:00', D + '22:00:00'), sr(3, D + '08:00:00', D + '22:00:00'), sr(7, D + '08:00:00', D + '12:00:00')
  ], [el1(1), el1(2), el(3), el1(4), el1(4)]);
  const r = T.report;
  eq([r.srRows, r.srUniqueIds, r.srDuplicateIds, r.elimiRecords, r.elimiUniqueIds, r.elimiDuplicateIds], [5, 4, 1, 5, 4, 1], 'input');
  eq([r.matched, r.elimiOnly, r.srOnly], [3, 1, 1], 'match');
  eq([r.windowOk, r.needsCheck], [1, 3], 'result');
  eq(r.byReason, { time_blank: 1, conflict_elimi: 1, not_in_sr: 1 }, 'reasons');
  eq(r.windowOk + r.noWindow + r.needsCheck, r.elimiUniqueIds, 'adds up to the target set');
});

// ---------- voice selection ----------
function voice(name, lang) { return { name, lang: lang || 'ja-JP', localService: true }; }
t('voice: male ja voice is chosen by name; female/Google voices are not treated as male', () => {
  const vs = [voice('Google 日本語'), voice('Microsoft Nanami Online (Natural) - Japanese (Japan)'), voice('Microsoft Ichiro - Japanese (Japan)'), voice('Alex', 'en-US')];
  const p = V.pickVoice(vs);
  eq([p.voice.name, p.male, p.reason], ['Microsoft Ichiro - Japanese (Japan)', true, 'male_by_name'], 'ichiro');
  eq(V.listJaVoices(vs).map((v) => v.male), [false, false, true], 'list');
});
t('voice: no male voice -> falls back to a ja voice with male:false (UI must say so); none -> null', () => {
  const p = V.pickVoice([voice('Google 日本語'), voice('Kyoko')]);
  eq([p.male, p.reason, p.voice.name], [false, 'no_known_male_voice', 'Google 日本語'], 'fallback');
  eq(V.pickVoice([voice('Alex', 'en-US')]).reason, 'no_ja_voice', 'no ja');
  eq(V.pickVoice([]).voice, null, 'empty');
  eq(V.pickVoice(undefined).voice, null, 'undefined');
});
t('voice: saved preference wins if still present; "female" is not mistaken for "male"', () => {
  const vs = [voice('Microsoft Ichiro'), voice('Otoya')];
  eq(V.pickVoice(vs, 'Otoya').voice.name, 'Otoya', 'preferred');
  eq(V.pickVoice(vs, 'Gone').voice.name, 'Microsoft Ichiro', 'preferred missing');
  eq(V.isMaleName(voice('Some Female Voice')), false, 'female');
});

// ---------- source hygiene ----------
t('source files contain no template literals and no console/log of data', async () => {
  const fs = require('node:fs');
  for (const f of ['delivery-window-core.js', 'delivery-window-voice.js']) {
    const src = fs.readFileSync(join(root, f), 'utf8');
    assert(src.indexOf('`') < 0, f + ' has a backtick');
    assert(!/console\./.test(src), f + ' logs');
    assert(!/=>/.test(src), f + ' uses arrow functions (IE mode)');
  }
});

console.log('\n' + passed + ' tests passed');
