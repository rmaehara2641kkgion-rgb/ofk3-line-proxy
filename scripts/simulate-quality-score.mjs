import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('../../fujin/node_modules/xlsx');

const INDEX = path.resolve('index.html');
const downloads = 'C:/Users/PC-2320/Downloads';
const desktop = 'C:/Users/PC-2320/OneDrive/Desktop';
const TQ_EXCLUDED = new Set(['GDS管理', '未所属']);
const OLD_WEIGHTS = { dnrPerDriver: 5, ftdsPerPkg: 2, misRate: 10, deliveryGap: 0.5 };

function findFile(baseNames) {
  for (const dir of [downloads, desktop]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      for (const base of baseNames) {
        if (name.includes(base) && name.endsWith('.xlsx')) return path.join(dir, name);
      }
    }
  }
  return null;
}

function extractDriverDB(html) {
  const start = html.indexOf('var driverDB = {');
  if (start < 0) throw new Error('driverDB not found');
  const end = html.indexOf('// driverDBオーバーレイ', start);
  const block = html.slice(start, end).trim().replace(/;\s*$/, '');
  return Function('return ' + block.replace(/^var driverDB = /, ''))();
}

function normalizeReportHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isTransporterHeader(h) {
  const n = normalizeReportHeader(h);
  const compact = n.replace(/\s/g, '');
  return n === 'transporter id' || n === 'transporter_id' || compact === 'transporterid' || compact === 'transportid';
}

function mapAnalysisHeaderColumns(headerRow) {
  const cols = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = normalizeReportHeader(headerRow[i]);
    const raw = String(headerRow[i] || '').trim();
    if (isTransporterHeader(raw)) cols.tid = i;
    else if (h.includes('ドライバ') || h.includes('driver')) cols.driver = i;
    else if (h.includes('件数合計')) cols.count = i;
    else if ((h === '件数' || h.includes('件数')) && cols.count === undefined) cols.count = i;
    else if (h.includes('べき架電') || h.includes('ベキ架電')) cols.ccRequired = i;
    else if (h.includes('実架電')) cols.ccActual = i;
    else if (h.includes('対象週')) cols.weekCount = i;
  }
  return cols;
}

function findAnalysisHeaderRow(rows, kind) {
  for (let ri = 0; ri < Math.min(rows.length, 15); ri++) {
    const cols = mapAnalysisHeaderColumns(rows[ri]);
    if (cols.tid === undefined) continue;
    if (kind === 'ftds') {
      if (cols.count !== undefined) return ri;
    } else if (cols.ccRequired !== undefined || cols.ccActual !== undefined) {
      return ri;
    }
  }
  return -1;
}

function findCumulativeSheetName(wb) {
  for (const name of wb.SheetNames) {
    if (name.indexOf('累計') === 0) return name;
  }
  return null;
}

function loadCumulativeRows(filePath, kind) {
  const wb = XLSX.read(fs.readFileSync(filePath));
  const sheet = findCumulativeSheetName(wb);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });
  const headerIdx = findAnalysisHeaderRow(rows, kind);
  const cols = mapAnalysisHeaderColumns(rows[headerIdx]);
  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const tid = String(row[cols.tid] || '').trim();
    if (!tid) continue;
    const driver = cols.driver !== undefined ? String(row[cols.driver] || '').trim() : '';
    const weekCount = cols.weekCount !== undefined ? parseInt(row[cols.weekCount], 10) || 0 : 0;
    if (kind === 'ftds') {
      out.push({
        driver,
        tid,
        ftdsCount: cols.count !== undefined ? parseInt(row[cols.count], 10) || 0 : 0,
        weekCount
      });
    } else {
      out.push({
        driver,
        tid,
        ccRequired: cols.ccRequired !== undefined ? parseInt(row[cols.ccRequired], 10) || 0 : 0,
        ccActual: cols.ccActual !== undefined ? parseInt(row[cols.ccActual], 10) || 0 : 0,
        weekCount
      });
    }
  }
  return { sheet, rows: out, weekCount: out[0] && out[0].weekCount ? out[0].weekCount : 4 };
}

function resolveDriverKey(name, driverDB) {
  if (!name) return '';
  if (driverDB[name]) return name;
  const lower = name.toLowerCase();
  for (const k of Object.keys(driverDB)) {
    if (k.toLowerCase() === lower) return k;
  }
  return name;
}

function buildDrivers(driverDB, ftdsRows, ccRows) {
  const drivers = {};
  for (const name of Object.keys(driverDB)) {
    const db = driverDB[name];
    drivers[name] = {
      name,
      dept: 'GDSダイレクト',
      packagesPerHour: db.packagesPerHour || 0,
      misdeliveryRate: db.misdeliveryRate || 0,
      deliveryRate: db.deliveryRate || 0,
      totalPackages: db.totalPackages || 0,
      dnrCount: 0,
      ftdsCount: 0,
      ftdsWeekCount: 0,
      ccRequired: 0,
      ccActual: 0,
      ccWeekCount: 0
    };
  }
  for (const row of ftdsRows) {
    const key = resolveDriverKey(row.driver, driverDB);
    if (!drivers[key]) {
      drivers[key] = {
        name: key,
        dept: 'GDSダイレクト',
        packagesPerHour: 0,
        misdeliveryRate: 0,
        deliveryRate: 100,
        totalPackages: 0,
        dnrCount: 0,
        ftdsCount: 0,
        ftdsWeekCount: 0,
        ccRequired: 0,
        ccActual: 0,
        ccWeekCount: 0
      };
    }
    drivers[key].ftdsCount = row.ftdsCount;
    drivers[key].ftdsWeekCount = Math.max(drivers[key].ftdsWeekCount, row.weekCount || 0);
  }
  for (const row of ccRows) {
    const key = resolveDriverKey(row.driver, driverDB);
    if (!drivers[key]) continue;
    drivers[key].ccRequired = row.ccRequired;
    drivers[key].ccActual = row.ccActual;
    drivers[key].ccWeekCount = Math.max(drivers[key].ccWeekCount, row.weekCount || 0);
  }
  return drivers;
}

function calcOldScore(d) {
  let s = 100;
  const parts = [];
  const dnrPen = (d.dnrCount || 0) * OLD_WEIGHTS.dnrPerDriver;
  if (dnrPen) parts.push({ item: 'DNR', pen: dnrPen });
  s -= dnrPen;
  let ftdsPen = 0;
  if (d.totalPackages > 0 && d.ftdsCount) {
    ftdsPen = (d.ftdsCount / d.totalPackages * 1000) * OLD_WEIGHTS.ftdsPerPkg;
    parts.push({ item: 'FTDS', pen: ftdsPen, detail: d.ftdsCount + '件/' + d.totalPackages + '個' });
    s -= ftdsPen;
  }
  const misPen = (d.misdeliveryRate || 0) * OLD_WEIGHTS.misRate;
  if (misPen) parts.push({ item: '誤配', pen: misPen, detail: d.misdeliveryRate + '%' });
  s -= misPen;
  const delPen = (100 - (d.deliveryRate || 100)) * OLD_WEIGHTS.deliveryGap;
  if (delPen > 0 && d.deliveryRate) parts.push({ item: '配完', pen: delPen, detail: d.deliveryRate + '%' });
  s -= delPen;
  if (s < 0) s = 0;
  if (s > 100) s = 100;
  return { score: Math.round(s), parts };
}

function getEffectiveWeeklyFtds(d) {
  const count = d.ftdsCount || 0;
  if (!count) return 0;
  const weeks = d.ftdsWeekCount || 0;
  return weeks > 1 ? count / weeks : count;
}

function calcFtdsScorePenalty(d) {
  const weekly = getEffectiveWeeklyFtds(d);
  if (weekly <= 0) return 0;
  let tier = 0;
  if (weekly <= 2) tier = 3;
  else if (weekly <= 5) tier = 8;
  else if (weekly <= 10) tier = 14;
  else if (weekly <= 20) tier = 20;
  else if (weekly <= 35) tier = 26;
  else tier = 32;
  let ratePen = 0;
  if (d.totalPackages > 0) {
    let pkgBase = d.totalPackages;
    if ((d.ftdsWeekCount || 0) > 1) pkgBase = d.totalPackages / d.ftdsWeekCount;
    if (pkgBase < weekly) pkgBase = weekly;
    const rate = weekly / pkgBase * 1000;
    if (rate >= 80) ratePen = 40;
    else if (rate >= 50) ratePen = 32;
    else if (rate >= 30) ratePen = 24;
    else if (rate >= 15) ratePen = 16;
    else if (rate >= 8) ratePen = 10;
    else if (rate >= 4) ratePen = 6;
  }
  return Math.min(Math.max(tier, ratePen), 40);
}

function tieredDnrPenalty(count) {
  if (count <= 0) return 0;
  if (count === 1) return 5;
  if (count <= 2) return 10;
  if (count <= 4) return 15;
  return 20;
}

function calcMisPenalty(rate) {
  if (!rate) return 0;
  const raw = rate * OLD_WEIGHTS.misRate;
  if (raw >= 12) return 20;
  return Math.min(raw, 15);
}

function calcDeliveryPenalty(deliveryRate) {
  if (!deliveryRate) return 0;
  const gap = 100 - deliveryRate;
  if (gap <= 0) return 0;
  const raw = gap * OLD_WEIGHTS.deliveryGap;
  if (gap >= 15) return Math.min(raw, 20);
  return Math.min(raw, 12);
}

function calcCcPenalty(required, actual) {
  if (!required || required <= 0) return 0;
  const rate = actual / required;
  if (rate >= 0.5) return 0;
  if (rate >= 0.3) return 4;
  if (rate >= 0.15) return 8;
  if (rate >= 0.08) return 12;
  if (rate > 0) return 16;
  return 18;
}

function calcNewScore(d) {
  let s = 100;
  const parts = [];
  const dnrPen = tieredDnrPenalty(d.dnrCount || 0);
  if (dnrPen) parts.push({ item: 'DNR', pen: dnrPen });
  s -= dnrPen;
  const ftdsPen = calcFtdsScorePenalty(d);
  if (ftdsPen) parts.push({ item: 'FTDS', pen: ftdsPen, detail: Math.round(getEffectiveWeeklyFtds(d) * 10) / 10 + '件/週' });
  s -= ftdsPen;
  const misPen = calcMisPenalty(d.misdeliveryRate || 0);
  if (misPen) parts.push({ item: '誤配', pen: misPen });
  s -= misPen;
  const delPen = calcDeliveryPenalty(d.deliveryRate || 0);
  if (delPen) parts.push({ item: '配完', pen: delPen });
  s -= delPen;
  const ccPen = calcCcPenalty(d.ccRequired || 0, d.ccActual || 0);
  if (ccPen) parts.push({ item: 'CC', pen: ccPen, detail: d.ccActual + '/' + d.ccRequired });
  s -= ccPen;
  if (s < 0) s = 0;
  if (s > 100) s = 100;
  return { score: Math.round(s), parts };
}

function bucket(score) {
  if (score >= 90) return '90-100';
  if (score >= 75) return '75-89';
  if (score >= 60) return '60-74';
  if (score >= 40) return '40-59';
  if (score >= 20) return '20-39';
  if (score >= 1) return '1-19';
  return '0';
}

function distribution(list, scorer) {
  const buckets = { '90-100': 0, '75-89': 0, '60-74': 0, '40-59': 0, '20-39': 0, '1-19': 0, '0': 0 };
  for (const d of list) buckets[bucket(scorer(d).score)]++;
  return buckets;
}

const html = fs.readFileSync(INDEX, 'utf8');
const driverDB = extractDriverDB(html);
const ftdsFile = findFile(['FTDS_累計W28']);
const ccFile = findFile(['ContactCompliance_累計W28']);
const ftds = loadCumulativeRows(ftdsFile, 'ftds');
const cc = loadCumulativeRows(ccFile, 'cc');
const driversObj = buildDrivers(driverDB, ftds.rows, cc.rows);
const drivers = Object.values(driversObj).filter(d => !TQ_EXCLUDED.has(d.dept) && (d.ftdsCount > 0 || d.totalPackages > 0));

const scored = drivers.map(d => {
  const oldR = calcOldScore(d);
  const newR = calcNewScore(d);
  return { ...d, oldScore: oldR.score, newScore: newR.score, oldParts: oldR.parts, newParts: newR.parts };
});

const before = distribution(scored, d => ({ score: d.oldScore }));
const after = distribution(scored, d => ({ score: d.newScore }));

function pickSample(targetOld, tolerance) {
  return scored
    .filter(d => Math.abs(d.oldScore - targetOld) <= tolerance)
    .sort((a, b) => b.oldScore - a.oldScore)[0];
}

const samples = [
  pickSample(100, 5) || pickSample(95, 5),
  pickSample(80, 8),
  pickSample(50, 15),
  ...scored.filter(d => d.oldScore === 0).slice(0, 3)
].filter(Boolean);

const uniqueSamples = [];
const seen = new Set();
for (const s of samples) {
  if (seen.has(s.name)) continue;
  seen.add(s.name);
  uniqueSamples.push({
    name: s.name,
    oldScore: s.oldScore,
    newScore: s.newScore,
    ftdsCount: s.ftdsCount,
    ftdsWeekCount: s.ftdsWeekCount,
    mis: s.misdeliveryRate,
    del: s.deliveryRate,
    cc: s.ccRequired ? s.ccActual + '/' + s.ccRequired : '-',
    oldReason: s.oldParts.sort((a, b) => b.pen - a.pen).slice(0, 3).map(p => p.item + ':' + Math.round(p.pen * 10) / 10).join(', '),
    newReason: s.newParts.sort((a, b) => b.pen - a.pen).slice(0, 3).map(p => p.item + ':' + p.pen).join(', ')
  });
}

console.log(JSON.stringify({
  ftdsFile,
  ccFile,
  ftdsSheet: ftds.sheet,
  ccSheet: cc.sheet,
  driverCount: drivers.length,
  ftdsMatched: ftds.rows.length,
  before,
  after,
  zeroBefore: scored.filter(d => d.oldScore === 0).length,
  zeroAfter: scored.filter(d => d.newScore === 0).length,
  samples: uniqueSamples,
  worstOld: scored.sort((a, b) => a.oldScore - b.oldScore).slice(0, 5).map(d => ({
    name: d.name, oldScore: d.oldScore, newScore: d.newScore, ftds: d.ftdsCount, tp: d.totalPackages,
    oldParts: d.oldParts
  }))
}, null, 2));
