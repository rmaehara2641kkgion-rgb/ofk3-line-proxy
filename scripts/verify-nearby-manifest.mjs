// 管理者向け ローカル検証スクリプト（実マニフェスト用）。
// 使い方: node scripts/verify-nearby-manifest.mjs <マニフェスト.xlsx>
// 出力は件数などの集計のみ。住所・Tracking ID・ファイル内容は一切表示/保存/送信しない。
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const C = require('../nearby-course-core.js');

const path = process.argv[2];
if (!path) { console.error('usage: node scripts/verify-nearby-manifest.mjs <manifest.xlsx>'); process.exit(2); }
const buf = readFileSync(path);
const z = C.inspectZip(new Uint8Array(buf));
if (!z.ok) { console.error('ファイル検証NG: ' + z.error); process.exit(1); }
const wb = XLSX.read(buf, { type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false, bookVBA: false });
const ex = C.extractManifest(XLSX, wb);
if (!ex.ok) { console.error('取込NG: ' + ex.error); process.exit(1); }
const t0 = Date.now();
const idx = C.buildIndex(ex);
const buildMs = Date.now() - t0;

let commaRows = 0, total = 0;
const prefCount = {};
for (const r of ex.routes) for (const row of r.rows) { total++; if (/[,，、]/.test(row.address)) commaRows++; }
for (const rec of idx.records) prefCount[rec.pref || '(なし)'] = (prefCount[rec.pref || '(なし)'] || 0) + 1;
const prefixes = {};
for (const r of ex.routes) prefixes[r.route.replace(/\d+$/, '')] = (prefixes[r.route.replace(/\d+$/, '')] || 0) + 1;

// 自己整合: 各配送先の基本住所で検索し、(a) 自コースがLEVEL1で見つかる (b) LEVEL1候補が別の基本住所を指さない
let selfMiss = 0, falseL1 = 0, maxMs = 0, sumMs = 0;
for (const rec of idx.records) {
  const s = Date.now();
  const r = C.search(idx, rec.display);
  const ms = Date.now() - s; sumMs += ms; if (ms > maxMs) maxMs = ms;
  if (!r.ok || !r.candidates.length || r.candidates[0].level !== 1) selfMiss++;
  for (const c of r.candidates) if (c.level === 1 && c.bestAddress !== rec.display) falseL1++;
}
const townCourses = {};
for (const rec of idx.records) { const k = rec.muni + '|' + rec.town; (townCourses[k] = townCourses[k] || new Set()).add(rec.route); }
const multi = Object.values(townCourses).filter((s) => s.size > 1).length;

console.log(JSON.stringify({
  認識コース数: idx.routeCount, コース接頭辞別: prefixes,
  有効配送件数_TrackingIDあり住所あり: idx.validCount,
  カンマ区切り住所件数: commaRows, 全行数: total,
  住所解析失敗件数_検索対象外: idx.unparsed,
  解析失敗率: total ? +(idx.unparsed / total * 100).toFixed(2) + '%' : '0%',
  検索対象の基本住所数: idx.baseCount, 都道府県別基本住所数: prefCount,
  複数コースにまたがる町域数: multi,
  自己検索でLEVEL1にならない件数: selfMiss,
  LEVEL1なのに別住所を指す件数_誤一致: falseL1,
  インデックス構築ms: buildMs, 検索ms平均: +(sumMs / Math.max(1, idx.records.length)).toFixed(2), 検索ms最大: maxMs,
  警告: ex.noAddress ? '住所なし行 ' + ex.noAddress + ' 件' : 'なし'
}, null, 2));
