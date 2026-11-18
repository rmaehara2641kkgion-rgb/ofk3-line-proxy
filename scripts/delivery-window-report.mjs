// Read-only verification of the elimination workbook + SearchResults CSV.
//   node scripts/delivery-window-report.mjs --sr <SearchResults.csv> --elimi <elimi.xlsx> --out <dir>
// Writes CSV/JSON reports. Never modifies the inputs, never sends anything anywhere, never speaks.
// The output holds delivery data (Tracking IDs, times): --out must be OUTSIDE the repository or under
// the git-ignored ./local/ directory, so reports cannot be committed by accident.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = require(join(root, 'delivery-window-report.js'));
const XLSX = require('xlsx');

function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : null; }
const srPath = arg('sr'), elPath = arg('elimi'), outDir = arg('out');
if (!srPath || !elPath || !outDir) { console.error('usage: --sr <csv> --elimi <xlsx> --out <dir>'); process.exit(2); }

const rel = relative(root, resolve(outDir));
const inside = !rel.startsWith('..') && !isAbsolute(rel);
if (inside && !rel.split(/[\\/]/)[0].match(/^local$/)) {
  console.error('refusing: --out is inside the repository (use a directory outside it, or ./local/...)');
  process.exit(2);
}

const ing = R.ingest({
  srText: readFileSync(srPath, 'utf8'),
  XLSX, workbook: XLSX.read(readFileSync(elPath), { type: 'buffer' }),
  loadedAt: null
});
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'errors.json'), JSON.stringify(R.errorSummary(ing), null, 2));
if (!ing.ok) { console.error('ingest failed: ' + ing.errors.map((e) => e.code).join(', ')); process.exit(1); }

const scenarios = R.compareScenarios(ing.input, {});
writeFileSync(join(outDir, 'summary_by_primary_reason.csv'), R.summaryCsv(ing.table));
writeFileSync(join(outDir, 'items.csv'), R.itemsCsv(ing.table));
writeFileSync(join(outDir, 'scenario_comparison.csv'), R.scenarioCsv(scenarios));
console.log(JSON.stringify({
  report: ing.table.report,
  scenarios: scenarios.map((s) => ({ name: s.name, total: s.total, readable: s.readable, with_window: s.withWindow, no_window: s.noWindow, counts: s.counts })),
  transitions_current_to_heading_off: R.transitions(scenarios[0], scenarios[1]),
  transitions_current_to_range_off: R.transitions(scenarios[0], scenarios[2]),
  transitions_current_to_both_off: R.transitions(scenarios[0], scenarios[3])
}, null, 1));
