import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const TwcAnalysisCore = require('../twc-analysis-core.js');
const XLSX = require('../../fujin/node_modules/xlsx');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'twc-w34');

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
}

function loadRows(fileName) {
  const buf = readFileSync(join(fixtureDir, fileName));
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
}

const TWC_FILE = 'Wk34_OFK3_GDS_TWC_Failed_Deliveries.xlsx';
const GDS_FILE = 'Wk34_OFK3_GDS_Raw_Data_for_DSP_SLS.xlsx';

const MASTER = {
  AK04JCSQ348UV: { driverName: '山田太郎', department: 'GDSダイレクト' },
  A1RVJFJDRIU9NB: { driverName: '佐藤次郎', department: 'JHS' },
  A2MIZV1UOZL3Q0: { driverName: '鈴木一郎', department: 'AE物流' },
};

function lookupDriver(tid) {
  return MASTER[tid] || null;
}

function run() {
  const twcRows = loadRows(TWC_FILE);
  const gdsRows = loadRows(GDS_FILE);

  // 1) 列構造で自動判定（ファイル名に依存しない）
  assert(TwcAnalysisCore.detectWorkbookKind(twcRows) === 'twc', 'TWC detected from columns');
  assert(TwcAnalysisCore.detectWorkbookKind(gdsRows) === 'gds_sls', 'GDS SLS detected from columns');
  const renamedTwc = TwcAnalysisCore.detectKindFromHeaders(twcRows[0]);
  const renamedGds = TwcAnalysisCore.detectKindFromHeaders(gdsRows[0]);
  assert(renamedTwc === 'twc', 'TWC headers still twc without filename');
  assert(renamedGds === 'gds_sls', 'GDS headers still gds_sls without filename');

  // 2) 投入順序逆転
  const fwd = TwcAnalysisCore.processDroppedWorkbooks(
    [
      { fileName: 'alpha.xlsx', rows: twcRows },
      { fileName: 'beta.xlsx', rows: gdsRows },
    ],
    { lookupDriver: lookupDriver, departments: ['GDSダイレクト', 'JHS', 'AE物流'] }
  );
  const rev = TwcAnalysisCore.processDroppedWorkbooks(
    [
      { fileName: 'beta.xlsx', rows: gdsRows },
      { fileName: 'alpha.xlsx', rows: twcRows },
    ],
    { lookupDriver: lookupDriver, departments: ['GDSダイレクト', 'JHS', 'AE物流'] }
  );
  assert(fwd.ok && rev.ok, 'both orders parse');
  assert(fwd.violations === 27, 'W34 violations 27');
  assert(fwd.invalidRows === 0 && fwd.validRows === 27, 'W34 all valid');
  assert(fwd.partial === false, 'W34 not partial');
  assert(fwd.processedTimeWindowData.records.length === rev.processedTimeWindowData.records.length, 'order independent record count');
  assert(fwd.classified.twc.length === 1 && rev.classified.twc.length === 1, 'one TWC each way');
  assert(fwd.classified.gdsSls.length === 1 && rev.classified.gdsSls.length === 1, 'one GDS each way');

  // 3) TWC 27件
  const data = fwd.processedTimeWindowData;
  assert(data.records.length === 27, 'TWC 27 rows, got ' + data.records.length);
  assert(data.summary.failedCount === 27, 'failedCount 27');
  assert(data.summary.targetCount === 27, 'targetCount 27');
  assert(data.summary.complianceRate === null, 'complianceRate null without denominator');
  assert(data.week === 34, 'amazon week 34, got ' + data.week);

  // 4) 日時解析 + 超過
  const sample = data.records.find((r) => r.scannableId === 'DA0159976491');
  assert(sample, 'sample scannable present');
  assert(sample.windowStart === '05:00', 'window start');
  assert(sample.windowEnd === '13:00', 'window end');
  assert(sample.plannedEnterTime.indexOf('2026-08-21 12:21') === 0, 'planned JST ' + sample.plannedEnterTime);
  assert(sample.actualAttemptTime.indexOf('2026-08-21 14:23') === 0, 'actual JST ' + sample.actualAttemptTime);
  assert(sample.overMinutes === 83, 'over 83, got ' + sample.overMinutes);

  const maxRec = data.records.reduce((a, b) => (a.overMinutes > b.overMinutes ? a : b));
  assert(maxRec.overMinutes === 192, 'max over 192');
  assert(data.summary.maxOverMinutes === 192, 'summary max 192');
  assert(data.summary.avgOverMinutes === 63, 'avg rounded 63, got ' + data.summary.avgOverMinutes);
  assert(data.summary.medianOverMinutes === 56, 'median 56, got ' + data.summary.medianOverMinutes);

  // 5) Transport ID 照合 / 未照合 / 所属
  const matchedYamada = data.records.filter((r) => r.transportId === 'AK04JCSQ348UV');
  assert(matchedYamada.length === 9, 'yamada 9 fails');
  assert(matchedYamada.every((r) => r.matched && r.driverName === '山田太郎' && r.department === 'GDSダイレクト'), 'yamada name+dept');
  const unmatched = data.records.filter((r) => !r.matched);
  assert(unmatched.length > 0, 'unmatched TIDs remain');
  assert(unmatched.every((r) => r.driverName === ''), 'unmatched have empty name not dropped');
  assert(data.issues.some((x) => x.code === 'UNMATCHED_TID'), 'UNMATCHED_TID issue emitted');

  // 6) TOP3
  assert(data.worstDrivers.length === 3, 'top3');
  assert(data.worstDrivers[0].transportId === 'AK04JCSQ348UV' && data.worstDrivers[0].failedCount === 9, 'top1 9');
  assert(data.worstDrivers[1].failedCount === 4, 'top2 4');
  assert(data.worstDrivers[2].failedCount === 4, 'top3 4');
  assert(data.worstDrivers[0].avgOverMinutes === 98.9, 'top1 avg over ' + data.worstDrivers[0].avgOverMinutes);
  assert(data.worstDrivers[0].maxOverMinutes === 192, 'top1 max over');

  // 7) JOIN 調査: scannable vs tracking は 0 件。統合しない
  const gds = TwcAnalysisCore.parseGdsSlsRows(gdsRows);
  const joinInfo = TwcAnalysisCore.inspectJoin(data.records, gds);
  assert(joinInfo.scannableTrackingOverlap.length === 0, 'no tracking overlap');
  assert(joinInfo.safeToJoin === false, 'not safe to join');
  assert(data.source.gdsIntegrated === false, 'gds not integrated');
  assert(fwd.issues.some((x) => x.code === 'JOIN_SKIPPED'), 'JOIN_SKIPPED issue');

  // 8) 片方のみ: TWC only
  const twcOnly = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'only-twc.xlsx', rows: twcRows }], { lookupDriver: lookupDriver });
  assert(twcOnly.ok, 'TWC only ok');
  assert(twcOnly.processedTimeWindowData.records.length === 27, 'TWC only 27');
  assert(twcOnly.issues.some((x) => x.code === 'GDS_MISSING'), 'GDS_MISSING informational');

  // 9) 片方のみ: GDS only
  const gdsOnly = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'only-gds.xlsx', rows: gdsRows }]);
  assert(gdsOnly.ok === false, 'GDS only cannot produce TWC analysis');
  assert(gdsOnly.issues.some((x) => x.code === 'TWC_MISSING'), 'TWC_MISSING');

  // 10) 不正ファイル
  const bad = TwcAnalysisCore.processDroppedWorkbooks([
    { fileName: 'random.xlsx', rows: [['foo', 'bar'], [1, 2]] },
  ]);
  assert(bad.ok === false, 'unknown file not ok');
  assert(bad.issues.some((x) => x.code === 'UNSUPPORTED_FILE'), 'UNSUPPORTED_FILE');

  const missingCols = TwcAnalysisCore.parseTwcRows([
    ['transporter_id', 'time_window', 'planned_enter_time', 'scannable_id'],
    ['AK04JCSQ348UV', 'DW 05:00:00-13:00:00', '2026-08-21 12:21:00', 'DA1'],
  ]);
  assert(missingCols.ok === false, 'missing required cols');
  assert(missingCols.issues[0].code === 'MISSING_COLUMNS', 'MISSING_COLUMNS got ' + (missingCols.issues[0] && missingCols.issues[0].code));

  // 11) 不正日時でも他行は継続（構造解析は継続、Workbook結果は partial / ok:false）
  const broken = twcRows.map(function (row, idx) {
    if (idx === 1) {
      var copy = row.slice();
      copy[18] = 'not-a-date';
      copy[19] = 'also-bad';
      return copy;
    }
    return row;
  });
  const partial = TwcAnalysisCore.parseTwcRows(broken, { lookupDriver: lookupDriver });
  assert(partial.ok, 'partial parse continues');
  assert(partial.records.length === 27, 'keeps 27 rows including invalid');
  const invalidCount = partial.records.filter((r) => r.status === 'invalid_datetime').length;
  assert(invalidCount === 1, 'one invalid datetime row');
  assert(partial.records.filter((r) => r.overMinutes != null).length === 26, '26 valid overs');
  assert(partial.partial === true, 'parseTwcRows partial');
  assert(partial.validRows === 26, 'parseTwcRows valid 26');
  assert(partial.invalidRows === 1, 'parseTwcRows invalid 1');
  assert(partial.violations === null, 'parseTwcRows violations null when invalid exists');
  const partialWb = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'partial.xlsx', rows: broken }], { lookupDriver: lookupDriver });
  assert(partialWb.ok === false, 'partial workbook not fully ok');
  assert(partialWb.partial === true, 'partial flag');
  assert(partialWb.validRows === 26, '26 valid');
  assert(partialWb.invalidRows === 1, '1 invalid');
  assert(partialWb.violations === null, 'violations null when partial');
  assert(partialWb.processedTimeWindowData === null, 'do not persist partial as success');
  assert(partialWb.reason === 'datetime-format-unrecognized', 'partial reason');

  // 12) 重複
  const dupRows = twcRows.concat([twcRows[1]]);
  const dup = TwcAnalysisCore.parseTwcRows(dupRows, { lookupDriver: lookupDriver });
  assert(dup.records.length === 28, 'duplicate row kept');
  assert(dup.issues.some((x) => x.code === 'DUPLICATE'), 'DUPLICATE issue');
  assert(dup.records.filter((r) => r.duplicate).length >= 1, 'duplicate flagged');

  // 13) エクスポート
  const json = TwcAnalysisCore.toChappyJson(data);
  assert(json.reportType === 'TWC', 'json reportType');
  assert(json.week === 34, 'json week');
  assert(json.summary.failedCount === 27, 'json failedCount');
  assert(json.summary.complianceRate === null, 'json complianceRate null');
  assert(json.summary.avgOverMinutes === 63, 'json avg');
  assert(json.summary.maxOverMinutes === 192, 'json max');
  assert(json.worstDrivers[0].failedCount === 9, 'json top driver');
  assert(json.worstDrivers[0].driverName === '山田太郎', 'json driver name');
  const csv = TwcAnalysisCore.toCsv(data);
  assert(csv.indexOf('transportId') >= 0, 'csv header');
  assert(csv.split('\n').length >= 28, 'csv 27 data + header');
  assert(csv.indexOf('未照合') >= 0, 'csv unmatched label');

  // week helper: W34 Sunday-Saturday
  const aug16 = new Date(Date.UTC(2026, 7, 16, 3, 0, 0)); // 12:00 JST Aug 16
  assert(TwcAnalysisCore.amazonWeekFromDate(aug16) === 34, 'Aug 16 2026 is week 34');

  const indexHtml = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
  assert(indexHtml.indexOf('twc-analysis-core.js') >= 0, 'index.html loads twc-analysis-core.js');
  assert(indexHtml.indexOf('id="twc-drop-zone"') >= 0, 'existing 時間指定 tab has D&D zone');
  assert(indexHtml.indexOf('function twExtract()') >= 0, 'daily twExtract kept');
  assert((indexHtml.match(/id="tab-tw-extract"/g) || []).length === 1, 'no duplicate 時間指定 tab');
  assert(indexHtml.indexOf('時間指定失敗') >= 0, 'team quality shows TWC failed column');
  assert(indexHtml.indexOf('calcDriverScore') >= 0, 'quality score function still present');
  assert(indexHtml.indexOf('TWCデータは読み込めましたが') >= 0, 'UI has datetime safety copy');
  assert(indexHtml.indexOf('違反0件ではありません') >= 0, 'UI distinguishes zero violations');
  assert(indexHtml.indexOf('twcExportAllowed') >= 0, 'export gated after failed parse');

  // 14) 日時形式分類。amazon-short-time は検出のみで変換しない
  assert(TwcAnalysisCore.classifyDatetimeFormat(46255.599399791667) === 'excel-serial', 'classify excel-serial number');
  assert(TwcAnalysisCore.classifyDatetimeFormat('46255.599') === 'excel-serial', 'classify excel-serial string');
  assert(TwcAnalysisCore.classifyDatetimeFormat('2026/9/4 13:10') === 'full-datetime', 'classify ymd datetime');
  assert(TwcAnalysisCore.classifyDatetimeFormat('2026-09-04 13:10:30') === 'full-datetime', 'classify iso datetime');
  assert(TwcAnalysisCore.classifyDatetimeFormat('13:10') === 'time-only', 'classify time-only');
  assert(TwcAnalysisCore.classifyDatetimeFormat('13:10:30') === 'time-only-with-seconds', 'classify time-only-with-seconds');
  assert(TwcAnalysisCore.classifyDatetimeFormat('09:57.9') === 'amazon-short-time', 'classify amazon-short-time');
  assert(TwcAnalysisCore.classifyDatetimeFormat('33:27.6') === 'amazon-short-time', 'classify amazon-short-time overflow minutes');
  assert(TwcAnalysisCore.classifyDatetimeFormat('') === 'empty', 'classify empty');
  assert(TwcAnalysisCore.classifyDatetimeFormat('also-bad') === 'unknown', 'classify unknown');
  assert(TwcAnalysisCore.parseDateTime('09:57.9') === null, 'never convert amazon-short-time');
  assert(TwcAnalysisCore.parseDateTime('13:10') === null, 'never convert time-only');
  assert(TwcAnalysisCore.parseDateTime('13:10:30') === null, 'never convert time-only-with-seconds');
  const serialParsed = TwcAnalysisCore.parseDateTime(46255.599399791667);
  assert(serialParsed instanceof Date && !isNaN(serialParsed.getTime()), 'excel-serial still parses');
  const csvParsed = TwcAnalysisCore.parseDateTime('2026/9/4 13:10');
  assert(csvParsed instanceof Date && TwcAnalysisCore.formatJst(csvParsed).indexOf('2026-09-04 13:10') === 0, 'full datetime CSV parses ' + TwcAnalysisCore.formatJst(csvParsed));

  const TWC_HEADER = [
    'dim_business', 'dim_location', 'dim_country', 'provider_type', 'service_type',
    'customer_ship_option', 'shipment_ship_option', 'time_window', 'delivery_promise',
    'scannable_id', 'transporter_id', 'parent_location', 'provider_company_name',
    'manifest_cycle', 'dispatch_cycle', 'cit', 'ib_arrival_time', 'first_dispatched_datetime',
    'planned_enter_time', 'actual_attempt_time', 'is_mnr', 'is_cluster_transfer', 'failure_bridge',
  ];
  function synthTwcRow(id, actual, planned) {
    return [
      'AMZL', 'OFK3', 'JP', 'DSP', 'Standard Parcel', 'rush', 'rush',
      'DW 05:00:00-13:00:00', 'OND', id, 'AK04JCSQ348UV', 'DFK2', 'GDS',
      'CYCLE_1', 'CYCLE_1', '', '', '53:18.0', planned, actual, 'N', 'N', 'driver_controllable',
    ];
  }

  // 15) 完全日時CSV → ok:true
  const fullCsvRows = [
    TWC_HEADER,
    synthTwcRow('DAFULL1', '2026/09/04 13:09:57', '2026/09/04 11:52:00'),
    synthTwcRow('DAFULL2', '2026-09-04 14:23:00', '2026-09-04 12:21:00'),
  ];
  const fullCsv = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'twc-full.csv', rows: fullCsvRows }], { lookupDriver: lookupDriver });
  assert(fullCsv.ok === true, 'full datetime CSV ok');
  assert(fullCsv.violations === 2, 'full datetime CSV violations 2');
  assert(fullCsv.invalidRows === 0, 'full datetime CSV no invalid');
  assert(fullCsv.processedTimeWindowData && fullCsv.processedTimeWindowData.records.length === 2, 'full datetime CSV persisted');

  // 16) amazon-short-time 81件 → ok:false / violations:null
  const shortRows = [TWC_HEADER];
  for (let i = 0; i < 81; i++) {
    shortRows.push(synthTwcRow('DASHORT' + i, i % 2 ? '33:27.6' : '09:57.9', '2026/9/4 11:52'));
  }
  const shortWb = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'twc-w36.csv', rows: shortRows }], { lookupDriver: lookupDriver });
  assert(shortWb.ok === false, 'amazon-short-time not ok');
  assert(shortWb.reason === 'datetime-format-unrecognized', 'amazon-short-time reason');
  assert(shortWb.totalRows === 81, 'amazon-short-time total 81');
  assert(shortWb.validRows === 0, 'amazon-short-time valid 0');
  assert(shortWb.invalidRows === 81, 'amazon-short-time invalid 81');
  assert(shortWb.violations === null, 'amazon-short-time violations null not 0');
  assert(shortWb.formatCounts['amazon-short-time'] === 81, 'amazon-short-time format count');
  assert(shortWb.processedTimeWindowData === null, 'amazon-short-time not saved as success');
  assert(!shortWb.issues.some((x) => x.code === 'MISSING_COLUMNS'), 'not a missing-column error');

  const w36Path = 'C:/Users/PC-2320/AppData/Local/Temp/Wk36_OFK3_GDS_Dive Deep Data TWC Failed Deliveries - Driver Controllable(9) (13).csv';
  try {
    const w36Buf = readFileSync(w36Path);
    const w36wb = XLSX.read(w36Buf, { type: 'buffer', cellDates: true, raw: true });
    const w36rows = XLSX.utils.sheet_to_json(w36wb.Sheets[w36wb.SheetNames[0]], { header: 1, defval: '', raw: true });
    const w36 = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'w36.csv', rows: w36rows }], { lookupDriver: lookupDriver });
    assert(w36.ok === false, 'real W36 csv not ok');
    assert(w36.totalRows === 81, 'real W36 81 rows, got ' + w36.totalRows);
    assert(w36.invalidRows === 81 && w36.validRows === 0, 'real W36 all invalid');
    assert(w36.violations === null, 'real W36 violations null');
    assert(w36.formatCounts['amazon-short-time'] === 81, 'real W36 amazon-short-time 81');
    assert(w36.processedTimeWindowData === null, 'real W36 not persisted');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.log('W36 real file skipped (not found)');
    } else {
      throw e;
    }
  }

  // 17) empty actual → ok:false
  const emptyRows = [TWC_HEADER, synthTwcRow('DAEMPTY1', '', '2026/9/4 11:52')];
  const emptyWb = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'empty-actual.csv', rows: emptyRows }]);
  assert(emptyWb.ok === false, 'empty actual not ok');
  assert(emptyWb.violations === null, 'empty actual violations null');
  assert(emptyWb.formatCounts.empty === 1, 'empty format counted');

  // 18) unknown actual → ok:false
  const unknownRows = [TWC_HEADER, synthTwcRow('DAUNK1', 'not-a-date', '2026/9/4 11:52')];
  const unknownWb = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'unknown-actual.csv', rows: unknownRows }]);
  assert(unknownWb.ok === false, 'unknown actual not ok');
  assert(unknownWb.violations === null, 'unknown actual violations null');
  assert(unknownWb.formatCounts.unknown === 1, 'unknown format counted');

  // 19) 正常解析した違反0件（ヘッダーのみ）
  const zeroWb = TwcAnalysisCore.processDroppedWorkbooks([{ fileName: 'zero.csv', rows: [TWC_HEADER] }]);
  assert(zeroWb.ok === true, 'header-only analyzed ok');
  assert(zeroWb.totalRows === 0 && zeroWb.validRows === 0 && zeroWb.invalidRows === 0, 'header-only counts');
  assert(zeroWb.violations === 0, 'true zero violations');
  assert(zeroWb.processedTimeWindowData != null, 'true zero may persist as analyzed empty');
  assert(zeroWb.processedTimeWindowData.summary.failedCount === 0, 'true zero failedCount 0');

  console.log('twc-analysis tests passed');
}

run();
