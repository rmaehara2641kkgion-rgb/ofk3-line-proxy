import fs from 'fs';
import path from 'path';
import vm from 'vm';

const repoRoot = path.resolve(import.meta.dirname, '..');
const auditPath = path.join(repoRoot, 'tenko-transport-audit.js');

function createMockXlsx() {
  function aoaToSheet(rows) {
    return { _rows: rows };
  }
  return {
    utils: {
      book_new: function() { return { SheetNames: [], Sheets: {} }; },
      aoa_to_sheet: aoaToSheet,
      book_append_sheet: function(wb, sheet, name) {
        wb.SheetNames.push(name);
        wb.Sheets[name] = sheet;
      },
      sheet_to_json: function(sheet, opts) {
        if (opts && opts.header === 1) return sheet._rows || [];
        return [];
      }
    },
    read: function() { throw new Error('read not used in unit tests'); },
    readFile: function() { throw new Error('readFile not used in unit tests'); }
  };
}

function loadAuditApi() {
  const code = fs.readFileSync(auditPath, 'utf8');
  const context = {
    window: {},
    document: {
      getElementById: function() { return null; },
      createElement: function() { return { style: {}, innerHTML: '', className: '', appendChild: function() {} }; },
      body: { appendChild: function() {} },
      readyState: 'complete',
      addEventListener: function() {}
    },
    XLSX: createMockXlsx()
  };
  context.window = context;
  vm.runInNewContext(code, context, { filename: auditPath });
  return context.window.__tenkoTransportAudit;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeShiftWorkbook(rows) {
  const XLSX = createMockXlsx();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'メイン');
  return wb;
}

function runCase1(api) {
  const shift = {
    records: [
      { name: '海鴻 全', japaneseName: '', company: 'GDS', normalizedName: '海鴻 全', transportId: 'ANJ7N6M28B5JO', sheet: 'メイン', sourceRow: 96 },
      { name: '海鴻 全', japaneseName: '', company: 'GDS', normalizedName: '海鴻 全', transportId: 'ANJ7N6M28B5JO', sheet: 'メイン', sourceRow: 219 }
    ],
    sheet: 'メイン',
    stats: { rawMainRows: 2, todayWorkingRows: 2, todayExcludedNonWorking: 0 }
  };
  const amazon = {
    records: [{ name: '海鴻 全', normalizedName: '海鴻 全', transportId: 'A3MFUEBH3M3PPV', sheet: 'test' }],
    lookup: { '海鴻 全': { name: '海鴻 全', normalizedName: '海鴻 全', transportId: 'A3MFUEBH3M3PPV', sheet: 'test' } },
    conflicts: [],
    amazonTidConflicts: [],
    personTids: { '海鴻 全': { 'A3MFUEBH3M3PPV': true } }
  };
  const pop = api.buildShiftAuditPopulation(shift.records);
  assert(pop.rawShiftRows === 2, 'Case1 rawShiftRows');
  assert(pop.uniqueTodayShiftPeople === 1, 'Case1 uniqueTodayShiftPeople');
  assert(pop.exactDuplicateRows === 1, 'Case1 exactDuplicateRows');
  const result = api.runTransportAudit(amazon, shift);
  assert(result.mismatched.length === 1, 'Case1 one mismatch card');
  assert(result.stats.auditEquationOk, 'Case1 equation');
  console.log('Case1 passed');
}

function runCase2(api) {
  const shift = {
    records: [
      { name: '山田 太郎', japaneseName: '太郎 山田', company: 'GDS', normalizedName: '山田 太郎', transportId: 'A123', sheet: 'メイン', sourceRow: 10 },
      { name: '山田 太郎', japaneseName: '太郎 山田', company: 'GDS', normalizedName: '山田 太郎', transportId: 'A999', sheet: 'メイン', sourceRow: 11 }
    ],
    sheet: 'メイン',
    stats: { rawMainRows: 2, todayWorkingRows: 2, todayExcludedNonWorking: 0 }
  };
  const amazon = {
    records: [{ name: '山田 太郎', normalizedName: '山田 太郎', transportId: 'A123', sheet: 'test' }],
    lookup: { '山田 太郎': { name: '山田 太郎', normalizedName: '山田 太郎', transportId: 'A123', sheet: 'test' } },
    conflicts: [],
    amazonTidConflicts: [],
    personTids: { '山田 太郎': { 'A123': true } }
  };
  const pop = api.buildShiftAuditPopulation(shift.records);
  assert(pop.shiftTidConflictPeople === 1, 'Case2 shiftTidConflictPeople');
  assert(pop.uniqueTodayShiftPeople === 1, 'Case2 uniqueTodayShiftPeople');
  const result = api.runTransportAudit(amazon, shift);
  assert(result.shiftTidConflicts.length === 1, 'Case2 shiftTidConflicts result');
  assert(result.shiftTidConflicts[0].shiftTransportIds.length === 2, 'Case2 two shift TIDs');
  assert(result.mismatched.length === 0, 'Case2 not in mismatched');
  assert(result.stats.shiftTidConflictPeople === 1, 'Case2 stats');
  console.log('Case2 passed');
}

function runCase3(api) {
  const amazon = {
    records: [
      { name: 'Taro Yamada', normalizedName: 'taro yamada', transportId: 'A111', sheet: 'test', sourceRow: 5 },
      { name: 'Taro Yamada', normalizedName: 'taro yamada', transportId: 'A111', sheet: 'test', sourceRow: 6 }
    ],
    lookup: { 'taro yamada': { name: 'Taro Yamada', normalizedName: 'taro yamada', transportId: 'A111', sheet: 'test' } },
    conflicts: [],
    amazonTidConflicts: [],
    personTids: { 'taro yamada': { 'A111': true } }
  };
  const shift = {
    records: [{ name: 'Taro Yamada', japaneseName: '山田 太郎', company: 'GDS', normalizedName: 'taro yamada', transportId: 'A111', sheet: 'メイン', sourceRow: 10 }],
    sheet: 'メイン',
    stats: { rawMainRows: 1, todayWorkingRows: 1, todayExcludedNonWorking: 0 }
  };
  const result = api.runTransportAudit(amazon, shift);
  assert(result.matched.length === 1, 'Case3 matched');
  assert(result.stats.amazonTidConflicts === 0, 'Case3 no amazon conflict');
  console.log('Case3 passed');
}

function runCase4(api) {
  const amazon = {
    records: [
      { name: 'Hanako Sato', normalizedName: 'hanako sato', transportId: 'B111', sheet: 'test', sourceRow: 5 },
      { name: 'Hanako Sato', normalizedName: 'hanako sato', transportId: 'B222', sheet: 'test', sourceRow: 6 }
    ],
    lookup: { 'hanako sato': { name: 'Hanako Sato', normalizedName: 'hanako sato', transportId: 'B111', sheet: 'test', sourceRow: 5 } },
    conflicts: [{ name: 'Hanako Sato', normalizedName: 'hanako sato', id1: 'B111', id2: 'B222', row1: 5, row2: 6 }],
    amazonTidConflicts: [{ name: 'Hanako Sato', normalizedName: 'hanako sato', id1: 'B111', id2: 'B222', row1: 5, row2: 6 }],
    personTids: { 'hanako sato': { 'B111': true, 'B222': true } }
  };
  const shift = {
    records: [{ name: 'Hanako Sato', japaneseName: '佐藤 花子', company: 'GDS', normalizedName: 'hanako sato', transportId: 'B111', sheet: 'メイン', sourceRow: 10 }],
    sheet: 'メイン',
    stats: { rawMainRows: 1, todayWorkingRows: 1, todayExcludedNonWorking: 0 }
  };
  const result = api.runTransportAudit(amazon, shift);
  assert(result.stats.amazonTidConflicts === 1, 'Case4 amazonTidConflicts');
  assert(result.mismatched.length === 1, 'Case4 mismatched with amazon conflict flag');
  assert(result.mismatched[0].amazonTidConflict === true, 'Case4 amazonTidConflict flag');
  console.log('Case4 passed');
}

function runCase5(api) {
  const amazon = {
    records: [],
    lookup: {},
    conflicts: [],
    amazonTidConflicts: [],
    personTids: {}
  };
  const shift = {
    records: [{ name: 'Ken Only', japaneseName: '唯一 健', company: 'GDS', normalizedName: 'ken only', transportId: 'C111', sheet: 'メイン', sourceRow: 10 }],
    sheet: 'メイン',
    stats: { rawMainRows: 1, todayWorkingRows: 1, todayExcludedNonWorking: 0 }
  };
  const result = api.runTransportAudit(amazon, shift);
  assert(result.amazonUnconfirmed.length === 1, 'Case5 amazonUnconfirmed');
  assert(result.matched.length === 0 && result.mismatched.length === 0, 'Case5 not mismatch');
  console.log('Case5 passed');
}

function runCase6(api) {
  const amazon = {
    records: [{ name: 'Amazon Only', normalizedName: 'amazon only', transportId: 'Z999', sheet: 'test' }],
    lookup: { 'amazon only': { name: 'Amazon Only', normalizedName: 'amazon only', transportId: 'Z999', sheet: 'test' } },
    conflicts: [],
    amazonTidConflicts: [],
    personTids: { 'amazon only': { 'Z999': true } }
  };
  const shift = { records: [], sheet: 'メイン', stats: { rawMainRows: 0, todayWorkingRows: 0, todayExcludedNonWorking: 0 } };
  const result = api.runTransportAudit(amazon, shift);
  assert(result.stats.amazonOnlyIgnored === 1, 'Case6 amazonOnlyIgnored');
  assert(result.stats.uniqueTodayShiftPeople === 0, 'Case6 no shift audit targets');
  console.log('Case6 passed');
}

function runTodayScopeTests(api) {
  const dom = api.getTodayDayOfMonth();
  const dateCol = dom + 2;
  const header = new Array(dateCol + 2).fill('');
  header[0] = '社　名';
  header[1] = '名　前';
  header[2] = '回数';
  header[dateCol] = String(dom);
  header[dateCol + 1] = 'Roman character';
  header[dateCol + 2] = 'Transport ID';

  const rows = [
    [],
    [],
    header,
    [],
    ['GDS', '出勤 太郎', 1, ...new Array(dateCol - 3).fill(''), '○', 'Taro Working', 'A111'],
    ['GDS', '休み 太郎', 1, ...new Array(dateCol - 3).fill(''), '休', 'Taro Off', 'A222'],
    ['GDS', '空白 太郎', 1, ...new Array(dateCol - 3).fill(''), '', 'Taro Blank', 'A333'],
    ['GDS', '合計', 0, ...new Array(dateCol - 3).fill(''), '', '', '']
  ];

  // pad each row to header length
  for (let i = 0; i < rows.length; i++) {
    while (rows[i].length < header.length) rows[i].push('');
  }
  rows[4][dateCol + 1] = 'Taro Working';
  rows[4][dateCol + 2] = 'A111';
  rows[5][dateCol + 1] = 'Taro Off';
  rows[5][dateCol + 2] = 'A222';
  rows[6][dateCol + 1] = 'Taro Blank';
  rows[6][dateCol + 2] = 'A333';

  const parsed = api.parseShiftMaster(makeShiftWorkbook(rows));
  assert(parsed.records.length === 1, 'Today scope: only working person included');
  assert(parsed.records[0].name === 'Taro Working', 'Today scope: working person name');
  assert(parsed.stats.rawMainRows === 3, 'Today scope: rawMainRows counts enrolled with TID');
  assert(parsed.stats.todayWorkingRows === 1, 'Today scope: todayWorkingRows');
  assert(parsed.stats.todayExcludedNonWorking === 2, 'Today scope: off+blank excluded');

  const dupRows = [
    [],
    [],
    header,
    [],
    ['GDS', '重複 太郎', 1, ...new Array(dateCol - 3).fill(''), '○', 'Dup Same', 'A444'],
    ['GDS', '重複 太郎', 1, ...new Array(dateCol - 3).fill(''), '○', 'Dup Same', 'A444']
  ];
  for (let i = 0; i < dupRows.length; i++) {
    while (dupRows[i].length < header.length) dupRows[i].push('');
  }
  dupRows[4][dateCol + 1] = 'Dup Same';
  dupRows[4][dateCol + 2] = 'A444';
  dupRows[5][dateCol + 1] = 'Dup Same';
  dupRows[5][dateCol + 2] = 'A444';
  const dupParsed = api.parseShiftMaster(makeShiftWorkbook(dupRows));
  const dupPop = api.buildShiftAuditPopulation(dupParsed.records);
  assert(dupPop.uniqueTodayShiftPeople === 1, 'Today scope: exact duplicate merged to 1');
  assert(dupPop.exactDuplicateRows === 1, 'Today scope: one duplicate row merged');

  const conflictRows = [
    [],
    [],
    header,
    [],
    ['GDS', '競合 太郎', 1, ...new Array(dateCol - 3).fill(''), '○', 'Conflict Person', 'A555'],
    ['GDS', '競合 太郎', 1, ...new Array(dateCol - 3).fill(''), '○', 'Conflict Person', 'A666']
  ];
  for (let i = 0; i < conflictRows.length; i++) {
    while (conflictRows[i].length < header.length) conflictRows[i].push('');
  }
  conflictRows[4][dateCol + 1] = 'Conflict Person';
  conflictRows[4][dateCol + 2] = 'A555';
  conflictRows[5][dateCol + 1] = 'Conflict Person';
  conflictRows[5][dateCol + 2] = 'A666';
  const conflictParsed = api.parseShiftMaster(makeShiftWorkbook(conflictRows));
  const conflictPop = api.buildShiftAuditPopulation(conflictParsed.records);
  assert(conflictPop.shiftTidConflictPeople === 1, 'Today scope: shift TID conflict detected');

  console.log('Today scope tests passed');
}

function runRealDataIfAvailable(api) {
  console.log('Real-data files skipped in mock XLSX test runner.');
  return null;
}

const api = loadAuditApi();
runCase1(api);
runCase2(api);
runCase3(api);
runCase4(api);
runCase5(api);
runCase6(api);
runTodayScopeTests(api);
runRealDataIfAvailable(api);
console.log('\nAll transport audit tests passed.');
