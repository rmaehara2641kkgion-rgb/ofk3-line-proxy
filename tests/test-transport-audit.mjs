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
    stats: { rawMainRows: 2 }
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
  assert(pop.uniqueShiftPeople === 1, 'Case1 uniqueShiftPeople');
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
    stats: { rawMainRows: 2 }
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
  assert(pop.uniqueShiftPeople === 1, 'Case2 uniqueShiftPeople');
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
    stats: { rawMainRows: 1 }
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
    stats: { rawMainRows: 1 }
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
    stats: { rawMainRows: 1 }
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
  const shift = { records: [], sheet: 'メイン', stats: { rawMainRows: 0 } };
  const result = api.runTransportAudit(amazon, shift);
  assert(result.stats.amazonOnlyIgnored === 1, 'Case6 amazonOnlyIgnored');
  assert(result.stats.uniqueShiftPeople === 0, 'Case6 no shift audit targets');
  console.log('Case6 passed');
}

function runUiCompactionTests(api) {
  function makeShift(name, tid) {
    return { name: name, japaneseName: name, company: 'GDS', normalizedName: name.toLowerCase(), transportId: tid, sheet: 'メイン', sourceRow: 1 };
  }

  function makeUnconfirmed(count) {
    var list = [];
    for (var i = 0; i < count; i++) {
      list.push({ shift: makeShift('Unconfirmed ' + i, 'U' + i) });
    }
    return list;
  }

  function makeResult(opts) {
    opts = opts || {};
    var stats = {
      rawMainRows: opts.rawMainRows || 100,
      uniqueShiftPeople: opts.uniqueShiftPeople || 100,
      exactDuplicateRows: 0,
      shiftTidConflictPeople: opts.shiftTidConflictPeople || 0,
      amazonTidConflicts: opts.amazonTidConflicts || 0,
      matched: opts.matched != null ? opts.matched : 65,
      mismatched: opts.mismatched != null ? opts.mismatched : 0,
      shiftOnly: opts.shiftOnly != null ? opts.shiftOnly : 28
    };
    return {
      matched: opts.matchedList || [],
      mismatched: (opts.mismatchedList || []).map(function(x) { return { shift: x.shift, amazon: x.amazon }; }),
      amazonUnconfirmed: opts.amazonUnconfirmed || makeUnconfirmed(stats.shiftOnly),
      shiftTidConflicts: opts.shiftTidConflicts || [],
      amazonTidConflicts: opts.amazonTidConflictsList || [],
      stats: stats
    };
  }

  var ui1 = api.buildAuditResultHtml(makeResult(), { unconfirmedOpen: false, compact: false });
  assert(ui1.html.indexOf('Amazon側未確認 28名を表示') >= 0, 'UI1 toggle label');
  assert(ui1.html.indexOf('data-tenko-audit-unconfirmed-list="1" class="mt-2 space-y-2" style="display:none"') >= 0, 'UI1 hidden list');
  assert(ui1.html.indexOf('<details') < 0, 'UI1 no matched details');

  var ui2 = api.buildAuditResultHtml(makeResult({
    matched: 62,
    mismatched: 2,
    shiftOnly: 28,
    mismatchedList: [
      { shift: makeShift('Bad One', 'A1'), amazon: { transportId: 'B1' } },
      { shift: makeShift('Bad Two', 'A2'), amazon: { transportId: 'B2' } }
    ]
  }), { unconfirmedOpen: false, compact: false });
  assert((ui2.html.match(/TransportID不一致/g) || []).length === 2, 'UI2 mismatch cards visible');
  assert(ui2.html.indexOf('style="display:none"') >= 0, 'UI2 unconfirmed still hidden');

  var ui3 = api.buildAuditResultHtml(makeResult(), { unconfirmedOpen: true, compact: false });
  assert(ui3.html.indexOf('Amazon側未確認を閉じる') >= 0, 'UI3 close label');
  assert(ui3.html.indexOf('data-tenko-audit-unconfirmed-list="1" class="mt-2 space-y-2">') >= 0, 'UI3 expanded list');
  assert((ui3.html.match(/Amazon側未確認<\/div>/g) || []).length === 28, 'UI3 all unconfirmed cards rendered');

  var ui4 = api.buildAuditResultHtml(makeResult(), { unconfirmedOpen: false, compact: false });
  assert(ui4.html.indexOf('style="display:none"') >= 0, 'UI4 collapsed again');

  var ui5 = api.buildAuditResultHtml(makeResult({
    shiftTidConflictPeople: 1,
    shiftTidConflicts: [{
      shift: makeShift('Dup Person', 'A111'),
      shiftTransportIds: ['A111', 'A222'],
      amazon: null,
      amazonTransportIds: []
    }]
  }), { unconfirmedOpen: false, compact: false });
  assert(ui5.html.indexOf('シフト表内TransportID重複') >= 0, 'UI5 shift TID conflict visible');

  var uiCompact = api.buildAuditResultHtml(makeResult(), { unconfirmedOpen: false, compact: true });
  assert(uiCompact.compact === true, 'UI compact mode');
  assert(uiCompact.html.indexOf('TransportID一致 65名') >= 0, 'UI compact summary');
  assert(api.isAuditFullyNormal(makeResult().stats), 'UI fully normal stats');

  console.log('UI compaction tests passed');
}

function runRosterScopeTests(api) {
  const header = ['社　名', '名　前', '回数', '', '', 'Roman character', 'Transport ID'];
  const rows = [
    [],
    [],
    header,
    [],
    ['GDS', '出勤 太郎', 1, '○', '', 'Taro Working', 'A111'],
    ['GDS', '休み 太郎', 1, '休', '', 'Taro Off', 'A222'],
    ['GDS', '空白 太郎', 1, '', '', 'Taro Blank', 'A333'],
    ['GDS', '合計', 0, '', '', '', '']
  ];

  const parsed = api.parseShiftMaster(makeShiftWorkbook(rows));
  assert(parsed.records.length === 3, 'Roster scope: working/off/blank all included');
  assert(parsed.stats.rawMainRows === 3, 'Roster scope: rawMainRows');
  const names = parsed.records.map(function(r) { return r.name; }).sort();
  assert(names.join('|') === 'Taro Blank|Taro Off|Taro Working', 'Roster scope: all roster names');

  const dupRows = [
    [],
    [],
    header,
    [],
    ['GDS', '重複 太郎', 1, '○', '', 'Dup Same', 'A444'],
    ['GDS', '重複 太郎', 1, '休', '', 'Dup Same', 'A444']
  ];
  const dupParsed = api.parseShiftMaster(makeShiftWorkbook(dupRows));
  const dupPop = api.buildShiftAuditPopulation(dupParsed.records);
  assert(dupPop.uniqueShiftPeople === 1, 'Roster scope: exact duplicate merged to 1');
  assert(dupPop.exactDuplicateRows === 1, 'Roster scope: one duplicate row merged');

  const conflictRows = [
    [],
    [],
    header,
    [],
    ['GDS', '競合 太郎', 1, '○', '', 'Conflict Person', 'A555'],
    ['GDS', '競合 太郎', 1, '休', '', 'Conflict Person', 'A666']
  ];
  const conflictParsed = api.parseShiftMaster(makeShiftWorkbook(conflictRows));
  const conflictPop = api.buildShiftAuditPopulation(conflictParsed.records);
  assert(conflictPop.shiftTidConflictPeople === 1, 'Roster scope: shift TID conflict detected');

  console.log('Roster scope tests passed');
}

const api = loadAuditApi();
runCase1(api);
runCase2(api);
runCase3(api);
runCase4(api);
runCase5(api);
runCase6(api);
runUiCompactionTests(api);
runRosterScopeTests(api);
console.log('\nAll transport audit tests passed.');
