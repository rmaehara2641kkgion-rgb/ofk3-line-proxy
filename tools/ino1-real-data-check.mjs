// Read-only comparison of the OFK3 list board and the INO-1 snapshot on REAL files (nothing is written or committed).
// usage: node tools/ino1-real-data-check.mjs <shift.xlsx> <daily.xlsx> <referenceDate> [name-key ...] [--id=<transportId> ...]
// A name key is the sorted, '|'-joined name parts as in the existing real-file test, e.g. "姓|名" in either order.
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
const XLSX = require('../node_modules/xlsx/xlsx.js');

const args = process.argv.slice(2);
const [shiftPath, dailyPath, REF] = args;
const ids = args.filter((a) => a.startsWith('--id=')).map((a) => a.slice(5));
const keys = args.slice(3).filter((a) => !a.startsWith('--'));
if (!shiftPath || !dailyPath || !/^\d{4}-\d{2}-\d{2}$/.test(REF || '') || !fs.existsSync(shiftPath) || !fs.existsSync(dailyPath)) {
  console.error('usage: node tools/ino1-real-data-check.mjs <shift.xlsx> <daily.xlsx> <YYYY-MM-DD> [name-key ...] [--id=<transportId> ...]');
  process.exit(2);
}
const nameKey = (v) => String(v || '').trim().split(/[\s　]+/).filter(Boolean).sort().join('|');
const shiftWb = XLSX.readFile(shiftPath, { cellDates: true });
const dailyWb = XLSX.readFile(dailyPath, { cellDates: true });
const sheet = Rolling.pickReport5Sheet(dailyWb.SheetNames || []);
const dailyRows = XLSX.utils.sheet_to_json(dailyWb.Sheets[sheet], { header: 1, raw: true, defval: null });
const parsedDaily = Rolling.parseAmazonDailyRows(dailyRows, { stationFilter: 'OFK3', allowHeaderlessFallback: false });
const names = {};
(shiftWb.SheetNames || []).forEach((name) => {
  if (Run.ROSTER_SKIP[name] || name === 'Report5_Daily_Data') return;
  const parsed = Rolling.parseMonthlyRosterSheetRows(XLSX.utils.sheet_to_json(shiftWb.Sheets[name], { header: 1, raw: true, defval: null }));
  const grouped = Rolling.groupRosterRecordsByDriver(parsed.records || []);
  Object.keys(grouped).forEach((k) => {
    const meta = grouped[k].meta || {};
    if (meta.transportId && k.indexOf('NAME:') !== 0 && meta.name && !names[meta.transportId]) names[meta.transportId] = meta.name;
  });
});
const executed = Run.capture({ xlsx: XLSX, rolling: Rolling, harvest: Harvest, dryRun: DryRun, dailyRows, dailyFileName: dailyPath.split(/[\\/]/).pop(), shiftBook: shiftWb, shiftFileName: shiftPath.split(/[\\/]/).pop(), referenceDate: REF });
const board = Board.buildBoard({
  executed, referenceDate: REF, generatedAt: new Date().toISOString(),
  files: { shift: { name: 'shift', ok: true }, daily: { name: 'daily', ok: true } }, names,
  actualDays: (parsedDaily.records || []).filter((r) => r.hoursOk !== false && typeof r.hours === 'number').map((r) => ({ transportId: r.transportId, date: r.date, hours: r.hours })),
}, { analyze: Dash.analyzePrediction, dispositionOf: Snap.dispositionOf });
const snap = Snap.buildSnapshot(executed, null);
const inoById = Object.fromEntries(snap.alerts.map((a) => [a.transportId, a]));

console.log('reference date handed over:', executed.referenceDate, '| snapshot horizon:', snap.horizon.referenceDate, snap.horizon.referenceDateSource);
console.log('FRIDAY counts (engine vs snapshot):', ['exceedCount', 'approachCount', 'partialCount', 'undeterminedCount', 'clearCount', 'driverCount'].map((k) => `${k}=${executed.summary[k]}/${snap.counts[k]}`).join(' '));
let bad = 0;
const targets = board.rows.filter((r) => ids.includes(r.transportId) || keys.includes(nameKey(r.name)));
targets.forEach((r) => {
  const i = inoById[r.transportId];
  const MAP = { 'actual-exceed': 'exceed', 'forecast-exceed': 'exceed', caution: 'approach', review: 'undetermined' };
  const okCurrent = r.judgment === 'ok' ? (!i || i.period === 'future') : (i && i.period === 'current' && i.disposition === MAP[r.judgment] && i.judgmentCode === r.judgment);
  const futureOfk = r.futureExceed ? Board.clockText(r.futureExceed.overBy) : null;
  const futureIno = i && i.futureExceed ? i.futureExceed.overByText : null;
  const okFuture = futureOfk === futureIno;
  if (!okCurrent || !okFuture) bad++;
  console.log([
    (Board.displayName(r)), r.transportId,
    'OFK3:', Board.judgmentText(r), 'past6=' + Board.clockText(r.past6.hours), 'forecast=' + Board.clockText(r.forecast.hours), 'workable=' + Board.clockText(r.workable.hours),
    '| INO-1:', i ? `${i.statusLabel} ${i.totalHoursText} future=${futureIno || '-'}` : '(no current row = normal)',
    '|', okCurrent && okFuture ? 'MATCH' : 'MISMATCH',
  ].join(' '));
  (r.days || []).forEach((d) => console.log('   ', d.date, Board.clockText(d.hours), d.adopted));
  (r.recordedActuals || []).forEach((d) => console.log('    actual', d.date, Board.clockText(d.hours)));
});
if (!targets.length) console.log('no matching person for the given keys/ids');
process.exit(bad ? 1 : 0);
