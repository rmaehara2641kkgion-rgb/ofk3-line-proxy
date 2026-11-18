// Spec-change proposal check: demoting the elimination-sheet heading comparison to "reference only"
// (headingCheck:false) must not weaken ANY other safety condition. Production default stays headingCheck:true.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = require(join(root, 'delivery-window-core.js'));

let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error('FAIL: ' + msg + '\n  actual:   ' + x + '\n  expected: ' + y);
}
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok - ' + name); } catch (e) { console.error('  NOT OK - ' + name + '\n' + e.message); process.exit(1); }
}

const REF = '2026-11-17';
const id = (n) => 'DA' + String(n).padStart(10, '0');
const ts = (d, hm) => d + ' ' + hm + ':00';

// SearchResults variants: [label, rows[]]
const SR = [
  ['blank', [{ start: '', end: '', promised: REF }]],
  ['partial', [{ start: ts(REF, '08:00'), end: '', promised: REF }]],
  ['invalid', [{ start: 'x', end: 'y', promised: REF }]],
  ['reversed', [{ start: ts(REF, '12:00'), end: ts(REF, '08:00'), promised: REF }]],
  ['w0812', [{ start: ts(REF, '08:00'), end: ts(REF, '12:00'), promised: REF }]],
  ['w1416', [{ start: ts(REF, '14:00'), end: ts(REF, '16:00'), promised: REF }]],
  ['w1618', [{ start: ts(REF, '16:00'), end: ts(REF, '18:00'), promised: REF }]],
  ['w0822', [{ start: ts(REF, '08:00'), end: ts(REF, '22:00'), promised: REF }]],
  ['w1823', [{ start: ts(REF, '18:00'), end: ts(REF, '23:59'), promised: REF }]],
  ['tomorrow0812', [{ start: ts('2026-11-18', '08:00'), end: ts('2026-11-18', '12:00'), promised: '2026-11-18' }]],
  ['mismatch', [{ start: ts('2026-11-18', '08:00'), end: ts('2026-11-18', '12:00'), promised: REF }]],
  ['mismatch0822', [{ start: ts('2026-11-18', '08:00'), end: ts('2026-11-18', '22:00'), promised: REF }]],
  ['span', [{ start: ts(REF, '08:00'), end: ts('2026-11-18', '12:00'), promised: REF }]],
  ['promisedBlank', [{ start: ts(REF, '08:00'), end: ts(REF, '12:00'), promised: '' }]],
  ['yesterday', [{ start: ts('2026-11-16', '08:00'), end: ts('2026-11-16', '12:00'), promised: '2026-11-16' }]],
  ['farFuture', [{ start: ts('2026-11-22', '08:00'), end: ts('2026-11-22', '12:00'), promised: '2026-11-22' }]],
  ['dupSame', [{ start: ts(REF, '08:00'), end: ts(REF, '12:00'), promised: REF }, { start: ts(REF, '08:00'), end: ts(REF, '12:00'), promised: REF }]],
  ['dupConflict', [{ start: ts(REF, '08:00'), end: ts(REF, '12:00'), promised: REF }, { start: ts(REF, '14:00'), end: ts(REF, '16:00'), promised: REF }]],
  ['dupBlankVsTime', [{ start: '', end: '', promised: REF }, { start: ts(REF, '08:00'), end: ts(REF, '12:00'), promised: REF }]],
  ['absent', null]
];
// Elimination variants: [label, records[]]
const MIXED = { cycle: 'Cycle1', heading: 'AM指定・14-16指定・BC', mixed: true, expected: null };
const SINGLE = { cycle: 'Cycle2', heading: '16-18時指定', mixed: false, expected: [[960, 1080]] };
const EL = [
  ['cycle1', [MIXED]],
  ['cycle2', [SINGLE]],
  ['cycle2x2', [SINGLE, SINGLE]],
  ['both', [MIXED, SINGLE]],
  ['absent', null]
];

function combos() {
  const srRows = [], elRecs = [], keys = [];
  let n = 1;
  for (const [sl, rows] of SR) {
    for (const [el, recs] of EL) {
      if (!rows && !recs) continue;
      const k = n++; keys.push({ n: k, sr: sl, el: el });
      if (rows) rows.forEach((r) => srRows.push({ id: id(k), start: r.start, end: r.end, promised: r.promised, updated: '' }));
      if (recs) recs.forEach((r) => elRecs.push({ id: id(k), cycle: r.cycle, heading: r.heading, mixed: r.mixed, expected: r.expected, row: 1 }));
    }
  }
  return { srRows, elRecs, keys };
}
const F = combos();
const input = { srRows: F.srRows, elimiRecords: F.elRecs, reportDate: REF };
const ON = C.buildTable(input, {});                       // production
const OFF = C.buildTable(input, { headingCheck: false }); // proposal (reference only)
const base = (r) => r.allReasons.filter((x) => x !== 'conflict_elimi');

console.log('delivery-window heading-mode tests (' + F.keys.length + ' combinations)');

t('production default is unchanged: headingCheck is true', () => {
  eq(ON.options.headingCheck, true, 'default');
  eq(C.buildTable({ srRows: [], elimiRecords: [] }, { headingCheck: true }).options.headingCheck, true, 'explicit');
});
t('fixture covers the interesting space (heading conflicts exist in production mode)', () => {
  const n = ON.all.filter((r) => r.allReasons.indexOf('conflict_elimi') >= 0).length;
  assert(n >= 8, 'enough heading conflicts: ' + n);
});
t('every ID: reasons with the heading as reference == reasons in production minus conflict_elimi', () => {
  for (const k of F.keys) {
    const a = ON.byId[id(k.n)], b = OFF.byId[id(k.n)];
    eq(b.allReasons, base(a), 'reasons ' + k.sr + '/' + k.el);
    assert(b.allReasons.indexOf('conflict_elimi') < 0, 'no heading reason in reference mode');
  }
});
t('status changes ONLY where the heading was the sole problem; nothing else is released', () => {
  let released = 0;
  for (const k of F.keys) {
    const a = ON.byId[id(k.n)], b = OFF.byId[id(k.n)];
    if (a.status !== b.status || a.speech !== b.speech) {
      eq(a.allReasons, ['conflict_elimi'], 'only-heading ' + k.sr + '/' + k.el);
      eq(a.status, 'unknown', 'was stopped');
      assert(b.status === 'window' || b.status === 'no_window', 'now readable');
      released += 1;
    }
  }
  assert(released > 0, 'the proposal releases something');
  eq(released, ON.all.filter((r) => r.allReasons.length === 1 && r.allReasons[0] === 'conflict_elimi').length, 'released == heading-only stops');
});
t('already readable items are identical in both modes (speech, status)', () => {
  for (const k of F.keys) {
    const a = ON.byId[id(k.n)];
    if (a.status !== 'unknown') eq([OFF.byId[id(k.n)].status, OFF.byId[id(k.n)].speech], [a.status, a.speech], 'same ' + k.sr + '/' + k.el);
  }
});
t('every other safety stop stays stopped in reference mode (blank, partial, invalid, dates, dups, not-in-sr/elimi)', () => {
  const must = ['blank', 'partial', 'invalid', 'reversed', 'mismatch', 'mismatch0822', 'span', 'promisedBlank', 'yesterday', 'farFuture', 'dupConflict', 'dupBlankVsTime'];
  for (const k of F.keys) {
    const b = OFF.byId[id(k.n)];
    if (must.indexOf(k.sr) >= 0) eq([b.status, b.speech], ['unknown', '確認できません！'], 'stays stopped ' + k.sr + '/' + k.el);
    if (k.el === 'both') eq(b.status, 'unknown', 'cycle duplicate stays stopped ' + k.sr);
    if (k.sr === 'absent') eq(b.status, 'unknown', 'not in SR ' + k.sr + '/' + k.el);
    if (k.el === 'absent') eq(b.status, 'unknown', 'not in elimi ' + k.sr);
  }
});
t('blank time is never turned into "時間指定なし" in either mode; only exact 08:00-22:00 is', () => {
  for (const k of F.keys) {
    for (const T of [ON, OFF]) {
      const r = T.byId[id(k.n)];
      if (r.status === 'no_window') assert(k.sr === 'w0822', 'no_window only from 08:00-22:00, got ' + k.sr);
    }
  }
});
t('heading difference is still recorded in reference mode (for display)', () => {
  for (const k of F.keys) eq(!!OFF.byId[id(k.n)].headingDiffers, !!ON.byId[id(k.n)].headingDiffers, 'headingDiffers ' + k.sr + '/' + k.el);
  assert(OFF.all.some((r) => r.headingDiffers), 'some differences recorded');
});
t('mixed Cycle1 heading never stops anything in either mode', () => {
  for (const k of F.keys) {
    if (k.el !== 'cycle1') continue;
    eq(ON.byId[id(k.n)].allReasons.indexOf('conflict_elimi'), -1, 'cycle1 ' + k.sr);
  }
});
t('report counts add up in both modes', () => {
  for (const T of [ON, OFF]) {
    const r = T.report;
    eq(r.windowOk + r.noWindow + r.needsCheck, r.elimiUniqueIds, 'adds up');
  }
});

console.log('\n' + passed + ' tests passed');
