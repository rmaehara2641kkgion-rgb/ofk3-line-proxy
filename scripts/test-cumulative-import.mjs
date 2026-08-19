import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('../../fujin/node_modules/xlsx');

const downloads = 'C:/Users/PC-2320/Downloads';
const desktop = 'C:/Users/PC-2320/OneDrive/Desktop';

function findFile(baseNames) {
  for (const dir of [downloads, desktop]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      for (const base of baseNames) {
        if (name.includes(base) && (name.endsWith('.xlsx') || name.endsWith('.csv'))) {
          return path.join(dir, name);
        }
      }
    }
  }
  return null;
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
    else if (h.includes('日付')) cols.date = i;
    else if (h.includes('失敗理由') && h.includes('内訳')) cols.reasonBreakdown = i;
    else if (h.includes('べき架電') || h.includes('ベキ架電')) cols.ccRequired = i;
    else if (h.includes('実架電')) cols.ccActual = i;
    else if (h.includes('通話回数')) cols.ccActual = i;
    else if (h.includes('通話時間')) cols.duration = i;
    else if (h.includes('架電率')) cols.ccRate = i;
    else if (h.includes('理由内訳')) cols.reasonBreakdown = i;
    else if (h.includes('対象週')) cols.weekCount = i;
  }
  return cols;
}

function findAnalysisHeaderRow(rows, kind) {
  for (let ri = 0; ri < Math.min(rows.length, 15); ri++) {
    const cols = mapAnalysisHeaderColumns(rows[ri]);
    if (cols.tid === undefined) continue;
    if (kind === 'ftds') {
      if (cols.count !== undefined || cols.reasonBreakdown !== undefined) return ri;
    } else if (cols.ccRequired !== undefined || cols.ccActual !== undefined || cols.reasonBreakdown !== undefined) {
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

function getSheetRows(wb, sheetName) {
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
}

function csvTextToRows(text) {
  const wb = XLSX.read(String(text || '').replace(/^\ufeff/, ''), { type: 'string' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
}

function calcCcCallRate(required, actual) {
  const r = required != null ? required : 0;
  const a = actual != null ? actual : 0;
  if (r <= 0) return null;
  return Math.round(a / r * 1000) / 10;
}

function testFtdsCumulative(filePath) {
  const wb = XLSX.read(fs.readFileSync(filePath));
  const sheet = findCumulativeSheetName(wb);
  if (!sheet) throw new Error('累計 sheet not found');
  const rows = getSheetRows(wb, sheet);
  const headerIdx = findAnalysisHeaderRow(rows, 'ftds');
  const cols = mapAnalysisHeaderColumns(rows[headerIdx]);
  if (cols.tid === undefined) throw new Error('TransportID not found: ' + JSON.stringify(rows[headerIdx]));
  let drivers = 0;
  let sample = null;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const tid = String(rows[r][cols.tid] || '').trim();
    if (!tid) continue;
    drivers++;
    if (tid === 'ANHZHN5DGDX2W') {
      sample = {
        tid,
        driver: cols.driver !== undefined ? rows[r][cols.driver] : '',
        count: cols.count !== undefined ? parseInt(rows[r][cols.count], 10) : 0
      };
    }
  }
  return { sheet, drivers, sample };
}

function testCcCumulative(filePath) {
  const wb = XLSX.read(fs.readFileSync(filePath));
  const sheet = findCumulativeSheetName(wb);
  if (!sheet) throw new Error('累計 sheet not found');
  const rows = getSheetRows(wb, sheet);
  const headerIdx = findAnalysisHeaderRow(rows, 'cc');
  const cols = mapAnalysisHeaderColumns(rows[headerIdx]);
  if (cols.tid === undefined) throw new Error('TransportID not found: ' + JSON.stringify(rows[headerIdx]));
  let drivers = 0;
  let sample = null;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const tid = String(rows[r][cols.tid] || '').trim();
    if (!tid) continue;
    drivers++;
    if (tid === 'ANHZHN5DGDX2W') {
      const ccRequired = cols.ccRequired !== undefined ? parseInt(rows[r][cols.ccRequired], 10) || 0 : 0;
      const ccActual = cols.ccActual !== undefined ? parseInt(rows[r][cols.ccActual], 10) || 0 : 0;
      const duration = cols.duration !== undefined ? parseInt(rows[r][cols.duration], 10) || 0 : 0;
      sample = {
        tid,
        driver: cols.driver !== undefined ? rows[r][cols.driver] : '',
        ccRequired,
        ccActual,
        duration,
        rate: calcCcCallRate(ccRequired, ccActual)
      };
    }
  }
  return { sheet, drivers, sample };
}

function testNormalFtdsCsv() {
  const rows = [
    ['ドライバー名', 'TransportID', '件数', '日付', '失敗理由内訳'],
    ['太 武富', 'A1O3I9E330JCLU', 148, '2025-07-07', 'OTHER:148']
  ];
  const headerIdx = findAnalysisHeaderRow(rows, 'ftds');
  const cols = mapAnalysisHeaderColumns(rows[headerIdx]);
  const tid = String(rows[1][cols.tid]).trim();
  const count = parseInt(rows[1][cols.count], 10);
  return { headerIdx, tidCol: cols.tid, driverCol: cols.driver, tid, count };
}

function testNormalCcCsv() {
  const rows = [
    ['ドライバー名', 'TransportID', '件数', '通話回数', '通話時間(秒)', '日付', '理由内訳'],
    ['テスト 太郎', 'TESTTID1234567', 10, 3, 120, '2025-07-07', 'OTHER:10']
  ];
  const headerIdx = findAnalysisHeaderRow(rows, 'cc');
  const cols = mapAnalysisHeaderColumns(rows[headerIdx]);
  return {
    headerIdx,
    tidCol: cols.tid,
    driverCol: cols.driver,
    ccActualCol: cols.ccActual,
    tid: String(rows[1][cols.tid]).trim()
  };
}

const results = [];

const ftdsXlsx = findFile(['FTDS_累計W28', 'FTDS_累計']);
if (ftdsXlsx) {
  const r = testFtdsCumulative(ftdsXlsx);
  results.push({ test: 'FTDS cumulative XLSX', file: ftdsXlsx, ok: r.sample && r.sample.count === 413, ...r });
} else {
  results.push({ test: 'FTDS cumulative XLSX', ok: false, error: 'file not found' });
}

const ccXlsx = findFile(['ContactCompliance_累計W28', 'ContactCompliance_累計']);
if (ccXlsx) {
  const r = testCcCumulative(ccXlsx);
  results.push({
    test: 'CC cumulative XLSX',
    file: ccXlsx,
    ok: r.sample && r.sample.ccRequired === 251 && r.sample.ccActual === 17 && r.sample.duration === 878 && r.sample.rate === 6.8,
    ...r
  });
} else {
  results.push({ test: 'CC cumulative XLSX', ok: false, error: 'file not found' });
}

const normalFtds = testNormalFtdsCsv();
results.push({
  test: 'FTDS normal CSV (synthetic)',
  ok: normalFtds.tidCol === 1 && normalFtds.driverCol === 0 && normalFtds.tid === 'A1O3I9E330JCLU' && normalFtds.count === 148,
  ...normalFtds
});

const normalCc = testNormalCcCsv();
results.push({
  test: 'CC normal CSV (synthetic)',
  ok: normalCc.tidCol === 1 && normalCc.driverCol === 0 && normalCc.ccActualCol === 3 && normalCc.tid === 'TESTTID1234567',
  ...normalCc
});

console.log(JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok);
process.exit(failed.length ? 1 : 0);
