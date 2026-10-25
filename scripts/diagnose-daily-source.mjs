// デイリー実績フォルダの読み取り専用診断。ファイルは変更しない。
// 使い方: node scripts/diagnose-daily-source.mjs ["G:\マイドライブ\マニフェスト"]
// 出力はファイル名・シート名・件数・日付範囲・原因コードのみ（氏名・ID・時間の値は出さない）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const rolling = require('../rolling60h-core.js');
const harvest = require('../harvest-daily-manifest.js');

const dir = process.argv[2] || 'G:\\マイドライブ\\マニフェスト';
const out = (key, value) => console.log(key.padEnd(28) + value);

out('node cwd', process.cwd());
out('folder', dir);
out('folder exists', fs.existsSync(dir));
if (!fs.existsSync(dir)) {
  out('reason', 'source-unavailable');
  process.exit(1);
}
let names = [];
try { names = fs.readdirSync(dir); } catch (e) { out('readdir', 'failed: ' + (e && e.code)); out('reason', 'source-unavailable'); process.exit(1); }
const pattern = /^Daily_AMZL_JP_Working_Hour_(\d{4}-\d{2}-\d{2})_/i;
const matched = names.filter((n) => pattern.test(n));
const nearMiss = names.filter((n) => /daily/i.test(n) && !pattern.test(n));
out('files in folder', names.length);
out('matching Daily pattern', matched.length);
out('near-miss (has "daily")', nearMiss.length + (nearMiss.length ? '  ' + nearMiss.slice(0, 5).join(' | ') : ''));
const dates = matched.map((n) => pattern.exec(n)[1]).sort();
const latest = dates[dates.length - 1];
out('latest date', latest || '-');
out('files on latest date', matched.filter((n) => n.includes(latest)).length);
matched.filter((n) => pattern.exec(n)[1] === latest).forEach((n) => {
  let size = '?', mtime = '?';
  try { const st = fs.statSync(path.join(dir, n)); size = st.size; mtime = st.mtime.toISOString(); } catch (e) {}
  out('  latest file', n + '  size=' + size + '  mtime=' + mtime);
});
let loaded;
try {
  loaded = harvest.loadFromDirectory(dir, { fs, path, xlsx: XLSX, rolling });
} catch (e) {
  out('dailyReason', 'read-failed  (' + (e && (e.code || e.name)) + ')');
  process.exit(1);
}
out('dailyReason', loaded.ok ? 'ok' : loaded.reason);
if (loaded.ok) {
  out('sheet', loaded.sheet);
  const parsed = rolling.parseAmazonDailyRows(loaded.rows, { stationFilter: 'OFK3', allowHeaderlessFallback: false });
  const d = (parsed.records || []).map((r) => r.date).sort();
  out('OFK3 records', (parsed.records || []).length);
  out('date range', (d[0] || '-') + ' .. ' + (d[d.length - 1] || '-'));
} else if (loaded.file) {
  out('file', loaded.file);
}
