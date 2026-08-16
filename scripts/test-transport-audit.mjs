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

function runSyntheticTests(api) {
  const amazon = {
    records: [
      { name: 'Taro Yamada', normalizedName: 'taro yamada', transportId: 'A123456', sheet: 'test' },
      { name: 'Hanako Sato', normalizedName: 'hanako sato', transportId: 'B111111', sheet: 'test' },
      { name: 'Amazon Only Person', normalizedName: 'amazon only person', transportId: 'Z999999', sheet: 'test' }
    ],
    lookup: {
      'taro yamada': { name: 'Taro Yamada', normalizedName: 'taro yamada', transportId: 'A123456', sheet: 'test' },
      'yamada taro': { name: 'Taro Yamada', normalizedName: 'taro yamada', transportId: 'A123456', sheet: 'test' },
      'hanako sato': { name: 'Hanako Sato', normalizedName: 'hanako sato', transportId: 'B111111', sheet: 'test' }
    },
    conflicts: []
  };

  const shift = {
    records: [
      { name: 'Taro Yamada', japaneseName: '山田 太郎', company: 'テスト物流', normalizedName: 'taro yamada', transportId: 'A123456', sheet: 'メイン' },
      { name: 'Yamada Taro', japaneseName: '山田 太郎', company: 'テスト物流', normalizedName: 'yamada taro', transportId: 'A123456', sheet: 'メイン' },
      { name: 'Hanako Sato', japaneseName: '佐藤 花子', company: 'テスト物流', normalizedName: 'hanako sato', transportId: 'B999999', sheet: 'メイン' },
      { name: 'Ken Zen', japaneseName: '海鴻 全', company: 'テスト物流', normalizedName: 'ken zen', transportId: 'C111111', sheet: 'メイン' },
      { name: 'Duplicate Ken', japaneseName: '重複 健', company: 'テスト物流', normalizedName: 'duplicate ken', transportId: 'D111111', sheet: 'メイン' },
      { name: 'Duplicate Ken', japaneseName: '重複 健', company: 'テスト物流', normalizedName: 'duplicate ken', transportId: 'D222222', sheet: 'メイン' }
    ],
    sheet: 'メイン'
  };

  const result = api.runTransportAudit(amazon, shift);
  const stats = result.stats;

  assert(stats.shiftMainTotal === 6, 'shift main total should be 6');
  assert(stats.auditTargetCount === 5, 'audit target should be 5 after exact dedup');
  assert(stats.exactDedupMergedCount === 1, 'exact dedup merged should be 1');
  assert(stats.matchedCount === 1, 'matched should be 1');
  assert(stats.mismatchedCount === 1, 'mismatched should be 1');
  assert(stats.amazonUnconfirmedCount === 3, 'amazon unconfirmed should be 3');
  assert(stats.amazonOnlyExcludedCount === 1, 'amazon only excluded should be 1');
  assert(stats.shiftTidDuplicateCount === 1, 'shift tid duplicate groups should be 1');
  assert(
    stats.matchedCount + stats.mismatchedCount + stats.amazonUnconfirmedCount === stats.auditTargetCount,
    'summary counts must equal audit target count'
  );

  console.log('Synthetic tests passed.');
  console.log(JSON.stringify(stats, null, 2));
}

function findWorkbookFiles() {
  const dirs = [
    path.join(repoRoot, 'fixtures'),
    path.join(process.env.USERPROFILE || '', 'Downloads'),
    path.join(process.env.USERPROFILE || '', 'OneDrive', 'Desktop')
  ];
  const patterns = ['シフト', 'shift', 'Amazon', 'スケジュール', 'schedule', 'DA'];
  const found = { amazon: null, shift: null };

  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.xlsx$|\.xls$/i.test(name)) continue;
      const full = path.join(dir, name);
      const lower = name.toLowerCase();
      if (!found.amazon && patterns.some(function(p) { return lower.includes(p.toLowerCase()) || name.includes(p); })) {
        if (/amazon|スケジュール|schedule/i.test(name)) found.amazon = full;
        if (/シフト|shift|da/i.test(name)) found.shift = full;
      }
    }
  }
  return found;
}

function runRealDataIfAvailable(api) {
  const files = findWorkbookFiles();
  if (!files.amazon || !files.shift) {
    console.log('Real workbook files not found in fixtures/Downloads/Desktop. Skipping real-data report.');
    return null;
  }

  try {
    const amazonWb = XLSX.readFile(files.amazon);
    const shiftWb = XLSX.readFile(files.shift);
    const amazon = api.parseAmazonSchedule(amazonWb);
    const shift = api.parseShiftMaster(shiftWb);
    const result = api.runTransportAudit(amazon, shift);
    const stats = result.stats;

    console.log('Real-data report:');
    console.log('Amazon file:', files.amazon);
    console.log('Shift file:', files.shift);
    console.log(JSON.stringify(stats, null, 2));
    return stats;
  } catch (err) {
    console.log('Real workbook files were found but could not be parsed for audit report:', err.message);
    return null;
  }
}

const api = loadAuditApi();
runSyntheticTests(api);
runRealDataIfAvailable(api);
