import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('../../fujin/node_modules/xlsx');

const repoRoot = path.resolve(import.meta.dirname, '..');
const auditPath = path.join(repoRoot, 'tenko-transport-audit.js');

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
    XLSX: XLSX
  };
  context.window = context;
  vm.runInNewContext(code, context, { filename: auditPath });
  return context.window.__tenkoTransportAudit;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCase1(api) {
  const shift = {
    records: [
      { name: '海鴻 全', japaneseName: '', company: 'GDS', normalizedName: '海鴻 全', transportId: 'ANJ7N6M28B5JO', sheet: 'メイン', sourceRow: 96 },
      { name: '海鴻 全', japaneseName: '', company: 'GDS', normalizedName: '海鴻 全', transportId: 'ANJ7N6M28B5JO', sheet: 'メイン', sourceRow: 219 }
    ],
    sheet: 'メイン'
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
    sheet: 'メイン'
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
    sheet: 'メイン'
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
    sheet: 'メイン'
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
    sheet: 'メイン'
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
  const shift = { records: [], sheet: 'メイン' };
  const result = api.runTransportAudit(amazon, shift);
  assert(result.stats.amazonOnlyIgnored === 1, 'Case6 amazonOnlyIgnored');
  assert(result.stats.uniqueShiftPeople === 0, 'Case6 no shift audit targets');
  console.log('Case6 passed');
}

function runRealDataIfAvailable(api) {
  const amazonPath = process.env.AUDIT_AMAZON || 'C:/Users/PC-2320/Downloads/Week-35-Schedule.xlsx';
  const shiftPath = process.env.AUDIT_SHIFT || 'C:/Users/PC-2320/OneDrive/Desktop/delivery-appバックアップ/da-shift-sample.xlsx';
  if (!fs.existsSync(amazonPath) || !fs.existsSync(shiftPath)) {
    console.log('Real-data files not found. Skipping real-data report.');
    return null;
  }
  const amazon = api.parseAmazonSchedule(XLSX.readFile(amazonPath));
  const shift = api.parseShiftMaster(XLSX.readFile(shiftPath));
  const result = api.runTransportAudit(amazon, shift);
  const stats = result.stats;
  console.log('\nReal-data report:');
  console.log('Amazon:', path.basename(amazonPath));
  console.log('Shift:', path.basename(shiftPath));
  console.log(JSON.stringify(stats, null, 2));

  const kaikoCards = result.mismatched.filter(function(m) {
    return (m.shift.name || '').indexOf('海鴻') >= 0 || (m.shift.japaneseName || '').indexOf('海鴻') >= 0;
  });
  const koguraCards = result.mismatched.filter(function(m) {
    return (m.shift.name || '').indexOf('小倉') >= 0 || (m.shift.name || '').indexOf('敏弘') >= 0;
  });
  console.log('海鴻 全 mismatch cards:', kaikoCards.length);
  console.log('敏弘 小倉 mismatch cards:', koguraCards.length);
  return stats;
}

const api = loadAuditApi();
runCase1(api);
runCase2(api);
runCase3(api);
runCase4(api);
runCase5(api);
runCase6(api);
runRealDataIfAvailable(api);
console.log('\nAll transport audit tests passed.');
